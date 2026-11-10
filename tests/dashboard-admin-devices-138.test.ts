/**
 * AGEND-138 (#3486): on a fleet with a chat connection, the devices rule ("an admin signs out their own devices and any guest's or
 * read-only one, not another admin's") must tell two admins apart when BOTH signed in with the real `/dashboard` → DM code. That
 * code is issued to the admin who asked (recipient → the session's owner), so each session is its admin's own: A cannot sign out
 * B (403 other_admin, B lives) and the other way round, while A's own second browser signs out. `issueDashboardLogin(recipient)`
 * (the code helper the host's menu uses) binds the same way; without a recipient the session is the host's (no chat account), which
 * only another host sign-in may end.
 * The real /dashboard menu, DM, /auth/login and /ui/devices/signout routes; a real FleetManager with no fleet; nothing spawns.
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
import { FleetManager } from "../src/fleet-manager.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { handleAuthRequest, type AuthApiContext } from "../src/auth-api.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { formatHumanInboundMessage, webHumanOrigin } from "../src/human-delivery-receipts.js";
import { setLocale } from "../src/locale.js";
import { WebPrefsStore } from "../src/web-prefs.js";
import { pollResultsText } from "../src/reply-polls.js";
import { WEB_NAME_FALLBACK, graphemeCount, safeWebName, validateWebName, webNameInUse, webPersonKey } from "../src/web-profile.js";

const LOCAL_HOST = "127.0.0.1:19280", LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
const PUBLIC_HOST = "sample.trycloudflare.com", PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
const ch = (cp: number) => String.fromCodePoint(cp);

let mono = 0;
const rigs: Array<{ dir: string; fm: FleetManager; s: any }> = [];
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

/** A real FleetManager with no fleet: one Telegram bot "owner", General "T0", admins "admin" and "admin2". Nothing spawns. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-returning-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: "telegram", sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "safe" })),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "menu" })),
    sendDirect: vi.fn(async (user: string, _text: string, _opts?: any) => ({ chatId: user, messageId: "dm" })),
    editMessageRemoveButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin", "admin2"] } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], health_port: 19280, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false };
  writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
  const manager = { start: vi.fn(async (_p: unknown, ctx: any) => { ctx.onCandidateHost(PUBLIC_HOST); return { ok: true as const, handle: { pageUrl: `${PUBLIC_ORIGIN}/signin`, onUnexpectedExit: () => () => {} } }; }), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager as never);
  s.tunnelPurposeLane = lane;
  s.publicWebLink = new PublicWebLink({ dataDir: dir, web: () => fm.fleetConfig!.web, permitted: o => s.publicOwnerCurrent(o), reserve: id => lane.reserve("dashboard", id),
    createGateway: () => ({ listen: async () => new URL("http://127.0.0.1:12345"), setHost: () => {}, close: () => {}, readinessMarker: "stub" }) as never,
    ensure: async () => ({ path: "/pinned", source: "agend" }), provider: () => ({}) as never,
    revoke: id => { s.webLoginCodes.revokeAudience(id); s.webSessions.revokeExposure(id); }, log: () => {}, now: () => mono });

  /** The real /dashboard menu, then a click on "local" or "public": returns the code the owner got by DM. */
  async function dashboardCode(action: "local" | "public" = "local", user = "admin"): Promise<string> {
    adapter.notifyAlert.mockClear();
    await s.topicCommands.handleGeneralCommand({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: user, username: user, text: "/dashboard", messageId: "in", timestamp: new Date() });
    const e = [...s.pendingNonceButtons.values()].find((x: any) => x.chatId === "G" && !x.consumed) as any;
    const before = adapter.sendDirect.mock.calls.length;
    await s.dispatchAdapterCallback({ callbackData: `dashboard:${e.nonce}:${action}`, chatId: e.chatId, threadId: e.threadId, messageId: e.messageId, userId: user, ack: vi.fn() }, "owner", adapter);
    await flush();
    const dm = adapter.sendDirect.mock.calls.slice(before).map(c => String(c[1])).find(text => CODE.test(text));
    if (!dm) throw new Error("no code by DM");
    return CODE.exec(dm)![0];
  }

  /** One request through the real auth handler, with this FleetManager as its context (as dispatchWebHttp does). */
  async function call(path: string, method: string, opts: { cookie?: string; body?: unknown; gateway?: string; current?: () => boolean; origin?: string | null; ua?: string } = {}) {
    const host = opts.gateway ? PUBLIC_HOST : LOCAL_HOST;
    const origin = opts.origin === null ? undefined : opts.origin ?? (opts.gateway ? PUBLIC_ORIGIN : LOCAL_ORIGIN);
    const headers: Record<string, string> = { host, "user-agent": opts.ua ?? UA, ...(origin ? { origin } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(method === "POST" ? { "content-type": "application/json" } : {}) };
    const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn() });
    if (opts.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: opts.gateway, expectedOrigin: PUBLIC_ORIGIN, isCurrent: opts.current ?? (() => true) });
    let status = 0, body = ""; const out: Record<string, any> = {};
    const res = { destroyed: false, headersSent: false, setHeader: (k: string, v: any) => { out[k] = v; }, writeHead: (code: number, h = {}) => { status = code; Object.assign(out, h); }, end: (text = "") => { body = text; }, destroy: vi.fn() };
    const handled = handleAuthRequest(req as never, res as never, new URL(path, opts.gateway ? PUBLIC_ORIGIN : LOCAL_ORIGIN), fm as unknown as AuthApiContext);
    expect(handled).toBe(true);
    if (method === "POST") { req.emit("data", Buffer.from(JSON.stringify(opts.body ?? {}))); req.emit("end"); }
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
    const cookies = ([] as string[]).concat(out["Set-Cookie"] ?? []);
    return { status, body, out, cookies, json: () => JSON.parse(body) };
  }

  /** Sign in with `code`; the device cookie the response set ("name=value"), or undefined. */
  async function signIn(code: string, gateway?: string): Promise<{ status: number; device?: string; cookies: string[] }> {
    const r = await call("/auth/login", "POST", { body: { code }, gateway });
    const set = r.cookies.find(c => /^(__Host-)?agend_device_[0-9a-f]{16}=/.test(c));
    return { status: r.status, device: set?.split(";")[0], cookies: r.cookies };
  }

  /** A returning device: signed in once with a /dashboard code. */
  async function returning(): Promise<string> {
    const r = await signIn(await dashboardCode("local"));
    expect(r.status).toBe(200);
    return r.device!;
  }

  const h = { dir, fm, s, adapter, owner, manager, dashboardCode, call, signIn, returning }; rigs.push(h); return h;
}


beforeEach(() => { setLocale("en"); vi.useFakeTimers(); mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const h of rigs.splice(0)) {
    try { h.s.replyButtonsCtl?.stop(); h.s.replyButtonsStore?.close(); } catch { /* none */ }
    rmSync(h.dir, { recursive: true, force: true });
  }
});

type Rig = ReturnType<typeof rig>;
type Who = { cookie?: string; sessionId?: string; token?: string; gateway?: string };

/** Sign in with a fresh /dashboard code DMed to `user` (its username is its platform name). */
async function signInAs(h: Rig, user = "admin"): Promise<Who> {
  const code = await h.dashboardCode("local", user);
  const r = await h.call("/auth/login", "POST", { body: { code } });
  expect(r.status).toBe(200);
  const c = r.cookies.find((x: string) => /^(__Host-)?agend_session_[0-9a-f]{16}=/.test(x))!.split(";")[0]!;
  return { cookie: c, sessionId: c.split("=")[1]! };
}

/** One request through the real web routes, as a page of that session (cookie, same origin, CSRF) or the CLI token. */
async function web(h: Rig, path: string, method: string, who: Who, body?: unknown) {
  const origin = who.gateway ? PUBLIC_ORIGIN : LOCAL_ORIGIN, host = who.gateway ? PUBLIC_HOST : LOCAL_HOST;
  const headers: Record<string, string> = { host, origin, "user-agent": UA, ...(who.cookie ? { cookie: who.cookie } : {}),
    ...(who.sessionId ? { "x-agend-csrf": csrfTokenFor(who.sessionId) } : {}), ...(who.token ? { "x-agend-token": who.token } : {}),
    ...(method === "POST" ? { "content-type": "application/json" } : {}) };
  const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn(), socket: { destroy() {}, remoteAddress: "127.0.0.1" } });
  if (who.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: who.gateway, expectedOrigin: PUBLIC_ORIGIN, isCurrent: () => true });
  let status = 0, text = "";
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { text = t; }, write() { return true; }, destroy: vi.fn() });
  expect(handleWebRequest(req as never, res as never, new URL(path, origin), h.fm as never)).toBe(true);
  if (method === "POST") { req.emit("data", Buffer.from(JSON.stringify(body ?? {}))); req.emit("end"); }
  for (let n = 0; n < 6; n++) { await flush(); await vi.advanceTimersByTimeAsync(0); }
  return { status, json: () => (text ? JSON.parse(text) : null) };
}

const sessionOf = (h: Rig, w: Who) => h.s.webSessions.authenticate(w.sessionId, tokenEpoch("c".repeat(48)), { touch: false });
const alive = async (h: Rig, w: Who) => (await h.call("/auth/session", "GET", { cookie: w.cookie })).status === 200;

describe("AGEND-138 (#3486): two admins who signed in with /dashboard are two principals", () => {
  it("each session is its admin's own (owner = who asked), so A cannot sign B out and B cannot sign A out; A's own second browser signs out", async () => {
    const h = rig();
    const a = await signInAs(h, "admin"), a2 = await signInAs(h, "admin"), b = await signInAs(h, "admin2");
    expect([sessionOf(h, a).owner, sessionOf(h, a2).owner, sessionOf(h, b).owner]).toEqual([
      { adapterId: "owner", userId: "admin" }, { adapterId: "owner", userId: "admin" }, { adapterId: "owner", userId: "admin2" }]);
    const refused = await web(h, "/ui/devices/signout", "POST", a, { handle: sessionOf(h, b).handle });
    expect([refused.status, refused.json()]).toEqual([403, { error: "other_admin" }]);
    expect(await alive(h, b)).toBe(true);
    const back = await web(h, "/ui/devices/signout", "POST", b, { handle: sessionOf(h, a).handle });
    expect([back.status, back.json()]).toEqual([403, { error: "other_admin" }]);
    expect(await alive(h, a)).toBe(true);
    const own = await web(h, "/ui/devices/signout", "POST", a, { handle: sessionOf(h, a2).handle });
    expect([own.status, own.json()]).toEqual([200, { ok: true }]);
    expect(await alive(h, a2)).toBe(false);
    // The list says the same, per row.
    const rows = (await web(h, "/ui/devices", "GET", a)).json().devices as Array<{ handle: string; canSignOut: boolean; signOutBlocked?: string }>;
    expect(rows.find(r => r.handle === sessionOf(h, b).handle)).toMatchObject({ canSignOut: false, signOutBlocked: "other_admin" });
  });

  it("issueDashboardLogin(recipient) binds the same way: a code for admin X makes X's session; with none the session has no account (the host's)", async () => {
    const h = rig();
    const issue = async (recipient?: { adapterId: string; userId: string }) => {
      const code = h.s.issueDashboardLogin(recipient)!.display;
      const r = await h.call("/auth/login", "POST", { body: { code } });
      expect(r.status).toBe(200);
      const c = r.cookies.find((x: string) => /^(__Host-)?agend_session_[0-9a-f]{16}=/.test(x))!.split(";")[0]!;
      return { cookie: c, sessionId: c.split("=")[1]! } as Who;
    };
    const x = await issue({ adapterId: "owner", userId: "admin" }), y = await issue({ adapterId: "owner", userId: "admin2" }), host = await issue();
    expect([sessionOf(h, x).owner, sessionOf(h, y).owner, sessionOf(h, host).owner]).toEqual([{ adapterId: "owner", userId: "admin" }, { adapterId: "owner", userId: "admin2" }, undefined]);
    expect((await web(h, "/ui/devices/signout", "POST", x, { handle: sessionOf(h, y).handle })).json()).toEqual({ error: "other_admin" });
    // A session with no account is the host's: no chat admin ends it, and it ends no chat admin's.
    expect((await web(h, "/ui/devices/signout", "POST", x, { handle: sessionOf(h, host).handle })).json()).toEqual({ error: "other_admin" });
    expect((await web(h, "/ui/devices/signout", "POST", host, { handle: sessionOf(h, x).handle })).json()).toEqual({ error: "other_admin" });
    expect(await alive(h, x)).toBe(true);
    expect(await alive(h, host)).toBe(true);
  });
});
