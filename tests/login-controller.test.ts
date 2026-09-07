import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { LoginController, LOGIN_TOKEN_RESEND_PREFIX, START_RATE_LIMIT, type LoginControllerDeps, type LoginChat } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { LOGIN_FLOWS } from "../src/login-flows.js";
import { setLocale, t } from "../src/locale.js";
import type { WebTerminalEvents, WebTerminalResult, WebTerminalSpec } from "../src/web-terminal.js";

/**
 * Web-mode /login authorization surface (PR-B):
 *   admin re-checked inside start · one window fleet-wide, claimed before the
 *   first await · every start confirmed once (risk / kiro logout) · link to the
 *   chat without any secret · token ONLY via the private route · DM failure
 *   never falls back to the channel · undeliverable link/token cancels the
 *   session · resend only by the requester · secret-bearing send errors logged
 *   without their message · audit without secrets · rate limit · noShellEscape
 *   allowlist · shutdown cancels and waits.
 */
class FakeSession extends EventEmitter {
  state: "created" | "running" | "finished" = "created";
  token: string | null = "ABCDEFGHJKMNPQRSTVWX";
  cancelled: string[] = [];
  constructor(readonly spec: WebTerminalSpec, readonly events: WebTerminalEvents) { super(); }
  async start(): Promise<void> { this.state = "running"; }
  peekAccessToken(): string | null { return this.token; }
  async cancel(detail = "cancelled"): Promise<void> {
    this.cancelled.push(detail);
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
  static failListen = false;
  closed = false;
  constructor(readonly session: FakeSession, readonly opts: { hostname?: string; bind?: string }) {}
  async listen(): Promise<{ port: number; url: string }> {
    if (FakeHttp.failListen) throw new Error("EADDRINUSE");
    return { port: 40001, url: `http://${this.opts.hostname ?? "localhost"}:40001/t/${"ab".repeat(16)}` };
  }
  async close(): Promise<void> { this.closed = true; }
}

const TOKEN = "ABCDEFGHJKMNPQRSTVWX";
const CONFIRMED = { skipAuthCheck: true } as const;

function adapterOf(type: "discord" | "telegram", opts: { noDirect?: boolean; directFails?: boolean | ((text: string) => Error); textFails?: boolean } = {}) {
  const a: Record<string, unknown> = {
    id: type, type,
    sendText: vi.fn(async () => { if (opts.textFails) throw new Error("channel gone"); return { messageId: "m1", chatId: "chat" }; }),
  };
  if (!opts.noDirect) {
    a.sendDirect = vi.fn(async (_u: string, text: string) => {
      if (typeof opts.directFails === "function") throw opts.directFails(text);
      if (opts.directFails) throw new Error("Cannot send messages to this user");
      return { messageId: "d1", chatId: "u1" };
    });
  }
  return a as unknown as LoginChat["adapter"] & { sendText: ReturnType<typeof vi.fn>; sendDirect?: ReturnType<typeof vi.fn> };
}

function make(over: Partial<LoginControllerDeps> & { config?: Record<string, unknown>; admin?: boolean; lock?: LoginWindowLock } = {}) {
  const sessions: FakeSession[] = [];
  const buttons: Array<Parameters<LoginControllerDeps["postButtons"]>[0]> = [];
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const recover = vi.fn(async () => ({ woken: ["kiro-a"], restarted: ["kiro-b"] }));
  const lock = over.lock ?? new LoginWindowLock();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const { config: _c, admin: _a, lock: _l, ...rest } = over;
  const deps: LoginControllerDeps = {
    logger,
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "fleet.example", ...(over.config ?? {}) }) as never,
    isFleetAdmin: () => over.admin !== false,
    eventLog: () => ({ insert: (_i: string, type: string, payload?: Record<string, unknown>) => { events.push([type, payload]); } }),
    recoverBackendInstances: recover,
    postButtons: async o => { buttons.push(o); },
    claimWindow: backend => lock.tryClaim("web", backend),
    releaseWindow: c => { lock.release(c); },
    windowBusyMessage: () => lock.busyMessage(),
    checkAuth: async () => "invalid",
    createSession: (spec, ev) => { const s = new FakeSession(spec, ev); sessions.push(s); return s as never; },
    createHttp: (s, _l, o) => new FakeHttp(s as unknown as FakeSession, o) as never,
    ...rest,
  };
  return { controller: new LoginController(deps), sessions, buttons, events, recover, deps, lock, logger };
}

const NO_USER = Symbol("no-user");
const chat = (adapter: LoginChat["adapter"], userId: string | typeof NO_USER = "admin-1"): LoginChat =>
  ({ adapter, adapterId: adapter.type, chatId: "chat", threadId: "topic", userId: userId === NO_USER ? undefined : userId });

const allText = (m: { mock: { calls: unknown[][] } }) => m.mock.calls.map(c => JSON.stringify(c)).join("\n");

beforeEach(() => { FakeHttp.failListen = false; });
afterEach(() => setLocale("en"));

describe("authorization gate", () => {
  it("re-checks admin inside start(): a non-admin (or missing user id) is denied and audited, no session is created", async () => {
    const { controller, sessions, events } = make({ admin: false });
    expect(await controller.start("codex", chat(adapterOf("discord")), CONFIRMED)).toBe(t("permission.denied"));
    const { controller: c2, sessions: s2 } = make();
    expect(await c2.start("codex", chat(adapterOf("discord"), NO_USER), CONFIRMED)).toBe(t("permission.denied"));
    expect(sessions).toHaveLength(0);
    expect(s2).toHaveLength(0);
    expect(events.some(e => e[0] === "login_web_denied")).toBe(true);
  });

  it("web_terminal.enabled: false refuses with guidance; unknown backend is unsupported", async () => {
    const { controller, sessions } = make({ config: { web_terminal: { enabled: false } } });
    expect(await controller.start("codex", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.web_disabled"));
    expect(await controller.start("nonesuch", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.unsupported", "nonesuch"));
    expect(sessions).toHaveLength(0);
  });

  it("noShellEscape allowlist: a flow without the reviewed flag never gets a terminal", async () => {
    (LOGIN_FLOWS as Record<string, unknown>)["testonly"] = { backend: "testonly", command: "true", successPattern: /x/, timeoutMs: 1000 };
    try {
      const { controller, sessions, events } = make();
      expect(await controller.start("testonly", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.web_flow_not_allowed", "testonly"));
      expect(sessions).toHaveLength(0);
      expect(events.some(e => e[0] === "login_web_flow_not_allowed")).toBe(true);
    } finally {
      delete (LOGIN_FLOWS as Record<string, unknown>)["testonly"];
    }
    for (const b of ["codex", "grok", "kiro-cli", "claude-code", "antigravity"]) expect(LOGIN_FLOWS[b].noShellEscape).toBe(true);
  });

  it("rate limit: a requester gets at most 3 starts per 5 minutes; the window slides", async () => {
    let now = 1_000_000;
    const { controller, sessions } = make({ now: () => now });
    for (let i = 0; i < START_RATE_LIMIT; i++) {
      expect(await controller.start("codex", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.web_started", "codex"));
      await sessions[i].finish({ ok: false, reason: "cancel", detail: "cancelled" });
    }
    expect(await controller.start("codex", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.web_rate_limited", "3", "5"));
    expect(sessions).toHaveLength(START_RATE_LIMIT);
    now += 5 * 60_000 + 1;
    expect(await controller.start("codex", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.web_started", "codex"));
  });

  it("one window fleet-wide: an active web login, or a held relay/install claim, blocks a second start", async () => {
    const { controller, sessions, lock } = make();
    expect(await controller.start("codex", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.web_started", "codex"));
    expect(controller.isActive()).toBe(true);
    expect(await controller.start("grok", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.busy", "codex"));
    expect(sessions).toHaveLength(1);
    const lock2 = new LoginWindowLock();
    lock2.tryClaim("install", "grok");
    const { controller: c2, sessions: s2 } = make({ lock: lock2 });
    expect(await c2.start("codex", chat(adapterOf("discord")), CONFIRMED)).toBe(t("install.busy"));
    expect(s2).toHaveLength(0);
    expect(lock.isHeld).toBe(true);
  });

  it("B1: two concurrent starts whose pre-checks resolve together — exactly one session; the other sees busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    // The confirmed path has no awaits before claiming; exercise the unconfirmed path (pre-check await) racing a confirmed one.
    const { controller, sessions, buttons, lock } = make({ checkAuth: async () => { await gate; return "invalid"; } });
    const a = controller.start("codex", chat(adapterOf("discord")));            // parks in pre-check, window claimed
    const b = controller.start("grok", chat(adapterOf("discord")), CONFIRMED);   // must NOT get the window meanwhile
    expect(await b).toBe(t("login.busy", "codex"));
    release();
    expect(await a).toBeNull();                                                 // buttons posted, window released
    expect(buttons).toHaveLength(1);
    expect(sessions).toHaveLength(0);
    expect(lock.isHeld).toBe(false);
    expect(await controller.start("grok", chat(adapterOf("discord")), CONFIRMED)).toBe(t("login.web_started", "grok"));
  });
});

describe("confirmation and kiro logout-first", () => {
  it("an unconfirmed start posts the risk confirmation and starts nothing; the window is released", async () => {
    const { controller, sessions, buttons, lock } = make();
    expect(await controller.start("codex", chat(adapterOf("discord")))).toBeNull();
    expect(sessions).toHaveLength(0);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].prefix).toBe("login-confirm:");
    expect(buttons[0].message).toContain("no shell");
    expect(buttons[0].choices.map(c => c.action)).toEqual(["go", "cancel"]);
    expect(lock.isHeld).toBe(false);
  });

  it("kiro with a live token: the confirmation names the logout and the button carries go-relogin", async () => {
    const { controller, buttons } = make({ checkAuth: async () => "valid" });
    expect(await controller.start("kiro", chat(adapterOf("discord")))).toBeNull();
    expect(buttons[0].message).toContain("kiro-cli logout");
    expect(buttons[0].choices.map(c => c.action)).toEqual(["go-relogin", "cancel"]);
  });

  it("confirmed with tokenPresent prepends `kiro-cli logout;`; without it the plain command; codex never has a pre-command", async () => {
    const a = make(); await a.controller.start("kiro", chat(adapterOf("discord")), { skipAuthCheck: true, tokenPresent: true });
    expect(a.sessions[0].spec.command).toBe("kiro-cli logout; kiro-cli login --use-device-flow");
    const b = make(); await b.controller.start("kiro", chat(adapterOf("discord")), CONFIRMED);
    expect(b.sessions[0].spec.command).toBe("kiro-cli login --use-device-flow");
    const c = make(); await c.controller.start("codex", chat(adapterOf("discord")), { skipAuthCheck: true, tokenPresent: true });
    expect(c.sessions[0].spec.command).toBe("codex login --device-auth");
  });

  it("the spec carries the flow's observation patterns and failure mapping; TTL comes from config, clamped to the engine cap", async () => {
    const a = make(); await a.controller.start("kiro", chat(adapterOf("discord")), CONFIRMED);
    expect(a.sessions[0].spec.observe?.failures?.map(f => f.suggest)).toEqual(["relogin", "check-args"]);
    expect(a.sessions[0].spec.observe?.successPattern).toBeInstanceOf(RegExp);
    expect(a.sessions[0].spec.ttlMs).toBe(10 * 60_000);
    expect(a.sessions[0].spec.requester).toEqual({ adapterId: "discord", userId: "admin-1", chatId: "chat", threadId: "topic" });
    const b = make({ config: { web_terminal: { ttl_minutes: 50 } } }); await b.controller.start("codex", chat(adapterOf("discord")), CONFIRMED);
    expect(b.sessions[0].spec.ttlMs).toBe(20 * 60_000);
  });
});

describe("two messages: link to the chat, token only privately", () => {
  it("Discord: the chat gets the URL without the token; the token goes through sendDirect without the URL; both audited without secrets", async () => {
    const adapter = adapterOf("discord");
    const { controller, events } = make({ config: { hostname: "fleet.example" } });
    await controller.start("codex", chat(adapter), CONFIRMED);
    const chatMsgs = adapter.sendText.mock.calls.map(c => String(c[1]));
    expect(chatMsgs).toHaveLength(1);
    expect(chatMsgs[0]).toContain("http://fleet.example:40001/t/");
    expect(chatMsgs[0]).not.toContain(TOKEN);
    expect(adapter.sendText.mock.calls[0][2]).toMatchObject({ threadId: "topic", disablePreview: true });
    expect(adapter.sendDirect!).toHaveBeenCalledTimes(1);
    const [toUser, dmText] = adapter.sendDirect!.mock.calls[0];
    expect(toUser).toBe("admin-1");
    expect(String(dmText)).toContain(TOKEN);
    expect(String(dmText)).not.toContain("http://");
    const audit = JSON.stringify(events);
    expect(audit).toContain("login_web_link_sent");
    expect(audit).toContain("login_web_token_sent");
    expect(audit).not.toContain(TOKEN);
    expect(audit).not.toContain("40001/t/");
  });

  it("Telegram: the private token message is HTML with a spoiler; the chat link suppresses previews", async () => {
    const adapter = adapterOf("telegram");
    const { controller } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    const [, dmText, dmOpts] = adapter.sendDirect!.mock.calls[0];
    expect(String(dmText)).toContain(`<tg-spoiler>${TOKEN}</tg-spoiler>`);
    expect(dmOpts).toMatchObject({ format: "html" });
    expect(adapter.sendText.mock.calls[0][2]).toMatchObject({ disablePreview: true });
  });

  it("DM failure: the token NEVER reaches the channel; a resend button is offered; resend works only for the requester while unredeemed", async () => {
    const adapter = adapterOf("discord", { directFails: true });
    const { controller, buttons, events, sessions } = make();
    expect(await controller.start("codex", chat(adapter), CONFIRMED)).toBe(t("login.web_started", "codex"));
    for (const call of adapter.sendText.mock.calls) expect(String(call[1])).not.toContain(TOKEN);
    expect(buttons.map(b => b.prefix)).toEqual([LOGIN_TOKEN_RESEND_PREFIX]);
    expect(buttons[0].choices[0].action).toBe("resend");
    expect(JSON.stringify(events)).toContain("login_web_token_dm_failed");

    expect(await controller.resendToken("someone-else")).toBe(t("permission.denied"));
    expect(JSON.stringify(events)).toContain("login_web_token_resend_denied");
    adapter.sendDirect!.mockImplementation(async () => ({ messageId: "d2", chatId: "u1" }));   // DMs enabled meanwhile
    expect(await controller.resendToken("admin-1")).toBe(t("login.web_token_resent"));
    expect(buttons).toHaveLength(1);                                                            // resend never re-posts a button
    sessions[0].token = null;
    expect(await controller.resendToken("admin-1")).toBe(t("login.web_token_already_used"));
    for (const call of adapter.sendText.mock.calls) expect(String(call[1])).not.toContain(TOKEN);
  });

  it("an adapter without sendDirect behaves like a DM failure (button, no token in channel)", async () => {
    const adapter = adapterOf("discord", { noDirect: true });
    const { controller, buttons } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    expect(buttons.map(b => b.prefix)).toEqual([LOGIN_TOKEN_RESEND_PREFIX]);
    for (const call of adapter.sendText.mock.calls) expect(String(call[1])).not.toContain(TOKEN);
  });

  it("B2: a provider error that echoes the payload never reaches the logger or the event log", async () => {
    const adapter = adapterOf("discord", { directFails: text => new Error(`provider rejected payload ${text}`) });
    const { controller, logger, events } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    const logged = allText(logger.warn) + allText(logger.info) + allText(logger.error) + JSON.stringify(events);
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain("web terminal token DM failed");
  });

  it("B2: a hint delivery error carrying the device code is logged without its message", async () => {
    const adapter = adapterOf("telegram");
    adapter.sendText.mockImplementationOnce(async () => ({ messageId: "link", chatId: "chat" }));
    const { controller, sessions, logger } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    adapter.sendText.mockImplementation(async (_c: string, text: string) => { throw new Error(`rejected: ${text}`); });
    await sessions[0].events.onHint!("https://auth.example/device?user_code=ZZZZ-9999", "ZZZZ-9999");
    expect(allText(logger.warn)).not.toContain("ZZZZ-9999");
    expect(allText(logger.warn)).toContain("Failed to deliver login URL");
  });

  it("M1: an undeliverable link cancels the session — no token is sent, one failure report, window released", async () => {
    const adapter = adapterOf("discord", { textFails: true });
    const { controller, sessions, lock } = make();
    const text = await controller.start("codex", chat(adapter), CONFIRMED);
    expect(text).toBe(t("login.failed", "codex", t("login.web_link_failed")));
    expect(sessions[0].cancelled).toEqual(["link delivery failed"]);
    expect(adapter.sendDirect!).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(false);
    expect(lock.isHeld).toBe(false);
    // onDone stayed silent: the only chat attempt was the (failed) link itself
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
  });

  it("M1: DM failure AND resend-button failure cancels the session with an explicit report; the token never entered the channel", async () => {
    const adapter = adapterOf("discord", { directFails: true });
    const { controller, sessions, lock } = make({ postButtons: async () => { throw new Error("buttons unavailable"); } });
    const text = await controller.start("codex", chat(adapter), CONFIRMED);
    expect(text).toBe(t("login.failed", "codex", t("login.web_token_failed")));
    expect(sessions[0].cancelled).toEqual(["token delivery failed"]);
    for (const call of adapter.sendText.mock.calls) expect(String(call[1])).not.toContain(TOKEN);
    expect(controller.isActive()).toBe(false);
    expect(lock.isHeld).toBe(false);
  });
});

describe("session outcome", () => {
  it("device URL + code observed in the pane is relayed as a spoiler-style hint to the chat", async () => {
    const adapter = adapterOf("telegram");
    const { controller, sessions } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    await sessions[0].events.onHint!("https://auth.example/device?user_code=ABCD-1234", "ABCD-1234");
    const hint = String(adapter.sendText.mock.calls.at(-1)![1]);
    expect(hint).toContain("<tg-spoiler>");
    expect(hint).toContain("ABCD-1234");
  });

  it("success → instances recovered and reported; the slot and window are released", async () => {
    const adapter = adapterOf("discord");
    const { controller, sessions, recover, lock } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    await sessions[0].finish({ ok: true, reason: "exit", exitCode: 0, detail: "clean exit" });
    expect(recover).toHaveBeenCalledWith("codex");
    expect(String(adapter.sendText.mock.calls.at(-1)![1])).toBe(t("login.success", "codex", "kiro-a", "kiro-b"));
    expect(controller.isActive()).toBe(false);
    expect(lock.isHeld).toBe(false);
    expect(await controller.start("codex", chat(adapter), CONFIRMED)).toBe(t("login.web_started", "codex"));
  });

  it("failure carries the mapped message and suggestion; cleanupFailed adds the operator warning", async () => {
    const adapter = adapterOf("discord");
    const { controller, sessions } = make();
    await controller.start("kiro", chat(adapter), CONFIRMED);
    await sessions[0].finish({ ok: false, reason: "exit", exitCode: 1, detail: "kiro-cli still holds a token — use Re-login (it logs out first)", suggest: "relogin", cleanupFailed: true });
    const text = String(adapter.sendText.mock.calls.at(-1)![1]);
    expect(text).toContain("still holds a token");
    expect(text).toContain(t("login.web_suggest_relogin"));
    expect(text).toContain("could not be confirmed dead");
  });

  it("/login cancel routes to the session and does not double-announce", async () => {
    const adapter = adapterOf("discord");
    const { controller, sessions } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    const before = adapter.sendText.mock.calls.length;
    expect(await controller.cancel()).toBe(t("login.cancelled", "codex"));
    expect(sessions[0].cancelled).toEqual(["cancelled"]);
    expect(adapter.sendText.mock.calls.length).toBe(before);
    expect(await controller.cancel()).toBe(t("login.no_session"));
  });

  it("listener failure at startup releases slot and window, cancels the session, reports ONCE, and never sent a token", async () => {
    FakeHttp.failListen = true;
    const adapter = adapterOf("discord");
    const { controller, sessions, lock } = make();
    const text = await controller.start("codex", chat(adapter), CONFIRMED);
    expect(text).toContain("EADDRINUSE");
    expect(controller.isActive()).toBe(false);
    expect(lock.isHeld).toBe(false);
    expect(sessions[0].cancelled).toEqual(["startup failed"]);
    expect(adapter.sendDirect!).not.toHaveBeenCalled();
    expect(adapter.sendText).not.toHaveBeenCalled();                    // onDone was silenced: no second report
  });

  it("B1: a late failure of an older entry never clears a newer owner (identity-guarded release)", async () => {
    const adapter = adapterOf("discord");
    const { controller, sessions, lock } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    const first = sessions[0];
    await first.finish({ ok: false, reason: "ttl", detail: "time limit reached" });
    await controller.start("grok", chat(adapter), CONFIRMED);
    expect(controller.activeBackend).toBe("grok");
    await first.events.onDone({ ok: false, reason: "error", detail: "stale duplicate callback" });   // stale event from the old session
    expect(controller.activeBackend).toBe("grok");
    expect(lock.isHeld).toBe(true);
  });

  it("B3: shutdown cancels the active session quietly, closes the listener, and releases the window", async () => {
    const adapter = adapterOf("discord");
    const { controller, sessions, lock } = make();
    await controller.start("codex", chat(adapter), CONFIRMED);
    const before = adapter.sendText.mock.calls.length;
    await controller.shutdown();
    expect(sessions[0].cancelled).toEqual(["fleet shutdown"]);
    expect(controller.isActive()).toBe(false);
    expect(lock.isHeld).toBe(false);
    expect(adapter.sendText.mock.calls.length).toBe(before);           // no chat noise during shutdown
    await controller.shutdown();                                        // idempotent
  });

  it("engine audits are forwarded to the event log under the login_web_ prefix", async () => {
    const { controller, sessions, events } = make();
    await controller.start("codex", chat(adapterOf("discord")), CONFIRMED);
    sessions[0].events.onAudit!("web_terminal_opened", { sid: "x", ip: "127.0.0.1" });
    expect(events.some(e => e[0] === "login_web_opened")).toBe(true);
  });

  it("zh-TW strings exist for every new key", async () => {
    setLocale("zh-TW");
    for (const key of ["login.web_started", "login.web_link", "login.web_token", "login.web_token_dm_failed", "login.web_resend",
      "login.web_token_resent", "login.web_token_already_used", "login.web_disabled", "login.web_cleanup_failed",
      "login.web_suggest_relogin", "login.web_suggest_check_args", "login.web_code_not_needed", "login.still_valid_precommand",
      "login.web_confirm", "login.web_confirm_go", "login.web_confirm_failed", "login.web_rate_limited", "login.web_flow_not_allowed",
      "login.web_link_failed", "login.web_token_failed"]) {
      expect(t(key as never, "a", "b", "c", "d")).not.toBe(key);
    }
  });
});
