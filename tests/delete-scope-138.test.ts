/**
 * AGEND-138 / PR #3553 review (P2 1): the two DELETE routes must not turn a FAILED live check of the caller into "no restriction".
 * auth-api authenticates the caller once, then asks the fleet for the ownership rule (sessionEndRule, which authenticates again). If
 * the caller expires between the two, the rule is null: that is a denial (401), never an unrestricted scope — `undefined` is kept
 * for the deliberate no-narrowing paths (a web-only fleet, a non-admin). And the ownership predicate is enforced at the deletion
 * itself, not only in a lookup before it: a pending record (hidden from findByHandle, not from revokeByHandle) of another admin
 * must not be deletable through its handle.
 * A real FleetManager (chat fleet) over HTTP with a real WebSessionStore on an injected clock; the interleaving is made by moving the
 * clock inside the fleet's own second check (a wrapper around endableSessions), so caller A is valid at t=1000 and expired at t=1002.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } from "../src/web-auth.js";

const dirs: string[] = [], stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const s of stops.splice(0)) await s().catch(() => {}); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

function raw(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    r.on("error", reject); r.end();
  });
}

async function chatFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-138-del-")); dirs.push(dir);
  const fm = new FleetManager(dir), any = fm as any, q = () => {};
  fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } },
    channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } } as never;
  any.initializeWebAuthTokens(); any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = (any.healthServer as Server).address() as { port: number }, origin = `http://127.0.0.1:${port.port}`, token = fm.getDashboardAccess().token!;
  stops.push(() => new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); }));
  const clock = { t: 1000 };
  const store = new WebSessionStore({ now: () => clock.t });
  any.webSessions = store;
  const make = (userId: string, opts: { pending?: boolean; expiresAt?: number } = {}) => {
    const made = store.create({ tier: "admin", surface: "local", label: `admin ${userId}`, tokenEpoch: tokenEpoch(token), owner: { adapterId: "tg", userId }, ...(opts.pending ? { pending: true } : {}) });
    if (opts.expiresAt !== undefined) { (made.record as any).absoluteExpiry = opts.expiresAt; (made.record as any).idleExpiry = opts.expiresAt; }
    return { sessionId: made.sessionId, cookie: `${WEB_SESSION_COOKIE}=${made.sessionId}`, handle: made.record.handle };
  };
  const del = (s: { cookie: string; sessionId: string }, path: string) =>
    raw(port.port, "DELETE", path, { cookie: s.cookie, origin, "sec-fetch-site": "same-origin", [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId) });
  /** The fleet's own second check (the ownership rule) reads the clock AFTER auth-api's first authentication. */
  const expireDuringRequest = (at: number) => {
    const real = any.endableSessions.bind(fm);
    vi.spyOn(any, "endableSessions").mockImplementation((req: unknown) => { clock.t = at; return real(req); });
  };
  const alive = (handle: string) => store.findByHandle(handle) !== null;
  return { fm, any, store, clock, make, del, expireDuringRequest, alive };
}

describe("PR #3553 review: a failed live check of the caller is a denial, not 'no restriction'", () => {
  it("DELETE /auth/sessions/<handle>: the caller expires between the two checks → refused, the other admin's session lives (own-account, still-valid control: ends)", async () => {
    const h = await chatFleet();
    const a = h.make("1", { expiresAt: 1001 }), b = h.make("2");
    h.expireDuringRequest(1002);
    const res = await h.del(a, `/auth/sessions/${b.handle}`);
    expect([res.status, h.alive(b.handle)]).toEqual([401, true]);
    // The positive control, with the same wrapper in place and a caller that is still valid at t=1002: its own device ends; another admin's does not.
    h.clock.t = 1000;
    const a1 = h.make("1"), a2 = h.make("1");
    const ok = await h.del(a1, `/auth/sessions/${a2.handle}`);
    expect([ok.status, h.alive(a2.handle)]).toEqual([200, false]);
    const other = await h.del(a1, `/auth/sessions/${b.handle}`);
    expect([other.status, JSON.parse(other.body)]).toEqual([403, { error: "other_admin" }]);
    expect(h.alive(b.handle)).toBe(true);
  }, 30_000);

  it("DELETE /auth/sessions: the caller expires between the two checks → refused, nothing is revoked (own-account, still-valid control: ends its own, not the other admin's)", async () => {
    const h = await chatFleet();
    const a = h.make("1", { expiresAt: 1001 }), b = h.make("2");
    h.expireDuringRequest(1002);
    const res = await h.del(a, "/auth/sessions");
    expect([res.status, h.alive(b.handle)]).toEqual([401, true]);
    h.clock.t = 1000;
    const a1 = h.make("1"), a2 = h.make("1");
    const ok = await h.del(a1, "/auth/sessions");
    expect(ok.status).toBe(200);
    expect([h.alive(a1.handle), h.alive(a2.handle), h.alive(b.handle)]).toEqual([false, false, true]);
  }, 30_000);

  it("a PENDING session of another admin cannot be deleted through its handle (the predicate is enforced at the deletion, not only in a lookup); the caller's own pending one can", async () => {
    const h = await chatFleet();
    const a = h.make("1"), pendingB = h.make("2", { pending: true }), pendingA = h.make("1", { pending: true });
    const size = h.store.size;
    const res = await h.del(a, `/auth/sessions/${pendingB.handle}`);
    expect([res.status, h.store.size]).toEqual([404, size]);
    // …and DELETE /auth/sessions spares it too.
    expect((await h.del(a, "/auth/sessions")).status).toBe(200);
    expect([...(h.store as any).byHash.values()].some((r: { handle: string }) => r.handle === pendingB.handle)).toBe(true);
    expect([...(h.store as any).byHash.values()].some((r: { handle: string }) => r.handle === pendingA.handle)).toBe(false);   // the same account's own pending one went with it
  }, 30_000);
});
