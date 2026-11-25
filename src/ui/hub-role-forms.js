import {html,useEffect,useMemo,useRef,useState} from "/assets/app-html.js";
import {Dialog} from "/assets/ui-dialog.js";
import {PeopleSearch} from "./hub-subject-picker.js";
import {GroupSearch} from "./hub-group-search.js";
import {hr} from "./hub-roles-strings.js";
import {personKey,personName,roleName,roleDescription,permissionGroups,management,changeLines,reviewImpact,scopeName,valueLines} from "./hub-role-view.js";
import { dateTimeText } from "/assets/clock-text.js";
const copy=value=>structuredClone(value);
const dateValue=at=>at?new Date(at-new Date(at).getTimezoneOffset()*60000).toISOString().slice(0,16):"";
export function RoleSearch({client,kind,onPick,disabled,id}){
 const candidates=useRef(new Map()),[revision,setRevision]=useState(0);
 const search=useMemo(()=>async(requested,q)=>{const out=await client.roleSearch(requested,q);if(!out.ok)return out;
  if(requested==="person")return {...out,people:out.candidates.map(row=>({person:row.key,displayName:row.name,login:row.login}))};
  // Retain recent rendered hits while the shared picker fetches its next query. No key is reconstructed.
  for(const row of out.candidates)candidates.current.set(row.key.objectId,row);while(candidates.current.size>256)candidates.current.delete(candidates.current.keys().next().value);
  return {...out,groups:out.candidates.map(row=>({objectId:row.key.objectId,cn:row.name,dn:row.dn}))};
 },[client]);
 const groups=useMemo(()=>({searchGroups:q=>search("group",q)}),[search]);
 return kind==="person"?html`<${PeopleSearch} key=${revision} search=${search} disabled=${disabled} id=${id} onPick=${row=>{onPick({kind:"person",key:row.person,name:row.displayName,login:row.login});setRevision(n=>n+1);}}/>`:html`<${GroupSearch} key=${revision} client=${groups} disabled=${disabled} id=${id} onPick=${row=>{const original=candidates.current.get(row.objectId);if(original){onPick(original);setRevision(n=>n+1);}}}/>`;
}
export function PermissionSections({permissions,onChange,disabled=false,readOnly=false,administrator=false}){
 const [small,setSmall]=useState(()=>typeof window!=="undefined"&&window.matchMedia?.("(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)").matches);
 useEffect(()=>{const media=window.matchMedia?.("(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)");if(!media)return;const update=()=>setSmall(media.matches);media.addEventListener?.("change",update);return()=>media.removeEventListener?.("change",update);},[]);
 const groups=permissionGroups.map(group=>group.key==="runningHub"&&administrator?{...group,permissions:[...group.permissions,"hub.admin"]}:group);
 const pick=(permission,checked)=>onChange(checked?[...new Set([...permissions,permission])]:permissions.filter(p=>p!==permission));
 return html`<div class="hub-role-permissions">${groups.map(group=>html`<details class="hub-role-permission-section" key=${group.key} open=${!readOnly||!small||group.key==="usingHub"}>
  <summary><span class="hub-role-disclosure" aria-hidden="true">›</span><strong>${hr(group.key)}</strong><span class="note">${hr("permissionCount",group.permissions.filter(p=>permissions.includes(p)).length,group.permissions.length)}</span></summary>
  <div class="hub-role-permission-list">${!readOnly?html`<button type="button" class="btn btn-sm" disabled=${disabled} onClick=${()=>onChange([...new Set([...permissions,...group.permissions])])}>${hr("selectAll")}</button>`:null}
   ${group.permissions.map(p=>html`<label class=${`hub-role-permission ${readOnly?"is-readonly":"check"}`} key=${p}>
    ${readOnly?html`<span class="hub-role-permission-mark" aria-label=${hr(p)}>${permissions.includes(p)?"✓":"–"}</span>`:html`<input type="checkbox" checked=${permissions.includes(p)} disabled=${disabled} onChange=${e=>pick(p,e.target.checked)}/>`}
    <span><strong>${hr(p)}</strong><small class="note">${hr("description_"+p)}</small>${p.startsWith("team.")?html`<span class="tag">${hr("teamFuture")}</span>`:null}</span></label>`)}
   ${group.key==="runningHub"&&permissions.some(p=>management.includes(p))?html`<p class="s-info">${hr("personOnly")}</p>`:null}
  </div></details>`)}
  <details class="hub-role-future"><summary>${hr("notAvailable")}</summary><p class="note">${hr("team.approve_join")} · ${hr("team.approve_ask")}</p></details></div>`;
}
export function Review({view,checked}){
 const lines=changeLines(view,checked.policy,checked.rootSelf),impact=reviewImpact(checked,view);
 const assignmentPermissions=(checked.policy?.assignments||[]).filter(a=>JSON.stringify(a)!==JSON.stringify(view.policy.assignments.find(old=>old.id===a.id))).flatMap(a=>checked.policy.roles.find(r=>r.id===a.roleId)?.permissions||[]);
 const warnings=[...new Set([...(checked.policy?.roles||[]).flatMap(role=>role.permissions.filter(p=>!view.policy.roles.find(r=>r.id===role.id)?.permissions.includes(p))),...assignmentPermissions].filter(p=>management.includes(p)))];
 return html`<div class="hub-role-review" data-role-review>${view.policy.state==="never-enabled"?html`<p class="s-info">${hr("selfLegacy")}</p>`:null}
  ${lines.map((line,i)=>html`<section key=${i} class="hub-role-change"><h3>${line.text}</h3>
   ${line.added?.length?html`<p><strong>${hr("added")}: </strong>${line.added.map(p=>hr(p)).join(" · ")}</p>`:null}
   ${line.removed?.length?html`<p><strong>${hr("removed")}: </strong>${line.removed.map(p=>hr(p)).join(" · ")}</p>`:null}
   ${line.added&&!line.added.length&&!line.removed.length?html`<p class="note">${hr("noPermissionChanges")}</p>`:null}
   ${line.before?.name!==line.after?.name&&line.before?.name&&line.after?.name?html`<p>${roleName(line.before,view)} → ${roleName(line.after,view)}</p>`:null}
   ${line.after?.description!==undefined?html`<p>${hr("rolePurpose")}: ${line.before?.description||"–"} → ${line.after.description||"–"}</p>`:null}
   ${line.after?.defaultMaxFleets!==undefined?html`<p>${hr("quota")}: ${line.before?.defaultMaxFleets??"–"} → ${line.after.defaultMaxFleets}</p>`:null}
   ${line.after?.scope?html`<p>${hr("scope")}: ${line.before?.scope?scopeName(line.before.scope):"–"} → ${scopeName(line.after.scope)}</p>
    ${line.after.startsAt||line.before?.startsAt?html`<p>${hr("start")}: ${line.before?.startsAt?dateTimeText(line.before.startsAt):"–"} → ${line.after.startsAt?dateTimeText(line.after.startsAt):"–"}</p>`:null}
    <p>${hr("ends")}: ${line.before?.expiresAt?dateTimeText(line.before.expiresAt):hr("noEnd")} → ${line.after.expiresAt?dateTimeText(line.after.expiresAt):hr("noEnd")}</p>
    ${line.after.maxFleets!==null||line.before?.maxFleets!=null?html`<p>${hr("override")}: ${line.before?.maxFleets??"–"} → ${line.after.maxFleets??"–"}</p>`:null}`:null}
   ${line.deleted?html`<p class="note">${hr("deleteAssignments",line.removedAssignments)}</p>`:null}</section>`)}
  ${!lines.length?html`<p>${hr("nothingChanged")}</p>`:null}
  <section><h3>${hr("whatHappens")}</h3>${!impact.lost.length&&!impact.resources.length&&!impact.unknown.length?html`<p class="s-info">${hr("nobodyLoses")}</p>`:html`
   ${impact.lost.length?html`<details open><summary>${hr(impact.lost.length===1?"losingPeopleOne":"losingPeople",impact.lost.length)} · ${hr("showWho")}</summary><ul>${impact.lost.map((row,i)=>html`<li key=${i}><strong>${row.name}</strong><small class="note">${row.permissions.map(p=>hr(p)).join(" · ")}</small></li>`)}</ul></details>`:null}
   ${impact.resources.length?html`<details><summary>${hr(impact.resources.length===1?"pausingResourcesOne":"pausingResources",impact.resources.length)} · ${hr("showWhich")}</summary><ul>${impact.resources.map((row,i)=>html`<li key=${i}>${row.label||row.name||hr("unknownRole")}</li>`)}</ul></details>`:null}
   ${impact.unknown.length?html`<details><summary>${hr(impact.unknown.length===1?"unverifiedPeopleOne":"unverifiedPeople",impact.unknown.length)} · ${hr("showWho")}</summary><ul>${impact.unknown.map((row,i)=>html`<li key=${i}>${row.name}</li>`)}</ul></details>`:null}`}</section>
  ${warnings.map(p=>html`<p class="s-info" key=${p}>${hr(p)}: ${hr("description_"+p)}</p>`)}<p class="note">${hr("noPreview")}</p></div>`;
}
export function RoleWizard({view,role,checked,busy,onCheck,onApply,onBack,onCancel}){
 const existing=view.policy.roles.some(r=>r.id===role.id),[draft,setDraft]=useState(()=>({...copy(role),description:role.description||""})),[quota,setQuota]=useState(String(role.defaultMaxFleets)),[step,setStep]=useState(1),[template,setTemplate]=useState("");
 const actual=checked?3:step,valid=draft.name.trim().length>0&&quota!==""&&Number.isInteger(Number(quota))&&Number(quota)>=0&&Number(quota)<=8;
 const selectTemplate=id=>{setTemplate(id);const source=view.policy.roles.find(r=>r.id===id);setDraft(old=>({...old,description:source?roleDescription(source,view):"",permissions:source?source.permissions.filter(p=>p!=="hub.admin"&&!p.startsWith("team.approve_")):[]}));setQuota(String(source?.defaultMaxFleets??0));};
 const check=()=>{if(!valid||busy)return;const policy=copy(view.policy),saved={...draft,description:draft.description.trim(),defaultMaxFleets:Number(quota)},index=policy.roles.findIndex(r=>r.id===saved.id);if(index<0)policy.roles.push(saved);else policy.roles[index]=saved;onCheck(policy);};
 return html`<section class="hub-role-wizard"><div class="hub-card-head"><h2>${existing?roleName(role,view):hr("newRole")}</h2><button type="button" class="btn" disabled=${busy} onClick=${onCancel}>${hr("cancel")}</button></div>
  <ol class="hub-role-stepper" aria-label=${hr("stepCount",actual)}>${["info","permissions","review"].map((key,i)=>html`<li aria-current=${actual===i+1?"step":undefined} key=${key}><span>${i+1}</span>${hr(key)}</li>`)}</ol><p class="hub-role-step-mobile note">${hr("stepCount",actual)}</p>
  ${actual===1?html`<form class="card hub-role-info" onSubmit=${e=>{e.preventDefault();if(valid&&!busy)setStep(2);}}>
   <label class="field"><span>${hr("name")}</span><input required maxlength="120" value=${draft.name} disabled=${busy} onInput=${e=>setDraft({...draft,name:e.target.value})}/></label>
   <label class="field"><span>${hr("description")}</span><input maxlength="500" value=${draft.description} disabled=${busy} onInput=${e=>setDraft({...draft,description:e.target.value})}/></label>
   ${!existing?html`<label class="field"><span>${hr("startFrom")}</span><select value=${template} disabled=${busy} onChange=${e=>selectTemplate(e.target.value)}><option value="">${hr("blank")}</option>${view.policy.roles.filter(r=>["manager","member","custom"].includes(r.kind)&&!r.id.startsWith("root-self:")).map(r=>html`<option key=${r.id} value=${r.id}>${roleName(r,view)}</option>`)}</select></label>`:null}
   <label class="field"><span>${hr("quota")}</span><span class="hub-group-fleets"><input type="number" min="0" max="8" step="1" required value=${quota} disabled=${busy} onInput=${e=>setQuota(e.target.value)}/></span></label>
   <div class="hub-role-actions"><button type="submit" class="btn btn-primary" disabled=${busy||!valid}>${hr("continue")}</button></div></form>`:actual===2?html`<section class="card hub-role-editor"><${PermissionSections} permissions=${draft.permissions} onChange=${permissions=>setDraft({...draft,permissions})} disabled=${busy}/></section>`:html`<section class="card"><${Review} view=${view} checked=${checked}/></section>`}
  ${actual>1?html`<div class="hub-role-actions hub-role-wizard-actions"><button type="button" class="btn" disabled=${busy} onClick=${()=>{if(checked)onBack();else setStep(1);}}>${hr("back")}</button><button type="button" class="btn btn-primary" disabled=${busy||!valid} onClick=${actual===3?onApply:check}>${hr(busy?(actual===3?"saving":"checking"):actual===3?(existing?"apply":"create"):"review")}</button></div>`:null}</section>`;
}
export function AssignPanel({view,client,roleId:initialRole,assignment,checked,busy,failure,onReload,onCheck,onApply,onBack,onClose,onRemember}){
 const subjectId=assignment?.subject.kind==="person"?assignment.subject.person:assignment?.subject.group;
 const [roleId,setRoleId]=useState(assignment?.roleId||initialRole||view.policy.roles[0]?.id),[kind,setKind]=useState(assignment?.subject.kind||"person"),[selected,setSelected]=useState(()=>assignment?[{kind:assignment.subject.kind,key:subjectId,name:assignment.subject.kind==="person"?personName(view,assignment.subject.person):assignment.subject.dn,dn:assignment.subject.dn}]:[]);
 const [whole,setWhole]=useState(assignment?.scope.kind==="hub"),[scope,setScope]=useState(assignment?.scope.kind==="group"?{key:assignment.scope.group,dn:assignment.scope.dn,name:assignment.scope.dn}:null),[start,setStart]=useState(dateValue(assignment?.startsAt)),[end,setEnd]=useState(dateValue(assignment?.expiresAt)),[limit,setLimit]=useState(assignment?.maxFleets==null?"":String(assignment.maxFleets));
 const role=view.policy.roles.find(r=>r.id===roleId),adminRole=role.permissions.some(p=>management.includes(p)),teamRole=role.permissions.some(p=>p.startsWith("team.")),startsAt=start?new Date(start).getTime():0,expiresAt=end?new Date(end).getTime():null;
 const valid=selected.length>0&&selected.length<=50&&(!adminRole||selected.every(s=>s.kind==="person"))&&(!teamRole||adminRole||whole&&view.management.includes("hub.admin")||scope)&&Number.isFinite(startsAt)&&(expiresAt===null||Number.isFinite(expiresAt)&&expiresAt>startsAt)&&(limit===""||Number.isInteger(Number(limit))&&Number(limit)>=0&&Number(limit)<=8);
 const pick=row=>{if(assignment)setSelected([row]);else setSelected(old=>old.some(s=>s.kind===row.kind&&personKey(s.key)===personKey(row.key))?old:[...old,row]);if(row.kind==="person")onRemember(row);};
 const check=()=>{if(!valid||busy)return;const policy=copy(view.policy);
  for(const subject of selected){const replacement={id:assignment?.id||`assignment:${crypto.randomUUID()}`,roleId,subject:subject.kind==="person"?{kind:"person",person:subject.key}:{kind:"group",group:subject.key,dn:subject.dn},scope:!teamRole||adminRole||whole?{kind:"hub"}:{kind:"group",group:scope.key,dn:scope.dn},startsAt,expiresAt,maxFleets:limit===""?null:Number(limit),assignedBy:assignment?.assignedBy||view.actor,assignedAt:assignment?.assignedAt||0};
   if(assignment)policy.assignments=policy.assignments.map(row=>row.id===assignment.id?replacement:row);else policy.assignments.push(replacement);
  }onCheck(policy);
 };
 const actions=checked?html`<button type="button" class="btn" disabled=${busy} onClick=${onBack}>${hr("back")}</button><button type="button" class="btn btn-primary" disabled=${busy} onClick=${onApply}>${hr(busy?"saving":"apply")}</button>`:html`<button type="button" class="btn" disabled=${busy} onClick=${onClose}>${hr("cancel")}</button><button type="button" class="btn btn-primary" disabled=${busy||!valid} onClick=${check}>${hr("review")}</button>`;
 return html`<${Dialog} title=${checked?hr("review"):hr("assignNamed",roleName(role,view))} drawer=${true} wide=${true} cls="hub-role-panel" busy=${busy} onClose=${onClose} actions=${actions}>
  ${failure?html`<p class="err" role="alert">${failure}</p><button type="button" class="btn" disabled=${busy} onClick=${onReload}>${hr("reloadRoles")}</button>`:null}
  ${checked?html`<${Review} view=${view} checked=${checked}/>`:html`<div class="hub-role-assignment">
   <label class="field"><span>${hr("role")}</span><select value=${roleId} disabled=${busy} onChange=${e=>{setRoleId(e.target.value);setSelected([]);setKind("person");}}>${view.policy.roles.map(r=>html`<option key=${r.id} value=${r.id}>${roleName(r,view)}</option>`)}</select></label>
   <label class="field"><span>${hr("subject")}</span><select value=${kind} disabled=${busy} onChange=${e=>setKind(e.target.value)}><option value="person">${hr("people")}</option><option value="group" disabled=${adminRole}>${hr("groups")}</option></select></label>
   ${adminRole?html`<p class="s-info">${hr("personOnly")}</p>`:kind==="group"?html`<p class="s-info">${hr("groupCost")}</p>`:null}
   ${selected.length?html`<div class="chips hub-role-selected">${selected.map(s=>html`<span class="tag" key=${s.kind+personKey(s.key)}>${s.name}<button type="button" class="icon-btn" disabled=${busy} aria-label=${hr("removeSelection",s.name)} onClick=${()=>setSelected(old=>old.filter(row=>row!==s))}>×</button></span>`)}</div>`:null}
   <${RoleSearch} key=${kind} client=${client} kind=${kind} disabled=${busy||selected.length>=50} id="hubRoleSubject" onPick=${pick}/>
   ${teamRole&&!adminRole?html`<label class="field"><span>${hr("appliesTo")}</span><select value=${whole?"hub":"group"} disabled=${busy} onChange=${e=>setWhole(e.target.value==="hub")}><option value="group">${hr("scopeGroup")}</option><option value="hub" disabled=${!view.management.includes("hub.admin")}>${hr("wholeHub")}</option></select></label>${!whole?scope?html`<div class="s-row"><strong>${scope.name}</strong><button type="button" class="btn btn-sm" disabled=${busy} onClick=${()=>setScope(null)}>${hr("changeSubject")}</button></div>`:html`<${RoleSearch} client=${client} kind="group" id="hubRoleScope" disabled=${busy} onPick=${setScope}/>`:null}`:null}
   <details open=${!!assignment} class="hub-role-more"><summary>${hr("moreOptions")}</summary><div class="grid2"><label class="field"><span>${hr("start")}</span><input type="datetime-local" value=${start} disabled=${busy} onInput=${e=>setStart(e.target.value)}/></label><label class="field"><span>${hr("ends")}</span><input type="datetime-local" value=${end} disabled=${busy} onInput=${e=>setEnd(e.target.value)}/></label></div>
   ${role.permissions.includes("pair_fleet")?html`<label class="field"><span>${hr("limitPeople")} · ${hr("quota")}: ${role.defaultMaxFleets}</span><span class="hub-group-fleets"><input type="number" min="0" max="8" step="1" value=${limit} disabled=${busy} onInput=${e=>setLimit(e.target.value)}/></span></label>`:null}</details>
  </div>`}</${Dialog}>`;
}
