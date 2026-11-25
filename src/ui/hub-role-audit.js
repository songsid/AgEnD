import {html,useEffect,useRef,useState} from "/assets/app-html.js";
import {hr} from "./hub-roles-strings.js";
import {auditActor,auditAction,auditCsv,auditResult,auditSentence,valueLines,roleAuditActions} from "./hub-role-view.js";
import { dateTimeText } from "/assets/clock-text.js";
export function RoleAudit({client}){
 const enhanced=client.roleAuditFiltersV1===true;
 const [page,setPage]=useState(null),[error,setError]=useState(null),[busy,setBusy]=useState(false),[exporting,setExporting]=useState(false),[filters,setFilters]=useState({}),[draft,setDraft]=useState({from:"",to:"",person:"",action:""}),[people,setPeople]=useState([]),[actions,setActions]=useState(()=>[...roleAuditActions]);
 const epoch=useRef(0),pending=useRef(false);
 const load=async(cursor=null,query=filters,mine=epoch.current)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError(null);let out;try{out=await client.roleAudit(cursor,query);}catch{out={ok:false};}
  if(mine!==epoch.current)return;pending.current=false;setBusy(false);
  if(!out.ok){setError(hr("auditFailed"));return;}
  setPage(previous=>({...out,rows:cursor?[...(previous?.rows||[]),...out.rows]:out.rows}));
  setPeople(previous=>[...new Map([...previous,...out.rows.map(row=>({id:row.actor.id,name:auditActor(row)}))].map(row=>[row.id,row])).values()]);setActions(previous=>[...new Set([...previous,...out.rows.map(row=>row.action)])]);
 };
 useEffect(()=>{const mine=++epoch.current;pending.current=false;void load(null,{},mine);return()=>{epoch.current++;pending.current=false;};},[client]);
 const filter=e=>{e.preventDefault();if(busy||exporting)return;const query={};if(draft.from)query.from=new Date(draft.from+"T00:00:00").getTime();if(draft.to)query.to=new Date(draft.to+"T23:59:59.999").getTime();if(draft.person)query.person=draft.person;if(draft.action)query.action=draft.action;setFilters(query);setPage(null);void load(null,query);};
 const download=async()=>{
  if(exporting||busy)return;setExporting(true);setError(null);const mine=epoch.current;let cursor=null,rows=[];const seen=new Set();
  try{do{const out=await client.roleAudit(cursor,filters);if(mine!==epoch.current)return;if(!out.ok)throw Error("exportFailed");rows.push(...out.rows);cursor=out.nextCursor;
    if(rows.length>5000||cursor&&rows.length>=5000)throw Error("exportTooLarge");if(cursor&&seen.has(cursor))throw Error("exportFailed");if(cursor)seen.add(cursor);
   }while(cursor);
   const blob=new Blob([auditCsv(rows)],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="hub-audit.csv";link.click();URL.revokeObjectURL(url);
  }catch(e){if(mine===epoch.current)setError(hr(e.message==="exportTooLarge"?"exportTooLarge":"exportFailed"));}
  finally{if(mine===epoch.current)setExporting(false);}
 };
 return html`<section class="hub-role-audit-page"><div class="hub-card-head"><h2>${hr("audit")}</h2><button type="button" class="btn" disabled=${!enhanced||busy||exporting||!page} onClick=${download}>${hr("exportCsv")}</button></div>
  ${!enhanced?html`<p class="note" role="status">${hr("refreshAudit")}</p>`:html`<p class="note">${hr("exportLimit")}</p>`}
  ${enhanced?html`<form class="hub-role-audit-filters" onSubmit=${filter}>
   <label class="field"><span>${hr("dateFrom")}</span><input type="date" value=${draft.from} disabled=${busy||exporting} onInput=${e=>setDraft({...draft,from:e.target.value})}/></label>
   <label class="field"><span>${hr("dateTo")}</span><input type="date" value=${draft.to} disabled=${busy||exporting} onInput=${e=>setDraft({...draft,to:e.target.value})}/></label>
   <label class="field"><span>${hr("filterPerson")}</span><select value=${draft.person} disabled=${busy||exporting} onChange=${e=>setDraft({...draft,person:e.target.value})}><option value="">${hr("all")}</option>${people.map(person=>html`<option key=${person.id} value=${person.id}>${person.name}</option>`)}</select></label>
   <label class="field"><span>${hr("filterAction")}</span><select value=${draft.action} disabled=${busy||exporting} onChange=${e=>setDraft({...draft,action:e.target.value})}><option value="">${hr("all")}</option>${actions.map(action=>html`<option key=${action} value=${action}>${auditAction(action)}</option>`)}</select></label><button type="submit" class="btn" disabled=${busy||exporting}>${hr("filter")}</button></form>`:null}
  ${error?html`<p class="err" role="alert">${error}</p><button type="button" class="btn" disabled=${busy||exporting} onClick=${()=>load(null,filters)}>${hr("retry")}</button>`:null}${!page&&!error?html`<p role="status">${hr("loading")}</p>`:null}
  <div class="hub-team-table-wrap"><table class="hub-team-table hub-role-audit"><thead><tr><th>${hr("when")}</th><th>${hr("who")}</th><th>${hr("action")}</th><th>${hr("result")}</th></tr></thead><tbody>
   ${page?.rows?.map(row=>html`<tr key=${row.id}><td class="hub-role-audit-when"><time datetime=${new Date(row.at).toISOString()}>${dateTimeText(row.at)}</time></td><td class="hub-role-audit-who">${auditActor(row)}</td><td class="hub-role-audit-action">
    ${row.details?html`<details><summary>${auditSentence(row)}</summary><div class="grid2 hub-role-audit-values">${["before","after"].map(side=>html`<div key=${side}><strong>${hr(side)}</strong><ul>${valueLines(row.details[side]).map((line,i)=>html`<li key=${i}>${line}</li>`)}</ul></div>`)}</div></details>`:auditSentence(row)}</td>
    <td class="hub-role-audit-result"><span class=${`tag ${row.result==="denied"?"warn":["completed","allowed"].includes(row.result)?"ok":"danger"}`}>${auditResult(row.result)}</span></td></tr>`)}</tbody></table></div>
  ${page&&!page.rows.length?html`<p class="note">${hr("empty")}</p>`:null}${page?.nextCursor?html`<div class="hub-role-actions"><button type="button" class="btn" disabled=${busy||exporting} onClick=${()=>load(page.nextCursor)}>${hr("more")}</button></div>`:null}</section>`;
}
