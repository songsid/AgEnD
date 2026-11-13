/** Actual SQL/audit/transport floor + existing directory pool. No network, account, timer or runtime mount. */
import Database from "better-sqlite3";
import {randomBytes,randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {createHubAudit,HUB_AUDIT_MIGRATION} from "../src/hub/audit/index.js";
import {HubTransportStore,HUB_TRANSPORT_MIGRATION} from "../src/hub/store.js";
import {createHubGroupPolicyStore,groupPolicyMigration} from "../src/hub/group-policy/store.js";
import {HUB_ROLE_WRITER_MIGRATION} from "../src/hub/roles/writer.js";
import {builtinRoles,BUILTIN_ROLE_IDS,type HubRoleAssignment,type HubRolePolicy} from "../src/hub/roles/model.js";
import {createHubRoleExpirySettlement,HUB_ROLE_EXPIRY_MIGRATION,type RoleExpiryOptions} from "../src/hub/roles/expiry.js";
import type {Eligibility,HubDirectory} from "../src/hub/directory/types.js";
import type {PersonKey} from "../src/hub/types.js";
const dbs:Database.Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();vi.restoreAllMocks();});
const key=():PersonKey=>({realm:"corp",objectId:randomUUID()});const clone=<T>(a:T):T=>structuredClone(a);
const assignment=(who:PersonKey,roleId:string=BUILTIN_ROLE_IDS.member):HubRoleAssignment=>({id:randomUUID(),roleId,subject:{kind:"person",person:who},scope:{kind:"hub"},maxFleets:1,startsAt:0,expiresAt:200,assignedBy:who,assignedAt:10});
function gate<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function fixture(){
 const db=new Database(":memory:");dbs.push(db);db.pragma("foreign_keys=ON");for(const m of [HUB_AUDIT_MIGRATION,HUB_TRANSPORT_MIGRATION,groupPolicyMigration("hub1","corp","g1"),HUB_ROLE_WRITER_MIGRATION,HUB_ROLE_EXPIRY_MIGRATION])m.up(db);
 db.exec("CREATE TABLE synthetic_expiry_resource(id TEXT PRIMARY KEY,state TEXT);INSERT INTO synthetic_expiry_resource VALUES('resource1','active')");
 const root=key(),owner=key(),admin=key();let time=100,elapsed=0,live=true,floor=0,ordinary=0;
 const audit=createHubAudit({db,contentKey:randomBytes(32),now:()=>time});const append=vi.fn((...args:Parameters<typeof audit.appendInTransaction>)=>audit.appendInTransaction(...args));
 const store=new HubTransportStore(db,{floor:{read:()=>floor,raise:n=>{floor=n;}},appendAudit:(e,tx)=>{audit.appendInTransaction(e,tx);}});store.initialize();
 const eligibility=vi.fn(async(p:PersonKey):Promise<Eligibility>=>({eligible:true as const,person:{key:clone(p),login:p.objectId,dn:"synthetic",groups:[]}}));
 const directory:HubDirectory={realm:"corp",checkEligibility:eligibility,async signIn(){return{ok:false,reason:"invalid-credentials"};},async close(){}};
 const reads=createHubGroupPolicyStore({db,hubId:"hub1",realm:"corp",generation:"g1",directory,audit,current:()=>live,now:()=>time});
 const policy:HubRolePolicy={realm:"corp",generation:"g1",revision:1,rolesActive:true,state:"enabled",everEnabled:true,roles:builtinRoles(),assignments:[assignment(owner),{...assignment(admin,BUILTIN_ROLE_IDS.admin),expiresAt:null}],denies:[]};
 db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(policy));const saved=()=>JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get() as {body:string}).body)as HubRolePolicy;
 const snapshot=()=>({fingerprint:JSON.stringify([ordinary,db.prepare("SELECT * FROM synthetic_expiry_resource").all()]),ordinaryFingerprint:JSON.stringify([ordinary,db.prepare("SELECT id FROM synthetic_expiry_resource").all()]),people:[root,owner,admin]});
 const commit=vi.fn((tx:Database.Database)=>{expect(tx).toBe(db);expect(tx.inTransaction).toBe(true);tx.prepare("UPDATE synthetic_expiry_resource SET state='suspended'").run();});
 const prepare=vi.fn<RoleExpiryOptions["effects"]["prepare"]>(async(input)=>{expect(input.expired.length).toBeGreaterThan(0);const before=snapshot().fingerprint;return{fingerprint:before,changed:true,impact:{suspend:["resource1"]},assertCurrent(){expect(snapshot().fingerprint).toBe(before);},commit,assertCommitted(){expect(db.prepare("SELECT state FROM synthetic_expiry_resource").get()).toEqual({state:"suspended"});}};});
 const advance=vi.fn((tx:Database.Database)=>{expect(tx).toBe(db);store.mutate({at:time,requestId:randomUUID(),actor:{kind:"local-host"},action:"synthetic.expiry-epoch",result:"completed"},s=>{s.revocationVersion++;});});
 const refresh=vi.fn(()=>{expect(db.inTransaction).toBe(false);});
 const options:RoleExpiryOptions={db,hubId:"hub1",realm:"corp",generation:"g1",root,audit:{appendInTransaction:append},directory,reads,effects:{snapshot,prepare},current:()=>live,version:()=>store.read().revocationVersion,advanceAuthorization:advance,refreshAuthorization:refresh,now:()=>time,elapsedNow:()=>elapsed};
 const settlement=createHubRoleExpirySettlement(options);
 return {db,root,owner,admin,policy,saved,store,audit,append,eligibility,reads,snapshot,prepare,commit,advance,refresh,options,settlement,time:(n:number)=>{time+=n;},elapsed:(n:number)=>{elapsed+=n;},stop:()=>{live=false;},ordinary:()=>{ordinary++;}};
}
describe("inactive role expiry settlement",()=>{
 it("settles each exact term once, preserves history and advances one epoch with required audit",async()=>{
  const w=fixture(),before=w.saved();expect(await w.settlement.settle()).toEqual({ok:true,settled:0});expect(w.prepare).not.toHaveBeenCalled();expect(w.eligibility).not.toHaveBeenCalled();const admission=vi.spyOn(w.reads,"withDirectoryRead");w.time(100);
  expect(await w.settlement.settle()).toEqual({ok:true,settled:1});expect(w.saved()).toEqual(before);expect(admission).toHaveBeenCalledWith(w.root,expect.any(Function));expect(w.advance).toHaveBeenCalledOnce();expect(w.refresh).toHaveBeenCalledOnce();
  expect(w.db.prepare("SELECT assignment_id,expires_at FROM hub_role_expiry_terms").all()).toEqual([{assignment_id:before.assignments[0]!.id,expires_at:200}]);
  expect(w.db.prepare("SELECT actor FROM hub_audit WHERE action='role.assignment-expired'").all()).toEqual([{actor:JSON.stringify({kind:"local-host"})}]);expect(w.audit.verifyChain()).toMatchObject({ok:true});
  expect(await w.settlement.settle()).toEqual({ok:true,settled:0});const reopened=createHubRoleExpirySettlement(w.options);expect(await reopened.settle()).toEqual({ok:true,settled:0});expect(w.advance).toHaveBeenCalledOnce();
 });
 it("batches simultaneous terms in one epoch and notifies only current eligible admins",async()=>{
  const w=fixture(),p=w.saved();p.assignments[1]!.expiresAt=200;w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));w.time(100);
  expect(await w.settlement.settle()).toEqual({ok:true,settled:2});expect(w.advance).toHaveBeenCalledOnce();expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='role.assignment-expired'").all()).toHaveLength(2);
  expect(w.db.prepare("SELECT person FROM hub_role_notices").all()).toEqual([{person:`${w.root.realm}/${w.root.objectId}`}]);expect(w.saved()).toEqual(p);
 });
 it("keeps a changed expiry term separate without re-settling its old identity",async()=>{
  const w=fixture();w.time(100);expect(await w.settlement.settle()).toEqual({ok:true,settled:1});const p=w.saved();p.assignments[0]!.expiresAt=300;p.assignments[0]!.assignedAt=200;w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));
  expect(await w.settlement.settle()).toEqual({ok:true,settled:0});w.time(100);expect(await w.settlement.settle()).toEqual({ok:true,settled:1});expect(w.db.prepare("SELECT term FROM hub_role_expiry_terms").all()).toHaveLength(2);expect(w.advance).toHaveBeenCalledTimes(2);
 });
 it.each(["audit","async-audit","effects","policy","epoch","ordinary","lifetime","wall-back","elapsed"]as const)("refuses %s during settlement with SQL rollback",async mode=>{
  const w=fixture();w.time(100);const before=w.saved();
  if(mode==="effects")w.commit.mockImplementation(tx=>{tx.prepare("UPDATE synthetic_expiry_resource SET state='suspended'").run();throw Error("effect unavailable");});
  w.append.mockImplementation((event,tx)=>{w.audit.appendInTransaction(event,tx);if(event.action!=="role.assignment-expired")return;
   if(mode==="audit")throw Error("audit unavailable");if(mode==="async-audit")return Promise.resolve()as never;
   if(mode==="policy")tx.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({...before,revision:2}));
   if(mode==="epoch")w.advance(tx);if(mode==="ordinary")w.ordinary();if(mode==="lifetime")w.stop();if(mode==="wall-back")w.time(-1);if(mode==="elapsed")w.elapsed(20_000);
  });
  expect(await w.settlement.settle()).toMatchObject({ok:false});expect(w.saved()).toEqual(before);expect(w.db.prepare("SELECT * FROM hub_role_expiry_terms").all()).toEqual([]);expect(w.db.prepare("SELECT state FROM synthetic_expiry_resource").get()).toEqual({state:"active"});expect(w.refresh).not.toHaveBeenCalled();
 });
 it.each(["commit","proof","epoch"]as const)("refuses a thenable %s and rolls back its synchronous prelude",async mode=>{
  const w=fixture();w.time(100);
  if(mode==="commit")w.commit.mockImplementation(tx=>{tx.prepare("UPDATE synthetic_expiry_resource SET state='suspended'").run();return Promise.resolve()as never;});
  if(mode==="proof"){const original=w.prepare.getMockImplementation()!;w.prepare.mockImplementation(async(...args)=>{const p=await original(...args);return{...p,assertCommitted(){return Promise.resolve()as never;}};});}
  if(mode==="epoch"){const original=w.advance.getMockImplementation()!;w.advance.mockImplementation(tx=>{original(tx);return Promise.resolve()as never;});}
  expect(await w.settlement.settle()).toMatchObject({ok:false});expect(w.db.prepare("SELECT * FROM hub_role_expiry_terms").all()).toEqual([]);
  expect(w.db.prepare("SELECT state FROM synthetic_expiry_resource").get()).toEqual({state:"active"});expect(w.refresh).not.toHaveBeenCalled();
 });
 it("preserves committed settlement on refresh failure and never repeats the resource effect",async()=>{
  const w=fixture();w.time(100);w.refresh.mockImplementationOnce(()=>{throw Error("refresh unavailable");});
  expect(await w.settlement.settle()).toEqual({ok:false,code:"unavailable"});expect(w.db.prepare("SELECT term FROM hub_role_expiry_terms").all()).toHaveLength(1);
  expect(await w.settlement.settle()).toEqual({ok:true,settled:0});expect(w.commit).toHaveBeenCalledOnce();expect(w.advance).toHaveBeenCalledOnce();
 });
 it.each(["unavailable","foreign"]as const)("refuses %s recipient eligibility without narrowing resources",async mode=>{
  const w=fixture();w.time(100);w.eligibility.mockImplementationOnce(async()=>mode==="unavailable"?{eligible:false,reason:"unavailable"}:{eligible:true,person:{key:key(),login:"synthetic",dn:"synthetic",groups:[]}});
  expect(await w.settlement.settle()).toEqual({ok:false,code:"unavailable"});expect(w.commit).not.toHaveBeenCalled();expect(w.db.prepare("SELECT term FROM hub_role_expiry_terms").all()).toEqual([]);
 });
 it("omits an explicitly disabled admin recipient and retains the configured root notice",async()=>{
  const w=fixture(),p=w.saved();p.assignments[0]!.roleId=BUILTIN_ROLE_IDS.admin;w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));w.time(100);
  const original=w.eligibility.getMockImplementation()!;w.eligibility.mockImplementation(async who=>who.objectId===w.admin.objectId?{eligible:false,reason:"disabled"}:original(who));
  expect(await w.settlement.settle()).toEqual({ok:true,settled:1});expect(w.db.prepare("SELECT person FROM hub_role_notices").all()).toEqual([{person:`${w.root.realm}/${w.root.objectId}`}]);
 });
 it("does not re-settle the same deadline after a display-only policy edit",async()=>{
  const w=fixture();w.time(100);expect(await w.settlement.settle()).toEqual({ok:true,settled:1});const p=w.saved();p.roles[2]!.name="Renamed member";p.revision++;
  w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));expect(await w.settlement.settle()).toEqual({ok:true,settled:0});expect(w.advance).toHaveBeenCalledOnce();
 });
 it("retains exact-term idempotence and clock floor after actual audit retention",async()=>{
  const w=fixture();w.time(100);expect(await w.settlement.settle()).toEqual({ok:true,settled:1});w.time(2*86_400_000);
  expect(w.audit.purge({contentDays:1,eventDays:1}).events).toBeGreaterThan(0);expect(w.audit.verifyChain()).toMatchObject({ok:true});
  expect(w.db.prepare("SELECT id FROM hub_role_events").all()).toEqual([]);expect(w.db.prepare("SELECT term FROM hub_role_expiry_terms").all()).toHaveLength(1);
  const reopened=createHubRoleExpirySettlement(w.options);expect(await reopened.settle()).toEqual({ok:true,settled:0});w.time(-2*86_400_000-1);
  expect(()=>reopened.assertAuthorizationTime()).toThrow();expect(await reopened.settle()).toEqual({ok:false,code:"expired"});
 });
 it("refuses a restored older transport image against the actual independent epoch floor",async()=>{
  const w=fixture(),old=w.db.prepare("SELECT state FROM hub_transport_state").get()as{state:string};w.time(100);
  expect(await w.settlement.settle()).toEqual({ok:true,settled:1});w.db.prepare("UPDATE hub_transport_state SET state=?").run(old.state);
  expect(()=>w.settlement.assertAuthorizationTime()).toThrow();expect(await w.settlement.settle()).toEqual({ok:false,code:"unavailable"});
  expect(w.commit).toHaveBeenCalledOnce();expect(w.advance).toHaveBeenCalledOnce();
 });
 it("checks policy again after the synchronous committed-resource proof",async()=>{
  const w=fixture();w.time(100);const original=w.prepare.getMockImplementation()!;
  w.prepare.mockImplementation(async(...args)=>{const p=await original(...args);return{...p,assertCommitted(){p.assertCommitted();w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({...w.saved(),revision:2}));}};});
  expect(await w.settlement.settle()).toMatchObject({ok:false});expect(w.saved().revision).toBe(1);expect(w.db.prepare("SELECT term FROM hub_role_expiry_terms").all()).toEqual([]);
 });
 it("publishes its one flight before any synchronous integration callback can re-enter",async()=>{
  const w=fixture();w.time(100);let nested:Promise<unknown>|undefined,once=true;const original=w.options.effects.snapshot;
  vi.spyOn(w.options.effects,"snapshot").mockImplementation(()=>{if(once){once=false;nested=w.settlement.settle();}return original();});
  const first=w.settlement.settle();expect(await first).toEqual({ok:true,settled:1});expect(nested).toBe(first);expect(w.commit).toHaveBeenCalledOnce();
 });
 it("requires the actual epoch increment before committing expiry",async()=>{
  const w=fixture();w.time(100);w.advance.mockImplementation(()=>{});
  expect(await w.settlement.settle()).toEqual({ok:false,code:"conflict"});expect(w.db.prepare("SELECT term FROM hub_role_expiry_terms").all()).toEqual([]);
  expect(w.db.prepare("SELECT state FROM synthetic_expiry_resource").get()).toEqual({state:"active"});expect(w.refresh).not.toHaveBeenCalled();
 });
 it("retries instead of using a recipient authority set that expires during its directory read",async()=>{
  const w=fixture(),p=w.saved();p.assignments[1]!.expiresAt=250;w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));w.time(100);
  const original=w.eligibility.getMockImplementation()!;w.eligibility.mockImplementationOnce(async who=>{const e=await original(who);w.time(60);return e;});
  expect(await w.settlement.settle()).toEqual({ok:false,code:"conflict"});expect(w.commit).not.toHaveBeenCalled();
  expect(await w.settlement.settle()).toEqual({ok:true,settled:2});expect(w.db.prepare("SELECT person FROM hub_role_notices").all()).toEqual([{person:`${w.root.realm}/${w.root.objectId}`}]);
 });
 it("proves every committed marker again after later audit callbacks",async()=>{
  const w=fixture(),p=w.saved();p.assignments[1]!.expiresAt=200;w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));w.time(100);let records=0;
  w.append.mockImplementation((e,tx)=>{w.audit.appendInTransaction(e,tx);if(e.action==="role.assignment-expired"&&++records===2)tx.prepare("UPDATE hub_role_expiry_terms SET expires_at=201").run();});
  expect(await w.settlement.settle()).toEqual({ok:false,code:"conflict"});expect(w.db.prepare("SELECT term FROM hub_role_expiry_terms").all()).toEqual([]);expect(w.refresh).not.toHaveBeenCalled();
 });
 it("allows only one of two independently prepared helpers to settle the same term",async()=>{
  const w=fixture();w.time(100);const other=createHubRoleExpirySettlement(w.options);
  const results=await Promise.all([w.settlement.settle(),other.settle()]);
  expect(results.filter(r=>r.ok)).toEqual([{ok:true,settled:1}]);expect(results.filter(r=>!r.ok)).toEqual([{ok:false,code:"conflict"}]);
  expect(w.commit).toHaveBeenCalledOnce();expect(w.advance).toHaveBeenCalledOnce();expect(w.db.prepare("SELECT term FROM hub_role_expiry_terms").all()).toHaveLength(1);
 });
 it("holds authorization and settlement on a persisted expiry clock floor after reopen",async()=>{
  const w=fixture();w.time(100);expect(await w.settlement.settle()).toEqual({ok:true,settled:1});
  w.time(-1);const reopened=createHubRoleExpirySettlement(w.options);
  expect(()=>reopened.assertAuthorizationTime()).toThrow();
  expect(await reopened.settle()).toEqual({ok:false,code:"expired"});
  w.time(1);expect(()=>reopened.assertAuthorizationTime()).not.toThrow();
  expect(await reopened.settle()).toEqual({ok:true,settled:0});expect(w.advance).toHaveBeenCalledOnce();
 });
 it("retains a single physical flight across close and releases directory admission only after the held read",async()=>{
  const w=fixture();w.time(100);let selected=w.root;const entered=gate<void>(),released=gate<Eligibility>();w.eligibility.mockImplementationOnce(who=>{selected=who;entered.resolve();return released.promise;});
  const first=w.settlement.settle(),second=w.settlement.settle();expect(first).toBe(second);await entered.promise;
  const blockers=[gate<void>(),gate<void>(),gate<void>()],pending=blockers.map(b=>w.reads.withDirectoryRead(w.root,()=>b.promise));
  try {
   await expect(w.reads.withDirectoryRead(w.root,async()=>undefined)).rejects.toBeTruthy();w.settlement.close();
   released.resolve({eligible:true,person:{key:selected,login:"synthetic",dn:"synthetic",groups:[]}});expect(await first).toMatchObject({ok:false});
   expect(w.db.prepare("SELECT * FROM hub_role_expiry_terms").all()).toEqual([]);expect(w.commit).not.toHaveBeenCalled();
  } finally {released.resolve({eligible:false,reason:"unavailable"});for(const b of blockers)b.resolve();await Promise.all(pending);await first;}
 });
});
