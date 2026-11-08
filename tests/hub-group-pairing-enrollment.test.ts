/** Real pairing, transport floor, SQLite and group/audit libraries. Inert directory/session callbacks, no HTTP/native claim. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubPairingService } from "../src/hub/pairing.js";
import { HubTransportStore, HUB_TRANSPORT_MIGRATION } from "../src/hub/store.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import type { HubDirectory, HubRequestContext, PersonKey } from "../src/hub/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
const key = (): PersonKey => ({ realm: "example", objectId: randomUUID() });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  for (const m of [HUB_TRANSPORT_MIGRATION, HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "gen-1"), HUB_GROUP_RESOURCES_MIGRATION]) m.up(db);
  let floor = 0, now = 100, enabled = true;
  const owner = key(), administrator = key(), group = key(), other = key(), clock = () => now;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: clock });
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } }, appendAudit: (event, tx) => append(event, tx) }); store.initialize();
  const eligible = vi.fn(async (person: PersonKey) => ({ eligible: true as const, person: { key: person, login: "morgan", dn: "CN=Morgan,DC=example,DC=test", groups: [] } }));
  const read = vi.fn(async (person: PersonKey): Promise<PolicyGroupFacts> => ({ kind: "complete", person, groups: [group.objectId], observedAt: now }));
  const directory: HubDirectory = { realm: "example", groupPolicy: "ad-direct-guid", signIn: vi.fn(), checkEligibility: eligible, readPolicyGroups: read, close: vi.fn() };
  const current = () => enabled, policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "gen-1", directory,
    audit: { appendInTransaction: append }, current, now: clock });
  const groups = createHubGroupAuthorization({ db, administrator, policy: () => policy,
    binding: () => inspectHubGroupPolicyBinding(db, "hub-1", "example", "gen-1"), audit: { appendInTransaction: append }, current, now: clock,
    version: () => store.read().revocationVersion, advanceAuthorization: () => { throw Error("enrollment must not advance version"); }, refreshAuthorization: () => { throw Error("enrollment must not refresh links"); } });
  const resources = createHubGroupResources({ db, policy, audit: { appendInTransaction: append }, current, now: clock });
  const prepare = vi.fn(groups.prepareEnrollment), atomic = vi.fn();
  const service = new HubPairingService({ store, directory, enabled: current, now: clock, fenceFleet: vi.fn(),
    enrollment: { prepare, atomic: work => { atomic(); return db.transaction(() => work(db)).immediate(); } },
    identity: { hubId: randomUUID(), memberOrigin: "https://hub.example.test:9443", webOrigin: "https://hub.example.test:8443", spkiSha256: "a".repeat(64), issuerPublicKey: "public" } });
  const ctx: HubRequestContext = { requestId: randomUUID(), current: vi.fn(), requirePerson: async () => owner,
    requireAdmin: async () => ({ kind: "directory", person: administrator, sessionId: "admin" }) };
  const action = { requestId: randomUUID(), current };
  const enable = (maxFleets = 1) => policy.replace({ ...policy.read(), state: "enabled", groups: [{ group, dn: "CN=Members,DC=example,DC=test", allow: ["pair_fleet"], maxFleets }] }, administrator, action);
  const pending = async () => {
    const offer = await service.create(ctx, owner), pair = service.pair({ code: offer.code });
    return { ...pair, input: { pairingId: pair.pairingId, fleetId: pair.fleetId, claimSecret: pair.claimSecret }, resource: { kind: "fleet" as const, id: pair.fleetId, revision: 1, owner } };
  };
  const approved = async () => { const p = await pending(); await service.confirmOwner(ctx, p.pairingId, p.fingerprint); await service.approve(ctx, p.pairingId, p.fingerprint); return p; };
  const mutate = (work: Parameters<typeof store.mutate>[1]) => store.mutate({ at: now, requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.change", result: "completed" }, work);
  const raw = () => JSON.parse((db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state) as ReturnType<typeof store.read>;
  return { db, store, directory, eligible, owner, administrator, group, other, audit, append, groups, resources, policy, read, prepare, atomic, service, ctx, action,
    enable, pending, approved, mutate, raw, off: () => { enabled = false; }, expire: () => { now += 600_001; } };
}
describe("group enrollment with an actual pairing credential", () => {
  it("keeps legacy pairing membership-free and creates no provenance", async () => {
    const w = fixture(), p = await w.approved(), result = await w.service.claim(p.input);
    expect(result.status).toBe("approved"); expect(w.read).not.toHaveBeenCalled(); expect(w.resources.read(p.resource)).toBeNull(); expect(w.atomic).toHaveBeenCalledOnce();
  });
  it("commits the approved fingerprint's fleet, credential, group provenance and registration audit together", async () => {
    const w = fixture(); w.enable(); const p = await w.approved(), result = await w.service.claim(p.input);
    expect(result.status).toBe("approved"); if (result.status !== "approved") throw Error("positive claim refused");
    expect(w.service.authenticate(result.credential)).toMatchObject({ fleetId: p.fleetId, owner: w.owner });
    expect(w.resources.read(p.resource)).toMatchObject({ source: "group", state: "active" }); expect(w.atomic).toHaveBeenCalledOnce();
    expect(w.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.registered'").all()).toHaveLength(1);
    expect(w.audit.verifyChain()).toMatchObject({ ok: true }); await expect(w.service.claim(p.input)).rejects.toThrow();
  });
  it.each(["unknown", "denied"] as const)("refuses %s membership without issuing any fleet or provenance", async kind => {
    const w = fixture(); w.enable(); const p = await w.approved();
    w.read.mockImplementation(async person => kind === "unknown" ? { kind: "unknown" } : { kind: "complete", person, groups: [w.other.objectId], observedAt: 100 });
    await expect(w.service.claim(p.input)).rejects.toThrow(kind === "unknown" ? "unavailable" : "denied");
    expect(w.store.read().fleets).toEqual([]); expect(w.resources.read(p.resource)).toBeNull(); expect(w.atomic).not.toHaveBeenCalled();
    expect(w.db.prepare("SELECT action,result FROM hub_audit WHERE action='pairing.claimed'").all()).toEqual([{ action: "pairing.claimed", result: "denied" }]);
  });
  it.each(["unknown", "quota"] as const)("retains the existing durable claim throttle for %s refusals", async reason => {
    const w = fixture(); w.enable();
    if (reason === "quota") { const first = await w.approved(); expect((await w.service.claim(first.input)).status).toBe("approved"); }
    const p = await w.approved(); if (reason === "unknown") w.read.mockResolvedValue({ kind: "unknown" });
    const beforeReads = w.read.mock.calls.length;
    for (let i = 0; i < 60; i++) await expect(w.service.claim(p.input)).rejects.toThrow();
    expect(w.read.mock.calls.length - beforeReads).toBe(60); const revision = w.store.read().revision;
    await expect(w.service.claim(p.input)).rejects.toThrow("denied");
    expect(w.store.read().revision).toBe(revision); expect(w.read.mock.calls.length - beforeReads).toBe(60);
    expect(w.resources.read(p.resource)).toBeNull();
  });
  it("does not consult groups or issue a fleet before both ordinary confirmations", async () => {
    const w = fixture(); w.enable(); const p = await w.pending();
    expect(await w.service.claim(p.input)).toEqual({ status: "pending" }); await w.service.confirmOwner(w.ctx, p.pairingId, p.fingerprint);
    expect(await w.service.claim(p.input)).toEqual({ status: "pending" }); expect(w.read).not.toHaveBeenCalled(); expect(w.prepare).not.toHaveBeenCalled(); expect(w.store.read().fleets).toEqual([]);
  });
  it.each([false, true])("keeps the original eligible owner bound across the ordinary directory await (groups enabled=%s)", async enabled => {
    const w = fixture(); if (enabled) w.enable(); const p = await w.approved(), held = gate<Awaited<ReturnType<typeof w.eligible>>>(), entered = gate<PersonKey>();
    w.eligible.mockImplementationOnce(person => { entered.resolve(person); return held.promise; }); const work = w.service.claim(p.input), person = await entered.promise;
    w.mutate(state => { state.pairings.find(row => row.id === p.pairingId)!.owner = w.other; });
    held.resolve({ eligible: true, person: { key: person, login: "morgan", dn: "CN=Morgan,DC=example,DC=test", groups: [] } });
    await expect(work).rejects.toThrow("denied"); expect(w.raw().fleets).toEqual([]); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
  });
  it("counts an existing manual/legacy fleet against the owner's new group limit", async () => {
    const w = fixture(), first = await w.approved(); expect((await w.service.claim(first.input)).status).toBe("approved");
    w.enable(); const second = await w.approved(); await expect(w.service.claim(second.input)).rejects.toThrow("denied");
    expect(w.store.read().fleets).toHaveLength(1); expect(w.resources.read(second.resource)).toBeNull();
  });
  it("rechecks the owner count inside the transaction so concurrent claims cannot exceed the limit", async () => {
    const w = fixture(); w.enable(); const a = await w.approved(), b = await w.approved();
    const results = await Promise.allSettled([w.service.claim(a.input), w.service.claim(b.input)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(w.store.read().fleets).toHaveLength(1);
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toHaveLength(1);
  });
  it("does not count a revoked fleet against the owner's active limit", async () => {
    const w = fixture(); w.enable(); const first = await w.approved(); expect((await w.service.claim(first.input)).status).toBe("approved");
    await w.service.revoke(w.ctx, first.fleetId); const second = await w.approved(); expect((await w.service.claim(second.input)).status).toBe("approved");
    expect(w.store.read().fleets.filter(f => f.status === "active")).toHaveLength(1);
  });
  it.each(["server", "expired", "policy", "epoch", "offer", "owner"] as const)("refuses a held membership continuation after %s changes", async changed => {
    const w = fixture(); w.enable(); const p = await w.approved(), entered = gate<PersonKey>(), held = gate<PolicyGroupFacts>();
    w.read.mockImplementationOnce(person => { entered.resolve(person); return held.promise; }); const work = w.service.claim(p.input), person = await entered.promise;
    if (changed === "server") w.off(); else if (changed === "expired") w.expire();
    else if (changed === "policy") w.policy.replace({ ...w.policy.read(), state: "suspended" }, w.administrator, w.action);
    else w.mutate(s => { if (changed === "epoch") s.revocationVersion++; else if (changed === "offer") s.pairings.find(x => x.id === p.pairingId)!.state = "revoked";
      else s.pairings.find(x => x.id === p.pairingId)!.owner = w.other; });
    held.resolve({ kind: "complete", person, groups: [w.group.objectId], observedAt: 100 }); await expect(work).rejects.toThrow();
    expect(w.raw().fleets).toEqual([]); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
  });
  it.each(["pairing.claimed", "group-resource.registered"])("rolls back fleet and provenance when required %s audit fails, preserving the uncertain floor", async action => {
    const w = fixture(); w.enable(); const p = await w.approved();
    w.append.mockImplementation((event, tx) => { if (event.action === action) throw Error("audit unavailable"); return w.audit.appendInTransaction(event, tx); });
    await expect(w.service.claim(p.input)).rejects.toThrow(); expect(w.raw().fleets).toEqual([]); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    expect(() => w.store.read()).toThrow("uncertain");
  });
  it.each(["pairing.claimed", "group-resource.registered"])("withholds issuance after lifetime invalidation during %s audit", async action => {
    const w = fixture(); w.enable(); const p = await w.approved();
    w.append.mockImplementation((event, tx) => { const id = w.audit.appendInTransaction(event, tx); if (event.action === action) w.off(); return id; });
    await expect(w.service.claim(p.input)).rejects.toThrow(); expect(w.raw().fleets).toEqual([]); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    expect(() => w.store.read()).toThrow("uncertain");
  });
  it.each(["owner", "approval", "fingerprint", "generation", "credential"] as const)("rechecks the actual %s binding after a registration audit reenters ordinary state", async changed => {
    const w = fixture(); w.enable(); const p = await w.approved();
    w.append.mockImplementation((event, tx) => {
      const id = w.audit.appendInTransaction(event, tx);
      if (event.action === "group-resource.registered") {
        const state = w.raw();
        if (changed === "owner") state.fleets[0]!.owner = w.other;
        else if (changed === "approval") state.pairings[0]!.adminApproved = false;
        else if (changed === "fingerprint") state.pairings[0]!.fingerprint = "b".repeat(64);
        else if (changed === "generation") state.fleets[0]!.generation = 2;
        else state.fleets[0]!.credentialHash = "b".repeat(64);
        w.db.prepare("UPDATE hub_transport_state SET state=?").run(JSON.stringify(state));
      }
      return id;
    });
    await expect(w.service.claim(p.input)).rejects.toThrow("unavailable"); expect(w.raw().fleets).toEqual([]); expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
  });
});
