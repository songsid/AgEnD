/**
 * M-3277 (decision 7933bf90, the user 2026-11-17): a /web code AgEnD delivered privately to an admin's own Discord or
 * Telegram account (a DM, or Discord's ephemeral reply) is proof of identity — the session it makes starts verified, no
 * Confirm card; the DM gets the "signed in" notice with Not me. Codes that were not private, guest codes and `agend web
 * --code` on a chat fleet keep today's behaviour; re-verifying an expired authorization keeps the card ("or sign in
 * again with /web").
 * Here, the parts on their own: the code store's `private` mark, and the signed-in notice (SessionAuthorizationRequests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { WebLoginCodes } from "../src/web-login.js";
import { SessionAuthorizationRequests, type SessionAuthorizationDeps } from "../src/web-session-authorization.js";
import { FleetManager } from "../src/fleet-manager.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { handleAuthRequest, type AuthApiContext } from "../src/auth-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { tokenEpoch } from "../src/web-session.js";
import { setLocale, t } from "../src/locale.js";

const OWNER = { adapterId: "owner", userId: "admin" };
const H = "a1b2c3d4e5f60718";

describe("the code store: `private` is kept only on an admin code with an account", () => {
  const redeem = (opts: Parameters<WebLoginCodes["issue"]>[0]) => {
    const codes = new WebLoginCodes();
    const issued = codes.issue(opts);
    return codes.redeem(issued.display, opts.epoch, opts.audience ?? "local");
  };
  const ownerOf = { adapterId: "tg", userId: "7", chatId: "7" };
  it("an admin code sent to its owner or recipient privately: the redemption says private", () => {
    expect(redeem({ epoch: "e", recipient: { adapterId: "dc", userId: "9" }, private: true })).toMatchObject({ kind: "ok", tier: "admin", private: true });
    expect(redeem({ epoch: "e", owner: ownerOf, audience: "x".repeat(32), private: true })).toMatchObject({ kind: "ok", private: true });
  });
  it("not private: no mark; a host code, an admin code with no account, never — whatever the caller asks", () => {
    expect(redeem({ epoch: "e", recipient: { adapterId: "dc", userId: "9" } })).not.toHaveProperty("private");
    expect(redeem({ epoch: "e", host: true, private: true })).not.toHaveProperty("private");
    expect(redeem({ epoch: "e", private: true })).not.toHaveProperty("private");
    expect(redeem({ epoch: "e", tier: "guest", recipient: { adapterId: "dc", userId: "9" }, private: true } as never)).not.toHaveProperty("private");
  });
});

function rig(over: Partial<SessionAuthorizationDeps> = {}) {
  const mono = 1_000_000, wall = Date.UTC(2026, 10, 17, 9, 0, 0);
  const sent: Array<{ text: string; choices: string[] }> = [], edits: Array<{ text: string; choices: string[] }> = [], hints: string[] = [], events: Array<[string, any]> = [];
  const signedOut: string[] = [];
  const deps: SessionAuthorizationDeps = {
    now: () => mono, wallNow: () => wall, maxSessionMs: () => 48 * 3_600_000,
    sendDirect: async (_o, text, choices) => { sent.push({ text, choices: choices.map(c => c.id) }); return { chatId: "dm", messageId: `m${sent.length}` }; },
    sendGeneralHint: async (_o, text) => { hints.push(text); },
    editCard: async (_o, _w, text, choices) => { edits.push({ text, choices: choices.map(c => c.id) }); },
    authorize: () => ({ ok: true, until: wall + 48 * 3_600_000 }),
    signOut: (handle) => { signedOut.push(handle); return { durable: true, authorizationDurable: true }; },
    event: (type, payload) => { events.push([type, payload]); },
    text: { ask: (c) => `ASK ${c.label}`, confirmed: (c) => `OK ${c.label} ${c.until}`, signedIn: (c) => `SIGNED IN ${c.label} ${c.peer} ${c.until}`, signedInHint: () => "SIGNED-IN HINT",
      denied: (c) => `DENIED ${c.label}`, expired: (c) => `EXPIRED ${c.label}`, refused: (c) => `REFUSED ${c.label} ${c.refusal}`, revoked: (c) => `REVOKED ${c.label}`,
      notSaved: (c) => `NOT SAVED ${c.label}`, ended: (c) => `ENDED ${c.label}`, generalHint: () => "HINT", confirmLabel: () => "Confirm", notMeLabel: () => "Not me", notYours: () => "NOT YOURS" },
    log: { warn: vi.fn() }, ...over,
  };
  return { r: new SessionAuthorizationRequests(deps), sent, edits, hints, events, signedOut, wall };
}

describe("the signed-in notice (noteAuthorized)", () => {
  it("in the DM: the browser, where, until when — Not me only (nothing to confirm); an event says how it was verified", async () => {
    const h = rig(), until = h.wall + 48 * 3_600_000;
    expect(await h.r.noteAuthorized({ handle: H, owner: OWNER, label: "Safari on iPhone", peer: "named_link", until })).toEqual({ sent: true });
    expect(h.sent).toEqual([{ text: `SIGNED IN Safari on iPhone named_link ${until}`, choices: [expect.stringMatching(/^wauth:[0-9a-f]{32}:notme$/)] }]);
    expect(h.events).toEqual([["session_authorization_verified", expect.objectContaining({ session: H, actor: "owner:admin", peer: "named_link", via: "private_code" })]]);
    expect(h.r.pending(H), "no card waits for a Confirm").toBeNull();
  });
  it("Not me: that browser is signed out, the notice says so; only its account may press it", async () => {
    const h = rig();
    await h.r.noteAuthorized({ handle: H, owner: OWNER, label: "Safari on iPhone", peer: "loopback", until: h.wall + 3_600_000 });
    const ack = vi.fn();
    await h.r.handleCallback({ callbackData: h.sent[0]!.choices[0]!, userId: "someone", ack }, "owner");
    expect([ack.mock.calls[0]?.[0], h.signedOut]).toEqual(["NOT YOURS", []]);
    await h.r.handleCallback({ callbackData: h.sent[0]!.choices[0]!, userId: "admin", ack: vi.fn() }, "owner");
    expect([h.signedOut, h.edits.at(-1)]).toEqual([[H], { text: "REVOKED Safari on iPhone", choices: [] }]);
  });
  it("at the authorization's end the notice says it ended (no Not me left)", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 17, 9, 0, 0) });
    try {
      const h = rig({ wallNow: () => Date.now() });
      await h.r.noteAuthorized({ handle: H, owner: OWNER, label: "Edge", peer: "loopback", until: Date.now() + 60_000 });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(h.edits.at(-1)).toEqual({ text: "ENDED Edge", choices: [] });
    } finally { vi.useRealTimers(); }
  });
  it("no DM can be sent: one line with no details in General; the browser stays verified (/web revoke ends it)", async () => {
    const h = rig({ sendDirect: async () => null });
    expect(await h.r.noteAuthorized({ handle: H, owner: OWNER, label: "Edge", peer: "loopback", until: h.wall + 3_600_000 })).toEqual({ sent: false });
    expect([h.hints, h.signedOut, h.events.map(e => e[0])]).toEqual([["SIGNED-IN HINT"], [], ["session_authorization_verified"]]);
  });
});

// ── The real paths: a real FleetManager (no fleet, nothing spawns), the real /auth/login ──
const LOCAL_HOST = "127.0.0.1:19280", LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
const PUBLIC_HOST = "sample.trycloudflare.com", PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
let mono = 0;
const rigs: Array<{ dir: string; s: any }> = [];
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

/** One bot ("owner": Telegram or Discord), its General "T0", the admin "admin". `dm`: whether the bot can DM the admin. */
function fleet(o: { platform?: "telegram" | "discord"; va?: Record<string, unknown>; dm?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-m3277-"));
  const fm = new FleetManager(dir), s = fm as any;
  const dmOk = o.dm !== false;
  const adapter = { id: "owner", type: o.platform ?? "telegram", sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "safe" })),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "menu" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any) => { if (!dmOk) throw new Error("Cannot send messages to this user"); return { chatId: user, messageId: `dm${Math.random()}` }; }),
    editMessage: vi.fn(async () => {}), editMessageRemoveButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const owner = { id: "owner", type: o.platform ?? "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], health_port: 19280, ...(o.va ? { web: { verified_authority: o.va } } : {}),
    instances: { general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" } } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, isUserAllowed: () => true };
  writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
  const manager = { start: vi.fn(async (_p: unknown, ctx: any) => { ctx.onCandidateHost(PUBLIC_HOST); return { ok: true as const, handle: { pageUrl: `${PUBLIC_ORIGIN}/signin`, onUnexpectedExit: () => () => {} } }; }), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager as never);
  s.tunnelPurposeLane = lane;
  s.publicWebLink = new PublicWebLink({ dataDir: dir, web: () => fm.fleetConfig!.web, permitted: (w: any) => s.publicOwnerCurrent(w), reserve: (id: string) => lane.reserve("dashboard", id),
    createGateway: () => ({ listen: async () => new URL("http://127.0.0.1:12345"), setHost: () => {}, close: () => {}, readinessMarker: "stub" }) as never,
    ensure: async () => ({ path: "/pinned", source: "agend" }), provider: () => ({}) as never,
    revoke: (id: string) => { s.webLoginCodes.revokeAudience(id); s.webSessions.revokeExposure(id); }, log: () => {}, now: () => mono });
  const dmsTo = (user: string) => adapter.sendDirect.mock.calls.filter(c => c[0] === user);
  /** Click "local" or "public" on the /web menu that is waiting in `chat` (General "G", or the admin's DM). */
  async function click(chat: string, action: "local" | "public") {
    const e = [...s.pendingNonceButtons.values()].find((x: any) => x.chatId === chat && !x.consumed) as any;
    if (!e) throw new Error(`no menu in ${chat}`);
    await s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:${action}`, chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, userId: "admin", ack: vi.fn(), respondPrivate: undefined }, "owner", adapter);
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
  }
  const codeIn = (texts: string[]) => { const hit = texts.find(x => CODE.test(x)); if (!hit) throw new Error("no code"); return CODE.exec(hit)![0]; };
  async function signIn(code: string, opts: { gateway?: string; lan?: boolean } = {}) {
    const host = opts.gateway ? PUBLIC_HOST : opts.lan ? "192.0.2.5:19280" : LOCAL_HOST;
    const origin = opts.gateway ? PUBLIC_ORIGIN : `http://${host}`;
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/auth/login", headers: { host, "user-agent": UA, origin, "content-type": "application/json" },
      socket: { remoteAddress: opts.lan ? "192.0.2.20" : "127.0.0.1" }, destroy: vi.fn() });
    if (opts.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: opts.gateway, expectedOrigin: PUBLIC_ORIGIN, isCurrent: () => true });
    let status = 0; const out: Record<string, any> = {};
    const res = { destroyed: false, headersSent: false, setHeader: (k: string, v: any) => { out[k] = v; }, writeHead: (code: number, hd = {}) => { status = code; Object.assign(out, hd); }, end: () => {}, destroy: vi.fn() };
    expect(handleAuthRequest(req as never, res as never, new URL("/auth/login", opts.gateway ? PUBLIC_ORIGIN : origin), fm as unknown as AuthApiContext)).toBe(true);
    req.emit("data", Buffer.from(JSON.stringify({ code }))); req.emit("end");
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush(); await vi.advanceTimersByTimeAsync(0); await flush();   // the notice goes after the answer
    const newest = s.webSessions.list(undefined, () => true).sort((a: any, b: any) => b.created - a.created)[0];
    const rec = newest ? s.webSessions.findByHandle(newest.handle) : null;
    const device = ([] as string[]).concat(out["Set-Cookie"] ?? []).find(c => /^(__Host-)?agend_device_[0-9a-f]{16}=/.test(c))?.split(";")[0]?.split("=")[1];
    return { status, rec, device };
  }
  /** What the session's messages would carry now (§3, judged as a request from it would be). */
  const verified = (rec: any, peer: "loopback" | "lan" | "quick_link" | "named_link" = "loopback") =>
    s.webAuthority({ session: rec, gateway: peer === "quick_link" || peer === "named_link", peer }).authority.kind;
  const notices = () => adapter.sendDirect.mock.calls.filter(c => String(c[1]).includes("signed in with the code sent to you"));
  const h = { dir, fm, s, adapter, dmsTo, click, codeIn, signIn, verified, notices }; rigs.push(h); return h;
}
const NOT_ME = /^wauth:[0-9a-f]{32}:notme$/;

describe("a private /web code: the session starts verified, the DM gets the signed-in notice with Not me", () => {
  beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const h of rigs.splice(0)) rmSync(h.dir, { recursive: true, force: true }); });

  it("Telegram, /web in General → this computer: the code by DM; signed in: web-verified, no card; the notice with Not me only", async () => {
    const h = fleet();
    await h.s.topicCommands.handleGeneralCommand({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: "admin", username: "admin", text: "/web", messageId: "in", timestamp: new Date() });
    await h.click("G", "local");
    const code = h.codeIn(h.dmsTo("admin").map(c => String(c[1])));
    const { status, rec } = await h.signIn(code);
    expect([status, h.verified(rec)]).toEqual([200, "web-verified"]);
    const n = h.notices();
    expect(n).toHaveLength(1);
    expect([n[0]![0], (n[0]![2] as any).choices.map((c: any) => c.id)]).toEqual(["admin", [expect.stringMatching(NOT_ME)]]);
    expect(h.s.sessionAuthorizationRequests().pending(rec.handle), "no Confirm card asked").toBeNull();
    // Not me: that browser is signed out at once.
    await h.s.dispatchAdapterCallback({ callbackData: (n[0]![2] as any).choices[0].id, chatId: "admin", userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    await flush();
    expect(h.s.webSessions.list(undefined, () => true).some((r: any) => r.handle === rec.handle)).toBe(false);
  });

  it("Telegram, /start web in the bot's DM (the bot could not DM first): the menu there, the code there — verified the same", async () => {
    const h = fleet();
    vi.spyOn(h.s, "isFleetAdmin").mockReturnValue(true);
    await h.s.handleInboundMessage({ source: "telegram", adapterId: "owner", chatId: "admin", userId: "admin", username: "admin", text: "/start web", messageId: "m1", timestamp: new Date() });
    await flush();
    await h.click("admin", "local");
    const { status, rec } = await h.signIn(h.codeIn(h.dmsTo("admin").map(c => String(c[1]))));
    expect([status, h.verified(rec), h.notices().length]).toEqual([200, "web-verified", 1]);
  });

  it("Discord, /web with DMs closed: the code in the slash command's ephemeral answer — verified; the notice can't go by DM: General gets one line", async () => {
    const h = fleet({ platform: "discord", dm: false });
    vi.spyOn(h.s, "findGeneralInstance").mockReturnValue("general");               // this rig's General, as a Discord fleet finds it
    const respond = vi.fn(async (_text: string) => "eph");
    await h.s.sendLocalDashboard({ command: "web", channelId: "G", channelName: "general", userId: "admin", username: "admin", respond }, "owner");
    const code = h.codeIn(respond.mock.calls.map(c => String(c[0])));
    const { status, rec } = await h.signIn(code);
    expect([status, h.verified(rec)]).toEqual([200, "web-verified"]);
    expect(h.adapter.sendDirect.mock.calls.some(c => String(c[1]).includes("signed in with the code sent to you")), "the notice was tried by DM").toBe(true);
    expect(h.adapter.sendText.mock.calls.some(c => String(c[1]) === t("web_auth.signed_in_hint")), "then one line in General").toBe(true);
  });

  it("a returning device's 「send me a code」: the code by DM only — verified the same", async () => {
    const h = fleet();
    await h.s.topicCommands.handleGeneralCommand({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: "admin", username: "admin", text: "/web", messageId: "in", timestamp: new Date() });
    await h.click("G", "local");
    const first = await h.signIn(h.codeIn(h.dmsTo("admin").map(c => String(c[1]))));
    const device = h.s.returningDevices.verify(first.device, "c".repeat(48), tokenEpoch("c".repeat(48)));
    const before = h.dmsTo("admin").length;
    expect(await h.s.requestReturningCode(device, { surface: "local", label: "Chrome on macOS" })).toEqual({ kind: "sent" });
    const { status, rec } = await h.signIn(h.codeIn(h.dmsTo("admin").slice(before).map(c => String(c[1]))));
    expect([status, h.verified(rec), h.notices().length]).toEqual([200, "web-verified", 2]);
  });

  it("over the temporary public link (its option on by default): the code by DM, the session verified as a quick_link one", async () => {
    const h = fleet();
    await h.s.topicCommands.handleGeneralCommand({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: "admin", username: "admin", text: "/web", messageId: "in", timestamp: new Date() });
    await h.click("G", "public");
    const exposureId = h.s.publicWebLink.exposureId;
    const code = h.codeIn(h.dmsTo("admin").map(c => String(c[1])));
    const { status, rec } = await h.signIn(code, { gateway: exposureId });
    expect([status, rec.surface, h.verified(rec, "quick_link")]).toEqual([200, "gateway", "web-verified"]);
  });
});

describe("not verified at sign-in: as before", () => {
  beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const h of rigs.splice(0)) rmSync(h.dir, { recursive: true, force: true }); });
  const viaMenu = async (h: ReturnType<typeof fleet>) => {
    await h.s.topicCommands.handleGeneralCommand({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: "admin", username: "admin", text: "/web", messageId: "in", timestamp: new Date() });
    await h.click("G", "local");
    return h.codeIn(h.dmsTo("admin").map(c => String(c[1])));
  };

  it("a code that was not delivered privately (no `private` mark): signed in, unverified, no notice — the card is how", async () => {
    const h = fleet();
    const issued = h.s.webLoginCodes.issue({ epoch: tokenEpoch("c".repeat(48)), recipient: { adapterId: "owner", userId: "admin" } });
    const { status, rec } = await h.signIn(issued.display);
    expect([status, h.verified(rec), h.notices().length]).toEqual([200, "none", 0]);
  });
  it("`agend web --code` (the host's own code) on a chat fleet: no account, unverified, no notice", async () => {
    const h = fleet();
    const issued = h.s.webLoginCodes.issue({ epoch: tokenEpoch("c".repeat(48)), host: true });
    const { status, rec } = await h.signIn(issued.display);
    expect([status, rec.owner ?? null, h.verified(rec), h.notices().length]).toEqual([200, null, "none", 0]);
  });
  it("the web authorization switch off: signed in, unverified, no notice", async () => {
    const h = fleet({ va: { enabled: false } });
    const { status, rec } = await h.signIn(await viaMenu(h));
    expect([status, h.verified(rec), h.notices().length]).toEqual([200, "none", 0]);
  });
  it("\"Only this computer\" on, signed in from another device on the LAN: unverified (§3 as at a Confirm)", async () => {
    const h = fleet({ va: { loopback_only: true } });
    const { status, rec } = await h.signIn(await viaMenu(h), { lan: true });
    expect([status, h.verified(rec, "lan"), h.notices().length]).toEqual([200, "none", 0]);
  });
  it("re-verifying once the authorization ran out keeps the card — it now says \"or sign in again with /web\" (en, zh-TW)", () => {
    for (const [lang, word] of [["en", "sign in again with /web"], ["zh-TW", "用 /web 重新登入"]] as const) {
      setLocale(lang);
      expect([t("web_auth.card_ask", "a", "b", "c", "d"), t("web_auth.card_ended", "a"), t("web_auth.card_expired", "a")].every(x => x.includes(word)), lang).toBe(true);
    }
  });
});
