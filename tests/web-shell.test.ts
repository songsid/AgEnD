import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { bypassesWebGate } from "../src/auth-api.js";
import { isViewPath } from "../src/view-api.js";
import { isUsagePath } from "../src/usage/usage-api.js";
import { csrfTokenFor } from "../src/web-session.js";
// @ts-expect-error — a shipped ESM module with no types (the app's own file)
import { createStream } from "../src/ui/shared/app-stream.js";

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

  it("the app's own polling, left alone, never keeps the session: the real stream against the real listener (#1253 review)", async () => {
    const h = await startFleet();
    const clock = { t: Date.now() };
    const cookie = await signedInAt(h, clock);
    const start = clock.t;
    // The page's stream as the app runs it on a public link (no EventSource; a poll at once, then every 5 s). Its fetch goes to
    // the real listener with this browser's cookie; the test drives the clock and calls the poll itself.
    const requested: string[] = [];
    const browserFetch = async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      requested.push(url);
      const r = await raw(h.port, o.method ?? "GET", url, { cookie, origin: h.origin, ...(o.headers ?? {}) }, o.body);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body || "{}") };
    };
    const stream = createStream({
      mode: "full", transport: "poll",
      env: { fetch: browserFetch, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {} },
    });
    stream.start();                                  // the first poll, at once
    for (const at of [5_000, 1 * H, 2 * H - 5_000]) { clock.t = start + at; await stream._pollOnce(); }
    expect(requested.length, "four polls").toBe(4);
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

  it("does not skip the gate for anything but the door and the View reads", () => {
    const skips = (url: string, view_access?: string) => bypassesWebGate({ method: "GET", url }, url, { web: { view_access } }, p => isViewPath(p) || isUsagePath(p));
    expect(skips("/")).toBe(true);
    expect(skips("/ui")).toBe(false);
    expect(skips("/ui/poll")).toBe(false);
    expect(skips("/ui/events")).toBe(false);
    // #1408 step 2: /view and /view/<name> are View's public pages (the View-only shell under view_access: open).
    expect(skips("/view")).toBe(true);
    expect(skips("/view/alpha")).toBe(true);
    expect(skips("/view/a%20b")).toBe(true);
    // Not a page of View: the gate still answers it.
    expect(skips("/view/a/b")).toBe(false);
    expect(skips("/view/")).toBe(false);
    expect(skips("/settings")).toBe(false);
    // view_access: session takes every View read back behind the gate.
    expect(skips("/view", "session")).toBe(false);
    expect(skips("/view/alpha", "session")).toBe(false);
  });
});

describe("the panels adopt the shell", () => {
  // #1408 step 3: /settings is the app shell on its Settings panel (settings.html is gone, as view.html went in step 2),
  // so no page loads the old shell.js or places its own nav any more.
  it("no page of the app is its own page any more: no HTML file under src/ui but the shell and sign-in", () => {
    const pages = readdirSync(join(process.cwd(), "src", "ui")).filter(f => f.endsWith(".html")).sort();
    expect(pages).toEqual(["app.html", "signin.html"]);
    for (const file of pages) {
      expect(ui(file), file).not.toContain("/assets/shell.js");
      expect(ui(file), file).not.toContain("data-agend-nav");
    }
  });

  // #1408 step 1: the dashboard is the app shell. It loads the app's own stylesheets and modules instead of shell.js, and
  // its navigation is the app's sidebar (rendered by the app), so it has no data-agend-nav slot.
  it("the app shell loads its tokens, its styles, the sign-in helper, the theme before paint, and the app module — and not the old shell", () => {
    const html = ui("app.html");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<link rel="stylesheet" href="/assets/tokens.css">');
    expect(head).toContain('<link rel="stylesheet" href="/assets/app.css">');
    expect(head).toContain('<script src="/assets/agend-auth.js"></script>');
    expect(head).toContain('<script src="/assets/theme.js"></script>');
    expect(html).toContain('<script type="module" src="/assets/app.js"></script>');
    expect(html).not.toContain("/assets/shell.js");
    expect(html).not.toContain("/assets/shell.css");
    expect(html).not.toContain("data-agend-nav");
  });

  it("/ui, /view and /settings are the app shell, with their sub-pages", async () => {
    const h = await startFleet();
    try {
      for (const path of ["/ui", "/view", "/view/alpha", "/settings", "/settings/general"]) {
        const r = await raw(h.port, "GET", path, { cookie: h.cookie, accept: "text/html" });
        expect(r.status, path).toBe(200);
        expect(r.body, path).toContain('<script type="module" src="/assets/app.js"></script>');
        expect(r.body, path).not.toContain("/assets/shell.js");
      }
    } finally { await stop(h.fm); }
  }, 30_000);

  it("loads nothing from another origin — no CDN fonts, scripts or styles", () => {
    // The View panel's modules are JavaScript: no URL of another origin in them either (#1408 step 2).
    for (const file of ["shared/panel-view.js", "shared/view-strings.js"]) {
      expect(ui(file), file).not.toMatch(/["'`(=]\s*https?:\/\//i);
      expect(ui(file), file).not.toMatch(/\bimport\(\s*["'`]https?:/i);
    }
    // Settings' modules: nothing is loaded from another origin (its one external URL is a link to the release notes).
    for (const file of ["panel-settings.js", "settings-dialogs.js", "settings-wizard.js", "settings-apply.js", "settings-confirm.js", "settings-model.js", "settings-strings.js"]) {
      const src = ui(file);
      expect(src, file).not.toMatch(/\b(?:import|fetch)\(\s*["'`]https?:/i);
      expect(src, file).not.toMatch(/\bsrc=\$?\{?\s*["'`]https?:/i);
      expect([...src.matchAll(/https?:\/\/[^\s"'`]+/g)].map(m => m[0]), file).toEqual(file === "panel-settings.js" ? ["https://github.com/songsid/AgEnD/releases"] : []);
    }
    for (const file of ["app.html", "signin.html"]) {
      const html = ui(file);
      expect(html, file).not.toMatch(/<(?:link|script|img)[^>]+(?:href|src)=["']https?:/i);
      expect(html, file).not.toContain("fonts.googleapis.com");
      expect(html, file).not.toContain("fonts.gstatic.com");
      expect(html, file).not.toMatch(/@import\s+url\(["']?https?:/i);
    }
    for (const file of ["shared/tokens.css", "shared/app.css"]) {
      const css = readFileSync(join(process.cwd(), "src", "ui", file), "utf8");
      expect(css, file).not.toMatch(/https?:\/\//);
      expect(css, file).not.toMatch(/@import/i);
    }
  });

  it("never builds markup from a string in the shell — labels are other browsers' User-Agents", () => {
    const js = ui("shared/shell.js");
    expect(js).not.toMatch(/\.innerHTML\s*=/);
    expect(js).not.toContain("insertAdjacentHTML");
    expect(js).not.toContain("document.write");
    expect(js).not.toMatch(/\beval\(|new Function\(/);
  });
});

describe("the app's stream falls back to polling when it is silent, and stops when it speaks (#1408 §3)", () => {
  // A clock the test moves: setTimeout/setInterval fire when advance() passes their due time, in order.
  function fakeEnv() {
    let now = 0, nextId = 0;
    const timers = new Map<number, { due: number; fn: () => void; every?: number }>();
    const fetched: string[] = [];
    const sources: FakeSource[] = [];
    class FakeSource {
      listeners = new Map<string, (e: { data: string; lastEventId?: string }) => void>();
      onerror: (() => void) | null = null;
      closed = false;
      constructor(public url: string) { sources.push(this); }
      addEventListener(name: string, fn: (e: { data: string; lastEventId?: string }) => void) { this.listeners.set(name, fn); }
      close() { this.closed = true; }
      frame(name: string, data: unknown, lastEventId?: string) { this.listeners.get(name)?.({ data: JSON.stringify(data), lastEventId }); }
    }
    const env = {
      EventSource: FakeSource,
      fetch: async (url: string) => { fetched.push(url); return { ok: true, json: async () => ({}) }; },
      setTimeout: (fn: () => void, ms: number) => { const k = ++nextId; timers.set(k, { due: now + ms, fn }); return k; },
      clearTimeout: (k: number) => { timers.delete(k); },
      setInterval: (fn: () => void, ms: number) => { const k = ++nextId; timers.set(k, { due: now + ms, fn, every: ms }); return k; },
      clearInterval: (k: number) => { timers.delete(k); },
    };
    function advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].sort(([, a], [, b]) => a.due - b.due)[0];
        if (!due || due[1].due > end) break;
        const [k, t] = due;
        now = t.due;
        if (t.every) t.due += t.every; else timers.delete(k);
        t.fn();
      }
      now = end;
    }
    return { env, fetched, sources, advance };
  }

  // A poll's answer settles between timers in a browser; here the fake clock is synchronous, so let it settle.
  const settled = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  it("a silent stream: nothing for 15 s, then a poll every 5 s from the empty cursor", async () => {
    const f = fakeEnv();
    const stream = createStream({ mode: "full", env: f.env });
    stream.start();
    expect(f.sources.map(s => s.url)).toEqual(["/ui/events"]);
    f.advance(14_999);
    expect(f.fetched, "not yet").toEqual([]);
    f.advance(1);
    expect(f.fetched).toEqual(["/ui/poll?after="]);
    expect(stream.connection()).toBe("polling");
    await settled();
    f.advance(5_000);
    expect(f.fetched).toHaveLength(2);
  });

  it("a status frame stops the polling; the message's id is the poll cursor, and silence re-arms the poll with it", async () => {
    const f = fakeEnv();
    const stream = createStream({ mode: "full", env: f.env });
    stream.start();
    f.advance(15_000);
    expect(f.fetched).toHaveLength(1);
    await settled();
    f.sources[0]!.frame("status", { instances: [] });
    expect(stream.connection()).toBe("live");
    f.advance(12_000);
    expect(f.fetched, "the stream speaks: no poll").toHaveLength(1);
    f.sources[0]!.frame("message", { text: "hi" }, "b-7");
    f.advance(30_000);
    expect(f.fetched.at(-1), "the poll resumes from the stream's cursor").toBe("/ui/poll?after=b-7");
  });

  it("a failing stream re-fires onerror on every retry, but the 5 s deadline is armed once, not pushed back", () => {
    const f = fakeEnv();
    const stream = createStream({ mode: "full", env: f.env });
    stream.start();
    f.advance(3_000);
    f.sources[0]!.onerror!();                        // the first failure: the poll is due 5 s after it (t = 8 s)
    f.advance(2_000);
    f.sources[0]!.onerror!();                        // the browser's retry fails again: the deadline must not move
    f.advance(2_999);
    expect(f.fetched, "t = 7.999 s").toEqual([]);
    f.advance(1);
    expect(f.fetched, "t = 8 s").toEqual(["/ui/poll?after="]);
  });
});
