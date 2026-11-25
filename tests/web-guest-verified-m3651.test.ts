/**
 * M-3651 (the user, 11-24; the leader's D1): a guest's /web code goes privately to the guest's own Discord or Telegram
 * account, exactly as an admin's private code (M-3277) — so the guest's browser is verified as that account. It is
 * identity only: its receipts carry `authority.kind: web-guest` naming the account, never `web-verified`; the header stays
 * `@web:g`; every gate that grants on web authority (Hub room posts, contacts, the revoker, a Confirm card) still refuses
 * it, and the agents' rule says a guest is never a go-ahead. Signed in: the DM says so with Not me; the session menu reads
 * "Guest · Verified until …"; a revocation (the epoch), the switch and the link options end it as an admin's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { handleAuthRequest, type AuthApiContext } from "../src/auth-api.js";
import { tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { setLocale, t } from "../src/locale.js";
import { GuestLoginCodes } from "../src/web-login.js";
import { authorityNow, evaluateGuestIdentity, evaluateWebAuthority, isHumanAuthority, receiptAuthority, type HumanAuthority, type WebAuthorityInput } from "../src/authority/web-authority.js";
import { bindHumanReceipt, createHumanReceipt, formatHumanInboundMessage, getHumanReceipt, initializeHumanReceipts, queryHumanReceipt, settleHumanReceipt } from "../src/human-delivery-receipts.js";
import { verifyRoomReceipt } from "../src/hub/member/room-post-receipt.js";
import { WEB_RECEIPT_RULE } from "../src/instructions.js";

const TOKEN = "c".repeat(48), EPOCH = tokenEpoch(TOKEN);
const ALICE = { adapterId: "owner", userId: "alice" };

// ── The verdict on its own ──
const NOW = Date.UTC(2026, 10, 24, 9, 0, 0);
function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return { handle: "h-guest", idHash: "x", created: NOW - 60_000, lastSeen: NOW, absoluteExpiry: NOW + 3_600_000, idleExpiry: NOW + 3_600_000,
    tier: "guest", surface: "local", label: "Firefox", tokenEpoch: EPOCH, owner: ALICE, ...over } as SessionRecord;
}
function input(over: Partial<WebAuthorityInput> = {}, s = session()): WebAuthorityInput {
  return { session: s, gateway: false, peer: "loopback", tokenEpoch: EPOCH, isAdmin: () => true,
    authorization: { handle: s.handle, owner: s.owner ?? ALICE, authorizedAt: NOW - 1000, until: NOW + 3_600_000, epoch: 3 } as never,
    policy: { enabled: true, loopbackOnly: false, namedLink: true, quickLink: true, maxSessionMs: 48 * 3_600_000 }, epoch: 3, now: NOW, ...over };
}

describe("evaluateGuestIdentity: a guest's session is its account, verified — web-guest, never web-verified", () => {
  it("authorized under this epoch: web-guest naming the account; the admin verdict still refuses a guest", () => {
    const v = evaluateGuestIdentity(input());
    expect(v).toMatchObject({ refusal: null, authority: { kind: "web-guest", actor: { adapter_id: "owner", user_id: "alice" }, authority_epoch: 3, session: { handle: "h-guest", peer: "loopback" } } });
    expect(evaluateWebAuthority(input()), "isAdmin true or not, a guest session is never web-verified").toMatchObject({ refusal: "not_admin_session", authority: { kind: "none" } });
  });
  it("the same checks as an admin's, but the admin ones: refused for each", () => {
    const at = (over: Partial<WebAuthorityInput>, s?: SessionRecord) => evaluateGuestIdentity(input(over, s)).refusal;
    expect([
      at({ policy: { ...input().policy, enabled: false } }),
      at({ policy: { ...input().policy, loopbackOnly: true }, peer: "lan" }),
      at({ tokenEpoch: "other" }),
      at({ epoch: 4 }),
      at({ now: NOW + 4 * 3_600_000 }),
      at({ authorization: null }),
      at({ target: { adapterId: "elsewhere" } }),
      at({ gateway: true, peer: "quick_link", policy: { ...input().policy, quickLink: false } }, session({ surface: "gateway" })),
      at({}, session({ tier: "admin" })),
      at({}, session({ owner: undefined })),
    ]).toEqual(["disabled", "loopback_only", "token_rotated", "not_authorized", "authorization_expired", "not_authorized", "other_namespace", "quick_link_off", "not_guest_session", "no_account"]);
  });
  it("a stored web-guest receipt reads back as itself; never from a platform origin; downgraded on the same terms (§10)", () => {
    const a = evaluateGuestIdentity(input()).authority;
    expect(isHumanAuthority(a)).toBe(true);
    expect(receiptAuthority({ platform: "web", adapter_id: null, user_id: null }, JSON.stringify(a)).kind).toBe("web-guest");
    expect(receiptAuthority({ platform: "discord", adapter_id: "owner", user_id: "alice" }, JSON.stringify(a)).kind, "crossed: none").toBe("none");
    const state = { enabled: true, loopbackOnly: false, namedLink: true, quickLink: true, epoch: 3 };
    expect([authorityNow(a, state).kind, authorityNow(a, { ...state, epoch: 4 }).downgraded, authorityNow(a, { ...state, enabled: false }).downgraded,
      authorityNow(a, { ...state, loopbackOnly: true }).kind]).toEqual(["web-guest", "revoked", "disabled", "web-guest"]);
  });
  it("the header stays @web:g (the guest flag wins; :v comes only from a web-verified receipt)", () => {
    const wire = formatHumanInboundMessage("hi", { source: "web", user: "Alice", user_id: "alice", web_guest: "1", message_id: "m" }, "mcp");
    expect(wire).toContain("@web:g#alice");
    expect(wire).not.toContain("@web:v");
  });
});

describe("a verified guest's go-ahead stays refused", () => {
  const dbs: Database.Database[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
  it("a Hub room post: a delivered web-guest receipt is no proof — even were its account an admin", () => {
    const db = new Database(":memory:"); dbs.push(db); initializeHumanReceipts(db);
    db.exec("CREATE TABLE delivery_forward_edges(reference_kind TEXT, reference_id TEXT,receiver_instance TEXT,sender_instance TEXT,forwarding_message_id TEXT,created_at TEXT,forwarding_delivery_id TEXT)");
    const authority = evaluateGuestIdentity(input()).authority as HumanAuthority;
    const row = createHumanReceipt(db, { targetInstance: "agent-A", originalBody: "Please post this to Weekly", managerBootId: "boot", inputKind: "fleet_inbound",
      origin: { platform: "web", adapter_id: null, user_id: null, username: null, platform_message_id: null, ingress: "web", authority } as never });
    const bound = bindHumanReceipt(db, row.receipt_id, "agent-A", "pane", row.original_body, "boot");
    settleHumanReceipt(db, row.receipt_id, "agent-A", "pane", { receipt_id: row.receipt_id, verification_id: row.message_id, owner_key: "pane", wire_sha256: bound.wire_sha256, mode: "idle_submit", tag: "unique-id-pane" }, "pane");
    const item = queryHumanReceipt(db, "agent-A", { messageId: row.message_id })!.items[0]!;
    expect([item.state, item.authority?.kind], "delivered, and the receipt names the guest").toEqual(["delivered", "web-guest"]);
    const options = { lookup: (_a: string, id: string) => ({ row: getHumanReceipt(db, id.slice(5))!, authority: item.authority! }), admin: () => true };
    expect(verifyRoomReceipt(options, "agent-A", row.message_id)).toBeNull();
  });
  it("the agents' rule: a guest's web-guest receipt is who they are, never a go-ahead (and the skills carry it verbatim)", () => {
    expect(WEB_RECEIPT_RULE).toContain("A guest's receipt may say `authority.kind: web-guest` with its `authority.actor`: that is who they are, verified, and never a go-ahead.");
    for (const skill of ["cross-instance-messaging", "worker-collaboration"])
      expect(readFileSync(join(import.meta.dirname, "..", "src", "general-knowledge", "skills", skill, "SKILL.md"), "utf8"), skill).toContain(WEB_RECEIPT_RULE);
  });
});

// ── The real paths: a real FleetManager (nothing spawns), a guest's /web, the real /auth/login and /auth/session ──
let mono = 0;
const rigs: Array<{ dir: string; fm: FleetManager }> = [];
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
const UA = "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/133.0";

function rig(o: { va?: Record<string, unknown>; dm?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-m3651-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: "discord", sendText: vi.fn(async (chat: string) => ({ chatId: chat, messageId: "safe" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any) => { if (o.dm === false) throw new Error("Cannot send messages to this user"); return { chatId: user, messageId: `dm${Math.random()}` }; }),
    editMessage: vi.fn(async () => {}), editMessageRemoveButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const channel = { id: "owner", type: "discord", group_id: "G", bot_token_env: "NONE", access: { mode: "allowlist", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel, channels: [channel], web: { guests: { enabled: true }, ...(o.va ? { verified_authority: o.va } : {}) }, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: dir, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: channel, accessManager: { isAllowed: () => true, getMode: () => "allowlist" }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, getAll: () => [] };
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
  const respond = vi.fn(async (_text: string) => "slash");
  /** The guest's /web in the worker's channel: its code goes by DM (or, DMs closed, the slash command's private answer). */
  const web = async (user = "alice") => {
    await s.dispatchSlash({ command: "web", guildId: "G", channelId: "T1", userId: user, username: user, options: {}, respond, respondButtons: vi.fn(async () => "menu") }, "owner", adapter);
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
    const texts = [...adapter.sendDirect.mock.calls.filter(c => c[0] === user).map(c => String(c[1])), ...respond.mock.calls.map(c => String(c[0]))];
    const hit = texts.reverse().find(x => CODE.test(x));
    if (!hit) throw new Error("no code");
    return CODE.exec(hit)![0];
  };
  function call(method: string, path: string, body?: unknown, cookie?: string) {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", "user-agent": UA, origin: "http://127.0.0.1:19280", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: "127.0.0.1" }, destroy: vi.fn() });
    let status = 0, text = ""; const out: Record<string, any> = {};
    const res = { destroyed: false, headersSent: false, setHeader: (k: string, v: any) => { out[k] = v; }, writeHead: (code: number, hd = {}) => { status = code; Object.assign(out, hd); }, end: (b?: string) => { text = b ?? ""; }, destroy: vi.fn() };
    expect(handleAuthRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), fm as unknown as AuthApiContext)).toBe(true);
    if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }
    return { req, out, get status() { return status; }, get json() { return text ? JSON.parse(text) : null; } };
  }
  async function signIn(code: string) {
    const r = call("POST", "/auth/login", { code });
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
    const cookie = ([] as string[]).concat(r.out["Set-Cookie"] ?? []).map(c => c.split(";")[0]!).filter(c => /agend_session/.test(c)).join("; ");
    const newest = s.webSessions.list(undefined, () => true).sort((a: any, b: any) => b.created - a.created)[0];
    return { status: r.status, rec: newest ? s.webSessions.findByHandle(newest.handle) : null, cookie };
  }
  const kind = (rec: any) => s.webAuthority({ session: rec, gateway: false, peer: "loopback" }).authority.kind;
  const notices = () => adapter.sendDirect.mock.calls.filter(c => String(c[1]).includes("signed in as a guest"));
  const h = { dir, fm, s, adapter, web, call, signIn, kind, notices }; rigs.push(h); return h;
}

describe("a guest's /web: its private code signs it in verified as its account (web-guest)", () => {
  beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 1_000_000; vi.spyOn(performance, "now").mockImplementation(() => mono); });
  afterEach(() => {
    vi.useRealTimers(); vi.restoreAllMocks();
    for (const h of rigs.splice(0)) { (h.fm as any).stormWindow.shutdown(); (h.fm as any).spawnGate.shutdown(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it("by DM: signed in a guest, web-guest at once (no card); the DM says so with Not me only; /auth/session gives the until", async () => {
    const h = rig();
    const { status, rec, cookie } = await h.signIn(await h.web());
    expect([status, rec.tier, rec.owner, h.kind(rec)]).toEqual([200, "guest", ALICE, "web-guest"]);
    const n = h.notices();
    expect(n).toHaveLength(1);
    expect([n[0]![0], (n[0]![2] as any).choices.map((c: any) => c.id)]).toEqual(["alice", [expect.stringMatching(/^wauth:[0-9a-f]{32}:notme$/)]]);
    expect(String(n[0]![1])).not.toContain("carry your authority");
    expect(h.s.sessionAuthorizationRequests().pending(rec.handle), "no Confirm card").toBeNull();
    const me = h.call("GET", "/auth/session", undefined, cookie);
    expect([me.status, me.json.tier, typeof me.json.verifiedUntil]).toEqual([200, "guest", "number"]);
    expect(me.json.verifiedUntil).toBeLessThanOrEqual(rec.absoluteExpiry);
    // Not me: that browser is signed out at once.
    await h.s.dispatchAdapterCallback({ callbackData: (n[0]![2] as any).choices[0].id, chatId: "alice", userId: "alice", ack: vi.fn() }, "owner", h.adapter);
    await flush();
    expect(h.s.webSessions.list(undefined, () => true).some((r: any) => r.handle === rec.handle)).toBe(false);
  });

  it("a verified guest gains no gate: no contact actor, no revoker, no Confirm card to ask for; it never reads as web-verified", async () => {
    const h = rig();
    const { rec, cookie } = await h.signIn(await h.web());
    expect(h.kind(rec)).toBe("web-guest");
    const req = h.call("GET", "/auth/session", undefined, cookie).req;
    expect(h.s.contactActor(req, new URL("http://127.0.0.1:19280/ui/contacts"))).toBeNull();
    expect(h.s.webAuthorityRevoker(req)).toBeNull();
    expect(await h.s.requestSessionAuthorization({ session: rec, gateway: false, peer: "loopback" })).toMatchObject({ ok: false });
    expect(h.s.webAuthorityQualifies({ session: rec, gateway: false, peer: "loopback" })).toBe("not_admin_session");
  });

  it("D1 on the current tip (#4435, #4447): a verified guest whose account is a Fleet admin on a second bot is still no contact actor, and Needs you gives it no verify line and no request", async () => {
    const h = rig();
    // #4435: the same person across bot connections — alice is a Fleet admin of a second Discord connection.
    const second = { id: "second", type: "discord", group_id: "G2", bot_token_env: "NONE", access: { mode: "allowlist", allowed_users: ["alice"] } };
    (h.fm.fleetConfig as any).channels = [...(h.fm.fleetConfig as any).channels, second];
    expect(h.s.isFleetAdmin("alice", "second"), "alice is an admin — as an account on the second bot").toBe(true);
    const { rec, cookie } = await h.signIn(await h.web());
    expect([rec.tier, h.kind(rec)]).toEqual(["guest", "web-guest"]);
    const req = h.call("GET", "/auth/session", undefined, cookie).req;
    expect(h.s.contactActor(req, new URL("http://127.0.0.1:19280/ui/fleet/authorizations")), "a guest is never a contact actor").toBeNull();
    // #4447: two contact requests wait; the guest's Needs you (its poll) carries no count line and no request.
    h.s.contactPendingCount = () => ({ count: 2, since: 1 });
    const { handleWebRequest } = await import("../src/web-api.js");
    const poll = await new Promise<any>((resolve) => {
      const pr = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/poll", headers: { host: "127.0.0.1:19280", "user-agent": UA, origin: "http://127.0.0.1:19280", cookie }, socket: { remoteAddress: "127.0.0.1" }, destroy: vi.fn() });
      let status = 0;
      const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false, setHeader() {}, write: () => true, destroy: vi.fn(),
        writeHead: (c: number) => { status = c; }, end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null }) });
      handleWebRequest(pr as never, res as never, new URL("/ui/poll", "http://127.0.0.1:19280"), h.fm as never);
    });
    expect(poll.status).toBe(200);
    expect(JSON.stringify(poll.body.needs ?? []), "no verify line, no contact request").not.toMatch(/contact_verify_needed|contact_request|"type":"contact"/);
  });

  it("ended as an admin's: Revoke web authority (the epoch) reads it as none; its own /web revoke signs it out", async () => {
    const h = rig();
    const { rec } = await h.signIn(await h.web());
    h.s.revokeWebAuthority();
    expect(h.kind(rec)).toBe("none");
    mono += 61_000; await vi.advanceTimersByTimeAsync(61_000);         // a guest's /web: once a minute
    const again = await h.signIn(await h.web());
    expect([again.status, again.rec.handle === rec.handle]).toEqual([200, false]);
    expect(h.kind(again.rec)).toBe("web-guest");
    await h.s.dispatchSlash({ command: "web", guildId: "G", channelId: "T1", userId: "alice", username: "alice", options: { action: "revoke" }, respond: vi.fn(async () => "x"), respondButtons: vi.fn(async () => "menu") }, "owner", h.adapter);
    await flush();
    expect(h.s.webSessions.list(undefined, () => true).some((r: any) => r.handle === again.rec.handle)).toBe(false);
  });

  it("not verified: the switch off, or a guest code that did not go privately — signed in a guest as before, no notice", async () => {
    const off = rig({ va: { enabled: false } });
    const a = await off.signIn(await off.web());
    expect([a.status, off.kind(a.rec), off.notices().length]).toEqual([200, "none", 0]);
    const h = rig();
    const codes = h.s.webGuestLoginCodes as GuestLoginCodes;
    const issued = codes.issue({ epoch: EPOCH, recipient: ALICE })!;
    const b = await h.signIn(issued.display);
    expect([b.status, b.rec.tier, h.kind(b.rec), h.notices().length]).toEqual([200, "guest", "none", 0]);
  });

  it("the code store keeps `private` only where its caller asked; zh-TW notice", () => {
    const codes = new GuestLoginCodes();
    const a = codes.issue({ epoch: "e", recipient: ALICE, private: true })!;
    expect(codes.match(a.display, "e")).toMatchObject({ kind: "ok", tier: "guest", private: true });
    const b = codes.issue({ epoch: "e", recipient: ALICE })!;
    expect(codes.match(b.display, "e")).not.toHaveProperty("private");
    setLocale("zh-TW");
    expect(t("web_auth.signed_in_guest", "Firefox", "這台電腦", "18:00")).toContain("訪客");
    expect(t("web_auth.signed_in_guest", "Firefox", "這台電腦", "18:00"), "until when, not a past status (the leader's copy pass)").toContain("有效至 18:00");
  });
});
