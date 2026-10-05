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

    // No cursor yet: the current cursor and no backlog (the page loads history separately).
    const first = await poll("");
    expect(first.messages).toEqual([]);
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
