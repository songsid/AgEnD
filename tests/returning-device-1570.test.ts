/**
 * #1570: "Send me a new code" on the sign-in page. One block per mitigation of the design baseline
 * (#1570 issuecomment-6098782305); each names the line whose removal turns it red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { rotateWebToken } from "../src/web-auth.js";
import { LOGIN_BREAKER_THRESHOLD } from "../src/web-login.js";
import { tokenEpoch } from "../src/web-session.js";
import { CodeRequestLimiter, CODE_REQUEST_LIMITS, ReturningDevices, readDeviceCookie, buildDeviceCookie } from "../src/web-returning-device.js";
import { setLocale } from "../src/locale.js";

const LOCAL_HOST = "127.0.0.1:19280", LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
const PUBLIC_HOST = "sample.trycloudflare.com", PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
const DEVICE_VALUE = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;

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
    const set = r.cookies.find(c => /^(__Host-)?agend_device=/.test(c));
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
afterEach(async () => {
  for (const h of rigs.splice(0)) { await h.s.publicWebLink.close("test end"); for (const e of h.s.pendingNonceButtons.values()) clearTimeout(e.timer); h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown(); rmSync(h.dir, { recursive: true, force: true }); }
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("① only a browser that signed in before with a /dashboard code is a returning device", () => {
  it("a /dashboard code sets an httpOnly device cookie beside the session; a code with no owner (agend web --code) does not", async () => {
    const h = rig();
    const first = await h.signIn(await h.dashboardCode("local"));
    expect(first.status).toBe(200);
    const set = first.cookies.find(c => c.startsWith("agend_device="))!;
    expect(set).toMatch(/; HttpOnly/); expect(set).toMatch(/; SameSite=Strict/); expect(set).toMatch(/; Path=\//);
    expect(first.cookies.some(c => c.startsWith("agend_session="))).toBe(true);

    const cli = await h.signIn(h.fm.issueDashboardLogin()!.display);
    expect(cli.status).toBe(200);
    expect(cli.device).toBeUndefined();
  });

  it("the cookie names no chat or user: a random id and a signature; the registry on disk keeps only the id's hash", async () => {
    const h = rig();
    const cookie = await h.returning();
    const value = cookie.split("=")[1]!;
    expect(value).toMatch(DEVICE_VALUE);
    for (const id of ["admin", "owner", "G", "T0"]) expect(value).not.toContain(id);
    const disk = readFileSync(join(h.dir, "web-devices.json"), "utf8");
    expect(disk).not.toContain(value.split(".")[0]);      // the id itself never reaches disk
    expect(disk).not.toContain(value.split(".")[1]);
    expect(JSON.parse(disk).devices[0].owner).toEqual({ adapterId: "owner", userId: "admin", chatId: "G", threadId: "T0" });
  });

  it("without a device cookie: GET /auth/device says no, and POST /auth/request-code is refused without sending anything", async () => {
    const h = rig();
    const none = await h.call("/auth/device", "GET");
    expect(none.status).toBe(200); expect(none.json()).toEqual({ returning: false }); expect(none.out["Cache-Control"]).toBe("no-store");
    const ask = await h.call("/auth/request-code", "POST");
    expect(ask.status).toBe(401);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);

    const cookie = await h.returning();
    expect((await h.call("/auth/device", "GET", { cookie })).json()).toEqual({ returning: true });
  });

  it("a forged, re-signed or truncated cookie is not a returning device; the plain cookie is ignored on the public link", async () => {
    const h = rig();
    const cookie = await h.returning();
    const [id, sig] = cookie.split("=")[1]!.split(".");
    const flip = (c: string) => (c === "0" ? "1" : "0");
    for (const bad of [`agend_device=${id}.${flip(sig![0]!)}${sig!.slice(1)}`, `agend_device=${flip(id![0]!)}${id!.slice(1)}.${sig}`, `agend_device=${id}`, `agend_device=${id}.`]) {
      expect((await h.call("/auth/device", "GET", { cookie: bad })).json(), bad).toEqual({ returning: false });
    }
    expect(readDeviceCookie(cookie, true)).toBeUndefined();
    expect(readDeviceCookie(cookie, false)).toBe(cookie.split("=")[1]);
    expect(readDeviceCookie(`__Host-${cookie}`, true)).toBe(cookie.split("=")[1]);
  });

  it("a cross-site or non-JSON request for a code is refused before anything happens", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockClear();
    expect((await h.call("/auth/request-code", "POST", { cookie, origin: "http://evil.example" })).status).toBe(403);
    expect((await h.call("/auth/request-code", "POST", { cookie, origin: null })).status).toBe(403);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
  });
});

describe("② the code goes privately to the recorded owner only, and only while they are a fleet admin", () => {
  it("a returning device gets a fresh code by DM to the person who received the earlier one — never into the group", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockClear(); h.adapter.sendText.mockClear();
    const ask = await h.call("/auth/request-code", "POST", { cookie });
    expect(ask.status).toBe(202);
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(1);
    const [to, text, opts] = h.adapter.sendDirect.mock.calls[0]!;
    expect(to).toBe("admin");
    expect(text).toMatch(CODE);
    expect(opts).toEqual({ disablePreview: true });
    expect(h.adapter.sendText.mock.calls.flat().join(" ")).not.toMatch(CODE);
    // The code works, and it carries its owner again (so this browser stays a returning device).
    const again = await h.signIn(CODE.exec(String(text))![0]);
    expect(again.status).toBe(200); expect(again.device).toMatch(/^agend_device=/);
  });

  it("an owner who is no longer a fleet admin gets nothing, and no code is outstanding", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockClear();
    h.owner.access.allowed_users = ["admin2"];
    const ask = await h.call("/auth/request-code", "POST", { cookie });
    expect(ask.status).toBe(503);
    expect(ask.json().error).toMatch(/\/dashboard/);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
  });

  it("a bot that is no longer live, or a General that is no longer configured, gets nothing", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockClear();
    const general = (h.fm.fleetConfig as any).instances.general;
    delete (h.fm.fleetConfig as any).instances.general;
    expect((await h.call("/auth/request-code", "POST", { cookie })).status).toBe(503);
    (h.fm.fleetConfig as any).instances.general = general;
    const live = h.s.adapters.get("owner"); h.s.adapters.delete("owner");
    mono += CODE_REQUEST_LIMITS.deviceGapMs;
    expect((await h.call("/auth/request-code", "POST", { cookie })).status).toBe(503);
    h.s.adapters.set("owner", live);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
  });

  it("an owner removed while the DM is in flight: the code it carried is withdrawn", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockImplementationOnce(async (user: string) => { h.owner.access.allowed_users = ["admin2"]; return { chatId: user, messageId: "dm" }; });
    expect((await h.call("/auth/request-code", "POST", { cookie })).status).toBe(503);
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
  });

  it("a DM that cannot be sent withdraws the code it would have carried", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockRejectedValueOnce(Object.assign(new Error("Forbidden: bot was blocked by the user"), { code: 403 }));
    const ask = await h.call("/auth/request-code", "POST", { cookie });
    expect(ask.status).toBe(503);
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
    expect(h.adapter.sendText.mock.calls.flat().join(" ")).not.toMatch(CODE);
  });
});

describe("③ rate limits per device and for the whole fleet, plus the existing breaker", () => {
  it("per device: one a minute, five an hour — answered 429 with Retry-After and nothing sent", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockClear();
    expect((await h.call("/auth/request-code", "POST", { cookie })).status).toBe(202);
    mono += 30_000;
    const soon = await h.call("/auth/request-code", "POST", { cookie });
    expect(soon.status).toBe(429); expect(soon.out["Retry-After"]).toBe("30");
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(1);
    for (let n = 2; n <= CODE_REQUEST_LIMITS.devicePerHour; n++) { mono += 60_000; expect((await h.call("/auth/request-code", "POST", { cookie })).status, `#${n}`).toBe(202); }
    mono += 60_000;
    expect((await h.call("/auth/request-code", "POST", { cookie })).status).toBe(429);
    expect(h.adapter.sendDirect).toHaveBeenCalledTimes(CODE_REQUEST_LIMITS.devicePerHour);
  });

  it("for the whole fleet: a second device inside 20 s waits", async () => {
    const h = rig();
    const a = await h.returning(), b = await h.returning();
    expect(a).not.toBe(b);
    expect((await h.call("/auth/request-code", "POST", { cookie: a })).status).toBe(202);
    mono += 5_000;
    const second = await h.call("/auth/request-code", "POST", { cookie: b });
    expect(second.status).toBe(429); expect(second.out["Retry-After"]).toBe("15");
    mono += 15_000;
    expect((await h.call("/auth/request-code", "POST", { cookie: b })).status).toBe(202);
  });

  it("the limiter counts on the monotonic clock: a wall-clock jump neither opens nor closes it", () => {
    let now = 0;
    const limiter = new CodeRequestLimiter(() => now);
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    expect(limiter.admit("d").ok).toBe(true);
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));       // a day forward on the wall clock
    expect(limiter.admit("d").ok).toBe(false);
    now = CODE_REQUEST_LIMITS.deviceGapMs;
    expect(limiter.admit("d").ok).toBe(true);
    // Global: twenty an hour across devices, at the 20 s pace.
    const g = new CodeRequestLimiter(() => now);
    for (let n = 0; n < CODE_REQUEST_LIMITS.globalPerHour; n++) { expect(g.admit(`d${n}`).ok, `#${n}`).toBe(true); now += CODE_REQUEST_LIMITS.globalGapMs; }
    const over = g.admit("fresh");
    expect(over.ok).toBe(false);
  });

  it("while the wrong-code breaker is open, no code is sent", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockClear();
    // Wrong guesses only count against a live code (five kill one): keep one outstanding until the breaker opens.
    for (let n = 0; n < LOGIN_BREAKER_THRESHOLD; n++) {
      if (!h.s.webLoginCodes.hasOutstandingCode) h.fm.issueDashboardLogin();
      await h.call("/auth/login", "POST", { body: { code: "ZZZZ-ZZZZ" } });
    }
    expect(h.s.webLoginCodes.pausedForMs()).toBeGreaterThan(0);
    const ask = await h.call("/auth/request-code", "POST", { cookie });
    expect(ask.status).toBe(429);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
  });
});

describe("④ the DM says who asked and how to stop it", () => {
  it("names the browser and the surface, and suggests /dashboard revoke", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.adapter.sendDirect.mockClear();
    await h.call("/auth/request-code", "POST", { cookie });
    const text = String(h.adapter.sendDirect.mock.calls[0]![1]);
    expect(text).toContain("Chrome on macOS");
    expect(text).toContain("local network");
    expect(text).toContain("/dashboard revoke");
  });
});

describe("⑤ /dashboard revoke and token rotation end every device", () => {
  it("revoke: the device is gone now and after a restart", async () => {
    const h = rig();
    const cookie = await h.returning();
    h.fm.revokeWebSessions();
    expect((await h.call("/auth/device", "GET", { cookie })).json()).toEqual({ returning: false });
    expect((await h.call("/auth/request-code", "POST", { cookie })).status).toBe(401);
    const fresh = new ReturningDevices({ dataDir: h.dir });
    expect(fresh.verify(cookie.split("=")[1], "c".repeat(48), tokenEpoch("c".repeat(48)))).toBeNull();
    expect(fresh.size).toBe(0);
  });

  it("rotation (even from another process): the device cookie stops verifying", async () => {
    const h = rig();
    const cookie = await h.returning();
    rotateWebToken(h.dir);
    expect((await h.call("/auth/device", "GET", { cookie })).json()).toEqual({ returning: false });
    expect((await h.call("/auth/request-code", "POST", { cookie })).status).toBe(401);
  });

  it("each half of the binding holds alone: a re-signed cookie under a new token still fails on the recorded epoch", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-returning-unit-"));
    try {
      const devices = new ReturningDevices({ dataDir: dir });
      const owner = { adapterId: "owner", userId: "admin", chatId: "G", threadId: "T0" };
      const oldToken = "c".repeat(48), newToken = "d".repeat(48);
      const value = devices.remember(owner, { surface: "local", label: "x", tokenEpoch: tokenEpoch(oldToken), webToken: oldToken });
      expect(devices.verify(value, oldToken, tokenEpoch(oldToken))).not.toBeNull();
      expect(devices.verify(value, newToken, tokenEpoch(oldToken))).toBeNull();    // signature
      expect(devices.verify(value, oldToken, tokenEpoch(newToken))).toBeNull();    // epoch
      expect(new ReturningDevices({ dataDir: dir }).verify(value, oldToken, tokenEpoch(oldToken))).not.toBeNull();   // survives a restart
      expect(existsSync(join(dir, "web-devices.json"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the device cookie expires: Max-Age on the cookie, the same expiry on the server", () => {
    let now = 1_000;
    const devices = new ReturningDevices({ now: () => now });
    const token = "c".repeat(48);
    const value = devices.remember({ adapterId: "owner", userId: "admin", chatId: "G" }, { surface: "local", label: "x", tokenEpoch: tokenEpoch(token), webToken: token });
    expect(buildDeviceCookie(value, false)).toMatch(/; Max-Age=7776000/);
    now += 90 * 24 * 60 * 60 * 1000;
    expect(devices.verify(value, token, tokenEpoch(token))).toBeNull();
  });
});

describe("⑥ the public link: only the open, current exposure; the sign-in still goes through confirmPublicWebLogin", () => {
  async function publicDevice(h: ReturnType<typeof rig>) {
    const code = await h.dashboardCode("public");
    const exposure = h.s.publicWebLink.exposureId as string;
    expect(h.s.publicWebLink.status().state).toBe("open");
    const confirm = vi.spyOn(h.fm, "confirmPublicWebLogin");
    const first = await h.signIn(code, exposure);
    expect(first.status).toBe(200);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(first.device).toMatch(/^__Host-agend_device=/);
    expect(first.cookies.find(c => c.startsWith("__Host-agend_device="))).toMatch(/; Secure/);
    return { exposure, cookie: first.device!, confirm };
  }

  it("a public returning device gets a code for that exposure, and redeeming it posts the public sign-in notice again", async () => {
    const h = rig();
    const { exposure, cookie, confirm } = await publicDevice(h);
    h.adapter.sendDirect.mockClear(); h.adapter.sendText.mockClear();
    const ask = await h.call("/auth/request-code", "POST", { cookie, gateway: exposure });
    expect(ask.status).toBe(202);
    const text = String(h.adapter.sendDirect.mock.calls[0]![1]);
    expect(text).toContain("public link");
    const code = CODE.exec(text)![0];
    // The code's audience is this exposure: it does not sign in locally.
    expect((await h.signIn(code)).status).toBe(401);
    mono += CODE_REQUEST_LIMITS.deviceGapMs;
    await h.call("/auth/request-code", "POST", { cookie, gateway: exposure });
    const next = CODE.exec(String(h.adapter.sendDirect.mock.calls.at(-1)![1]))![0];
    const redeemed = await h.signIn(next, exposure);
    expect(redeemed.status).toBe(200);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]![0].owner).toMatchObject({ adapterId: "owner", userId: "admin", chatId: "G", threadId: "T0" });
    expect(h.adapter.sendText.mock.calls.some(c => c[0] === "G" && /web sign-in/i.test(String(c[1])))).toBe(true);
  });

  it("a request for another exposure, a link that is not open, or a request that is no longer current gets nothing", async () => {
    const h = rig();
    const { exposure, cookie } = await publicDevice(h);
    h.adapter.sendDirect.mockClear();
    expect((await h.call("/auth/request-code", "POST", { cookie, gateway: "b".repeat(32) })).status).toBe(503);
    mono += CODE_REQUEST_LIMITS.deviceGapMs;
    expect((await h.call("/auth/request-code", "POST", { cookie, gateway: exposure, current: () => false })).status).toBe(403);
    await h.s.publicWebLink.close("test");
    mono += CODE_REQUEST_LIMITS.deviceGapMs;
    expect((await h.call("/auth/request-code", "POST", { cookie, gateway: exposure })).status).toBe(503);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.s.webLoginCodes.hasOutstandingCode).toBe(false);
  });

  it("an exposure that is still starting (or closing) gets nothing; once open it does", async () => {
    const h = rig();
    const { exposure, cookie } = await publicDevice(h);
    h.adapter.sendDirect.mockClear();
    h.s.publicWebLink.entry.phase = "starting";
    expect((await h.call("/auth/request-code", "POST", { cookie, gateway: exposure })).status).toBe(503);
    h.s.publicWebLink.entry.phase = "open";
    mono += CODE_REQUEST_LIMITS.deviceGapMs;
    expect((await h.call("/auth/request-code", "POST", { cookie, gateway: exposure })).status).toBe(202);
  });

  it("a request that stops being current while its body is read gets nothing", async () => {
    const h = rig();
    const { exposure, cookie } = await publicDevice(h);
    h.adapter.sendDirect.mockClear();
    let checks = 0;
    const once = () => ++checks === 1;      // current at the door, not after the body
    expect((await h.call("/auth/request-code", "POST", { cookie, gateway: exposure, current: once })).status).toBe(503);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
  });

  it("the gateway lets exactly the two new routes through", () => {
    expect(isPublicWebRoute("GET", "/auth/device")).toBe(true);
    expect(isPublicWebRoute("POST", "/auth/request-code")).toBe(true);
    expect(isPublicWebRoute("POST", "/auth/device")).toBe(false);
    expect(isPublicWebRoute("GET", "/auth/request-code")).toBe(false);
    expect(isPublicWebRoute("POST", "/auth/issue-code")).toBe(false);
  });
});

describe("the sign-in page offers the button only to a returning device", () => {
  async function page(returning: boolean, answer = 202) {
    const vm = await import("node:vm");
    vi.useRealTimers();
    const calls: Array<{ url: string; init?: any }> = [];
    const handlers: Record<string, () => Promise<void>> = {};
    const el = (id: string) => ({ id, hidden: id === "resend" || id === "form", textContent: "", value: "", disabled: false, classList: { set: new Set<string>(), add(c: string) { this.set.add(c); }, remove(c: string) { this.set.delete(c); } },
      addEventListener(type: string, fn: () => Promise<void>) { handlers[`${id}:${type}`] = fn; }, focus() {}, select() {} });
    const elements: Record<string, ReturnType<typeof el>> = {};
    const context = vm.createContext({
      document: { documentElement: {}, getElementById: (id: string) => (elements[id] ??= el(id)), querySelectorAll: () => [] },
      location: { href: "http://127.0.0.1:1/signin", pathname: "/signin", search: "", hash: "", origin: "http://127.0.0.1:1", replace() {} },
      history: { replaceState() {} }, navigator: { language: "en" }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: async (url: string, init?: any) => {
        calls.push({ url, init });
        if (url === "/auth/session") return { ok: false, status: 401 };
        if (url === "/auth/device") return { ok: true, status: 200, json: async () => ({ returning }) };
        return { ok: answer < 300, status: answer };
      },
      URL, URLSearchParams, JSON, Date, Number, String,
    });
    vm.runInContext(readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8"), context);
    for (let n = 0; n < 50; n++) await new Promise(r => setImmediate(r));
    const $ = (id: string) => elements[id] ??= el(id);
    return { calls, $, click: async () => { await handlers["resend:click"]!(); } };
  }

  it("not a returning device: no button, and nothing is asked for", async () => {
    const p = await page(false);
    expect(p.$("form").hidden).toBe(false);
    expect(p.$("resend").hidden).toBe(true);
    expect(p.calls.map(c => c.url)).toEqual(["/auth/session", "/auth/device"]);
  });

  it("a returning device: the button posts JSON to /auth/request-code and says where the code went", async () => {
    const p = await page(true);
    expect(p.$("resend").hidden).toBe(false);
    await p.click();
    const post = p.calls.find(c => c.url === "/auth/request-code")!;
    expect(post.init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" } });
    expect(p.$("msg").textContent).toMatch(/privately/);
    expect(p.$("msg").classList.set.has("ok")).toBe(true);
  });

  it("a refusal says to use /dashboard; a 401 also hides the button; 429 asks to wait", async () => {
    const refused = await page(true, 401);
    await refused.click();
    expect(refused.$("msg").textContent).toMatch(/\/dashboard/);
    expect(refused.$("resend").hidden).toBe(true);
    const limited = await page(true, 429);
    await limited.click();
    expect(limited.$("msg").textContent).toMatch(/wait/);
    expect(limited.$("resend").hidden).toBe(false);
  });
});
