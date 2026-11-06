/**
 * #2910 D1: on a web-only fleet (no Discord or Telegram connection) the host operator is a principal — a session signed
 * in with the host's own code (`agend web --code`: the web token in a header, i.e. shell access to this computer), used
 * from this computer, is web-verified with actor host/operator for its life (capped as every authorization). It confirms
 * its own Settings changes. Never over the public link, never from another machine; a fleet with a chat connection keeps
 * today's rule (the operator's session is not an account: no_account); a code sent by chat (/dashboard) is never the host's.
 * The rule itself (evaluateWebAuthority), the flags that carry "the host's own code" (web-login → web-session), and a
 * real fleet's sign-in over HTTP.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { evaluateWebAuthority, HOST_OPERATOR, webAuthorityPolicy, type WebAuthorityInput } from "../src/authority/web-authority.js";
import { WebLoginCodes } from "../src/web-login.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

// ── The rule ──
const EPOCH_HASH = "a".repeat(64), NOW = 1_800_000_000_000;
const hostSession = (over: Partial<SessionRecord> = {}): SessionRecord => ({ handle: "0123456789abcdef", idHash: "b".repeat(64), created: NOW - 1000, lastSeen: NOW,
  absoluteExpiry: NOW + 3_600_000, idleExpiry: NOW + 3_600_000, tier: "admin", surface: "local", label: "Chrome", tokenEpoch: EPOCH_HASH, host: true, ...over } as SessionRecord);
function judge(over: Partial<WebAuthorityInput> = {}) {
  const isAdmin = vi.fn(() => true);
  const session = (over.session === undefined ? hostSession() : over.session) as SessionRecord | null;
  const r = evaluateWebAuthority({
    session, gateway: false, peer: "loopback", tokenEpoch: EPOCH_HASH, isAdmin,
    authorization: session ? { handle: session.handle, owner: HOST_OPERATOR, authorizedAt: NOW - 500, until: NOW + 3_600_000, epoch: 3 } : null,
    policy: webAuthorityPolicy(undefined), epoch: 3, now: NOW, hostOperator: true, ...over,
  });
  return { ...r, isAdmin };
}

describe("#2910 D1 the rule: a web-only fleet's host session on this computer is the host operator", () => {
  it("web-verified, actor host/operator, its session and peer recorded; no adapter asked (there is none); a target instance is no other namespace", () => {
    const r = judge({ target: { adapterId: undefined } });
    expect([r.refusal, r.authority.kind, r.authority.actor, r.authority.session?.peer, r.authority.session?.handle, r.isAdmin.mock.calls.length])
      .toEqual([null, "web-verified", { adapter_id: "host", user_id: "operator" }, "loopback", "0123456789abcdef", 0]);
  });
  it.each([
    ["from another machine (lan)", { peer: "lan" as const }, "loopback_only"],
    ["over the public link (quick)", { gateway: true, peer: "quick_link" as const }, "public_link"],
    ["over the public link (named, option on)", { gateway: true, peer: "named_link" as const, policy: { ...webAuthorityPolicy({ verified_authority: { named_link: true } } as never) } }, "public_link"],
    ["a fleet with a chat connection (today's rule)", { hostOperator: false }, "no_account"],
    ["…the flag absent (a caller that does not say)", { hostOperator: undefined }, "no_account"],
    ["a token rotated since", { tokenEpoch: "c".repeat(64) }, "token_rotated"],
    ["the switch off", { policy: { ...webAuthorityPolicy({ verified_authority: { enabled: false } } as never) } }, "disabled"],
    ["no authorization (revoked, or never given)", { authorization: null }, "host_sign_in"],
    ["an authorization from an older epoch (revoked)", { epoch: 4 }, "host_sign_in"],
    ["an authorization run out", { now: NOW + 3_600_001 }, "host_sign_in"],
    ["an account's authorization on this handle", { authorization: { handle: "0123456789abcdef", owner: { adapterId: "dc", userId: "1" }, authorizedAt: NOW - 500, until: NOW + 3_600_000, epoch: 3 } }, "host_sign_in"],
  ] as const)("%s: %s", (_why, over, refusal) => {
    const r = judge(over as Partial<WebAuthorityInput>);
    expect([r.refusal, r.authority.kind, r.authority.actor]).toEqual([refusal, "none", null]);
  });
  it("a session that is not the host's: another `agend web` session or an older one — sign in again on this computer; a guest is not one", () => {
    expect(judge({ session: hostSession({ host: undefined }) }).refusal).toBe("host_sign_in");
    expect(judge({ session: hostSession({ host: undefined }), hostOperator: false }).refusal).toBe("no_account");
    expect(judge({ session: hostSession({ tier: "guest" as never }) }).refusal).toBe("not_admin_session");
  });
  it("a session with an account is that account, as before (its admin and namespace asked), host flag or not", () => {
    const owner = { adapterId: "dc", userId: "1" };
    const r = judge({ session: hostSession({ owner }), authorization: { handle: "0123456789abcdef", owner, authorizedAt: NOW - 500, until: NOW + 3_600_000, epoch: 3 } });
    expect([r.refusal, r.authority.actor, r.isAdmin.mock.calls]).toEqual([null, { adapter_id: "dc", user_id: "1" }, [["1", "dc"]]]);
  });
});

describe("#2910 D1 the flags: only the host's own code makes a host session", () => {
  it("a code issued as the host's carries it to the redeemer; one sent to an account, a guest's or another audience's never does", () => {
    const codes = new WebLoginCodes({ generate: () => "ABCDEFGH" });
    const redeem = (opts: Parameters<WebLoginCodes["issue"]>[0], audience = "local") => { codes.issue(opts); return codes.redeem("ABCD-EFGH", "e", audience); };
    expect(redeem({ epoch: "e", host: true })).toEqual({ kind: "ok", tier: "admin", host: true });
    expect(redeem({ epoch: "e" })).toEqual({ kind: "ok", tier: "admin" });
    expect((redeem({ epoch: "e", host: true, recipient: { adapterId: "dc", userId: "1" } }) as { host?: true }).host).toBeUndefined();
    expect((redeem({ epoch: "e", host: true, owner: { adapterId: "dc", userId: "1", chatId: "c" } }) as { host?: true }).host).toBeUndefined();
    expect((redeem({ epoch: "e", host: true, tier: "read" }) as { host?: true }).host).toBeUndefined();
    expect((redeem({ epoch: "e", host: true, audience: "f".repeat(32) }, "f".repeat(32)) as { host?: true }).host).toBeUndefined();
  });
  it("the session keeps it (and after a restart); never with an account, another tier or over the gateway; a file that says so otherwise is not read", () => {
    const dir = temp("agend-2910-host-sess-"), path = join(dir, "web-sessions.json");
    const store = new WebSessionStore({ dataDir: dir });
    const make = (o: object) => store.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: EPOCH_HASH, ...o }).record;
    const host = make({ host: true });
    expect([host.host, make({ host: true, owner: { adapterId: "dc", userId: "1" } }).host, make({ host: true, tier: "read" }).host,
      make({ host: true, surface: "gateway", exposureId: "e".repeat(32) }).host]).toEqual([true, undefined, undefined, undefined]);
    store.flush();
    expect(new WebSessionStore({ dataDir: dir }).findByHandle(host.handle)?.host).toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8"));
    for (const s of file.sessions) if (s.handle !== host.handle) s.host = true;          // tampered: host on a gateway / account / read session
    writeFileSync(path, JSON.stringify(file));
    const reread = new WebSessionStore({ dataDir: dir });
    expect(file.sessions.map((s: SessionRecord) => !!reread.findByHandle(s.handle))).toEqual(file.sessions.map((s: SessionRecord) => s.handle === host.handle));
  });
});

// ── A real fleet: its web server, sign-in over HTTP ──
interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } };
async function startFleet(config: Record<string, unknown> = {}) {
  const dir = temp("agend-2910-host-");
  const fm = new FleetManager(dir), any = fm as any;
  const logged: string[] = [];
  const sink = (obj: unknown, msg?: string) => { logged.push(JSON.stringify(obj) + " " + (msg ?? "")); };
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: () => {}, fatal: () => {}, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } }, ...config } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  const stop = () => new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); });
  /** `agend web --code`'s request, then the browser's sign-in (extra headers: where it signs in from). */
  const signIn = async (code?: string, extra: Record<string, string> = {}) => {
    code ??= JSON.parse((await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).body).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin, ...extra }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    const set = res.headers["set-cookie"]; const cookie = (Array.isArray(set) ? set[0] : set)!.split(";")[0]!;
    const sessionId = cookie.split("=")[1]!;
    const record = any.webSessions.authenticate(sessionId, tokenEpoch(token), { touch: false }) as SessionRecord;
    return { cookie, sessionId, record };
  };
  const status = async (cookie: string, extra: Record<string, string> = {}) => JSON.parse((await raw(port, "GET", "/ui/authorization", { cookie, ...extra })).body);
  return { fm, any, dir, port, origin, token, logged, stop, signIn, status };
}

describe("#2910 D1 a real fleet: `agend web --code`, signed in on this computer", () => {
  it("web-only: verified as this computer's admin at once — web-verified host/operator here, refused from another machine; the device list names it", async () => {
    setLocale("en");
    const h = await startFleet();
    try {
      const s = await h.signIn();
      expect([s.record.host, (await h.status(s.cookie)).state]).toEqual([true, "verified"]);
      const here = h.fm.webAuthority({ session: s.record, gateway: false, peer: "loopback", instance: "agent-1" });
      expect([here.refusal, here.authority.kind, here.authority.actor]).toEqual([null, "web-verified", { adapter_id: "host", user_id: "operator" }]);
      expect(h.fm.webAuthority({ session: s.record, gateway: false, peer: "lan" }).refusal).toBe("loopback_only");
      expect((await h.status(s.cookie, { "x-forwarded-for": "10.0.0.9" })).reason).toBe("loopback_only");
      expect(h.fm.webAuthorityOverview().authorized.map(a => [a.handle, a.account])).toEqual([[s.record.handle, "This computer's admin"]]);
    } finally { await h.stop(); }
  }, 20_000);
  it("web-only, signed in from another machine (a forwarded request): a host session, never authorized — not even when later used here", async () => {
    const h = await startFleet();
    try {
      const s = await h.signIn(undefined, { "x-forwarded-for": "10.0.0.9" });
      expect([s.record.host, h.any.sessionAuthorizationStore().list().length, (await h.status(s.cookie)).reason]).toEqual([true, 0, "host_sign_in"]);
    } finally { await h.stop(); }
  }, 20_000);
  it("web-only: a code sent by chat (/dashboard) is never the host's; asking to authorize a host session asks no one", async () => {
    const h = await startFleet();
    try {
      const s = await h.signIn(h.fm.issueDashboardLogin()!.display);
      expect([s.record.host, (await h.status(s.cookie)).reason, h.any.sessionAuthorizationStore().list().length]).toEqual([undefined, "host_sign_in", 0]);
      const ask = vi.spyOn(h.fm.sessionAuthorizationRequests(), "ask");
      const asked = await raw(h.port, "POST", "/ui/authorization", { cookie: s.cookie, origin: h.origin, "content-type": "application/json", [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId) }, "{}");
      expect([JSON.parse(asked.body).refusal, ask.mock.calls.length]).toEqual(["host_sign_in", 0]);
    } finally { await h.stop(); }
  }, 20_000);
  it("web-only: a revocation ends it (sign in again on this computer); a new sign-in is verified again", async () => {
    const h = await startFleet();
    try {
      const first = await h.signIn();
      h.fm.revokeWebAuthority();
      expect((await h.status(first.cookie)).reason).toBe("host_sign_in");
      const again = await h.signIn();
      expect([(await h.status(again.cookie)).state, (await h.status(first.cookie)).reason]).toEqual(["verified", "host_sign_in"]);
    } finally { await h.stop(); }
  }, 20_000);
  it("a fleet with a chat connection: unchanged — the operator's session is not an account (no_account), nothing authorized", async () => {
    const h = await startFleet(CHAT);
    try {
      const s = await h.signIn();
      expect([s.record.host, (await h.status(s.cookie)).reason, h.any.sessionAuthorizationStore().list().length]).toEqual([true, "no_account", 0]);
      expect(h.fm.webAuthority({ session: s.record, gateway: false, peer: "loopback" }).authority.kind).toBe("none");
    } finally { await h.stop(); }
  }, 20_000);
});

describe("#2910 D1 Settings: the host operator applies its own change", () => {
  async function held(h: Awaited<ReturnType<typeof startFleet>>) {
    const store = new SettingsConfirmationStore({ audit: vi.fn(), notify: vi.fn() }); stores.push(store);
    // Connecting a Telegram bot: a held change (one that never needs confirming would not reach the confirmation at all).
    const effect = prepareSettingsEffect("PUT", "/api/settings/fleet/channels", [{ ...CHAT.channel, id: "tg" }], { config: h.fm.fleetConfig, classic: {} });
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
      current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
    return { store, view, apply };
  }
  const reqOf = (h: Awaited<ReturnType<typeof startFleet>>, sessionId: string, extra: Record<string, string> = {}) => ({ method: "PUT", socket: { remoteAddress: "127.0.0.1" },
    headers: { host: `127.0.0.1:${h.port}`, origin: h.origin, "sec-fetch-site": "same-origin", cookie: `agend_session=${sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(sessionId), ...extra } });
  it("web-only: confirmed by applying it, labelled this computer's admin; asked again at execution (a revocation since: stale, not applied)", async () => {
    setLocale("en");
    const h = await startFleet();
    try {
      const s = await h.signIn();
      const a = await held(h);
      const self = h.any.settingsSelfConfirmation(a.store, reqOf(h, s.sessionId), a.view.id);
      expect([self?.label, self?.current()]).toEqual(["This computer's admin", true]);
      const done = await a.store.decide(a.view.id, "confirm", { ...self, via: "web" });
      expect([done.state, done.outcome?.decided_by_label, a.apply.mock.calls.length]).toEqual(["applied", "This computer's admin", 1]);
      const b = await held(h);
      const later = h.any.settingsSelfConfirmation(b.store, reqOf(h, s.sessionId), b.view.id);
      const deciding = b.store.decide(b.view.id, "confirm", { ...later, via: "web" });   // Apply: current then…
      h.fm.revokeWebAuthority();                                                          // …revoked before it executes
      const stale = await deciding;
      expect([stale.state, b.apply.mock.calls.length]).toEqual(["stale", 0]);
    } finally { await h.stop(); }
  }, 20_000);
  it("…and a channel added meanwhile ends it (no longer web-only); from another machine, over the public link, or a chat fleet: none", async () => {
    const h = await startFleet();
    try {
      const s = await h.signIn();
      const a = await held(h);
      const self = h.any.settingsSelfConfirmation(a.store, reqOf(h, s.sessionId), a.view.id);
      expect(self?.current()).toBe(true);
      Object.assign(h.fm.fleetConfig!, CHAT);
      expect(self.current()).toBe(false);
      delete (h.fm.fleetConfig as any).channel;
      expect(h.any.settingsSelfConfirmation(a.store, reqOf(h, s.sessionId, { "x-forwarded-for": "10.0.0.9" }), a.view.id)).toBeNull();
      const gw = reqOf(h, s.sessionId);
      bindGatewayRequest(gw, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://abc.trycloudflare.com", isCurrent: () => true });
      expect(h.any.settingsSelfConfirmation(a.store, gw, a.view.id)).toBeNull();
    } finally { await h.stop(); }
    const c = await startFleet(CHAT);
    try {
      const s = await c.signIn();
      const a = await held(c);
      expect(c.any.settingsSelfConfirmation(a.store, reqOf(c, s.sessionId), a.view.id)).toBeNull();
    } finally { await c.stop(); }
  }, 20_000);
});
