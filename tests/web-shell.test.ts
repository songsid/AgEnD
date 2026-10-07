import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { bypassesWebGate } from "../src/auth-api.js";
import { isViewPath } from "../src/view-api.js";
import { isUsagePath } from "../src/usage/usage-api.js";
import { csrfTokenFor } from "../src/web-session.js";

const ui = (name: string) => readFileSync(join(process.cwd(), "src", "ui", name), "utf8");

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Message numbering, boots and replay are C1's WebChatHistory (tests/web-chat-c1.test.ts); this file checks
// that polling uses the very same cursor as the stream.

// ── live ──

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = "";
      res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function startFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-shell-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = ((fm as unknown as { healthServer: Server }).healthServer).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const login = await raw(address.port, "POST", "/auth/login", { "content-type": "application/json", origin }, JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  return { fm, port: address.port, origin, cookie, csrf: csrfTokenFor(cookie.split("=")[1]!) };
}
async function stop(fm: FleetManager) {
  const server = (fm as unknown as { healthServer: Server | null }).healthServer;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  (fm as unknown as { healthServer: Server | null }).healthServer = null;
}

describe("GET /ui/poll", () => {
  it("is the stream over plain requests: the same <boot>-<id> cursor, to a signed-in session only", async () => {
    const h = await startFleet();
    const boot = h.fm.webChatHistory.boot;
    h.fm.emitSseEvent("message", { instance: "a", sender: "agent", text: "one", ts: "1" });
    h.fm.emitSseEvent("message", { instance: "a", sender: "agent", text: "two", ts: "2" });
    h.fm.emitSseEvent("status", { ignored: true });
    const poll = async (q: string) => JSON.parse((await raw(h.port, "GET", `/ui/poll${q}`, { cookie: h.cookie })).body);

    // No cursor yet (the page has seen no stream message): everything still retained, so nothing said while the
    // stream was silent is skipped by the cursor handed out here; the page keeps one entry per boot+id.
    const first = await poll("");
    expect(first.messages.map((m: { text: string }) => m.text)).toEqual(["one", "two"]);
    expect(first.cursor).toBe(`${boot}-2`);
    expect(first.status).toHaveProperty("instances");

    expect((await poll(`?after=${boot}-0`)).messages.map((m: { text: string }) => m.text)).toEqual(["one", "two"]);
    expect((await poll(`?after=${boot}-1`)).messages.map((m: { text: string }) => m.text)).toEqual(["two"]);
    expect((await poll(`?after=${boot}-2`)).messages).toEqual([]);
    // A cursor from another boot (the fleet restarted): this boot's whole backlog.
    expect((await poll("?after=deadbeef-999")).messages.map((m: { text: string }) => m.text)).toEqual(["one", "two"]);

    for (const junk of ["?after=abc", "?after=-5", "?after=1e9", "?after=2"]) {
      const res = await raw(h.port, "GET", `/ui/poll${junk}`, { cookie: h.cookie });
      expect(res.status, junk).toBe(200);
      expect(JSON.parse(res.body).messages, junk).toEqual([]);
    }
    expect((await raw(h.port, "GET", `/ui/poll?after=${boot}-0`)).status).toBe(401);
    // Status events are not chat: only messages get ids.
    expect(h.fm.webChatHistory.lastId).toBe(2);
    await stop(h.fm);
  }, 30_000);
});

describe("a passive poll is not activity (#1251 review): it never keeps an idle session alive", () => {
  // The real listener: the outer gate and the /ui handler's own check, a real session cookie, the store's clock
  // driven by the test. Local sessions end after 2h idle (12h absolute).
  async function signedInAt(h: Awaited<ReturnType<typeof startFleet>>, clock: { t: number }) {
    (h.fm as unknown as { webSessions: { now: () => number } }).webSessions.now = () => clock.t;
    const login = await raw(h.port, "POST", "/auth/login", { "content-type": "application/json", origin: h.origin }, JSON.stringify({ code: h.fm.issueDashboardLogin()!.display }));
    expect(login.status).toBe(200);
    return String(login.headers["set-cookie"]).split(";")[0]!;
  }
  const H = 3_600_000, M = 60_000;
  const poll = (h: { port: number }, cookie: string) => raw(h.port, "GET", "/ui/poll?after=", { cookie });

  it("polls alone: still authorized up to the idle limit, refused after it — the polls did not extend it", async () => {
    const h = await startFleet();
    const clock = { t: Date.now() };
    const cookie = await signedInAt(h, clock);
    const start = clock.t;
    for (const at of [5_000, 1 * H, 1 * H + 59 * M, 2 * H - 5_000]) {
      clock.t = start + at;
      expect((await poll(h, cookie)).status, `poll at +${at / M}m`).toBe(200);
    }
    clock.t = start + 2 * H + 5_000;
    expect((await poll(h, cookie)).status, "two hours after the last real use").toBe(401);
    expect((await raw(h.port, "GET", "/ui/history?instance=w", { cookie })).status, "and the session is over for everything").toBe(401);
    await stop(h.fm);
  }, 30_000);

  it("a real request (the person using the page) still extends it, and polls in between change nothing", async () => {
    const h = await startFleet();
    const clock = { t: Date.now() };
    const cookie = await signedInAt(h, clock);
    const start = clock.t;
    clock.t = start + 1 * H;
    expect((await raw(h.port, "GET", "/ui/history?instance=w", { cookie })).status).toBe(200);   // activity: idle now ends at +3h
    clock.t = start + 2 * H + 5_000;
    expect((await poll(h, cookie)).status, "past the first idle limit, inside the extended one").toBe(200);
    clock.t = start + 3 * H + 5_000;
    expect((await poll(h, cookie)).status, "the polls since did not extend it again").toBe(401);
    await stop(h.fm);
  }, 30_000);

  it("the dashboard's own polling, left alone, never keeps the session: the real page script against the real listener (#1253 review)", async () => {
    const h = await startFleet();
    const clock = { t: Date.now() };
    const cookie = await signedInAt(h, clock);
    const start = clock.t;
    // The page as served, its fetch going to the real listener with this browser's cookie.
    const vm = await import("node:vm");
    const RENDER = ui("chat-render.js");
    const PAGE = ui("dashboard.html").match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
    const requested: string[] = [];
    const browserFetch = async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      requested.push(url);
      const r = await raw(h.port, o.method ?? "GET", url, { cookie, origin: h.origin, ...(o.headers ?? {}) }, o.body);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body || "{}") };
    };
    const node = () => ({ style: {}, remove() {}, append() {}, setAttribute() {}, children: [], textContent: "", innerHTML: "" });
    const c = vm.createContext({
      localStorage: { getItem: () => null }, navigator: { language: "en" },
      document: { addEventListener() {}, getElementById: () => node(), createElement: () => node(), body: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: browserFetch, EventSource: class { addEventListener() {} },
    });
    vm.runInContext(RENDER, c);
    vm.runInContext(PAGE, c);
    vm.runInContext('renderList=()=>{};renderActions=()=>{};renderMsgs=()=>{};mode="instance";cur="w";curTab="chat";', c);
    const pollOnce = () => vm.runInContext("pollOnce()", c) as Promise<void>;
    for (const at of [5_000, 1 * H, 2 * H - 5_000]) { clock.t = start + at; await pollOnce(); }
    expect(requested.length, "three polls").toBe(3);
    expect(requested.every(u => u.startsWith("/ui/poll?")), `only polls, no background history read: ${requested.join(" ")}`).toBe(true);
    clock.t = start + 2 * H + 5_000;
    expect((await raw(h.port, "GET", "/ui/history?instance=w", { cookie })).status, "two hours after sign-in, nobody touched it").toBe(401);
    await stop(h.fm);
  }, 30_000);

  it("a passive poll still checks everything else: a revoked session is refused at once", async () => {
    const h = await startFleet();
    expect((await poll(h, h.cookie)).status).toBe(200);
    (h.fm as unknown as { webSessions: { revokeAll(): unknown } }).webSessions.revokeAll();
    expect((await poll(h, h.cookie)).status).toBe(401);
    await stop(h.fm);
  }, 30_000);
});

describe("a web handler that throws answers 500 — it never reaches the fleet's uncaughtException (#1252 review)", () => {
  it("the request fails, the listener and every other route keep working", async () => {
    const h = await startFleet();
    const crashes: unknown[] = [];
    const onCrash = (err: unknown) => { crashes.push(err); };
    process.on("uncaughtException", onCrash);
    try {
      (h.fm as unknown as { getUiStatus(): unknown }).getUiStatus = () => { throw new URIError("URI malformed"); };
      const res = await raw(h.port, "GET", "/ui/poll?after=", { cookie: h.cookie });
      expect(res.status).toBe(500);
      expect(res.body).toBe(JSON.stringify({ error: "internal error" }));
      expect((await raw(h.port, "GET", "/ui/history?instance=w", { cookie: h.cookie })).status).toBe(200);
      expect(crashes).toEqual([]);
    } finally {
      process.off("uncaughtException", onCrash);
      await stop(h.fm);
    }
  }, 30_000);
});

describe("/ and the shared assets", () => {
  it("redirects / to the dashboard, with nothing about who may enter", async () => {
    const h = await startFleet();
    for (const headers of [{}, { cookie: h.cookie }]) {
      const res = await raw(h.port, "GET", "/", headers as Record<string, string>);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/ui");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect((await raw(h.port, "POST", "/", { origin: h.origin })).status).toBe(405);
    await stop(h.fm);
  }, 30_000);

  it("serves the shell script and stylesheet, and nothing else beside them", async () => {
    const h = await startFleet();
    const js = await raw(h.port, "GET", "/assets/shell.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    const css = await raw(h.port, "GET", "/assets/shell.css");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    const theme = await raw(h.port, "GET", "/assets/theme.js");                       // #1307: light / dark before paint
    expect(theme.status).toBe(200);
    expect(theme.headers["content-type"]).toContain("text/javascript");
    expect((await raw(h.port, "GET", "/assets/shell.css.map")).status).toBe(404);
    await stop(h.fm);
  }, 30_000);

  it("does not skip the gate for anything but the door", () => {
    const skips = (url: string) => bypassesWebGate({ method: "GET", url }, url, undefined, p => isViewPath(p) || isUsagePath(p));
    expect(skips("/")).toBe(true);
    expect(skips("/ui")).toBe(false);
    expect(skips("/ui/poll")).toBe(false);
    expect(skips("/ui/events")).toBe(false);
  });
});

describe("the panels adopt the shell", () => {
  it("each panel loads the stylesheet and both scripts, and places one nav marked with its own name", () => {
    for (const [file, current] of [["dashboard.html", "ui"], ["view.html", "view"], ["settings.html", "settings"]] as const) {
      const html = ui(file);
      expect(html, file).toContain('<link rel="stylesheet" href="/assets/shell.css">');
      expect(html, file).toContain('<script src="/assets/agend-auth.js"></script>');
      expect(html, file).toContain('<script src="/assets/shell.js" defer></script>');
      expect(html.match(/data-agend-nav/g), file).toHaveLength(1);
      expect(html, file).toContain(`data-current="${current}"`);
    }
  });

  it("loads nothing from another origin — no CDN fonts, scripts or styles", () => {
    for (const file of ["dashboard.html", "view.html", "settings.html", "signin.html"]) {
      const html = ui(file);
      expect(html, file).not.toMatch(/<(?:link|script|img)[^>]+(?:href|src)=["']https?:/i);
      expect(html, file).not.toContain("fonts.googleapis.com");
      expect(html, file).not.toContain("fonts.gstatic.com");
      expect(html, file).not.toMatch(/@import\s+url\(["']?https?:/i);
    }
  });

  it("never builds markup from a string in the shell — labels are other browsers' User-Agents", () => {
    const js = ui("shared/shell.js");
    expect(js).not.toMatch(/\.innerHTML\s*=/);
    expect(js).not.toContain("insertAdjacentHTML");
    expect(js).not.toContain("document.write");
    expect(js).not.toMatch(/\beval\(|new Function\(/);
  });

  it("the dashboard falls back to polling when the stream is silent, and stops when it speaks", () => {
    const html = ui("dashboard.html");
    expect(html).toContain("/ui/poll?after=");
    expect(html).toContain("setTimeout(startPolling, 15000)");   // nothing within 15s of load
    expect(html).toMatch(/function stopPolling\(\) \{ if \(pollTimer\) \{ clearInterval\(pollTimer\); pollTimer = null; \} \}/);
    // ...and it is the stream speaking that stops it.
    expect(html).toMatch(/function sseAlive\(\) \{ stopPolling\(\);/);
    // A failing stream fires onerror again on every retry; the deadline must not be pushed back each time.
    expect(html).toMatch(/if \(!errorTimer\) errorTimer = setTimeout\(startPolling, 5000\)/);
    expect(html).toMatch(/sse\.addEventListener\("status", e => \{ sseAlive\(\);/);
    // The stream's cursor is the poll's cursor; a message is ingested through the boot+id merge (behaviour:
    // tests/web-chat-c1.test.ts "dashboard polling").
    expect(html).toContain("if (e.lastEventId) lastCursor = e.lastEventId;");
    expect(html).toContain("/ui/poll?after=${encodeURIComponent(lastCursor)}");
  });
});
