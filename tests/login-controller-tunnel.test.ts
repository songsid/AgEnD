import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginController, type LoginControllerDeps, type LoginChat, type LoginTunnelPort } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { setLocale, t } from "../src/locale.js";
import { ManagedTunnel, type ManagedStartResult } from "../src/tunnel/manager.js";
import { leasePath } from "../src/tunnel/lease.js";
import { TunnelStartError, type TunnelHandle, type TunnelProvider, type TunnelStartContext, type TunnelStopResult } from "../src/tunnel/types.js";
import type { WebTerminalEvents, WebTerminalResult, WebTerminalSpec } from "../src/web-terminal.js";

/**
 * The public-link option of /login (web_terminal.tunnel.allow_public).
 *
 * What these pin, in the order the feature can hurt: nothing is offered unless the config AND the
 * flow allow it · the consent is its own button, re-checked when pressed · the public URL and the
 * token reach ONLY the requester, as two private messages, and never the channel · a delivery
 * failure, a failed start, a lost tunnel, a cancel, a TTL and a shutdown all end with the tunnel
 * stopped (and stopped BEFORE the window is released) · a tunnel that cannot be confirmed stopped
 * is announced · the public name is never logged or audited.
 */
const TUNNEL_HOST = "calm-river-1.trycloudflare.com";
const TUNNEL_PAGE = `https://${TUNNEL_HOST}/t/${"ab".repeat(16)}/`;
const TOKEN = "ABCDEFGHJKMNPQRSTVWX";
const CONFIRMED = { skipAuthCheck: true } as const;
const CONFIRMED_TUNNEL = { skipAuthCheck: true, tunnel: true } as const;
const ON = { web_terminal: { tunnel: { allow_public: true } } };

class FakeSession extends EventEmitter {
  /** A session whose cancel() fails and never reports done: the tunnel must still be closed by the caller. */
  static cancelThrows = false;
  state: "created" | "running" | "finished" = "created";
  token: string | null = TOKEN;
  cancelled: string[] = [];
  constructor(readonly spec: WebTerminalSpec, readonly events: WebTerminalEvents) { super(); }
  async start(): Promise<void> { this.state = "running"; }
  peekAccessToken(): string | null { return this.token; }
  async cancel(detail = "cancelled"): Promise<void> {
    if (this.state === "finished") return;
    this.cancelled.push(detail);
    if (FakeSession.cancelThrows) throw new Error("tmux kill failed");
    await this.finish({ ok: false, reason: "cancel", detail });
  }
  async finish(result: WebTerminalResult): Promise<void> {
    this.state = "finished";
    this.token = null;
    this.emit("finished", result);
    await this.events.onDone(result);
  }
}
class FakeHttp {
  closed = false;
  /** Every value the controller has handed setExternalHost, in order. */
  externalHistory: Array<string | null> = [];
  externalHost: string | null = null;
  readonly readinessMarker = `agend-terminal:${"ab".repeat(16)}`;
  constructor(readonly session: FakeSession, readonly opts: { hostname?: string; bind?: string }) {}
  async listen(): Promise<{ port: number; url: string }> {
    return { port: 40001, url: `http://${this.opts.hostname ?? "localhost"}:40001/t/${"ab".repeat(16)}/` };
  }
  setExternalHost(host: string | null): void { this.externalHost = host; this.externalHistory.push(host); }
  async close(): Promise<void> { this.closed = true; }
}

interface FakeTunnelOpts {
  start?: () => Promise<ManagedStartResult>;
  stop?: () => Promise<TunnelStopResult>;
  /** false: a provider that never calls onCandidateHost (the controller must still publish the host once up). */
  announce?: boolean;
}
function okHandle(exitListeners: Array<(exit: { code: number | null; signal: null }) => void> = []): TunnelHandle {
  return {
    provider: "cloudflared", visibility: "public", baseUrl: `https://${TUNNEL_HOST}`, pageUrl: TUNNEL_PAGE, pid: 4242, identity: "id",
    stop: async () => ({ confirmed: true }),
    onUnexpectedExit: l => { exitListeners.push(l); return () => {}; },
  };
}
function fakeTunnel(opts: FakeTunnelOpts = {}) {
  const calls: { ctx: TunnelStartContext[]; stops: string[]; stoppedBeforeStartSettled: boolean[] } = { ctx: [], stops: [], stoppedBeforeStartSettled: [] };
  let startSettled = false;
  const exitListeners: Array<(exit: { code: number | null; signal: null }) => void> = [];
  const handle = okHandle(exitListeners);
  const port: LoginTunnelPort = {
    start: async ctx => {
      calls.ctx.push(ctx);
      if (opts.announce !== false) ctx.onCandidateHost?.(TUNNEL_HOST);
      try { return opts.start ? await opts.start() : { ok: true, handle }; } finally { startSettled = true; }
    },
    stop: async reason => {
      calls.stops.push(reason);
      calls.stoppedBeforeStartSettled.push(calls.ctx.length > 0 && !startSettled);
      return opts.stop ? opts.stop() : { confirmed: true };
    },
  };
  return { port, calls, die: () => exitListeners.forEach(l => l({ code: 1, signal: null })) };
}

function adapterOf(type: "discord" | "telegram", o: { noDirect?: boolean; failDirectAt?: number[] } = {}) {
  let n = 0;
  const a: Record<string, unknown> = {
    id: type, type,
    sendText: vi.fn(async () => ({ messageId: "m1", chatId: "chat" })),
  };
  if (!o.noDirect) {
    a.sendDirect = vi.fn(async () => {
      n += 1;
      if (o.failDirectAt?.includes(n)) throw new Error("Cannot send messages to this user");
      return { messageId: "d1", chatId: "u1" };
    });
  }
  return a as unknown as LoginChat["adapter"] & { sendText: ReturnType<typeof vi.fn>; sendDirect?: ReturnType<typeof vi.fn> };
}

function make(over: { config?: Record<string, unknown>; tunnel?: ReturnType<typeof fakeTunnel>; noTunnelDep?: boolean; checkAuth?: LoginControllerDeps["checkAuth"] } = {}) {
  const sessions: FakeSession[] = [];
  const https: FakeHttp[] = [];
  const buttons: Array<Parameters<LoginControllerDeps["postButtons"]>[0]> = [];
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const lock = new LoginWindowLock();
  const tunnel = over.tunnel ?? fakeTunnel();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: LoginControllerDeps = {
    logger,
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "fleet.example", ...(over.config ?? {}) }) as never,
    isFleetAdmin: () => true,
    eventLog: () => ({ insert: (_i: string, type: string, payload?: Record<string, unknown>) => { events.push([type, payload]); } }),
    recoverBackendInstances: vi.fn(async () => ({ woken: [], restarted: [], pending: [] as string[] })),
    postButtons: async o => { buttons.push(o); },
    claimWindow: backend => lock.tryClaim("web", backend),
    releaseWindow: c => { lock.release(c); },
    isClaimCurrent: c => lock.isCurrent(c),
    windowBusyMessage: () => lock.busyMessage(),
    checkAuth: over.checkAuth ?? (async () => "invalid"),
    createSession: (spec, ev) => { const s = new FakeSession(spec, ev); sessions.push(s); return s as never; },
    createHttp: (s, _l, o) => { const h = new FakeHttp(s as unknown as FakeSession, o); https.push(h); return h as never; },
    ...(over.noTunnelDep ? {} : { createTunnel: () => tunnel.port }),
  };
  return { controller: new LoginController(deps), sessions, https, buttons, events, lock, logger, tunnel };
}

const chat = (adapter: LoginChat["adapter"]): LoginChat => ({ adapter, adapterId: adapter.type, chatId: "chat", threadId: "topic", userId: "admin-1" });
const all = (m: { mock: { calls: unknown[][] } }) => m.mock.calls.map(c => JSON.stringify(c)).join("\n");

beforeEach(() => { setLocale("en"); FakeSession.cancelThrows = false; });
afterEach(() => { setLocale("en"); FakeSession.cancelThrows = false; });

describe("a public link is offered only when the config AND the flow allow it", () => {
  it("is not offered by default: the confirmation is exactly what it was", async () => {
    const { controller, buttons } = make();
    expect(await controller.start("kiro-cli", chat(adapterOf("discord")))).toBeNull();
    expect(buttons[0]!.choices.map(c => c.action)).toEqual(["go", "cancel"]);
    expect(buttons[0]!.message).not.toContain(t("login.tunnel_confirm_extra"));
  });

  it("is not offered when allow_public is false, or when the web terminal is disabled", async () => {
    for (const config of [{ web_terminal: { tunnel: { allow_public: false } } }, { web_terminal: { enabled: false, tunnel: { allow_public: true } } }]) {
      const { controller, buttons } = make({ config });
      await controller.start("kiro-cli", chat(adapterOf("discord")));
      expect(buttons.flatMap(b => b.choices.map(c => c.action)), JSON.stringify(config)).not.toContain("go-tunnel");
    }
  });

  it("is offered for kiro-cli as its own button, beside 'local link only' and cancel", async () => {
    const { controller, buttons } = make({ config: ON });
    expect(await controller.start("kiro-cli", chat(adapterOf("telegram")))).toBeNull();
    expect(buttons[0]!.choices).toEqual([
      { action: "go-tunnel", label: t("login.tunnel_go") },
      { action: "go", label: t("login.tunnel_go_local") },
      { action: "cancel", label: t("login.relogin_cancel") },
    ]);
    expect(buttons[0]!.message).toContain(t("login.tunnel_confirm_extra"));
  });

  it("carries the re-login variant of both actions when a token is already held", async () => {
    const { controller, buttons } = make({ config: ON, checkAuth: async () => "valid" });
    await controller.start("kiro-cli", chat(adapterOf("discord")));
    expect(buttons[0]!.choices.map(c => c.action)).toEqual(["go-relogin-tunnel", "go-relogin", "cancel"]);
  });

  it("is offered for claude-code too: its sign-in pastes a code back into the terminal (#1137)", async () => {
    const { controller, buttons } = make({ config: ON });
    await controller.start("claude-code", chat(adapterOf("discord")));
    expect(buttons[0]!.choices.map(c => c.action)).toContain("go-tunnel");
  });

  it("is never offered for a device-auth flow (no terminal to reach)", async () => {
    for (const backend of ["codex", "grok"]) {
      const { controller, buttons } = make({ config: ON });
      await controller.start(backend, chat(adapterOf("discord")));
      expect(buttons[0]!.choices.map(c => c.action), backend).not.toContain("go-tunnel");
    }
  });

  it("is not offered when the controller was given no way to run a tunnel", async () => {
    const { controller, buttons } = make({ config: ON, noTunnelDep: true });
    await controller.start("kiro-cli", chat(adapterOf("discord")));
    expect(buttons[0]!.choices.map(c => c.action)).toEqual(["go", "cancel"]);
  });

  it.each(["en", "zh-TW"] as const)("%s: the consent text says where the link goes", async locale => {
    setLocale(locale);
    const { controller, buttons } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("discord")));
    expect(buttons[0]!.message).toBe(t("login.web_confirm", "kiro-cli") + t("login.tunnel_confirm_extra"));
    expect(buttons[0]!.choices[0]!.label).toBe(t("login.tunnel_go"));
  });
});

describe("pressing the button is re-checked: a stale or forged consent gets a refusal, not a tunnel", () => {
  it.each([
    ["allow_public false", {}, "kiro-cli"],
    ["device-auth flow (no tunnelOk)", ON, "grok"],
  ])("%s", async (_name, config, backend) => {
    const { controller, sessions, tunnel, lock } = make({ config });
    expect(await controller.start(backend, chat(adapterOf("discord")), CONFIRMED_TUNNEL)).toBe(t("login.tunnel_not_allowed", backend));
    expect(sessions).toHaveLength(0);
    expect(tunnel.calls.ctx).toHaveLength(0);
    expect(lock.isHeld).toBe(false);
  });

  it("the ordinary 'local' button never starts a tunnel", async () => {
    const { controller, tunnel, https } = make({ config: ON });
    const adapter = adapterOf("discord");
    await controller.start("kiro-cli", chat(adapter), CONFIRMED);
    expect(tunnel.calls.ctx).toHaveLength(0);
    expect(https[0]!.externalHistory).toEqual([]);
    expect(all(adapter.sendText)).toContain("http://fleet.example:40001/t/");   // the old local link, in the channel
    await controller.cancel();
  });
});

describe("a public-link login", () => {
  it("puts the tunnel in front of this session's listener only, and tells the listener the host before it is probed", async () => {
    const { controller, tunnel, https } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    const ctx = tunnel.calls.ctx[0]!;
    expect(ctx.origin.href).toBe("http://127.0.0.1:40001/");
    expect(ctx.pagePath).toBe(`/t/${"ab".repeat(16)}/`);
    expect(ctx.readinessMarker).toBe(https[0]!.readinessMarker);
    expect(ctx.signal.aborted).toBe(false);
    expect(ctx.expiresAt).toBeGreaterThan(Date.now());
    expect(https[0]!.externalHistory[0]).toBe(TUNNEL_HOST);          // announced by onCandidateHost, before readiness
    expect(https[0]!.externalHost).toBe(TUNNEL_HOST);                // and kept once the tunnel is up
    await controller.cancel();
  });

  it.each(["discord", "telegram"] as const)("%s: URL then token, each as a private message — the channel gets one line and never the link", async type => {
    const { controller } = make({ config: ON });
    const adapter = adapterOf(type);
    const reply = await controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);

    expect(reply).toBe(t("login.tunnel_started", "kiro-cli", "10"));
    const direct = adapter.sendDirect!.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>;
    expect(direct).toHaveLength(2);
    expect(direct[0]![0]).toBe("admin-1");
    expect(direct[0]![1]).toBe(t("login.tunnel_link", "kiro-cli", "10", "kiro-cli login", TUNNEL_PAGE));
    expect(direct[0]![1]).not.toContain(TOKEN);
    expect(direct[1]![0]).toBe("admin-1");
    expect(direct[1]![1]).toContain(TOKEN);
    expect(direct[1]![1]).not.toContain(TUNNEL_HOST);
    if (type === "telegram") expect(direct[1]![1]).toContain(`<tg-spoiler>${TOKEN}</tg-spoiler>`);
    else expect(direct[1]![1]).toContain(`\`${TOKEN}\``);

    // Nothing in the channel but the status line (which the caller posts from the return value).
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(reply).not.toContain(TUNNEL_HOST);
    expect(reply).not.toContain(TOKEN);
    await controller.cancel();
  });

  it("never logs or audits the public name, the link or the token", async () => {
    const { controller, events, logger } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("telegram")), CONFIRMED_TUNNEL);
    await controller.cancel();
    const trail = JSON.stringify([events, logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls, logger.debug.mock.calls]);
    expect(trail).not.toContain(TUNNEL_HOST);
    expect(trail).not.toContain("trycloudflare");
    expect(trail).not.toContain(TOKEN);
    expect(events.map(e => e[0])).toEqual(expect.arrayContaining([
      "login_web_tunnel_requested", "login_web_tunnel_link_sent", "login_web_token_sent", "login_web_tunnel_delivered", "login_web_tunnel_closed",
    ]));
  });

  it("keeps the rate limit, the window and admin-only exactly as the local path does", async () => {
    const { controller, lock } = make({ config: ON });
    const adapter = adapterOf("discord");
    await controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    expect(lock.isHeld).toBe(true);
    expect(await controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL)).toBe(t("login.busy", "kiro-cli"));
    await controller.cancel();
  });
});

describe("private delivery is all or nothing: a link nobody private received is not left open", () => {
  async function failing(adapter: ReturnType<typeof adapterOf>) {
    const made = make({ config: ON });
    const reply = await made.controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    return { ...made, reply };
  }

  it.each([
    ["the link DM fails", { failDirectAt: [1] }],
    ["the token DM fails", { failDirectAt: [2] }],
    ["the platform has no private route", { noDirect: true }],
  ])("%s: tunnel stopped, session cancelled, window freed, nothing in the channel", async (_n, o) => {
    const adapter = adapterOf("discord", o);
    const { reply, sessions, tunnel, lock, https, controller } = await failing(adapter);
    expect(reply).toBe(t("login.tunnel_dm_failed"));
    expect(sessions[0]!.cancelled).toHaveLength(1);
    expect(tunnel.calls.stops).toHaveLength(1);
    expect(https[0]!.externalHost).toBeNull();
    expect(lock.isHeld).toBe(false);
    expect(controller.isActive()).toBe(false);
    expect(all(adapter.sendText)).not.toContain(TUNNEL_HOST);
    expect(all(adapter.sendText)).not.toContain(TOKEN);
    expect(reply).not.toContain(TUNNEL_HOST);
  });

  it("does not leak the link or token through a send error's message", async () => {
    const { logger } = await failing(adapterOf("discord", { failDirectAt: [1] }));
    expect(JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls])).not.toContain("Cannot send messages");
  });
});

describe("a tunnel that does not come up fails closed", () => {
  it("a start failure aborts the login, names the reason, exposes nothing and frees the window", async () => {
    const tunnel = fakeTunnel({ start: async () => ({ ok: false, errorKind: "readiness-failed", message: "the public URL never served this page (status 502)", leaseHeld: false }) });
    const adapter = adapterOf("discord");
    const { controller, sessions, https, lock } = make({ config: ON, tunnel });
    const reply = await controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    expect(reply).toBe(t("login.tunnel_failed", t("login.tunnel_reason.readiness-failed")));
    expect(reply).not.toContain("502");
    expect(sessions[0]!.cancelled).toHaveLength(1);
    expect(https[0]!.externalHost).toBeNull();                    // the candidate host was taken back
    expect(adapter.sendDirect).not.toHaveBeenCalled();
    expect(lock.isHeld).toBe(false);
  });

  it("a start that left a process nobody can account for says so instead of offering a fallback", async () => {
    const tunnel = fakeTunnel({ start: async () => ({ ok: false, errorKind: "timeout", message: "A tunnel process could not be confirmed stopped (pid 77).", leaseHeld: true }) });
    const { controller, lock } = make({ config: ON, tunnel });
    const reply = await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    expect(reply).toBe(t("login.tunnel_unconfirmed", "", t("login.tunnel_reason.lease-held")));
    expect(lock.isHeld).toBe(false);
  });
});

describe("every way a login ends closes the tunnel first", () => {
  it("success: the tunnel is stopped while the window is still held, and the user is told afterwards", async () => {
    const lockStateAtStop: boolean[] = [];
    const made: ReturnType<typeof make> = make({
      config: ON,
      tunnel: fakeTunnel({ stop: async () => { lockStateAtStop.push(made.lock.isHeld); return { confirmed: true }; } }),
    });
    const adapter = adapterOf("discord");
    await made.controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    await made.sessions[0]!.finish({ ok: true, reason: "exit", exitCode: 0, detail: "clean exit" });
    expect(lockStateAtStop).toEqual([true]);
    expect(made.lock.isHeld).toBe(false);
    expect(made.https[0]!.externalHost).toBeNull();
    expect(all(adapter.sendText)).toContain(t("login.completed", "kiro-cli"));
  });

  it("/login cancel", async () => {
    const { controller, tunnel, https } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    await controller.cancel();
    expect(tunnel.calls.stops).toEqual(["login ended"]);
    expect(https[0]!.externalHost).toBeNull();
  });

  it("the session timing out", async () => {
    const { controller, sessions, tunnel, lock } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    await sessions[0]!.finish({ ok: false, reason: "ttl", detail: "time limit" });
    expect(tunnel.calls.stops).toHaveLength(1);
    expect(lock.isHeld).toBe(false);
    expect(controller.isActive()).toBe(false);
  });

  it("fleet shutdown", async () => {
    const { controller, tunnel, https, lock } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    await controller.shutdown();
    expect(tunnel.calls.stops).toHaveLength(1);
    expect(https[0]!.externalHost).toBeNull();
    expect(lock.isHeld).toBe(false);
  });

  it("is stopped once, however many paths reach it", async () => {
    const { controller, sessions, tunnel } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    await Promise.all([controller.shutdown(), sessions[0]!.finish({ ok: false, reason: "exit", detail: "x" })]);
    expect(tunnel.calls.stops).toHaveLength(1);
  });

  it("a local-only login never touches the tunnel on the way out", async () => {
    const { controller, tunnel } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED);
    await controller.cancel();
    expect(tunnel.calls.stops).toHaveLength(0);
  });
});

describe("a tunnel that dies takes the login with it", () => {
  it("cancels the session with a reason the user can read, and stops the tunnel", async () => {
    const { controller, sessions, tunnel, lock } = make({ config: ON });
    const adapter = adapterOf("discord");
    await controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    tunnel.die();
    await vi.waitFor(() => expect(sessions[0]!.cancelled).toEqual([t("login.tunnel_lost")]));
    await vi.waitFor(() => expect(lock.isHeld).toBe(false));
    expect(tunnel.calls.stops).toHaveLength(1);
    expect(all(adapter.sendText)).toContain(t("login.failed", "kiro-cli", t("login.tunnel_lost")));
  });
});

describe("a stop that cannot be proven is announced, not swallowed", () => {
  it("tells the channel which process is left, audits it, and still frees the window", async () => {
    const tunnel = fakeTunnel({ stop: async () => ({ confirmed: false, reason: "the process did not exit after SIGTERM and SIGKILL", pid: 4242, identity: "id" }) });
    const { controller, events, logger, lock } = make({ config: ON, tunnel });
    const adapter = adapterOf("discord");
    await controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    await controller.cancel();
    expect(all(adapter.sendText)).toContain(t("login.tunnel_unconfirmed", " (pid 4242)", t("login.tunnel_reason.stop-unconfirmed")).replace(/\n/g, "\\n"));
    expect(events.map(e => e[0])).toContain("login_web_tunnel_unconfirmed");
    expect(logger.error).toHaveBeenCalled();
    expect(lock.isHeld).toBe(false);
  });

  it("a stop that throws is treated as unconfirmed", async () => {
    const tunnel = fakeTunnel({ stop: async () => { throw new Error("boom"); } });
    const { controller, events } = make({ config: ON, tunnel });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    await controller.cancel();
    expect(events.map(e => e[0])).toContain("login_web_tunnel_unconfirmed");
  });
});

describe("a shutdown while the tunnel is still starting", () => {
  it("cancels the start, stops what it produced, and publishes nothing", async () => {
    let finishStart!: (r: ManagedStartResult) => void;
    const startedSignal: AbortSignal[] = [];
    const tunnel = fakeTunnel({ start: () => new Promise<ManagedStartResult>(r => { finishStart = r; }) });
    const origStart = tunnel.port.start;
    tunnel.port.start = async ctx => { startedSignal.push(ctx.signal); return origStart(ctx); };
    const adapter = adapterOf("discord");
    const { controller, https, lock } = make({ config: ON, tunnel });
    const starting = controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    await vi.waitFor(() => expect(startedSignal).toHaveLength(1));

    const down = controller.shutdown();
    await vi.waitFor(() => expect(startedSignal[0]!.aborted).toBe(true));   // the in-flight start was told to stop
    finishStart({ ok: true, handle: okHandle() });
    await down;
    await starting;

    expect(tunnel.calls.stops).toHaveLength(1);
    expect(https[0]!.externalHost).toBeNull();
    expect(adapter.sendDirect).not.toHaveBeenCalled();
    expect(lock.isHeld).toBe(false);
  });
});

describe("the controller closes the tunnel itself — it does not rely on the session reporting done", () => {
  it("fleet shutdown with a session that cannot be cancelled", async () => {
    const { controller, tunnel, https } = make({ config: ON });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    FakeSession.cancelThrows = true;
    await controller.shutdown();
    expect(tunnel.calls.stops).toHaveLength(1);
    expect(https[0]!.externalHost).toBeNull();
  });

  it("an aborted start with a session that cannot be cancelled", async () => {
    const { controller, tunnel, https } = make({ config: ON });
    FakeSession.cancelThrows = true;
    const reply = await controller.start("kiro-cli", chat(adapterOf("discord", { failDirectAt: [1] })), CONFIRMED_TUNNEL);
    expect(reply).toBe(t("login.tunnel_dm_failed"));
    expect(tunnel.calls.stops).toHaveLength(1);
    expect(https[0]!.externalHost).toBeNull();
  });
});

describe("the listener learns the tunnel's host at the right moments", () => {
  it("while the tunnel is still starting — that is when the readiness probe arrives under it", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const tunnel = fakeTunnel({ start: async () => { await gate; return { ok: true, handle: okHandle() }; } });
    const { controller, https } = make({ config: ON, tunnel });
    const starting = controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    await vi.waitFor(() => expect(https[0]?.externalHost).toBe(TUNNEL_HOST));
    release();
    await starting;
    await controller.cancel();
  });

  it("once the tunnel is up, even if the provider never announced it", async () => {
    const { controller, https } = make({ config: ON, tunnel: fakeTunnel({ announce: false }) });
    await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    expect(https[0]!.externalHost).toBe(TUNNEL_HOST);
    await controller.cancel();
  });

  it("a close never runs stop() while the start is still in flight (it would find nothing active)", async () => {
    let finishStart!: (r: ManagedStartResult) => void;
    const tunnel = fakeTunnel({ start: () => new Promise<ManagedStartResult>(r => { finishStart = r; }) });
    const { controller } = make({ config: ON, tunnel });
    const starting = controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    await vi.waitFor(() => expect(tunnel.calls.ctx).toHaveLength(1));
    const down = controller.shutdown();
    await vi.waitFor(() => expect(tunnel.calls.ctx[0]!.signal.aborted).toBe(true));
    expect(tunnel.calls.stops).toHaveLength(0);          // waiting for the start to settle
    finishStart({ ok: true, handle: okHandle() });
    await down;
    await starting;
    expect(tunnel.calls.stoppedBeforeStartSettled).toEqual([false]);
  });
});

describe("the provider's own words never reach the channel", () => {
  // What Node's TLS layer really says on a name mismatch: it names the host.
  const TLS_MESSAGE = `Hostname/IP does not match certificate's altnames: Host: ${TUNNEL_HOST}. is not in the cert's altnames: DNS:other.example`;
  const KINDS = ["binary-missing", "binary-not-executable", "not-logged-in", "spawn-failed", "no-url", "bad-url", "readiness-failed", "timeout", "cancelled"] as const;

  it.each(KINDS)("a failed start of kind %s becomes that kind's fixed sentence, not the message", async kind => {
    const tunnel = fakeTunnel({ start: async () => ({ ok: false, errorKind: kind, message: TLS_MESSAGE, leaseHeld: false }) });
    const { controller } = make({ config: ON, tunnel });
    const reply = await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    expect(reply).toBe(t("login.tunnel_failed", t(`login.tunnel_reason.${kind}`)));
    expect(reply).not.toContain(TUNNEL_HOST);
    expect(reply).not.toContain("altnames");
  });

  it("an unrecognised kind falls back to a generic sentence", async () => {
    const tunnel = fakeTunnel({ start: async () => ({ ok: false, errorKind: `x ${TUNNEL_HOST}`, message: TLS_MESSAGE, leaseHeld: false }) });
    const { controller, events } = make({ config: ON, tunnel });
    const reply = await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    expect(reply).toBe(t("login.tunnel_failed", t("login.tunnel_reason.other")));
    expect(JSON.stringify(events)).not.toContain(TUNNEL_HOST);          // the kind is normalised before it is audited too
  });

  it("a start that throws — with the host in its message — says nothing of it", async () => {
    const tunnel = fakeTunnel({ start: async () => { throw Object.assign(new Error(TLS_MESSAGE), { errorKind: "readiness-failed" }); } });
    const { controller } = make({ config: ON, tunnel });
    const reply = await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    expect(reply).toBe(t("login.tunnel_failed", t("login.tunnel_reason.readiness-failed")));
    expect(reply).not.toContain(TUNNEL_HOST);
    const plain = fakeTunnel({ start: async () => { throw new Error(TLS_MESSAGE); } });
    const second = make({ config: ON, tunnel: plain });
    expect(await second.controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL))
      .toBe(t("login.tunnel_failed", t("login.tunnel_reason.other")));
  });

  it("an unaccounted-for tunnel is announced without the provider's text", async () => {
    const tunnel = fakeTunnel({ start: async () => ({ ok: false, errorKind: "timeout", message: `${TLS_MESSAGE} (pid 77)`, leaseHeld: true }) });
    const { controller } = make({ config: ON, tunnel });
    const reply = await controller.start("kiro-cli", chat(adapterOf("discord")), CONFIRMED_TUNNEL);
    expect(reply).not.toContain(TUNNEL_HOST);
    expect(reply).toContain(t("login.tunnel_reason.lease-held"));
  });

  it("an unconfirmed stop announces the pid but not the provider's reason", async () => {
    const tunnel = fakeTunnel({ stop: async () => ({ confirmed: false, reason: `still running ${TUNNEL_HOST}`, pid: 4242, identity: "id" }) });
    const { controller } = make({ config: ON, tunnel });
    const adapter = adapterOf("discord");
    await controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    await controller.cancel();
    const said = all(adapter.sendText);
    expect(said).toContain("4242");
    expect(said).not.toContain(TUNNEL_HOST);
  });

  it("every user-facing kind has a sentence in both languages", () => {
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      for (const kind of [...KINDS, "lease-held", "stop-unconfirmed", "other"]) {
        const key = `login.tunnel_reason.${kind}`;
        expect(t(key), `${locale} ${key}`).not.toBe(key);
      }
    }
  });
});

describe("the provider's own sign-in URL and code stay out of a public-link login's channel", () => {
  const DEVICE_URL = "https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH";

  it.each(["discord", "telegram"] as const)("%s: a hint from the CLI is not relayed anywhere", async type => {
    const { controller, sessions, events } = make({ config: ON });
    const adapter = adapterOf(type);
    await controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);
    const dmsBefore = adapter.sendDirect!.mock.calls.length;
    await sessions[0]!.events.onHint!(DEVICE_URL, "ABCD-EFGH");
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(adapter.sendDirect!.mock.calls.length).toBe(dmsBefore);
    expect(JSON.stringify([adapter.sendText.mock.calls, adapter.sendDirect!.mock.calls.slice(dmsBefore)])).not.toMatch(/ABCD-EFGH|awsapps/);
    expect(events.map(e => e[0])).toContain("login_web_hint_not_relayed");
    expect(JSON.stringify(events)).not.toContain("ABCD-EFGH");
    await controller.cancel();
  });

  it("a local-only login still relays it, exactly as before (Telegram keeps its spoiler)", async () => {
    const { controller, sessions } = make({ config: ON });
    const adapter = adapterOf("telegram");
    await controller.start("kiro-cli", chat(adapter), CONFIRMED);
    await sessions[0]!.events.onHint!(DEVICE_URL, "ABCD-EFGH");
    const said = all(adapter.sendText);
    expect(said).toContain("awsapps.com");
    expect(said).toContain("ABCD-EFGH");
    expect(said).toContain("<tg-spoiler>");
    await controller.cancel();
  });
});

describe("the real ManagedTunnel behind the controller: a lease that cannot be written, a child that cannot be proven dead", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** ENOSPC-ish: a directory where the lease file goes makes every write after the first fail. */
  function breakLease(dir: string): void { rmSync(leasePath(dir), { recursive: true, force: true }); mkdirSync(leasePath(dir)); }

  function withManaged(provider: TunnelProvider) {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-login-tunnel-"));
    dirs.push(dataDir);
    const managed = new ManagedTunnel({ dataDir, probe: () => ({ kind: "gone" }) });
    const port: LoginTunnelPort = { start: ctx => managed.start(provider, ctx), stop: reason => managed.stop(reason) };
    return { managed, dataDir, tunnel: { port, calls: { ctx: [] as TunnelStartContext[], stops: [] as string[], stoppedBeforeStartSettled: [] as boolean[] }, die: () => {} } };
  }
  const stuckHandle = (dataDir: string): TunnelHandle => ({
    ...okHandle(),
    pid: 4242, identity: "linux:777",
    stop: async () => ({ confirmed: false, reason: "did not exit", pid: 4242, identity: "linux:777" }),
  });
  const provider = (start: (ctx: TunnelStartContext) => Promise<TunnelHandle>): TunnelProvider => ({
    name: "fake", preflight: async () => ({ ok: true as const, binaryPath: "/bin/true" }), start,
  });

  async function expectUnconfirmedAnnouncedNotClosed(made: ReturnType<typeof withManaged>) {
    const adapter = adapterOf("discord");
    const ctl = make({ config: ON, tunnel: made.tunnel as never });
    await ctl.controller.start("kiro-cli", chat(adapter), CONFIRMED_TUNNEL);

    const events = ctl.events.map(e => e[0]);
    expect(events).toContain("login_web_tunnel_unconfirmed");
    expect(events).not.toContain("login_web_tunnel_closed");              // never "closed" for a child that may still run
    expect(all(adapter.sendText)).toContain("4242");                       // the warning names the pid …
    expect(all(adapter.sendText)).not.toContain(TUNNEL_HOST);              // … and still none of the provider's words
    expect(ctl.lock.isHeld).toBe(false);
    // The manager still answers honestly, and further tunnels stay blocked.
    expect(await made.managed.stop("again")).toMatchObject({ confirmed: false, pid: 4242, identity: "linux:777" });
    const next = await made.managed.start(provider(async () => okHandle()), {
      sid: "x", origin: new URL("http://127.0.0.1:1"), pagePath: "/", readinessMarker: "m", expiresAt: Date.now() + 60_000, signal: new AbortController().signal,
    });
    expect(next).toMatchObject({ ok: false, errorKind: "lease-held", leaseHeld: true });
  }

  it("(a) the provider hands over a handle, the second lease write fails, and that tunnel cannot be stopped", async () => {
    let dir = "";
    const made = withManaged(provider(async () => { breakLease(dir); return stuckHandle(dir); }));
    dir = made.dataDir;
    await expectUnconfirmedAnnouncedNotClosed(made);
  });

  it("(b) the start fails leaving a child it cannot prove dead, and the lease write fails too", async () => {
    let dir = "";
    const made = withManaged(provider(async () => {
      breakLease(dir);
      throw new TunnelStartError("readiness-failed", `never ready at ${TUNNEL_HOST}`, { pid: 4242, identity: "linux:777" });
    }));
    dir = made.dataDir;
    await expectUnconfirmedAnnouncedNotClosed(made);
  });
});
