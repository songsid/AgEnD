/**
 * S3c PR B (S-55): the member's pairing backend over S1 (pairing-api.ts), as Sentinel and web-claude specified.
 * - Projections only of what is known: pending's Hub confirmations are null (unknown), never derived from the local
 *   fingerprint receipt (localConfirmed); paired from the profile (spkiSha256, origins, no name; link injected, else
 *   offline); malformed or orphaned private state holds, never reads as unpaired.
 * - The claim loop: only after an exact "pending", one generation, sequential and bounded; any unknown outcome holds
 *   unknown_outcome and stops; cancel invalidates the generation before clearing.
 * - Disconnect: fence, tombstone (profile kept), withdraw every exposure, remote "pending"; Start over → unpaired with the
 *   old binding retired (never reconnected), and a new pairing with the same Hub is shown as pending, not the old profile.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHubMemberPairingApi, httpsOrigin } from "../src/hub/member/pairing-api.js";

const homes: string[] = [];
afterEach(() => { homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })); });

function rig(over: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "s3c-pair-")); homes.push(home); chmodSync(home, 0o700);
  const hubId = randomUUID(), digest = "f".repeat(64);
  let now = 1_800_000_000_000, expires = now + 600_000, profileRev = 0;
  const dir = () => { mkdirSync(join(home, "hub-member", hubId), { recursive: true, mode: 0o700 }); return join(home, "hub-member", hubId); };
  const pending = () => ({ hub: { hubId, memberOrigin: "https://hub.test", webOrigin: "https://web.hub.test", spkiSha256: "a".repeat(64) }, fingerprint: digest, expiresAt: expires });
  const begin = vi.fn(async (i: { current(): boolean }) => { if (!i.current()) throw Object.assign(Error("stale"), { code: "stale" }); writeFileSync(join(dir(), "pending.json"), "{}", { mode: 0o600 }); return pending() as any; });
  const answers: Array<"pending" | "paired" | "fail"> = [];
  const claim = vi.fn(async () => {
    const a = answers.shift() ?? "pending";
    if (a === "fail") throw Object.assign(Error("uncertain"), { code: "unavailable" });
    if (a === "paired") { writeFileSync(join(dir(), "pairing.json"), `{"rev":${++profileRev}}`, { mode: 0o600 }); unlinkSync(join(dir(), "pending.json")); }
    return { status: a };
  });
  const profiles = () => ({
    readProfile: () => ({ hub: { hubId, memberOrigin: "https://hub.test", webOrigin: "https://web.hub.test", spkiSha256: "a".repeat(64) } }) as any,
    readPending: () => pending() as any,
    profileDigest: () => (existsSync(join(home, "hub-member", hubId, "pairing.json")) ? `p${profileRev}` : null),
    clearPending: () => unlinkSync(join(dir(), "pending.json")),
  });
  const fence = vi.fn(), withdrawAll = vi.fn(async () => {});
  let link: "online" | "offline" = "offline";
  const sleeps: number[] = [];
  const api = createHubMemberPairingApi({ home, begin: begin as any, claim: claim as any, profiles: profiles as any, fence, withdrawAll, link: () => link,
    now: () => now, sleep: async (ms) => { sleeps.push(ms); }, pollMs: 5000, maxPolls: 10, ...over });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { home, hubId, digest, api, begin, claim, answers, fence, withdrawAll, sleeps, flush, setLink: (l: typeof link) => { link = l; }, expire: () => { expires = now - 1; } };
}
const yes = () => true;

describe("the member's pairing backend", () => {
  it("connect: the address and code are checked here; then pending — the Hub's confirmations unknown (null), the local receipt false", async () => {
    const r = rig();
    expect(r.api.view()).toEqual({ state: "unpaired" });
    expect(await r.api.connect({ address: "http://hub.test", code: "abcdef012345" }, yes)).toEqual({ ok: false, error: "address" });
    expect(await r.api.connect({ address: "https://hub.test/path", code: "abcdef012345" }, yes)).toEqual({ ok: false, error: "address" });
    expect(await r.api.connect({ address: "https://hub.test", code: "nope" }, yes)).toEqual({ ok: false, error: "code" });
    const ok = await r.api.connect({ address: "https://hub.test", code: "ABCD-EF01-2345" }, yes);
    expect(ok).toEqual({ ok: true, pairing: { state: "pending", memberOrigin: "https://hub.test", fingerprint: { kind: "pairing", digest: r.digest }, expiresAt: expect.any(Number),
      ownerConfirmed: null, adminApproved: null, localConfirmed: false } });
    expect((r.begin.mock.calls as any)[0][0]).toMatchObject({ memberOrigin: "https://hub.test", code: "abcdef012345" });
    expect(await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes)).toEqual({ ok: false, error: "busy" });
    expect([httpsOrigin("https://a.test/"), httpsOrigin("https://u:p@a.test"), httpsOrigin("https://a.test?x=1")]).toEqual(["https://a.test", null, null]);
  });
  it("S1's refusals map without claiming more than they say: conflict busy, unavailable unreachable, the rest refused", async () => {
    for (const [code, error] of [["conflict", "busy"], ["unavailable", "unreachable"], ["denied", "refused"], ["stale", "refused"]]) {
      const r = rig({ begin: vi.fn(async () => { throw Object.assign(Error(code), { code }); }) });
      expect(await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes)).toEqual({ ok: false, error });
      expect(r.api.view()).toEqual({ state: "unpaired" });
    }
  });
  it("the local fingerprint check: a receipt (never ownerConfirmed); the claim polls after exact pending only, then paired", async () => {
    const r = rig();
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    expect(await r.api.confirmFingerprint("0".repeat(64), yes)).toEqual({ ok: false, error: "conflict" });
    r.answers.push("pending", "pending", "paired");
    const c = await r.api.confirmFingerprint(r.digest, yes);
    expect(c).toMatchObject({ ok: true, pairing: { state: "pending", localConfirmed: true, ownerConfirmed: null, adminApproved: null } });
    await r.flush();
    expect(r.claim).toHaveBeenCalledTimes(3);
    expect(r.sleeps).toEqual([5000, 5000]);
    expect((r.claim.mock.calls as any)[0][0]).toMatchObject({ hubId: r.hubId, approvedFingerprint: r.digest, expectedProfileDigest: null });
    expect(r.api.view()).toEqual({ state: "paired", hub: { hubId: r.hubId, name: null, memberOrigin: "https://hub.test", webOrigin: "https://web.hub.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "offline" });
    r.setLink("online");
    expect(r.api.view()).toMatchObject({ state: "paired", link: "online" });
  });
  it("an unknown claim outcome holds and stops (no retry); bounded: no more than maxPolls", async () => {
    const r = rig();
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("pending", "fail", "paired");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(r.claim).toHaveBeenCalledTimes(2);
    expect(r.api.view()).toMatchObject({ state: "held", hold: "unknown_outcome", memberOrigin: "https://hub.test" });
    const b = rig({ maxPolls: 3 });
    await b.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    await b.api.confirmFingerprint(b.digest, yes); await b.flush();
    expect(b.claim).toHaveBeenCalledTimes(3);
  });
  it("cancel invalidates the in-flight claim first, then clears the local pending; an expired one holds and refuses confirmation", async () => {
    const r = rig({ sleep: () => new Promise(() => {}) });                       // the poll parks in its wait
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("pending", "paired");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(r.claim).toHaveBeenCalledTimes(1);
    expect(r.api.cancel()).toEqual({ state: "unpaired" });
    const e = rig();
    await e.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    e.expire();
    expect(e.api.view()).toMatchObject({ state: "held", hold: "expired" });
    expect(await e.api.confirmFingerprint(e.digest, yes)).toEqual({ ok: false, error: "expired" });
    expect(e.api.cancel()).toEqual({ state: "unpaired" });
  });
  it("disconnect: fence, tombstone (profile kept), every exposure withdrawn, remote pending; Start over retires the binding; a new pairing with the same Hub shows pending", async () => {
    const r = rig();
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("paired");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(r.api.view().state).toBe("paired");
    expect(await r.api.disconnect()).toEqual({ ok: true, remote: "pending" });
    expect([r.fence, r.withdrawAll].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    expect(existsSync(join(r.home, "hub-member", r.hubId, "pairing.json"))).toBe(true);
    expect(r.api.view()).toEqual({ state: "held", hold: "disconnected", memberOrigin: "https://hub.test" });
    expect(r.api.disconnected()).toBe(true);
    expect(await r.api.disconnect()).toEqual({ ok: false, error: "conflict" });
    expect(r.api.cancel()).toEqual({ state: "unpaired" });                       // Start over
    expect(r.api.disconnected(r.hubId)).toBe(true);                             // the old profile never reconnects
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    expect(r.api.view()).toMatchObject({ state: "pending", localConfirmed: false });
  });
  it("private state that is missing or malformed holds (never unpaired); a failed exposure withdrawal is unsaved", async () => {
    const r = rig();
    mkdirSync(join(r.home, "hub-member", r.hubId), { recursive: true, mode: 0o700 });
    expect(r.api.view()).toEqual({ state: "unpaired" });                        // an empty directory is nothing
    writeFileSync(join(r.home, "hub-member", r.hubId, "pairing.json"), "{}", { mode: 0o600 });
    expect(r.api.view()).toEqual({ state: "held", hold: "unsaved" });            // Hub files with no state: held
    writeFileSync(join(r.home, "hub-member", "state.json"), "{nope", { mode: 0o600 });
    expect(r.api.view()).toEqual({ state: "held", hold: "unsaved" });
    const w = rig({ withdrawAll: vi.fn(async () => { throw Error("disk"); }) });
    await w.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    w.answers.push("paired");
    await w.api.confirmFingerprint(w.digest, yes); await w.flush();
    expect(await w.api.disconnect()).toEqual({ ok: false, error: "unsaved" });
    expect(w.api.disconnected()).toBe(true);                                    // fenced and tombstoned all the same
  });
});

describe("the pairing routes", async () => {
  const { EventEmitter } = await import("node:events");
  const { handleSettingsRequest } = await import("../src/settings-api.js");
  const { createSettingsReplay } = await import("../src/settings-request-capability.js");
  const { SettingsExecution } = await import("../src/settings-transaction.js");
  const { bindGatewayRequest } = await import("../src/web-request-context.js");
  const { isSettingsMutation, prepareSettingsEffect } = await import("../src/settings-effect.js");
  const { pairingSummary } = await import("../src/hub-pairing-summary.js");
  async function call(o: { method: string; path: string; json?: unknown; replay?: boolean; admin?: boolean; gateway?: boolean; api: unknown }) {
    const raw = Buffer.from(JSON.stringify(o.json ?? {}));
    const cap = new SettingsExecution({ current: () => true, snapshot: () => null });
    const req: any = o.replay ? createSettingsReplay({ method: o.method, url: o.path, body: raw, binding: "owned", localAdmin: () => o.admin !== false }, cap)
      : Object.assign(new EventEmitter(), { method: o.method, url: o.path, headers: o.admin === false ? {} : { "x-agend-token": "tok" } });
    if (o.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "scratch", expectedOrigin: "https://scratch.invalid", isCurrent: () => true });
    const ctx = { webToken: "tok", webSessions: null, fleetConfig: { instances: {} }, logger: { warn: vi.fn() }, hubMemberPairing: () => o.api };
    const out = await new Promise<{ status: number; body: any }>((resolve) => {
      let status = 0;
      const res = { writeHead(v: number) { status = v; }, setHeader() {}, end(v: string) { resolve({ status, body: JSON.parse(v) }); } };
      expect(handleSettingsRequest(req, res as never, new URL(o.path, "http://localhost"), ctx as never)).toBe(true);
      if (!o.replay) { req.emit("data", raw); req.emit("end"); }
    });
    cap.close();
    return out;
  }
  it("connect, confirm and disconnect are Settings mutations (the owner confirms them); cancel and the projection are not", () => {
    for (const s of ["connect", "confirm", "disconnect"]) expect(isSettingsMutation("POST", `/api/hub/member/pairing/${s}`)).toBe(true);
    expect([isSettingsMutation("POST", "/api/hub/member/pairing/cancel"), isSettingsMutation("GET", "/api/hub/member/pairing")]).toEqual([false, false]);
    const pending = { state: "pending", memberOrigin: "https://hub.test", fingerprint: { kind: "pairing", digest: "ab".repeat(32) }, expiresAt: 9, ownerConfirmed: null, adminApproved: null, localConfirmed: false } as const;
    const ctx = (view: any) => ({ config: null, classic: {}, hubPairing: (a: any, i: unknown) => pairingSummary(a, i, view) });
    expect(prepareSettingsEffect("POST", "/api/hub/member/pairing/connect", { address: "https://hub.test", code: "x" }, ctx({ state: "unpaired" })).diff!.summary[0]).toBe("Connect this fleet to the Hub at https://hub.test");
    expect(prepareSettingsEffect("POST", "/api/hub/member/pairing/confirm", { digest: "ab".repeat(32) }, ctx(pending)).diff!.summary[1]).toBe("abab abab abab abab abab abab abab abab");
    expect(() => prepareSettingsEffect("POST", "/api/hub/member/pairing/confirm", { digest: "cd".repeat(32) }, ctx(pending))).toThrow(expect.objectContaining({ status: 409, code: "conflict" }));
    expect(() => prepareSettingsEffect("POST", "/api/hub/member/pairing/connect", { address: "http://x" }, ctx({ state: "unpaired" }))).toThrow(expect.objectContaining({ code: "address" }));
    expect(() => prepareSettingsEffect("POST", "/api/hub/member/pairing/connect", {}, { config: null, classic: {} })).toThrow(expect.objectContaining({ status: 404 }));
  });
  it("the routes: the projection and cancel for the admin only; the steps only as a confirmed replay; never over the public link; none composed: 404", async () => {
    const api = { view: vi.fn(() => ({ state: "unpaired" })), cancel: vi.fn(() => ({ state: "unpaired" })), connect: vi.fn(async () => ({ ok: true, pairing: { state: "pending" } })),
      confirmFingerprint: vi.fn(async () => ({ ok: false, error: "conflict" })), disconnect: vi.fn(async () => ({ ok: true, remote: "pending" })) };
    expect(await call({ method: "GET", path: "/api/hub/member/pairing", api })).toEqual({ status: 200, body: { ok: true, pairing: { state: "unpaired" } } });
    expect((await call({ method: "GET", path: "/api/hub/member/pairing", admin: false, api })).status).toBe(403);
    expect((await call({ method: "GET", path: "/api/hub/member/pairing", gateway: true, api })).status).toBe(403);
    expect((await call({ method: "POST", path: "/api/hub/member/pairing/cancel", admin: false, api })).status).toBe(403);
    expect((await call({ method: "POST", path: "/api/hub/member/pairing/cancel", api })).status).toBe(200);
    expect((await call({ method: "POST", path: "/api/hub/member/pairing/connect", json: { address: "https://hub.test", code: "abcdef012345" }, api })).status).toBe(403);
    expect((await call({ method: "POST", path: "/api/hub/member/pairing/connect", json: {}, replay: true, gateway: true, api })).status).toBe(403);
    expect(await call({ method: "POST", path: "/api/hub/member/pairing/connect", json: { address: "https://hub.test", code: "abcdef012345" }, replay: true, api })).toMatchObject({ status: 200, body: { ok: true } });
    expect((api.connect.mock.calls as any)[0][0]).toEqual({ address: "https://hub.test", code: "abcdef012345" });
    expect(await call({ method: "POST", path: "/api/hub/member/pairing/confirm", json: { digest: "x" }, replay: true, api })).toMatchObject({ status: 409, body: { ok: false, error: "conflict" } });
    expect(await call({ method: "POST", path: "/api/hub/member/pairing/disconnect", replay: true, api })).toMatchObject({ status: 200, body: { ok: true, remote: "pending" } });
    expect(await call({ method: "GET", path: "/api/hub/member/pairing", api: null })).toMatchObject({ status: 404, body: { error: "unavailable" } });
  });
});

describe("the claim loop's edges (mutation review)", () => {
  it("cancel during the wait: the parked poll wakes and claims nothing more (its generation is gone)", async () => {
    let wake: (() => void) | null = null;
    const r = rig({ sleep: () => new Promise<void>((ok) => { wake = ok; }) });
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("pending", "paired");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(r.claim).toHaveBeenCalledTimes(1);
    r.api.cancel();
    wake!(); await r.flush();
    expect(r.claim).toHaveBeenCalledTimes(1);
    expect(r.api.view()).toEqual({ state: "unpaired" });
  });
  it("an answer that is neither pending nor paired stops the loop", async () => {
    const claim = vi.fn(async () => ({ status: "weird" }));
    const r = rig({ claim });
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
