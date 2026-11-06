/**
 * Refs #3061 (P2a): device-code sign-in on a web-only fleet, over HTTP against a real fleet — its public link through the
 * REAL gateway with only the tunnel stubbed (as outside-connections-3008.test.ts).
 *
 * The threat model, each line a test:
 *  - GUESSING: a wrong code at the approving side counts toward one breaker (429 + Retry-After) that holds a right code
 *    too; asking for codes is rate-limited per address and for the fleet; the room is bounded;
 *  - REPLAY / SINGLE USE: the poll that finds a request approved spends it — a second poll, a second approval and a
 *    stolen copy of the code find nothing; an expired request is neither approved nor claimed; a denied one never signs in;
 *  - NO CREDENTIAL TRAVELS: approving answers with the request and sets no cookie; the new browser's session is made by
 *    its OWN poll, with its own fresh id; the request id is never in anything the approver sees;
 *  - OWNER AUTHORITY IS SEPARATE: the new session is an admin session with no owner authority (web-authority:
 *    host_sign_in); it cannot approve another device, set up the authenticator, or decide an agent's request;
 *  - WHO MAY APPROVE: only this web-only fleet's verified owner — this computer's admin, or signed in from outside with
 *    the authenticator's code; a LAN session, a session a device approval made, no session, the CLI's header token and a
 *    session over the link that is not the owner are 403/401 — and learn nothing about any request;
 *  - PUBLIC LINK vs LAN/tailnet: the new device's three routes are 404 through the public link (and not in its
 *    manifest); the sign-in page there has no "another device"; the owner signed in from outside CAN approve;
 *  - a chat fleet: no such routes; the switch (`web.verified_authority.enabled`) and "Only this computer can authorize"
 *    take the owner's authority — and the approval — away at once; a rotated token or `/dashboard revoke` withdraws requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor, tokenEpoch, WebSessionStore, type SessionRecord } from "../src/web-session.js";
import { rotateWebToken, WEB_CSRF_HEADER, WEB_SESSION_COOKIE_SECURE } from "../src/web-auth.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { base32Decode, hotp, totpStep } from "../src/web-remote-access.js";
import { DEVICE_LOGIN_COOKIE, DEVICE_LOGIN_CREATES_PER_PEER, DEVICE_LOGIN_TTL_MS, MAX_PENDING_PER_PEER, DEVICE_APPROVE_THRESHOLD } from "../src/web-device-login.js";
import { fleetCookieName } from "../src/web-cookie-names.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { setLocale } from "../src/locale.js";
import { handleAuthRequest, serveSigninPage } from "../src/auth-api.js";

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stops.splice(0)) await s().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
beforeEach(() => setLocale("en"));

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
const parse = (r: Res) => { try { return JSON.parse(r.body); } catch { return null; } };
const setCookies = (r: Res): string[] => { const set = r.headers["set-cookie"]; return Array.isArray(set) ? set : set ? [set] : []; };
const cookieOf = (r: Res) => setCookies(r)[0]!.split(";")[0]!;
const HOST = "device-test.trycloudflare.com";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const SIGNED_IN_AS = (r: Res) => ({ cookie: cookieOf(r), sessionId: cookieOf(r).split("=")[1]! });

async function startFleet(opts: { chat?: boolean; web?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-3061-")); dirs.push(dir);
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  const infos: Array<[unknown, string | undefined]> = [], warns: Array<[unknown, string | undefined]> = [];
  // pino's two shapes: (object, message) and (message).
  fm.logger = { info: (o: unknown, m?: string) => { infos.push(typeof o === "string" ? [{}, o] : [o, m]); }, warn: (o: unknown, m?: string) => { warns.push(typeof o === "string" ? [{}, o] : [o, m]); }, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  const notified: string[] = [];
  vi.spyOn(fm, "notifyFleetError").mockImplementation((text: string) => { notified.push(text); return true; });
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true }, ...opts.web },
    ...(opts.chat ? { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } } : {}) } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  const tunnel = { port: 0 };
  const manager = {
    start: vi.fn(async (_p: unknown, ctx: any) => {
      tunnel.port = Number(new URL(ctx.origin).port);
      ctx.onCandidateHost(HOST);
      return { ok: true as const, handle: { pageUrl: `https://${HOST}/signin`, onUnexpectedExit: () => () => {} } };
    }),
    stop: vi.fn(async () => ({ confirmed: true as const })),
  };
  any.tunnelPurposeLane = new TunnelPurposeLane(manager as never);
  any.publicWebLink = new PublicWebLink({ ...any.publicWebLinkDeps(), ensure: async () => ({ path: "/stub/cloudflared", source: "agend" }), provider: () => ({}) as never });
  stops.push(async () => { await any.publicWebLink?.close("test end"); await new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); }); });

  const cookieName = fleetCookieName(DEVICE_LOGIN_COOKIE, token);
  /** This computer's admin: `agend web --code` and its sign-in, here. `extra` headers make it a LAN session. */
  const hostSignIn = async (extra: Record<string, string> = {}) => {
    const code = parse(await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin, ...extra }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    return SIGNED_IN_AS(res);
  };
  const local = (s: { cookie: string; sessionId: string }, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    raw(port, method, path, { cookie: s.cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId), ...extra },
      body === undefined ? undefined : JSON.stringify(body));
  /** A new device: no session; its request-id cookie (if it holds one) and its own User-Agent. */
  const device = (path: string, opts: { cookie?: string; body?: unknown; extra?: Record<string, string>; method?: string } = {}) =>
    raw(port, opts.method ?? "POST", `/auth/device-login${path}`, { origin, "content-type": "application/json", "user-agent": ANDROID, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.extra },
      opts.body === undefined ? "{}" : JSON.stringify(opts.body));
  /** The new device asks for a code; returns what it holds: the code on screen and its cookie. */
  const ask = async (extra: Record<string, string> = {}, cookie?: string) => {
    const r = await device("", { extra, ...(cookie ? { cookie } : {}) });
    expect(r.status).toBe(200);
    const mine = setCookies(r).find(c => c.startsWith(`${cookieName}=`))!;
    return { code: parse(r).code as string, expiresAt: parse(r).expiresAt as number, cookie: mine.split(";")[0]!, res: r };
  };
  const poll = (cookie?: string, extra: Record<string, string> = {}) => device("/poll", { ...(cookie ? { cookie } : {}), extra });
  /** Through the link: the gateway's port, with the tunnel's Host and Origin. */
  const outside = (method: string, path: string, opts: { session?: { cookie: string; sessionId: string }; body?: unknown } = {}) =>
    raw(tunnel.port, method, path, { host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone) Safari",
      ...(opts.session ? { cookie: opts.session.cookie, [WEB_CSRF_HEADER]: csrfTokenFor(opts.session.sessionId) } : {}) }, opts.body === undefined ? undefined : JSON.stringify(opts.body));
  /** The owner's authenticator, set up on this computer; the link opened; a session from outside with the app's code. */
  const outsideOwner = async (s: { cookie: string; sessionId: string }) => {
    const begun = parse(await local(s, "POST", "/ui/outside/enroll", {}));
    const key = base32Decode(begun.secret)!;
    expect((await local(s, "POST", "/ui/outside/enroll/confirm", { code: hotp(key, totpStep(Date.now()) - 1) })).status).toBe(200);
    expect((await local(s, "POST", "/ui/outside/switch", { on: true })).status).toBe(200);
    await vi.waitFor(() => expect(fm.getPublicWebStatus().state).toBe("open"));
    const r = await outside("POST", "/auth/totp", { body: { code: hotp(key, totpStep(Date.now())) } });
    expect(r.status).toBe(200);
    return SIGNED_IN_AS(r);
  };
  const sessionOf = (s: { sessionId: string }, surface: "local" | "gateway" = "local") =>
    any.webSessions.authenticate(s.sessionId, tokenEpoch(token), { touch: false, surface, ...(surface === "gateway" ? { exposureId: any.publicWebLink.exposureId } : {}) }) as SessionRecord | null;
  return { dir, fm, any, port, origin, token, tunnel, hostSignIn, local, device, ask, poll, outside, outsideOwner, sessionOf, cookieName, infos, warns, notified };
}
type Fleet = Awaited<ReturnType<typeof startFleet>>;
const lookup = (h: Fleet, s: { cookie: string; sessionId: string }, code: string, extra: Record<string, string> = {}) => h.local(s, "POST", "/ui/devices/lookup", { code }, extra);
const approve = (h: Fleet, s: { cookie: string; sessionId: string }, code: string, extra: Record<string, string> = {}) => h.local(s, "POST", "/ui/devices/approve", { code }, extra);
const deny = (h: Fleet, s: { cookie: string; sessionId: string }, code: string) => h.local(s, "POST", "/ui/devices/deny", { code });

describe("#3061 P2a: signing a new device in with its code", () => {
  it("asks → shows a code → the owner looks it up and approves → the device signs itself in with its own session; a Notice goes out", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const mine = await h.ask({ "x-forwarded-for": "192.168.1.23" });                      // a device elsewhere on the network
    expect(mine.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(mine.expiresAt).toBeGreaterThan(Date.now() + DEVICE_LOGIN_TTL_MS - 5000);
    // Its cookie: HttpOnly, Strict, scoped to the route, the request id and nothing else — not the code.
    const [setCookie] = setCookies(mine.res);
    expect(setCookie).toMatch(/^agend_device_login_[0-9a-f]{16}=[0-9a-f]{64}; Path=\/auth\/device-login; HttpOnly; SameSite=Strict; Max-Age=300$/);
    expect(setCookie).not.toContain(mine.code.replace("-", ""));
    expect(parse(await h.poll(mine.cookie))).toMatchObject({ state: "pending" });
    // The owner sees the label, where it came from and how long is left — and approves.
    const looked = parse(await lookup(h, owner, mine.code.toLowerCase()));
    expect(looked.request).toMatchObject({ code: mine.code, label: "Chrome on Android", peer: "network", address: "127.0.0.1", state: "pending" });
    expect(looked.request.expiresAt).toBe(mine.expiresAt);
    const approved = await approve(h, owner, mine.code);
    expect([approved.status, parse(approved).request.state]).toEqual([200, "approved"]);
    // …the approval set no cookie and carries no session or request id:
    expect(setCookies(approved)).toEqual([]);
    expect(approved.body).not.toMatch(/[0-9a-f]{64}/);
    expect(h.any.webSessions.list().length).toBe(1);                                      // still just the owner's own
    // The device's own poll makes its session.
    const done = await h.poll(mine.cookie);
    expect(done.status).toBe(200);
    expect(parse(done)).toMatchObject({ state: "approved", ok: true, tier: "admin" });
    const [session, cleared] = setCookies(done);
    expect(session).toMatch(/^[^=]+=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect(cleared).toMatch(new RegExp(`^${h.cookieName}=; Path=/auth/device-login; HttpOnly; SameSite=Strict; Max-Age=0`));
    const signedIn = SIGNED_IN_AS(done);
    expect(signedIn.sessionId).not.toBe(owner.sessionId);                                 // a fresh id of its own
    const record = h.sessionOf(signedIn)!;
    expect([record.tier, record.surface, record.via, record.owner, record.host, record.remote, record.label]).toEqual(["admin", "local", "device", undefined, undefined, undefined, "Chrome on Android"]);
    expect(parse(await raw(h.port, "GET", "/auth/session", { cookie: signedIn.cookie, origin: h.origin })).ok).toBe(true);
    // The operator is told, as for any sign-in (web.notify_login), and the log names who approved.
    expect(h.notified.some(n => n.includes("Chrome on Android"))).toBe(true);
    expect(h.infos.some(([o, m]) => m === "New device sign-in approved" && (o as any).label === "Chrome on Android")).toBe(true);
    expect(h.infos.some(([o, m]) => m === "Web sign-in with a device code" && (o as any).approvedBy === h.sessionOf(owner)!.handle.slice(0, 8))).toBe(true);
    // The session survives a restart of the store (the file's validator accepts `via`).
    expect(new WebSessionStore({ dataDir: h.dir }).list().some(s => s.handle === record.handle)).toBe(true);
  }, 20_000);

  it("NO CREDENTIAL TRAVELS: the new session's id is random and unrelated; the approver's session is untouched; the page's body never holds the id", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const before = JSON.stringify(h.sessionOf(owner));
    const mine = await h.ask();
    const lookedRes = await lookup(h, owner, mine.code);
    const approvedRes = await approve(h, owner, mine.code);
    const requestId = mine.cookie.split("=")[1]!;
    for (const r of [lookedRes, approvedRes, mine.res]) expect(r.body).not.toContain(requestId);
    for (const r of [lookedRes, approvedRes]) expect(JSON.stringify(r.headers)).not.toContain(owner.sessionId);
    const done = SIGNED_IN_AS(await h.poll(mine.cookie));
    expect(done.sessionId).not.toContain(requestId);
    expect(done.sessionId).not.toBe(requestId);
    // The approver's session is the same one it was (its record unchanged but for the activity stamp); the new one is another.
    const after = h.sessionOf(owner)!;
    expect([after.handle, after.idHash, after.tier, after.host, after.created]).toEqual([JSON.parse(before).handle, JSON.parse(before).idHash, "admin", true, JSON.parse(before).created]);
    expect(h.sessionOf(owner)!.handle).not.toBe(h.sessionOf(done)!.handle);
  }, 20_000);

  it("OWNER AUTHORITY IS SEPARATE: the new session carries none (host_sign_in), cannot approve another device, set up the app or decide an agent's request", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const mine = await h.ask();
    await approve(h, owner, mine.code);
    const fresh = SIGNED_IN_AS(await h.poll(mine.cookie));
    const record = h.sessionOf(fresh)!;
    const verdict = h.any.webAuthority({ session: record, gateway: false, peer: "loopback" });
    expect([verdict.authority.kind, verdict.refusal]).toEqual(["none", "host_sign_in"]);
    // …where the owner's own session is web-verified as this computer's admin.
    expect(h.any.webAuthority({ session: h.sessionOf(owner), gateway: false, peer: "loopback" }).authority).toMatchObject({ kind: "web-verified", actor: { adapter_id: "host", user_id: "operator" } });
    // It may read its own state (not the owner), but not approve; the same for set-up and agents' requests.
    expect(parse(await h.local(fresh, "GET", "/ui/devices"))).toMatchObject({ webOnly: true, owner: false });
    expect(parse(await h.local(owner, "GET", "/ui/devices"))).toMatchObject({ webOnly: true, owner: true });
    const another = await h.ask();
    for (const op of ["lookup", "approve", "deny"]) {
      const r = await h.local(fresh, "POST", `/ui/devices/${op}`, { code: another.code });
      expect([r.status, parse(r)]).toEqual([403, { error: "owner_required" }]);
    }
    expect((await h.local(fresh, "POST", "/ui/outside/enroll", {})).status).toBe(403);
    expect(parse(await h.local(fresh, "GET", "/ui/agent-proposals"))).toEqual({ owner: false, proposals: [] });
    // The other request is untouched: the owner still finds it pending.
    expect(parse(await lookup(h, owner, another.code)).request.state).toBe("pending");
  }, 20_000);

  it("a second poll, a second approval and a replayed code find nothing: the request is spent the moment it is claimed", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const mine = await h.ask();
    expect((await approve(h, owner, mine.code)).status).toBe(200);
    const again = await approve(h, owner, mine.code);
    expect([again.status, parse(again)]).toEqual([409, { error: "already_decided", state: "approved" }]);
    expect((await deny(h, owner, mine.code)).status).toBe(409);                           // an approval is not taken back by a later tap
    const first = await h.poll(mine.cookie), second = await h.poll(mine.cookie);
    expect(parse(first).state).toBe("approved");
    expect(parse(second)).toEqual({ state: "expired" });
    expect(setCookies(second).some(c => /^[^=]+=[0-9a-f]{64};/.test(c) && !c.startsWith(h.cookieName))).toBe(false);   // no second session cookie
    const sessions = h.any.webSessions.list().length;
    expect(sessions).toBe(2);                                                              // the owner's and the one device's
    expect((await lookup(h, owner, mine.code)).status).toBe(404);                          // the code is gone for the approver too
    expect((await approve(h, owner, mine.code)).status).toBe(404);
    // A second browser holding a copy of the (spent) cookie gets nothing.
    expect(parse(await h.poll(mine.cookie))).toEqual({ state: "expired" });
    expect(h.any.webSessions.list().length).toBe(sessions);
  }, 20_000);

  it("a code nobody asked for, and the empty one, are 404 (no hint); a body that is not a code is 400", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    await h.ask();
    expect((await lookup(h, owner, "ZZZZ-ZZZZ")).status).toBe(404);
    expect((await lookup(h, owner, "")).status).toBe(404);
    expect((await h.local(owner, "POST", "/ui/devices/lookup", {})).status).toBe(400);
    expect((await h.local(owner, "POST", "/ui/devices/lookup", { code: 12345678 })).status).toBe(400);
    expect((await h.local(owner, "POST", "/ui/devices/lookup", { code: "A".repeat(40) })).status).toBe(400);
  }, 20_000);

  it("EXPIRY: five minutes from asking; approving does not extend it; an expired request is neither approved nor signs in", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    vi.useFakeTimers({ toFake: ["Date"] });
    const stale = await h.ask(), approvedLate = await h.ask({}, undefined);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    expect((await approve(h, owner, approvedLate.code)).status).toBe(200);
    vi.setSystemTime(Date.now() + 60_000 + 1);
    expect((await lookup(h, owner, stale.code)).status).toBe(404);
    expect((await approve(h, owner, stale.code)).status).toBe(404);
    expect(parse(await h.poll(stale.cookie))).toEqual({ state: "expired" });
    expect(parse(await h.poll(approvedLate.cookie))).toEqual({ state: "expired" });       // approved, but too late: it never signs in
    expect(h.any.webSessions.list().length).toBe(1);
  }, 20_000);

  it("DENIED: the device is told once; it never signs in; it can ask again", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const mine = await h.ask();
    expect(parse(await deny(h, owner, mine.code)).request.state).toBe("denied");
    expect(parse(await h.poll(mine.cookie))).toEqual({ state: "denied" });
    expect(parse(await h.poll(mine.cookie))).toEqual({ state: "expired" });
    expect(h.any.webSessions.list().length).toBe(1);
    const next = await h.ask();
    expect(next.code).not.toBe(mine.code);
    expect(parse(await h.poll(next.cookie)).state).toBe("pending");
  }, 20_000);

  it("asking again with the old cookie withdraws the old request (its code stops working); cancel withdraws it too", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const first = await h.ask();
    const second = await h.ask({}, first.cookie);
    expect((await lookup(h, owner, first.code)).status).toBe(404);
    expect((await lookup(h, owner, second.code)).status).toBe(200);
    const cancelled = await h.device("/cancel", { cookie: second.cookie });
    expect(cancelled.status).toBe(200);
    expect(setCookies(cancelled)[0]).toContain("Max-Age=0");
    expect((await lookup(h, owner, second.code)).status).toBe(404);
    expect(h.any.webDeviceLogins.size).toBe(0);
  }, 20_000);

  it("a poll without a cookie, or with one this fleet did not give, is `expired` — never an error", async () => {
    const h = await startFleet();
    expect(parse(await h.poll())).toEqual({ state: "expired" });
    expect(parse(await h.poll(`${h.cookieName}=${"0".repeat(64)}`))).toEqual({ state: "expired" });
    expect(parse(await h.poll(`${h.cookieName}=nope`))).toEqual({ state: "expired" });
  }, 20_000);
});

describe("#3061 P2a: who may approve — only this web-only fleet's verified owner", () => {
  it("a LAN session (host code from the network, or the owner's session as a proxy shows it), no session, the CLI's header token and a guest-less cross-site call: refused, and nothing leaks", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const lan = await h.hostSignIn({ "x-forwarded-for": "10.0.0.5" });                    // signed in from the network: never authorized
    const mine = await h.ask();
    for (const op of ["lookup", "approve", "deny"] as const) {
      // The owner's own session, but this request looks like it came from the network:
      expect((await h.local(owner, "POST", `/ui/devices/${op}`, { code: mine.code }, { "x-forwarded-for": "10.0.0.5" })).status).toBe(403);
      // A session that signed in from the network:
      expect((await h.local(lan, "POST", `/ui/devices/${op}`, { code: mine.code })).status).toBe(403);
      // No session, however it asks:
      expect((await raw(h.port, "POST", `/ui/devices/${op}`, { origin: h.origin, "content-type": "application/json" }, JSON.stringify({ code: mine.code }))).status).toBe(401);
      // The CLI's header token is no person:
      const viaToken = await raw(h.port, "POST", `/ui/devices/${op}`, { origin: h.origin, "content-type": "application/json", "x-agend-token": h.token }, JSON.stringify({ code: mine.code }));
      expect([401, 403]).toContain(viaToken.status);
      // The owner's cookie from another site: the gate's own CSRF refusal.
      expect((await h.local(owner, "POST", `/ui/devices/${op}`, { code: mine.code }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    }
    expect(parse(await h.local(lan, "GET", "/ui/devices"))).toMatchObject({ webOnly: true, owner: false });
    // …and the request is still pending for the real owner.
    expect(parse(await lookup(h, owner, mine.code)).request.state).toBe("pending");
    expect(parse(await h.poll(mine.cookie)).state).toBe("pending");
  }, 30_000);

  it("the switch off (`web.verified_authority.enabled: false`) or \"Only this computer can authorize\" (from outside): the owner's authority — and the approval — are gone at once", async () => {
    const off = await startFleet();
    const owner = await off.hostSignIn();
    const mine = await off.ask();
    expect((await approve(off, owner, mine.code)).status).toBe(200);                      // while it is on: yes
    const waiting = await off.ask({ "x-forwarded-for": "10.0.0.7" });
    off.fm.fleetConfig = { ...off.fm.fleetConfig, web: { ...(off.fm.fleetConfig as any).web, verified_authority: { enabled: false } } } as never;
    expect((await approve(off, owner, waiting.code)).status).toBe(403);                  // …off: the owner is no one, at once
    expect(parse(await off.local(owner, "GET", "/ui/devices"))).toMatchObject({ webOnly: true, owner: false });
    const only = await startFleet({ web: { verified_authority: { enabled: true, loopback_only: true } } });
    const host = await only.hostSignIn();
    const there = await only.ask();
    expect((await approve(only, host, there.code)).status).toBe(200);                    // this computer: yes
    const other = await only.ask();
    expect((await approve(only, host, other.code, { "x-forwarded-for": "10.0.0.5" })).status).toBe(403);    // the same session, from the network: no
  }, 30_000);

  it("a chat-connected fleet: no such routes (404), no \"another device\" on its sign-in page, nobody approves anything", async () => {
    const h = await startFleet({ chat: true });
    expect((await h.device("")).status).toBe(404);
    expect((await h.device("/poll")).status).toBe(404);
    expect((await h.device("/cancel")).status).toBe(404);
    const owner = await h.hostSignIn();
    expect(parse(await h.local(owner, "GET", "/ui/devices"))).toMatchObject({ webOnly: false, owner: false });
    expect((await approve(h, owner, "ABCD-EFGH")).status).toBe(403);
    const page = await raw(h.port, "GET", "/signin", {});
    expect(page.body).not.toContain("data-device-login");
  }, 20_000);

  it("the new device's routes: POST only, from this very site, JSON — GET 405, no Origin or another site 403, not JSON 415", async () => {
    const h = await startFleet();
    for (const path of ["", "/poll", "/cancel"]) {
      expect((await h.device(path, { method: "GET" })).status).toBe(405);
      expect((await raw(h.port, "POST", `/auth/device-login${path}`, { "content-type": "application/json" }, "{}")).status).toBe(403);                  // no Origin
      expect((await h.device(path, { extra: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await raw(h.port, "POST", `/auth/device-login${path}`, { origin: h.origin, "content-type": "text/plain" }, "{}")).status).toBe(415);
    }
    expect(h.any.webDeviceLogins.size).toBe(0);
  }, 20_000);
});

describe("#3061 P2a review: the route is absent (404) before its method is judged (405)", () => {
  const METHODS = ["GET", "HEAD", "PUT", "DELETE"] as const;
  const PATHS = ["", "/poll", "/cancel"] as const;
  it("a chat-connected fleet: GET, HEAD and every other method on the three routes read 404, never 405", async () => {
    const h = await startFleet({ chat: true });
    for (const path of PATHS) for (const method of [...METHODS, "POST" as const]) expect([method, path, (await h.device(path, { method })).status]).toEqual([method, path, 404]);
    expect(h.any.webDeviceLogins.size).toBe(0);
  }, 20_000);

  it("web authorization off: GET, HEAD and every other method read 404, never 405", async () => {
    const h = await startFleet({ web: { verified_authority: { enabled: false } } });
    for (const path of PATHS) for (const method of [...METHODS, "POST" as const]) expect([method, path, (await h.device(path, { method })).status]).toEqual([method, path, 404]);
    expect(h.any.webDeviceLogins.size).toBe(0);
  }, 20_000);

  it("through the public link (the gateway's own provenance): 404 for every method — and the handler itself, handed the gateway, answers 404 to GET and HEAD too", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    await h.outsideOwner(owner);
    for (const path of PATHS) for (const method of [...METHODS, "POST" as const]) expect([method, path, (await h.outside(method, `/auth/device-login${path}`, { body: {} })).status]).toEqual([method, path, 404]);
    // Were a route to slip into the manifest, the handler refuses the gateway before it judges the method.
    const { bindGatewayRequest } = await import("../src/web-request-context.js");
    for (const method of [...METHODS, "POST" as const]) {
      const req: any = { method, url: "/auth/device-login", headers: { host: HOST, origin: `https://${HOST}`, "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } };
      bindGatewayRequest(req, { surface: "gateway", named: false, exposureId: h.any.publicWebLink.exposureId, expectedOrigin: `https://${HOST}`, isCurrent: () => true });
      let status = 0;
      const res: any = { writeHead(code: number) { status = code; return res; }, end() {}, setHeader() {}, getHeader() { return undefined; } };
      expect(handleAuthRequest(req, res, new URL("https://x/auth/device-login"), h.any)).toBe(true);
      expect([method, status]).toEqual([method, 404]);
    }
    expect(h.any.webDeviceLogins.size).toBe(0);
  }, 30_000);

  it("an available feature: a method other than POST is 405 on the three routes (HEAD too), and creates nothing", async () => {
    const h = await startFleet();
    for (const path of PATHS) for (const method of METHODS) expect([method, path, (await h.device(path, { method })).status]).toEqual([method, path, 405]);
    expect(h.any.webDeviceLogins.size).toBe(0);
  }, 20_000);
});

describe("#3061 P2a: guessing and flooding", () => {
  it(`wrong codes at the approving side count toward one breaker: ${DEVICE_APPROVE_THRESHOLD} → 429 + Retry-After, and a right code waits too`, async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const mine = await h.ask();
    for (let i = 0; i < DEVICE_APPROVE_THRESHOLD; i++) expect((await lookup(h, owner, "ZZZZ-ZZZZ")).status).toBe(404);
    const paused = await lookup(h, owner, mine.code);
    expect(paused.status).toBe(429);
    expect(Number(paused.headers["retry-after"])).toBeGreaterThan(0);
    expect(parse(paused).error).toBe("paused");
    expect((await approve(h, owner, mine.code)).status).toBe(429);
    expect((await deny(h, owner, mine.code)).status).toBe(429);
    expect(h.warns.some(([, m]) => m === "Device sign-in approval paused: too many wrong codes")).toBe(true);
    expect(parse(await h.poll(mine.cookie)).state).toBe("pending");                       // the device itself is unaffected, and unapproved
  }, 30_000);

  it("with nothing waiting, wrong codes count against nothing (so no one can pause the owner by guessing at an empty room)", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    for (let i = 0; i < DEVICE_APPROVE_THRESHOLD * 2; i++) expect((await lookup(h, owner, "ZZZZ-ZZZZ")).status).toBe(404);
    const mine = await h.ask();
    expect((await lookup(h, owner, mine.code)).status).toBe(200);
  }, 30_000);

  it(`asking for codes: ${DEVICE_LOGIN_CREATES_PER_PEER} per address per window (429 + Retry-After); the room holds ${MAX_PENDING_PER_PEER} per address (503 busy), and never evicts`, async () => {
    const h = await startFleet();
    const first = await h.ask(), second = await h.ask();
    const full = await h.device("");
    expect([full.status, parse(full)]).toEqual([503, { error: "busy" }]);
    for (const m of [first, second]) expect(parse(await h.poll(m.cookie)).state).toBe("pending");
    // Asking again with a cookie replaces; it never fills the room…
    let cookie = second.cookie, made = 2;
    while (made < DEVICE_LOGIN_CREATES_PER_PEER) { cookie = (await h.ask({}, cookie)).cookie; made++; }
    const limited = await h.device("", { cookie });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(parse(limited).error).toBe("limited");
    expect(h.warns.some(([, m]) => m === "Device sign-in code requests limited")).toBe(true);
  }, 30_000);
});

describe("#3061 P2a: the public link, a rotated token, /dashboard revoke", () => {
  it("through the public link the new device's routes do not exist (404, and not in its manifest); its sign-in page offers no \"another device\"; on the host's own listener it does", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    await h.outsideOwner(owner);
    for (const path of ["/auth/device-login", "/auth/device-login/poll", "/auth/device-login/cancel"]) {
      expect(isPublicWebRoute("POST", path)).toBe(false);
      expect((await h.outside("POST", path, { body: {} })).status).toBe(404);
    }
    // Even were a route to slip into the manifest, the handler itself refuses the gateway:
    const { bindGatewayRequest } = await import("../src/web-request-context.js");
    const req: any = { method: "POST", url: "/auth/device-login", headers: { host: HOST, origin: `https://${HOST}`, "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } };
    bindGatewayRequest(req, { surface: "gateway", named: false, exposureId: h.any.publicWebLink.exposureId, expectedOrigin: `https://${HOST}`, isCurrent: () => true });
    let status = 0;
    const res: any = { writeHead(code: number) { status = code; return res; }, end() {}, setHeader() {}, getHeader() { return undefined; } };
    expect(handleAuthRequest(req, res, new URL("https://x/auth/device-login"), h.any)).toBe(true);
    expect(status).toBe(404);
    expect(h.any.webDeviceLogins.size).toBe(0);
    // The pages:
    const link = await h.outside("GET", "/signin");
    expect(link.status).toBe(200);
    expect(link.body).not.toContain("data-device-login");
    expect((await raw(h.port, "GET", "/signin", {})).body).toContain('data-device-login="1"');
  }, 30_000);

  it("the owner signed in from outside (the authenticator's code) CAN approve a new device on the network, over the link; a session over the link that is not the owner cannot", async () => {
    const h = await startFleet();
    const host = await h.hostSignIn();
    const remote = await h.outsideOwner(host);
    expect(isPublicWebRoute("GET", "/ui/devices")).toBe(true);
    expect(isPublicWebRoute("POST", "/ui/devices/approve")).toBe(true);
    expect(parse(await h.outside("GET", "/ui/devices", { session: remote }))).toMatchObject({ webOnly: true, owner: true });
    const mine = await h.ask({ "x-forwarded-for": "192.168.1.50" });
    const seen = parse(await h.outside("POST", "/ui/devices/lookup", { session: remote, body: { code: mine.code } }));
    expect(seen.request).toMatchObject({ label: "Chrome on Android", state: "pending" });
    const ok = await h.outside("POST", "/ui/devices/approve", { session: remote, body: { code: mine.code } });
    expect([ok.status, parse(ok).request.state]).toEqual([200, "approved"]);
    expect(setCookies(ok)).toEqual([]);
    const fresh = SIGNED_IN_AS(await h.poll(mine.cookie));
    expect(h.sessionOf(fresh)!.via).toBe("device");
    // A gateway-side session that is not the owner: a plain admin session made over the link by a code the host's shell issued
    // is refused at sign-in (audience is this computer), so make one directly — a session over the link with no authority.
    const { sessionId, record } = h.any.webSessions.create({ tier: "admin", surface: "gateway", label: "x", tokenEpoch: tokenEpoch(h.token), exposureId: h.any.publicWebLink.exposureId });
    expect(record.remote).toBeUndefined();
    const plain = { cookie: `${fleetCookieName(WEB_SESSION_COOKIE_SECURE, h.token)}=${sessionId}`, sessionId };
    const other = await h.ask({ "x-forwarded-for": "192.168.1.51" });
    const refused = await h.outside("POST", "/ui/devices/approve", { session: plain, body: { code: other.code } });
    expect([refused.status, parse(refused)]).toEqual([403, { error: "owner_required" }]);
    expect(parse(await lookup(h, host, other.code)).request.state).toBe("pending");
  }, 40_000);

  it("a rotated web token withdraws every request — approved ones too — and `/dashboard revoke` does the same", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const a = await h.ask(), b = await h.ask({ "x-forwarded-for": "10.0.0.8" });
    expect((await approve(h, owner, a.code)).status).toBe(200);
    h.any.revokeWebSessions();                                                              // /dashboard revoke: everyone signed out, requests withdrawn
    expect(h.any.webDeviceLogins.size).toBe(0);
    expect(parse(await h.poll(a.cookie))).toEqual({ state: "expired" });
    expect(parse(await h.poll(b.cookie))).toEqual({ state: "expired" });
    expect(h.any.webSessions.list().length).toBe(0);
    // A rotated token (`agend web-token rotate`, another process): a request made under the old one is not honoured under the
    // new — not looked up, not approved, not claimed — even one already approved.
    const owner2 = await h.hostSignIn();
    const c = await h.ask(), d = await h.ask({ "x-forwarded-for": "10.0.0.9" });
    expect((await approve(h, owner2, c.code)).status).toBe(200);
    rotateWebToken(h.dir);
    expect(h.fm.getDashboardAccess().token).not.toBe(h.token);
    expect(parse(await h.poll(c.cookie))).toEqual({ state: "expired" });                  // (its cookie's name followed the token, so it is not even presented)
    expect(h.any.webDeviceLogins.poll(c.cookie.split("=")[1], tokenEpoch(h.fm.getDashboardAccess().token!))).toEqual({ kind: "expired" });
    expect(h.any.webDeviceLogins.lookup(d.code, tokenEpoch(h.fm.getDashboardAccess().token!)).kind).toBe("invalid");
    expect(h.any.webSessions.list().length).toBe(1);                                         // no session came of any of it
  }, 30_000);

  it("the sign-in page: a web-only fleet's own listener carries data-device-login; the 401 page for a gated URL too", async () => {
    const h = await startFleet();
    const served = (opts: Parameters<typeof serveSigninPage>[2]) => {
      let body = "";
      const res = { writeHead() { return res; }, setHeader() {}, end(b: string) { body = String(b); }, getHeader() { return undefined; } } as never;
      serveSigninPage(res, 200, opts);
      return body.match(/<body[^>]*>/)?.[0];
    };
    expect(served({ webOnly: true, deviceLogin: true })).toBe('<body data-web-only="1" data-device-login="1">');
    expect(served({ webOnly: true, outside: true, deviceLogin: true })).toBe('<body data-web-only="1" data-outside="1">');     // from outside: the app's code only
    expect(served({ deviceLogin: true })).toBe("<body>");                                                                        // a chat fleet: nothing
    const gated = await raw(h.port, "GET", "/ui", { accept: "text/html" });
    expect(gated.status).toBe(401);
    expect(gated.body).toContain('data-device-login="1"');
  }, 20_000);
});

describe("#3061 P2a (review): the entrance is open only while someone could approve; limits count the socket's peer", () => {
  it("web authorization off: the three routes answer 404 (also after the body is read), and the sign-in page shows no button — nothing is created", async () => {
    const h = await startFleet({ web: { verified_authority: { enabled: false } } });
    for (const path of ["", "/poll", "/cancel"]) expect([path, (await h.device(path)).status]).toEqual([path, 404]);
    expect(h.any.webDeviceLogins.size).toBe(0);
    expect((await raw(h.port, "GET", "/signin", {})).body).not.toContain("data-device-login");
    const gated = await raw(h.port, "GET", "/ui", { accept: "text/html" });
    expect([gated.status, gated.body.includes("data-device-login"), gated.body.includes('data-web-only="1"')]).toEqual([401, false, true]);
  }, 20_000);

  it("turned off while a request waits (even an approved one): the poll answers 404 and no session is made", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const mine = await h.ask();
    expect((await approve(h, owner, mine.code)).status).toBe(200);
    expect((await raw(h.port, "GET", "/signin", {})).body).toContain('data-device-login="1"');
    h.fm.fleetConfig = { ...h.fm.fleetConfig, web: { ...(h.fm.fleetConfig as any).web, verified_authority: { enabled: false } } } as never;
    const polled = await h.poll(mine.cookie);
    expect([polled.status, setCookies(polled).length, h.any.webSessions.list().length]).toEqual([404, 0, 1]);
    expect((await h.device("")).status).toBe(404);
    expect((await raw(h.port, "GET", "/signin", {})).body).not.toContain("data-device-login");
  }, 20_000);

  it("\"Only this computer can authorize\" on: the entrance stays open (this computer's own session can still approve)", async () => {
    const h = await startFleet({ web: { verified_authority: { enabled: true, loopback_only: true } } });
    const host = await h.hostSignIn();
    expect((await raw(h.port, "GET", "/signin", {})).body).toContain('data-device-login="1"');
    const mine = await h.ask();
    expect((await approve(h, host, mine.code)).status).toBe(200);
    expect(parse(await h.poll(mine.cookie)).state).toBe("approved");
  }, 20_000);

  /** A request as the socket reports it — to see an IPv6 peer, which a loopback test server cannot show. */
  function viaSocket(h: Fleet, remoteAddress: string, extra: Record<string, string> = {}) {
    const req: any = Readable.from([Buffer.from("{}")]);
    Object.assign(req, { method: "POST", url: "/auth/device-login", socket: { remoteAddress },
      headers: { host: `127.0.0.1:${h.port}`, origin: h.origin, "content-type": "application/json", "user-agent": ANDROID, ...extra } });
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      let status = 0;
      const res: any = { headersSent: false, destroyed: false, setHeader() {}, getHeader() { return undefined; },
        writeHead(code: number) { status = code; return res; }, end(text: string) { try { resolve({ status, body: JSON.parse(text) }); } catch (err) { reject(err); } } };
      handleAuthRequest(req, res, new URL(`http://127.0.0.1:${h.port}/auth/device-login`), h.any);
    });
  }

  it("asked again once the body is in: web authorization turned off while the body is still arriving — 404, nothing created, whichever of the three", async () => {
    for (const path of ["/auth/device-login", "/auth/device-login/poll", "/auth/device-login/cancel"]) {
      const h = await startFleet();
      const req: any = new PassThrough();                                                   // the body has not arrived yet
      Object.assign(req, { method: "POST", url: path, socket: { remoteAddress: "10.1.1.1" },
        headers: { host: `127.0.0.1:${h.port}`, origin: h.origin, "content-type": "application/json", "user-agent": ANDROID } });
      const answered = new Promise<number>(resolve => {
        const res: any = { headersSent: false, destroyed: false, setHeader() {}, getHeader() { return undefined; }, writeHead(code: number) { resolve(code); return res; }, end() {} };
        handleAuthRequest(req, res, new URL(`http://127.0.0.1:${h.port}${path}`), h.any);
      });
      h.fm.fleetConfig = { ...h.fm.fleetConfig, web: { ...(h.fm.fleetConfig as any).web, verified_authority: { enabled: false } } } as never;
      req.end("{}");
      expect([path, await answered, h.any.webDeviceLogins.size]).toEqual([path, 404, 0]);
    }
  }, 30_000);

  it("IPv6 counts by its /64: six codes per window for the whole /64; another /64 and an IPv4 peer are separate; the approver is shown the full address", async () => {
    const h = await startFleet();
    for (let i = 1; i <= 6; i++) { expect((await viaSocket(h, `2001:db8:1:2::${i}`)).status).toBe(200); h.any.webDeviceLogins.revokeAll(); }   // revokeAll: the room, not the allowance
    const limited = await viaSocket(h, "2001:db8:1:2:ffff:ffff:ffff:ffff");
    expect([limited.status, limited.body.error]).toEqual([429, "limited"]);
    expect((await viaSocket(h, "2001:db8:1:3::1")).status).toBe(200);
    expect((await viaSocket(h, "10.9.9.9")).status).toBe(200);
    h.any.webDeviceLogins.revokeAll();
    const shown = await viaSocket(h, "2001:db8:1:3::1:abcd");
    expect(shown.status).toBe(200);
    const view = h.any.webDeviceLogins.lookup(shown.body.code, tokenEpoch(h.token));
    expect(view).toMatchObject({ kind: "ok", view: { address: "2001:db8:1:3::1:abcd" } });
  }, 20_000);

  it("an IPv4-mapped peer (::ffff:a.b.c.d) is the IPv4 one — one allowance, shown as a.b.c.d", async () => {
    const h = await startFleet();
    for (let i = 0; i < 3; i++) { expect((await viaSocket(h, "::ffff:10.0.0.5")).status).toBe(200); h.any.webDeviceLogins.revokeAll(); }
    for (let i = 0; i < 3; i++) { expect((await viaSocket(h, "10.0.0.5")).status).toBe(200); h.any.webDeviceLogins.revokeAll(); }
    expect((await viaSocket(h, "::ffff:10.0.0.5")).status).toBe(429);
    h.any.webDeviceLogins.revokeAll();
    const other = await viaSocket(h, "::ffff:10.0.0.6");
    expect(other.status).toBe(200);
    expect(h.any.webDeviceLogins.lookup(other.body.code, tokenEpoch(h.token))).toMatchObject({ view: { address: "10.0.0.6" } });
  }, 20_000);

  it("X-Forwarded-For is never trusted for the limits: behind a reverse proxy on this machine every device is one address and shares one allowance", async () => {
    const h = await startFleet();
    for (let i = 1; i <= 6; i++) { expect((await h.device("", { extra: { "x-forwarded-for": `203.0.113.${i}` } })).status).toBe(200); h.any.webDeviceLogins.revokeAll(); }
    const seventh = await h.device("", { extra: { "x-forwarded-for": "203.0.113.200", "x-real-ip": "198.51.100.7" } });
    expect([seventh.status, parse(seventh).error]).toEqual([429, "limited"]);
  }, 20_000);
});
