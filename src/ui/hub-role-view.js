/** Display projections only. Policy keys, permissions and checked writes remain server-owned. */
import {hr} from "./hub-roles-strings.js";
import { dateTimeText } from "/assets/clock-text.js";
export const personKey=p=>`${p?.realm}/${p?.objectId}`;
export const management=["fleets.manage","join.manage","roles.assign","audit.view","hub.admin"];
export const permissionGroups=[{key:"usingHub",permissions:["ask_agents","publish_agents","pair_fleet"]},{key:"theirTeam",permissions:["team.view","team.usage"]},{key:"runningHub",permissions:["fleets.manage","join.manage","roles.assign","audit.view"]}];
const builtinNames={admin:"Administrator",manager:"Manager",member:"Member"};
export function roleName(role,view){
 if(!role)return hr("unknownRole");
 if(role.systemRole==="first-administrator-self-use"||role.id===`root-self:${view?.root?.objectId}`)return hr("rootSelf");
 const name=role.name??role.roleName,kind=role.kind??role.roleKind;
 return builtinNames[kind]===name?hr(kind):name||hr("unknownRole");
}
export const personName=(view,person)=>view?.personLabels?.find(row=>row.id===personKey(person))?.name||hr("unknownPerson");
export function roleDescription(role,view){
 if(role.description?.trim())return role.description;
 if(role.kind==="admin")return hr("roleDescriptionAdmin");
 const defaults={member:["ask_agents","publish_agents","pair_fleet"],manager:["ask_agents","publish_agents","pair_fleet","team.view","team.usage"]},expected=defaults[role.kind];
 if(expected&&(role.kind!=="manager"||!view||defaults.member.every(p=>view.policy.roles.find(r=>r.kind==="member")?.permissions.includes(p))&&view.policy.roles.find(r=>r.kind==="member")?.permissions.length===3)&&expected.length===role.permissions.length&&expected.every(p=>role.permissions.includes(p)))return hr(role.kind==="member"?"roleDescriptionMember":"roleDescriptionManager");
 return hr(expected?"roleDescriptionEdited":"roleDescriptionCustom");
}
export const subjectId=s=>s.kind+":"+personKey(s.kind==="person"?s.person:s.group);
export const subjectName=(view,s)=>s.kind==="person"?personName(view,s.person):s.dn;
export const scopeName=s=>s?.kind==="group"?`${hr("scopeGroup")}: ${s.dn??s.name}`:hr("wholeHub");
export function assignedSubjects(view,roleId=null){
 const rows=new Map();
 const add=(subject,assignment,fixed=false)=>{const id=subjectId(subject);if(!rows.has(id))rows.set(id,{id,subject,name:subjectName(view,subject),assignments:[],fixed:false});const row=rows.get(id);row.fixed||=fixed;if(assignment)row.assignments.push(assignment);};
 if(!roleId||roleId==="builtin:admin")add({kind:"person",person:view.root},null,true);
 for(const a of view.policy.assignments)if(!roleId||a.roleId===roleId)add(a.subject,a);
 return [...rows.values()];
}
export function assignmentCount(view,role){
 const rows=assignedSubjects(view,role.id),p=rows.filter(r=>r.subject.kind==="person").length,g=rows.length-p;
 return !rows.length?hr("nobodyAssigned"):[p?hr(p===1?"peopleCountOne":"peopleCount",p):null,g?hr(g===1?"groupCountOne":"groupCount",g):null].filter(Boolean).join(" · ");
}
export const roleError=(out,save=false)=>out?.code==="last-administrator"?hr("lastAdmin"):["denied","self-target"].includes(out?.code)?hr("denied"):["expired","stale-preview","conflict"].includes(out?.code)?hr("stale"):out?.code==="invalid"?hr("invalid"):hr(save?"saveFailed":"failed");
export function changeLines(view,next,rootSelf=false){
 if(rootSelf)return [{text:hr("rootDefaults")}];
 const before=view.policy,lines=[];
 if(before.rolesActive!==next.rolesActive)lines.push({text:hr(next.rolesActive?"turnOn":"turnOff")});
 const changed=(a,b)=>JSON.stringify(a)!==JSON.stringify(b);
 for(const role of next.roles){const old=before.roles.find(r=>r.id===role.id);if(!old||changed(old,role))lines.push({text:hr(old?"changingRole":"creatingRole",roleName(role,view)),added:role.permissions.filter(p=>!old?.permissions.includes(p)),removed:old?.permissions.filter(p=>!role.permissions.includes(p))||[],before:old,after:role});}
 for(const role of before.roles)if(!next.roles.some(r=>r.id===role.id))lines.push({text:hr("deletingRole",roleName(role,view)),deleted:true,removedAssignments:before.assignments.filter(a=>a.roleId===role.id).length});
 for(const a of next.assignments){const old=before.assignments.find(r=>r.id===a.id);if(!old||changed(old,a))lines.push({text:hr("givingRole",roleName(next.roles.find(r=>r.id===a.roleId),view),subjectName(view,a.subject)),before:old,after:a});}
 for(const a of before.assignments)if(!next.assignments.some(r=>r.id===a.id))lines.push({text:hr("removingRole",roleName(before.roles.find(r=>r.id===a.roleId),view),subjectName(view,a.subject))});
 return lines;
}
export function reviewImpact(checked,view){
 const lost=new Map(),unknown=new Map();
 const add=(map,id,row)=>{const previous=map.get(id);map.set(id,{...previous,...row,permissions:[...new Set([...(previous?.permissions||[]),...(row.permissions||[])])]});};
 for(const row of checked.impact?.losingActions||[])add(lost,row.personId,{name:row.name||view.personLabels?.find(p=>p.id===row.personId)?.name||hr("unknownPerson"),permissions:row.capabilities||[]});
 for(const row of checked.review?.losingPermissions||[])add(lost,personKey(row.person),{name:row.name||personName(view,row.person),permissions:row.permissions});
 for(const row of checked.impact?.held||[])unknown.set(row.personId,{name:row.name||view.personLabels?.find(p=>p.id===row.personId)?.name||hr("unknownPerson")});
 for(const row of checked.review?.unverified||[]){const person=row.person||row;unknown.set(personKey(person),{name:row.name||personName(view,person)});}
 return {lost:[...lost.values()],unknown:[...unknown.values()],resources:checked.impact?.suspendedOnSave||[]};
}
const auditKeys={"role.created":"eventCreated","role.changed":"eventChanged","role.deleted":"eventDeleted","role.assigned":"auditAssignedAction","role.unassigned":"auditUnassignedAction","role.policy-changed":"auditPolicy","role.root-self-use-activated":"auditRootSelf","role.write-refused":"auditTried","role.audit-read":"auditRead","role.migrated":"auditMigrated","role.assignment-expired":"auditExpired","role.authorization-changed":"auditAuthorized","role.mode-on":"auditOn","role.mode-off":"auditOff","session.signed-in":"auditSignedIn","administrator.claimed":"auditFirstAdmin"};
export const roleAuditActions=Object.freeze(Object.keys(auditKeys));
export const auditAction=action=>hr(auditKeys[action]||"auditOther",hr("unknownRole"));
export const auditResult=result=>["completed","allowed"].includes(result)?hr("done"):result==="denied"?hr("refused"):hr("failedResult");
export const auditActor=row=>row.actor?.id==="local-host"?hr("localHost"):row.actor?.name||hr("unknownActor");
export function auditSentence(row){
 const details=row.details,value=details?.after||details?.before;
 if(details?.kind==="role")return hr(row.action==="role.created"?"auditCreated":row.action==="role.deleted"?"auditDeleted":"auditChanged",roleName(value));
 if(details?.kind==="assignment")return row.action==="role.unassigned"?hr("auditUnassigned",roleName(value),value?.subject?.name||hr("unknownPerson")):hr("auditAssigned",roleName(value),value?.subject?.name||hr("unknownPerson"),scopeName(value?.scope));
 if(details?.kind==="root-self")return hr("auditRootSelf");
 if(details?.kind==="policy"&&details.before?.rolesActive!==details.after?.rolesActive)return hr(details.after?.rolesActive?"auditOn":"auditOff");
 return auditAction(row.action);
}
export function valueLines(value){
 if(!value)return[];
 const lines=[];
 if(value.roleName)lines.push(roleName(value));if(value.description)lines.push(`${hr("rolePurpose")}: ${value.description}`);
 if(value.permissions)lines.push(value.permissions.map(p=>hr(p)).join(" · "));
 if(value.defaultMaxFleets!==undefined)lines.push(`${hr("quota")}: ${value.defaultMaxFleets}`);
 if(value.subject)lines.push(value.subject.name||hr("unknownPerson"));if(value.scope)lines.push(scopeName(value.scope));
 if(value.startsAt)lines.push(`${hr("start")}: ${dateTimeText(value.startsAt)}`);
 if(value.expiresAt!==undefined)lines.push(`${hr("ends")}: ${value.expiresAt?dateTimeText(value.expiresAt):hr("noEnd")}`);
 if(value.maxFleets!=null)lines.push(`${hr("override")}: ${value.maxFleets}`);
 if(value.rolesActive!==undefined)lines.push(hr(value.rolesActive?"on":"off"));
 return lines;
}
/** CSV is actions/labels only; protect spreadsheet consumers from formula-looking directory names. */
export function auditCsv(rows){
 const field=value=>{const text=String(value??"");return '"'+(/^[\s]*[=+\-@]/.test(text)?"'":"")+text.replace(/"/g,'""')+'"';};
 return "\ufeff"+[[hr("when"),hr("who"),hr("action"),hr("result"),hr("before"),hr("after")],...rows.map(row=>[new Date(row.at).toISOString(),auditActor(row),auditSentence(row),auditResult(row.result),valueLines(row.details?.before).join("; "),valueLines(row.details?.after).join("; ")])].map(row=>row.map(field).join(",")).join("\r\n");
}
