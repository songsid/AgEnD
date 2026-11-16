import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {createHubHttp} from "../src/hub/http/compose.js";
import {hubTxDatabase} from "../src/hub/db.js";
import {hubCookieName,hubCsrfOf} from "../src/hub/sessions.js";
import {createHubGroupWelcome} from "../src/hub/group-policy/welcome.js";
import {createHubRoleAllowedListControl} from "../src/hub/roles/allowed-list-control.js";
import {createHubRoleAdminControl} from "../src/hub/roles/admin-control.js";
import {createHubGroupAdminInventory} from "../src/hub/group-policy/admin-inventory.js";
import {createHubGroupAuthorization} from "../src/hub/group-policy/authorization.js";
import {readHubOperationalPolicy} from "../src/hub/group-policy/store.js";
import {parseRolePolicy} from "../src/hub/roles/model.js";
import type {HubGroupAdminControl,GroupAdminContext} from "../src/hub/group-policy/admin-dto.js";
import {createHubRoleExpiryEffects} from "../src/hub/roles/expiry-effects.js";
import {createHubRoleExpirySettlement} from "../src/hub/roles/expiry.js";
/** Real SQL, role writer, resource ledger and audit; inert eligible directory, no network. */
import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {roleAuthorityWorld} from "./support/hub-role-authority-rig.js";
import {HUB_TEAMS_MIGRATION} from "../src/hub/teams/store.js";
import {createHubGroupResources} from "../src/hub/group-policy/resources.js";
import {createHubRoleResourceEffects} from "../src/hub/roles/resource-effects.js";
import {createHubRoleWriter} from "../src/hub/roles/writer.js";
import {BUILTIN_ROLE_IDS} from "../src/hub/roles/model.js";
async function fixture(){
 const w=await roleAuthorityWorld();HUB_TEAMS_MIGRATION.up(w.db);const fleetId=randomUUID();
 w.store.mutate({at:100,requestId:randomUUID(),actor:{kind:"local-host"},action:"fixture.fleet",result:"completed"},s=>s.fleets.push({id:fleetId,owner:w.other,generation:1,status:"active",credentialHash:"a".repeat(64)}));
 w.policy.assignments.push({id:"owner",roleId:BUILTIN_ROLE_IDS.member,subject:{kind:"person",person:w.other},scope:{kind:"hub"},maxFleets:2,startsAt:0,expiresAt:null,assignedBy:w.root,assignedAt:0});w.save(w.policy);
 const resources=createHubGroupResources({db:w.db,policy:w.pool,audit:w.audit,current:w.options.current,now:w.options.now});
 const resource={kind:"fleet" as const,id:fleetId,owner:w.other,revision:1},ctx={requestId:randomUUID(),current:w.options.current};
 const effects=createHubRoleResourceEffects({db:w.db,root:w.root,transport:w.store,policy:w.pool,audit:w.audit,current:w.options.current,now:w.options.now});
 const writer=createHubRoleWriter({db:w.db,hubId:w.hubId,realm:"corp",generation:"g1",root:w.root,directory:w.directory,audit:w.audit,reads:w.pool,effects,current:w.options.current,version:w.options.version,advanceAuthorization:w.advance,refreshAuthorization(){},now:w.options.now});
 await resources.register(resource,ctx);return{...w,resource,resources,writer,effects};
}
it("suspends the exact retained group resource with its role write and keeps its ordinary Fleet",async()=>{
 const w=await fixture(),next=structuredClone(w.policy);next.assignments=next.assignments.filter(a=>a.id!=="owner");
 const preview=await w.writer.preview(next,w.ctx.ctx);if(!preview.ok)throw Error(preview.code);
 expect(preview.impact).toMatchObject({suspendedOnSave:[{kind:"fleet",id:w.resource.id}]});
 expect(await w.writer.apply(next,preview.previewDigest,w.ctx.ctx)).toMatchObject({ok:true});
 expect(w.resources.read(w.resource)).toMatchObject({source:"group",state:"suspended",revision:2});expect(w.store.read().fleets[0]?.status).toBe("active");expect(w.audit.verifyChain().ok).toBe(true);
});
it("a retained-resource drift between preview and apply cannot suspend a different revision",async()=>{
 const w=await fixture(),next=structuredClone(w.policy);next.assignments=next.assignments.filter(a=>a.id!=="owner");const preview=await w.writer.preview(next,w.ctx.ctx);if(!preview.ok)throw Error(preview.code);
 w.store.mutate({at:100,requestId:randomUUID(),actor:{kind:"local-host"},action:"fixture.replaced",result:"completed"},s=>{s.fleets[0]!.generation=2;});
 expect(await w.writer.apply(next,preview.previewDigest,w.ctx.ctx)).toMatchObject({ok:false,code:"conflict"});expect(w.resources.read(w.resource)).toMatchObject({state:"active",revision:1});
});

it("settles an expired assignment once, suspends its exact resource and audits the local host",async()=>{
 const w=await fixture();w.policy.assignments.find(a=>a.id==="owner")!.expiresAt=200;w.save(w.policy);w.time(100);
 const effects=createHubRoleExpiryEffects({db:w.db,root:w.root,transport:w.store,policy:w.pool,audit:w.audit,directory:w.directory,reads:w.pool,current:w.options.current,now:w.options.now});
 const settlement=createHubRoleExpirySettlement({db:w.db,hubId:w.hubId,realm:"corp",generation:"g1",root:w.root,directory:w.directory,audit:w.audit,reads:w.pool,effects,current:w.options.current,version:w.options.version,advanceAuthorization:w.advance,refreshAuthorization(){},now:w.options.now});
 const epoch=w.options.version();expect(await settlement.settle()).toEqual({ok:true,settled:1});expect(w.options.version()).toBe(epoch+1);expect(w.resources.read(w.resource)).toMatchObject({state:"suspended",source:"group",revision:2});
 const actor=w.db.prepare("SELECT actor FROM hub_audit WHERE action='group-resource.suspended'").get() as {actor:string};expect(JSON.parse(actor.actor)).toEqual({kind:"local-host"});
 expect(await settlement.settle()).toEqual({ok:true,settled:0});expect(w.options.version()).toBe(epoch+1);expect(w.audit.verifyChain().ok).toBe(true);
 w.time(-1);expect(()=>settlement.assertAuthorizationTime()).toThrow();settlement.close();
});

function shortcut(w:Awaited<ReturnType<typeof fixture>>){
 const unused=async():Promise<never>=>{throw Error("legacy path must not run on a role document");};
 const legacy:HubGroupAdminControl={read:unused,resolve:unused,preview:unused,apply:unused,resume:unused};
 const roleAdmin=createHubRoleAdminControl({db:w.db,root:w.root,directory:w.directory,reads:w.pool,management:w.authority,writer:w.writer,audit:w.audit,policy:()=>parseRolePolicy(readHubOperationalPolicy(w.pool)),current:w.options.current,now:w.options.now});
 const authorization=createHubGroupAuthorization({db:w.db,administrator:w.root,policy:()=>w.pool,binding:()=>({kind:"ready"}),audit:w.audit,current:w.options.current,now:w.options.now,directory:w.directory,version:w.options.version,advanceAuthorization:w.advance,refreshAuthorization(){},roleAdministrators:true});
 const control=createHubRoleAllowedListControl({db:w.db,root:w.root,directory:w.directory,policy:w.pool,legacy,management:w.authority,roleAdmin,writer:w.writer,inventory:createHubGroupAdminInventory({db:w.db,transport:w.store,realm:"corp"}),authorization,current:w.options.current,now:w.options.now,version:w.options.version});
 const ctx:GroupAdminContext={requestId:w.ctx.ctx.requestId,current:()=>w.ctx.ctx.isCurrent?.()===true,requireAdmin:w.ctx.ctx.requireAdmin,roleContext:w.ctx.ctx};
 return{control,ctx,roleAdmin};
}
it("keeps the old hex preview contract while the role writer seals the current full graph",async()=>{
 const w=await fixture(),{control,ctx}=shortcut(w),loaded=await control.read(ctx);expect(loaded.policy).not.toBeNull();const next=structuredClone(loaded.policy!);next.people=[{person:w.other,name:"Owner",allow:["ask_agents"],maxFleets:0}];
 const checked=await control.preview({policy:next},ctx);if(!checked.ok)throw Error(checked.code);expect(checked.previewDigest).toMatch(/^[0-9a-f]{64}$/);
 expect(await control.apply({policy:next,previewDigest:checked.previewDigest},ctx)).toMatchObject({ok:true,policyRevision:2});expect(parseRolePolicy(readHubOperationalPolicy(w.pool)).assignments).toEqual(w.policy.assignments);expect(parseRolePolicy(readHubOperationalPolicy(w.pool)).people).toEqual(next.people);
 expect(await control.apply({policy:next,previewDigest:checked.previewDigest},ctx)).toMatchObject({ok:false});control.close();
});
it("refuses a shortcut request without the private HTTP identity context",async()=>{
 const w=await fixture(),{control,ctx}=shortcut(w),{roleContext:_private,...unbound}=ctx;
 await expect(control.read(unbound)).rejects.toMatchObject({code:"unavailable"});control.close();
});
it("an auxiliary administrator resumes an exact resource under its own identity and owned epoch advance",async()=>{
 const w=await fixture();w.db.transaction(()=>w.resources.suspend(w.resource,w.admin,{requestId:randomUUID(),current:w.options.current})).immediate();
 const {control,ctx}=shortcut(w),read=await control.read(ctx);expect(read.paused).toHaveLength(1);const row=read.paused[0]!;
 expect(await control.resume({resource:row.resource,expectedPolicyRevision:read.policy!.revision,expectedLifecycleRevision:row.lifecycleRevision},ctx)).toMatchObject({ok:true,state:"active",lifecycleRevision:3});
 const actor=w.db.prepare("SELECT actor FROM hub_audit WHERE action='group-resource.resumed'").get() as {actor:string};expect(JSON.parse(actor.actor)).toEqual({kind:"person",person:w.admin});expect(w.admin).not.toEqual(w.root);control.close();
});

it("carries the private session context through the existing HTTP shortcut without accepting it from JSON",async()=>{
 const w=await fixture(),{control,roleAdmin}=shortcut(w);w.core.deps.management=w.authority;w.core.deps.roleAdmin=roleAdmin;
 w.core.deps.groupHttp={control,welcome:createHubGroupWelcome({policy:()=>w.pool,readiness:()=>"ready",fleets:()=>w.store.read().fleets})};
 const http=createHubHttp(w.core.deps,hubTxDatabase),server=createServer((req,res)=>{if(!http.handle(req,res)){res.writeHead(404);res.end();}});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 try{
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,headers={cookie:`${hubCookieName(w.hubId)}=${w.ctx.token}`,origin:w.core.deps.config.webOrigin,"x-agend-hub-csrf":hubCsrfOf(w.ctx.token),"content-type":"application/json"};
  const read=await fetch(base+"/hub/v1/admin/group-policy",{headers});expect(read.status).toBe(200);const body=await read.json();body.policy.people=[{person:w.other,name:"Owner",allow:["ask_agents"],maxFleets:0}];
  const response=await fetch(base+"/hub/v1/admin/group-policy/preview",{method:"POST",headers,body:JSON.stringify({policy:body.policy})});expect(response.status).toBe(200);const checked=await response.json();expect(checked.previewDigest).toMatch(/^[0-9a-f]{64}$/);
  const denied=await fetch(base+"/hub/v1/admin/group-policy",{method:"PUT",headers,body:JSON.stringify({policy:body.policy,previewDigest:checked.previewDigest,roleContext:{person:w.root}})});expect(denied.status).toBe(400);
  const saved=await fetch(base+"/hub/v1/admin/group-policy",{method:"PUT",headers,body:JSON.stringify({policy:body.policy,previewDigest:checked.previewDigest})});expect(saved.status).toBe(200);expect(parseRolePolicy(readHubOperationalPolicy(w.pool)).people).toEqual(body.policy.people);
 }finally{control.close();await http.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
