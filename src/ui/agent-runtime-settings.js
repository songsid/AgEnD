import {html,useEffect,useRef,useState} from "/assets/app-html.js";
import {useLease} from "/assets/app-ctx.js";
import {appStore,useStore} from "/assets/app-store.js";
import {register,t} from "/assets/app-i18n.js";
import {Dialog} from "/assets/ui-dialog.js";
import {CliPicker,CliProductMark,cliLabel} from "./cli-picker.js";
import {RuntimePicker,tr} from "./agent-runtime.js";
import {useRuntimeCatalog,runtimeCliChoices} from "./runtime-catalog.js";
import {useWindowsCliCatalog} from "./windows-cli-catalog.js";
import {useBackendRows} from "./settings-catalog.js";
import {ModelSelect} from "./settings-dialogs.js";
import {removedBackendReplacement} from "./settings-model.js";
register("runtimeChange",{
 "zh-TW":{removed:"{0} 已從 AgEnD 移除，無法繼續使用。請改選其他 CLI，建議使用 {1}。",title:"切換 Runtime 與 CLI",change:"切換 Runtime／CLI",current:"執行環境與 CLI",lead:"保留同一個 Agent 與 AgEnD 聊天歷史，在選擇的電腦開始新的 CLI 對話。",configure:"設定新環境",next:"下一步",back:"上一步",cancel:"取消",apply:"儲存切換",loading:"正在讀取 Agent 與 Runtime 狀態…",busy:"正在準備新工作區並關閉舊 CLI…",fresh:"我了解切換後會開始新的 CLI 對話",freshHint:"原有 CLI 對話與檔案會留在原電腦；不會自動複製到新環境。",stopped:"切換後 Agent 會暫停，請從 Agent 列表啟動。",directoryHint:"更換電腦時請填目標電腦的路徑；留空會建立獨立工作區。",dirty:"請先儲存或取消其他編輯，再切換 Runtime。",unknown:"請重新讀取 Agent 狀態再操作，避免重複切換。",reload:"重新讀取狀態",failed:"無法切換 Runtime",noCli:"這台電腦尚無可用的 CLI。請先到 Runtime 偵測或更新清單。"},
 en:{removed:"{0} was removed from AgEnD and can no longer run. Choose another CLI; {1} is its replacement.",title:"Change runtime and CLI",change:"Change runtime / CLI",current:"Runtime and CLI",lead:"Keep this Agent and its AgEnD chat history. Start a fresh CLI conversation on the selected computer.",configure:"Configure the new environment",next:"Next",back:"Back",cancel:"Cancel",apply:"Save runtime change",loading:"Loading Agent and runtime state…",busy:"Preparing the new workspace and closing the old CLI…",fresh:"I understand this starts a new CLI conversation",freshHint:"Existing CLI conversations and files stay on the original computer. They are not copied to the new environment.",stopped:"The Agent will be paused after switching. Start it from the Agent list.",directoryHint:"Use a path on the target computer. Leave empty for a separate managed workspace.",dirty:"Save or cancel other edits before changing runtime.",unknown:"Read the Agent state again before another operation to avoid switching twice.",reload:"Read state again",failed:"Could not change runtime",noCli:"No runnable CLI is available on this computer. Detect or refresh its inventory in Runtime settings."}
});
const text=(key,...values)=>t(`runtimeChange.${key}`,...values);
export function AgentRuntimeSettings({name,inst,disabled=false,inherited=null,onChanged}){
 const [open,setOpen]=useState(false);
 return html`<section class="agent-runtime-settings"><div><span class="note">${text("current")}</span><p><${CliProductMark} id=${inst.backend} size=${20}/><strong>${inst.runtime==="windows"?(inst.machine_name||inst.machine_id||tr("windows")):tr("wsl")}</strong><span class=${removedBackendReplacement(inst.backend)?"agent-runtime-removed":undefined}>· ${removedBackendReplacement(inst.backend)?t("settings.backendUnavailable",inst.backend):cliLabel(inst.backend)}</span></p>${inherited}</div><button type="button" class="btn btn-sm" disabled=${disabled} title=${disabled?text("dirty"):undefined} onClick=${()=>setOpen(true)}>${text("change")}</button>${open?html`<${AgentRuntimeChangeDialog} name=${name} inst=${inst} onClose=${()=>setOpen(false)} onChanged=${onChanged}/>`:null}</section>`;
}
export function AgentRuntimeChangeDialog({name,inst,onClose,onChanged}){
 const lease=useLease(`runtime-change:${name}`),claim=useRef(false);
 const {windowsCli}=useStore(appStore),machinesState=useRuntimeCatalog(),rows=useBackendRows();
 const [source,setSource]=useState(null),[step,setStep]=useState(1),[error,setError]=useState(""),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const [f,setForm]=useState({runtime:inst.runtime==="windows"?"windows":"wsl",machineId:inst.machine_id||"",backend:inst.backend||"",directory:inst.working_directory||"",model:inst.model||"",sandbox:inst.native_sandbox||"read-only",adapter:inst.native_adapter||"exec",fresh:false});
 const local=useWindowsCliCatalog(windowsCli===true&&f.runtime==="windows"&&!f.machineId),machines=machinesState.data?.machines||[],machine=machines.find(row=>row.id===f.machineId);
 const windows=f.runtime==="windows",inventory=f.machineId?machine?.inventory:local.data;
 const native=windows?(f.machineId?runtimeCliChoices(machine):inventory?.clis||[]).filter(cli=>cli.path&&cli.supports?.execution!==false&&cli.supports?.resume!==false):[];
 const choices=windows?native.map(cli=>({value:cli.id,label:cliLabel(cli.id),disabled:!cli.runnable||source?.general&&!['codex','claude-code'].includes(cli.id)})): (rows||[]).filter(row=>row.installed!==false).map(row=>({value:row.name,label:cliLabel(row.name),disabled:["not_installed","not_signed_in","too_old"].includes(source?.runtime==="wsl"&&source.backend===row.name?(source.backendState||row.state):row.state)}));
 const selected=native.find(cli=>cli.id===f.backend),targetReady=!!choices.find(choice=>choice.value===f.backend&&!choice.disabled)&&(!f.machineId||machine?.status==="online");
 const allowedRead=!windows||selected?.readOnlySupport!==false;
 const set=(key,value)=>setForm(old=>({...old,[key]:value}));
 const load=async()=>{
  if(claim.current)return;setSource(null);setError("");
  try{const response=await lease.fetch(`/ui/instances/${encodeURIComponent(name)}/runtime`),value=await response.json();if(!lease.current())return;if(!response.ok)throw Error(value.error||text("failed"));
   setSource(value);setUncertain(false);setStep(1);setForm({runtime:value.runtime,machineId:value.machineId||"",backend:value.backend||inst.backend||"",directory:value.directory||"",model:value.model||"",sandbox:value.sandbox,adapter:value.adapter,fresh:false});
  }catch(e){if(lease.current())setError(e.message);}
 };
 useEffect(()=>{void load();},[lease]);
 const choose=(runtime,machineId="")=>setForm(old=>({...old,runtime,machineId,backend:"",model:"",directory:runtime===source?.runtime&&machineId===(source?.machineId||"")?source.directory:"",sandbox:"read-only",adapter:source?.general&&runtime==="windows"?"pane":"exec",fresh:false}));
 useEffect(()=>{if(!f.backend&&choices.some(choice=>!choice.disabled))set("backend",choices.find(choice=>!choice.disabled).value);},[f.runtime,f.machineId,f.backend,choices.map(choice=>`${choice.value}:${choice.disabled}`).join(",")]);
 const submit=async()=>{
  if(claim.current||uncertain||!source||!f.fresh||!targetReady||(!allowedRead&&f.sandbox==="read-only"))return;
  claim.current=true;setBusy(true);setError("");
  const body={requestId:crypto.randomUUID(),expectedRevision:source.revision,runtime:f.runtime,...(f.machineId?{machineId:f.machineId}:{}),backend:f.backend,model:f.model.trim(),directory:f.directory.trim(),sandbox:f.sandbox,adapter:windows?f.adapter:"exec",startNewConversation:true};
  try{const response=await lease.fetch(`/ui/instances/${encodeURIComponent(name)}/runtime`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),value=await response.json();if(!lease.current())return;
   if(!response.ok||value?.ok!==true)throw Error(value.error||text("failed"));onChanged?.();onClose();
  }catch(e){if(lease.current()){setError(e.message);setUncertain(true);}}
  finally{claim.current=false;if(lease.current())setBusy(false);}
 };
 const close=()=>{if(!claim.current)onClose();};
 return html`<${Dialog} title=${text("title")} cls="agent-runtime-change-dialog" busy=${busy} onClose=${close} wide=${true} actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${close}>${text("cancel")}</button>${step===2?html`<button type="button" class="btn" disabled=${busy||uncertain} onClick=${()=>setStep(1)}>${text("back")}</button>`:null}<button type="button" class="btn btn-primary" disabled=${busy||uncertain||!source||!targetReady||(step===2&&(!f.fresh||!allowedRead&&f.sandbox==="read-only"))} onClick=${step===1?()=>setStep(2):submit}>${text(step===1?"next":"apply")}</button>`}>
  <div class="form agent-runtime-change" aria-busy=${busy}><p>${text("lead")}</p>${!source?html`<p role="status">${text("loading")}</p>`:null}
  ${source&&step===1?html`<${RuntimePicker} value=${f.runtime} onChange=${runtime=>choose(runtime)} windowsEnabled=${windowsCli===true} machineId=${f.machineId} machines=${machines} onMachineChange=${id=>choose("windows",id)}/><div class="field"><label>${tr("backend")}</label><${CliPicker} value=${f.backend} choices=${choices} label=${tr("backend")} onChange=${backend=>setForm(old=>({...old,backend,model:"",fresh:false}))}/></div>${removedBackendReplacement(f.backend)?html`<p class="note" role="status">${text("removed",f.backend,removedBackendReplacement(f.backend))}</p>`:null}${!choices.length?html`<p class="note">${text("noCli")}</p>`:null}`:null}
  ${source&&step===2?html`<h3>${text("configure")}</h3><p><strong>${machine?.name||(windows?tr("windows"):tr("wsl"))}</strong> · ${cliLabel(f.backend)}</p><label class="field"><span>${tr("directory")}</span><input value=${f.directory} disabled=${busy||uncertain} onInput=${event=>set("directory",event.target.value)}/></label><p class="note">${text("directoryHint")}</p><div class="field"><label for="runtime-change-model">${t("settings.model")}</label><${ModelSelect} id="runtime-change-model" disabled=${busy||uncertain} value=${f.model} onChange=${value=>set("model",value)} backend=${f.backend} instance=${!windows&&source.runtime==="wsl"&&source.backend===f.backend?name:undefined} runtime=${f.runtime} machineId=${f.machineId} inherit=${t("settings.modelCliDefault")}/></div>
  ${windows?html`<label class="field"><span>${tr("access")}</span><select value=${f.sandbox} disabled=${busy||uncertain} onChange=${event=>set("sandbox",event.target.value)}><option value="read-only" disabled=${!allowedRead}>${tr("read")}</option><option value="workspace-write">${tr("write")}</option></select></label>${!allowedRead?html`<p class="note" role="status">${tr("noReadOnly")}</p>`:null}<label class="field"><span>${tr("adapter")}</span><select value=${f.adapter} disabled=${busy||uncertain||source.general} onChange=${event=>set("adapter",event.target.value)}><option value="exec">${tr("adapterExec")}</option><option value="pane" disabled=${!["codex","claude-code"].includes(f.backend)}>${tr("adapterPane")}</option></select></label>`:null}
  <p class="note">${text("freshHint")}</p><p class="note">${text("stopped")}</p><label class="check"><input type="checkbox" checked=${f.fresh} disabled=${busy||uncertain} onChange=${event=>set("fresh",event.target.checked)}/><span>${text("fresh")}</span></label>`:null}
  ${busy?html`<p role="status"><span class="out-spin" aria-hidden="true"></span> ${text("busy")}</p>`:null}${error?html`<p class="feedback error" role="alert">${error}</p>`:null}${uncertain?html`<p class="note">${text("unknown")}</p><button type="button" class="btn" onClick=${load}>${text("reload")}</button>`:null}</div>
 </${Dialog}>`;
}
