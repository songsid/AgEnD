import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LoginController, PASTED_TOKEN_MASK, type LoginControllerDeps, type LoginChat } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { t } from "../src/locale.js";
import type { WebTerminalEvents, WebTerminalResult, WebTerminalSpec } from "../src/web-terminal.js";

/**
 * #4145: a person pasted the /login one-time access token (the bot's private message) into General, and AgEnD wrote it
 * in plain text to daemon.log, the activity log and the search index. Matched exactly against the token AgEnD itself
 * issued (no format guessing):
 *   - hidden before anything logs, indexes, keeps or delivers the message (the agent reads the mask too);
 *   - taken back at once and a new one sent the way the first went; the chat told once not to paste it there, and
 *     where it goes (the terminal page);
 *   - another copy of the same message (a sibling bot's, a retry) is still hidden, and told about only once;
 *   - the web chat's /ui/send the same.
 */
const TOKENS = ["ABCDEFGHJKMNPQRSTVWX", "QQQQQQQQQQQQQQQQQQQ2", "ZZZZZZZZZZZZZZZZZZZ3"];

class FakeSession extends EventEmitter {
  state: "created" | "running" | "finished" = "created";
  private n = 0;
  token: string | null = TOKENS[0];
  constructor(readonly spec: WebTerminalSpec, readonly events: WebTerminalEvents) { super(); }
  async start(): Promise<void> { this.state = "running"; }
  peekAccessToken(): string | null { return this.token; }
  rotateAccessToken(): boolean {
    if (this.state !== "running" || this.token === null) return false;
    this.token = TOKENS[++this.n];
    return true;
  }
  async cancel(detail = "cancelled"): Promise<void> { await this.finish({ ok: false, reason: "cancel", detail }); }
  async finish(result: WebTerminalResult): Promise<void> {
    this.state = "finished"; this.token = null; this.emit("finished", result); await this.events.onDone(result);
  }
}
class FakeHttp {
  constructor(readonly session: FakeSession, readonly opts: { hostname?: string }) {}
  async listen(): Promise<{ port: number; url: string }> { return { port: 40001, url: `http://${this.opts.hostname ?? "localhost"}:40001/t/${"ab".repeat(16)}/` }; }
  async close(): Promise<void> { /* closed */ }
}

function adapterOf(type: "discord" | "telegram", opts: { directFails?: boolean } = {}) {
  return {
    id: type, type,
    sendText: vi.fn(async () => ({ messageId: "m1", chatId: "chat" })),
    sendDirect: vi.fn(async () => { if (opts.directFails) throw new Error("Cannot send messages to this user"); return { messageId: "d1", chatId: "u1" }; }),
  } as unknown as LoginChat["adapter"] & { sendText: ReturnType<typeof vi.fn>; sendDirect: ReturnType<typeof vi.fn> };
}

function controllerFor() {
  const sessions: FakeSession[] = [];
  const audits: string[] = [];
  const lock = new LoginWindowLock();
  const deps: LoginControllerDeps = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "fleet.example" }) as never,
    isFleetAdmin: () => true,
    eventLog: () => ({ insert: (_i: string, type: string, payload?: Record<string, unknown>) => { audits.push(`${type} ${JSON.stringify(payload ?? {})}`); } }) as never,
    recoverBackendInstances: async () => ({ woken: [], restarted: [], pending: [] }),
    postButtons: async () => {},
    claimWindow: backend => lock.tryClaim("web", backend),
    releaseWindow: c => { lock.release(c); },
    isClaimCurrent: c => lock.isCurrent(c),
    windowBusyMessage: () => lock.busyMessage(),
    checkAuth: async () => "invalid",
    createSession: (spec, ev) => { const s = new FakeSession(spec, ev); sessions.push(s); return s as never; },
    createHttp: (s, _l, o) => new FakeHttp(s as unknown as FakeSession, o) as never,
  };
  return { controller: new LoginController(deps), sessions, audits };
}
const chatOf = (adapter: LoginChat["adapter"]): LoginChat => ({ adapter, adapterId: adapter.type, chatId: "chat", threadId: "topic", userId: "admin-1" });
const PASTE = `🔑 claude-code login — your one-time access token (paste it into the terminal page; do not forward):\n${TOKENS[0]}\n can you sign me in?`;

describe("LoginController: the pasted token", () => {
  it("screenToken hides exactly the live token (either case, every copy); nothing else, and nothing without a sign-in", async () => {
    const { controller } = controllerFor();
    expect(controller.screenToken(PASTE)).toBeNull();                                         // no sign-in: no token to know
    await controller.start("claude-code", chatOf(adapterOf("discord")), { skipAuthCheck: true });
    const r = controller.screenToken(`${PASTE} ${TOKENS[0].toLowerCase()}`)!;
    expect(r.live).toBe(true);
    expect(r.text).not.toMatch(new RegExp(TOKENS[0], "i"));
    expect(r.text.split(PASTED_TOKEN_MASK)).toHaveLength(3);
    expect(r.text).toContain("can you sign me in?");
    expect(controller.screenToken("ABCDEFGHJKMNPQRSTVW (19 chars) and a 20-char base32 lookalike AAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(controller.screenToken("")).toBeNull();
  });

  it("tokenPasted takes it back, DMs a new one, says where it goes; the old one stays hidden; the new one is live", async () => {
    const adapter = adapterOf("telegram");
    const { controller, sessions, audits } = controllerFor();
    await controller.start("claude-code", chatOf(adapter), { skipAuthCheck: true });
    adapter.sendDirect.mockClear();
    expect(await controller.tokenPasted()).toBe(t("login.token_pasted", "claude-code"));
    expect(sessions[0].peekAccessToken()).toBe(TOKENS[1]);
    expect(String(adapter.sendDirect.mock.calls[0][1])).toContain(TOKENS[1]);                // the new one, privately
    expect(adapter.sendText.mock.calls.map(c => String(c[1])).join("\n")).not.toContain(TOKENS[1]);
    expect(controller.screenToken(PASTE)).toEqual({ text: expect.not.stringContaining(TOKENS[0]), live: false });  // a second copy: hidden, not told again
    expect(controller.screenToken(`x ${TOKENS[1]}`)?.live).toBe(true);
    expect(audits.some(a => a.startsWith("login_web_token_pasted"))).toBe(true);
    expect(audits.join("\n")).not.toMatch(new RegExp(`${TOKENS[0]}|${TOKENS[1]}`));
  });

  it("a new token that cannot go privately ends the sign-in (never posted in the chat); nothing to take back once redeemed or ended", async () => {
    const adapter = adapterOf("discord");
    const { controller, sessions } = controllerFor();
    await controller.start("claude-code", chatOf(adapter), { skipAuthCheck: true });
    adapter.sendDirect.mockImplementation(async () => { throw new Error("Cannot send messages to this user"); });
    expect(await controller.tokenPasted()).toBe(t("login.token_pasted_closed", "claude-code"));
    expect(sessions[0].state).toBe("finished");
    expect(controller.isActive()).toBe(false);
    expect(controller.screenToken(PASTE)).toBeNull();                                         // ended: nothing is known any more
    expect(await controller.tokenPasted()).toBeNull();
    for (const c of adapter.sendText.mock.calls) expect(String(c[1])).not.toMatch(/ABCDEFGHJK|QQQQQ/);
  });
});

describe("FleetManager: a pasted token in General never reaches the logs", () => {
  let dir: string;
  beforeEach(() => { dir = join(tmpdir(), `agend-4145-${Date.now()}-${Math.random()}`); mkdirSync(dir, { recursive: true }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
  const OPEN = { mode: "open" as const, allowed_users: [] as string[], max_pending_codes: 5, code_expiry_minutes: 10 };

  async function rig() {
    const fm = new FleetManager(dir);
    const mk = (id: string) => ({ id, type: "discord", react: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: "m", chatId: "guild" }) } as any);
    const cfg = (id: string) => ({ id, type: "discord", mode: "topic", group_id: "guild", access: OPEN });
    const mainCfg = cfg("main"), sibCfg = cfg("sib");
    fm.fleetConfig = { defaults: {}, channels: [mainCfg, sibCfg],
      instances: { general: { working_directory: dir, topic_id: "topic-g", channel_id: "main", general_topic: true } } } as any;
    const main = mk("main"), sib = mk("sib");
    fm.adapter = main;
    fm.worlds.set("main", { id: "main", adapter: main, channelConfig: mainCfg, groupId: "guild", botUserId: "bot-main", accessManager: new AccessManager(OPEN, join(dir, "main.json")) } as any);
    fm.worlds.set("sib", { id: "sib", adapter: sib, channelConfig: sibCfg, groupId: "guild", botUserId: "bot-sib", accessManager: new AccessManager(OPEN, join(dir, "sib.json")) } as any);
    fm.routing.rebuild(fm.fleetConfig!);
    vi.spyOn((fm as any).topicCommands, "handleInstanceCommand").mockResolvedValue(false);
    vi.spyOn((fm as any).topicCommands, "handleGeneralCommand").mockResolvedValue(false);
    vi.spyOn(fm as any, "sendCancelButton").mockResolvedValue(undefined);
    const deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined);
    const activity = vi.fn();
    (fm as any).eventLog = { logActivity: activity, insert: vi.fn(), pendingReactions: () => null, markReactionsConsumed: vi.fn() };
    const lines: string[] = [];
    for (const level of ["info", "warn", "debug", "error"] as const) {
      vi.spyOn(fm.logger, level).mockImplementation(((...a: unknown[]) => { lines.push(JSON.stringify(a)); }) as never);
    }
    const login = controllerFor();
    (fm as any).loginController = login.controller;
    const dm = adapterOf("telegram");
    await login.controller.start("claude-code", chatOf(dm), { skipAuthCheck: true });
    return { fm, main, sib, deliver, activity, lines, login, dm };
  }
  const pasted = (adapterId: string, messageId = "paste-1") => ({ source: "discord", adapterId, chatId: "guild", threadId: "topic-g",
    messageId, userId: "user-1", username: "han", text: PASTE, timestamp: new Date() });

  it("hidden in the agent's copy, its receipt, daemon.log and the activity log; taken back; told once where it was pasted", async () => {
    const r = await rig();
    await (r.fm as any).handleInboundMessage(pasted("main"));
    await (r.fm as any).handleInboundMessage(pasted("sib"));                                 // the sibling bot's copy of the same message
    const everything = JSON.stringify([r.deliver.mock.calls, r.activity.mock.calls, r.lines]);
    expect(everything).not.toMatch(new RegExp(`${TOKENS[0]}|${TOKENS[1]}`, "i"));
    expect(r.deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r.deliver.mock.calls[0])).toContain(PASTED_TOKEN_MASK);
    expect(JSON.stringify(r.deliver.mock.calls[0])).toContain("can you sign me in?");
    expect(r.activity.mock.calls[0][2]).toContain(PASTED_TOKEN_MASK);
    expect(r.login.sessions[0].peekAccessToken()).toBe(TOKENS[1]);                          // taken back once, not twice
    const notices = [...r.main.sendText.mock.calls, ...r.sib.sendText.mock.calls].filter(c => String(c[1]) === t("login.token_pasted", "claude-code"));
    expect(notices).toHaveLength(1);
    expect(notices[0][2]).toEqual({ threadId: "topic-g" });
    expect(String(r.dm.sendDirect.mock.calls.at(-1)![1])).toContain(TOKENS[1]);
  });

  it("an ordinary message, or one with no sign-in running, is left exactly as it was", async () => {
    const r = await rig();
    await (r.fm as any).handleInboundMessage({ ...pasted("main", "plain-1"), text: "hello there" });
    expect(JSON.stringify(r.deliver.mock.calls[0])).toContain("hello there");
    expect(r.login.sessions[0].peekAccessToken()).toBe(TOKENS[0]);
    expect(r.main.sendText.mock.calls.some((c: unknown[]) => String(c[1]).includes("🔒"))).toBe(false);
  });
});

describe("the web chat's /ui/send", () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });

  it("hides the token before delivering, keeping or logging it, and posts the take-back line in that chat", async () => {
    const login = controllerFor();
    await login.controller.start("claude-code", chatOf(adapterOf("discord")), { skipAuthCheck: true });
    const token = "a".repeat(48), sessions = new WebSessionStore();
    const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
    const delivered: any[] = [], sse: any[] = [], activity: any[] = [];
    const ctx: any = {
      webToken: token, webSessions: sessions, fleetConfig: { instances: { general: { working_directory: "/w" } } }, instanceIpcClients: new Map([["general", {}]]),
      deliverToInstance: async (_n: string, payload: unknown) => { delivered.push(payload); return true; },
      emitSseEvent: (kind: string, data: unknown) => { sse.push([kind, data]); },
      eventLog: { logActivity: (...a: unknown[]) => activity.push(a) },
      lastInboundUser: new Map(),
      screenLoginToken: (text: string) => login.controller.screenToken(text),
      loginTokenPasted: () => login.controller.tokenPasted(),
      logger: { error() {}, info() {}, warn() {}, debug() {} },
    };
    const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
    servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
    const base = `http://127.0.0.1:${(s.address() as any).port}`;
    const res = await fetch(base + "/ui/send", { method: "POST", body: JSON.stringify({ instance: "general", message: PASTE }),
      headers: { "content-type": "application/json", cookie: `agend_session=${admin.sessionId}`, origin: base, "x-agend-csrf": csrfTokenFor(admin.sessionId) } });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sse.some(([, d]) => d.role === "status")).toBe(true));
    expect(JSON.stringify([delivered, sse, activity])).not.toMatch(new RegExp(`${TOKENS[0]}|${TOKENS[1]}`, "i"));
    expect(JSON.stringify(delivered)).toContain(PASTED_TOKEN_MASK);
    const userLine = sse.find(([k, d]) => k === "message" && d.role === "user")![1];
    expect(userLine.text).toContain(PASTED_TOKEN_MASK);
    const status = sse.find(([, d]) => d.role === "status")![1];
    expect(status).toMatchObject({ instance: "general", sender: "AgEnD", text: t("login.token_pasted", "claude-code") });
    expect(sse.indexOf(sse.find(([, d]) => d.role === "user")!)).toBeLessThan(sse.indexOf(sse.find(([, d]) => d.role === "status")!));
    expect(login.sessions[0].peekAccessToken()).toBe(TOKENS[1]);
  });
});
