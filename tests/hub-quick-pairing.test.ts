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
  db.exec("CREATE TABLE test_notices (body TEXT)");
  const enqueue = vi.fn((database: Database.Database, notice: unknown) => { if(database!==db || !db.inTransaction) throw Error("notice outside owning transaction"); db.prepare("INSERT INTO test_notices VALUES(?)").run(JSON.stringify(notice)); });
  const committed = vi.fn(() => { if(db.inTransaction)throw Error("delivered before commit"); });
  const current = () => enabled, policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "gen-1", directory,
    audit: { appendInTransaction: append }, current, now: clock });
  const groups = createHubGroupAuthorization({ db, administrator, policy: () => policy,
    binding: () => inspectHubGroupPolicyBinding(db, "hub-1", "example", "gen-1"), audit: { appendInTransaction: append }, current, now: clock,
    version: () => store.read().revocationVersion, advanceAuthorization: () => { throw Error("enrollment must not advance version"); }, refreshAuthorization: () => { throw Error("enrollment must not refresh links"); } });
  const resources = createHubGroupResources({ db, policy, audit: { appendInTransaction: append }, current, now: clock });
  const prepare = vi.fn(groups.prepareEnrollment), atomic = vi.fn();
  const service = new HubPairingService({ store, directory, enabled: current, now: clock, fenceFleet: vi.fn(),
    quick: { enqueue, committed },
    enrollment: { prepare, atomic: work => { atomic(); return db.transaction(() => work(db)).immediate(); } },
    identity: { hubId: randomUUID(), memberOrigin: "https://hub.example.test:9443", webOrigin: "https://hub.example.test:8443", spkiSha256: "a".repeat(64), issuerPublicKey: "public" } });
  const ctx: HubRequestContext = { requestId: randomUUID(), isCurrent: () => true, current: async () => ({kind:"directory" as const,person:owner,sessionId:"owner-session"}), requirePerson: async () => owner,
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
  return { db, store, directory, eligible, owner, administrator, group, other, audit, append, groups, resources, policy, read, prepare, atomic, service, ctx, action, enqueue, committed,
    enable, pending, approved, mutate, raw, off: () => { enabled = false; }, expire: () => { now += 600_001; } };
}

describe("self-service pairing skips only the admin wait", () => {
  it("requires explicit group allowance even when manual pairing remains available", async () => {
    const w=fixture();
    await expect(w.service.createQuick(w.ctx,{label:"Lab"})).rejects.toThrow();
    expect(w.store.read().pairings).toEqual([]); expect(w.read).not.toHaveBeenCalled();
    w.enable(); const offer=await w.service.createQuick(w.ctx,{label:"Lab"});
    expect(offer.code).toMatch(/^[a-f0-9]{12}$/); expect(w.read).toHaveBeenCalledOnce();
    expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
    const p=w.service.pair({code:offer.code}),input={pairingId:p.pairingId,fleetId:p.fleetId,claimSecret:p.claimSecret};
    expect(await w.service.claim(input)).toEqual({status:"pending"}); expect(w.enqueue).not.toHaveBeenCalled();
    await expect(w.service.confirmOwner(w.ctx,p.pairingId,"0".repeat(64))).rejects.toThrow();
    await w.service.confirmOwner(w.ctx,p.pairingId,p.fingerprint);
    const before=w.read.mock.calls.length, result=await w.service.claim(input);
    expect(result.status).toBe("approved"); expect(w.read.mock.calls.length).toBeGreaterThan(before);
    expect(w.store.read().pairings[0]!.adminApproved).toBe(false); // do not manufacture an admin receipt
    expect(w.enqueue).toHaveBeenCalledOnce(); expect(w.committed).toHaveBeenCalledOnce();
    const notice=JSON.parse((w.db.prepare("SELECT body FROM test_notices").get() as {body:string}).body);
    expect(notice).toMatchObject({fleetId:p.fleetId,generation:1,owner:w.owner,label:"Lab",initiatingSessionId:"owner-session"});
    expect(w.resources.read({kind:"fleet",id:p.fleetId,revision:1,owner:w.owner})).toMatchObject({source:"group",state:"active"});
    await expect(w.service.claim(input)).rejects.toThrow();
  });
  it.each(["unknown","denied"] as const)("refuses %s at claim and can recover from unknown without resume", async mode => {
    const w=fixture();w.enable();const offer=await w.service.createQuick(w.ctx,{label:"Lab"}),p=w.service.pair({code:offer.code});
    await w.service.confirmOwner(w.ctx,p.pairingId,p.fingerprint);
    w.read.mockImplementation(async person=>mode==="unknown"?{kind:"unknown"}:{kind:"complete",person,groups:[],observedAt:100});
    const input={pairingId:p.pairingId,fleetId:p.fleetId,claimSecret:p.claimSecret};
    await expect(w.service.claim(input)).rejects.toThrow(mode==="unknown"?"unavailable":"denied");
    expect(w.store.read().fleets).toEqual([]);expect(w.enqueue).not.toHaveBeenCalled();
    if(mode==="unknown"){w.read.mockImplementation(async person=>({kind:"complete",person,groups:[w.group.objectId],observedAt:100}));expect((await w.service.claim(input)).status).toBe("approved");}
  });
  it("supersedes one own automatic offer without leaking reservations or accepting its old code", async()=>{
    const w=fixture();w.enable();const a=await w.service.createQuick(w.ctx,{label:"A"}),b=await w.service.createQuick(w.ctx,{label:"B"});
    expect(w.store.read().pairings).toHaveLength(1);expect(()=>w.service.pair({code:a.code})).toThrow();
    expect(w.service.pair({code:b.code}).pairingId).toBe(b.pairingId);
  });
  it("keeps manual offers, admin headroom and recent retained claims inside the table budget", async()=>{
    const w=fixture();w.enable(8);await w.service.create(w.ctx,w.owner);
    await expect(w.service.createQuick(w.ctx,{label:"Lab"})).rejects.toThrow();
    const many=fixture();many.enable(8);for(let i=0;i<48;i++)await many.service.create(many.ctx,key());
    await expect(many.service.createQuick(many.ctx,{label:"Lab"})).rejects.toThrow();
    for(let i=48;i<64;i++)await many.service.create(many.ctx,key());
    expect(many.store.read().pairings).toHaveLength(64);await expect(many.service.create(many.ctx,key())).rejects.toThrow();
  });
  it("admits concurrent owner requests with at most one counted reservation",async()=>{
    const w=fixture();w.enable();const offers=await Promise.all([w.service.createQuick(w.ctx,{label:"A"}),w.service.createQuick(w.ctx,{label:"B"})]);
    expect(w.store.read().pairings).toHaveLength(1);expect(offers).toHaveLength(2);
  });
  it("counts retained manual fleets against later self-service admission",async()=>{
    const w=fixture();
    // Pre-enable explicit admin approval is retained as manual provenance, not an automatic allowance.
    const first=await w.approved();expect((await w.service.claim(first.input)).status).toBe("approved");
    w.enable();await expect(w.service.createQuick(w.ctx,{label:"automatic"})).rejects.toThrow();
    expect(w.store.read().fleets).toHaveLength(1);
  });
  it("stops only the exact owned live offer and refuses a second person's Stop",async()=>{
    const w=fixture();w.enable();const offer=await w.service.createQuick(w.ctx,{label:"Lab"});
    await expect(w.service.stopQuick({...w.ctx,requirePerson:async()=>w.other},offer.pairingId)).rejects.toThrow();
    await w.service.stopQuick(w.ctx,offer.pairingId);expect(()=>w.service.pair({code:offer.code})).toThrow();
    expect(w.store.read().pairings.filter(p=>p.state==="offered"||p.state==="pending")).toEqual([]);
  });
  it("cannot return credentials when the required notice transaction fails",async()=>{
    const w=fixture();w.enable();const offer=await w.service.createQuick(w.ctx,{label:"Lab"}),p=w.service.pair({code:offer.code});
    await w.service.confirmOwner(w.ctx,p.pairingId,p.fingerprint);w.enqueue.mockImplementation(()=>{throw Error("notice full")});
    await expect(w.service.claim({pairingId:p.pairingId,fleetId:p.fleetId,claimSecret:p.claimSecret})).rejects.toThrow();
    expect(w.raw().fleets).toEqual([]);expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);expect(w.committed).not.toHaveBeenCalled();
  });
  it("rechecks the owner session after a held admission lookup",async()=>{
    const w=fixture();w.enable();let live=true;const held=gate<PolicyGroupFacts>(),entered=gate<boolean>();w.read.mockImplementationOnce(()=>{entered.resolve(true);return held.promise});
    const work=w.service.createQuick({...w.ctx,isCurrent:()=>live},{label:"Lab"}),failed=expect(work).rejects.toThrow();await entered.promise;live=false;held.resolve({kind:"complete",person:w.owner,groups:[w.group.objectId],observedAt:100});await failed;expect(w.raw().pairings).toEqual([]);
  });
});

describe("exact owner narrowing and asynchronous proof races",()=>{
  it("revokes only the exact owned fleet generation after pair permission is removed",async()=>{
    const w=fixture();w.enable(2);const make=async(label:string)=>{const o=await w.service.createQuick(w.ctx,{label}),p=w.service.pair({code:o.code});await w.service.confirmOwner(w.ctx,p.pairingId,p.fingerprint);const r=await w.service.claim({pairingId:p.pairingId,fleetId:p.fleetId,claimSecret:p.claimSecret});if(r.status!=="approved")throw Error("not approved");return r;};
    const a=await make("same"),b=await make("same");w.read.mockResolvedValue({kind:"complete",person:w.owner,groups:[],observedAt:100});
    await expect(w.service.revokeOwned({...w.ctx,requirePerson:async()=>w.other},a.fleetId,1)).rejects.toThrow();
    await expect(w.service.revokeOwned(w.ctx,a.fleetId,2)).rejects.toThrow();
    await w.service.revokeOwned(w.ctx,a.fleetId,1);
    expect(()=>w.service.authenticate(a.credential)).toThrow();expect(w.service.authenticate(b.credential).fleetId).toBe(b.fleetId);
  });
  it("does not publish a held claim after Stop or replacement",async()=>{
    const w=fixture();w.enable();const o=await w.service.createQuick(w.ctx,{label:"first"}),p=w.service.pair({code:o.code});await w.service.confirmOwner(w.ctx,p.pairingId,p.fingerprint);
    const held=gate<PolicyGroupFacts>(),entered=gate<boolean>();w.read.mockImplementationOnce(()=>{entered.resolve(true);return held.promise});
    const work=w.service.claim({pairingId:p.pairingId,fleetId:p.fleetId,claimSecret:p.claimSecret}),refused=expect(work).rejects.toThrow();await entered.promise;await w.service.stopQuick(w.ctx,p.pairingId);held.resolve({kind:"complete",person:w.owner,groups:[w.group.objectId],observedAt:100});await refused;expect(w.store.read().fleets).toEqual([]);expect(w.enqueue).not.toHaveBeenCalled();
  });
  it("cannot auto approve a legacy preparation or a disabled notice composition",async()=>{
    const w=fixture();w.enable();w.prepare.mockResolvedValueOnce({source:"legacy",maxFleets:8,assertCurrent(){},commit(){}});
    await expect(w.service.createQuick(w.ctx,{label:"Lab"})).rejects.toThrow("denied");expect(w.store.read().pairings).toEqual([]);
  });
  it("does not re-read groups indefinitely after exhausting the person's successful-offer budget",async()=>{
    const w=fixture();w.enable();for(let i=0;i<5;i++)await w.service.createQuick(w.ctx,{label:"Lab"});const reads=w.read.mock.calls.length;
    await expect(w.service.createQuick(w.ctx,{label:"Lab"})).rejects.toThrow("backpressure");expect(w.read.mock.calls.length).toBe(reads);
  });
  it("charges denied and unknown admission lookups too, without creating reservations",async()=>{
    for(const mode of ["denied","unknown"] as const){
      const w=fixture();w.enable();w.read.mockImplementation(async person=>mode==="unknown"?{kind:"unknown"}:{kind:"complete",person,groups:[],observedAt:100});
      for(let i=0;i<5;i++)await expect(w.service.createQuick(w.ctx,{label:"Lab"})).rejects.toThrow();
      const reads=w.read.mock.calls.length;expect(reads).toBe(5);
      await expect(w.service.createQuick(w.ctx,{label:"Lab"})).rejects.toThrow("backpressure");
      expect(w.read.mock.calls.length).toBe(reads);expect(w.store.read().pairings).toEqual([]);
    }
  });
  it("expires the one-time code and pending claim without issuing credentials",async()=>{
    const a=fixture();a.enable();const offer=await a.service.createQuick(a.ctx,{label:"Lab"});a.expire();expect(()=>a.service.pair({code:offer.code})).toThrow();
    const b=fixture();b.enable();const o=await b.service.createQuick(b.ctx,{label:"Lab"}),p=b.service.pair({code:o.code});
    await b.service.confirmOwner(b.ctx,p.pairingId,p.fingerprint);b.expire();
    await expect(b.service.claim({pairingId:p.pairingId,fleetId:p.fleetId,claimSecret:p.claimSecret})).rejects.toThrow();
    expect(b.store.read().fleets).toEqual([]);expect(b.enqueue).not.toHaveBeenCalled();
  });
});
