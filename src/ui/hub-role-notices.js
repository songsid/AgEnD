/** Roles use the Hub's Notices destination, not a migration card above its role list. */
import {html,useEffect,useRef,useState} from "/assets/app-html.js";
import {hr} from "./hub-roles-strings.js";
export const roleNoticeLead=()=>hr("noticesLead");
export const roleNoticesOffered=(session,client)=>!!session?.features?.includes("role-settings-v1")&&client?.roleSettingsV1===true&&typeof client.roleNotices==="function"&&typeof client.acknowledgeRoleNotice==="function";
export function RoleNotices({client}){
 const [rows,setRows]=useState(null),[error,setError]=useState(null),[busy,setBusy]=useState(false),epoch=useRef(0);
 useEffect(()=>{const mine=++epoch.current;Promise.resolve().then(()=>client.roleNotices()).then(out=>{if(mine!==epoch.current)return;if(out.ok)setRows(out.notices||[]);else setError(hr("failed"));},()=>{if(mine===epoch.current)setError(hr("failed"));});return()=>{epoch.current++;};},[client]);
 const ack=async id=>{if(busy)return;setBusy(true);const mine=epoch.current;let out;try{out=await client.acknowledgeRoleNotice(id);}catch{out={ok:false};}if(mine!==epoch.current)return;setBusy(false);if(out.ok)setRows(previous=>previous.filter(row=>row.id!==id));else setError(hr("saveFailed"));};
 return html`<section class="card" aria-label=${hr("notices")}><h2>${hr("notices")}</h2>${error?html`<p class="err" role="alert">${error}</p>`:null}${rows===null&&!error?html`<p role="status">${hr("loading")}</p>`:null}${rows?.map(row=>html`<article class="directory-notice" key=${row.id}><p>${hr(row.body?.kind==="roles-available"?"migrationNotice":"adminNotice")}</p><button type="button" class="btn btn-sm" disabled=${busy} onClick=${()=>ack(row.id)}>${hr("ack")}</button></article>`)}${rows&&!rows.length?html`<p class="note">${hr("empty")}</p>`:null}</section>`;
}
