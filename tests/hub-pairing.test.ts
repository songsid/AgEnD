import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
import { HubPairingService, displayHubFingerprint, hubPairingFingerprint } from "../src/hub/pairing.js";
import type { HubDirectory, HubRequestContext } from "../src/hub/types.js";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(":memory:"); databases.push(db); migrateHubTransportStore(db);
  let floor = 0, now = 1_800_000_000_000, enabled = true, auditFailed = false;
  db.exec("CREATE TABLE audit (record TEXT)");
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } }, appendAudit: (event, tx) => {
    if (auditFailed) throw Error("full"); tx.prepare("INSERT INTO audit VALUES(?)").run(JSON.stringify(event));
  } }); store.initialize();
  const owner = { realm: "directory", objectId: randomUUID() };
  const directory: HubDirectory = { realm: "directory", signIn: vi.fn(), checkEligibility: vi.fn(async () => ({ eligible: true as const, person: { key: owner, login: "owner", dn: "private", groups: [] } })), close: vi.fn() };
  const ctx: HubRequestContext = { requestId: randomUUID(), current: vi.fn(), requirePerson: vi.fn(async () => owner), requireAdmin: vi.fn(async () => ({ kind: "local-host" as const, sessionId: randomUUID(), directoryBinding: owner })) };
  const identity = { hubId: randomUUID(), memberOrigin: "https://hub.test:9443", webOrigin: "https://hub.test:9444", spkiSha256: "a".repeat(64), issuerPublicKey: "public" };
  const fence = vi.fn(), service = new HubPairingService({ store, directory, identity, enabled: () => enabled, now: () => now, fenceFleet: fence });
  const pair = async () => { const offer = await service.create(ctx, owner); const pending = service.pair({ code: offer.code }); return { offer, pending }; };
  const approve = async () => { const x = await pair(); await service.confirmOwner(ctx, x.pending.pairingId, x.pending.fingerprint); await service.approve(ctx, x.pending.pairingId, x.pending.fingerprint); return x; };
  return { db, store, service, ctx, directory, owner, identity, fence, pair, approve, setNow: (n: number) => { now = n; }, off: () => { enabled = false; }, failAudit: () => { auditFailed = true; }, setFloor: (n: number) => { floor = n; } };
}
describe("Hub pairing authorization and durable state", () => {
  it("requires owner AND admin comparison, issues once, stores no usable secret", async () => {
    const f = fixture(), { offer, pending } = await f.pair();
    expect(offer.code).toMatch(/^[a-f0-9]{12}$/); expect(pending.claimSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(displayHubFingerprint(pending.fingerprint)).toMatch(/^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
    expect(() => f.service.pair({ code: offer.code })).toThrow();
    const input = { pairingId: pending.pairingId, fleetId: pending.fleetId, claimSecret: pending.claimSecret };
    await expect(f.service.claim(input)).resolves.toEqual({ status: "pending" });
    await expect(f.service.approve(f.ctx, pending.pairingId, pending.fingerprint)).rejects.toThrow();
    await f.service.confirmOwner(f.ctx, pending.pairingId, pending.fingerprint);
    await expect(f.service.claim(input)).resolves.toEqual({ status: "pending" });
    await f.service.approve(f.ctx, pending.pairingId, pending.fingerprint);
    const claimed = await f.service.claim(input); expect(claimed.status).toBe("approved");
    if (claimed.status !== "approved") throw Error();
    expect(f.service.authenticate(claimed.credential).fleetId).toBe(pending.fleetId);
    await expect(f.service.claim(input)).rejects.toThrow(); // lost claim response is never silently re-issued
    const all = JSON.stringify(f.db.prepare("SELECT * FROM hub_transport_state").all()) + JSON.stringify(f.db.prepare("SELECT * FROM audit").all());
    for (const secret of [offer.code, pending.claimSecret, claimed.credential]) expect(all).not.toContain(secret);
  });
  it("binds the complete fingerprint and rejects another claim/person", async () => {
    const f = fixture(), x = await f.pair();
    const altered = hubPairingFingerprint({ ...f.identity, webOrigin: "https://other.test" }, x.pending.pairingId, f.owner, "b".repeat(64));
    expect(altered).not.toBe(x.pending.fingerprint);
    await expect(f.service.confirmOwner({ ...f.ctx, requirePerson: async () => ({ ...f.owner, objectId: randomUUID() }) }, x.pending.pairingId, x.pending.fingerprint)).rejects.toThrow();
    await expect(f.service.claim({ pairingId: x.pending.pairingId, fleetId: randomUUID(), claimSecret: x.pending.claimSecret })).rejects.toThrow();
  });
  it("freshly checks eligibility and rechecks mode after asynchronous directory work", async () => {
    const f = fixture(), x = await f.approve();
    vi.mocked(f.directory.checkEligibility).mockResolvedValue({ eligible: false, reason: "disabled" });
    await expect(f.service.claim({ pairingId: x.pending.pairingId, fleetId: x.pending.fleetId, claimSecret: x.pending.claimSecret })).rejects.toThrow();
    vi.mocked(f.directory.checkEligibility).mockImplementation(async () => { f.off(); return { eligible: true, person: { key: f.owner, login: "owner", dn: "private", groups: [] } }; });
    await expect(f.service.create(f.ctx, f.owner)).rejects.toThrow();
  });
  it("persists throttle without locking out a separately issued valid code", async () => {
    const f = fixture(), valid = await f.service.create(f.ctx, f.owner);
    for (let i = 0; i < 15; i++) expect(() => f.service.pair({ code: "0".repeat(12) })).toThrow();
    expect(f.store.read().buckets.length).toBe(1);
    expect(f.service.pair({ code: valid.code }).pairingId).toBe(valid.pairingId);
  });
  it("fences replaced links and rejects a revoked credential at every future connect", async () => {
    const f = fixture(), x = await f.approve();
    const claim = await f.service.claim({ pairingId: x.pending.pairingId, fleetId: x.pending.fleetId, claimSecret: x.pending.claimSecret });
    if (claim.status !== "approved") throw Error();
    const a = await f.service.connect(claim.credential), b = await f.service.connect(claim.credential);
    expect(b.linkEpoch).toBeGreaterThan(a.linkEpoch); expect(f.fence).toHaveBeenCalledWith(claim.fleetId, "replaced");
    await f.service.revoke(f.ctx, claim.fleetId);
    expect(() => f.service.authenticate(claim.credential)).toThrow(); await expect(f.service.connect(claim.credential)).rejects.toThrow();
  });
  it("fails closed on audit failure and monotonic floor mismatch", async () => {
    const f = fixture(); await f.service.create(f.ctx, f.owner); f.failAudit();
    await expect(f.service.create(f.ctx, f.owner)).rejects.toThrow(); expect(() => f.store.read()).toThrow();
    const other = fixture(); other.setFloor(10); expect(() => other.store.read()).toThrow();
  });
  it("never renews an expired offer or silently resets a corrupt existing store", async () => {
    const f = fixture(), offer = await f.service.create(f.ctx, f.owner); f.setNow(offer.expiresAt);
    expect(() => f.service.pair({ code: offer.code })).toThrow();
    const broken = fixture(); broken.db.prepare("UPDATE hub_transport_state SET state=?").run('{"v":1,"v":1}');
    expect(() => broken.store.read()).toThrow(); expect(() => broken.store.initialize()).toThrow();
  });
});
