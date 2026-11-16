/** Existing allowed-list HTTP contract over the current role graph; all commits still use the sealed role writer. */
import {randomBytes} from "node:crypto";
import {z} from "zod";
import type Database from "better-sqlite3";
import type {HubDirectory} from "../directory/types.js";
import type {HubRequestContext,PersonKey} from "../types.js";
import {personKeyString} from "../identity.js";
import {HubProtocolError,identifier,plain,person,validated} from "../validation.js";
import {readHubOperationalPolicy,type HubGroupPolicyStore} from "../group-policy/store.js";
import {readAllowedListTeams} from "../group-policy/team-subjects.js";
import type {HubGroupAdminInventory} from "../group-policy/admin-inventory.js";
import type {HubGroupAuthorization} from "../group-policy/authorization.js";
import type {GroupAdminContext,HubGroupAdminControl,GroupImpact} from "../group-policy/admin-dto.js";
import {resolveRequest} from "../group-policy/admin-dto.js";
import {GROUP_CAPABILITIES,parseGroupPolicy,type HubGroupPolicy} from "../group-policy/model.js";
import {parseRolePolicy} from "./model.js";
import {mergeRoleAllowedList,projectRoleAllowedList} from "./allowed-list.js";
import type {HubManagementAuthority} from "./authority.js";
import type {RoleAdminControl} from "./admin-types.js";
import type {createHubRoleWriter,RoleWriteCode} from "./writer.js";
const text=plain(1024),rev=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const impactPerson=z.object({personId:text,name:text.nullable(),login:text.nullable(),capabilities:z.array(z.enum(GROUP_CAPABILITIES)).optional()});
const resource=z.object({kind:z.enum(["fleet","exposure","asker"]),id:identifier,revision:rev,label:text.nullable(),owner:z.object({name:text.nullable()}).nullable()});
const impactShape=z.object({losingActions:z.array(impactPerson),losingPublication:z.array(impactPerson),grandfathered:z.array(resource),suspendedOnSave:z.array(resource),adminLosesChat:z.boolean(),held:z.array(impactPerson.extend({reason:z.literal("membership-unknown")})),teamMembers:z.number().int().min(0).optional()});
export function createHubRoleAllowedListControl(options:{
 db:Database.Database;root:PersonKey;directory:HubDirectory;policy:HubGroupPolicyStore;legacy:HubGroupAdminControl;
 management:Pick<HubManagementAuthority,"require">;roleAdmin:RoleAdminControl;writer:ReturnType<typeof createHubRoleWriter>;
 inventory:HubGroupAdminInventory;authorization:Pick<HubGroupAuthorization,"resume">;current():boolean;now():number;version():number;
}){
 const {db,directory,policy,legacy,management,roleAdmin,writer,inventory,authorization,current,now,version}=options;
 const root=Object.freeze(validated(person,options.root));
 const aliases=new Map<string,{digest:string;raw:string;created:number;expires:number}>();let closed=false;
 const read=()=>{if(closed||current()!==true)throw new HubProtocolError("unavailable");return readHubOperationalPolicy(policy);};
 const roleMode=()=>"rolesActive" in read();
 const context=(incoming:GroupAdminContext):HubRequestContext=>{
  const c=incoming.roleContext;if(!c||c.requestId!==incoming.requestId||incoming.current()!==true||c.isCurrent?.()!==true)throw new HubProtocolError("unavailable");
  return Object.freeze({requestId:c.requestId,current:c.current.bind(c),isCurrent:c.isCurrent.bind(c),requirePerson:c.requirePerson.bind(c),requireAdmin:c.requireAdmin.bind(c),...(c.isIdentityCurrent?{isIdentityCurrent:c.isIdentityCurrent.bind(c)}:{})});
 };
 const admin=async(c:HubRequestContext)=>{const p=await management.require(c,"hub.admin");p.assertCurrent();read();return p;};
 const fail=(code:RoleWriteCode):{ok:false;code:"conflict"|"unknown"}=>{if(code==="denied"||code==="self-target")throw new HubProtocolError("denied");if(code==="invalid")throw new HubProtocolError("invalid");return{ok:false,code:code==="conflict"||code==="expired"||code==="stale-preview"?"conflict":"unknown"};};
 const callerCurrent=(c:HubRequestContext)=>{read();if(c.isCurrent?.()!==true)throw new HubProtocolError("unavailable");};
 const canonical=async(input:HubGroupPolicy,c:HubRequestContext)=>{
  let proof=await admin(c);const before=parseRolePolicy(read()),image=JSON.stringify(before),next=parseGroupPolicy(input),resolve=directory.resolvePolicyGroup;
  if(next.revision!==before.revision)throw new HubProtocolError("conflict");
  const guard=()=>{if(JSON.stringify(read())!==image||directory.resolvePolicyGroup!==resolve||c.isCurrent?.()!==true)throw new HubProtocolError("conflict");};
  for(const row of next.groups){
   if(!resolve||directory.groupPolicy!=="ad-direct-guid")throw new HubProtocolError("incompatible");
   const found=await policy.withDirectoryRead(proof.actor.person,()=>resolve.call(directory,row.dn));guard();proof=await admin(c);
   if(!found.ok||personKeyString(validated(person,found.group.key))!==personKeyString(row.group))throw new HubProtocolError("conflict");row.dn=validated(resolveRequest,{dn:found.group.dn}).dn;
  }
  for(const row of readAllowedListTeams(db,next).snapshots){if(!row.team)throw new HubProtocolError("invalid");next.teams!.find(r=>r.teamId===row.id)!.name=row.team.name;}
  guard();proof.assertCurrent();return mergeRoleAllowedList(before,next,root);
 };
 const prune=()=>{const at=now();for(const[id,a]of aliases)if(at<a.created||at>=a.expires)aliases.delete(id);};
 const control:HubGroupAdminControl={
  async read(incoming){if(!roleMode())return legacy.read(incoming);const c=context(incoming),proof=await admin(c),p=parseRolePolicy(read());
   const paused=inventory.paused().map(({item,lifecycleRevision})=>({resource:{kind:item.resource.kind,id:item.resource.id,revision:item.resource.revision},label:item.display.label,owner:item.display.owner,lifecycleRevision}));proof.assertCurrent();
   return{ok:true,groupPolicyV1:true,supported:directory.groupPolicy==="ad-direct-guid",binding:"ready",policy:projectRoleAllowedList(p),paused};
  },
  async resolve(input,incoming){if(!roleMode())return legacy.resolve(input,incoming);const c=context(incoming),proof=await admin(c),resolve=directory.resolvePolicyGroup;
   if(!resolve||directory.groupPolicy!=="ad-direct-guid")return{ok:false,reason:"unsupported"};
   const found=await policy.withDirectoryRead(proof.actor.person,()=>resolve.call(directory,input.dn));const fresh=await admin(c);fresh.assertCurrent();
   if(directory.resolvePolicyGroup!==resolve)throw new HubProtocolError("unavailable");
   if(!found.ok)return{ok:false,reason:found.reason==="unsupported"?"unsupported":"unknown"};const key=validated(person,found.group.key);
   if(key.realm!==root.realm)throw new HubProtocolError("unavailable");return{ok:true,realm:key.realm,objectId:key.objectId,dn:validated(resolveRequest,{dn:found.group.dn}).dn};
  },
  async search(input,incoming){if(!roleMode())return legacy.search?legacy.search(input,incoming):{ok:false,reason:"unsupported"};const c=context(incoming);await admin(c);
   try{const rows=await roleAdmin.search(c,{kind:"group",q:input.q});const proof=await admin(c);proof.assertCurrent();return{ok:true,groups:rows.map(r=>({objectId:r.key.objectId,cn:r.name,dn:r.dn!})),truncated:rows.length>=20};}catch(error){if(error instanceof HubProtocolError&&error.code==="backpressure")return{ok:false,reason:"limited"};throw error;}
  },
  async searchPeople(input,incoming){if(!roleMode())return legacy.searchPeople?legacy.searchPeople(input,incoming):{ok:false,reason:"unsupported"};const c=context(incoming);await admin(c);
   try{const rows=await roleAdmin.search(c,{kind:"person",q:input.q});const proof=await admin(c);proof.assertCurrent();return{ok:true,people:rows.map(r=>({person:r.key,displayName:r.name,login:r.login??r.name})),truncated:rows.length>=20};}catch(error){if(error instanceof HubProtocolError&&error.code==="backpressure")return{ok:false,reason:"limited"};throw error;}
  },
  async preview(input,incoming){if(!roleMode())return legacy.preview(input,incoming);const c=context(incoming);prune();if(aliases.size>=16)throw new HubProtocolError("backpressure");
   const next=await canonical(input.policy,c),result=await writer.previewAllowedList(next,c);if(!result.ok)return fail(result.code);
   callerCurrent(c);const token=randomBytes(32).toString("hex"),impact:GroupImpact=validated(impactShape,result.impact);aliases.set(token,{digest:result.previewDigest,raw:JSON.stringify(input.policy),created:now(),expires:result.expiresAt});
   return{ok:true,previewDigest:token,expiresAt:result.expiresAt,policyRevision:result.revision,authorizationVersion:version(),impact};
  },
  async apply(input,incoming){if(!roleMode())return legacy.apply(input,incoming);const c=context(incoming);prune();const checked=aliases.get(input.previewDigest);aliases.delete(input.previewDigest);
   if(!checked||checked.raw!==JSON.stringify(input.policy))return{ok:false,code:"conflict"};const next=await canonical(input.policy,c),result=await writer.applyAllowedList(next,checked.digest,c);if(!result.ok)return fail(result.code);
   callerCurrent(c);return{ok:true,policyRevision:result.revision,state:next.state};
  },
  async resume(input,incoming){if(!roleMode())return legacy.resume(input,incoming);const c=context(incoming),proof=await admin(c),p=parseRolePolicy(read()),image=JSON.stringify(p),item=inventory.current(input.resource),before=inventory.ledger(input.resource);
   if(p.revision!==input.expectedPolicyRevision||!item||!before||before.state!=="suspended"||before.revision!==input.expectedLifecycleRevision||JSON.stringify(item.resource)!==JSON.stringify(before.resource))return{ok:false,code:"conflict"};
   const valid=()=>{try{return !closed&&current()&&c.isCurrent?.()===true&&now()<proof.expiresAt&&JSON.stringify(read())===image&&inventory.current(input.resource)?.fingerprint===item.fingerprint;}catch{return false;}};
   proof.assertCurrent();const permit=await authorization.resume(item.resource,{requestId:c.requestId,current:valid,requireAdmin:async()=>{const fresh=await admin(c);return fresh.actor;}});permit.assertCurrent();
   const after=inventory.ledger(item.resource);if(!valid()||!after||after.state!=="active"||after.revision!==before.revision+1)throw new HubProtocolError("unavailable");
   return{ok:true,resource:input.resource,state:"active",policyRevision:p.revision,lifecycleRevision:after.revision};
  },
 };
 return{...control,close(){closed=true;aliases.clear();}};
}
