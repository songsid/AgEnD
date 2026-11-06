/**
 * Refs #3061 (P2b): the device list and ending another device's session, over HTTP against a real fleet — its public link
 * through the REAL gateway with only the tunnel stubbed (as device-login-3061.test.ts).
 *
 *  - THE LIST (GET /ui/devices): this fleet's admin sessions — how each was approved (sign-in code / host / device code /
 *    authenticator), whether it carries owner authority, which one is the reader's own — to an admin session only (a guest,
 *    the CLI's header token, a chat fleet: nothing); no id, no hash, no cookie in it;
 *  - ENDING ANOTHER DEVICE needs the verified owner, on EVERY way in: POST /ui/devices/signout, and the older
 *    `DELETE /auth/sessions/<handle>` and `DELETE /auth/sessions` (an admin session could always do these — a session a
 *    code or a device approval made would otherwise sign the owner out). A non-owner gets 403 before anything is looked up
 *    (no oracle for which handles exist); ending one's own is sign-out and stays everyone's; a fleet with a chat
 *    connection is as it was;
 *  - the owner's authority is asked of the LIVE session: the switch off, or a session that lost it, ends the right at once;
 *  - the owner signed in from outside may do it over the public link; a session over the link that is not the owner may not;
 *  - THE QR (web.login_qr): the sign-in page is marked to draw it only on a web-only fleet's own listener, while device
 *    sign-in is offered and the option is on — never over the link, never by default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor, sessionVia, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { WEB_CSRF_HEADER, WEB_SESSION_COOKIE, WEB_SESSION_COOKIE_SECURE } from "../src/web-auth.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { base32Decode, hotp, totpStep } from "../src/web-remote-access.js";
import { DEVICE_LOGIN_COOKIE } from "../src/web-device-login.js";
import { fleetCookieName } from "../src/web-cookie-names.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { setLocale } from "../src/locale.js";

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
const HOST = "device-list.trycloudflare.com";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
type Signed = { cookie: string; sessionId: string };
const SIGNED_IN_AS = (r: Res): Signed => ({ cookie: cookieOf(r), sessionId: cookieOf(r).split("=")[1]! });

async function startFleet(opts: { chat?: boolean; web?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-3061-list-")); dirs.push(dir);
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  const infos: Array<[any, string | undefined]> = [];
  fm.logger = { info: (o: unknown, m?: string) => { infos.push(typeof o === "string" ? [{}, o] : [o, m]); }, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
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
  /** This computer's admin: `agend web --code` and its sign-in, here. `extra` headers make it a LAN session (no owner authority). */
  const hostSignIn = async (extra: Record<string, string> = {}): Promise<Signed> => {
    const code = parse(await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin, ...extra }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    return SIGNED_IN_AS(res);
  };
  const local = (s: Signed, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    raw(port, method, path, { cookie: s.cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId), ...extra },
      body === undefined ? undefined : JSON.stringify(body));
  const device = (path: string, opts: { cookie?: string; extra?: Record<string, string> } = {}) =>
    raw(port, "POST", `/auth/device-login${path}`, { origin, "content-type": "application/json", "user-agent": ANDROID, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.extra }, "{}");
  /** A new device is approved by `owner` and signs itself in: a session with via "device" (an admin session with no owner authority). */
  const deviceSession = async (owner: Signed, from = "192.168.1.23"): Promise<Signed> => {
    const asked = await device("", { extra: { "x-forwarded-for": from } });
    expect(asked.status).toBe(200);
    const mine = setCookies(asked).find(c => c.startsWith(`${cookieName}=`))!.split(";")[0]!;
    expect((await local(owner, "POST", "/ui/devices/approve", { code: parse(asked).code })).status).toBe(200);
    const done = await device("/poll", { cookie: mine });
    expect(parse(done).state).toBe("approved");
    return SIGNED_IN_AS(done);
  };
  const outside = (method: string, path: string, opts: { session?: Signed; body?: unknown } = {}) =>
    raw(tunnel.port, method, path, { host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone) Safari",
      ...(opts.session ? { cookie: opts.session.cookie, [WEB_CSRF_HEADER]: csrfTokenFor(opts.session.sessionId) } : {}) }, opts.body === undefined ? undefined : JSON.stringify(opts.body));
  /** The owner's authenticator, set up on this computer; the link opened; a session from outside with the app's code. */
  const outsideOwner = async (s: Signed): Promise<Signed> => {
    const begun = parse(await local(s, "POST", "/ui/outside/enroll", {}));
    const key = base32Decode(begun.secret)!;
    expect((await local(s, "POST", "/ui/outside/enroll/confirm", { code: hotp(key, totpStep(Date.now()) - 1) })).status).toBe(200);
    expect((await local(s, "POST", "/ui/outside/switch", { on: true })).status).toBe(200);
    await vi.waitFor(() => expect(fm.getPublicWebStatus().state).toBe("open"));
    const r = await outside("POST", "/auth/totp", { body: { code: hotp(key, totpStep(Date.now())) } });
    expect(r.status).toBe(200);
    return SIGNED_IN_AS(r);
  };
  const sessionOf = (s: Signed, surface: "local" | "gateway" = "local") =>
    any.webSessions.authenticate(s.sessionId, tokenEpoch(token), { touch: false, surface, ...(surface === "gateway" ? { exposureId: any.publicWebLink.exposureId } : {}) }) as SessionRecord | null;
  /** A session made straight in the store: `via` "code" (none of host / device / authenticator), or a guest's. */
  const stored = (input: { tier?: "admin" | "guest"; surface?: "local" | "gateway"; label: string }): Signed => {
    const surface = input.surface ?? "local";
    const { sessionId } = any.webSessions.create({ tier: input.tier ?? "admin", surface, label: input.label, tokenEpoch: tokenEpoch(token),
      ...(input.tier === "guest" ? { owner: { adapterId: "discord", userId: "9" } } : {}), ...(surface === "gateway" ? { exposureId: any.publicWebLink.exposureId } : {}) });
    return { sessionId, cookie: `${surface === "gateway" ? fleetCookieName(WEB_SESSION_COOKIE_SECURE, token) : WEB_SESSION_COOKIE}=${sessionId}` };
  };
  const alive = async (s: Signed) => (await raw(port, "GET", "/auth/session", { cookie: s.cookie, origin })).status === 200;
  return { dir, fm, any, port, origin, token, tunnel, hostSignIn, local, device, deviceSession, outside, outsideOwner, sessionOf, stored, alive, infos };
}
type Fleet = Awaited<ReturnType<typeof startFleet>>;
const handleOf = (h: Fleet, s: Signed, surface: "local" | "gateway" = "local") => h.sessionOf(s, surface)!.handle;
const signOut = (h: Fleet, by: Signed, handle: string) => h.local(by, "POST", "/ui/devices/signout", { handle });
const list = async (h: Fleet, s: Signed) => parse(await h.local(s, "GET", "/ui/devices"));

describe("#3061 P2b: the device list", () => {
  it("lists this fleet's admin sessions with how each was approved and whether its owner is verified — and nothing that signs anyone in", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const remote = await h.outsideOwner(owner);                                           // via the authenticator, over the link
    const approved = await h.deviceSession(owner);                                        // via a device code
    const lan = await h.hostSignIn({ "x-forwarded-for": "192.168.1.9" });                 // the host's code, typed on the network
    const plain = h.stored({ label: "Plain code" });                                      // any other one-time code
    const guest = h.stored({ tier: "guest", label: "A guest" });
    const body = await list(h, owner);
    expect(body).toMatchObject({ webOnly: true, owner: true });
    const rows = body.devices as Array<Record<string, any>>;
    const by = (s: Signed, surface: "local" | "gateway" = "local") => rows.find(r => r.handle === handleOf(h, s, surface))!;
    // The same keys on every row, and none of them is a credential.
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["created", "current", "expiresAt", "handle", "label", "lastSeen", "ownerVerified", "surface", "via"]);
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/);
    for (const s of [owner, remote, approved, lan, plain, guest]) expect(JSON.stringify(body)).not.toContain(s.sessionId);
    // How, and whether the owner is verified (the §3 verdict for the session as it signs in).
    expect([by(owner).via, by(owner).ownerVerified, by(owner).current, by(owner).surface]).toEqual(["host", true, true, "local"]);
    expect([by(remote, "gateway").via, by(remote, "gateway").ownerVerified, by(remote, "gateway").surface]).toEqual(["totp", true, "gateway"]);
    expect([by(approved).via, by(approved).ownerVerified, by(approved).label]).toEqual(["device", false, "Chrome on Android"]);
    expect([by(lan).via, by(lan).ownerVerified]).toEqual(["host", false]);                // a host code used from the network is no owner
    expect([by(plain).via, by(plain).ownerVerified]).toEqual(["code", false]);
    // Exactly one is the reader's own; a guest's session is the Guests page's, not here.
    expect(rows.filter(r => r.current).map(r => r.handle)).toEqual([handleOf(h, owner)]);
    expect(rows.some(r => r.handle === handleOf(h, guest))).toBe(false);
    expect(rows.length).toBe(5);
    // Read as another session, the "current" mark moves with the reader.
    const asDevice = (await list(h, approved)).devices as Array<Record<string, any>>;
    expect(asDevice.filter(r => r.current).map(r => r.label)).toEqual(["Chrome on Android"]);
  }, 60_000);

  it("is the admin's list: a guest, the CLI's header token and a chat fleet get none — and a non-owner admin sees it but is told it may not end a device", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const approved = await h.deviceSession(owner);
    const guest = h.stored({ tier: "guest", label: "A guest" });
    // A guest never reaches the handler: the gate's guest scope refuses it first (the list names no one).
    const asGuest = await h.local(guest, "GET", "/ui/devices");
    expect([401, 403]).toContain(asGuest.status);
    expect(parse(asGuest)?.devices).toBeUndefined();
    const cli = await raw(h.port, "GET", "/ui/devices", { "x-agend-token": h.token, origin: h.origin });
    expect(parse(cli)?.devices ?? []).toEqual([]);
    const seen = await list(h, approved);
    expect(seen.owner).toBe(false);
    expect(seen.devices.length).toBe(2);
    const chat = await startFleet({ chat: true });
    const admin = chat.stored({ label: "chat admin" });
    expect(await list(chat, admin)).toEqual({ webOnly: false, owner: false, authority: false, devices: [] });
  }, 40_000);

  it("the methods themselves hand nothing to a guest (the gate's guest scope stops one first; this is the second line)", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const guest = h.stored({ tier: "guest", label: "A guest" });
    const asked = (s: Signed) => ({ method: "GET", headers: { cookie: s.cookie, host: `127.0.0.1:${h.port}` }, socket: { remoteAddress: "127.0.0.1" } });
    expect(h.any.webDevicesStatus(asked(guest))).toEqual({ webOnly: true, owner: false, authority: true, devices: [] });
    expect(h.any.webDevicesStatus(asked(owner)).devices.map((r: { label: string }) => r.label).sort()).toEqual([h.sessionOf(owner)!.label]);
    expect(h.any.webDeviceSignOut(asked(guest), handleOf(h, owner))).toEqual({ status: 403, body: { error: "owner_required" } });
    expect(await h.alive(owner)).toBe(true);
  }, 30_000);

  it("describes a session by what its record carries (display only: authority never reads it)", () => {
    expect(sessionVia({})).toBe("code");
    expect(sessionVia({ host: true })).toBe("host");
    expect(sessionVia({ via: "device" })).toBe("device");
    expect(sessionVia({ remote: "totp" })).toBe("totp");
    // A session from before `via` existed is described the same way — nothing is migrated.
    expect(sessionVia({ host: true, via: "device" })).toBe("device");                     // (never made: the store refuses the mix)
  });
});

describe("#3061 P2b: ending another device — only the verified owner, on every way in", () => {
  it("the owner ends a device with POST /ui/devices/signout: it is signed out at once, its authorization goes with it, the list and the log say so", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const remote = await h.outsideOwner(owner);
    const approved = await h.deviceSession(owner);
    const remoteHandle = handleOf(h, remote, "gateway"), approvedHandle = handleOf(h, approved);
    expect(h.any.sessionAuthorizationStore().get(remoteHandle)).toBeTruthy();             // the one from outside holds an authorization
    const res = await signOut(h, owner, approvedHandle);
    expect([res.status, parse(res)]).toEqual([200, { ok: true }]);
    expect(await h.alive(approved)).toBe(false);
    expect(h.sessionOf(approved)).toBeNull();
    expect(((await list(h, owner)).devices as Array<{ handle: string }>).some(r => r.handle === approvedHandle)).toBe(false);
    expect(h.infos.some(([o, m]) => m === "Device signed out by the owner" && o.handle === approvedHandle && o.by === handleOf(h, owner).slice(0, 8) && o.via === "device")).toBe(true);
    // …and one with an authorization loses it as well.
    expect((await signOut(h, owner, remoteHandle)).status).toBe(200);
    expect(h.any.sessionAuthorizationStore().get(remoteHandle)).toBeFalsy();
    expect(h.sessionOf(remote, "gateway")).toBeNull();
    expect(await h.alive(owner)).toBe(true);                                              // the owner's own is untouched
  }, 60_000);

  it("a session that is not the owner — a device approval's, the host's code from the network, a plain one, a guest, none, the CLI's token — is refused 403 BEFORE any handle is looked up", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const approved = await h.deviceSession(owner);
    const lan = await h.hostSignIn({ "x-forwarded-for": "192.168.1.9" });
    const plain = h.stored({ label: "Plain code" });
    const guest = h.stored({ tier: "guest", label: "A guest" });
    const target = handleOf(h, owner), nobody = "f".repeat(16);
    for (const by of [approved, lan, plain]) {
      const real = await signOut(h, by, target), unknown = await signOut(h, by, nobody);
      expect([real.status, parse(real)], "a real handle").toEqual([403, { error: "owner_required" }]);
      expect([unknown.status, parse(unknown)], "no such handle: the same answer").toEqual([403, { error: "owner_required" }]);
    }
    // A guest is stopped before the handler (the gate's guest scope): refused, and nothing about any handle.
    for (const handle of [target, nobody]) {
      const g = await signOut(h, guest, handle);
      expect([401, 403]).toContain(g.status);
      expect(g.body).not.toContain("not_found");
    }
    expect(await h.alive(owner)).toBe(true);
    // No session: the gate; the CLI's header token is no session either.
    expect((await raw(h.port, "POST", "/ui/devices/signout", { origin: h.origin, "content-type": "application/json" }, JSON.stringify({ handle: target }))).status).toBe(401);
    const cli = await raw(h.port, "POST", "/ui/devices/signout", { "x-agend-token": h.token, origin: h.origin, "content-type": "application/json" }, JSON.stringify({ handle: target }));
    expect([401, 403]).toContain(cli.status);
    expect(await h.alive(owner)).toBe(true);
  }, 60_000);

  it("what it takes and what it ends: the owner's OWN session is not ended here, an unknown or a guest's handle is 404 (the guest lives), a malformed one 400, cross-site and a missing CSRF 403", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const guest = h.stored({ tier: "guest", label: "A guest" });
    const guestHandle = h.any.webSessions.list(undefined, (r: SessionRecord) => r.tier === "guest")[0].handle as string;
    const own = await signOut(h, owner, handleOf(h, owner));
    expect([own.status, parse(own)]).toEqual([400, { error: "this_device" }]);
    expect(await h.alive(owner)).toBe(true);
    expect((await signOut(h, owner, "f".repeat(16))).status).toBe(404);
    const g = await signOut(h, owner, guestHandle);
    expect([g.status, parse(g)]).toEqual([404, { error: "not_found" }]);
    expect(await h.alive(guest)).toBe(true);
    for (const bad of ["", "xyz", "F".repeat(16), "0".repeat(15), "0".repeat(17), 7, null, undefined]) {
      expect((await h.local(owner, "POST", "/ui/devices/signout", { handle: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    const target = h.stored({ label: "Plain code" });
    const targetHandle = handleOf(h, target);
    const noCsrf = await raw(h.port, "POST", "/ui/devices/signout", { cookie: owner.cookie, origin: h.origin, "content-type": "application/json" }, JSON.stringify({ handle: targetHandle }));
    const crossSite = await h.local(owner, "POST", "/ui/devices/signout", { handle: targetHandle }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect([noCsrf.status, crossSite.status]).toEqual([403, 403]);
    expect((await h.local(owner, "GET", "/ui/devices/signout")).status).not.toBe(200);
    expect(await h.alive(target)).toBe(true);
  }, 40_000);

  it("a sign-out the session file could not record is said so (500, not durable) — never 'ok': a restart may bring the device back", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const other = h.stored({ label: "Plain code" });
    vi.spyOn(h.any.webSessions, "persistNow").mockReturnValue(false);
    const res = await signOut(h, owner, handleOf(h, other));
    expect([res.status, parse(res)]).toEqual([500, { ok: false, durable: false, error: "not_durable" }]);
    expect(h.sessionOf(other)).toBeNull();                                                // gone from memory all the same
    expect(h.infos.some(([o, m]) => m === "Device signed out by the owner" && o.durable === false)).toBe(true);
  }, 30_000);

  it("THE OLDER WAY IN is closed the same: DELETE /auth/sessions/<handle> and DELETE /auth/sessions by a non-owner are 403 — while ending one's OWN session stays everyone's", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const approved = await h.deviceSession(owner);
    const plain = h.stored({ label: "Plain code" });
    const ownerHandle = handleOf(h, owner);
    // Told with the list, so the menu can hide its buttons; the owner's list says nothing of it.
    const asApproved = parse(await raw(h.port, "GET", "/auth/sessions", { cookie: approved.cookie, origin: h.origin }));
    const asOwner = parse(await raw(h.port, "GET", "/auth/sessions", { cookie: owner.cookie, origin: h.origin }));
    expect([asApproved.canEndOthers, asOwner.canEndOthers]).toEqual([false, undefined]);
    expect(asApproved.sessions.every((s: Record<string, unknown>) => typeof s.via === "string")).toBe(true);
    for (const by of [approved, plain]) {
      const one = await h.local(by, "DELETE", `/auth/sessions/${ownerHandle}`);
      const none = await h.local(by, "DELETE", `/auth/sessions/${"f".repeat(16)}`);
      const all = await h.local(by, "DELETE", "/auth/sessions");
      expect([one.status, parse(one)]).toEqual([403, { error: "owner_required" }]);
      expect([none.status, parse(none)], "an unknown handle: the same answer").toEqual([403, { error: "owner_required" }]);
      expect([all.status, parse(all)]).toEqual([403, { error: "owner_required" }]);
    }
    for (const s of [owner, approved, plain]) expect(await h.alive(s)).toBe(true);
    // Its own: a sign-out, allowed.
    const self = await h.local(approved, "DELETE", `/auth/sessions/${handleOf(h, approved)}`);
    expect([self.status, parse(self).current]).toEqual([200, true]);
    expect(await h.alive(approved)).toBe(false);
    // The owner ends another with the old route as ever, and everyone's with the other.
    expect((await h.local(owner, "DELETE", `/auth/sessions/${handleOf(h, plain)}`)).status).toBe(200);
    expect(await h.alive(plain)).toBe(false);
    const another = h.stored({ label: "Another" });
    expect([(await h.local(owner, "DELETE", "/auth/sessions")).status, await h.alive(another), await h.alive(owner)]).toEqual([200, false, false]);
  }, 60_000);

  it("the owner's authority is asked of the LIVE session: with web authorization off nobody is the owner, so nobody ends another device here (the CLI's `agend web-token rotate` is the way)", async () => {
    const h = await startFleet({ web: { verified_authority: { enabled: false } } });
    const owner = await h.hostSignIn();
    const other = h.stored({ label: "Plain code" });
    const body = await list(h, owner);
    expect(body.owner).toBe(false);
    expect(body.authority).toBe(false);                                                   // …and the page is told why, to say so (settings-devices-3061)
    expect((body.devices as Array<{ ownerVerified: boolean }>).every(r => !r.ownerVerified)).toBe(true);
    expect((await signOut(h, owner, handleOf(h, other))).status).toBe(403);
    expect((await h.local(owner, "DELETE", `/auth/sessions/${handleOf(h, other)}`)).status).toBe(403);
    expect(await h.alive(other)).toBe(true);
    // Switched back on, the same session is the owner again only if it was authorized then — one that signed in while it was off was not.
    h.any.fleetConfig.web.verified_authority.enabled = true;
    expect([(await list(h, owner)).owner, (await list(h, owner)).authority]).toEqual([false, true]);   // on again; this session is still no owner
    expect((await signOut(h, owner, handleOf(h, other))).status).toBe(403);
    const fresh = await h.hostSignIn();
    expect((await signOut(h, fresh, handleOf(h, other))).status).toBe(200);
  }, 60_000);

  it("a session that LOSES owner authority loses the right at once: 'Only this computer can authorize' turns the owner from outside into a non-owner", async () => {
    const h = await startFleet();
    const host = await h.hostSignIn();
    const remote = await h.outsideOwner(host);
    const victim = h.stored({ label: "Plain code" });
    const before = await h.outside("POST", "/ui/devices/signout", { session: remote, body: { handle: "f".repeat(16) } });
    expect(before.status).toBe(404);                                                      // the owner: past the check, nothing there
    h.any.fleetConfig.web.verified_authority.loopback_only = true;
    const after = await h.outside("POST", "/ui/devices/signout", { session: remote, body: { handle: handleOf(h, victim) } });
    expect([after.status, parse(after)]).toEqual([403, { error: "owner_required" }]);
    expect(await h.alive(victim)).toBe(true);
  }, 60_000);

  it("the owner signed in from outside may end a device over the public link — through the gateway's manifest; a session over the link that is not the owner may not", async () => {
    const h = await startFleet();
    const host = await h.hostSignIn();
    const remote = await h.outsideOwner(host);
    expect(isPublicWebRoute("POST", "/ui/devices/signout")).toBe(true);
    expect(isPublicWebRoute("GET", "/ui/devices/signout")).toBe(false);
    const approved = await h.deviceSession(host);
    const rows = parse(await h.outside("GET", "/ui/devices", { session: remote })).devices as Array<{ handle: string; current: boolean; via: string }>;
    expect(rows.find(r => r.current)!.via).toBe("totp");
    const ok = await h.outside("POST", "/ui/devices/signout", { session: remote, body: { handle: handleOf(h, approved) } });
    expect([ok.status, parse(ok)]).toEqual([200, { ok: true }]);
    expect(await h.alive(approved)).toBe(false);
    const plain = h.stored({ surface: "gateway", label: "Plain over the link" });
    const refused = await h.outside("POST", "/ui/devices/signout", { session: plain, body: { handle: handleOf(h, host) } });
    expect([refused.status, parse(refused)]).toEqual([403, { error: "owner_required" }]);
    const refusedOld = await h.outside("DELETE", `/auth/sessions/${handleOf(h, host)}`, { session: plain });
    expect(refusedOld.status).toBe(403);
    expect(await h.alive(host)).toBe(true);
  }, 60_000);

  it("a fleet with a chat connection is as it was: no such route (404), an admin still ends the others with the old routes", async () => {
    const h = await startFleet({ chat: true });
    const a = h.stored({ label: "chat admin A" }), b = h.stored({ label: "chat admin B" }), c = h.stored({ label: "chat admin C" });
    const res = await signOut(h, a, handleOf(h, b));
    expect([res.status, parse(res)]).toEqual([404, { error: "not_found" }]);
    expect(await h.alive(b)).toBe(true);
    const asA = parse(await raw(h.port, "GET", "/auth/sessions", { cookie: a.cookie, origin: h.origin }));
    expect(asA.canEndOthers).toBeUndefined();
    expect((await h.local(a, "DELETE", `/auth/sessions/${handleOf(h, b)}`)).status).toBe(200);
    expect(await h.alive(b)).toBe(false);
    expect((await h.local(a, "DELETE", "/auth/sessions")).status).toBe(200);
    expect(await h.alive(c)).toBe(false);
  }, 40_000);
});

describe("#3061 P2b: the sign-in page's QR switch (web.login_qr)", () => {
  const page = async (h: Fleet, via: "local" | "link" = "local") =>
    (via === "link" ? await h.outside("GET", "/signin") : await raw(h.port, "GET", "/signin", {})).body;

  it("marked only on a web-only fleet's own listener, while device sign-in is offered AND the option is on — off by default", async () => {
    const off = await startFleet();
    expect(await page(off)).toContain('data-device-login="1"');
    expect(await page(off)).not.toContain("data-login-qr");
    const on = await startFleet({ web: { login_qr: true } });
    const html = await page(on);
    expect(html).toContain('data-device-login="1"');
    expect(html).toContain('data-login-qr="1"');
    // The gate's own sign-in page (a browser navigation with no cookie) carries the same marks.
    const gated = await raw(on.port, "GET", "/settings/access", { accept: "text/html" });
    expect(gated.status).toBe(401);
    expect(gated.body).toContain('data-login-qr="1"');
  }, 30_000);

  it("never where no one could approve or no one should be offered it: over the public link, with web authorization off, on a chat fleet", async () => {
    const on = await startFleet({ web: { login_qr: true } });
    await on.hostSignIn().then(o => on.outsideOwner(o));
    const link = await page(on, "link");
    expect(link).not.toContain("data-login-qr");
    expect(link).not.toContain("data-device-login");
    const authOff = await startFleet({ web: { login_qr: true, verified_authority: { enabled: false } } });
    expect(await page(authOff)).not.toContain("data-login-qr");
    const chat = await startFleet({ chat: true, web: { login_qr: true } });
    expect(await page(chat)).not.toContain("data-login-qr");
    // Read per page served: switching it off takes it away at once.
    on.any.fleetConfig.web.login_qr = false;
    expect(await page(on)).not.toContain("data-login-qr");
  }, 60_000);
});
