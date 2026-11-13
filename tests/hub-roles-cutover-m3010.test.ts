/** Owned SQL, actual audit and durable floor; no runtime mount, network, backend CLI or real accounts. */
import Database from "better-sqlite3";
import {randomBytes,randomUUID,generateKeyPairSync} from "node:crypto";
import {mkdtempSync,chmodSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {buildSync} from "esbuild";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {applyHubMigrations,assertHubMigrationsCurrent,bindHubInstance,openHubDatabase} from "../src/hub/db.js";
import {createHubAudit} from "../src/hub/audit/index.js";
import {HubTransportStore} from "../src/hub/store.js";
import {HubFileVersionFloor} from "../src/hub/version-floor.js";
import {HubEnrolmentCodes} from "../src/hub/enrolment-code.js";
import {createHubRoleCutover,type RoleCutoverOptions} from "../src/hub/roles/cutover.js";
import {captureRoleCutoverInventory} from "../src/hub/roles/cutover-inventory.js";
import {GROUP_CAPABILITIES,evaluateGroupPolicy,type HubGroupPolicy} from "../src/hub/group-policy/model.js";
import {createJoinSealer,type DeliveryBinding} from "../src/hub/join/receipt.js";
import {CompanyJoinRecords,type JoinRecord,companyInvitationRecord} from "../src/hub/join/store.js";
import {companyIdentityDigest,joinKeyThumbprint,type JoinBinding} from "../src/hub/join/protocol.js";
import {signCompanyInvitation,verifyCompanyInvitation} from "../src/hub/join/invitation.js";
import {sha256} from "../src/hub/identity.js";
import {evaluateRolePolicy} from "../src/hub/roles/evaluate.js";
import {createHubRoleWriter} from "../src/hub/roles/writer.js";
import {createHubRoleModeEffects} from "../src/hub/roles/mode-effects.js";
import {createHubGroupPolicyStore} from "../src/hub/group-policy/store.js";
import type {HubDirectory} from "../src/hub/directory/types.js";
import type {HubRequestContext} from "../src/hub/types.js";
import {parseRolePolicy} from "../src/hub/roles/model.js";
import {roleCutoverLegacyPlan} from "./support/hub-role-cutover-plan.js";
import type {PersonKey} from "../src/hub/types.js";
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();vi.restoreAllMocks();});
const person=():PersonKey=>({realm:"corp",objectId:randomUUID()});
function fixture(state:HubGroupPolicy["state"]="enabled",disk=false){
 const home=mkdtempSync(join(tmpdir(),"role-cutover-"));chmodSync(home,0o700);cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const db=disk?openHubDatabase(home,"hub/hub.sqlite",{create:true}):new Database(":memory:");cleanup.push(()=>{if(db.open)db.close();});db.pragma("foreign_keys=ON");const hubId=randomUUID(),root=person(),owner=person();let time=1_000,elapsed=0,live=true;
 const migrations=roleCutoverLegacyPlan(hubId);applyHubMigrations(db,migrations);bindHubInstance(db,hubId,"new",time);
 const auditKey=randomBytes(32),audit=createHubAudit({db,contentKey:auditKey,now:()=>time});const append=vi.fn((...args:Parameters<typeof audit.appendInTransaction>)=>audit.appendInTransaction(...args));
 const fileFloor=new HubFileVersionFloor(home,"hub/floors/transport");fileFloor.initialize();const raise=vi.fn((n:number)=>fileFloor.raise(n));
 const floor={read:()=>fileFloor.read(),raise};const transport=new HubTransportStore(db,{floor,appendAudit:(e,tx)=>append(e,tx)});transport.initialize();
 const policy:HubGroupPolicy={realm:"corp",generation:"g1",revision:7,state,groups:[{group:person(),dn:"CN=Members,DC=synthetic",allow:[...GROUP_CAPABILITIES],maxFleets:0}],denies:[{person:owner,deny:["publish_agents"]}]};
 const oldRaw=JSON.stringify(policy,null,2);db.prepare("UPDATE hub_group_policy SET body=?").run(oldRaw);
 const codes=new HubEnrolmentCodes({db,home,hubId,now:()=>time,audit:(action,codeId)=>audit.appendInTransaction({id:randomUUID(),at:time,sequence:0,requestId:randomUUID(),actor:{kind:"person",person:root},action,result:"completed",policyVersion:policy.revision,codeId},db)});
 const code=db.transaction(()=>codes.create(root,{expires:"1h",maxUses:3})).immediate();
 const refresh=vi.fn(()=>{expect(db.inTransaction).toBe(false);});
 const options:RoleCutoverOptions={db,hubId,realm:"corp",generation:"g1",root,transport,migrations,current:()=>live,refreshAuthorization:refresh,now:()=>time,elapsedNow:()=>elapsed};
 const cutover=createHubRoleCutover(options),raw=()=>(db.prepare("SELECT body FROM hub_group_policy").get()as{body:string}).body;
 return{home,db,hubId,root,owner,policy,oldRaw,codes,code,audit,auditKey,append,transport,fileFloor,raise,floor,refresh,options,cutover,raw,time:(n:number)=>{time+=n;},elapsed:(n:number)=>{elapsed+=n;},stop:()=>{live=false;}};
}
describe("inactive atomic roles cutover",()=>{
 it.each(["never-enabled","enabled","suspended"]as const)("atomically converts %s without changing state/latch/root self-use or retained bytes",state=>{
  const w=fixture(state),inventory=captureRoleCutoverInventory(w.db,w.transport,()=>{});
  expect(w.cutover.migrate()).toEqual({ok:true,changed:true,revision:7,epoch:1});
  const p=parseRolePolicy(JSON.parse(w.raw()));expect(p).toMatchObject({rolesActive:true,state,everEnabled:state!=="never-enabled",revision:7});
  expect(p.assignments.every(a=>a.subject.kind==="group")).toBe(true);expect(p.denies).toEqual(w.policy.denies);expect(p.assignments[0]!.maxFleets).toBe(0);
  expect(captureRoleCutoverInventory(w.db,w.transport,()=>{})).toEqual(inventory);expect(w.refresh).toHaveBeenCalledOnce();expect(w.audit.verifyChain()).toMatchObject({ok:true});
  expect(w.db.prepare("SELECT person FROM hub_role_notices").all()).toEqual([{person:`${w.root.realm}/${w.root.objectId}`}]);
 });
 it("repeats without another epoch, notice or old-policy rewrite, even after audit retention",()=>{
  const w=fixture();expect(w.cutover.migrate()).toMatchObject({ok:true,changed:true});
  const marker=(w.db.prepare("SELECT body FROM hub_role_cutover").get()as{body:string}).body;
  expect(JSON.parse(marker).oldRaw).toBe(w.oldRaw);
  expect(w.cutover.migrate()).toMatchObject({ok:true,changed:false,epoch:1});expect(w.refresh).toHaveBeenCalledOnce();
  expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='role.migrated'").all()).toHaveLength(1);
  w.time(2*86_400_000);expect(w.audit.purge({contentDays:1,eventDays:1}).events).toBeGreaterThan(0);
  expect(w.db.prepare("SELECT * FROM hub_role_notices").all()).toEqual([]);
  expect(createHubRoleCutover(w.options).migrate()).toMatchObject({ok:true,changed:false,epoch:1});
  expect((w.db.prepare("SELECT body FROM hub_role_cutover").get()as{body:string}).body).toBe(marker);
  expect(w.db.prepare("SELECT * FROM hub_role_notices").all()).toEqual([]);expect(w.audit.verifyChain()).toMatchObject({ok:true});
 });
 it("makes both old migration entry paths refuse a converted database",()=>{
  const w=fixture();expect(w.cutover.migrate()).toMatchObject({ok:true});
  for(const read of [()=>assertHubMigrationsCurrent(w.db,w.options.migrations),()=>applyHubMigrations(w.db,w.options.migrations)]){
   expect(read).toThrow(expect.objectContaining({code:"hub-state-newer"}));
  }
 });
 it.each(["before-floor","after-floor","audit","async-audit","missing-audit","policy","ordinary","marker","recipient","wall","elapsed","close"]as const)("rolls back SQL at %s without lowering an advanced independent floor",mode=>{
  const w=fixture(),before=captureRoleCutoverInventory(w.db,w.transport,()=>{});
  if(mode==="before-floor")w.raise.mockImplementation(()=>{throw Error("floor unavailable");});
  if(mode==="after-floor")w.raise.mockImplementation(n=>{w.fileFloor.raise(n);throw Error("floor interrupted");});
  w.append.mockImplementation((event,tx)=>{
   if(event.action!=="role.migrated"){w.audit.appendInTransaction(event,tx);return;}
   if(mode==="missing-audit")return;w.audit.appendInTransaction(event,tx);
   if(mode==="audit")throw Error("audit interrupted");if(mode==="async-audit")return Promise.resolve()as never;
   if(mode==="policy")tx.prepare("UPDATE hub_group_policy SET body=?").run(w.oldRaw);
   if(mode==="ordinary")tx.prepare("UPDATE hub_enrolment_codes SET uses=uses+1").run();
   if(mode==="marker")tx.exec("CREATE TRIGGER damage_marker AFTER INSERT ON hub_role_cutover BEGIN UPDATE hub_role_cutover SET body=json_set(body,'$.oldDigest','bad'); END");
   if(mode==="recipient")tx.exec("CREATE TRIGGER damage_notice AFTER INSERT ON hub_role_notices BEGIN DELETE FROM hub_role_notices; END");
   if(mode==="wall")w.time(-1);if(mode==="elapsed")w.elapsed(20_000);if(mode==="close")w.cutover.close();
  });
  expect(w.cutover.migrate()).toMatchObject({ok:false});expect(w.raw()).toBe(w.oldRaw);expect(w.refresh).not.toHaveBeenCalled();
  expect(w.db.prepare("SELECT uses FROM hub_enrolment_codes").get()).toEqual({uses:0});
  expect(w.db.prepare("SELECT name FROM sqlite_master WHERE name='hub_role_cutover'").get()).toBeUndefined();
  expect(w.db.prepare("SELECT component FROM hub_schema WHERE component LIKE 'roles-%'").all()).toEqual([]);
  const raised=mode!=="before-floor";expect(w.fileFloor.read()).toBe(raised?1:0);
  const reopened=new HubTransportStore(w.db,{floor:w.fileFloor,appendAudit:(e,tx)=>w.audit.appendInTransaction(e,tx)});
  if(raised)expect(()=>reopened.read()).toThrow();else expect(captureRoleCutoverInventory(w.db,reopened,()=>{})).toEqual(before);
 });
 it("keeps a completed commit on refresh failure and retries only publication",()=>{
  const w=fixture();w.refresh.mockImplementationOnce(()=>{throw Error("mount retired");});
  expect(w.cutover.migrate()).toEqual({ok:false,code:"unavailable"});expect(parseRolePolicy(JSON.parse(w.raw())).rolesActive).toBe(true);
  expect(w.transport.read().revocationVersion).toBe(1);expect(w.cutover.migrate()).toMatchObject({ok:true,changed:false,epoch:1});
  expect(w.refresh).toHaveBeenCalledTimes(2);expect(w.db.prepare("SELECT * FROM hub_role_notices").all()).toHaveLength(1);
 });
 it("refuses an ambient transaction and synchronous re-entry",()=>{
  const w=fixture();w.db.transaction(()=>expect(w.cutover.migrate()).toEqual({ok:false,code:"unavailable"})).immediate();
  let nested:unknown;w.append.mockImplementation((e,tx)=>{w.audit.appendInTransaction(e,tx);nested=w.cutover.migrate();});
  expect(w.cutover.migrate()).toMatchObject({ok:true,epoch:1});expect(nested).toEqual({ok:false,code:"unavailable"});
 });
 it("re-proves the exact audit image after the transport callback returns",()=>{
  const w=fixture(),transport={read:()=>w.transport.read(),mutate:((...args:Parameters<HubTransportStore["mutate"]>)=>{
   const result=w.transport.mutate(...args);w.db.prepare("UPDATE hub_audit SET actor=? WHERE action='role.migrated'").run(JSON.stringify({kind:"local-host",changed:true}));return result;
  })as HubTransportStore["mutate"]};
  expect(createHubRoleCutover({...w.options,transport}).migrate()).toEqual({ok:false,code:"conflict"});
  expect(w.raw()).toBe(w.oldRaw);expect(w.fileFloor.read()).toBe(1);expect(w.refresh).not.toHaveBeenCalled();
 });
 it.each(["before-floor","after-floor","after-audit","after-commit","mode-before-floor","mode-after-floor","mode-after-audit","mode-after-commit"])("recovers owned WAL/SQL after an actual process SIGKILL at %s",phase=>{
  const w=fixture("enabled",true),mode=phase.startsWith("mode-"),point=phase.replace(/^mode-/,"");
  if(mode)expect(w.cutover.migrate()).toMatchObject({ok:true});
  const beforeRaw=w.raw(),config=join(w.home,"fixture.json");
  // Resolve installed dependencies from this worktree; the child receives only private fixture-generated material.
  const built=fileURLToPath(new URL("../.artifacts/role-cutover-crash-worker.mjs",import.meta.url));
  buildSync({entryPoints:[fileURLToPath(new URL("./support/hub-role-cutover-crash-worker.ts",import.meta.url))],outfile:built,bundle:true,platform:"node",format:"esm",packages:"external",logLevel:"silent"});
  writeFileSync(config,JSON.stringify({home:w.home,hubId:w.hubId,root:w.root,auditKey:w.auditKey.toString("base64"),phase}),{mode:0o600});w.db.close();
  const child=spawnSync(process.execPath,[built,config],{timeout:8_000,encoding:"utf8"});expect(child.error).toBeUndefined();expect(child.signal,child.stderr).toBe("SIGKILL");
  const db=openHubDatabase(w.home,"hub/hub.sqlite",{create:false});cleanup.push(()=>db.close());
  const transport=new HubTransportStore(db,{floor:w.fileFloor,appendAudit(){throw Error("no replay writes expected");}});
  const raw=(db.prepare("SELECT body FROM hub_group_policy").get()as{body:string}).body;
  if(point==="after-commit"){
   expect(parseRolePolicy(JSON.parse(raw))).toMatchObject({rolesActive:!mode,revision:mode?8:7});expect(transport.read().revocationVersion).toBe(mode?2:1);
   expect(db.prepare("SELECT * FROM hub_role_notices").all()).toHaveLength(mode?2:1);
   expect(createHubRoleCutover({...w.options,db,transport,refreshAuthorization(){}}).migrate()).toMatchObject({ok:true,changed:false,epoch:mode?2:1});
  }else{
   expect(raw).toBe(beforeRaw);expect(db.prepare("SELECT name FROM sqlite_master WHERE name='hub_role_cutover'").all()).toHaveLength(mode?1:0);
   if(point==="before-floor"){expect(transport.read().revision).toBe(mode?1:0);expect(w.fileFloor.read()).toBe(mode?1:0);}
   else{expect(w.fileFloor.read()).toBe(mode?2:1);expect(()=>transport.read()).toThrow();}
  }
  expect(createHubAudit({db,contentKey:w.auditKey,now:()=>1_000}).verifyChain()).toMatchObject({ok:true});
 });
 it.each(["never-enabled","enabled","suspended"]as const)("matches stored %s access across all bitsets, MAX overlap, denies and exact quotas",state=>{
  const w=fixture(state),p=structuredClone(w.policy);
  p.groups=Array.from({length:8},(_,mask)=>({group:person(),dn:`CN=Mask${mask}`,allow:GROUP_CAPABILITIES.filter((_,bit)=>mask&(1<<bit)),maxFleets:mask}));
  w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(p));expect(w.cutover.migrate()).toMatchObject({ok:true});
  const saved=parseRolePolicy(JSON.parse(w.raw()));let assertions=0;
  for(const who of [w.owner,w.root])for(const rule of p.groups)for(const overlap of [false,true]){
   const facts={kind:"complete"as const,person:who,groups:[rule.group.objectId,...(overlap?[p.groups[7]!.group.objectId]:[])],observedAt:1_000};
   for(const cap of GROUP_CAPABILITIES){const old=evaluateGroupPolicy(p,who,cap,facts),actual=evaluateRolePolicy(saved,who,cap,null,{subject:facts},1_000,w.root);
    expect(actual).toMatchObject({outcome:old.outcome,authoritative:old.authoritative,maxFleets:old.maxFleets});assertions++;
   }
  }
  expect(assertions).toBe(96);
 });
 it.each((["never-enabled","enabled","suspended"]as const).flatMap(state=>(["manual","group","code"]as const).map(source=>({state,source}))))("preserves actual $source provenance in $state, pending/issued records, signatures, keys and sealed recovery",({state,source})=>{
  const w=fixture(state),keys=generateKeyPairSync("ed25519"),pem=keys.publicKey.export({type:"spki",format:"pem"}).toString();
  const hub={hubId:w.hubId,webOrigin:"https://hub.example.test",memberOrigin:"https://member.example.test",spkiSha256:"a".repeat(64),issuerPublicKey:pem};
  const binding:JoinBinding={hub,requestId:randomUUID(),operationId:randomUUID(),fleetId:randomUUID(),publicKey:pem,fleetOrigin:"https://fleet.example.test",verifierS256:randomBytes(32).toString("base64url")};
  const credential=randomBytes(32).toString("hex"),sealer=createJoinSealer(w.home,()=>false),records=new CompanyJoinRecords(w.db,()=>1_000);
  const resource={kind:"fleet",id:binding.fleetId,revision:1,owner:w.owner,...(source==="code"?{codeId:w.code.id,approvedBy:w.root}:{})};
  const rawResource=JSON.stringify(resource,null,2),eventId=randomUUID();
  w.db.transaction(()=>{
   w.audit.appendInTransaction({id:eventId,at:1_000,sequence:0,requestId:binding.requestId,actor:{kind:"person",person:w.root},action:"group-resource.registered",result:"completed",policyVersion:7},w.db);
   w.db.prepare("INSERT INTO hub_group_resources VALUES(?,?,?,?,?)").run(JSON.stringify(["fleet",binding.fleetId,1]),rawResource,source,"suspended",4);
   w.db.prepare("INSERT INTO hub_group_resource_events VALUES(?,?)").run(eventId,JSON.stringify({resource,payload:{approvedBy:w.root,source}}));
  }).immediate();
  const provenanceDigest=sha256(JSON.stringify([rawResource,w.db.prepare("SELECT * FROM hub_group_resource_events WHERE id=?").get(eventId)]));
  const delivery:DeliveryBinding={hubIdentityDigest:companyIdentityDigest(hub),requestId:binding.requestId,operationId:binding.operationId,owner:w.owner,fleetId:binding.fleetId,generation:1,
   joinKeyThumbprint:joinKeyThumbprint(pem),verifierS256:binding.verifierS256,issuedCredentialHash:sha256(credential),resourceRevision:4,committedSource:source,provenanceDigest,issuedAt:1_000,deliveryDeadline:121_000,outerDeadline:601_000};
  const receipt=sealer.seal(delivery,credential),claims={v:2 as const,id:randomUUID(),hub,owner:w.owner,approvedBy:w.root,nonce:"b".repeat(64),createdAt:1_000,expiresAt:601_000};
  const invitation=signCompanyInvitation(claims,keys.privateKey);
  const record:JoinRecord={v:1,binding,version:1,label:"Retained Fleet",stateHash:"c".repeat(64),stage:"issued",createdAt:1_000,outerDeadline:601_000,retainUntil:701_000,
   browserHash:"d".repeat(64),browserOrigin:hub.webOrigin,owner:w.owner,sessionId:"synthetic-session",approvedAt:1_000,redeemDeadline:121_000,deliveryDeadline:121_000,issuedHash:sha256(credential),reason:null,
   delivery,receipt,invitationId:source==="manual"?claims.id:null,approvedBy:source==="group"?null:w.root,supersedesFleetId:null,enrolmentCodeId:source==="code"?w.code.id:null};
  const use={requestId:binding.requestId,fleetId:binding.fleetId,owner:w.owner},expected=w.codes.get(w.code.id);
  w.db.transaction(()=>{
   records.insert(record);records.insert({...record,binding:{...binding,requestId:randomUUID()},stage:"pending",delivery:null,receipt:null,issuedHash:null});
   w.db.prepare("INSERT INTO hub_company_join_cipher_nonces VALUES(?,?)").run(receipt.keyId,receipt.nonce);
   w.db.prepare("INSERT INTO hub_company_join_nonces VALUES(?,?,?,?)").run("retained-nonce",JSON.stringify(binding),"redeem",121_000);
   w.db.prepare("INSERT INTO hub_company_join_invites VALUES(?,?)").run(claims.id,JSON.stringify({claims,digest:sha256(invitation),requestId:source==="manual"?binding.requestId:null,consumed:source==="manual"}));
   if(source==="code")w.codes.consume(expected,use);
  }).immediate();
  const inventory=captureRoleCutoverInventory(w.db,w.transport,()=>{}),key=readFileSync(join(w.home,"hub/secrets/join-delivery.key")),prior=records.get(binding.requestId);
  expect(w.cutover.migrate()).toMatchObject({ok:true});expect(captureRoleCutoverInventory(w.db,w.transport,()=>{})).toEqual(inventory);
  expect(records.current(prior)).toBe(true);expect(records.get(binding.requestId)).toEqual(prior);
  const offer=w.db.prepare("SELECT body FROM hub_company_join_invites").get()as{body:string};expect(companyInvitationRecord.parse(JSON.parse(offer.body)).claims).toEqual(verifyCompanyInvitation(invitation,1_000));
  expect(readFileSync(join(w.home,"hub/secrets/join-delivery.key"))).toEqual(key);
  expect(createJoinSealer(w.home,()=>true).open(delivery,receipt,1_001)).toBe(credential);
  expect(()=>sealer.open({...delivery,provenanceDigest:"e".repeat(64)},receipt,1_001)).toThrow();expect(()=>sealer.open(delivery,receipt,121_000)).toThrow();
  if(source==="code"){
   w.db.transaction(()=>w.codes.revoke(w.code.id,w.root)).immediate();w.time(3_600_001);
   expect(()=>w.db.transaction(()=>w.codes.consume(expected,use)).immediate()).not.toThrow();
   expect(()=>w.db.transaction(()=>w.codes.consume(expected,{...use,requestId:randomUUID()})).immediate()).toThrow();expect(w.codes.get(w.code.id).uses).toBe(1);
  }
 });
 it("refuses a clock rollback after reopening the persisted cutover marker",()=>{
  const w=fixture();expect(w.cutover.migrate()).toMatchObject({ok:true});w.time(-1);
  expect(createHubRoleCutover(w.options).migrate()).toEqual({ok:false,code:"expired"});expect(w.refresh).toHaveBeenCalledOnce();
 });
 it("switches roles off/on through the real writer using current forward projection, without resource resurrection or a second migration notice",async()=>{
  const w=fixture();
  const directory:HubDirectory={realm:"corp",async signIn(){return{ok:false,reason:"invalid-credentials"};},async checkEligibility(who){return{eligible:true,person:{key:who,login:who.objectId,dn:"synthetic",groups:[]}};},async close(){}};
  const reads=createHubGroupPolicyStore({db:w.db,hubId:w.hubId,realm:"corp",generation:"g1",directory,audit:w.audit,current:()=>true,now:w.options.now});
  expect(w.cutover.migrate()).toMatchObject({ok:true});
  const context:HubRequestContext={requestId:randomUUID(),isCurrent:()=>true,async current(){return{kind:"directory",person:w.root,sessionId:"synthetic-root"};},async requirePerson(){return w.root;},async requireAdmin(){throw Error("legacy admin flag must not authorize roles");}};
  const writer=createHubRoleWriter({...w.options,audit:w.audit,directory,reads,effects:createHubRoleModeEffects(w.db,w.transport,()=>true),version:()=>w.transport.read().revocationVersion,
   advanceAuthorization(tx){expect(tx).toBe(w.db);w.transport.mutate({at:1_000,requestId:randomUUID(),actor:{kind:"local-host"},action:"role.mode-epoch",result:"completed"},s=>{s.revocationVersion++;});}});
  const notices=await writer.notices(context);expect(notices.ok).toBe(true);if(!notices.ok)throw Error("notice read refused");
  expect(notices.notices).toHaveLength(1);expect(notices.notices[0]!.body).toMatchObject({kind:"roles-available",accessChanged:false});
  expect(await writer.acknowledge(notices.notices[0]!.id,context)).toEqual({ok:true});expect(await writer.notices(context)).toEqual({ok:true,notices:[]});
  const before=parseRolePolicy(JSON.parse(w.raw())),inventory=captureRoleCutoverInventory(w.db,w.transport,()=>{});
  const flip=async(active:boolean)=>{const next=parseRolePolicy(JSON.parse(w.raw()));next.rolesActive=active;const p=await writer.preview(next,context);expect(p.ok).toBe(true);if(!p.ok)throw Error("mode preview refused");return writer.apply(next,p.previewDigest,context);};
  expect(await flip(false)).toMatchObject({ok:true,revision:8});expect(parseRolePolicy(JSON.parse(w.raw()))).toEqual({...before,rolesActive:false,revision:8});
  expect(await flip(false)).toMatchObject({ok:true,revision:8});expect(w.transport.read().revocationVersion).toBe(2);
  // A later current-document removal while off must not be restored by the on control.
  const narrowed=parseRolePolicy(JSON.parse(w.raw()));narrowed.assignments=[];narrowed.revision++;
  w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(narrowed));
  expect(await flip(true)).toMatchObject({ok:true,revision:10});expect(parseRolePolicy(JSON.parse(w.raw()))).toEqual({...narrowed,rolesActive:true,revision:10});
  expect(captureRoleCutoverInventory(w.db,w.transport,()=>{})).toEqual(inventory);
  expect(w.db.prepare("SELECT * FROM hub_role_events WHERE json_extract(body,'$.kind')='roles-available'").all()).toHaveLength(1);
  expect(createHubRoleCutover(w.options).migrate()).toMatchObject({ok:true,changed:false,epoch:3});
  const facts={kind:"eligible"as const,person:w.owner,observedAt:1_000};expect(evaluateRolePolicy(JSON.parse(w.raw()),w.owner,"pair_fleet",null,{subject:facts},1_000,w.root).outcome).toBe("deny");
 });
 it("the mode adapter refuses other role edits and stale resource images",async()=>{
  const w=fixture();expect(w.cutover.migrate()).toMatchObject({ok:true});const before=parseRolePolicy(JSON.parse(w.raw())),next=structuredClone(before);next.assignments=[];
  const {planRoleChange}=await import("../src/hub/roles/change.js"),effects=createHubRoleModeEffects(w.db,w.transport,()=>true);
  await expect(effects.prepare(planRoleChange(before,next,w.root,1_000),new Map(),()=>{})).rejects.toThrow();
  const off={...before,rolesActive:false},prepared=await effects.prepare(planRoleChange(before,off,w.root,1_000),new Map(),()=>{});
  expect(()=>prepared.commit(w.db)).toThrow();w.db.prepare("UPDATE hub_enrolment_codes SET uses=uses+1").run();expect(()=>prepared.assertCurrent()).toThrow();
 });
 it.each(["wrong-hub","unknown-schema","missing-table","changed-lifetime"]as const)("refuses %s before advancing the floor",mode=>{
  const w=fixture();
  if(mode==="wrong-hub")w.db.prepare("UPDATE hub_instance SET hub_id=?").run(randomUUID());
  if(mode==="unknown-schema")w.db.prepare("INSERT INTO hub_schema(component,version) VALUES('future-roles',1)").run();
  if(mode==="missing-table")w.db.exec("DROP TABLE hub_company_join_nonces");if(mode==="changed-lifetime")w.stop();
  expect(w.cutover.migrate()).toMatchObject({ok:false});expect(w.fileFloor.read()).toBe(0);expect(w.raw()).toBe(w.oldRaw);
 });
 it.each(["marker","registry","old-transport"]as const)("refuses a missing %s proof after committed conversion",mode=>{
  const w=fixture(),old=(w.db.prepare("SELECT state FROM hub_transport_state").get()as{state:string}).state;
  expect(w.cutover.migrate()).toMatchObject({ok:true});
  if(mode==="marker")w.db.exec("DELETE FROM hub_role_cutover");if(mode==="registry")w.db.exec("DELETE FROM hub_schema WHERE component='roles-expiry'");
  if(mode==="old-transport")w.db.prepare("UPDATE hub_transport_state SET state=?").run(old);
  expect(createHubRoleCutover(w.options).migrate()).toMatchObject({ok:false});expect(w.refresh).toHaveBeenCalledOnce();
 });
 it("includes actual code bytes in the inventory",()=>{
  const w=fixture(),before=captureRoleCutoverInventory(w.db,w.transport,()=>{});w.db.prepare("UPDATE hub_enrolment_codes SET uses=uses+1").run();
  expect(captureRoleCutoverInventory(w.db,w.transport,()=>{}).digest).not.toBe(before.digest);
 });
});
