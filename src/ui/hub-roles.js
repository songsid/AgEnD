/** Role navigation/presentation. Every mutation still uses the server's single checked policy proposal. */
import {html,useEffect,useRef,useState} from "/assets/app-html.js";
import {Dialog} from "/assets/ui-dialog.js";
import {hr,linkRoleCss} from "./hub-roles-strings.js";
import {RoleWizard,AssignPanel,PermissionSections,Review} from "./hub-role-forms.js";
import {RoleAudit} from "./hub-role-audit.js";
import {personKey,personName,roleName,roleDescription,assignedSubjects,assignmentCount,subjectId,scopeName,roleError} from "./hub-role-view.js";
import { dateTimeText } from "/assets/clock-text.js";
const copy=value=>structuredClone(value);
function Tabs({items,value,onChange,disabled=false,label}){
 return html`<div class="hub-role-tabs" role="tablist" aria-label=${label}>${items.map(item=>html`<button key=${item.key} type="button" role="tab" tabindex=${item.key===value?0:-1} onKeyDown=${e=>{const at=items.findIndex(row=>row.key===value),keys={ArrowRight:(at+1)%items.length,ArrowLeft:(at+items.length-1)%items.length,Home:0,End:items.length-1};if(Object.hasOwn(keys,e.key)){e.preventDefault();const next=keys[e.key];onChange(items[next].key);(e.currentTarget||e.target).parentNode.querySelectorAll('[role="tab"]')[next]?.focus();}}} aria-selected=${item.key===value} class=${item.key===value?"is-active":""} disabled=${disabled} onClick=${()=>onChange(item.key)}>${item.label}</button>`)}</div>`;
}
function RoleList({view,busy,canEdit,canAssign,onOpen,onAssign,onCreate}){
 return html`<section class="card hub-role-list-page"><div class="hub-card-head"><h2>${hr("roles")}</h2>${canEdit?html`<button type="button" class="btn btn-primary" disabled=${busy} onClick=${onCreate}>${hr("newRole")}</button>`:null}</div>
  <div class="hub-team-table-wrap"><table class="hub-team-table hub-role-list"><thead><tr><th>${hr("role")}</th><th>${hr("rolePurpose")}</th><th>${hr("assignedTo")}</th><th></th></tr></thead><tbody>${view.policy.roles.map(role=>html`<tr key=${role.id} onClick=${()=>{if(!busy)onOpen(role.id);}}>
   <td><button type="button" class="hub-role-row-open" disabled=${busy} onClick=${e=>{e.stopPropagation();onOpen(role.id);}}>${roleName(role,view)}</button><span class="tag">${hr(role.kind==="custom"?"custom":role.kind==="carried-over"?"carried":"builtin")}</span></td>
   <td class="hub-role-purpose">${roleDescription(role,view)}</td><td class="hub-role-assigned-count">${assignmentCount(view,role)}</td><td>${canAssign?html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${e=>{e.stopPropagation();onAssign(role.id);}}>${hr("assign")}</button>`:null}</td></tr>`)}</tbody></table></div></section>`;
}
function People({view,roleId=null,busy,onOpen,onAssign}){
 const [filter,setFilter]=useState("all"),rows=assignedSubjects(view,roleId).filter(row=>filter==="all"||row.subject.kind===filter);
 return html`<section class="card hub-role-people"><div class="hub-card-head"><h2>${hr("people")}</h2>${onAssign?html`<button type="button" class="btn btn-primary" disabled=${busy} onClick=${onAssign}>${hr("assignPeople")}</button>`:null}</div>
  <label class="field hub-role-filter"><span>${hr("subject")}</span><select value=${filter} disabled=${busy} onChange=${e=>setFilter(e.target.value)}><option value="all">${hr("all")}</option><option value="person">${hr("people")}</option><option value="group">${hr("groups")}</option></select></label>
  <ul class="hub-rows">${rows.map(row=>html`<li class="s-row hub-row" key=${row.id}><span class="hub-row-text"><button type="button" class="hub-role-row-open" disabled=${busy} onClick=${()=>onOpen(row.subject)}>${row.name}</button>
   <span class="chips">${row.fixed?html`<span class="tag">${hr("admin")}</span>`:null}${[...new Set(row.assignments.map(a=>a.roleId))].map(id=>html`<span class="tag" key=${id}>${roleName(view.policy.roles.find(r=>r.id===id),view)}</span>`)}${row.subject.kind==="person"&&personKey(row.subject.person)===personKey(view.actor)?html`<span class="tag">${hr("you")}</span>`:null}</span>
   <small class="note">${row.fixed?hr("firstAdminHelp"):[...new Set(row.assignments.map(a=>scopeName(a.scope)))].join(" · ")}</small></span></li>`)}</ul>${!rows.length?html`<p class="note">${hr("nobodyAssigned")}</p>`:null}</section>`;
}
function PersonRoles({view,subject,busy,onBack,onEdit,onRemove}){
 const row=assignedSubjects(view).find(row=>row.id===subjectId(subject)),own=subject.kind==="person"&&personKey(subject.person)===personKey(view.actor),canAssign=view.management.includes("roles.assign");
 return html`<section class="card hub-role-person"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${onBack}>‹ ${hr("people")}</button><h2>${row?.name||hr("unknownPerson")}${own?html` <span class="tag">${hr("you")}</span>`:null}</h2>${own?html`<p class="s-info">${hr("selfHelp")}</p>`:null}
  <ul class="hub-rows">${row?.fixed?html`<li class="s-row hub-row"><span class="hub-row-text"><strong>${hr("admin")}</strong><small class="note">${hr("firstAdminHelp")}</small></span></li>`:null}
   ${row?.assignments.map(a=>html`<li class="s-row hub-row" key=${a.id}><span class="hub-row-text"><strong>${roleName(view.policy.roles.find(r=>r.id===a.roleId),view)}</strong><small class="note">${scopeName(a.scope)} · ${a.expiresAt?dateTimeText(a.expiresAt):hr("noEnd")}</small></span>
    ${canAssign?html`<div class="s-actions"><button type="button" class="btn btn-sm" disabled=${busy||own} onClick=${()=>onEdit(a)}>${hr("edit")}</button><button type="button" class="btn btn-sm danger" disabled=${busy||own} onClick=${()=>onRemove(a)}>${hr("remove")}</button></div>`:null}</li>`)}</ul></section>`;
}
function RolePage({view,role,busy,canEdit,canAssign,onBack,onAssign,onEdit,onDelete,onPerson}){
 const [tab,setTab]=useState("people"),editable=canEdit&&!["admin","carried-over"].includes(role.kind)&&!role.id.startsWith("root-self:");
 const count=assignedSubjects(view,role.id).length;
 return html`<section class="hub-role-detail"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${onBack}>‹ ${hr("roles")}</button><div class="hub-card-head"><h2>${roleName(role,view)} <span class="tag">${hr(["custom","carried-over"].includes(role.kind)?role.kind==="custom"?"custom":"carried":"builtin")}</span></h2>
  ${editable&&role.kind==="custom"?html`<details class="hub-role-menu"><summary>${hr("more")}</summary><button type="button" class="btn danger" disabled=${busy} onClick=${onDelete}>${hr("delete")}</button></details>`:null}</div><p>${roleDescription(role,view)}</p><p class="note">${hr("quota")}: ${role.defaultMaxFleets}</p>
  <${Tabs} label=${roleName(role,view)} items=${[{key:"people",label:hr("people")+" · "+count},{key:"permissions",label:hr("permissions")+" · "+hr("permissionCount",role.permissions.length,view.permissions.length)}]} value=${tab} disabled=${busy} onChange=${setTab}/>
  ${tab==="people"?html`<${People} key=${role.id} view=${view} roleId=${role.id} busy=${busy} onOpen=${onPerson} onAssign=${canAssign?onAssign:null}/>`:html`<section class="card"><div class="hub-card-head"><h3>${hr("permissions")}</h3>${editable?html`<button type="button" class="btn" disabled=${busy} onClick=${onEdit}>${hr("editPermissions")}</button>`:null}</div>
   ${role.kind==="admin"?html`<p class="s-info">${hr("adminFixed")}</p>`:null}${role.kind==="carried-over"?html`<p class="note">${hr("inherited")}</p>`:null}<${PermissionSections} permissions=${role.permissions} readOnly=${true} administrator=${role.kind==="admin"}/></section>`}</section>`;
}
export function HubRoles({client}){
 const [styled,setStyled]=useState(null),[styleRetry,setStyleRetry]=useState(0),[view,setView]=useState(null),[failure,setFailure]=useState(null),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[reload,setReload]=useState(0),[tab,setTab]=useState("roles"),[page,setPage]=useState(null),[wizard,setWizard]=useState(null),[assign,setAssign]=useState(null),[settings,setSettings]=useState(false),[checked,setChecked]=useState(null);
 const epoch=useRef(0),writing=useRef(false);
 useEffect(()=>{let live=true;linkRoleCss().then(out=>{if(live)setStyled(out);});return()=>{live=false;};},[styleRetry]);
 useEffect(()=>{let live=true;const mine=++epoch.current;setView(null);setChecked(null);setWizard(null);setAssign(null);setSettings(false);
  Promise.resolve().then(()=>client.roles()).then(out=>{if(!live||mine!==epoch.current)return;if(out.ok){setView(out.view);setFailure(null);if(!out.view.policy)setTab(out.view.management.includes("audit.view")?"audit":"roles");}else setFailure(roleError(out));},()=>{if(live&&mine===epoch.current)setFailure(hr("failed"));});
  const end=client.onSignedOut?.(()=>{epoch.current++;writing.current=false;setView(null);setChecked(null);setWizard(null);setAssign(null);setSettings(false);setBusy(false);setFailure(hr("denied"));});return()=>{live=false;epoch.current++;end?.();};
 },[client,reload]);
 const preview=async(policy,origin="page",rootSelf=false)=>{
  if(writing.current)return;writing.current=true;setBusy(true);setFailure(null);setSaved(false);setChecked(null);const mine=++epoch.current;let out;try{out=rootSelf?await client.roleRootPreview():await client.rolePreview(policy);}catch{out={ok:false};}
  if(mine!==epoch.current)return;writing.current=false;setBusy(false);if(out.ok)setChecked({policy,rootSelf,origin,...out});else setFailure(roleError(out,true));
 };
 const apply=async()=>{
  if(!checked||writing.current)return;writing.current=true;setBusy(true);setFailure(null);const selected=checked,mine=++epoch.current;let out;try{out=selected.rootSelf?await client.roleRootApply(selected.previewDigest):await client.roleApply(selected.policy,selected.previewDigest);}catch{out={ok:false};}
  if(mine!==epoch.current)return;writing.current=false;setBusy(false);setChecked(null);
  if(out.ok){if(wizard)setPage({kind:"role",id:wizard.id});setWizard(null);setAssign(null);setSettings(false);setSaved(true);setReload(n=>n+1);}else setFailure(roleError(out,true));
 };
 const remember=row=>setView(previous=>({...previous,personLabels:[...(previous.personLabels||[]).filter(p=>p.id!==personKey(row.key)),{id:personKey(row.key),name:row.name}]}));
 const close=()=>{if(busy)return;setChecked(null);setFailure(null);setWizard(null);setAssign(null);setSettings(false);};
 const openAssign=(roleId,assignment=null)=>{setChecked(null);setFailure(null);setAssign({roleId,assignment});};
 const refresh=()=>{setWizard(null);setAssign(null);setSettings(false);setChecked(null);setPage(null);setReload(n=>n+1);};
 const remove=a=>{const next=copy(view.policy);next.assignments=next.assignments.filter(row=>row.id!==a.id);void preview(next);};
 const root=view&&personKey(view.root)===personKey(view.actor),canEdit=!!view?.management.includes("hub.admin"),canAssign=!!view?.management.includes("roles.assign"),selectedRole=view?.policy?.roles.find(r=>r.id===page?.id);
 if(styled!==true)return html`<section class="card"><p role="status">${hr(styled===false?"styleFailed":"styleLoading")}</p>${styled===false?html`<button type="button" class="btn" onClick=${()=>{setStyled(null);setStyleRetry(n=>n+1);}}>${hr("retry")}</button>`:null}</section>`;
 return html`<div class="hub-roles"><p class="s-page-lead hub-page-lead">${hr("lead")}</p>
  ${failure&&!assign&&!settings?html`<p class="err" role="alert">${failure}</p><button type="button" class="btn" disabled=${busy} onClick=${refresh}>${hr("reloadRoles")}</button>`:null}${saved?html`<p role="status">${hr("saved")}</p>`:null}${!view&&!failure?html`<p role="status">${hr("loading")}</p>`:null}
  ${view?html`<div class="hub-role-top"><${Tabs} label=${hr("title")} items=${[...(view.policy?[{key:"roles",label:hr("roles")},{key:"people",label:hr("people")}]:[]),...(view.management.includes("audit.view")?[{key:"audit",label:hr("audit")}]:[])]} value=${tab} disabled=${busy} onChange=${key=>{setTab(key);setPage(null);setWizard(null);setChecked(null);setFailure(null);}}/>
   ${canEdit?html`<details class="hub-role-menu"><summary aria-label=${hr("rolesSettings")}>⋯</summary><button type="button" class="btn" disabled=${busy} onClick=${()=>{setSettings(true);setChecked(null);setFailure(null);}}>${hr("rolesSettings")}</button></details>`:null}</div>
   ${checked?.origin==="page"?html`<section class="card"><h2>${hr("review")}</h2><${Review} view=${view} checked=${checked}/><div class="hub-role-actions"><button type="button" class="btn" disabled=${busy} onClick=${()=>setChecked(null)}>${hr("back")}</button><button type="button" class=${`btn ${checked.policy?.roles.length<view.policy.roles.length?"danger":"btn-primary"}`} disabled=${busy} onClick=${apply}>${hr(busy?"saving":checked.policy?.roles.length<view.policy.roles.length?"delete":"apply")}</button></div></section>`:
    wizard?html`<${RoleWizard} key=${wizard.id} view=${view} role=${wizard} checked=${checked?.origin==="wizard"?checked:null} busy=${busy} onCheck=${policy=>preview(policy,"wizard")} onApply=${apply} onBack=${()=>setChecked(null)} onCancel=${close}/>`:
    tab==="audit"?html`<${RoleAudit} key=${reload} client=${client}/>`:
    page?.kind==="person"?html`<${PersonRoles} view=${view} subject=${page.subject} busy=${busy} onBack=${()=>setPage(null)} onEdit=${a=>openAssign(a.roleId,a)} onRemove=${remove}/>`:
    selectedRole?html`<${RolePage} key=${selectedRole.id} view=${view} role=${selectedRole} busy=${busy} canEdit=${canEdit} canAssign=${canAssign} onBack=${()=>setPage(null)} onPerson=${subject=>setPage({kind:"person",subject})} onAssign=${()=>openAssign(selectedRole.id)} onEdit=${()=>{setChecked(null);setWizard(selectedRole);}} onDelete=${()=>{const next=copy(view.policy);next.roles=next.roles.filter(r=>r.id!==selectedRole.id);next.assignments=next.assignments.filter(a=>a.roleId!==selectedRole.id);preview(next);}}/>`:
    tab==="people"?html`<${People} view=${view} busy=${busy} onOpen=${subject=>setPage({kind:"person",subject})} onAssign=${canAssign?()=>openAssign(null):null}/>`:
    view.policy?html`<${RoleList} view=${view} busy=${busy} canEdit=${canEdit} canAssign=${canAssign} onOpen=${id=>setPage({kind:"role",id})} onAssign=${openAssign} onCreate=${()=>{setFailure(null);setWizard({id:"custom:"+crypto.randomUUID(),kind:"custom",name:"",description:"",permissions:[],defaultMaxFleets:0});}}/>`:html`<p class="note">${hr("noPolicy")}</p>`}
   ${root&&!view.rootSelfUsed&&!wizard&&!checked&&tab==="roles"&&!page?html`<aside class="s-info hub-role-root-notice"><p>${hr("rootHelp")}</p><button type="button" class="btn btn-sm" disabled=${busy} onClick=${()=>preview(null,"page",true)}>${hr("rootDefaults")}</button></aside>`:null}
   ${assign?html`<${AssignPanel} view=${view} client=${client} roleId=${assign.roleId} assignment=${assign.assignment} checked=${checked?.origin==="assign"?checked:null} busy=${busy} failure=${failure} onReload=${refresh} onCheck=${policy=>preview(policy,"assign")} onApply=${apply} onBack=${()=>setChecked(null)} onClose=${close} onRemember=${remember}/>`:null}
   ${settings?html`<${Dialog} title=${checked?hr("review"):hr("rolesSettings")} busy=${busy} onClose=${close} wide=${true} cls="hub-role-panel" actions=${checked?html`<button type="button" class="btn" disabled=${busy} onClick=${()=>setChecked(null)}>${hr("back")}</button><button type="button" class="btn btn-primary" disabled=${busy} onClick=${apply}>${hr("apply")}</button>`:null}>
    ${failure?html`<p class="err" role="alert">${failure}</p><button type="button" class="btn" disabled=${busy} onClick=${refresh}>${hr("reloadRoles")}</button>`:null}${checked?html`<${Review} view=${view} checked=${checked}/>`:html`<div class="hub-role-status"><p><span class=${`tag ${view.policy.rolesActive?"ok":"warn"}`}>${hr(view.policy.rolesActive?"on":"off")}</span></p><p>${hr("offHelp")}</p>${view.policy.state==="never-enabled"?html`<p class="s-info">${hr("selfLegacy")}</p>`:view.policy.state==="suspended"?html`<p class="s-info">${hr("selfPaused")}</p>`:null}<button type="button" class="btn" disabled=${busy} onClick=${()=>{const next=copy(view.policy);next.rolesActive=!next.rolesActive;preview(next,"settings");}}>${hr(view.policy.rolesActive?"turnOff":"turnOn")}</button>
     <h3>${hr("firstAdmin")}</h3><p>${personName(view,view.root)}</p><p class="note">${hr("firstAdminHelp")}</p><a class="btn" href="/ui/hub/admin?view=allowed-list">${hr("openAllowedList")}</a></div>`}</${Dialog}>`:null}`:null}
 </div>`;
}
