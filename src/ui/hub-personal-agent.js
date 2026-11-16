import {html,useEffect,useRef,useState} from "/assets/app-html.js";
import {ErrorState,Skeleton} from "/assets/ui-states.js";
import {confirmDialog} from "/assets/ui-confirm.js";
import {runtimeEnrollCommand} from "./runtime-commands.js";
import {hp} from "./hub-personal-agent-strings.js";
const refused=()=>({ok:false});
const fields=agent=>({name:agent?.name??"",description:agent?.description??"",cli:agent?.cli??"",model:agent?.model??"",ifRevision:agent?.revision??0,answerOnly:agent?.answerOnly===true});
const policy=value=>({enabled:value.enabled===true,people:[...(value.people??[])],teams:[...(value.teams??[])]});
export function personalCliReason(cli){
 if(cli?.available)return "canUse";
 if(!cli?.path)return "missing";
 if(cli.authenticated!==true)return "signIn";
 if(cli.id==="codex"&&["sandbox-unavailable","profile-unavailable"].includes(cli.personalStatus)&&cli.answerOnlyAvailable===false)return "answerOnlyFailed";
 return cli.id==="codex"&&cli.personalStatus==="sandbox-unavailable"?"codexSandbox":"profile";
}
function installCss(){if(typeof document==="undefined"||document.querySelector('link[data-personal-install="1"]'))return;const link=document.createElement("link");link.rel="stylesheet";link.href="/assets/runtime-install.css";link.setAttribute("data-personal-install","1");document.head.appendChild(link);}
/** The captured sign-in is passed through every client call, including writes after an await. */
export function HubPersonalAgent({client,scope,onSaved=()=>{}}){
 const [view,setView]=useState(null),[form,setForm]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[issued,setIssued]=useState(null),[saved,setSaved]=useState(false),[copied,setCopied]=useState(false),[clock,setClock]=useState(Date.now());
 const generation=useRef(0),dirty=useRef(false),reads=useRef(0),busyRef=useRef(false);
 const markBusy=value=>{busyRef.current=value;if(value)reads.current++;setBusy(value);};
 const load=async(refresh=false,replace=false)=>{const mine=generation.current,read=++reads.current;let value;try{value=await (refresh?client.refreshPersonalAgent(scope):client.personalAgent(scope));}catch{value=refused();}
  if(mine!==generation.current||read!==reads.current)return;if(!value?.ok){setError(hp("loadFailed"));return;}setView(value);setError("");
  setForm(previous=>!previous||replace||!dirty.current?fields(value.agent):previous);
 };
 useEffect(()=>{generation.current++;dirty.current=false;markBusy(false);setView(null);setForm(null);setIssued(null);setSaved(false);setError("");installCss();void load();
  const timer=setInterval(()=>{setClock(Date.now());if(!busyRef.current)void load();},5000);return()=>{generation.current++;clearInterval(timer);};},[client,scope]);
 const edit=patch=>{dirty.current=true;setSaved(false);setForm(value=>({...value,...patch}));};
 const enroll=async()=>{if(busyRef.current)return;markBusy(true);setError("");const mine=generation.current;let result;try{result=await client.personalEnrollment(scope);}catch{result=refused();}
  if(mine!==generation.current)return;markBusy(false);if(!result?.ok){setError(hp("saveFailed"));return;}setIssued(result);setClock(Date.now());setCopied(false);
 };
 const save=async event=>{event.preventDefault();if(busyRef.current||!form?.name.trim())return;markBusy(true);setError("");const mine=generation.current;
  let result;try{const {model,answerOnly,...input}=form;result=await client.savePersonalAgent(scope,{...input,...(model?{model}:{}),...(answerOnly?{answerOnly:true}:{})});}catch{result=refused();}
  if(mine!==generation.current)return;markBusy(false);if(!result?.ok){setError(hp("saveFailed"));return;}dirty.current=false;setIssued(null);setSaved(true);await load(false,true);if(mine===generation.current)onSaved();
 };
 const disconnect=async()=>{if(busyRef.current)return;const mine=generation.current;markBusy(true);const confirmed=await confirmDialog({message:hp("disconnectAsk"),confirmLabel:hp("disconnectConfirm"),danger:true});if(mine!==generation.current)return;if(!confirmed){markBusy(false);return;}
  let result;try{result=await client.disconnectPersonalAgent(scope);}catch{result=refused();}if(mine!==generation.current)return;markBusy(false);
  if(!result?.ok){setError(hp("saveFailed"));return;}dirty.current=false;setIssued(null);await load(false,true);if(mine===generation.current)onSaved();
 };
 const refresh=async()=>{if(busyRef.current)return;const mine=generation.current;markBusy(true);await load(true);if(mine===generation.current)markBusy(false);};
 const computer=view?.computer,selected=computer?.clis.find(row=>row.id===form?.cli),command=issued&&issued.expiresAt>clock?runtimeEnrollCommand(issued.server,issued.installer?.scriptSha256,issued.token,issued.fingerprint,"personal"):"";
 const canUse=cli=>cli?.available && (cli.id!=="codex"||!form?.answerOnly) || cli?.id==="codex" && form?.answerOnly && cli.answerOnlyAvailable===true;
 return html`<section class="card hub-personal-agent" data-personal-agent><h3>${hp("title")}</h3><p class="note">${hp("lead")}</p>${!form?.answerOnly?html`<p class="note">${hp("guard")}</p>`:null}
  ${error?html`<${ErrorState} message=${error} onRetry=${()=>void load()} />`:null}
  ${!view&&!error?html`<${Skeleton} lines=${3} />`:null}
  ${view&&!view.enabled?html`<p class="note">${hp("off")}</p>`:view&&!view.canAdd?html`<p class="note">${hp("denied")}</p>`:view?html`
   <div class="field-row">${!computer||issued?html`<button type="button" class=${`btn btn-sm ${issued?"btn-ghost":"btn-primary"}`} disabled=${busy} onClick=${enroll}>${hp(issued?"newCommand":"add")}</button>`:null}<button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${refresh}>${hp("refresh")}</button></div>
   ${issued?command?html`<div class="runtime-command-card"><strong class="runtime-command-label">${hp("install")}</strong><p class="note">${hp("installHint")}</p><div class="runtime-command-row"><pre class="runtime-command-text"><code>${command}</code></pre><button type="button" class="btn btn-sm btn-primary" onClick=${async()=>{try{const mine=generation.current;await navigator.clipboard.writeText(command);if(mine===generation.current)setCopied(true);}catch{setCopied(false);}}}>${hp(copied?"copied":"copy")}</button></div><p class="note">${hp("folderHint")}</p><details class="s-ui-disclosure"><summary>${hp("commandFails")}</summary><div class="s-disclosure-body form"><p class="note">${hp("certificateFailure")}</p><p class="note">${hp("nodeFailure")}</p><p class="note">${hp("expiredHelp")}</p></div></details></div>`:html`<div class="form"><p class="note">${hp("expired")}</p></div>`:null}
   ${computer?html`<div class="s-row"><span class="hub-row-text"><strong>${computer.name}</strong><small class="note">${form?.answerOnly?hp("answerOnly"):computer.folder||hp("unchecked")}</small></span><span class="tag">${hp(!computer.connected?"later":computer.working?"working":computer.clis.some(canUse)?"ready":"unavailable")}</span></div>
    ${computer.clis.map(cli=>{const compact=view.agent?.answerOnly===true&&form?.answerOnly,reason=personalCliReason(cli);return html`<div key=${cli.id} class="hub-personal-cli">
     <div class="s-row"><span class="hub-row-text"><strong>${cli.id==="codex"?"Codex":"Claude"}</strong><small class="note">${hp(form?.answerOnly&&cli.id==="codex"&&cli.answerOnlyAvailable?"answerOnly":reason)}</small>${cli.reason&&!cli.available&&reason!=="answerOnlyFailed"?html`<small class="note">${cli.reason}</small>`:null}</span></div>
     ${cli.id==="codex"&&(cli.answerOnlyAvailable===true||form?.answerOnly&&cli.available)?html`<div class="form" data-answer-only-option>
      ${!compact?html`<strong>${hp("answerOnlyOption")}</strong><p class="note">${hp("answerOnlyExplain")}</p>`:null}
      <p class="note">${hp("answerOnlyDisclosure")}</p>${!compact?html`<p class="note">${hp("answerOnlyPays")}</p>`:null}
      <label class="check"><input type="checkbox" disabled=${busy} checked=${form?.answerOnly===true} onChange=${e=>edit({answerOnly:e.target.checked,cli:e.target.checked?"codex":form.cli,model:""})} /><span>${hp("answerOnlyTick")}</span></label>
     </div>`:null}</div>`;})}
    ${computer.clis.some(canUse)?html`<form onSubmit=${save} class="form"><label class="field"><span>${hp("name")}</span><input required maxlength="256" disabled=${busy} value=${form?.name||""} onInput=${e=>edit({name:e.target.value})} /></label>
     <label class="field"><span>${hp("description")}</span><input maxlength="512" disabled=${busy} value=${form?.description||""} onInput=${e=>edit({description:e.target.value})} /></label>
     <label class="field"><span>${hp("cli")}</span><select required disabled=${busy} value=${form?.cli||""} onChange=${e=>edit({cli:e.target.value,model:"",answerOnly:e.target.value==="codex"&&form.answerOnly})}><option value=""></option>${computer.clis.filter(canUse).map(c=>html`<option value=${c.id}>${c.id==="codex"?"Codex":"Claude"}</option>`)}</select></label>
     <label class="field"><span>${hp("model")}</span><select disabled=${busy} value=${form?.model||""} onChange=${e=>edit({model:e.target.value})}><option value="">${hp("defaultModel")}</option>${(selected?.models??[]).map(m=>html`<option value=${m.id}>${m.label||m.id}</option>`)}</select></label>
     <div class="field-row"><button class="btn btn-sm btn-primary" disabled=${busy||!canUse(selected)||!computer.connected||!form?.name.trim()||!!view.agent&&!dirty.current}>${hp("save")}</button>${dirty.current?html`<span class="note" role="status">${hp("unsaved")}</span>`:null}</div></form>`:null}
    `:null}
   ${saved?html`<p class="note" role="status">${hp("saved")}</p>`:null}${view.agent?html`<div class="form">${!view.agent.shared?html`<p class="note">${hp("notShared")}</p>`:null}<div class="field-row"><a class=${`btn btn-sm ${!view.agent.shared?"btn-primary":"btn-ghost"}`} href=${`/ui/hub/exposures?agent=${encodeURIComponent(view.agent.exposureId)}`}>${hp(view.agent.shared?"changeSharing":"sharing")}</a></div></div>`:null}
   ${computer?html`<div class="hub-this-actions"><button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${enroll}>${hp("replace")}</button><button type="button" class="btn btn-sm btn-danger" disabled=${busy} onClick=${disconnect}>${hp("disconnect")}</button></div>`:null}`:null}
 </section>`;
}
export function HubPersonalAgentAdmin({client,scope}){
 const [view,setView]=useState(null),[form,setForm]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[errorKind,setErrorKind]=useState("load"),[saved,setSaved]=useState(false),[query,setQuery]=useState(""),[hits,setHits]=useState([]),[teams,setTeams]=useState([]);
 const generation=useRef(0),searchSequence=useRef(0),reads=useRef(0),busyRef=useRef(false);
 const markBusy=value=>{busyRef.current=value;if(value)reads.current++;setBusy(value);};
 const load=async()=>{const mine=generation.current,read=++reads.current;const [settings,teamRows]=await Promise.allSettled([client.personalAgentSettings(scope),client.teams()]);if(mine!==generation.current||read!==reads.current)return;
  const data=settings.status==="fulfilled"?settings.value:refused();if(!data?.ok){setErrorKind("load");setError(hp("loadFailed"));return;}setError("");setView(data);setForm(policy(data));setTeams(teamRows.status==="fulfilled"&&teamRows.value.ok?teamRows.value.teams??[]:[]);
 };
 useEffect(()=>{generation.current++;markBusy(false);setView(null);setForm(null);setError("");setSaved(false);setHits([]);void load();return()=>{generation.current++;};},[client,scope]);
 const edit=patch=>{setSaved(false);setForm(value=>({...value,...patch}));};
 const search=async()=>{if(query.trim().length<2||busy)return;const mine=generation.current,search=++searchSequence.current;let result;try{result=await client.teamSuggestions("person",query.trim());}catch{result=refused();}
  if(mine!==generation.current||search!==searchSequence.current)return;if(!result?.ok){setErrorKind("search");setError(hp("loadFailed"));return;}setError("");setHits(result.candidates??[]);
 };
 const pickPerson=row=>{if(!form.people.includes(row.id))edit({people:[...form.people,row.id]});setView(value=>({...value,peopleInfo:[...(value.peopleInfo??[]).filter(p=>p.id!==row.id),row]}));setHits([]);setQuery("");};
 const save=async event=>{event?.preventDefault();if(busyRef.current)return;markBusy(true);setError("");const mine=generation.current;let result;try{result=await client.savePersonalAgentSettings(scope,policy(form));}catch{result=refused();}
  if(mine!==generation.current)return;markBusy(false);if(!result?.ok){setErrorKind("save");setError(hp("saveFailed"));return;}setView(result);setForm(policy(result));setSaved(true);
 };
 const changed=!!form&&JSON.stringify(policy(view))!==JSON.stringify(form);
 return html`<section class="card" data-personal-admin><h3>${hp("adminTitle")}</h3><p class="note">${hp("adminLead")}</p>${error?html`<${ErrorState} message=${error} onRetry=${()=>void (errorKind==="save"?save():errorKind==="search"?search():load())} />`:null}
  ${!form&&!error?html`<${Skeleton} lines=${3} />`:form?html`<form onSubmit=${save} class="form"><label class="s-row"><span class="hub-row-text">${hp("enabled")}</span><input class="s-ui-toggle" role="switch" aria-label=${hp("enabled")} type="checkbox" disabled=${busy} checked=${form.enabled} onChange=${e=>edit({enabled:e.target.checked})} /></label>
   <p class="note">${hp("adminAlways")}</p><h4>${hp("allowed")}</h4>${!form.people.length&&!form.teams.length?html`<p class="note">${hp("onlyAdmin")}</p>`:null}
   ${form.people.map(id=>{const p=view.peopleInfo?.find(p=>p.id===id);return html`<div key=${id} class="s-row"><span class="hub-row-text"><strong>${p?.name||hp("unknownPerson")}</strong><small class="note">${p?.login||""}</small></span><button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${()=>edit({people:form.people.filter(p=>p!==id)})}>${hp("remove")}</button></div>`;})}
   ${form.teams.map(id=>html`<div key=${id} class="s-row"><span class="hub-row-text">${teams.find(t=>t.id===id)?.name||view.teamsInfo?.find(t=>t.id===id)?.name||hp("unknownTeam")}</span><button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${()=>edit({teams:form.teams.filter(t=>t!==id)})}>${hp("remove")}</button></div>`)}
   <label class="field"><span>${hp("search")}</span><input type="search" disabled=${busy} minlength="2" maxlength="64" value=${query} onInput=${e=>{searchSequence.current++;setQuery(e.target.value);setHits([]);}} /></label><button type="button" class="btn btn-sm" disabled=${busy||query.trim().length<2} onClick=${search}>${hp("find")}</button>
   ${hits.map(p=>html`<div key=${p.id} class="s-row"><span class="hub-row-text"><strong>${p.name}</strong><small class="note">${p.login||""}</small></span><button type="button" class="btn btn-sm" disabled=${busy} onClick=${()=>pickPerson(p)}>${hp("choose")}</button></div>`)}
   <label class="field"><span>${hp("team")}</span><select disabled=${busy} value="" onChange=${e=>{if(e.target.value&&!form.teams.includes(e.target.value))edit({teams:[...form.teams,e.target.value]});}}><option value="">${hp("chooseTeam")}</option>${teams.filter(t=>!form.teams.includes(t.id)).map(t=>html`<option value=${t.id}>${t.name}</option>`)}</select></label>
   <div class="field-row"><button class="btn btn-sm btn-primary" disabled=${busy||!changed}>${hp("saveSettings")}</button>${changed||saved?html`<span class="note" role="status">${hp(changed?"unsaved":"savedSettings")}</span>`:null}</div></form>`:null}
 </section>`;
}
