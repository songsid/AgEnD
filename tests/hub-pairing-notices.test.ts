/** Real pairing, transport floor, SQLite and group/audit libraries. Inert directory/session callbacks, no HTTP/native claim. */
import { HubPairingNotices, HUB_PAIRING_NOTICES_MIGRATION } from "../src/hub/pairing-notices.js";
import type { HubQuickPairingNotice } from "../src/hub/pairing.js";
import type { HubLinkContext } from "../src/hub/server.js";
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
  for (const m of [HUB_TRANSPORT_MIGRATION, HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "gen-1"), HUB_GROUP_RESOURCES_MIGRATION, HUB_PAIRING_NOTICES_MIGRATION]) m.up(db);
  let floor = 0, now = 100, enabled = true;
  const owner = key(), administrator = key(), group = key(), other = key(), clock = () => now;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: clock });
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } }, appendAudit: (event, tx) => append(event, tx) }); store.initialize();
  const eligible = vi.fn(async (person: PersonKey) => ({ eligible: true as const, person: { key: person, login: "morgan", dn: "CN=Morgan,DC=example,DC=test", groups: [] } }));
  const read = vi.fn(async (person: PersonKey): Promise<PolicyGroupFacts> => ({ kind: "complete", person, groups: [group.objectId], observedAt: now }));
  const directory: HubDirectory = { realm: "example", groupPolicy: "ad-direct-guid", signIn: vi.fn(), checkEligibility: eligible, readPolicyGroups: read, close: vi.fn() };
  const send=vi.fn(async()=>{});
  const notices = new HubPairingNotices({db,store,administrator,directory,audit:{appendInTransaction:append},current:()=>enabled,now:clock,transport:()=>({send})});
  db.exec("CREATE TABLE test_notices (body TEXT)");
  const enqueue = vi.fn((database: Database.Database, notice: HubQuickPairingNotice) => { if(database!==db || !db.inTransaction) throw Error("notice outside owning transaction"); db.prepare("INSERT INTO test_notices VALUES(?)").run(JSON.stringify(notice));notices.enqueue(database,notice,store.read()); });
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
  return { db, store, directory, eligible, owner, administrator, group, other, audit, append, groups, resources, policy, read, prepare, atomic, service, ctx, action, enqueue, committed, notices, send,
    enable, pending, approved, mutate, raw, off: () => { enabled = false; }, expire: () => { now += 600_001; } };
}


const session=(w:ReturnType<typeof fixture>,person:PersonKey,id:string):HubRequestContext=>({...w.ctx,requirePerson:async()=>person,current:async()=>({kind:"directory",person,sessionId:id})});
async function quick(w:ReturnType<typeof fixture>,label="Lab"){
 const offer=await w.service.createQuick(w.ctx,{label}),p=w.service.pair({code:offer.code});await w.service.confirmOwner(w.ctx,p.pairingId,p.fingerprint);
 const result=await w.service.claim({pairingId:p.pairingId,fleetId:p.fleetId,claimSecret:p.claimSecret});if(result.status!=="approved")throw Error("quick not approved");return result;
}
describe("durable quick-pairing security notice outbox",()=>{
 it("queues owner, admin and existing fleet with credential/audit; excludes only the initiating session",async()=>{
  const w=fixture();w.enable(2);const manual=await w.approved();await w.service.claim(manual.input);const made=await quick(w,"<img src=x onerror=alert(1)>");
  expect(w.db.prepare("SELECT kind,target,state FROM hub_pairing_notice_targets ORDER BY kind,target").all()).toEqual(expect.arrayContaining([
   {kind:"person",target:`example/${w.owner.objectId}`,state:"queued"},{kind:"person",target:`example/${w.administrator.objectId}`,state:"queued"},{kind:"fleet",target:manual.fleetId,state:"queued"}]));
  expect(await w.notices.forSession(w.ctx)).toEqual([]);
  expect(await w.notices.forSession(session(w,w.owner,"other-session"))).toMatchObject([{fleetId:made.fleetId,label:"<img src=x onerror=alert(1)>",source:"group"}]);
  expect(await w.notices.forSession(session(w,w.administrator,"admin-session"))).toHaveLength(1);
  expect(await w.notices.forSession(session(w,w.other,"other-person"))).toEqual([]);
  expect(w.audit.verifyChain()).toMatchObject({ok:true});
 });
 it("retains offline notices over reconstruction and records delivery only after an authenticated ACK",async()=>{
  const w=fixture();w.enable();await quick(w);const ctx=session(w,w.owner,"offline-session");const first=await w.notices.forSession(ctx),n=first[0]!;
  const recreated=new HubPairingNotices({db:w.db,store:w.store,administrator:w.administrator,directory:w.directory,audit:w.audit,current:()=>true,now:()=>100,transport:()=>null});
  expect(await recreated.forSession(ctx)).toEqual(first);
  await expect(recreated.acknowledgeSession(session(w,w.other,"stranger"),n.id)).rejects.toThrow();
  await recreated.acknowledgeSession(ctx,n.id);await recreated.acknowledgeSession(ctx,n.id);
  expect(w.db.prepare("SELECT * FROM hub_pairing_notice_targets WHERE kind='session'").all()).toHaveLength(1);
  expect((await recreated.forSession(ctx))[0]).toEqual(n); // acknowledging doesn't erase other/offline sessions' notice
 });
 it("keeps failed fleet sends queued and accepts only that owner's exact target ACK",async()=>{
  const w=fixture();w.enable(2);const old=await w.approved();await w.service.claim(old.input);await quick(w);
  const link:HubLinkContext={fleetId:old.fleetId,owner:w.owner,linkEpoch:1,features:new Set(["welcome-caps-v1","pairing-notices-v1"]),current:()=>true};
  const noticeId=(w.db.prepare("SELECT id FROM hub_pairing_notices").get() as {id:string}).id;
  w.send.mockRejectedValueOnce(Error("offline"));await w.notices.flushFleet(link);
  expect(w.db.prepare("SELECT state FROM hub_pairing_notice_targets WHERE kind='fleet'").get()).toEqual({state:"failed"});
  await expect(w.notices.flushFleet({...link,features:new Set()})).resolves.toBeUndefined();expect(w.send).toHaveBeenCalledOnce();
  expect(()=>w.notices.acknowledgeFleet({...link,fleetId:randomUUID()},noticeId)).toThrow();
  expect(()=>w.notices.acknowledgeFleet({...link,owner:w.other},noticeId)).toThrow();
  w.notices.acknowledgeFleet(link,noticeId);w.notices.acknowledgeFleet(link,noticeId);
  expect(w.db.prepare("SELECT state FROM hub_pairing_notice_targets WHERE kind='fleet'").get()).toEqual({state:"delivered"});
 });
 it("does not disclose after eligibility/session revocation while the read is held",async()=>{
  const w=fixture();w.enable();await quick(w);let live=true;const held=gate<PersonKey>(),ctx={...session(w,w.owner,"held"),isCurrent:()=>live,requirePerson:()=>held.promise};
  const work=w.notices.forSession(ctx),failed=expect(work).rejects.toThrow();live=false;held.resolve(w.owner);await failed;
 });
 it("refuses credentials and provenance if the durable notice table cannot accept the queue",async()=>{
  const w=fixture();w.enable();w.db.exec("CREATE TRIGGER notice_full BEFORE INSERT ON hub_pairing_notices BEGIN SELECT RAISE(ABORT,'notice full'); END");
  await expect(quick(w)).rejects.toThrow("notice full");expect(w.raw().fleets).toEqual([]);expect(w.db.prepare("SELECT * FROM hub_group_resources").all()).toEqual([]);
 });
});
