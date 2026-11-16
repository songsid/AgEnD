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

it.each(["presentation","read"] as const)("%s rechecks real directory eligibility before returning role visibility",async method=>{
 const w=await world();w.eligible.mockClear();w.eligible.mockResolvedValue({eligible:false,reason:"disabled"});
 await expect(w.control[method](w.ctx.ctx)).rejects.toMatchObject({code:"revoked"});expect(w.eligible).toHaveBeenCalledWith(w.admin);
});

it.each(["not json",JSON.stringify({kind:"person",person:{realm:"corp",objectId:"bad"}}),JSON.stringify({kind:"legacy",label:"PRIVATE-LEGACY-LABEL"})])("keeps an unreadable legacy audit actor from breaking the metadata page (%s)",async actor=>{
 const w=await world(),id=randomUUID();w.db.transaction(()=>w.audit.appendInTransaction({id,sequence:0,at:100,requestId:randomUUID(),actor:{kind:"person",person:w.root},action:"fixture.legacy",result:"completed",policyVersion:1},w.db)).immediate();
 // Deliberate legacy/corrupt input: it is never used as authority or a valid-chain claim.
 w.db.prepare("UPDATE hub_audit SET actor=? WHERE id=?").run(actor,id);
 const page=await w.control.audit(w.ctx.ctx,{});expect(page.rows.find(row=>row.id===id)?.actor).toEqual({id:"unknown",name:""});expect(JSON.stringify(page)).not.toContain("PRIVATE-LEGACY-LABEL");
});
it("normal retention prunes role audit-read events and preserves the audit checkpoint chain",async()=>{
 const w=await world();await w.control.audit(w.ctx.ctx,{});const old=w.db.prepare("SELECT id FROM hub_audit WHERE action='role.audit-read'").get() as {id:string};expect(old).toBeTruthy();
 w.time(2*86400000);expect(w.audit.purge({contentDays:1,eventDays:1}).events).toBeGreaterThan(0);expect(w.db.prepare("SELECT id FROM hub_audit WHERE id=?").get(old.id)).toBeUndefined();expect(w.audit.verifyChain().ok).toBe(true);
});

it("remembers searched directory labels for assignments without creating signed-in people or authority",async()=>{
 const w=await world();
 w.directory.searchGrantPeople=async()=>({ok:true,people:[{person:w.other,login:"alex",displayName:"Alex Chen"}],truncated:false});
 const rows=await w.control.search(w.ctx.ctx,{kind:"person",q:"Al"});expect(rows[0]?.name).toBe("Alex Chen");
 expect(w.db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(`${w.other.realm}/${w.other.objectId}`)).toBeUndefined();
 w.policy.assignments.push({id:"display-only",roleId:"builtin:member",subject:{kind:"person",person:w.other},scope:{kind:"hub"},maxFleets:null,startsAt:0,expiresAt:null,assignedAt:0,assignedBy:w.root});w.save(w.policy);
 expect((await w.control.read(w.ctx.ctx)).personLabels).toContainEqual({id:`${w.other.realm}/${w.other.objectId}`,name:"Alex Chen"});
 expect((await w.control.presentation((await w.browser(w.other)).ctx)).management).toEqual([]);
});
