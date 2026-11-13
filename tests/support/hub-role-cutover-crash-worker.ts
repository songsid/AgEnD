/** Owned Node process only. SIGKILL at the real durable boundaries; no service or host lifecycle. */
import {readFileSync} from "node:fs";
import {openHubDatabase} from "../../src/hub/db.js";
import {createHubAudit} from "../../src/hub/audit/index.js";
import {HubTransportStore} from "../../src/hub/store.js";
import {HubFileVersionFloor} from "../../src/hub/version-floor.js";
import {createHubRoleCutover} from "../../src/hub/roles/cutover.js";
import {createHubRoleWriter} from "../../src/hub/roles/writer.js";
import {createHubRoleModeEffects} from "../../src/hub/roles/mode-effects.js";
import type {HubDirectory} from "../../src/hub/directory/types.js";
import type {HubRequestContext} from "../../src/hub/types.js";
import type {PersonKey} from "../../src/hub/types.js";
import {roleCutoverLegacyPlan} from "./hub-role-cutover-plan.js";
const c=JSON.parse(readFileSync(process.argv[2]!,"utf8"))as{home:string;hubId:string;root:PersonKey;auditKey:string;phase:string};
const mode=c.phase.startsWith("mode-"),point=c.phase.replace(/^mode-/,"");
const db=openHubDatabase(c.home,"hub/hub.sqlite",{create:false}),floor=new HubFileVersionFloor(c.home,"hub/floors/transport");
const audit=createHubAudit({db,contentKey:Buffer.from(c.auditKey,"base64"),now:()=>1_000});
const die=()=>{process.kill(process.pid,"SIGKILL");throw Error("SIGKILL did not terminate the fixture");};
const transport=new HubTransportStore(db,{floor:{read:()=>floor.read(),raise(n){if(point==="before-floor")die();floor.raise(n);if(point==="after-floor")die();}},
 appendAudit(e,tx){audit.appendInTransaction(e,tx);if(point==="after-audit")die();}});
let ok=false;
if(mode){
 // Admission/session are inert fixture boundaries here; actual shared-pool mode tests run in the parent suite.
 const directory:HubDirectory={realm:"corp",async signIn(){return{ok:false,reason:"invalid-credentials"};},async checkEligibility(who){return{eligible:true,person:{key:who,login:who.objectId,dn:"synthetic",groups:[]}};},async close(){}};
 const context:HubRequestContext={requestId:"fixture-mode",isCurrent:()=>true,async current(){return{kind:"directory",person:c.root,sessionId:"fixture-root"};},async requirePerson(){return c.root;},async requireAdmin(){throw Error("not used");}};
 const writer=createHubRoleWriter({db,hubId:c.hubId,realm:"corp",generation:"g1",root:c.root,audit,directory,
  reads:{async withDirectoryRead(_actor,read){return read();}},effects:createHubRoleModeEffects(db,transport,()=>true),current:()=>true,version:()=>transport.read().revocationVersion,
  advanceAuthorization(){transport.mutate({at:1_000,requestId:"fixture-mode-epoch",actor:{kind:"local-host"},action:"role.mode-epoch",result:"completed"},s=>{s.revocationVersion++;});},
  now:()=>1_000,elapsedNow:()=>0,refreshAuthorization(){if(point==="after-commit")die();}});
 const next=JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get()as{body:string}).body);next.rolesActive=false;
 const preview=await writer.preview(next,context);if(preview.ok)ok=(await writer.apply(next,preview.previewDigest,context)).ok;
}else{
 const r=createHubRoleCutover({db,hubId:c.hubId,realm:"corp",generation:"g1",root:c.root,transport,migrations:roleCutoverLegacyPlan(c.hubId),current:()=>true,
  now:()=>1_000,elapsedNow:()=>0,refreshAuthorization(){if(point==="after-commit")die();}}).migrate();ok=r.ok;
}
// Any accidental early refusal fails the parent signal assertion, rather than counting as a crash.
process.exit(ok?11:12);
