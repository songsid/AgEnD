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
/** The pairing the page shows (what a disconnect is confirmed for). */
const shownOf = (api: { boundHub(): { hubId: string; binding: string | null } | null }) => { const b = api.boundHub()!; return { hubId: b.hubId, binding: b.binding }; };

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
    expect(r.api.view()).toEqual({ state: "paired", hub: { hubId: r.hubId, name: null, memberOrigin: "https://hub.test", webOrigin: "https://web.hub.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "offline",
      binding: expect.stringMatching(/^[0-9a-f]{64}$/) });
    r.setLink("online");
    expect(r.api.view()).toMatchObject({ state: "paired", link: "online" });
  });
  it("an unknown claim outcome holds and stops (no retry); bounded: no more than maxPolls", async () => {
    const r = rig();
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("pending", "fail", "paired");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(r.claim).toHaveBeenCalledTimes(2);
    expect(r.api.view()).toMatchObject({ state: "held", hold: "unknown_outcome", memberOrigin: "https://hub.test", hubId: r.hubId });
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
    expect(await r.api.disconnect({ hubId: randomUUID() })).toEqual({ ok: false, error: "conflict" });   // another Hub: never
    expect(await r.api.disconnect({ hubId: r.hubId })).toEqual({ ok: false, error: "conflict" });                // the pairing unnamed
    expect(await r.api.disconnect(shownOf(r.api))).toEqual({ ok: true, remote: "pending" });
    expect([r.fence, r.withdrawAll].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    expect(existsSync(join(r.home, "hub-member", r.hubId, "pairing.json"))).toBe(true);
    expect(r.api.view()).toEqual({ state: "held", hold: "disconnected", memberOrigin: "https://hub.test", hubId: r.hubId, binding: expect.any(String) });
    expect(r.api.disconnected(r.hubId)).toBe(true);
    expect(await r.api.disconnect(shownOf(r.api))).toEqual({ ok: false, error: "conflict" });
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
    expect(await w.api.disconnect(shownOf(w.api))).toEqual({ ok: false, error: "unsaved" });
    expect(w.api.disconnected(w.hubId)).toBe(true);                                    // fenced and tombstoned all the same
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
    expect(await call({ method: "GET", path: "/api/hub/member/pairing", api })).toEqual({ status: 200, body: { ok: true, pairing: { state: "unpaired" }, notices: [] } });
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

describe("Prism #3115 r1 (pairing)", () => {
  it("P1: the claim loop outlives the confirming request (its authority is the saved receipt), and ends when the receipt goes or hub_member is off", async () => {
    const r = rig();
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("pending", "pending", "paired");
    let open = true;
    await r.api.confirmFingerprint(r.digest, () => open);
    open = false;                                                     // the Settings change applied: its execution closed
    await r.flush();
    expect(r.claim).toHaveBeenCalledTimes(3);
    expect(r.api.view().state).toBe("paired");
    let on = true;
    const o = rig({ enabled: () => on });
    await o.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    let wake: (() => void) | null = null;
    const p = rig({ enabled: () => on, sleep: () => new Promise<void>((ok) => { wake = ok; }) });
    await p.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    p.answers.push("pending", "paired");
    await p.api.confirmFingerprint(p.digest, yes); await p.flush();
    on = false; wake!(); await p.flush();
    expect(p.claim).toHaveBeenCalledTimes(1);                         // hub_member off: no further claim
  });
  it("P4: cancel after an unknown outcome abandons the binding (retired, no retry) and a new pairing can start; a failed hold save still holds", async () => {
    const r = rig();
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("fail");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(r.api.view()).toMatchObject({ state: "held", hold: "unknown_outcome" });
    expect(await r.api.confirmFingerprint(r.digest, yes)).toEqual({ ok: false, error: "conflict" });
    expect(r.api.cancel()).toEqual({ state: "unpaired" });
    expect(r.claim).toHaveBeenCalledTimes(1);
    expect(r.api.disconnected(r.hubId)).toBe(true);
    expect((await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes)).ok).toBe(true);
    // The hold cannot be saved (the directory is read-only): the memory hold stands — no retry, no pending view.
    let fail: (() => void) | null = null;
    const w = rig({ claim: vi.fn(() => new Promise((_ok, no) => { fail = () => no(Object.assign(Error("uncertain"), { code: "unavailable" })); })) });
    await w.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    const { chmodSync } = await import("node:fs");
    const dir = join(w.home, "hub-member");
    const confirmed = await w.api.confirmFingerprint(w.digest, yes);
    expect(confirmed.ok).toBe(true);
    chmodSync(dir, 0o500);                                            // the hold's save will fail
    try {
      fail!(); await w.flush();
      expect(w.api.view()).toMatchObject({ state: "held", hold: "unknown_outcome" });
      expect(await w.api.confirmFingerprint(w.digest, yes)).toEqual({ ok: false, error: "conflict" });
    } finally { chmodSync(dir, 0o700); }
    expect(w.api.cancel()).toEqual({ state: "unpaired" });
  });
  it("P5: the reconnect predicate fails closed — no state, another hub, a held or disconnected binding all refuse", async () => {
    const r = rig();
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("paired");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(r.api.disconnected(r.hubId)).toBe(false);                  // the one consistent case
    expect(r.api.disconnected(randomUUID())).toBe(true);
    await r.api.disconnect(shownOf(r.api));
    unlinkSync(join(r.home, "hub-member", "state.json"));
    expect(r.api.view()).toEqual({ state: "held", hold: "unsaved" });
    expect(r.api.disconnected(r.hubId)).toBe(true);
  });
  it("P2: the disconnect confirmation names the exact Hub; another hub id is refused before anything is proposed", async () => {
    const { pairingSummary } = await import("../src/hub-pairing-summary.js");
    const paired = { state: "paired", hub: { hubId: "h1", name: null, memberOrigin: "https://a.test", webOrigin: "https://w.a.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "offline" } as const;
    const bound = { hubId: "h1", binding: "b".repeat(64) };
    expect(pairingSummary("disconnect", { hubId: "h1", binding: "b".repeat(64) }, paired, bound).summary[0]).toBe("Disconnect this fleet from the Hub at https://a.test (h1, pairing bbbbbbbbbbbb)");
    expect(() => pairingSummary("disconnect", { hubId: "h2", binding: "b".repeat(64) }, paired, bound)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => pairingSummary("disconnect", { hubId: "h1", binding: "c".repeat(64) }, paired, bound)).toThrow(expect.objectContaining({ code: "conflict" }));   // a re-pair
    expect(() => pairingSummary("disconnect", {}, paired, bound)).toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

describe("S5's seams (dev-claude): bindingChanged and currentBinding", () => {
  it("bindingChanged after a saved claim, a disconnect, a Start over, an abandonment and a cancel; currentBinding only for a current, connectable binding", async () => {
    const { currentBinding } = await import("../src/hub/member/pairing-api.js");
    const changed = vi.fn();
    const r = rig({ bindingChanged: changed });
    const prof = (home: string, hubId: string) => ({ readProfile: () => ({}) as any, profileDigest: () => (existsSync(join(home, "hub-member", hubId, "pairing.json")) ? "p1" : null) });
    expect(currentBinding(r.home, prof)).toBeNull();                                  // nothing yet
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    expect([changed.mock.calls.length, currentBinding(r.home, prof)]).toEqual([0, null]);   // pending is no binding
    r.answers.push("paired");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(currentBinding(r.home, prof)).toEqual({ hubId: r.hubId });
    await r.api.disconnect(shownOf(r.api));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(currentBinding(r.home, prof)).toBeNull();
    r.api.cancel();                                                                   // Start over
    expect(changed).toHaveBeenCalledTimes(3);
    expect(currentBinding(r.home, prof)).toBeNull();
    const c = rig({ bindingChanged: changed });
    await c.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    c.api.cancel();
    expect(changed).toHaveBeenCalledTimes(4);
    const u = rig({ bindingChanged: changed });
    await u.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    u.answers.push("fail");
    await u.api.confirmFingerprint(u.digest, yes); await u.flush();
    expect(currentBinding(u.home, prof)).toBeNull();                                  // held
    u.api.cancel();                                                                   // abandonment
    expect(changed).toHaveBeenCalledTimes(5);
    // S5's own throw never undoes the change.
    const t = rig({ bindingChanged: () => { throw Error("s5"); } });
    await t.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    expect(t.api.cancel()).toEqual({ state: "unpaired" });
  });
});

describe("Prism #3115 r2", () => {
  it("a disconnect confirmed for one pairing never applies to a re-pair of the same Hub (the saved profile changed)", async () => {
    const r = rig();
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    r.answers.push("paired");
    await r.api.confirmFingerprint(r.digest, yes); await r.flush();
    const shown = shownOf(r.api);
    writeFileSync(join(r.home, "hub-member", r.hubId, "pairing.json"), '{"rev":"re-paired"}', { mode: 0o600 });   // a new profile, same Hub
    const r2 = createHubMemberPairingApi({ home: r.home, profiles: (home: string, hubId: string) => ({ readProfile: () => ({ hub: { hubId, memberOrigin: "https://hub.test", webOrigin: "https://web.hub.test", spkiSha256: "a".repeat(64) } }) as any,
      readPending: () => { throw Error("none"); }, profileDigest: () => "p-new", clearPending: () => {} }) as any });
    expect(await r2.disconnect(shown)).toEqual({ ok: false, error: "conflict" });
    expect(await r2.disconnect(shownOf(r2))).toEqual({ ok: true, remote: "pending" });
  });
  it("a saved profile whose claim never finished settling holds for every reader — a fresh API, currentBinding, the reconnect predicate; a normal restart is paired", async () => {
    const { currentBinding } = await import("../src/hub/member/pairing-api.js");
    const { chmodSync } = await import("node:fs");
    let settle: (() => void) | null = null;
    const r = rig({ claim: vi.fn(() => new Promise((ok) => { settle = () => { writeFileSync(join(r.home, "hub-member", r.hubId, "pairing.json"), "{}", { mode: 0o600 }); ok({ status: "paired" }); }; })) });
    await r.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    await r.api.confirmFingerprint(r.digest, yes);
    const dir = join(r.home, "hub-member");
    chmodSync(dir, 0o500);                                            // the settlement (and the hold) cannot be saved
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    try { settle!(); await r.flush(); } finally { chmodSync(dir, 0o700); }
    await new Promise((x) => setTimeout(x, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();                         // the final write's failure is caught
    const prof = (home: string, hubId: string) => ({ readProfile: () => ({ hub: { hubId, memberOrigin: "https://hub.test", webOrigin: "https://web.hub.test", spkiSha256: "a".repeat(64) } }) as any,
      readPending: () => ({ hub: { hubId, memberOrigin: "https://hub.test" }, fingerprint: r.digest, expiresAt: Date.now() + 60_000 }) as any,
      profileDigest: () => "p1", clearPending: () => unlinkSync(join(home, "hub-member", hubId, "pending.json")) });
    const fresh = createHubMemberPairingApi({ home: r.home, profiles: prof as any });  // a restart: no memory
    expect(r.api.view()).toMatchObject({ state: "held", hold: "unknown_outcome" });
    expect(fresh.view()).toMatchObject({ state: "held", hold: "unknown_outcome" });
    expect(currentBinding(r.home, prof as any)).toBeNull();
    expect(fresh.disconnected(r.hubId)).toBe(true);
    // Recovery: abandon (Start over) retires it; a normal pairing afterwards settles and a restart sees it paired.
    expect(fresh.cancel()).toEqual({ state: "unpaired" });
    const ok = rig();
    await ok.api.connect({ address: "https://hub.test", code: "abcdef012345" }, yes);
    ok.answers.push("paired");
    await ok.api.confirmFingerprint(ok.digest, yes); await ok.flush();
    const prof2 = (home: string, hubId: string) => ({ ...prof(home, hubId), profileDigest: () => "p1" });
    const restarted = createHubMemberPairingApi({ home: ok.home, profiles: prof2 as any });
    expect(restarted.view().state).toBe("paired");
    expect(currentBinding(ok.home, prof2 as any)).toEqual({ hubId: ok.hubId });
  });
});

describe("currentBinding: each unfinished marker on its own", () => {
  it.each([["the pending claim left (its cleanup failed)", { pending: true, receipt: false }], ["the local receipt left (the settlement save failed)", { pending: false, receipt: true }], ["neither (settled)", { pending: false, receipt: false }]])(
    "%s", async (_name, o) => {
      const { currentBinding } = await import("../src/hub/member/pairing-api.js");
      const home = mkdtempSync(join(tmpdir(), "s3c-cb-")); homes.push(home); chmodSync(home, 0o700);
      const hubId = randomUUID(), dir = join(home, "hub-member", hubId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "pairing.json"), "{}", { mode: 0o600 });
      if (o.pending) writeFileSync(join(dir, "pending.json"), "{}", { mode: 0o600 });
      writeFileSync(join(home, "hub-member", "state.json"), JSON.stringify({ hubId, ...(o.receipt ? { localConfirmed: { digest: "f".repeat(64), at: 1 } } : {}) }), { mode: 0o600 });
      const prof = () => ({ readProfile: () => ({}) as any, profileDigest: () => "p1" });
      expect(currentBinding(home, prof as any)).toEqual(o.pending || o.receipt ? null : { hubId });
    });
});
