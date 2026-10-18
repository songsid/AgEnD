/**
 * #1939 S1 (observe only; §0: once its account has authorized the session): a web message, command or click gets `web-verified` authority in its
 * receipt (docs/design/1939-verified-web-sessions.md §3, §4); delivery_status returns it; nothing else changes. The §3
 * checks one by one (pure), then the real web routes on a real FleetManager with no fleet, then the receipt store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { createHumanReceipt, initializeHumanReceipts, nativeHumanOrigin, queryHumanReceipt, webHumanOrigin } from "../src/human-delivery-receipts.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { setLocale } from "../src/locale.js";
import {
  classifyWebPeer, confirmAfterBody, evaluateWebAuthority, receiptAuthority, webAuthorityPolicy,
  type HumanAuthority, type WebAuthorityInput,
} from "../src/authority/web-authority.js";

const TOKEN = "c".repeat(48), EPOCH = tokenEpoch(TOKEN);
const HOUR = 3_600_000, T0 = Date.UTC(2026, 9, 18, 9, 0, 0);
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({ handle: "a1b2c3d4e5f60718", idHash: "x".repeat(64), created: T0, lastSeen: T0,
  absoluteExpiry: T0 + 48 * HOUR, idleExpiry: T0 + 48 * HOUR, tier: "admin", surface: "local", label: "Firefox", tokenEpoch: EPOCH,
  owner: { adapterId: "owner", userId: "admin" }, ...over });
/** §0: this session authorized by its account half an hour after sign-in, under epoch 0. */
const AUTH = { handle: "a1b2c3d4e5f60718", owner: { adapterId: "owner", userId: "admin" }, authorizedAt: T0 + HOUR / 2, until: T0 + HOUR / 2 + 48 * HOUR, epoch: 0 };
const input = (over: Partial<WebAuthorityInput> = {}): WebAuthorityInput => ({ session: record(), gateway: false, peer: "loopback", tokenEpoch: EPOCH,
  isAdmin: (u, a) => a === "owner" && u === "admin", authorization: AUTH, policy: { enabled: true, loopbackOnly: false, maxSessionMs: 48 * HOUR }, epoch: 0, now: T0 + HOUR, ...over });
const req = (remoteAddress: string | undefined, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers });

describe("§3.4 where one request comes from: loopback only when the peer, the Host and the headers all say so", () => {
  it.each([
    ["127.0.0.1", "127.0.0.1:19280"], ["127.8.9.10", "localhost:19280"], ["::1", "[::1]:19280"], ["::ffff:127.0.0.1", "localhost"],
    ["127.0.0.1", "LOCALHOST."],
  ])("peer %s, Host %s → loopback", (peer, host) => expect(classifyWebPeer(req(peer, { host }))).toBe("loopback"));
  it.each([
    ["a LAN peer", "192.168.1.20", "127.0.0.1:19280"], ["a tailnet peer", "100.64.0.7", "localhost"], ["no peer address", undefined, "localhost"],
    ["a mapped LAN peer", "::ffff:192.168.1.20", "localhost"], ["a LAN Host", "127.0.0.1", "192.168.1.5:19280"],
    ["a proxy's name", "127.0.0.1", "agend.example.com"], ["no Host", "127.0.0.1", ""], ["a 127-lookalike", "127.0.0.1.evil", "localhost"],
  ])("%s → lan", (_name, peer, host) => expect(classifyWebPeer(req(peer, host ? { host } : {}))).toBe("lan"));
  it.each(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "via"])("a %s header makes a loopback request lan", h => {
    expect(classifyWebPeer(req("127.0.0.1", { host: "localhost", [h]: "1.2.3.4" }))).toBe("lan");
  });
});

describe("§3 every check, in order, for one request", () => {
  it("a qualifying, authorized session: web-verified, bound to its account, with its handle, peer, sign-in and authorization times", () => {
    expect(evaluateWebAuthority(input())).toEqual({ refusal: null, authority: { kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" },
      session: { handle: "a1b2c3d4e5f60718", peer: "loopback", signed_in_at: "2026-10-18T09:00:00.000Z", authorized_at: "2026-10-18T09:30:00.000Z" }, authority_epoch: 0 } });
    expect(evaluateWebAuthority(input({ peer: "lan" })).authority.session?.peer).toBe("lan");     // §11.3: LAN qualifies by default
  });
  it.each([
    ["the public link (request)", { gateway: true }, "public_link"],
    ["a header token or CLI call", { session: null }, "not_session"],
    ["a guest session", { session: record({ tier: "guest" }) }, "not_admin_session"],
    ["a read session", { session: record({ tier: "read" }) }, "not_admin_session"],
    ["a public-link session", { session: record({ surface: "gateway", exposureId: "e" }) }, "public_link"],
    ["a rotated token", { tokenEpoch: "d".repeat(64) }, "token_rotated"],
    ["no token", { tokenEpoch: null }, "token_rotated"],
    ["an `agend web --code` session", { session: record({ owner: undefined }) }, "no_account"],
    ["an account no longer in allowed_users", { isAdmin: () => false }, "not_admin"],
    ["an instance of another adapter", { target: { adapterId: "two" } }, "other_namespace"],
    ["an instance with no adapter", { target: { adapterId: undefined } }, "other_namespace"],
    ["a LAN request under loopback_only", { peer: "lan", policy: { enabled: true, loopbackOnly: true, maxSessionMs: 48 * HOUR } }, "loopback_only"],
    ["the server switch off", { policy: { enabled: false, loopbackOnly: false, maxSessionMs: 48 * HOUR } }, "disabled"],
    ["the switch off, even on the public link", { gateway: true, policy: { enabled: false, loopbackOnly: false, maxSessionMs: 48 * HOUR } }, "disabled"],
    ["a session its account has not authorized", { authorization: null }, "not_authorized"],
    ["another session's authorization", { authorization: { ...AUTH, handle: "ffffffffffffffff" } }, "not_authorized"],
    ["an authorization by another account", { authorization: { ...AUTH, owner: { adapterId: "owner", userId: "admin2" } } }, "not_authorized"],
    ["an authorization on another adapter", { authorization: { ...AUTH, owner: { adapterId: "two", userId: "admin" } } }, "not_authorized"],
    ["an authorization past max_session_hours", { now: AUTH.authorizedAt + 48 * HOUR + 1 }, "authorization_expired"],
  ] as Array<[string, Partial<WebAuthorityInput>, string]>)("%s → none (%s)", (_name, over, refusal) => {
    expect(evaluateWebAuthority(input(over))).toEqual({ authority: { kind: "none", actor: null, authority_epoch: 0 }, refusal });
  });
  it("an authorization given under an older epoch is none (stamped with the current one)", () => {
    expect(evaluateWebAuthority(input({ epoch: 1 }))).toEqual({ authority: { kind: "none", actor: null, authority_epoch: 1 }, refusal: "not_authorized" });
  });
  it("the admin check asks the bound account's own adapter, and the target must be that adapter", () => {
    const isAdmin = vi.fn(() => true);
    expect(evaluateWebAuthority(input({ isAdmin, target: { adapterId: "owner" } })).refusal).toBeNull();
    expect(isAdmin).toHaveBeenCalledWith("admin", "owner");
  });
  it("loopback_only lets a loopback request through; the age limit counts from the authorization, inclusive, the policy's", () => {
    expect(evaluateWebAuthority(input({ policy: { enabled: true, loopbackOnly: true, maxSessionMs: 48 * HOUR } })).refusal).toBeNull();
    expect(evaluateWebAuthority(input({ now: AUTH.authorizedAt + 48 * HOUR })).refusal).toBeNull();
    expect(evaluateWebAuthority(input({ now: T0 + 48 * HOUR + 1 })).refusal, "48 h after sign-in, but not after authorizing").toBeNull();
    expect(evaluateWebAuthority(input({ policy: { enabled: true, loopbackOnly: false, maxSessionMs: HOUR }, now: AUTH.authorizedAt + HOUR + 1 })).refusal).toBe("authorization_expired");
  });
  it("on arrival and after the body: both must pass, under the same session", () => {
    const ok = evaluateWebAuthority(input()), lan = evaluateWebAuthority(input({ peer: "lan" }));
    expect(confirmAfterBody(ok, ok)).toEqual(ok);
    expect(confirmAfterBody(ok, lan)).toEqual(lan);                                       // the later values
    expect(confirmAfterBody(evaluateWebAuthority(input({ gateway: true })), ok)).toEqual({ authority: { kind: "none", actor: null, authority_epoch: 0 }, refusal: "public_link" });
    expect(confirmAfterBody(ok, evaluateWebAuthority(input({ isAdmin: () => false }))).refusal).toBe("not_admin");
    expect(confirmAfterBody(ok, evaluateWebAuthority(input({ session: record({ handle: "ffffffffffffffff" }), authorization: { ...AUTH, handle: "ffffffffffffffff" } }))))
      .toEqual({ authority: { kind: "none", actor: null, authority_epoch: 0 }, refusal: "session_changed" });
  });
  it("the policy: 48 h and LAN by default; a bad value never loosens it", () => {
    expect(webAuthorityPolicy(undefined)).toEqual({ enabled: true, loopbackOnly: false, maxSessionMs: 48 * HOUR });         // §0.1: on by default
    expect(webAuthorityPolicy({ verified_authority: { enabled: true, loopback_only: true, max_session_hours: 6 } })).toEqual({ enabled: true, loopbackOnly: true, maxSessionMs: 6 * HOUR });
    expect(webAuthorityPolicy({ verified_authority: { enabled: false } }).enabled).toBe(false);
    expect(webAuthorityPolicy({ verified_authority: { max_session_hours: 500 } }).maxSessionMs).toBe(48 * HOUR);
    expect(webAuthorityPolicy({ verified_authority: { max_session_hours: 0 } }).maxSessionMs).toBe(HOUR);
    expect(webAuthorityPolicy({ verified_authority: { max_session_hours: Number.NaN } }).maxSessionMs).toBe(48 * HOUR);
    expect(webAuthorityPolicy({ verified_authority: { loopback_only: "yes" as never } }).loopbackOnly).toBe(false);
  });
  it("fleet.yaml: its keys are checked; others under it are ignored with a warning", () => {
    const issues = (va: unknown) => { const r = validateFleetConfig({ instances: {}, web: { verified_authority: va } } as never); return [...r.errors, ...r.warnings].map(i => i.path).filter(p => p.startsWith("web.")); };
    expect(issues({ loopback_only: true, max_session_hours: 12 })).toEqual([]);
    expect(issues({ loopback_only: "no" })).toEqual(["web.verified_authority.loopback_only"]);
    expect(issues({ max_session_hours: 49 })).toEqual(["web.verified_authority.max_session_hours"]);
    expect(issues({ max_session_hours: 0.5 })).toEqual(["web.verified_authority.max_session_hours"]);
    expect(issues({ enabled: true })).toEqual([]);
    expect(issues({ enabled: "on" })).toEqual(["web.verified_authority.enabled"]);
    expect(issues({ switch: true })).toEqual(["web.verified_authority.switch"]);
    expect(issues("on")).toEqual(["web.verified_authority"]);
  });
});

// ── the real web routes ──

const rigs: Array<{ dir: string }> = [];
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
const LOCAL_HOST = "127.0.0.1:19280", LOCAL_ORIGIN = `http://${LOCAL_HOST}`;

/** A real FleetManager with no fleet: Telegram "owner" (admins admin, admin2) owns general; Discord "two" owns alpha. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1939-")); rigs.push({ dir });
  const fm = new FleetManager(dir), s = fm as any;
  const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin", "admin2"] } };
  const two = { id: "two", type: "discord", group_id: "D", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner, two], health_port: 19280, web: { verified_authority: { enabled: true } }, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    alpha: { working_directory: dir, topic_id: "T1", channel_id: "two" },
  } } as never;
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, getAll: () => [], getChannelIdByInstance: () => undefined, isCollab: () => false };
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
  const got: Array<{ name: string; payload: any; origin: any }> = [];
  for (const name of ["general", "alpha"]) s.instanceIpcClients.set(name, { send: () => true });
  s.deliverHumanToInstance = vi.fn(async (name: string, payload: any, origin: any) => { got.push({ name, payload, origin }); return true; });
  return { dir, fm, s, got };
}
type Rig = ReturnType<typeof rig>;
type Who = { cookie?: string; sessionId?: string; token?: string; gateway?: string; peer?: string; headers?: Record<string, string> };

/**
 * A session as the sign-in makes it (#1827 binds `owner` to the DM recipient; tested there), as its cookie. With an owner
 * it is also authorized by that account now (§0; S2b's card or code does that in the product) — unless `authorized:
 * false` — straight in the store, so every other §3 check is still what decides.
 */
function session(h: Rig, over: { owner?: { adapterId: string; userId: string } | null; tier?: "admin" | "guest"; surface?: "local" | "gateway"; exposureId?: string; authorized?: boolean } = {}): Who {
  const owner = over.owner === undefined ? { adapterId: "owner", userId: "admin" } : over.owner;
  const { sessionId, record } = h.s.webSessions.create({ tier: over.tier ?? "admin", surface: over.surface ?? "local", label: "Firefox", tokenEpoch: EPOCH,
    ...(owner ? { owner } : {}), ...(over.exposureId ? { exposureId: over.exposureId } : {}) });
  if (owner && over.authorized !== false) h.s.sessionAuthorizationStore().authorize(record.handle, owner, Date.now(), h.s.webAuthorityState().epoch, Date.now() + 48 * HOUR);
  // Over https (the public link) the cookie is the __Host- one.
  return { cookie: `${over.exposureId ? "__Host-" : ""}agend_session=${sessionId}`, sessionId, ...(over.exposureId ? { gateway: over.exposureId } : {}) };
}

/** One request through the real web routes; `between` runs after the route took it and before its body arrives. */
async function web(h: Rig, path: string, who: Who, body: unknown, between?: () => void) {
  const origin = who.gateway ? "https://sample.trycloudflare.com" : LOCAL_ORIGIN, host = who.gateway ? "sample.trycloudflare.com" : LOCAL_HOST;
  const headers: Record<string, string> = { host, origin, "content-type": "application/json", ...(who.cookie ? { cookie: who.cookie } : {}),
    ...(who.sessionId ? { "x-agend-csrf": csrfTokenFor(who.sessionId) } : {}), ...(who.token ? { "x-agend-token": who.token } : {}), ...who.headers };
  const req = Object.assign(new EventEmitter(), { method: "POST", url: path, headers, destroy: vi.fn(), socket: { destroy() {}, remoteAddress: who.peer ?? "127.0.0.1" } });
  if (who.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: who.gateway, expectedOrigin: origin, isCurrent: () => true });
  let status = 0;
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end() {}, write() { return true; }, destroy: vi.fn() });
  expect(handleWebRequest(req as never, res as never, new URL(path, origin), h.fm as never)).toBe(true);
  between?.();
  req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end");
  for (let n = 0; n < 6; n++) { await flush(); await vi.advanceTimersByTimeAsync(0); }
  return status;
}
const send = (h: Rig, who: Who, instance = "general", between?: () => void) => web(h, "/ui/send", who, { instance, message: "ship it" }, between);
const NONE: HumanAuthority = { kind: "none", actor: null, authority_epoch: 0 };
/** In the rig: the switch was turned on (its first read moved the epoch from 0 to 1). */
const NONE1: HumanAuthority = { kind: "none", actor: null, authority_epoch: 1 };

beforeEach(() => { setLocale("en"); vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const r of rigs.splice(0)) rmSync(r.dir, { recursive: true, force: true }); });

describe("/ui/send: the receipt's origin carries the session's authority (and is still the web's, with no platform actor)", () => {
  it("a signed-in admin on this machine, authorized: web-verified, as the bound account, from loopback", async () => {
    const h = rig(); const a = session(h);
    vi.setSystemTime(T0 + 2 * HOUR);
    expect(await send(h, a)).toBe(200);
    const { origin } = h.got[0]!;
    expect(origin).toMatchObject({ platform: "web", adapter_id: null, user_id: null, username: null, ingress: "web" });
    const handle = h.s.webSessions.list(undefined, () => true)[0]!.handle;
    expect(origin.authority).toEqual({ kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" },
      session: { handle, peer: "loopback", signed_in_at: new Date(T0).toISOString(), authorized_at: new Date(T0).toISOString() }, authority_epoch: 1 });
  });
  it("§0: the same session before its account authorized it: none — recognition only, as before #1939", async () => {
    const h = rig(); const a = session(h, { authorized: false });
    expect(await send(h, a)).toBe(200);
    expect(h.got[0]!.origin.authority).toEqual(NONE1);
  });
  it("from a LAN browser: web-verified with peer lan; with loopback_only on: none", async () => {
    const h = rig(); const a = session(h);
    await send(h, { ...a, peer: "192.168.1.20" });
    expect(h.got[0]!.origin.authority).toMatchObject({ kind: "web-verified", session: { peer: "lan" } });
    h.fm.fleetConfig!.web = { verified_authority: { enabled: true, loopback_only: true } };
    await send(h, { ...a, peer: "192.168.1.20" });
    expect(h.got[1]!.origin.authority).toEqual(NONE1);
    await send(h, a);
    expect(h.got[2]!.origin.authority).toMatchObject({ kind: "web-verified", session: { peer: "loopback" } });
  });
  it("through a proxy header from this machine: lan", async () => {
    const h = rig(); const a = session(h);
    await send(h, { ...a, headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(h.got[0]!.origin.authority.session.peer).toBe("lan");
  });
  it.each([
    ["the CLI's header token", (_h: Rig) => ({ token: TOKEN })],
    ["an `agend web --code` session (no account)", (h: Rig) => session(h, { owner: null })],
    ["an account that is not an admin", (h: Rig) => session(h, { owner: { adapterId: "owner", userId: "stranger" } })],
  ])("%s: none", async (_name, who) => {
    const h = rig();
    expect(await send(h, who(h))).toBe(200);
    expect(h.got[0]!.origin.authority).toEqual(NONE1);
  });
  it("the public link: none, even for an admin's account", async () => {
    const h = rig();
    expect(await send(h, session(h, { surface: "gateway", exposureId: "e1" }))).toBe(200);
    expect(h.got[0]!.origin.authority).toEqual(NONE1);
  });
  it("an instance of another adapter: none (the same user id on Discord is another account)", async () => {
    const h = rig();
    await send(h, session(h), "alpha");
    expect(h.got[0]!.origin.authority).toEqual(NONE1);
    await send(h, session(h, { owner: { adapterId: "two", userId: "admin" } }), "alpha");
    expect(h.got[1]!.origin.authority).toMatchObject({ kind: "web-verified", actor: { adapter_id: "two", user_id: "admin" } });
  });
  it("too long after the authorization: none — and it still sends, as recognition", async () => {
    const h = rig(); const a = session(h);
    h.fm.fleetConfig!.web = { verified_authority: { enabled: true, max_session_hours: 1 } };
    vi.setSystemTime(T0 + HOUR + 1000);
    expect(await send(h, a)).toBe(200);
    expect(h.got[0]!.origin.authority).toEqual(NONE1);
    expect(h.got[0]!.payload.content).toBe("ship it");
  });
  it("re-checked after the body: removed from allowed_users meanwhile → none", async () => {
    const h = rig(); const a = session(h);
    await send(h, a, "general", () => { (h.fm.fleetConfig as any).channels[0].access.allowed_users = ["admin2"]; });
    expect(h.got[0]!.origin.authority).toEqual(NONE1);
  });
  it("…and loopback_only turned on meanwhile → none", async () => {
    const h = rig(); const a = session(h);
    await send(h, { ...a, peer: "100.64.0.7" }, "general", () => { h.fm.fleetConfig!.web = { verified_authority: { enabled: true, loopback_only: true } }; });
    expect(h.got[0]!.origin.authority).toEqual(NONE1);
  });
  it("…and checked on arrival too: an admin added only after the request arrived gets none", async () => {
    const h = rig(); const a = session(h, { owner: { adapterId: "owner", userId: "late" } });
    await send(h, a, "general", () => { (h.fm.fleetConfig as any).channels[0].access.allowed_users.push("late"); });
    expect(h.got[0]!.origin.authority).toEqual(NONE1);
    await send(h, a);
    expect(h.got[1]!.origin.authority.kind).toBe("web-verified");
  });
  it("the request never counts as activity for the session (the check reads it untouched)", async () => {
    const h = rig(); const a = session(h);
    const auth = vi.spyOn(h.s.webSessions, "authenticate");
    await send(h, a);
    expect(auth.mock.calls.filter((c: any[]) => c[2]?.touch === false).length).toBeGreaterThanOrEqual(2);
  });
});

describe("/ui/command and /ui/reply-button carry it too", () => {
  it("a /steer: the authority reaches the steer's origin", async () => {
    const h = rig(); const a = session(h);
    const steer = vi.spyOn(h.s.topicCommands, "sendSteer").mockReturnValue("queued" as never);
    await web(h, "/ui/command", a, { instance: "general", command: "steer", args: "look here" });
    expect(steer).toHaveBeenCalled();
    const meta = steer.mock.calls[0]![2] as any;
    expect(meta.humanOrigin).toMatchObject({ platform: "web", adapter_id: null, user_id: null, ingress: "action", authority: { kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" } } });
  });
  it("a /steer re-checks after the body", async () => {
    const h = rig(); const a = session(h);
    const run = vi.spyOn(h.fm, "webCommand").mockResolvedValue({ status: 200, body: {} } as never);
    await web(h, "/ui/command", a, { instance: "general", command: "steer", args: "x" }, () => { (h.fm.fleetConfig as any).channels[0].access.allowed_users = []; });
    expect(run.mock.calls[0]![1].authority).toEqual(NONE1);
    await web(h, "/ui/command", a, { instance: "alpha", command: "steer", args: "x" });
    expect(run.mock.calls[1]![1].authority).toEqual(NONE1);
  });
  it("a reply-button click: the voter's authority, which the controller puts on the click's origin", async () => {
    const h = rig(); const a = session(h);
    const click = vi.spyOn(h.fm, "clickWebReplyButton").mockResolvedValue({ status: 200 });
    await web(h, "/ui/reply-button", a, { instance: "general", id: "f".repeat(32), index: 0 });
    expect(click.mock.calls[0]![3]!.authority).toMatchObject({ kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" } });
    await web(h, "/ui/reply-button", session(h, { owner: null }), { instance: "general", id: "f".repeat(32), index: 0 });
    expect(click.mock.calls[1]![3]!.authority).toEqual(NONE1);
  });
  it("the controller delivers a web click with that authority on its (web) origin", async () => {
    const { ReplyButtonsController } = await import("../src/reply-buttons-controller.js");
    const set = { id: "f".repeat(32), instance: "general", poll: null, messageId: null, settledAt: null };
    const deliver = vi.fn(async () => true);
    const ctl = new ReplyButtonsController({ store: { get: () => set, consume: () => ({ ok: true, set, button: { label: "A" } }), markDelivered() {}, release() {} },
      now: () => T0, deliver, logger: { info() {}, warn() {} } } as never);
    const authority = evaluateWebAuthority(input()).authority;
    expect(await ctl.clickWeb("general", set.id, 0, { key: "k", userId: "admin", name: "Ann", authority })).toEqual({ status: 200 });
    expect((deliver.mock.calls[0] as any)[2].humanOrigin).toEqual(webHumanOrigin(true, authority));
    await ctl.clickWeb("general", set.id, 0, { key: "k", userId: "admin", name: "Ann" });
    expect((deliver.mock.calls[1] as any)[2].humanOrigin).toEqual(webHumanOrigin(true));
  });
});

// ── the receipt ──

describe("the receipt stores it apart from origin; delivery_status returns it", () => {
  const db = () => { const d = new Database(":memory:"); initializeHumanReceipts(d); d.exec("CREATE TABLE delivery_forward_edges (reference_kind TEXT, reference_id TEXT, receiver_instance TEXT, sender_instance TEXT, forwarding_message_id TEXT, created_at TEXT, forwarding_delivery_id TEXT)"); return d; };
  const web1: HumanAuthority = { kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" },
    session: { handle: "a1b2c3d4e5f60718", peer: "lan", signed_in_at: "2026-10-18T09:00:00.000Z", authorized_at: "2026-10-18T09:05:00.000Z" }, authority_epoch: 0 };
  const status = (d: Database.Database, id: string) => queryHumanReceipt(d, "general", { messageId: "hmsg-" + id } as never)!.items[0]!;
  const make = (d: Database.Database, origin: any) => createHumanReceipt(d, { targetInstance: "general", originalBody: "ship it", origin, inputKind: "fleet_inbound", managerBootId: "m" });

  it("web-verified: `authority` next to origin and proof_kind; source_instance names the account; origin keeps null actor fields", () => {
    const d = db(); const row = make(d, webHumanOrigin(false, web1));
    const item = status(d, row.receipt_id);
    expect(item.authority).toEqual(web1);
    expect(item.source_instance).toBe("human:web:owner:admin");
    expect(item.origin).toEqual(webHumanOrigin());
    expect(JSON.parse(row.origin_json)).not.toHaveProperty("authority");
  });
  it("web none: none, and still human:web:unknown", () => {
    const d = db();
    const item = status(d, make(d, webHumanOrigin(false, NONE)).receipt_id);
    expect(item.authority).toEqual(NONE);
    expect(item.source_instance).toBe("human:web:unknown");
    expect(status(d, make(d, webHumanOrigin()).receipt_id).authority).toEqual(NONE);       // nothing said: none
  });
  it("a platform message: platform, its sender", () => {
    const d = db(); const origin = nativeHumanOrigin("discord", "two", "42", "ann", false, "900")!;
    const item = status(d, make(d, origin).receipt_id);
    expect(item.authority).toEqual({ kind: "platform", actor: { adapter_id: "two", user_id: "42" }, authority_epoch: 0 });
    expect(item.source_instance).toBe("human:discord:42");
  });
  it("only web admission writes authority: platform traffic with one, or a platform kind on the web, or a bad shape, is refused", () => {
    const d = db();
    expect(() => make(d, { ...nativeHumanOrigin("discord", "two", "42", "ann", false, "900")!, authority: web1 })).toThrow(/unavailable/);
    expect(() => make(d, webHumanOrigin(false, { kind: "platform", actor: { adapter_id: "owner", user_id: "admin" }, authority_epoch: 0 }))).toThrow(/unavailable/);
    expect(() => make(d, webHumanOrigin(false, { ...web1, session: undefined } as never))).toThrow(/unavailable/);
    expect(() => make(d, webHumanOrigin(false, { ...web1, actor: null } as never))).toThrow(/unavailable/);
    expect(() => make(d, webHumanOrigin(false, { ...NONE, authority_epoch: -1 }))).toThrow(/unavailable/);
  });
  it("rows from before #1939: discord/telegram read as platform, web as none", () => {
    const d = db();
    const a = make(d, nativeHumanOrigin("telegram", "owner", "7", "bo", false, "1")!), b = make(d, webHumanOrigin(false, web1));
    d.prepare("UPDATE human_delivery_receipts SET authority_json=NULL").run();
    expect(status(d, a.receipt_id).authority).toEqual({ kind: "platform", actor: { adapter_id: "owner", user_id: "7" }, authority_epoch: 0 });
    expect(status(d, b.receipt_id).authority).toEqual(NONE);
    expect(status(d, b.receipt_id).source_instance).toBe("human:web:unknown");
  });
  it("an older database gains the column in place, and its rows keep their meaning", () => {
    const d = new Database(":memory:");
    d.exec("CREATE TABLE human_delivery_receipts (receipt_id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE,target_instance TEXT NOT NULL,manager_boot_id TEXT NOT NULL,original_body TEXT NOT NULL,original_sha256 TEXT NOT NULL,origin_json TEXT NOT NULL,wire_body TEXT,wire_sha256 TEXT,owner_key TEXT,input_kind TEXT NOT NULL,state TEXT NOT NULL,proof_tag TEXT,proof_mode TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,delivered_at TEXT)");
    d.prepare("INSERT INTO human_delivery_receipts VALUES ('r','hmsg-r','general','m','x','h',?,NULL,NULL,NULL,'fleet_inbound','queued',NULL,NULL,'t','t',NULL)").run(JSON.stringify(webHumanOrigin()));
    initializeHumanReceipts(d); initializeHumanReceipts(d);                                  // twice: idempotent
    expect((d.prepare("PRAGMA table_info(human_delivery_receipts)").all() as any[]).map(c => c.name)).toContain("authority_json");
    d.exec("CREATE TABLE delivery_forward_edges (reference_kind TEXT, reference_id TEXT, receiver_instance TEXT, sender_instance TEXT, forwarding_message_id TEXT, created_at TEXT, forwarding_delivery_id TEXT)");
    expect(status(d, "r").authority).toEqual(NONE);
  });
  it.each([
    ["not JSON", "{", NONE],
    ["another shape", JSON.stringify({ kind: "web-verified" }), NONE],
    ["platform on a web row", JSON.stringify({ kind: "platform", actor: { adapter_id: "owner", user_id: "admin" }, authority_epoch: 0 }), NONE],
  ])("a stored value that is %s reads as none", (_name, stored, want) => {
    expect(receiptAuthority({ platform: "web", adapter_id: null, user_id: null }, stored)).toEqual(want);
  });
  it("§0: S1's observe-only web-session, and a web-verified value without its authorization time, read as none", () => {
    const actor = { adapter_id: "owner", user_id: "admin" }, session = { handle: "a1b2c3d4e5f60718", peer: "lan", signed_in_at: "2026-10-18T09:00:00.000Z" };
    const web = { platform: "web", adapter_id: null, user_id: null };
    expect(receiptAuthority(web, JSON.stringify({ kind: "web-session", actor, session: { ...session, age_s: 60 }, authority_epoch: 0 }))).toEqual(NONE);
    expect(receiptAuthority(web, JSON.stringify({ kind: "web-session", actor, session: { ...session, authorized_at: "2026-10-18T09:05:00.000Z" }, authority_epoch: 0 }))).toEqual(NONE);
    expect(receiptAuthority(web, JSON.stringify({ kind: "web-verified", actor, session, authority_epoch: 0 }))).toEqual(NONE);
  });
  it("web-verified stored on a platform row reads as none", () => {
    expect(receiptAuthority({ platform: "telegram", adapter_id: "owner", user_id: "7" }, JSON.stringify(web1))).toEqual(NONE);
  });
});

describe("admission writes it, and the event log records each verified web message (§7) without text or session id", () => {
  it("through the real FleetManager admission: the receipt says web-verified; one web_authority event names the handle", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1939-fm-")); rigs.push({ dir });
    const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "m");
    const insert = vi.fn();
    const fm: any = Object.assign(Object.create(FleetManager.prototype), { managerBootId: "m", deliveryOutbox: outbox, eventLog: { insert }, logger: { warn: vi.fn() } });
    const web1: HumanAuthority = { kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" },
      session: { handle: "a1b2c3d4e5f60718", peer: "loopback", signed_in_at: "2026-10-18T09:00:00.000Z", authorized_at: "2026-10-18T09:05:00.000Z" }, authority_epoch: 0 };
    const out = fm.humanReceiptPayload("general", { type: "fleet_inbound", content: "secret plan", meta: {} }, webHumanOrigin(false, web1), "secret plan");
    expect(insert).toHaveBeenCalledTimes(1);
    const [instance, type, payload] = insert.mock.calls[0]!;
    expect([instance, type]).toEqual(["general", "web_authority"]);
    expect(payload).toEqual({ receipt_id: out.meta.human_receipt_id, session: "a1b2c3d4e5f60718", peer: "loopback", surface: "local",
      actor: "owner:admin", input_kind: "fleet_inbound", outcome: "web-verified", authority_epoch: 0 });
    expect(JSON.stringify(payload)).not.toContain("secret");
    // none and platform: no event.
    fm.humanReceiptPayload("general", { type: "fleet_inbound", content: "x", meta: {} }, webHumanOrigin(false, NONE), "x");
    fm.humanReceiptPayload("general", { type: "fleet_inbound", content: "x", meta: {} }, nativeHumanOrigin("telegram", "owner", "7", "bo", false, "1"), "x");
    expect(insert).toHaveBeenCalledTimes(1);
    outbox.close();
  });
  it("an event log that throws never stops the message", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1939-fm-")); rigs.push({ dir });
    const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "m");
    const warn = vi.fn();
    const fm: any = Object.assign(Object.create(FleetManager.prototype), { managerBootId: "m", deliveryOutbox: outbox, eventLog: { insert: () => { throw new Error("locked"); } }, logger: { warn } });
    const web1: HumanAuthority = { kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" },
      session: { handle: "h", peer: "lan", signed_in_at: "2026-10-18T09:00:00.000Z", authorized_at: "2026-10-18T09:05:00.000Z" }, authority_epoch: 0 };
    expect(fm.humanReceiptPayload("general", { type: "fleet_inbound", content: "x", meta: {} }, webHumanOrigin(false, web1), "x").meta.verification_id).toMatch(/^hmsg-/);
    expect(warn).toHaveBeenCalled();
    outbox.close();
  });
});
