import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { broadcastSseEvent, UiMessageLog } from "../src/web-api.js";
import { bypassesWebGate } from "../src/auth-api.js";
import { isViewPath } from "../src/view-api.js";
import { isUsagePath } from "../src/usage/usage-api.js";
import { csrfTokenFor } from "../src/web-session.js";

const ui = (name: string) => readFileSync(join(process.cwd(), "src", "ui", name), "utf8");

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("UiMessageLog", () => {
  it("numbers messages from 1 and returns only what is after an id", () => {
    const log = new UiMessageLog();
    expect(log.last).toBe(0);
    expect(log.append({ instance: "a", text: "one" })).toBe(1);
    expect(log.append({ instance: "b", text: "two" })).toBe(2);
    expect(log.append({ instance: "a", text: "three" })).toBe(3);

    expect(log.since(0).map(m => m.text)).toEqual(["one", "two", "three"]);
    expect(log.since(2).map(m => m.text)).toEqual(["three"]);
    expect(log.since(3)).toEqual([]);
    expect(log.last).toBe(3);
  });

  it("gives an id of its own even to a message that already had one", () => {
    const log = new UiMessageLog();
    log.append({ id: 999, text: "x" });
    expect(log.since(0)[0]!.id).toBe(1);
  });

  it("keeps only the newest N, and still answers correctly about older ids", () => {
    const log = new UiMessageLog(3);
    for (let i = 1; i <= 5; i++) log.append({ n: i });
    expect(log.since(0).map(m => m.n)).toEqual([3, 4, 5]);
    expect(log.since(4).map(m => m.n)).toEqual([5]);
  });

  it("does not replay a conversation to a client that is ahead of it (the fleet restarted)", () => {
    const log = new UiMessageLog();
    log.append({ text: "after the restart" });
    expect(log.since(500)).toEqual([]);
    expect(log.last).toBe(1);
  });

  it("wraps a non-object payload instead of dropping it", () => {
    const log = new UiMessageLog();
    log.append("plain");
    expect(log.since(0)).toEqual([{ value: "plain", id: 1 }]);
  });
});

describe("SSE frames", () => {
  const fakeClient = () => ({ written: [] as string[], write(p: string) { this.written.push(p); return true; }, end() {} });

  it("carry an id when they have one, and are otherwise unchanged", () => {
    const a = fakeClient();
    broadcastSseEvent(new Set([a]) as never, "message", { text: "hi" }, undefined, 7);
    expect(a.written[0]).toBe('id: 7\nevent: message\ndata: {"text":"hi"}\n\n');

    const b = fakeClient();
    broadcastSseEvent(new Set([b]) as never, "status", { ok: true });
    expect(b.written[0]).toBe('event: status\ndata: {"ok":true}\n\n');
  });
});

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
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
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
  it("returns the status and the messages after an id, to a signed-in session only", async () => {
    const h = await startFleet();
    h.fm.emitSseEvent("message", { instance: "a", sender: "agent", text: "one", ts: 1 });
    h.fm.emitSseEvent("message", { instance: "a", sender: "agent", text: "two", ts: 2 });
    h.fm.emitSseEvent("status", { ignored: true });

    const all = JSON.parse((await raw(h.port, "GET", "/ui/poll?after=0", { cookie: h.cookie })).body);
    expect(all.messages.map((m: { text: string }) => m.text)).toEqual(["one", "two"]);
    expect(all.last).toBe(2);
    expect(all.status).toHaveProperty("instances");

    const after = JSON.parse((await raw(h.port, "GET", "/ui/poll?after=1", { cookie: h.cookie })).body);
    expect(after.messages.map((m: { text: string }) => m.text)).toEqual(["two"]);
    const none = JSON.parse((await raw(h.port, "GET", "/ui/poll?after=2", { cookie: h.cookie })).body);
    expect(none.messages).toEqual([]);

    for (const junk of ["", "?after=abc", "?after=-5", "?after=1e9"]) {
      expect((await raw(h.port, "GET", `/ui/poll${junk}`, { cookie: h.cookie })).status, junk).toBe(200);
    }
    expect((await raw(h.port, "GET", "/ui/poll?after=0")).status).toBe(401);
    // Status events are not messages: only chat is numbered.
    expect(h.fm.uiMessages.last).toBe(2);
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
    // A message already shown by a poll is not shown again when the stream returns.
    expect(html).toContain("id <= lastMsgId");
  });
});
