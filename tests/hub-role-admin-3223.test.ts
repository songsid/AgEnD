/** Real role authority, sessions, SQLite and audit; directory is inert and owned. No live Hub/account. */
import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {roleAuthorityWorld} from "./support/hub-role-authority-rig.js";
import {createHubRoleAdminControl} from "../src/hub/roles/admin-control.js";
import {createHubRoleWriter} from "../src/hub/roles/writer.js";
import type {RoleWriteEffects} from "../src/hub/roles/writer.js";
import {MANAGEMENT_PERMISSIONS} from "../src/hub/roles/model.js";
async function world(){
 const w=await roleAuthorityWorld();
 // This controller rig has no retained resources; production effects are exercised in their own mount tests.
 const effects:RoleWriteEffects={snapshot:()=>({fingerprint:"empty",ordinaryFingerprint:"empty",people:[]}),async prepare(){return{fingerprint:"empty",changed:false,impact:{},assertCurrent(){},commit(){},assertCommitted(){}};}};
 const writer=createHubRoleWriter({db:w.db,hubId:w.hubId,realm:"corp",generation:"g1",root:w.root,directory:w.directory,audit:w.audit,reads:w.pool,effects,current:w.options.current,version:w.options.version,advanceAuthorization:w.advance,refreshAuthorization(){},now:w.options.now});
 const control=createHubRoleAdminControl({db:w.db,root:w.root,directory:w.directory,reads:w.pool,management:w.authority,writer,audit:w.audit,policy:()=>w.policy,current:w.options.current,now:w.options.now});
 // The production mount injects the same management authority and role controller into the session Core.
 w.core.deps.management=w.authority;w.core.deps.roleAdmin=control;
 return {...w,writer,control};
}
it("presents a second admin and grants a request-owned admin proof without recursion",async()=>{
 const w=await world();expect(await w.control.presentation(w.ctx.ctx)).toEqual({admin:true,management:MANAGEMENT_PERMISSIONS});
 const view=await w.control.read(w.ctx.ctx);expect(view.policy?.assignments[0]?.subject).toEqual({kind:"person",person:w.admin});
 expect(await w.ctx.ctx.requireAdmin()).toMatchObject({kind:"directory",person:w.admin});expect(w.ctx.ctx.isCurrent?.()).toBe(true);
 w.policy.assignments=[];w.save(w.policy);expect(w.ctx.ctx.isCurrent?.()).toBe(false);
 const fresh=await w.browser(w.admin);await expect(fresh.ctx.requireAdmin()).rejects.toMatchObject({code:"denied"});
});
it("metadata audit permission is distinct from assigning or editing roles",async()=>{
 const w=await world();w.policy.roles.push({id:"auditor",name:"Auditor",kind:"custom",permissions:["audit.view"],defaultMaxFleets:0});
 w.policy.assignments.push({id:"auditor",roleId:"auditor",subject:{kind:"person",person:w.other},scope:{kind:"hub"},maxFleets:null,startsAt:0,expiresAt:null,assignedBy:w.root,assignedAt:0});w.save(w.policy);
 const auditor=await w.browser(w.other);expect(await w.control.presentation(auditor.ctx)).toEqual({admin:false,management:["audit.view"]});
 expect((await w.control.read(auditor.ctx)).policy).toBeNull();
 await expect(auditor.ctx.requireAdmin()).rejects.toMatchObject({code:"denied"});
 const id=randomUUID();let contentRef="";w.core.deps.uow.atomic(tx=>{contentRef=w.audit.content.put(tx,{answer:"PRIVATE-ANSWER-TEXT"});w.audit.appendInTransaction({id,sequence:0,at:100,requestId:randomUUID(),actor:{kind:"person",person:w.root},action:"room.answer",result:"completed",policyVersion:1,contentRef},w.db);});
 const page=await w.control.audit(auditor.ctx,{});expect(page.rows.some(row=>row.id===id)).toBe(true);expect(JSON.stringify(page)).not.toContain(contentRef);expect(JSON.stringify(page)).not.toContain("PRIVATE-ANSWER-TEXT");expect(JSON.stringify(page)).not.toContain("contentRef");
});
it("does not disclose an awaited group search after assignment revocation",async()=>{
 const w=await world();Object.assign(w.directory,{groupPolicy:"ad-direct-guid"});let entered!:()=>void,release!:()=>void;const start=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 w.directory.searchPolicyGroups=async()=>{entered();await held;return{ok:true,groups:[{objectId:randomUUID(),cn:"Private group name",dn:"CN=Private"}],truncated:false};};
 const searching=w.control.search(w.ctx.ctx,{kind:"group",q:"Pr"});await start;w.policy.assignments=[];w.save(w.policy);release();await expect(searching).rejects.toMatchObject({code:"unavailable"});
});

it("accepts the actual writer UUID preview and applies only its checked document",async()=>{
 const w=await world(),next=structuredClone(w.policy);next.rolesActive=false;
 const preview=await w.control.preview(w.ctx.ctx,next);if(!preview.ok)throw Error(preview.code);expect(preview.ok).toBe(true);
 expect(preview.previewDigest).toMatch(/^[0-9a-f-]{36}$/);
 const result=await w.control.apply(w.ctx.ctx,{policy:next,previewDigest:preview.previewDigest});expect(result).toMatchObject({ok:true,revision:2});
 expect(JSON.parse((w.db.prepare("SELECT body FROM hub_group_policy").get() as {body:string}).body).rolesActive).toBe(false);
});
