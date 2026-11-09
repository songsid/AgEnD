/**
 * #3321 review: the dialog's own Close and Remove's "Cancel sign-in and remove" were not bound to the sign-in they describe. Both sent the generic
 * `/ui/backend-login/cancel` `{}`, which cancels whatever sign-in is current — so a Close that arrives late (the page read two seconds ago) could end a
 * sign-in another admin started since, or one whose terminal had been opened meanwhile.
 *
 * Now, on the server:
 *  - Close is `{ run, ifUnopened: true }`: it ends run `run` only while that run is still running, was started by the calling session (still a local
 *    admin), and its terminal's one-time access code is unredeemed — read as the cancel starts. Anything else is left alone: `{ cancelled: false }`.
 *  - "Cancel sign-in and remove" is one `DELETE /ui/accounts/<backend>/<name>` with `cancelSignIn: true`: the sign-in of exactly that account is ended
 *    (LoginController.cancelAccount), never another account's, then every Remove check runs as usual.
 *  - The explicit "Cancel sign-in" button is unchanged: `{}` cancels what is running.
 * The real LoginController (fake terminal session and listener), the real WebBackendLogins, the real session store and the real routes on a private scratch
 * HTTP server, as web-backend-login-2233.test.ts; no fleet, tmux, CLI, tunnel or vendor.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginController, type LoginChat, type WebLoginSink } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { setLocale, t } from "../src/locale.js";
import { WebBackendLogins } from "../src/web-backend-login.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { WebTerminalEvents, WebTerminalResult, WebTerminalSpec } from "../src/web-terminal.js";

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
  constructor(readonly session: FakeSession, readonly opts: { hostname?: string }) {}
  async listen() { return { port: 40001, url: `http://${this.opts.hostname ?? "localhost"}:40001/t/${"ab".repeat(16)}/` }; }
  async close() {}
  setExternalHost() {}
  readonly readinessMarker = "ready";
}

const servers: Server[] = [];
const registries: WebBackendLogins[] = [];
const dirs: string[] = [];
afterEach(async () => {
  setLocale("en");
  for (const r of registries.splice(0)) r.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
});

async function fixture(extra: Partial<WebApiContext> = {}) {
  const wall = 1_000_000;
  const token = "signin-fence-scratch-token";
  const sessions = new WebSessionStore({ now: () => wall });
  const lock = new LoginWindowLock();
  const terminals: FakeSession[] = [];
  const controller = new LoginController({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "localhost" }) as never,
    isFleetAdmin: () => { throw new Error("a dashboard requester is never judged as a chat user"); },
    eventLog: () => ({ insert: () => {} }),
    recoverBackendInstances: vi.fn(async () => ({ woken: [], restarted: [], pending: [] as string[] })),
    postButtons: async () => { throw new Error("a dashboard requester gets no chat buttons"); },
    claimWindow: backend => lock.tryClaim("web", backend),
    releaseWindow: c => { lock.release(c); },
    isClaimCurrent: c => lock.isCurrent(c),
    windowBusyMessage: () => lock.busyMessage(),
    checkAuth: async () => "invalid",
    createSession: (spec, ev) => { const s = new FakeSession(spec, ev); terminals.push(s); return s as never; },
    createHttp: (s, _l, o) => new FakeHttp(s as unknown as FakeSession, o) as never,
    now: () => wall,
  });
  /** Handles of sessions that have stopped being a local admin (signed out, expired, revoked) — as the registry's watchdog asks. */
  const revoked = new Set<string>();
  const isLocalAdmin = (handle: string) => {
    const r = sessions.findByHandle(handle);
    return !revoked.has(handle) && !!r && r.tier === "admin" && r.surface === "local" && sessions.isCurrent(r, tokenEpoch(token));
  };
  const logins = new WebBackendLogins({
    isLocalAdmin,
    start: (backend, chat, opts) => controller.start(backend, chat, opts),
    accessToken: sink => controller.webAccessToken(sink),
    isActiveFor: sink => controller.isActiveFor(sink),
    cancelFor: (sink, opts) => controller.cancelFor(sink, opts),
    cancel: () => controller.isActive() ? controller.cancel() : Promise.resolve(t("login.no_session")),
    notice: () => {}, changed: () => {}, now: () => wall,
  });
  registries.push(logins);
  const ctx = { webToken: token, webSessions: sessions, webBackendLogins: logins, ...extra } as unknown as WebApiContext;
  const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = (label = "Firefox on Linux") => {
    const made = sessions.create({ tier: "admin", surface: "local", label, tokenEpoch: tokenEpoch(token) });
    return { handle: made.record.handle, headers: { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string> };
  };
  type S = ReturnType<typeof session>;
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = request(`${origin}${path}`, { method, headers: { ...headers, ...(data ? { "content-length": String(data.length) } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.on("end", () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); });
    });
    r.on("error", reject); r.setTimeout(5000, () => r.destroy(Error("scratch HTTP deadline")));
    r.end(data);
  });
  /** A sign-in this session starts for claude-code's default login (check, then start): the view it is given. */
  const signIn = async (s: S) => {
    const asked = await call("POST", "/ui/backend-login/check", s.headers, { backend: "claude-code" });
    expect(asked.status).toBe(200);
    const started = await call("POST", "/ui/backend-login/start", s.headers, { confirm: asked.body.confirm.id });
    expect(started.status).toBe(200);
    return started.body.login as { id: string; phase: string; mine: boolean; accessCode?: string | null };
  };
  const close = (s: S, run: string) => call("POST", "/ui/backend-login/cancel", s.headers, { run, ifUnopened: true });
  const view = (s: S) => call("GET", "/ui/backend-login", s.headers);
  return { controller, logins, sessions, terminals, session, call, signIn, close, view, ctx, revoked };
}

describe("the dialog's Close is bound to the run it was closed on (#3321 review)", () => {
  it("yours, running, its terminal unopened: ends that run (and the answer says so)", async () => {
    const f = await fixture(), a = f.session();
    const run = await f.signIn(a);
    expect(run).toMatchObject({ phase: "running", mine: true, accessCode: TOKEN });
    expect(await f.close(a, run.id)).toEqual({ status: 200, body: { cancelled: true } });
    expect(f.terminals[0]!.state).toBe("finished");
    expect((await f.view(a)).body.login).toMatchObject({ id: run.id, phase: "ended" });
  });

  it("A's stale Close, after A ended and another admin started B: B is left alone", async () => {
    const f = await fixture(), a = f.session("A's browser"), b = f.session("B's browser");
    const runA = await f.signIn(a);
    await f.terminals[0]!.finish({ ok: true, reason: "exit", exitCode: 0, detail: "" });                                           // A's sign-in ended (it was done, or someone cancelled it)
    const runB = await f.signIn(b);
    expect(runB.id).not.toBe(runA.id);
    expect(await f.close(a, runA.id)).toEqual({ status: 200, body: { cancelled: false } });   // the Close that A's page sent late
    expect(f.terminals[1]!.state).toBe("running");                                        // B is untouched …
    expect((await f.view(b)).body.login).toMatchObject({ id: runB.id, phase: "running", mine: true });
    expect(f.controller.isActive()).toBe(true);
    // … and the same stale Close, naming a run that never existed, is just as harmless
    expect(await f.close(a, "f".repeat(32))).toEqual({ status: 200, body: { cancelled: false } });
    expect(f.terminals[1]!.state).toBe("running");
  });

  it("someone has opened the terminal since the page read it (the access code is used): the stale Close does not cancel the open terminal", async () => {
    const f = await fixture(), a = f.session();
    const run = await f.signIn(a);
    expect(run.accessCode).toBe(TOKEN);                                                   // what the page saw
    f.terminals[0]!.token = null;                                                         // the code is redeemed: the terminal is open
    expect(await f.close(a, run.id)).toEqual({ status: 200, body: { cancelled: false } });
    expect(f.terminals[0]!.state).toBe("running");
    expect((await f.view(a)).body.login).toMatchObject({ id: run.id, phase: "running", accessCode: null });
  });

  it("another admin's Close naming your run does not end it: only the session that started a run closes it", async () => {
    const f = await fixture(), a = f.session("A's browser"), other = f.session("another admin's browser");
    const run = await f.signIn(a);
    expect(await f.close(other, run.id)).toEqual({ status: 200, body: { cancelled: false } });
    expect(f.terminals[0]!.state).toBe("running");
    expect(await f.close(a, run.id)).toEqual({ status: 200, body: { cancelled: true } });   // the starter's own does
  });

  it("a session that is no longer a local admin closes nothing", async () => {
    const f = await fixture(), a = f.session();
    const run = await f.signIn(a);
    f.revoked.add(a.handle);                                                              // the starter's session stops being a local admin (the registry's watchdog would end the run within seconds)
    expect(await f.close(a, run.id)).toEqual({ status: 200, body: { cancelled: false } });
    expect(f.terminals[0]!.state).toBe("running");
    expect(await f.logins.closeRun({ handle: a.handle, label: "x" }, run.id)).toEqual({ cancelled: false });
  });

  it("the explicit “Cancel sign-in” is as it was: `{}` ends what is running, whoever started it", async () => {
    const f = await fixture(), a = f.session("A's browser"), b = f.session("B's browser");
    await f.signIn(a);
    const r = await f.call("POST", "/ui/backend-login/cancel", b.headers, {});
    expect(r.status).toBe(200);
    expect(typeof r.body.message).toBe("string");
    expect(f.terminals[0]!.state).toBe("finished");
  });

  it("the body is closed: a run is a 32-hex id with ifUnopened: true, and nothing else", async () => {
    const f = await fixture(), a = f.session();
    const run = await f.signIn(a);
    for (const body of [{ run: "nothex" }, { run: run.id }, { ifUnopened: true }, { run: run.id, ifUnopened: false }, { run: run.id, ifUnopened: true, extra: 1 }, { run: 5, ifUnopened: true }, []]) {
      expect((await f.call("POST", "/ui/backend-login/cancel", a.headers, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(f.terminals[0]!.state).toBe("running");                                        // none of them cancelled anything
  });
});

describe("LoginController.cancelFor / cancelAccount (#3321 review)", () => {
  const sinkOf = (admin = true): WebLoginSink => ({ isAdmin: () => admin, confirm: () => {}, hint: () => {}, terminal: () => {}, ended: () => {} });
  const active = (over: Record<string, unknown> = {}) => {
    const sink = sinkOf(), cancel = vi.fn(async () => {});
    const entry = { backend: "claude-code", profile: "work", chat: { web: sink } as unknown as LoginChat, http: {}, session: { peekAccessToken: () => "CODE", cancel }, ...over };
    return { sink, cancel, self: { active: entry, pendingTunnelStart: null } as any };
  };
  const cancelFor = (self: unknown, sink: WebLoginSink, opts?: { unopenedTerminalOnly?: boolean }) => (LoginController.prototype as any).cancelFor.call(self, sink, opts) as Promise<boolean>;
  const cancelAccount = (self: unknown, backend: string, profile: string) => (LoginController.prototype as any).cancelAccount.call(self, backend, profile) as Promise<boolean>;

  it("cancelFor with unopenedTerminalOnly: only while the terminal's code is unredeemed, the sink's own, an admin's, with a listener", async () => {
    let x = active();
    expect(await cancelFor(x.self, x.sink, { unopenedTerminalOnly: true })).toBe(true);
    expect(x.cancel).toHaveBeenCalledOnce();
    x = active({ session: { peekAccessToken: () => null, cancel: vi.fn(async () => {}) } });                    // code redeemed: the terminal is open
    expect(await cancelFor(x.self, x.sink, { unopenedTerminalOnly: true })).toBe(false);
    expect(x.self.active.session.cancel).not.toHaveBeenCalled();
    x = active({ http: null });                                                                                   // no listener: no terminal to be unopened
    expect(await cancelFor(x.self, x.sink, { unopenedTerminalOnly: true })).toBe(false);
    expect(x.cancel).not.toHaveBeenCalled();
    x = active();
    expect(await cancelFor(x.self, sinkOf(), { unopenedTerminalOnly: true })).toBe(false);                        // another sink's run
    expect(x.cancel).not.toHaveBeenCalled();
    x = active({ chat: { web: sinkOf(false) } });
    expect(await cancelFor(x.self, x.self.active.chat.web, { unopenedTerminalOnly: true })).toBe(false);          // the session is no longer an admin
    expect(x.cancel).not.toHaveBeenCalled();
  });

  it("cancelFor without the option is as it was: the sink's own run, whatever state its terminal is in", async () => {
    const x = active({ session: { peekAccessToken: () => null, cancel: vi.fn(async () => {}) } });
    expect(await cancelFor(x.self, x.sink)).toBe(true);
    expect(x.self.active.session.cancel).toHaveBeenCalledOnce();
  });

  it("a start still getting its cloudflared has no terminal: unopenedTerminalOnly leaves it, the plain cancelFor aborts it", async () => {
    const sink = sinkOf(), abort = new AbortController();
    const self: any = { active: null, pendingTunnelStart: { backend: "claude-code", abort, sink } };
    expect(await cancelFor(self, sink, { unopenedTerminalOnly: true })).toBe(false);
    expect(abort.signal.aborted).toBe(false);
    expect(await cancelFor(self, sink)).toBe(true);
    expect(abort.signal.aborted).toBe(true);
  });

  it("cancelAccount: that account's sign-in only — the backend and the profile (case-insensitive, as Remove compares) both must match", async () => {
    let x = active();
    expect(await cancelAccount(x.self, "claude-code", "work")).toBe(true);
    expect(x.cancel).toHaveBeenCalledOnce();
    x = active();
    expect(await cancelAccount(x.self, "claude-code", "Work")).toBe(true);                                      // one account on a case-insensitive disk
    for (const [backend, profile] of [["claude-code", "other"], ["codex", "work"], ["claude-code", ""]] as const) {
      x = active();
      expect(await cancelAccount(x.self, backend, profile), `${backend}/${profile}`).toBe(false);
      expect(x.cancel).not.toHaveBeenCalled();
    }
    x = active({ profile: undefined });                                                                           // the default login is no account's
    expect(await cancelAccount(x.self, "claude-code", "work")).toBe(false);
    expect(x.cancel).not.toHaveBeenCalled();
    expect(await cancelAccount({ active: null, pendingTunnelStart: { backend: "claude-code", abort: new AbortController() } }, "claude-code", "work")).toBe(false);   // profile not known yet: not guessed at
  });
});

describe("Remove with cancelSignIn (#3321 review)", () => {
  async function routes() {
    const rm = vi.fn((..._a: unknown[]) => ({ ok: true }) as any);
    const f = await fixture({ removeAccountProfile: rm as never, addAccountProfile: (() => ({ ok: true })) as never });
    return { ...f, rm, a: f.session() };
  }

  it("the route passes cancelSignIn to the fleet for a host account, once, with the typed name — and without it as before", async () => {
    const f = await routes();
    expect(await f.call("DELETE", "/ui/accounts/claude-code/CHY", f.a.headers, { confirm: "CHY", cancelSignIn: true })).toEqual({ status: 200, body: { removed: "CHY" } });
    expect(f.rm).toHaveBeenCalledTimes(1);
    expect(f.rm).toHaveBeenCalledWith("claude-code", "CHY", "CHY", "Firefox on Linux", undefined, { cancelSignIn: true });
    f.rm.mockClear();
    await f.call("DELETE", "/ui/accounts/claude-code/CHY", f.a.headers, { confirm: "CHY" });
    expect(f.rm).toHaveBeenCalledWith("claude-code", "CHY", "CHY", "Firefox on Linux");
  });

  it("not for a paired computer's account, not as `false`, not with other fields: refused before anything is called", async () => {
    const f = await routes();
    const machine = "0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f";
    for (const body of [{ confirm: "CHY", cancelSignIn: true, machine }, { confirm: "CHY", cancelSignIn: false }, { confirm: "CHY", cancelSignIn: "yes" }, { confirm: "CHY", cancelSignIn: true, run: "x" }]) {
      expect((await f.call("DELETE", "/ui/accounts/claude-code/CHY", f.a.headers, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(f.rm).not.toHaveBeenCalled();
  });

  /** FleetManager.removeAccountProfile on a scratch data dir holding profile `spare`, its login controller a stand-in that records what it was asked. */
  function fleet(loginController: Record<string, unknown>, signingIn: (backend: string, profile: string) => boolean = () => false) {
    const data = mkdtempSync(join(tmpdir(), "agend-cancel-remove-")); dirs.push(data);
    const home = join(data, "credential-profiles", "claude-code", "spare");
    mkdirSync(home, { recursive: true }); writeFileSync(join(home, ".credentials.json"), "{}");
    const info = vi.fn();
    const self: any = {
      dataDir: data, logger: { info },
      accountUses: () => ({ agents: [], classic: [], fleetDefaults: new Map() }),
      loginWindow: { current: null }, loginController: { signingIn, activeBackend: null, ...loginController },
      removalRequest: (FleetManager.prototype as any).removalRequest, withAccountWriter: (FleetManager.prototype as any).withAccountWriter, accountWriters: new Set(),
    };
    const call = (...a: unknown[]): Promise<any> => (FleetManager.prototype as any).removeAccountProfile.call(self, ...a);
    return { self, call, info, home };
  }

  it("FleetManager: it ends the sign-in of THIS account first, then removes it; the fleet log says so, with no path", async () => {
    let signing = true;
    const cancelAccount = vi.fn(async () => { signing = false; return true; });
    const f = fleet({ cancelAccount }, () => signing);
    expect(await f.call("claude-code", "spare", "spare", "Firefox on Linux", undefined, { cancelSignIn: true })).toEqual({ ok: true });
    expect(cancelAccount).toHaveBeenCalledExactlyOnceWith("claude-code", "spare");
    expect(f.info).toHaveBeenCalledWith({ backend: "claude-code", profile: "spare", by: "Firefox on Linux" }, "Sign-in cancelled for Remove");
    expect(JSON.stringify(f.info.mock.calls)).not.toContain(f.home);
  });

  it("without cancelSignIn nothing is cancelled and a running sign-in still refuses; for a paired computer's account the fleet is never asked", async () => {
    const cancelAccount = vi.fn(async () => true);
    const f = fleet({ cancelAccount }, () => true);
    expect(await f.call("claude-code", "spare", "spare", "x")).toEqual({ ok: false, error: "signing_in" });
    expect(cancelAccount).not.toHaveBeenCalled();
    const machineAccounts = { remove: vi.fn(async () => ({ ok: true })) };
    f.self.machineAccounts = machineAccounts;
    await f.call("claude-code", "spare", "spare", "x", { id: "m1", actor: "admin:x" }, { cancelSignIn: true });
    expect(cancelAccount).not.toHaveBeenCalled();
    expect(machineAccounts.remove).toHaveBeenCalledOnce();
  });

  it("a replacement sign-in for the same account after the cancel still refuses: the Remove checks are made as usual, nothing is removed", async () => {
    const f = fleet({ cancelAccount: vi.fn(async () => true) }, () => true);                    // another sign-in for `spare` took the window right after
    expect(await f.call("claude-code", "spare", "spare", "x", undefined, { cancelSignIn: true })).toEqual({ ok: false, error: "signing_in" });
  });

  it("a name that is not a valid profile name, or a controller that throws, never stops the Remove checks from running", async () => {
    const cancelAccount = vi.fn(async () => { throw new Error("controller gone"); });
    const f = fleet({ cancelAccount });
    expect(await f.call("claude-code", "bad/name", "bad/name", "x", undefined, { cancelSignIn: true })).toMatchObject({ ok: false });
    expect(cancelAccount).not.toHaveBeenCalled();
    expect(await f.call("claude-code", "spare", "spare", "x", undefined, { cancelSignIn: true })).toEqual({ ok: true });   // the cancel threw: Remove went on
    expect(cancelAccount).toHaveBeenCalledOnce();
  });
});
