/**
 * #2233: signing a backend in from the web dashboard. The real LoginController (fake terminal session and listener, as
 * in login-controller.test.ts), the real WebBackendLogins, the real session store and the real /ui/backend-login routes
 * on a private scratch HTTP server. No fleet, no tmux, no CLI, no tunnel, no vendor.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import { LoginController, type LoginControllerDeps } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { extractLoginHint } from "../src/login-flows.js";
import { setLocale, t } from "../src/locale.js";
import { WebBackendLogins, WEB_LOGIN_CONFIRM_TTL_MS, WEB_LOGIN_WATCH_MS, linkableLoginUrl } from "../src/web-backend-login.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { GUEST_ROUTES } from "../src/web-guest-access.js";
import type { WebTerminalEvents, WebTerminalResult, WebTerminalSpec } from "../src/web-terminal.js";
import { credentialProfileEnv } from "../src/backend/credential-profile.js";
import { getAgendHome } from "../src/paths.js";

const TOKEN = "ABCDEFGHJKMNPQRSTVWX";
class FakeSession extends EventEmitter {
  state: "created" | "running" | "finished" = "created";
  token: string | null = TOKEN;
  constructor(readonly spec: WebTerminalSpec, readonly events: WebTerminalEvents) { super(); }
  async start(): Promise<void> { this.state = "running"; }
  peekAccessToken(): string | null { return this.token; }
  async cancel(detail = "cancelled"): Promise<void> { await this.finish({ ok: false, reason: "cancel", detail }); }
  async finish(result: WebTerminalResult): Promise<void> {
    if (this.state === "finished") return;
    this.state = "finished"; this.token = null; this.emit("finished", result); await this.events.onDone(result);
  }
}
class FakeHttp {
  /** The next listener's listen() waits for this (taken by that one listener only). */
  static gate: Promise<void> | null = null;
  private readonly held = FakeHttp.gate;
  constructor(readonly session: FakeSession, readonly opts: { hostname?: string }) { FakeHttp.gate = null; }
  async listen() { if (this.held) await this.held; return { port: 40001, url: `http://${this.opts.hostname ?? "localhost"}:40001/t/${"ab".repeat(16)}/` }; }
  async close() {}
  setExternalHost() {}
  readonly readinessMarker = "ready";
}
function hold(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  return { gate, release };
}

const servers: Server[] = [];
const registries: WebBackendLogins[] = [];
afterEach(async () => {
  vi.useRealTimers(); setLocale("en"); FakeHttp.gate = null;
  for (const r of registries.splice(0)) r.dispose();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
});

async function fixture(over: { checkAuth?: LoginControllerDeps["checkAuth"]; config?: Record<string, unknown>; installed?: boolean; ensureCloudflared?: LoginControllerDeps["ensureCloudflared"] } = {}) {
  let wall = 1_000_000;
  const token = "backend-login-scratch-token";
  const sessions = new WebSessionStore({ now: () => wall });
  const lock = new LoginWindowLock();
  const terminals: FakeSession[] = [];
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const recover = vi.fn(async () => ({ woken: [], restarted: ["agent-a"], pending: [] as string[] }));
  const controller = new LoginController({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "localhost", ...(over.config ?? {}) }) as never,
    isFleetAdmin: () => { throw new Error("a dashboard requester is never judged as a chat user"); },
    eventLog: () => ({ insert: (_i: string, type: string, payload?: Record<string, unknown>) => { events.push([type, payload]); } }),
    recoverBackendInstances: recover,
    postButtons: async () => { throw new Error("a dashboard requester gets no chat buttons"); },
    claimWindow: backend => lock.tryClaim("web", backend),
    releaseWindow: c => { lock.release(c); },
    isClaimCurrent: c => lock.isCurrent(c),
    windowBusyMessage: backend => lock.busyMessage(backend),
    windowHolder: backend => lock.holderFor(backend),
    checkAuth: over.checkAuth ?? (async () => "invalid"),
    createSession: (spec, ev) => { const s = new FakeSession(spec, ev); terminals.push(s); return s as never; },
    createHttp: (s, _l, o) => new FakeHttp(s as unknown as FakeSession, o) as never,
    now: () => wall,
    ...(over.ensureCloudflared ? {
      ensureCloudflared: over.ensureCloudflared,
      createTunnel: () => ({ start: async () => ({ ok: false, errorKind: "cancelled", message: "", leaseHeld: false }) as never, stop: async () => ({ confirmed: true, reason: "", pid: null, identity: null }) }),
    } : {}),
  });
  const isLocalAdmin = (handle: string) => {
    const r = sessions.findByHandle(handle);
    return !!r && r.tier === "admin" && r.surface === "local" && sessions.isCurrent(r, tokenEpoch(token));
  };
  const notices: Array<{ shown: string; label: string; handle: string }> = [];
  const changes = { n: 0 };
  const logins = new WebBackendLogins({
    isLocalAdmin,
    start: (backend, chat, opts) => over.installed === false ? Promise.resolve(t("login.web_dashboard_not_installed", backend, "curl …")) : controller.start(backend, chat, opts),
    accessToken: sink => controller.webAccessToken(sink),
    isActiveFor: sink => controller.isActiveFor(sink),
    cancelFor: sink => controller.cancelFor(sink),
    cancel: backend => controller.isActive() && (backend === undefined || controller.pendingBackend === backend) ? controller.cancel() : Promise.resolve(t("login.no_session")),
    notice: info => { notices.push(info); },
    changed: () => { changes.n++; },
    now: () => wall,
  });
  registries.push(logins);
  const ctx = { webToken: token, webSessions: sessions, webBackendLogins: logins } as unknown as WebApiContext;
  const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = (tier: "admin" | "read" | "guest" = "admin", label = "Firefox on Linux") => {
    const made = sessions.create({ tier, surface: "local", label, tokenEpoch: tokenEpoch(token), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "g1" } } : {}) });
    return { ...made, handle: made.record.handle, headers: { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string> };
  };
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; body: any; raw: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const r = request(`${origin}${path}`, { method, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.on("end", () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, raw, headers: res.headers, body: raw ? JSON.parse(raw) : null }); });
    });
    r.on("error", reject); r.setTimeout(5000, () => r.destroy(Error("scratch HTTP deadline")));
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const check = (s: ReturnType<typeof session>, backend: string, profile?: string) => call("POST", "/ui/backend-login/check", s.headers, { backend, ...(profile ? { profile } : {}) });
  const start = (s: ReturnType<typeof session>, confirm: string, tunnel?: boolean) => call("POST", "/ui/backend-login/start", s.headers, { confirm, ...(tunnel !== undefined ? { tunnel } : {}) });
  const view = (s: ReturnType<typeof session>) => call("GET", "/ui/backend-login", s.headers);
  return { controller, logins, sessions, lock, terminals, events, recover, notices, changes, ctx, token, origin, session, call, check, start, view, at: (ms: number) => { wall = ms; }, now: () => wall };
}

describe("#2233 who may sign a backend in from the dashboard", () => {
  it("a local admin session only: no credential 401, the CLI's header token (an agent's) 403, a read or guest session 403 — before anything runs", async () => {
    const f = await fixture();
    expect((await f.call("GET", "/ui/backend-login", { origin: f.origin })).status).toBe(401);
    expect((await f.call("POST", "/ui/backend-login/check", { "x-agend-token": f.token, origin: f.origin, "content-type": "application/json" }, { backend: "claude-code" })))
      .toMatchObject({ status: 403, body: { error: "sign_in_needs_a_local_admin" } });
    for (const tier of ["read", "guest"] as const) {
      const s = f.session(tier);
      expect(await f.view(s)).toMatchObject({ status: 403, body: { error: "sign_in_needs_a_local_admin" } });
      expect(await f.check(s, "claude-code")).toMatchObject({ status: 403, body: { error: "sign_in_needs_a_local_admin" } });
    }
    expect(f.terminals).toHaveLength(0);
    expect(f.events).toEqual([]);
  });

  it("a POST without the session's CSRF header is refused; nothing is checked or started", async () => {
    const f = await fixture(), a = f.session();
    const { "x-agend-csrf": _csrf, ...noCsrf } = a.headers;
    expect((await f.call("POST", "/ui/backend-login/check", noCsrf, { backend: "claude-code" })).status).toBe(401);
    expect(f.events).toEqual([]);
  });

  it("the public link: not in its manifest, absent from the guest table, and a bound gateway request is refused even as an admin", async () => {
    const f = await fixture();
    for (const path of ["/ui/backend-login", "/ui/backend-login/check", "/ui/backend-login/start", "/ui/backend-login/cancel"]) {
      for (const method of ["GET", "POST"]) {
        expect(isPublicWebRoute(method, path)).toBe(false);
        expect(GUEST_ROUTES.some(r => (r.methods as readonly string[]).includes(method) && r.pattern.test(path))).toBe(false);
      }
    }
    const made = f.sessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(f.token) });
    for (const [method, path] of [["GET", "/ui/backend-login"], ["POST", "/ui/backend-login/check"]] as const) {
      let status = 0;
      const res: any = { headersSent: false, setHeader() {}, writeHead(n: number) { status = n; this.headersSent = true; }, end() {} };
      const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "x.trycloudflare.com", origin: "https://x.trycloudflare.com", cookie: `__Host-agend_session=${made.sessionId}`, "x-agend-csrf": csrfTokenFor(made.sessionId) }, destroy() {}, resume() {} });
      bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
      expect(handleWebRequest(req as never, res, new URL(`https://x.trycloudflare.com${path}`), f.ctx)).toBe(true);
      expect(status).toBe(method === "GET" ? 404 : 403);
    }
  });

  it("asked again after the body: a session revoked while its request was still arriving starts nothing", async () => {
    const f = await fixture(), a = f.session();
    const id = (await f.check(a, "claude-code")).body.confirm.id;
    const body = JSON.stringify({ confirm: id });
    const answer = new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const r = request(`${f.origin}/ui/backend-login/start`, { method: "POST", headers: { ...a.headers, "content-length": String(body.length) } }, res => {
        const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode!, raw: Buffer.concat(chunks).toString() }));
      });
      r.on("error", reject);
      r.write(body.slice(0, 5));
      setTimeout(() => { f.sessions.revokeByHandle(a.handle); r.end(body.slice(5)); }, 50);
    });
    expect((await answer).status).toBe(401);
    expect(f.terminals).toHaveLength(0);
  });

  it("the controller asks the dashboard sink itself: a sink that is no longer an admin is refused even when a caller skipped the route", async () => {
    const f = await fixture();
    const sink = { isAdmin: () => false, confirm: vi.fn(), hint: vi.fn(), terminal: vi.fn(), ended: vi.fn() };
    const adapter = { type: "web", id: "web", sendText: vi.fn(async () => ({ chatId: "web", messageId: "1" })) } as never;
    expect(await f.controller.start("claude-code", { adapter, adapterId: "web", chatId: "web", userId: "web:x", web: sink }, { skipAuthCheck: true })).toBe(t("permission.denied"));
    expect(await f.controller.start("claude-code", { adapter, adapterId: "web", chatId: "web", userId: "web:x", web: sink })).toBe(t("permission.denied"));
    expect(sink.confirm).not.toHaveBeenCalled();
    expect(f.terminals).toHaveLength(0);
  });

  it("malformed bodies and unknown paths are refused", async () => {
    const f = await fixture(), a = f.session();
    expect((await f.call("POST", "/ui/backend-login/check", a.headers, { backend: "claude-code", extra: 1 })).status).toBe(400);
    expect((await f.call("POST", "/ui/backend-login/check", a.headers, { backend: "../../bin/sh" })).status).toBe(400);
    expect((await f.call("POST", "/ui/backend-login/start", a.headers, { confirm: "nope" })).status).toBe(400);
    expect((await f.call("POST", "/ui/backend-login/elsewhere", a.headers, {})).status).toBe(404);
    expect((await f.call("GET", "/ui/backend-login?x=1", a.headers)).status).toBe(404);
  });
});

describe("#2233 a terminal sign-in (claude-code) from the dashboard", () => {
  it("check → confirm (held server-side) → start: the starter sees the terminal and its access code; no-store; one notice", async () => {
    const f = await fixture(), a = f.session("admin", "Chrome on Windows");
    const asked = await f.check(a, "claude");
    expect(asked.status).toBe(200);
    expect(asked.body.confirm).toMatchObject({ backend: "claude-code", tokenPresent: false, logoutFirst: null, deviceAuth: false, id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(f.terminals).toHaveLength(0);
    expect(f.lock.isHeld, "the pre-check holds nothing while the dialog asks").toBe(false);
    const started = await f.start(a, asked.body.confirm.id);
    expect(started.status).toBe(200);
    expect(started.headers["cache-control"]).toBe("private, no-store");
    expect(started.body.login).toMatchObject({ backend: "claude-code", phase: "running", mine: true, startedOn: "Chrome on Windows", accessCode: TOKEN,
      terminal: { url: `http://localhost:40001/t/${"ab".repeat(16)}/`, loopback: true, public: false, command: "claude auth login" } });
    expect(f.terminals[0]!.spec.command).toBe("claude auth login");
    expect(f.notices).toEqual([{ shown: "claude-code", label: "Chrome on Windows", handle: a.handle }]);
    expect(f.changes.n, "the pages are told once it starts").toBe(1);
    const view = await f.view(a);
    expect(view.body.targets, "GET carries Settings' list (none in a hand-built context)").toEqual([]);
    const again = await f.view(a);
    expect(again.headers["cache-control"]).toBe("private, no-store");
    expect(again.body.login.accessCode).toBe(TOKEN);
    expect(JSON.stringify(f.events), "the audit never holds the code").not.toContain(TOKEN);
    expect(f.events.map(e => e[0])).toEqual(expect.arrayContaining(["login_web_link_sent", "login_web_token_sent"]));
    expect(f.events.find(e => e[0] === "login_web_token_sent")![1]).toMatchObject({ via: "web-session", requester: `web:${a.handle}` });
  });

  it("another admin session sees only that a sign-in runs (backend, device, phase) — never the link, the code or its lines — and may cancel it", async () => {
    const f = await fixture(), a = f.session(), b = f.session("admin", "Safari on iPhone");
    await f.start(a, (await f.check(a, "claude-code")).body.confirm.id);
    const seen = await f.view(b);
    expect(seen.body.login).toEqual({ id: expect.any(String), backend: "claude-code", phase: "running", ok: null, startedOn: "Firefox on Linux", startedAt: f.now(), endedAt: null, mine: false });
    expect(seen.raw).not.toContain(TOKEN);
    expect(seen.raw).not.toContain("/t/");
    const cancelled = await f.call("POST", "/ui/backend-login/cancel", b.headers, {});
    expect(cancelled.body.message).toBe(t("login.cancelled", "claude-code"));
    expect(f.controller.isActive()).toBe(false);
    expect((await f.view(a)).body.login).toMatchObject({ phase: "ended", ok: false, accessCode: null, terminal: null });
  });

  it("the confirm id belongs to the session it was given to, is used once, and expires", async () => {
    const f = await fixture(), a = f.session(), b = f.session();
    const id = (await f.check(a, "claude-code")).body.confirm.id;
    expect(await f.start(b, id)).toMatchObject({ status: 409, body: { error: "confirm_expired" } });
    f.at(f.now() + WEB_LOGIN_CONFIRM_TTL_MS + 1);
    expect(await f.start(a, id)).toMatchObject({ status: 409, body: { error: "confirm_expired" } });
    const fresh = (await f.check(a, "claude-code")).body.confirm.id;
    expect((await f.start(a, fresh)).status).toBe(200);
    expect(await f.start(a, fresh)).toMatchObject({ status: 409, body: { error: "confirm_expired" } });
    expect(f.terminals).toHaveLength(1);
  });

  it("whether the CLI still held a token is the server's answer, not the client's: kiro logs out first only when the pre-check found one", async () => {
    const f = await fixture({ checkAuth: async () => "valid" }), a = f.session();
    const asked = (await f.check(a, "kiro")).body.confirm;
    expect(asked).toMatchObject({ backend: "kiro-cli", tokenPresent: true, logoutFirst: "kiro-cli logout" });
    await f.start(a, asked.id);
    expect(f.terminals[0]!.spec.command).toBe("kiro-cli logout; kiro-cli login");
  });

  it("a session that signs out loses the code at once, and the watchdog ends its sign-in", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await fixture(), a = f.session();
    await f.start(a, (await f.check(a, "claude-code")).body.confirm.id);
    expect(f.controller.isActive()).toBe(true);
    f.sessions.revokeByHandle(a.handle);
    const sink = (f.logins as any).run.sink;
    expect(f.controller.webAccessToken(sink), "no live session: no code").toBeNull();
    await vi.advanceTimersByTimeAsync(WEB_LOGIN_WATCH_MS);
    expect(f.controller.isActive()).toBe(false);
    expect(f.terminals[0]!.state).toBe("finished");
  });

  it("watched from admission: a session revoked while its listener is still coming up ends that sign-in (two ticks)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await fixture(), a = f.session(), held = hold();
    const id = (await f.check(a, "claude-code")).body.confirm.id;
    FakeHttp.gate = held.gate;
    const starting = f.start(a, id);
    await vi.waitFor(() => expect(f.terminals).toHaveLength(1));
    f.sessions.revokeByHandle(a.handle);
    await vi.advanceTimersByTimeAsync(2 * WEB_LOGIN_WATCH_MS);
    expect(f.terminals[0]!.state).toBe("finished");
    expect(f.lock.isHeld).toBe(false);
    held.release();
    expect((await starting).status).toBe(200);
    expect(f.controller.isActive()).toBe(false);
  });

  it("watched from admission: a session revoked while its public link's cloudflared is still downloading stops that download; nothing opens", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let aborted = false;
    const f = await fixture({ ensureCloudflared: (_on, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { kind: "download-failed" })); });
    }) }), a = f.session();
    const asked = (await f.check(a, "claude-code")).body.confirm;
    expect(asked.publicLink).toBe(true);
    const starting = f.start(a, asked.id, true);
    await vi.waitFor(() => expect(f.controller.isActive()).toBe(true));
    f.sessions.revokeByHandle(a.handle);
    await vi.advanceTimersByTimeAsync(2 * WEB_LOGIN_WATCH_MS);
    expect(aborted).toBe(true);
    await starting;
    expect(f.terminals).toHaveLength(0);
    expect(f.controller.isActive()).toBe(false);
    expect(f.lock.isHeld).toBe(false);
  });

  it("a slower start never replaces a later one: A held, cancelled, B started; A's late end leaves B shown, and B's session revoked ends B", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await fixture(), a = f.session("admin", "A"), b = f.session("admin", "B"), held = hold();
    const idA = (await f.check(a, "claude-code")).body.confirm.id;
    FakeHttp.gate = held.gate;
    const startingA = f.start(a, idA);
    await vi.waitFor(() => expect(f.terminals).toHaveLength(1));
    await f.call("POST", "/ui/backend-login/cancel", b.headers, {});
    expect(f.terminals[0]!.state).toBe("finished");
    const startedB = await f.start(b, (await f.check(b, "claude-code")).body.confirm.id);
    expect(startedB.body.login).toMatchObject({ mine: true, phase: "running", accessCode: TOKEN });
    held.release();
    await startingA;
    expect((await f.view(b)).body.login, "B is still what is shown").toMatchObject({ mine: true, phase: "running", startedOn: "B", accessCode: TOKEN });
    f.sessions.revokeByHandle(a.handle);
    await vi.advanceTimersByTimeAsync(2 * WEB_LOGIN_WATCH_MS);
    expect(f.terminals[1]!.state, "revoking A never touches B").toBe("running");
    f.sessions.revokeByHandle(b.handle);
    await vi.advanceTimersByTimeAsync(2 * WEB_LOGIN_WATCH_MS);
    expect(f.terminals[1]!.state).toBe("finished");
    expect(f.lock.isHeld).toBe(false);
  });

  it("success: the outcome and the recovery lines reach the starter's view; the code is gone", async () => {
    const f = await fixture(), a = f.session();
    await f.start(a, (await f.check(a, "claude-code")).body.confirm.id);
    await f.terminals[0]!.finish({ ok: true, reason: "exit", detail: "success reported" });
    const v = (await f.view(a)).body.login;
    expect(v).toMatchObject({ phase: "ended", ok: true, accessCode: null, terminal: null });
    expect(v.lines[0]).toBe(t("login.completed", "claude-code"));
    expect(f.changes.n, "started, then ended").toBe(2);
    expect(v.lines.join("\n")).toContain("agent-a");
    expect(f.recover).toHaveBeenCalledWith("claude-code");
  });

  it("busy: a sign-in already running (from chat or another session) refuses the start with the window's message; nothing is replaced", async () => {
    const f = await fixture(), a = f.session(), b = f.session();
    const idB = (await f.check(b, "claude-code")).body.confirm.id;
    await f.start(a, (await f.check(a, "claude-code")).body.confirm.id);
    const refused = await f.start(b, idB);
    // The dashboard is not told to type a chat command: it gets a plain sentence and the backend whose sign-in the dialog can end.
    expect(refused.body).toEqual({ message: t("login.busy_web", "claude-code"), busy: { backend: "claude-code" } });
    expect(refused.body.message).not.toContain("/login");
    expect((await f.view(a)).body.login).toMatchObject({ mine: true, phase: "running", accessCode: TOKEN });
    expect(f.terminals).toHaveLength(1);
  });

  it("AGEND-203: connecting Grok while Claude Code's sign-in is held is not refused by it; while this controller runs Claude Code's, Grok is told whose it is and the dialog's cancel (by backend) frees it", async () => {
    // Claude Code's window held by something else (an unfinished dashboard sign-in of the structured kind): Grok asks and is confirmed.
    const f = await fixture(), a = f.session();
    const claude = f.lock.tryClaim("web", "claude-code");
    expect((await f.check(a, "grok")).body.confirm).toMatchObject({ backend: "grok" });
    const started = await f.start(a, (await f.check(a, "grok")).body.confirm.id);
    expect(started.body.login).toMatchObject({ backend: "grok", mine: true, phase: "running" });
    f.lock.release(claude);
    await f.call("POST", "/ui/backend-login/cancel", a.headers, {});

    // The controller's own session on Claude Code: Grok is refused with the web sentence, and cancelling THAT backend (not "whatever runs") frees it.
    const g = await fixture(), b = g.session(), c = g.session();
    await g.start(b, (await g.check(b, "claude-code")).body.confirm.id);
    const refused = await g.check(c, "grok");
    expect(refused.body).toEqual({ message: t("login.busy_web", "claude-code"), busy: { backend: "claude-code" } });
    // A cancel that names another backend ends nothing.
    expect((await g.call("POST", "/ui/backend-login/cancel", c.headers, { backend: "grok" })).body).toEqual({ message: t("login.no_session") });
    expect(g.terminals[0]!.state).toBe("running");
    expect((await g.call("POST", "/ui/backend-login/cancel", c.headers, { backend: "claude-code" })).status).toBe(200);
    expect(g.terminals[0]!.state).toBe("finished");
    expect(g.lock.isHeld).toBe(false);
    expect((await g.check(c, "grok")).body.confirm).toMatchObject({ backend: "grok" });
    // The body is validated: a backend name that is not one is refused, and so is anything else next to it.
    expect((await g.call("POST", "/ui/backend-login/cancel", c.headers, { backend: "../x" })).status).toBe(400);
    expect((await g.call("POST", "/ui/backend-login/cancel", c.headers, { backend: "grok", extra: 1 })).status).toBe(400);
  });

  it("not installed and unsupported (agy) are answered with words, and nothing runs; a codex profile (#3212 PR 4) is asked like any sign-in", async () => {
    const g = await fixture({ installed: false }), ga = g.session();
    expect((await g.check(ga, "codex")).body).toEqual({ message: t("login.web_dashboard_not_installed", "codex", "curl …") });
    const f = await fixture(), a = f.session();
    expect((await f.check(a, "agy")).body.message).toBe(t("login.remote_unsupported_agent_cli", "antigravity", "agy"));
    expect((await f.check(a, "codex", "work")).body.confirm).toMatchObject({ backend: "codex", profile: "work" });
    expect(f.terminals).toHaveLength(0);
  });
});

describe("#3307 named accounts use the same controller/commands/outcomes as chat /login", () => {
  it.each(["codex", "kiro-cli"])("%s: check → confirm → launch → success/cancel/expiry, always in the selected profile", async backend => {
    for (const outcome of ["success", "cancel", "ttl"] as const) {
      const checkAuth = vi.fn<NonNullable<LoginControllerDeps["checkAuth"]>>(async () => backend === "kiro-cli" ? "valid" as const : "invalid" as const);
      const f = await fixture({ checkAuth }), a = f.session(), other = f.session();
      const expectedEnv = credentialProfileEnv(getAgendHome(), backend, "work")!;
      const asked = (await f.check(a, backend, "work")).body.confirm;
      expect(asked).toMatchObject({ backend, profile: "work", deviceAuth: backend === "codex" });
      expect(checkAuth).toHaveBeenCalledOnce();
      expect(checkAuth.mock.calls[0]![1]).toEqual(expectedEnv);
      expect(f.terminals).toHaveLength(0); // the check never launches a login
      await f.start(a, asked.id);
      const terminal = f.terminals[0]!;
      const [key, home] = Object.entries(expectedEnv)[0]!;
      const login = `${key}='${home}' ${backend === "codex" ? "codex login --device-auth" : "kiro-cli login"}`;
      expect(terminal.spec.command).toBe(backend === "kiro-cli" ? `${key}='${home}' kiro-cli logout; ${login}` : login);
      expect((await f.start(a, asked.id)).body).toEqual({ error: "confirm_expired" });
      if (backend === "codex") {
        await terminal.events.onHint!("https://auth.openai.com/codex/device", "ABCD-1234");
        expect((await f.view(a)).body.login).toMatchObject({ hint: { code: "ABCD-1234" }, terminal: null, accessCode: null });
        expect((await f.view(other)).raw).not.toContain("ABCD-1234");
      } else {
        expect((await f.view(a)).body.login).toMatchObject({ accessCode: TOKEN, terminal: { loopback: true } });
        expect((await f.view(other)).raw).not.toContain(TOKEN);
      }
      if (outcome === "cancel") await f.call("POST", "/ui/backend-login/cancel", a.headers, {});
      else await terminal.finish({ ok: outcome === "success", reason: outcome === "success" ? "exit" : "ttl", detail: outcome === "success" ? "success reported" : "time limit reached" });
      const ended = (await f.view(a)).body.login;
      expect(ended).toMatchObject({ backend, profile: "work", phase: "ended", ok: outcome === "success", terminal: null, accessCode: null });
      if (outcome === "success") expect(f.recover).toHaveBeenCalledExactlyOnceWith(backend, "work");
      else expect(f.recover).not.toHaveBeenCalled();
      expect(f.lock.isHeld).toBe(false);
    }
  });
});

describe("#2233 a device-code sign-in (codex) from the dashboard", () => {
  it("the provider's URL and code go to the starter's view (a link: the vendor's own host), with no terminal or code", async () => {
    const f = await fixture(), a = f.session(), b = f.session();
    const asked = (await f.check(a, "codex")).body.confirm;
    expect(asked).toMatchObject({ deviceAuth: true, publicLink: false });
    expect((await f.start(a, asked.id, true)).body, "no public link for a device-code flow").toEqual({ error: "tunnel_not_offered" });
    await f.start(a, (await f.check(a, "codex")).body.confirm.id);
    const s = f.terminals[0]!;
    const hint = extractLoginHint("https://auth.openai.com/codex/device\nABCD-1234\n", s.spec.observe!);
    await s.events.onHint!(hint.url!, hint.code);
    expect((await f.view(a)).body.login).toMatchObject({ hint: { url: "https://auth.openai.com/codex/device", code: "ABCD-1234", linkable: true }, terminal: null, accessCode: null });
    expect((await f.view(b)).raw).not.toContain("ABCD-1234");
  });

  it("a URL off the vendor's hosts is shown as text, never a link", () => {
    expect(linkableLoginUrl("codex", "https://auth.openai.com/codex/device")).toBe(true);
    expect(linkableLoginUrl("codex", "https://openai.com.evil.example/device")).toBe(false);
    expect(linkableLoginUrl("codex", "http://auth.openai.com/codex/device")).toBe(false);
    expect(linkableLoginUrl("codex", "https://user:pw@auth.openai.com/")).toBe(false);
    expect(linkableLoginUrl("grok", "https://accounts.x.ai/device")).toBe(true);
    expect(linkableLoginUrl("grok", "https://x.ai.example/device")).toBe(false);
    expect(linkableLoginUrl("kiro-cli", "https://view.awsapps.com/start/#/device")).toBe(true);
    expect(linkableLoginUrl("opencode", "https://opencode.ai/")).toBe(false);
  });
});

describe("AGEND-207: POST /ui/backend-login/cancel {backend} — who may end a sign-in, and what it ends", () => {
  const CANCEL = "/ui/backend-login/cancel";
  /** A Claude Code sign-in running in the controller (started by `owner`); every refusal below must leave it running. */
  async function running() {
    const f = await fixture(), owner = f.session();
    await f.start(owner, (await f.check(owner, "claude-code")).body.confirm.id);
    expect(f.terminals[0]!.state).toBe("running");
    return { f, owner };
  }

  it("a local admin session only: no credential 401, the CLI's header token 403, a read or guest session 403, no CSRF header 401 — the sign-in keeps running", async () => {
    const { f, owner } = await running();
    expect((await f.call("POST", CANCEL, { origin: f.origin, "content-type": "application/json" }, { backend: "claude-code" })).status).toBe(401);
    expect((await f.call("POST", CANCEL, { "x-agend-token": f.token, origin: f.origin, "content-type": "application/json" }, { backend: "claude-code" })))
      .toMatchObject({ status: 403, body: { error: "sign_in_needs_a_local_admin" } });
    for (const tier of ["read", "guest"] as const) {
      expect(await f.call("POST", CANCEL, f.session(tier).headers, { backend: "claude-code" })).toMatchObject({ status: 403, body: { error: "sign_in_needs_a_local_admin" } });
    }
    const { "x-agend-csrf": _csrf, ...noCsrf } = owner.headers;
    expect((await f.call("POST", CANCEL, noCsrf, { backend: "claude-code" })).status).toBe(401);
    expect(f.terminals[0]!.state, "nothing was ended by any of them").toBe("running");
    expect(f.lock.heldFor("claude-code")).not.toBeNull();
    // …and the admin's own request does end it.
    expect((await f.call("POST", CANCEL, owner.headers, { backend: "claude-code" })).body).toEqual({ message: t("login.cancelled", "claude-code") });
    expect(f.terminals[0]!.state).toBe("finished");
    expect(f.lock.isHeld).toBe(false);
  });

  it("the public link: a bound gateway request is refused even as an admin, and the sign-in keeps running", async () => {
    const { f } = await running();
    const made = f.sessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(f.token) });
    let status = 0;
    const res: any = { headersSent: false, setHeader() {}, writeHead(n: number) { status = n; this.headersSent = true; }, end() {} };
    const req = Object.assign(new EventEmitter(), { method: "POST", url: CANCEL, headers: { host: "x.trycloudflare.com", origin: "https://x.trycloudflare.com", cookie: `__Host-agend_session=${made.sessionId}`, "x-agend-csrf": csrfTokenFor(made.sessionId) }, destroy() {}, resume() {} });
    bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
    expect(handleWebRequest(req as never, res, new URL(`https://x.trycloudflare.com${CANCEL}`), f.ctx)).toBe(true);
    expect(status).toBe(403);
    expect(f.terminals[0]!.state).toBe("running");
  });

  it("strictObject: `backend` next to `run`/`ifUnopened` or any other field is refused (400), as is a non-backend name — nothing is ended", async () => {
    const { f, owner } = await running();
    for (const body of [
      { backend: "claude-code", run: "a".repeat(32), ifUnopened: true }, { backend: "claude-code", extra: 1 }, { backend: "claude-code", backend2: "grok" },
      { backend: 1 }, { backend: "../x" }, { backend: "" }, { run: "a".repeat(32) }, [], "claude-code",
    ]) expect((await f.call("POST", CANCEL, owner.headers, body)).status, JSON.stringify(body)).toBe(400);
    expect(f.terminals[0]!.state).toBe("running");
  });

  it("it ends only the named backend's sign-in: another backend's name, and the install's backend, end nothing; the alias is not a backend name", async () => {
    const { f, owner } = await running();
    expect((await f.call("POST", CANCEL, owner.headers, { backend: "grok" })).body).toEqual({ message: t("login.no_session") });
    expect((await f.call("POST", CANCEL, owner.headers, { backend: "claude" })).body, "the aliases are the chat's: the dialog sends the real name").toEqual({ message: t("login.no_session") });
    expect(f.terminals[0]!.state).toBe("running");
    expect((await f.call("POST", CANCEL, owner.headers, { backend: "Claude-Code" })).body).toEqual({ message: t("login.cancelled", "claude-code") });
    expect(f.terminals[0]!.state).toBe("finished");
  });
});

describe("AGEND-207: a refused start offers the cancel button only when something can be cancelled", () => {
  it("a sign-out, Remove or keep-alive refresh holding the backend: plain words, no `busy` (no button); an install: its own sentence, no `busy`; a sign-in: `busy`", async () => {
    const f = await fixture(), a = f.session();
    for (const kind of ["account", "keepalive"] as const) {
      const held = f.lock.tryClaim(kind, "claude-code")!;
      const refused = await f.check(a, "claude-code");
      expect(refused.body, kind).toEqual({ message: t("login.busy_wait", "claude-code") });
      expect(refused.body.message).not.toContain("/login");
      f.lock.release(held);
    }
    const install = f.lock.tryClaim("install", "claude-code")!;
    expect((await f.check(a, "claude-code")).body).toEqual({ message: t("install.busy") });
    f.lock.release(install);
    const signIn = f.lock.tryClaim("web", "claude-code")!;
    expect((await f.check(a, "claude-code")).body).toEqual({ message: t("login.busy_web", "claude-code"), busy: { backend: "claude-code" } });
    f.lock.release(signIn);
  });

  it("the Chinese sentence is wired too", () => {
    setLocale("zh-TW");
    expect(t("login.busy_wait", "claude-code")).toContain("claude-code");
    expect(t("login.busy_wait", "claude-code")).not.toBe("login.busy_wait");
    expect(t("login.busy_wait", "claude-code")).toMatch(/[一-鿿]/);
  });
});

describe("AGEND-207: two backends starting together — the second is refused while the first is starting, and cancelling reaches the first", () => {
  it("claude-code's public-link start is still getting its cloudflared: Grok is refused naming claude-code; cancel {backend: claude-code} aborts it, frees the window, and Grok is then asked", async () => {
    let aborted = false;
    const f = await fixture({ ensureCloudflared: (_on, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { kind: "download-failed" })); });
    }) }), a = f.session(), b = f.session();
    const asked = (await f.check(a, "claude-code")).body.confirm;
    const startA = f.start(a, asked.id, true);
    await vi.waitFor(() => expect(f.controller.pendingBackend).toBe("claude-code"));
    expect(f.controller.signingIn("claude-code", null)).toBe(true);
    // The second backend: its own window is free, but the controller is busy with the first — refused, and the dialog is told which backend to end.
    expect((await f.check(b, "grok")).body).toEqual({ message: t("login.busy_web", "claude-code"), busy: { backend: "claude-code" } });
    expect(f.lock.heldFor("grok"), "the refused start left no window behind").toBeNull();
    expect((await f.call("POST", "/ui/backend-login/cancel", b.headers, { backend: "grok" })).body).toEqual({ message: t("login.no_session") });
    expect(aborted).toBe(false);
    expect((await f.call("POST", "/ui/backend-login/cancel", b.headers, { backend: "claude-code" })).status).toBe(200);
    expect(aborted).toBe(true);
    await startA;
    expect(f.terminals).toHaveLength(0);
    expect(f.lock.isHeld).toBe(false);
    expect((await f.check(b, "grok")).body.confirm).toMatchObject({ backend: "grok" });
  });

  it("a start between its claim and its session (the controller's `starting`): it counts as pending, the second backend is refused, and cancel ends it by releasing its window", async () => {
    const f = await fixture(), b = f.session();
    // The state a confirmed start is in until it publishes its session (no await separates them for a local start, so it is set up directly).
    const claim = f.lock.tryClaim("web", "claude-code")!;
    (f.controller as any).starting.set(claim.id, { backend: "claude-code", claim });
    expect(f.controller.isActive()).toBe(true);
    expect(f.controller.pendingBackend).toBe("claude-code");
    expect((await f.check(b, "grok")).body).toEqual({ message: t("login.busy_web", "claude-code"), busy: { backend: "claude-code" } });
    expect(f.lock.heldFor("grok")).toBeNull();
    // Another backend's cancel leaves it; its own ends it — the window is released, so the start that owns the claim sees it was lost (`stale`) and stops.
    expect((await f.call("POST", "/ui/backend-login/cancel", b.headers, { backend: "grok" })).body).toEqual({ message: t("login.no_session") });
    expect(f.lock.isCurrent(claim)).toBe(true);
    expect((await f.call("POST", "/ui/backend-login/cancel", b.headers, { backend: "claude-code" })).body).toEqual({ message: t("login.cancelled", "claude-code") });
    expect(f.lock.isCurrent(claim)).toBe(false);
    expect(f.controller.pendingBackend, "a start whose claim is gone no longer counts").toBeNull();
    expect(f.controller.isActive()).toBe(false);
    (f.controller as any).starting.delete(claim.id);
    expect((await f.check(b, "grok")).body.confirm).toMatchObject({ backend: "grok" });
  });

  it("two confirmed starts for different backends at once: the first runs, the second is refused (no second session, no window held for it); after the first ends the second starts", async () => {
    const f = await fixture(), a = f.session(), b = f.session();
    const idA = (await f.check(a, "claude-code")).body.confirm.id, idB = (await f.check(b, "grok")).body.confirm.id;
    const held = hold();
    FakeHttp.gate = held.gate;                                          // claude-code's listener is slow: its start is mid-flight when grok's arrives
    const startA = f.start(a, idA);
    await vi.waitFor(() => expect(f.terminals).toHaveLength(1));
    const refused = await f.start(b, idB);
    expect(refused.body).toEqual({ message: t("login.busy_web", "claude-code"), busy: { backend: "claude-code" } });
    expect(f.terminals, "the second backend got no session").toHaveLength(1);
    expect(f.lock.heldFor("grok")).toBeNull();
    held.release();
    expect((await startA).status).toBe(200);
    await f.terminals[0]!.finish({ ok: true, reason: "exit", detail: "success reported" });
    expect((await f.check(b, "grok")).body.confirm).toMatchObject({ backend: "grok" });
  });
});
