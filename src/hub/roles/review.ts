/** Pure presentation/continuity checks over the writer's freshly collected facts. Never an operation permit. */
import {personKeyString} from "../identity.js";
import type {PersonKey} from "../types.js";
import {heldRoleBundle,type HeldRoleBundle} from "./delegation.js";
import {MANAGEMENT_PERMISSIONS,TEAM_PERMISSIONS,type HubRolePolicy,type RolePermission} from "./model.js";
import type {RolePersonFacts} from "./evaluate.js";
import type {RoleChangePlan} from "./change.js";
export interface RoleReview {
 losingPermissions: {person:PersonKey;permissions:RolePermission[]}[];
 unverified:PersonKey[];
}
/** Only a plan that can remove administrator authority needs the continuity proof. */
export function mayReduceAdministrators(plan:RoleChangePlan):boolean {
 if(plan.before.rolesActive&&!plan.next.rolesActive)return true;
 if(plan.roles.some(delta=>delta.before?.permissions.includes("hub.admin")&&!delta.after?.permissions.includes("hub.admin")))return true;
 return plan.assignments.some(delta=>delta.before&&plan.before.roles.find(r=>r.id===delta.before!.roleId)?.permissions.includes("hub.admin"));
}
/** Configured root counts only with current eligibility; future/expired assignments never count. */
export function hasCurrentAdministrator(policy:HubRolePolicy,people:Iterable<PersonKey>,facts:ReadonlyMap<string,RolePersonFacts>,root:PersonKey,at:number):boolean {
 return [...people].some(who=>heldRoleBundle(policy,who,facts.get(personKeyString(who))??{kind:"unknown"},at,root).administrator);
}
function scopes(bundle:HeldRoleBundle,permission:RolePermission){
 if(permission!=="rooms.create"&&bundle.administrator&&(MANAGEMENT_PERMISSIONS as readonly string[]).includes(permission))return [{kind:"hub" as const}];
 return bundle.rolesActive?bundle.grants.filter(g=>g.permission===permission).map(g=>g.scope):[];
}
export function roleReview(plan:RoleChangePlan,people:Iterable<PersonKey>,facts:ReadonlyMap<string,RolePersonFacts>,root:PersonKey,at:number):RoleReview {
 const losingPermissions:RoleReview["losingPermissions"]=[],unverified:PersonKey[]=[];
 if(!plan.affected.length&&plan.before.rolesActive===plan.next.rolesActive)return {losingPermissions,unverified};
 const permissions=[...TEAM_PERMISSIONS.filter(p=>!p.startsWith("team.approve_")),...MANAGEMENT_PERMISSIONS];
 for(const who of people){
  const fact=facts.get(personKeyString(who))??{kind:"unknown" as const};
  const before=heldRoleBundle(plan.before,who,fact,at,root),after=heldRoleBundle(plan.next,who,fact,at,root);
  if(before.kind==="unknown"||after.kind==="unknown"||before.unknownGroups||after.unknownGroups){unverified.push({...who});continue;}
  if(before.kind!=="known")continue;
  const lost=permissions.filter(permission=>scopes(before,permission).some(old=>!scopes(after,permission).some(next=>next.kind==="hub"||old.kind==="group"&&next.kind==="group"&&personKeyString(old.group)===personKeyString(next.group))));
  if(lost.length)losingPermissions.push({person:{...who},permissions:lost});
 }
 return {losingPermissions,unverified};
}
