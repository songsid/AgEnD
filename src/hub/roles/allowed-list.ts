/** Pure compatibility projection; it grants nothing and is never a policy writer or an operation permit. */
import type {PersonKey} from "../types.js";
import {person,validated,HubProtocolError} from "../validation.js";
import {GROUP_CAPABILITIES,parseGroupPolicy,type HubGroupPolicy} from "../group-policy/model.js";
import {parseRolePolicy,type HubRolePolicy,SELF_PERMISSIONS} from "./model.js";
function carried(policy:HubRolePolicy){
 return policy.assignments.filter(a=>a.subject.kind==="group"&&a.id===`legacy:group:${a.subject.group.objectId}`&&a.scope.kind==="hub"&&a.startsAt===0&&a.expiresAt===null
  &&policy.roles.find(r=>r.id===a.roleId)!.permissions.every(c=>(SELF_PERMISSIONS as readonly string[]).includes(c)));
}
/** The shortcut edits only timeless carried groups. Other role grants keep their own scopes, expiries and quotas. */
export function projectRoleAllowedList(input:unknown):HubGroupPolicy{
 const p=parseRolePolicy(input);
 return parseGroupPolicy({realm:p.realm,generation:p.generation,revision:p.revision,state:p.state,denies:p.denies,
  ...(p.people?{people:p.people}:{}),...(p.teams?{teams:p.teams}:{}),
  groups:carried(p).map(a=>{if(a.subject.kind!=="group")throw new HubProtocolError("invalid");const role=p.roles.find(r=>r.id===a.roleId)!;
   return{group:a.subject.group,dn:a.subject.dn,allow:GROUP_CAPABILITIES.filter(c=>role.permissions.includes(c)),maxFleets:a.maxFleets??role.defaultMaxFleets};}),
 });
}
/** Server adapter input only; the role writer must separately authorize the actor and seal/recheck the proposal. */
export function mergeRoleAllowedList(input:unknown,shortcut:unknown,rootInput:PersonKey):HubRolePolicy{
 const p=parseRolePolicy(input),next=parseGroupPolicy(shortcut),root=validated(person,rootInput);
 if(root.realm!==p.realm||next.realm!==p.realm||next.generation!==p.generation||next.revision!==p.revision)throw new HubProtocolError("conflict");
 const old=carried(p),owned=new Set(old.map(a=>a.id)),kept=p.assignments.filter(a=>!owned.has(a.id));
 for(const rule of next.groups){
  const id=`legacy:group:${rule.group.objectId}`,original=old.find(a=>a.id===id),role=original?p.roles.find(r=>r.id===original.roleId):undefined;
  if(kept.some(a=>a.id===id))throw new HubProtocolError("conflict");
  const same=role&&role.permissions.length===rule.allow.length&&rule.allow.every(c=>role.permissions.includes(c));let roleId=original?.roleId;
  if(!same){
   const mask=GROUP_CAPABILITIES.reduce((bits,c,i)=>bits|(rule.allow.includes(c)?1<<i:0),0);roleId=`allowed-list:self:${mask}`;
   const existing=p.roles.find(r=>r.id===roleId);
   if(existing&&(existing.kind!=="custom"||existing.permissions.length!==rule.allow.length||!rule.allow.every(c=>existing.permissions.includes(c))))throw new HubProtocolError("conflict");
   if(!existing)p.roles.push({id:roleId,name:mask?`Allowed list: ${["Chat","Sharing","Fleet connections"].filter((_,i)=>mask&(1<<i)).join(" + ")}`:"Allowed list (no access)",kind:"custom",permissions:[...rule.allow],defaultMaxFleets:0});
  }
  kept.push({id,roleId:roleId!,subject:{kind:"group",group:rule.group,dn:rule.dn},scope:{kind:"hub"},startsAt:0,expiresAt:null,
   maxFleets:same&&original&&(original.maxFleets??role!.defaultMaxFleets)===rule.maxFleets?original.maxFleets:rule.maxFleets,
   assignedBy:original?.assignedBy??root,assignedAt:original?.assignedAt??0});
 }
 return parseRolePolicy({...p,assignments:kept,state:next.state,everEnabled:p.everEnabled||next.state!=="never-enabled",denies:next.denies,
  teams:next.teams,people:next.people});
}
