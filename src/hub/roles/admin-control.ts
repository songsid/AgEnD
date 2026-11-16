/** Mounted role settings use the existing writer and operation authority; no alternate policy writer. */
import type Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {HubDirectory} from "../directory/types.js";
import type {HubDirectoryReads} from "../directory/admission.js";
import type {HubAuditStore} from "../audit/index.js";
import type {HubRequestContext,PersonKey} from "../types.js";
import {personKeyString} from "../identity.js";
import {rememberRoomPeople} from "../rooms/directory.js";
import {HubProtocolError,epoch,person,uuid,identifier,plain,validated,parseStrictJson} from "../validation.js";
import {evaluateRolePolicy} from "./evaluate.js";
import {MANAGEMENT_PERMISSIONS,ROLE_PERMISSIONS,parseRolePolicy,type HubRolePolicy} from "./model.js";
import type {HubManagementAuthority} from "./authority.js";
import type {createHubRoleWriter} from "./writer.js";
import type {RoleAdminControl,RoleAuditRow,RoleDirectoryCandidate} from "./admin-types.js";
import {rolePersonLabel,roleAuditDetailsSchema,roleAuditValue,assignmentAuditValue} from "./audit-details.js";
// The writer issues an opaque UUID preview token, not a content hash.
const digest=uuid;
const applyInput=z.strictObject({policy:z.unknown(),previewDigest:digest});
const rootInput=z.strictObject({previewDigest:digest});
const searchInput=z.strictObject({kind:z.enum(["person","group"]),q:plain(64).trim().min(2).max(64).regex(/^[^\u0000-\u001f\u007f]+$/)});
const auditInput=z.strictObject({cursor:z.string().regex(/^[1-9][0-9]{0,15}$/).optional(),from:epoch.optional(),to:epoch.optional(),person:plain(256).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),action:z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/).optional()}).refine(q=>q.from===undefined||q.to===undefined||q.from<=q.to);
const personHit=z.strictObject({person,displayName:plain(256),login:plain(256)});
const groupHit=z.strictObject({objectId:uuid,cn:plain(256),dn:plain(4096)});
const auditActor=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("person"),person}),z.object({kind:z.literal("local-host")}),z.object({kind:z.literal("member"),fleetId:identifier}),
]);
function actorId(raw:string){
 try{const actor=auditActor.parse(parseStrictJson(raw,4096));return actor.kind==="person"?personKeyString(actor.person):actor.kind==="local-host"?"local-host":`fleet:${actor.fleetId}`;}catch{return "unknown";}
}

export interface RoleAdminOptions {
 db:Database.Database;root:PersonKey;directory:HubDirectory;reads:Pick<HubDirectoryReads,"withDirectoryRead">;
 management:Pick<HubManagementAuthority,"require">;writer:ReturnType<typeof createHubRoleWriter>;
 audit:Pick<HubAuditStore,"appendInTransaction">;policy():HubRolePolicy;current():boolean;now?:()=>number;
}
export function createHubRoleAdminControl(options:RoleAdminOptions):RoleAdminControl & {presentation(ctx:HubRequestContext):Promise<{admin:boolean;management:readonly string[]}>;close():void} {
 const {db,root,directory,reads,management,writer}=options,now=options.now??Date.now;
 const buckets=new Map<string,{at:number;count:number}>();let closed=false;
 const live=(ctx:HubRequestContext)=>{if(closed||options.current()!==true||ctx.isCurrent?.()!==true)throw new HubProtocolError("unavailable");};
 const currentPolicy=()=>parseRolePolicy(options.policy());
 const personLabel=(id:string)=>rolePersonLabel(db,id);
 const display=async(ctx:HubRequestContext)=>{
  // Production HubSessions.requirePerson performs a fresh directory eligibility read and
  // rechecks the owned session after that await. This snapshot drives presentation only;
  // read/search/audit/apply still acquire their separate operation-owned proofs.
  live(ctx);const actor=await ctx.requirePerson();live(ctx);const policy=currentPolicy(),raw=JSON.stringify(policy),at=now();
  const permissions=MANAGEMENT_PERMISSIONS.filter(cap=>evaluateRolePolicy(policy,actor,cap,null,{subject:{kind:"eligible",person:actor,observedAt:at}},at,root).outcome==="allow");
  const assert=()=>{live(ctx);if(JSON.stringify(currentPolicy())!==raw)throw new HubProtocolError("conflict");};assert();return{actor,policy,permissions,assert};
 };
 return {
  async presentation(ctx){const selected=await display(ctx);selected.assert();return{admin:selected.permissions.includes("hub.admin"),management:selected.permissions};},
  async read(ctx){
   const selected=await display(ctx);if(!selected.permissions.length)throw new HubProtocolError("denied");
   const canAssign=selected.permissions.includes("roles.assign");
   const proof=canAssign?await management.require(ctx,"roles.assign"):null;selected.assert();proof?.assertCurrent();
   const rootSelfUsed=!!db.prepare("SELECT 1 FROM hub_role_root_self WHERE person=?").get(personKeyString(root));
   const ids=new Set([personKeyString(root),personKeyString(selected.actor),...(canAssign?selected.policy.assignments.flatMap(a=>a.subject.kind==="person"?[personKeyString(a.subject.person)]:[]):[])]);
   const personLabels=[...ids].map(id=>({id,name:personLabel(id)}));
   const out={personLabels,policy:canAssign?selected.policy:null,permissions:ROLE_PERMISSIONS,root,actor:selected.actor,management:selected.permissions,rootSelfUsed};selected.assert();proof?.assertCurrent();return out;
  },
  async search(ctx,input){
   const query=validated(searchInput,input),proof=await management.require(ctx,"roles.assign");live(ctx);proof.assertCurrent();
   const at=now();for(const [key,b]of buckets)if(at<b.at||at-b.at>=60000)buckets.delete(key);
   const id=JSON.stringify([proof.actor.person,proof.actor.sessionId]),bucket=buckets.get(id);if(bucket?bucket.count>=30:buckets.size>=1024)throw new HubProtocolError("backpressure");buckets.set(id,{at:bucket?.at??at,count:(bucket?.count??0)+1});
   const people=directory.searchGrantPeople,groups=directory.searchPolicyGroups,realm=directory.realm;
   let out:RoleDirectoryCandidate[];
   if(query.kind==="person"){
    if(!people)throw new HubProtocolError("unavailable");const found=await reads.withDirectoryRead(proof.actor.person,()=>people.call(directory,query.q));
    if(!found.ok)throw new HubProtocolError("unavailable");out=validated(z.array(personHit).max(20),found.people).map(row=>({kind:"person",key:row.person,name:row.displayName||row.login,login:row.login}));
   }else{
    if(!groups||directory.groupPolicy!=="ad-direct-guid")throw new HubProtocolError("unavailable");const found=await reads.withDirectoryRead(proof.actor.person,()=>groups.call(directory,query.q));
    if(!found.ok)throw new HubProtocolError("unavailable");out=validated(z.array(groupHit).max(20),found.groups).map(row=>({kind:"group",key:{realm,objectId:row.objectId},name:row.cn,dn:row.dn}));
   }
   live(ctx);proof.assertCurrent();if(directory.realm!==realm||directory.searchGrantPeople!==people||directory.searchPolicyGroups!==groups||out.some(row=>row.key.realm!==realm))throw new HubProtocolError("unavailable");
   if(query.kind==="person")db.transaction(()=>{live(ctx);proof.assertCurrent();rememberRoomPeople(db,out.map(row=>({id:personKeyString(row.key),login:row.login!,displayName:row.name})),now());live(ctx);proof.assertCurrent();}).immediate();
   return out;
  },
  async preview(ctx,input){
   const out=await writer.preview(input,ctx);live(ctx);if(!out.ok)return out;
   const {review,...base}=out;
   return {...base,...(review?{review:{losingPermissions:review.losingPermissions.map(row=>({...row,name:personLabel(personKeyString(row.person))})),unverified:review.unverified.map(person=>({person,name:personLabel(personKeyString(person))}))}}:{})};
  },
  apply(ctx,input){const body=validated(applyInput,input);return writer.apply(body.policy,body.previewDigest,ctx);},
  previewRootSelf:ctx=>writer.previewRootSelf(ctx),
  applyRootSelf(ctx,input){const body=validated(rootInput,input);return writer.applyRootSelf(body.previewDigest,ctx);},
  async audit(ctx,input){
   const body=validated(auditInput,input),cursor=body.cursor?Number(body.cursor):Number.MAX_SAFE_INTEGER;if(!Number.isSafeInteger(cursor))throw new HubProtocolError("invalid");
   const proof=await management.require(ctx,"audit.view");live(ctx);proof.assertCurrent();
   return db.transaction(()=>{
    live(ctx);proof.assertCurrent();const appended:unknown=options.audit.appendInTransaction({id:randomUUID(),sequence:0,at:now(),requestId:ctx.requestId,actor:{kind:"person",person:proof.actor.person},action:"role.audit-read",result:"allowed",policyVersion:currentPolicy().revision},db);
    if(appended&&typeof (appended as {then?:unknown}).then==="function"){void Promise.resolve(appended).catch(()=>undefined);throw new HubProtocolError("unavailable");}
    // Deliberately select metadata only; never content_ref, content keys, questions or answers.
    const where=["sequence<?"],params:(string|number)[]=[cursor];
    if(body.from!==undefined){where.push("at>=?");params.push(body.from);}if(body.to!==undefined){where.push("at<=?");params.push(body.to);}
    if(body.action){where.push("action=?");params.push(body.action);}
    if(body.person){where.push("(CASE WHEN json_valid(actor) THEN CASE json_extract(actor,'$.kind') WHEN 'person' THEN json_extract(actor,'$.person.realm')||'/'||json_extract(actor,'$.person.objectId') WHEN 'local-host' THEN 'local-host' WHEN 'member' THEN 'fleet:'||json_extract(actor,'$.fleetId') ELSE 'unknown' END ELSE 'unknown' END)=?");params.push(body.person);}
    const raw=db.prepare(`SELECT id,sequence,at,actor,action,result FROM hub_audit WHERE ${where.join(" AND ")} ORDER BY sequence DESC LIMIT 51`).all(...params) as {id:string;sequence:number;at:number;actor:string;action:string;result:string}[];
    const rows:RoleAuditRow[]=raw.slice(0,50).map(row=>{
     const id=actorId(row.actor);
     const label=id==="unknown"?"":personLabel(id);
     const summary:string[]=[];let details;
     const event=db.prepare("SELECT body FROM hub_role_events WHERE id=?").get(row.id) as {body:string}|undefined;
     if(event){try{
      const e=parseStrictJson(event.body,1024*1024) as {details?:unknown;before?:unknown;after?:unknown};
      let parsed=roleAuditDetailsSchema.safeParse(e.details);
      if(!parsed.success&&["role.created","role.changed","role.deleted","role.assigned","role.unassigned"].includes(row.action)){
       const assignment=row.action==="role.assigned"||row.action==="role.unassigned";
       const convert=(value:unknown)=>value&&typeof value==="object"?(assignment?assignmentAuditValue(value as Parameters<typeof assignmentAuditValue>[0],currentPolicy(),personLabel):roleAuditValue(value as Parameters<typeof roleAuditValue>[0])):null;
       parsed=roleAuditDetailsSchema.safeParse({kind:assignment?"assignment":"role",before:convert(e.before),after:convert(e.after)});
      }
      if(parsed.success){details=parsed.data;for(const [side,value]of [["before",details.before],["after",details.after]]as const)if(value?.roleName)summary.push(`${side}: ${value.roleName}${value.permissions?" · "+value.permissions.join(", "):""}`);}
     }catch{/* Malformed/legacy metadata cannot break the audit page or expose its raw payload. */}}
     return{id:row.id,at:row.at,actor:{id,name:label??""},action:row.action,result:row.result,summary,...(details?{details}:{})};
    });
    live(ctx);proof.assertCurrent();return{rows,nextCursor:raw.length>50?String(rows.length?raw[49]!.sequence:cursor):null};
   }).immediate();
  },
  notices:ctx=>writer.notices(ctx),acknowledge:(ctx,id)=>writer.acknowledge(id,ctx),
  close(){closed=true;buckets.clear();},
 };
}
