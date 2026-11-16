/** Person-owned app connections. All authority remains in the Hub; names are display data. */
import {html,useEffect,useMemo,useRef,useState} from "/assets/app-html.js";
import {lang} from "/assets/app-i18n.js";
import {hubConnectorPrompt} from "/assets/connector-prompt.js";
import {SubjectPicker,subjectText} from "./hub-subject-picker.js";
import {ha} from "./hub-ai-apps-strings.js";

export const APP_SCOPES=Object.freeze(["rooms:read","rooms:post","agents:ask"]);
const keys={"rooms:read":"read","rooms:post":"post","agents:ask":"ask"};
const styles=new WeakMap();
export function linkHubAppsCss(doc=typeof document==="undefined"?null:document){
 if(!doc?.head)return Promise.resolve(false);if(styles.has(doc))return styles.get(doc);
 const loaded=new Promise(resolve=>{const link=doc.createElement("link");link.setAttribute("rel","stylesheet");link.setAttribute("href","/assets/hub-ai-apps.css");link.setAttribute("data-hub-apps-css","1");
  link.addEventListener("load",()=>resolve(true),{once:true});link.addEventListener("error",()=>{link.remove();styles.delete(doc);resolve(false);},{once:true});doc.head.appendChild(link);});styles.set(doc,loaded);return loaded;
}
function useStyle(){const[ready,setReady]=useState(null),[retry,setRetry]=useState(0);useEffect(()=>{let live=true;linkHubAppsCss().then(r=>{if(live)setReady(r);});return()=>{live=false;};},[retry]);return[ready,()=>setRetry(n=>n+1)];}
function StyleWait({ready,retry}){return html`<p role="status">${ha(ready===false?"styleFailed":"loading")}</p>${ready===false?html`<button class="btn hub-app-button" type="button" onClick=${retry}>${ha("retry")}</button>`:null}`;}
function useLife(client,key){const epoch=useRef(0),identity=useRef({client,key});if(identity.current.client!==client||identity.current.key!==key){epoch.current++;identity.current={client,key};}
 useEffect(()=>{const off=client.onSignedOut?.(()=>{epoch.current++;});return()=>{epoch.current++;off?.();};},[client,key]);return epoch;}
function useRead(client,method,arg){
 const[slot,setSlot]=useState(null),[revision,setRevision]=useState(0),epoch=useRef(0),identity=useMemo(()=>({}),[client,method,arg]);
 useEffect(()=>{let live=true;const mine=++epoch.current;setSlot({identity,value:null});Promise.resolve().then(()=>client[method](arg)).then(out=>{if(live&&mine===epoch.current)setSlot({identity,value:out});},()=>{if(live&&mine===epoch.current)setSlot({identity,value:{ok:false}});});
  const off=client.onSignedOut?.(()=>{epoch.current++;setSlot({identity,value:{ok:false,status:401}});});return()=>{live=false;epoch.current++;off?.();};},[identity,revision]);
 return[slot?.identity===identity?slot.value:null,()=>setRevision(n=>n+1)];
}
const errorText=r=>ha(r?.status===401?"signInAgain":r?.status===403?"denied":r?.status===400?"expired":"failed");
function ReadError({value,retry}){return html`<p class="err" role="alert">${errorText(value)}</p><button class="btn hub-app-button" type="button" onClick=${retry}>${ha("retry")}</button>`;}
export function appReturnUrl(value){try{const u=new URL(value);return !u.username&&!u.password&&!u.hash&&(u.protocol==="https:"||u.protocol==="http:"&&["127.0.0.1","[::1]","localhost"].includes(u.hostname))?u.href:null;}catch{return null;}}
export function AppConsentPage({client,request,person,returnTo=url=>location.assign(url)}){
 const[view,reload]=useRead(client,"appConsent",request),[scopes,setScopes]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),life=useLife(client,request),[ready,retry]=useStyle();
 const offered=JSON.stringify(view?.scopes||[]);useEffect(()=>{setScopes(APP_SCOPES.filter(scope=>view?.scopes?.includes(scope)));setError("");},[request,offered]);
 useEffect(()=>{setBusy(false);setError("");},[request]);
 const finish=async cancel=>{if(busy||!cancel&&!scopes.length)return;const mine=life.current;setBusy(true);setError("");let out;try{out=await client.saveAppConsent(request,cancel?{cancel:true}:{scopes});}catch{out={ok:false};}
  if(mine!==life.current)return;setBusy(false);const target=out.ok&&appReturnUrl(out.location);if(target)returnTo(target);else setError(out.ok?ha("invalidReturn"):errorText(out));};
 return html`<div class="s-section-layout hub-ai-apps"><section class="card"><h2>${view?.ok?ha("consentTitle",view.name):ha("consentHeading")}</h2>
  ${!ready?html`<${StyleWait} ready=${ready} retry=${retry}/>`:view===null?html`<p role="status">${ha("loading")}</p>`:!view.ok?html`<${ReadError} value=${view} retry=${reload}/>`:html`
   <p>${ha("consentLead",view.name,person||"")}</p><p class="note">${ha("unverified")}</p>
   ${APP_SCOPES.filter(scope=>view.scopes.includes(scope)).map(scope=>html`<label class="check" key=${scope}><input type="checkbox" data-app-scope=${scope} checked=${scopes.includes(scope)} disabled=${busy} onChange=${e=>setScopes(old=>e.target.checked?[...old,scope]:old.filter(x=>x!==scope))}/><span>${ha(keys[scope])}</span></label>`)}
   <label class="check"><input type="checkbox" disabled=${true} checked=${false}/><span>${ha("inbox")} · ${ha("later")}</span></label>
   <p class="note">${ha("noAdmin")}</p><p class="note">${ha("privacy")}</p>${!scopes.length?html`<p class="note">${ha("chooseScope")}</p>`:null}
   <div class="hub-app-actions"><button type="button" class="btn btn-primary hub-app-button" disabled=${busy||!scopes.length} onClick=${()=>finish(false)}>${ha("allow")}</button><button type="button" class="btn hub-app-button" disabled=${busy} onClick=${()=>finish(true)}>${ha("cancel")}</button></div>`}
   ${error?html`<p class="err" role="alert">${error}</p>`:null}</section></div>`;
}
function SetupCard({address}){
 const[app,setApp]=useState("claude"),[note,setNote]=useState("");const prompt=hubConnectorPrompt(address,app,ha);
 const copy=async text=>{try{await navigator.clipboard.writeText(text);setNote(ha("copied"));}catch{setNote(ha("copyFailed"));}};
 return html`<section class="card"><h3>${ha("connectTitle")}</h3><p class="note">${ha("connectLead")}</p>
  <label class="field"><span>${ha("address")}</span><input type="url" readonly=${true} value=${address||""}/></label><button type="button" class="btn hub-app-button" disabled=${!prompt} onClick=${()=>copy(address)}>${ha("copyAddress")}</button>
  <label class="field"><span>${ha("appChoice")}</span><select value=${app} onChange=${e=>setApp(e.target.value)}>${["claude","codex","generic"].map(key=>html`<option value=${key}>${ha(key)}</option>`)}</select></label>
  <button type="button" class="btn hub-app-button" disabled=${!prompt} onClick=${()=>copy(prompt)}>${ha("copyPrompt")}</button><p class="note" role="status">${note}</p>
  <details open=${note===ha("copyFailed")?true:undefined}><summary>${ha("config")}</summary><textarea readonly=${true} rows="7" aria-label=${ha("config")} value=${prompt}/></details></section>`;
}
export function MyAiAppsPage({client}){
 const[view,reload]=useRead(client,"aiApps"),[busy,setBusy]=useState(null),[note,setNote]=useState(""),life=useLife(client),[ready,retry]=useStyle();
 const disconnect=async id=>{if(busy)return;const mine=life.current;setBusy(id);let out;try{out=await client.disconnectAiApp(id);}catch{out={ok:false};}if(mine!==life.current)return;setBusy(null);setNote(out.ok?ha("disconnected"):errorText(out));if(out.ok)reload();};
 const date=n=>Number.isFinite(n)?new Date(n).toLocaleString(lang()):ha("unknown");
 return html`<div class="s-section-layout hub-ai-apps">${!ready?html`<section class="card"><${StyleWait} ready=${ready} retry=${retry}/></section>`:view===null?html`<section class="card"><p role="status">${ha("loading")}</p></section>`:!view.ok?html`<section class="card"><${ReadError} value=${view} retry=${reload}/></section>`:html`
  ${view.available===false?html`<section class="card"><p role="status">${ha("denied")}</p></section>`:null}<${SetupCard} address=${view.address}/>
  <section class="card"><h3>${ha("title")}</h3><p class="note">${ha("idle")}</p>${view.apps?.length?html`<ul class="hub-app-list">${view.apps.map(app=>html`<li class="s-row" key=${app.id}><div class="hub-app-row"><strong>${app.name}</strong><small class="note">${ha("dates",date(app.connectedAt),date(app.lastUsedAt))}</small><ul>${APP_SCOPES.filter(scope=>app.scopes?.includes(scope)).map(scope=>html`<li>${ha(keys[scope])}</li>`)}</ul></div><button type="button" class="btn hub-app-button" disabled=${busy!==null} onClick=${()=>disconnect(app.id)}>${ha("disconnect")}</button></li>`)}</ul>`:html`<p>${ha("empty")}</p>`}<p role="status" class="note">${note}</p></section>`}</div>`;
}
export function AiAppsAdminCard({client}){
 const[view,reload]=useRead(client,"aiAppsSettings"),[draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[note,setNote]=useState(""),life=useLife(client),[ready,retry]=useStyle();
 useEffect(()=>{if(view?.ok)setDraft({revision:view.revision,enabled:view.enabled,everyone:view.everyone,subjects:view.subjects||[]});},[view]);
 const search=useMemo(()=>(kind,q)=>client.searchAiAppSubjects(kind,q),[client]);
 const pick=(kind,row)=>{const id=kind==="person"?`${row.person?.realm}/${row.person?.objectId}`:kind==="team"?row.id:row.objectId,name=row.name||row.displayName||row.cn||row.login;
  setDraft(old=>old.subjects.some(s=>s.kind===kind&&s.id===id)?old:{...old,subjects:[...old.subjects,{kind,id,name}]});};
 const save=async()=>{if(busy||!draft)return;const mine=life.current;setBusy(true);let out;try{out=await client.saveAiAppsSettings(draft);}catch{out={ok:false};}if(mine!==life.current)return;setBusy(false);setNote(out.ok?ha("saved"):errorText(out));if(out.ok)reload();};
 return html`<section class="card hub-ai-apps"><h3>${ha("adminTitle")}</h3>${!ready?html`<${StyleWait} ready=${ready} retry=${retry}/>`:view===null?html`<p role="status">${ha("loading")}</p>`:!view.ok?html`<${ReadError} value=${view} retry=${reload}/>`:draft?html`
  <label class="check"><input class="s-ui-toggle" type="checkbox" role="switch" checked=${draft.enabled} disabled=${busy} onChange=${e=>{const value=e.target.checked;setDraft(old=>({...old,enabled:value}));}}/><span>${ha("adminSwitch")}</span></label>
  ${[true,false].map(everyone=>html`<label class="check"><input type="radio" name="hubAppAllowed" checked=${draft.everyone===everyone} disabled=${busy} onChange=${()=>setDraft(old=>({...old,everyone}))}/><span>${ha(everyone?"everyone":"selected")}</span></label>`)}
  ${!draft.everyone?html`<ul class="hub-app-list">${draft.subjects.map(row=>html`<li class="s-row" key=${`${row.kind}:${row.id}`}><span class="grow">${row.name} · ${subjectText(row.kind)}</span><button type="button" class="btn hub-app-button" disabled=${busy} aria-label=${ha("removeLabel",row.name)} onClick=${()=>setDraft({...draft,subjects:draft.subjects.filter(x=>x!==row)})}>${ha("remove")}</button></li>`)}</ul><${SubjectPicker} client=${client} search=${search} disabled=${busy} onPick=${pick}/>`:null}
  <p class="note">${ha("narrowWarning")}</p><button type="button" class="btn btn-primary hub-app-button" disabled=${busy} onClick=${save}>${ha("save")}</button><p class="note" role="status">${note}</p>`:null}</section>`;
}
