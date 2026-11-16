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
