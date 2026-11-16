/** Role presentation reuses the Hub's rows/pickers; all writes still use one checked proposal. */
import {html,useEffect,useMemo,useRef,useState} from "/assets/app-html.js";
import {PeopleSearch} from "./hub-subject-picker.js";
import {GroupSearch} from "./hub-group-search.js";
import {hr,linkRoleCss} from "./hub-roles-strings.js";
const copy=value=>structuredClone(value),key=person=>`${person?.realm}/${person?.objectId}`;
const personName=(view,person)=>view.personLabels?.find(row=>row.id===key(person))?.name||key(person);
const management=["fleets.manage","join.manage","roles.assign","audit.view","hub.admin"];
const approvals=["team.approve_join","team.approve_ask"];
const name=role=>["admin","manager","member"].includes(role.kind)?hr(role.kind):role.name;
const error=out=>["denied","self-target"].includes(out?.code)?hr("denied"):["expired","stale-preview","conflict"].includes(out?.code)?hr("stale"):out?.code==="invalid"?hr("invalid"):hr("failed");

const auditWord=value=>{
 const translated=hr(`audit_${value}`);
 return translated===`hubRole.audit_${value}`||translated===`audit_${value}`?value:translated;
};
const auditSummary=line=>{
 const match=/^(before|after): (.*)$/.exec(line);
 if(!match)return line;
 const [label,permissions]=match[2].split(" · ");
 return `${hr(match[1])}: ${label}${permissions?" · "+permissions.split(", ").map(p=>hr(p)).join(" · "):""}`;
};
function proposedChanges(view,checked){
 if(!view?.policy||!checked)return[];
 if(checked.rootSelf)return[hr("rootDefaults")];
 const before=view.policy,after=checked.policy,lines=[];
 if(before.rolesActive!==after.rolesActive)lines.push(hr(after.rolesActive?"turnOn":"turnOff"));
 for(const role of after.roles){const previous=before.roles.find(r=>r.id===role.id);if(!previous||JSON.stringify(previous)!==JSON.stringify(role))lines.push(hr(previous?"changedRole":"addedRole",name(role)));}
 for(const role of before.roles)if(!after.roles.some(r=>r.id===role.id))lines.push(hr("removedRole",name(role)));
 const describe=(assignment,kind)=>{const role=after.roles.find(r=>r.id===assignment.roleId)||before.roles.find(r=>r.id===assignment.roleId);return hr(kind,role?name(role):assignment.roleId,assignment.subject.kind==="person"?personName(view,assignment.subject.person):assignment.subject.dn);};
 for(const assignment of after.assignments){const previous=before.assignments.find(a=>a.id===assignment.id);if(!previous||JSON.stringify(previous)!==JSON.stringify(assignment))lines.push(describe(assignment,previous?"changedAssignment":"addedAssignment"));}
 for(const assignment of before.assignments)if(!after.assignments.some(a=>a.id===assignment.id))lines.push(describe(assignment,"removedAssignment"));
 return lines;
}


/** Adapt display rows only. These pickers never call the broader directory-search APIs. */
function RoleSearch({client,kind,onPick,disabled,id}) {
 const candidates=useRef(new Map());
 const search=useMemo(()=>async(requested,q)=>{
  const out=await client.roleSearch(requested,q);
  if(!out.ok)return out;
  if(requested==="person")return {...out,people:(out.candidates||[]).map(row=>({person:row.key,displayName:row.name,login:row.login})),truncated:false};
  candidates.current=new Map((out.candidates||[]).map(row=>[row.key.objectId,row]));
  return {...out,groups:(out.candidates||[]).map(row=>({objectId:row.key.objectId,cn:row.name,dn:row.dn})),truncated:false};
 },[client]);
 const groups=useMemo(()=>({searchGroups:q=>search("group",q)}),[search]);
 return kind==="person"
  ? html`<${PeopleSearch} search=${search} disabled=${disabled} id=${id} onPick=${row=>onPick({kind:"person",key:row.person,name:row.displayName,login:row.login})}/>`
  : html`<${GroupSearch} client=${groups} disabled=${disabled} id=${id} unknownHint=${hr("failed")} onPick=${row=>{const original=candidates.current.get(row.objectId);if(original)onPick(original);}}/>`;
}
function SelectedSubject({subject,onClear,disabled}) {
 return html`<div class="s-row hub-row hub-role-selected"><span class="hub-row-text"><strong>${subject.name}</strong>${subject.login||subject.dn?html`<small class="note"><code>${subject.login||subject.dn}</code></small>`:null}</span><div class="s-actions"><button type="button" class="btn btn-sm" disabled=${disabled} onClick=${onClear}>${hr("changeSubject")}</button></div></div>`;
}
const permissionGroups=[
 {key:"selfUse",permissions:["ask_agents","publish_agents","pair_fleet"]},
 {key:"teamPermissions",permissions:["team.view","team.usage","team.approve_join","team.approve_ask"],badge:"later"},
 {key:"hubPermissions",permissions:management,badge:"lockedTag"},
];
function RoleEditor({view,role,onCheck,onCancel,busy}) {
 const [quota,setQuota]=useState(String(role.defaultMaxFleets)),[draft,setDraft]=useState(()=>copy(role));
 const locked=role.kind==="admin"||!view.management.includes("hub.admin");
 const valid=!locked&&draft.name.trim()&&quota!==""&&Number.isInteger(Number(quota))&&Number(quota)>=0&&Number(quota)<=8;
 const save=e=>{
  e.preventDefault();if(busy||!valid)return;
  const checkedRole={...draft,defaultMaxFleets:Number(quota)},next=copy(view.policy),at=next.roles.findIndex(r=>r.id===draft.id);
  if(at<0)next.roles.push(checkedRole);else next.roles[at]=checkedRole;onCheck(next);
 };
 return html`<form class="card hub-role-editor" onSubmit=${save}>
  <div class="hub-card-head"><h3>${draft.name.trim()||(role.kind==="custom"?hr("newRole"):name(role))}</h3>${locked?html`<span class="tag" title=${hr("locked")}>${hr("lockedTag")}</span>`:null}</div>
  <div class="hub-role-meta-grid"><label class="field"><span>${hr("name")}</span><input required maxlength="100" value=${draft.name} disabled=${busy||locked} onInput=${e=>setDraft({...draft,name:e.target.value})}/></label>
   <label class="field hub-role-quota-field"><span>${hr("quota")}</span><span class="hub-group-fleets"><input type="number" min="0" max="8" step="1" required value=${quota} disabled=${busy||locked} onInput=${e=>setQuota(e.target.value)}/></span></label></div>
  <div class="hub-role-perm-groups">${permissionGroups.map(group=>html`<fieldset class="hub-role-group" key=${group.key}>
   <legend><span>${hr(group.key)}</span>${group.badge?html`<span class="tag" title=${group.badge==="lockedTag"?hr("locked"):undefined}>${hr(group.badge)}</span>`:null}</legend>
   ${group.key==="hubPermissions"?html`<p class="note">${hr("personOnly")}</p>`:null}
   <div class="s-checks">${group.permissions.filter(p=>view.permissions.includes(p)).map(permission=>html`<label class="check hub-role-check" key=${permission}>
    <input type="checkbox" checked=${draft.permissions.includes(permission)} disabled=${busy||locked||permission==="hub.admin"||approvals.includes(permission)} onChange=${e=>setDraft({...draft,permissions:e.target.checked?[...draft.permissions,permission]:draft.permissions.filter(p=>p!==permission)})}/>
    <span>${hr(permission)}${approvals.includes(permission)?html`<span class="tag">${hr("later")}</span>`:permission==="hub.admin"?html`<span class="tag" title=${hr("locked")}>${hr("lockedTag")}</span>`:null}</span>
   </label>`)}</div></fieldset>`)}</div>
  <div class="hub-role-actions"><button type="submit" class="btn btn-primary" disabled=${busy||!valid}>${hr("preview")}</button><button type="button" class="btn" disabled=${busy} onClick=${onCancel}>${hr("cancel")}</button>
   ${role.kind==="custom"?html`<span class="dlg-spacer"></span><button type="button" class="btn danger" disabled=${busy||locked} onClick=${()=>{const next=copy(view.policy);next.roles=next.roles.filter(r=>r.id!==role.id);next.assignments=next.assignments.filter(a=>a.roleId!==role.id);onCheck(next);}}>${hr("delete")}</button>`:null}</div>
 </form>`;
}
const inputDate=at=>at?new Date(at-new Date(at).getTimezoneOffset()*60000).toISOString().slice(0,16):"";
function AssignmentEditor({view,assignment=null,onCheck,onCancel,busy}) {
 const original=assignment&&typeof assignment==="object"?assignment:null,selected=original?.subject;
 const initial=selected?(selected.kind==="person"?{kind:"person",key:selected.person,name:personName(view,selected.person)}:{kind:"group",key:selected.group,name:selected.dn,dn:selected.dn}):null;
 const [roleId,setRoleId]=useState(original?.roleId||view.policy.roles[0]?.id||""),[kind,setKind]=useState(selected?.kind||"person"),[subject,setSubject]=useState(initial);
 const [scope,setScope]=useState(original?.scope.kind==="group"?{key:original.scope.group,name:original.scope.dn,dn:original.scope.dn}:null),[whole,setWhole]=useState(original?.scope.kind==="hub");
 const [expiry,setExpiry]=useState(inputDate(original?.expiresAt)),[start,setStart]=useState(inputDate(original?.startsAt)),[limit,setLimit]=useState(original?.maxFleets==null?"":String(original.maxFleets));
 const role=view.policy.roles.find(r=>r.id===roleId),adminRole=role?.permissions.some(p=>management.includes(p)),teamRole=role?.permissions.some(p=>p.startsWith("team."));
 const startsAt=start?new Date(start).getTime():0,expiresAt=expiry?new Date(expiry).getTime():null;
 const valid=subject&&(!adminRole||subject.kind==="person")&&(!teamRole||adminRole||whole&&view.management.includes("hub.admin")||scope)&&Number.isFinite(startsAt)&&(expiresAt===null||Number.isFinite(expiresAt)&&expiresAt>startsAt)&&(limit===""||Number.isInteger(Number(limit))&&Number(limit)>=0&&Number(limit)<=8);
 const save=e=>{
  e.preventDefault();if(!valid||busy)return;const next=copy(view.policy);
  const replacement={id:original?.id||`assignment:${crypto.randomUUID()}`,roleId,subject:subject.kind==="person"?{kind:"person",person:subject.key}:{kind:"group",group:subject.key,dn:subject.dn},scope:!teamRole||adminRole||whole?{kind:"hub"}:{kind:"group",group:scope.key,dn:scope.dn},maxFleets:limit===""?null:Number(limit),startsAt,expiresAt,assignedBy:original?.assignedBy||view.actor,assignedAt:original?.assignedAt||0};
  if(original)next.assignments=next.assignments.map(row=>row.id===original.id?replacement:row);else next.assignments.push(replacement);onCheck(next);
 };
 const pick=row=>{setSubject(row);if(row.kind==="person")view.rememberPerson?.(row);};
 return html`<form class="card hub-role-assignment" onSubmit=${save}>
  <div class="hub-card-head"><h3>${hr("assign")}</h3></div>
  <div class="grid2"><label class="field"><span>${hr("role")}</span><select value=${roleId} disabled=${busy} onChange=${e=>setRoleId(e.target.value)}>${view.policy.roles.map(r=>html`<option key=${r.id} value=${r.id}>${name(r)}</option>`)}</select></label>
   <label class="field"><span>${hr("subject")}</span><select value=${kind} disabled=${busy} onChange=${e=>{setKind(e.target.value);setSubject(null);}}><option value="person">${hr("person")}</option><option value="group" disabled=${adminRole}>${hr("group")}</option></select></label></div>
  ${adminRole?html`<p class="s-info">${hr("personOnly")}</p>`:kind==="group"?html`<p class="s-info">${hr("groupCost")}</p>`:null}
  ${subject?html`<${SelectedSubject} subject=${subject} disabled=${busy} onClear=${()=>setSubject(null)}/>`:html`<${RoleSearch} key=${kind} client=${view.client} kind=${kind} disabled=${busy} id="hubRoleSubject" onPick=${pick}/>`}
  ${teamRole&&!adminRole?html`<label class="field"><span>${hr("scope")}</span><select value=${whole?"hub":"group"} disabled=${busy} onChange=${e=>setWhole(e.target.value==="hub")}><option value="group">${hr("scopeGroup")}</option><option value="hub" disabled=${!view.management.includes("hub.admin")}>${hr("wholeHub")}</option></select></label>
   ${!whole?scope?html`<${SelectedSubject} subject=${scope} disabled=${busy} onClear=${()=>setScope(null)}/>`:html`<${RoleSearch} client=${view.client} kind="group" disabled=${busy} id="hubRoleScope" onPick=${setScope}/>`:null}`:null}
  <div class="grid2"><label class="field"><span>${hr("start")}</span><input type="datetime-local" value=${start} disabled=${busy} onInput=${e=>setStart(e.target.value)}/></label><label class="field"><span>${hr("expiry")}</span><input type="datetime-local" value=${expiry} disabled=${busy} onInput=${e=>setExpiry(e.target.value)}/></label></div>
  ${role?.permissions.includes("pair_fleet")?html`<label class="field hub-role-quota-field"><span>${hr("override")} · ${hr("quota")}: ${role.defaultMaxFleets}</span><span class="hub-group-fleets"><input type="number" min="0" max="8" step="1" value=${limit} disabled=${busy} onInput=${e=>setLimit(e.target.value)}/></span></label>`:null}
  <div class="hub-role-actions"><button type="submit" class="btn btn-primary" disabled=${busy||!valid}>${hr("preview")}</button><button type="button" class="btn" disabled=${busy} onClick=${onCancel}>${hr("cancel")}</button></div>
 </form>`;
}
function ImpactPreview({view,checked,busy,onApply,onCancel}) {
 const metrics=[{key:"impactAffected",value:checked.impact?.losingActions?.length||0},{key:"impactPaused",value:checked.impact?.suspendedOnSave?.length||0},{key:"impactUnknown",value:checked.impact?.held?.length||0}];
 const changes=proposedChanges(view,checked);
 return html`<section class="card hub-role-preview" role="region" aria-label=${hr("changes")}><div class="hub-card-head"><h3>${hr("changes")}</h3></div>
  ${changes.length?html`<div class="s-row hub-row"><ul class="hub-role-summary">${changes.map(line=>html`<li>${line}</li>`)}</ul></div>`:null}
  <div class="hub-role-impact-grid">${metrics.map(metric=>html`<div class="hub-ov-card" key=${metric.key}><span class="hub-ov-card-title">${hr(metric.key)}</span><strong class=${`hub-ov-big${metric.value?" hub-role-warning":""}`}>${metric.value}</strong></div>`)}</div>
  <p class="note">${hr("noPreview")}</p><div class="hub-role-actions"><button type="button" class="btn btn-primary" disabled=${busy} onClick=${onApply}>${hr(busy?"saving":"apply")}</button><button type="button" class="btn" disabled=${busy} onClick=${onCancel}>${hr("cancel")}</button></div></section>`;
}
const resultTone=result=>/allow|complete|ok|success/i.test(result)?"ok":/denied|failed|refused/i.test(result)?"danger":"warn";
export function HubRoles({client}){
 const [styled,setStyled]=useState(null),[styleRetry,setStyleRetry]=useState(0);useEffect(()=>{let live=true;linkRoleCss().then(value=>{if(live)setStyled(value);});return()=>{live=false;};},[styleRetry]);
 const [view,setView]=useState(null),[failure,setFailure]=useState(null),[busy,setBusy]=useState(false),[editor,setEditor]=useState(null),[checked,setChecked]=useState(null),[saved,setSaved]=useState(false),[audit,setAudit]=useState(null),[auditError,setAuditError]=useState(null),[reload,setReload]=useState(0),[notices,setNotices]=useState([]);const epoch=useRef(0),writing=useRef(false);
 useEffect(()=>{let live=true;const mine=++epoch.current;setChecked(null);Promise.resolve().then(()=>client.roles()).then(out=>{if(!live||mine!==epoch.current)return;if(out.ok){setView(out.view);setFailure(null);if(out.view.management.includes("hub.admin")&&client.roleNotices)Promise.resolve(client.roleNotices()).then(n=>{if(live&&mine===epoch.current&&n.ok)setNotices(n.notices||[]);},()=>{});}else setFailure(error(out));},()=>{if(live&&mine===epoch.current)setFailure(hr("failed"));});Promise.resolve().then(()=>client.roleAudit()).then(out=>{if(!live||mine!==epoch.current)return;if(out.ok){setAudit(out);setAuditError(null);}else if(out.status!==403)setAuditError(hr("auditFailed"));},()=>{if(live&&mine===epoch.current)setAuditError(hr("auditFailed"));});const end=client.onSignedOut?.(()=>{epoch.current++;setView(null);setChecked(null);setEditor(null);setNotices([]);writing.current=false;setBusy(false);setFailure(hr("denied"));});return()=>{live=false;epoch.current++;end?.();};},[client,reload]);
 const preview=async(policy,rootSelf=false,origin="assignments")=>{if(writing.current)return;writing.current=true;setBusy(true);setFailure(null);setSaved(false);setChecked(null);const mine=++epoch.current;let out;try{out=rootSelf?await client.roleRootPreview():await client.rolePreview(policy);}catch{out={ok:false};}if(mine!==epoch.current)return;writing.current=false;setBusy(false);if(out.ok)setChecked({policy,rootSelf,...out,origin});else setFailure(error(out));};
 const apply=async()=>{if(!checked||writing.current)return;writing.current=true;setBusy(true);setFailure(null);const mine=++epoch.current;let out;try{out=checked.rootSelf?await client.roleRootApply(checked.previewDigest):await client.roleApply(checked.policy,checked.previewDigest);}catch{out={ok:false};}if(mine!==epoch.current)return;writing.current=false;setBusy(false);if(out.ok){setChecked(null);setEditor(null);setSaved(true);setReload(n=>n+1);}else{setChecked(null);setFailure(error(out));}};
 const more=async()=>{if(!audit?.nextCursor||busy)return;setBusy(true);const mine=epoch.current;let out;try{out=await client.roleAudit(audit.nextCursor);}catch{out={ok:false};}if(mine!==epoch.current)return;setBusy(false);if(out.ok)setAudit({...out,rows:[...audit.rows,...out.rows]});else setAuditError(hr("auditFailed"));};
 const acknowledge=async id=>{if(busy)return;setBusy(true);const mine=epoch.current;let out;try{out=await client.acknowledgeRoleNotice(id);}catch{out={ok:false};}if(mine!==epoch.current)return;setBusy(false);if(out.ok)setNotices(rows=>rows.filter(row=>row.id!==id));else setFailure(error(out));};
 const isRoot=view&&key(view.actor)===key(view.root),canEdit=view?.management.includes("hub.admin"),canAssign=view?.management.includes("roles.assign");
 if(!styled)return html`<section class="card"><p role="status">${hr(styled===false?"styleFailed":"styleLoading")}</p>${styled===false?html`<button type="button" class="btn" onClick=${()=>{setStyled(null);setStyleRetry(n=>n+1);}}>${hr("retry")}</button>`:null}</section>`;
 const impact=origin=>checked?.origin===origin?html`<${ImpactPreview} view=${view} checked=${checked} busy=${busy} onApply=${apply} onCancel=${()=>setChecked(null)}/>`:null;
 const changePerson=row=>setView(old=>({...old,personLabels:[...(old.personLabels||[]).filter(p=>p.id!==key(row.key)),{id:key(row.key),name:row.name}]}));
 return html`<div class="hub-roles"><p class="s-page-lead hub-page-lead">${hr("lead")}</p>
  ${failure?html`<p role="alert" class="err">${failure}</p><div class="hub-groups-actions"><button type="button" class="btn" disabled=${busy} onClick=${()=>setReload(n=>n+1)}>${hr("retry")}</button></div>`:null}
  ${saved?html`<p role="status">${hr("saved")}</p>`:null}${!view&&!failure?html`<p role="status">${hr("loading")}</p>`:null}
  <div class="s-section-layout">
   ${notices.length?html`<section class="card"><div class="hub-card-head"><h3>${hr("notices")}</h3></div><ul class="hub-rows hub-role-list">${notices.map(n=>html`<li class="s-row hub-row" key=${n.id}><span class="hub-row-text">${hr(n.body?.kind==="roles-available"?"migrationNotice":"adminNotice")}</span><div class="s-actions"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${()=>acknowledge(n.id)}>${hr("ack")}</button></div></li>`)}</ul></section>`:null}
   ${view?.policy?html`<section class="card hub-role-status"><div class="hub-card-head"><h3>${hr("status")}</h3><span class=${`tag ${view.policy.rolesActive?"ok":"warn"}`}>${hr(view.policy.rolesActive?"on":"off")}</span></div>
    <p class="note">${hr("offHelp")}</p>${view.policy.state==="never-enabled"?html`<p class="s-info" role="status">${hr("selfLegacy")}</p>`:view.policy.state==="suspended"?html`<p class="s-info" role="status">${hr("selfPaused")}</p>`:null}
    ${canEdit?html`<div class="hub-groups-actions"><a class="btn" href="/ui/hub/admin?view=allowed-list">${hr("openAllowedList")}</a><button type="button" class="btn" disabled=${busy} onClick=${()=>preview({...copy(view.policy),rolesActive:!view.policy.rolesActive},false,"status")}>${hr(view.policy.rolesActive?"turnOff":"turnOn")}</button></div>`:null}
    <div class="s-row hub-row hub-role-root"><span class="hub-row-text"><strong>${hr("firstAdmin")} · <span title=${key(view.root)}>${personName(view,view.root)}</span></strong><small class="note">${hr("firstAdminHelp")}</small>${isRoot&&!view.rootSelfUsed?html`<small class="note">${hr("rootHelp")}</small>`:null}</span>
     ${isRoot&&!view.rootSelfUsed?html`<div class="s-actions"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${()=>preview(null,true,"status")}>${hr("rootDefaults")}</button></div>`:null}</div></section>`:view?html`<p class="note">${hr("noPolicy")}</p>`:null}
   ${impact("status")}
   ${view?.policy?html`<section class="card"><div class="hub-card-head"><h3>${hr("roles")}</h3>${canEdit?html`<button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${()=>{setChecked(null);setEditor({role:{id:`custom:${crypto.randomUUID()}`,name:"",kind:"custom",permissions:[],defaultMaxFleets:1}});}}>${hr("newRole")}</button>`:null}</div>
    <ul class="hub-rows hub-role-list">${view.policy.roles.map(role=>html`<li class="s-row hub-row hub-role-row" key=${role.id}><span class="hub-row-text"><span class="hub-role-title-row"><strong>${name(role)}</strong><span class=${`tag${role.kind==="custom"?" persona":""}`}>${hr(role.kind==="custom"?"custom":role.kind==="carried"?"carried":"builtin")}</span>${role.permissions.includes("pair_fleet")?html`<span class="tag">${hr("quota")}: ${role.defaultMaxFleets}</span>`:null}</span>
     <span class="chips">${role.permissions.map(p=>html`<span class="tag hub-perm-tag" key=${p}>${hr(p)}</span>`)}</span></span><div class="s-actions hub-role-row-actions"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${()=>{setChecked(null);setEditor({role});}}>${hr("edit")}</button></div></li>`)}</ul><p class="note">${hr("inherited")}</p></section>`:null}
   ${editor?.role&&view?html`<${RoleEditor} key=${editor.role.id} view=${view} role=${editor.role} busy=${busy} onCheck=${policy=>preview(policy,false,"role")} onCancel=${()=>{setEditor(null);setChecked(null);}}/>${impact("role")}`:null}
   ${editor?.assignment&&view?html`<${AssignmentEditor} key=${editor.assignment?.id||"new"} assignment=${editor.assignment} view=${{...view,client,rememberPerson:changePerson}} busy=${busy} onCheck=${policy=>preview(policy,false,"assignment")} onCancel=${()=>{setEditor(null);setChecked(null);}}/>${impact("assignment")}`:null}
   ${view?.policy?html`<section class="card"><div class="hub-card-head"><h3>${hr("assignments")}</h3>${canAssign?html`<button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${()=>{setChecked(null);setEditor({assignment:true});}}>${hr("assign")}</button>`:null}</div><p class="note">${hr("selfHelp")}</p>
    <ul class="hub-rows hub-role-list">${view.policy.assignments.map(a=>{const own=a.subject.kind==="person"&&key(a.subject.person)===key(view.actor);return html`<li class="s-row hub-row hub-assignment-row" key=${a.id}><span class="hub-row-text"><span class="hub-role-title-row"><strong>${a.subject.kind==="person"?personName(view,a.subject.person):a.subject.dn}</strong><span class="tag persona">${name(view.policy.roles.find(r=>r.id===a.roleId))}</span><span class="tag">${a.scope.kind==="hub"?hr("wholeHub"):a.scope.dn}</span></span>
     <small class="note hub-role-detail">${a.startsAt?`${hr("start")}: ${new Date(a.startsAt).toLocaleString()}`:""}${a.expiresAt?` · ${hr("expiry")}: ${new Date(a.expiresAt).toLocaleString()}`:""}${a.maxFleets!==null?` · ${hr("quota")}: ${a.maxFleets}`:""}</small></span>
     ${canAssign?html`<div class="s-actions hub-role-row-actions"><button type="button" class="btn btn-sm" disabled=${busy||own} onClick=${()=>{setChecked(null);setEditor({assignment:a});}}>${hr("edit")}</button><button type="button" class="btn btn-sm danger" disabled=${busy||own} onClick=${()=>{const next=copy(view.policy);next.assignments=next.assignments.filter(row=>row.id!==a.id);preview(next,false,"assignments");}}>${hr("remove")}</button></div>`:null}</li>`;})}</ul></section>`:null}
   ${impact("assignments")}
   ${audit||auditError?html`<section class="card"><div class="hub-card-head"><h3>${hr("audit")}</h3></div>${auditError?html`<p class="err" role="alert">${auditError}</p>`:null}
    <div class="hub-team-table-wrap hub-role-table-wrap"><table class="hub-team-table hub-role-audit"><thead><tr><th>${hr("when")}</th><th>${hr("who")}</th><th>${hr("action")}</th><th>${hr("result")}</th></tr></thead>
     <tbody>${audit?.rows?.map(row=>html`<tr key=${row.id}><td class="hub-role-audit-when" data-label=${hr("when")}>${new Date(row.at).toLocaleString()}</td><td class="hub-role-audit-who" data-label=${hr("who")} title=${row.actor.id}>${row.actor.id==="unknown"?hr("unknownActor"):row.actor.name}</td><td class="hub-role-audit-action" data-label=${hr("action")}>${auditWord(row.action)}${row.summary?.map(line=>html`<small class="note hub-role-detail">${auditSummary(line)}</small>`)}</td><td class="hub-role-audit-result" data-label=${hr("result")}><span class=${`tag ${resultTone(row.result)}`}>${auditWord(row.result)}</span></td></tr>`)}</tbody></table></div>
    ${!audit?.rows?.length?html`<p class="note">${hr("empty")}</p>`:null}${audit?.nextCursor?html`<div class="hub-groups-actions"><button type="button" class="btn" disabled=${busy} onClick=${more}>${hr("more")}</button></div>`:null}</section>`:null}
  </div></div>`;
}
