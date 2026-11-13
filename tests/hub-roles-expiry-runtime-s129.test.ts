/** Actual SQL/cutover/resource effects/expiry/admission; fake clock/timers, fictional directory, no sockets. */
import Database from "better-sqlite3";
import {randomBytes,randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {applyHubMigrations,bindHubInstance} from "../src/hub/db.js";
import {createHubAudit} from "../src/hub/audit/index.js";
import {HubTransportStore} from "../src/hub/store.js";
import {createHubDirectoryAdmission} from "../src/hub/directory/admission.js";
import {createHubRoleCutover} from "../src/hub/roles/cutover.js";
import {createHubRoleAuthorizationClock} from "../src/hub/roles/clock.js";
import {createHubRoleExpiryRuntime} from "../src/hub/roles/expiry-runtime.js";
import {parseRolePolicy,BUILTIN_ROLE_IDS} from "../src/hub/roles/model.js";
import {personKeyString} from "../src/hub/identity.js";
import type {Eligibility,HubDirectory} from "../src/hub/directory/types.js";
import type {PersonKey} from "../src/hub/types.js";
import {roleCutoverLegacyPlan} from "./support/hub-role-cutover-plan.js";
const cleanups:(()=>Promise<void>)[]=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100);});
afterEach(async()=>{for(const close of cleanups.splice(0))await close();vi.useRealTimers();vi.restoreAllMocks();});
function gate<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function world(){
 const db=new Database(":memory:");db.pragma("foreign_keys=ON");
 const hubId=randomUUID(),root:PersonKey={realm:"corp",objectId:randomUUID()},owner:PersonKey={realm:"corp",objectId:randomUUID()};let live=true,floor=0,elapsed=0;
 const migrations=roleCutoverLegacyPlan(hubId);applyHubMigrations(db,migrations);bindHubInstance(db,hubId,"new",Date.now());db.prepare("UPDATE hub_group_policy SET body=json_set(body,'$.state','enabled')").run();
 const audit=createHubAudit({db,contentKey:randomBytes(32),now:Date.now}),store=new HubTransportStore(db,{floor:{read:()=>floor,raise:n=>{floor=n;}},appendAudit:(e,tx)=>audit.appendInTransaction(e,tx)});store.initialize();
 expect(createHubRoleCutover({db,hubId,root,realm:"corp",generation:"g1",migrations,transport:store,current:()=>live,now:Date.now,refreshAuthorization(){}}).migrate()).toMatchObject({ok:true});
 const policy=()=>parseRolePolicy(JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get()as{body:string}).body));
 const p=policy();p.assignments.push({id:"owner",roleId:BUILTIN_ROLE_IDS.member,subject:{kind:"person",person:owner},scope:{kind:"hub"},maxFleets:1,startsAt:0,expiresAt:200,assignedBy:root,assignedAt:100});db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));
 const resource={kind:"fleet"as const,id:randomUUID(),revision:1,owner};store.mutate({at:Date.now(),requestId:randomUUID(),actor:{kind:"local-host"},action:"synthetic.fleet",result:"completed"},s=>s.fleets.push({id:resource.id,owner,credentialHash:"c".repeat(64),generation:1,status:"active"}));
 db.prepare("INSERT INTO hub_group_resources VALUES(?,?,'group','active',1)").run(JSON.stringify(["fleet",resource.id,1]),JSON.stringify(resource));
 const good=(who:PersonKey):Eligibility=>({eligible:true,person:{key:who,login:who.objectId,dn:"synthetic",groups:[]}});
 const eligibility=vi.fn(async(who:PersonKey):Promise<Eligibility>=>good(who));
 const directory:HubDirectory={realm:"corp",checkEligibility:eligibility,async signIn(){return{ok:false,reason:"invalid-credentials"};},async close(){}};
 const reads=createHubDirectoryAdmission(()=>live),clock=createHubRoleAuthorizationClock({db,hubId,realm:"corp",generation:"g1",root,transport:store,current:()=>live,now:Date.now});
 const refresh=vi.fn(()=>{expect(db.inTransaction).toBe(false);}),warning=vi.fn();
 const options={db,hubId,root,realm:"corp",generation:"g1",transport:store,audit,directory,reads,current:()=>live,assertAuthorizationTime:clock.assertAuthorizationTime,refreshAuthorization:refresh,warning,now:Date.now,elapsedNow:()=>elapsed};
 const runtime=createHubRoleExpiryRuntime(options);
 cleanups.push(async()=>{await runtime.close();await reads.drain();db.close();});
 const terms=()=>db.prepare("SELECT * FROM hub_role_expiry_terms").all(),state=()=>db.prepare("SELECT state,revision FROM hub_group_resources").get();
 const save=(mutate:(p:ReturnType<typeof policy>)=>void)=>{const p=policy();mutate(p);db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));};
 return{db,root,owner,store,audit,policy,save,eligibility,good,reads,refresh,warning,options,runtime,terms,state,
  advance:async(ms:number)=>{elapsed+=ms;await vi.advanceTimersByTimeAsync(ms);},stop:()=>{live=false;},restore:()=>{live=true;}};
}
describe("S129 role expiry runtime",()=>{
 it("waits for the actual deadline, then settles once with committed refresh",async()=>{
  const w=world();w.runtime.start();await w.advance(0);expect(w.terms()).toHaveLength(0);expect(w.eligibility).not.toHaveBeenCalled();
  await w.advance(99);expect(w.state()).toEqual({state:"active",revision:1});await w.advance(1);
  expect(w.state()).toEqual({state:"suspended",revision:2});expect(w.terms()).toHaveLength(1);expect(w.refresh).toHaveBeenCalledOnce();expect(w.store.read().revocationVersion).toBe(2);expect(vi.getTimerCount()).toBe(0);
  expect(w.audit.verifyChain()).toMatchObject({ok:true});
 });
 it("settles an already-expired term at start without an explicit caller",async()=>{
  const w=world();await w.advance(100);expect(w.terms()).toHaveLength(0);w.runtime.start();await w.advance(0);expect(w.terms()).toHaveLength(1);expect(w.state()).toEqual({state:"suspended",revision:2});
 });
 it("rearms an earlier changed deadline and keeps roles-off self-use expiry",async()=>{
  const w=world();w.runtime.start();await w.advance(0);w.save(p=>{p.rolesActive=false;p.assignments[0]!.expiresAt=150;});w.runtime.changed();await w.advance(0);await w.advance(49);expect(w.terms()).toHaveLength(0);await w.advance(1);expect(w.terms()).toHaveLength(1);expect(w.state()).toEqual({state:"suspended",revision:2});
 });
 it("does not auto-resume a suspended resource after extending the assignment",async()=>{
  const w=world();w.runtime.start();await w.advance(100);const old=w.state();w.save(p=>{p.assignments[0]!.expiresAt=400;});w.runtime.changed();await w.advance(0);expect(w.state()).toEqual(old);await w.advance(300);expect(w.terms()).toHaveLength(2);expect(w.state()).toEqual(old);
 });
 it("retries unknown directory facts at one second without a hot loop or fabricated narrowing",async()=>{
  const w=world();w.eligibility.mockResolvedValue({eligible:false,reason:"unavailable"});w.runtime.start();await w.advance(100);expect(w.terms()).toHaveLength(0);expect(w.warning).toHaveBeenCalledOnce();const calls=w.eligibility.mock.calls.length;
  await w.advance(999);expect(w.eligibility).toHaveBeenCalledTimes(calls);await w.advance(1);expect(w.eligibility.mock.calls.length).toBeGreaterThan(calls);expect(w.warning).toHaveBeenCalledOnce();
  w.eligibility.mockImplementation(async who=>w.good(who));await w.advance(1000);expect(w.terms()).toHaveLength(1);expect(w.refresh).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it("holds close until its actual physical read settles and never commits after fence",async()=>{
  const w=world(),entered=gate<void>(),release=gate<Eligibility>();let selected=w.root;
  w.eligibility.mockImplementationOnce(who=>{selected=who;entered.resolve();return release.promise;});w.runtime.start();await w.advance(100);await entered.promise;
  let closed=false;const closing=w.runtime.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);expect(vi.getTimerCount()).toBe(0);
  const blockers=[gate<void>(),gate<void>(),gate<void>()],pending=blockers.map(b=>w.reads.withDirectoryRead(w.root,()=>b.promise));
  try{await expect(w.reads.withDirectoryRead(w.root,async()=>undefined)).rejects.toBeTruthy();release.resolve(w.good(selected));await closing;expect(w.terms()).toHaveLength(0);expect(w.state()).toEqual({state:"active",revision:1});expect(w.refresh).not.toHaveBeenCalled();}
  finally{release.resolve(w.good(selected));blockers.forEach(b=>b.resolve());await Promise.all(pending);await closing;}
 });
 it("coalesces reentrant changes while one settlement owns the read",async()=>{
  const w=world(),entered=gate<void>(),release=gate<Eligibility>();let selected=w.root;
  w.eligibility.mockImplementationOnce(who=>{selected=who;w.runtime.changed();entered.resolve();return release.promise;});w.runtime.start();await w.advance(100);await entered.promise;
  w.runtime.changed();w.runtime.start();await w.advance(0);expect(w.eligibility).toHaveBeenCalledOnce();release.resolve(w.good(selected));await w.advance(0);expect(w.terms()).toHaveLength(1);expect(w.refresh).toHaveBeenCalledOnce();
 });
 it("keeps a committed expiry when refresh fails and never repeats its resource effect",async()=>{
  const w=world();w.refresh.mockImplementationOnce(()=>{throw Error("inert refresh failure");});w.runtime.start();await w.advance(100);expect(w.terms()).toHaveLength(1);expect(w.state()).toEqual({state:"suspended",revision:2});await w.advance(1000);expect(w.refresh).toHaveBeenCalledOnce();expect(w.terms()).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
 });
 it("stops scheduled work when the owning mount is no longer current",async()=>{
  const w=world();w.runtime.start();await w.advance(0);w.stop();await w.advance(100);expect(w.eligibility).not.toHaveBeenCalled();expect(w.terms()).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
  w.restore();w.runtime.changed();w.runtime.start();await w.advance(1000);expect(w.eligibility).not.toHaveBeenCalled();expect(w.terms()).toHaveLength(0);
 });
 it("bounds a far-future timer instead of overflowing into a one-millisecond loop",async()=>{
  const w=world();w.save(p=>{p.assignments[0]!.expiresAt=Date.now()+3_000_000_000;});const set=vi.spyOn(globalThis,"setTimeout");w.runtime.start();await w.advance(0);expect(set).toHaveBeenLastCalledWith(expect.any(Function),2_147_483_647);expect(w.eligibility).not.toHaveBeenCalled();
 });
});
