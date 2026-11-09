/**
 * AGEND-138 (server): "Revoke other devices' authorization" on a real fleet over HTTP.
 * - Only the verified owner may revoke: a sign-in that is not one (a device-code or one-time-code sign-in, a host session
 *   from another machine) gets 403 `owner_required` and nothing moves; the overview says so (`you.canRevoke`).
 * - The owner's revoke moves the epoch, but the owner's own session is authorized again under the new epoch at once (same
 *   end as before) and stays verified; every other session's authorization ends and stored receipts read as none.
 * - A chat fleet: the same rule — an admin that is not web-verified is refused.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

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
  const dir = temp("agend-138-");
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } }, ...config } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  const stop = () => new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); });
  const login = async (code: string, extra: Record<string, string> = {}) => {
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin, ...extra }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    const set = res.headers["set-cookie"]; const cookie = (Array.isArray(set) ? set[0] : set)!.split(";")[0]!;
    const sessionId = cookie.split("=")[1]!;
    return { cookie, sessionId, record: any.webSessions.authenticate(sessionId, tokenEpoch(token), { touch: false }) as SessionRecord };
  };
  /** `agend web --code`'s request, then the browser's sign-in (extra headers: where it signs in from). */
  const hostSignIn = async (extra: Record<string, string> = {}) =>
    login(JSON.parse((await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).body).code as string, extra);
  /** A device-code sign-in (what a device the owner approved gets): an admin session, never an owner. */
  const deviceSession = () => {
    const made = any.webSessions.create({ tier: "admin", surface: "local", label: "Chrome on Android", tokenEpoch: tokenEpoch(token), via: "device" });
    return { cookie: `agend_session=${made.sessionId}`, sessionId: made.sessionId as string, record: made.record as SessionRecord };
  };
  const auth = (s: { cookie: string; sessionId: string }) => ({ cookie: s.cookie, origin, [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId), "content-type": "application/json" });
  const status = async (s: { cookie: string }) => JSON.parse((await raw(port, "GET", "/ui/authorization", { cookie: s.cookie })).body);
  const overview = async (s: { cookie: string }, extra: Record<string, string> = {}) => JSON.parse((await raw(port, "GET", "/api/settings/web-authority", { cookie: s.cookie, ...extra })).body);
  const revoke = async (s: { cookie: string; sessionId: string }, extra: Record<string, string> = {}) => {
    const r = await raw(port, "POST", "/api/settings/web-authority/revoke", { ...auth(s), ...extra }, "{}");
    return { status: r.status, body: JSON.parse(r.body) };
  };
  return { fm, any, port, origin, token, stop, hostSignIn, deviceSession, status, overview, revoke, epoch: () => fm.webAuthorityState().epoch };
}

describe("AGEND-138: only the verified owner may revoke (web-only fleet)", () => {
  it("a device-approved sign-in is refused with 403 owner_required, the overview says it can't, and nothing moves", async () => {
    const h = await startFleet();
    try {
      const owner = await h.hostSignIn();
      const device = h.deviceSession();
      const before = h.epoch();
      expect((await h.overview(owner)).you).toEqual({ handle: owner.record.handle, canRevoke: true });
      expect((await h.overview(device)).you).toEqual({ handle: device.record.handle, canRevoke: false });
      expect(await h.revoke(device)).toEqual({ status: 403, body: { error: "owner_required" } });
      expect([h.epoch(), (await h.status(owner)).state]).toEqual([before, "verified"]);
    } finally { await h.stop(); }
  }, 20_000);

  it("a host sign-in made from another machine (never authorized) is refused too, and so is a host session used from there", async () => {
    const h = await startFleet();
    try {
      const outsider = await h.hostSignIn({ "x-forwarded-for": "10.0.0.9" });
      const before = h.epoch();
      expect(await h.revoke(outsider)).toEqual({ status: 403, body: { error: "owner_required" } });
      const owner = await h.hostSignIn();
      expect((await h.revoke(owner, { "x-forwarded-for": "10.0.0.9" })).status).toBe(403);            // the owner's cookie, from another machine
      expect(h.epoch()).toBe(before);
    } finally { await h.stop(); }
  }, 20_000);

  it("no session at all is 401 (as before); over the public link it is never offered", async () => {
    const h = await startFleet();
    try {
      expect((await raw(h.port, "POST", "/api/settings/web-authority/revoke", { origin: h.origin, "content-type": "application/json" }, "{}")).status).toBe(401);
    } finally { await h.stop(); }
  }, 20_000);
});

describe("AGEND-138: the owner's revoke keeps the owner", () => {
  it("epoch +1; the owner is verified again at once with the same end; another host session and a stored receipt read as none", async () => {
    const h = await startFleet();
    try {
      const owner = await h.hostSignIn(), other = await h.hostSignIn();
      expect([(await h.status(owner)).state, (await h.status(other)).state]).toEqual(["verified", "verified"]);
      const store = h.any.sessionAuthorizationStore();
      const until = store.get(owner.record.handle).until, authorizedAt = store.get(owner.record.handle).authorizedAt;
      const stored = h.fm.webAuthority({ session: other.record, gateway: false, peer: "loopback" }).authority;   // a receipt written before the revoke
      const ownerStored = h.fm.webAuthority({ session: owner.record, gateway: false, peer: "loopback" }).authority;
      expect([stored.kind, ownerStored.kind]).toEqual(["web-verified", "web-verified"]);
      const before = h.epoch();

      const done = await h.revoke(owner);
      expect(done).toEqual({ status: 200, body: { ok: true, epoch: before + 1, durable: true, kept: true } });
      expect(h.epoch()).toBe(before + 1);

      // The owner: verified under the new epoch, the end it already had.
      expect((await h.status(owner)).state).toBe("verified");
      expect(store.get(owner.record.handle)).toMatchObject({ epoch: before + 1, until, authorizedAt });
      expect(h.fm.webAuthority({ session: owner.record, gateway: false, peer: "loopback" }).authority.kind).toBe("web-verified");
      expect((await h.overview(owner)).you.canRevoke).toBe(true);
      expect((await h.overview(owner)).authorized.map((a: { handle: string }) => a.handle)).toEqual([owner.record.handle]);
      // Everyone else: no authorization, and the old receipts read as none.
      expect([(await h.status(other)).state, (await h.status(other)).reason]).toEqual(["none", "host_sign_in"]);
      expect(store.get(other.record.handle)?.epoch === before + 1).toBe(false);
      expect(h.fm.receiptAuthorityNow(stored)).toMatchObject({ kind: "none", downgraded: "revoked" });
      expect(h.fm.receiptAuthorityNow(ownerStored)).toMatchObject({ kind: "none", downgraded: "revoked" });    // a receipt from before is none for the owner too…
      expect(h.fm.webAuthority({ session: owner.record, gateway: false, peer: "loopback" }).authority.authority_epoch).toBe(before + 1);   // …new ones carry the new epoch
    } finally { await h.stop(); }
  }, 20_000);

  it("the other host session signs in again on this computer and is verified again (Re-bind's end result)", async () => {
    const h = await startFleet();
    try {
      const owner = await h.hostSignIn(), other = await h.hostSignIn();
      await h.revoke(owner);
      expect((await h.status(other)).reason).toBe("host_sign_in");
      const again = await h.hostSignIn();
      expect((await h.status(again)).state).toBe("verified");
    } finally { await h.stop(); }
  }, 20_000);

  it("the revoke without a session to keep (the settings of a header-token caller, or /dashboard revoke) is as before: everyone ends", async () => {
    const h = await startFleet();
    try {
      const owner = await h.hostSignIn();
      h.fm.revokeWebAuthority();
      expect((await h.status(owner)).reason).toBe("host_sign_in");
    } finally { await h.stop(); }
  }, 20_000);
});

describe("AGEND-138: a fleet with a chat connection", () => {
  it("an admin sign-in that is not web-verified (the host's own code: no account) is refused; nothing moves", async () => {
    const h = await startFleet(CHAT);
    try {
      const admin = await h.hostSignIn();
      const before = h.epoch();
      expect((await h.overview(admin)).you.canRevoke).toBe(false);
      expect(await h.revoke(admin)).toEqual({ status: 403, body: { error: "owner_required" } });
      expect(h.epoch()).toBe(before);
    } finally { await h.stop(); }
  }, 20_000);

  it("an admin whose account confirmed in chat (web-verified) may revoke, stays verified, and another confirmed admin ends", async () => {
    const h = await startFleet(CHAT);
    try {
      vi.spyOn(h.any, "adminGate").mockReturnValue("ok");
      const make = (userId: string) => {
        const made = h.any.webSessions.create({ tier: "admin", surface: "local", label: `acct ${userId}`, tokenEpoch: tokenEpoch(h.token), owner: { adapterId: "tg", userId } });
        const session = { cookie: `agend_session=${made.sessionId}`, sessionId: made.sessionId as string, record: made.record as SessionRecord };
        expect(h.fm.authorizeWebSession(session.record, "loopback", false).ok).toBe(true);
        return session;
      };
      const mine = make("1"), theirs = make("2");
      expect([(await h.status(mine)).state, (await h.status(theirs)).state]).toEqual(["verified", "verified"]);
      const before = h.epoch();
      expect((await h.revoke(mine)).body).toEqual({ ok: true, epoch: before + 1, durable: true, kept: true });
      expect([(await h.status(mine)).state, (await h.status(theirs)).state]).toEqual(["verified", "none"]);
    } finally { await h.stop(); }
  }, 20_000);
});
