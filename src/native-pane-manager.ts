import { t } from "./locale.js";
import { loadGeneralKnowledge } from "./runtime-general-workspace.js";
import { generalWorkspaceUpgrade, validateGeneralWorkspaceReceipt } from "./runtime-general-protocol.js";
import { NativePaneRecoveryError } from "./native-pane-recovery.js";
/** Fleet-owned native launch registry. No process IDs, credentials or provider paths cross this boundary. */
import {lstatSync,readFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {atomicWriteFileSync} from "./atomic-write.js";
import {runtimeJobDigest} from "./runtime-client-store.js";
import {RuntimeNativePaneLifecycle} from "./native-pane-lifecycle.js";
import {assertAuditedNativePaneVersion} from "./runtime-pane-native.js";
import {PaneMcpAuthorityLease} from "./runtime-pane-mcp.js";
import {validateRuntimePaneLaunch,validateRuntimePaneSnapshot,validateRuntimePaneSessionProof,type RuntimePaneLaunch,type RuntimePaneSnapshot} from "./runtime-pane-protocol.js";
import {validatePaneMcpBody,type PaneMcpBody} from "./runtime-pane-mcp-protocol.js";
import type {PaneEndpoint} from "./runtime-pane-port.js";
import type {WindowsAgent,WindowsAgents} from "./windows-agents.js";
import type {InstanceConfig} from "./types.js";
import type {Daemon} from "./daemon.js";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
interface Manifest {version:1;machineId:string;configuration:string;launch:RuntimePaneLaunch;exited?:RuntimePaneSnapshot;
 /** Committed before replacing the pin; retained until this replacement has a real saved transcript. */
 fresh?:{previous:RuntimePaneSnapshot;automatic:boolean;announced?:true;previousLaunch?:RuntimePaneLaunch;sessionId?:string;decisionLaunchId?:string}}
export interface NativeMachineEndpoint extends PaneEndpoint {epoch():string|null; version(provider:string):string|null}
export interface NativePaneManagerOptions {
 home:string;
 store:WindowsAgents;
 config(name:string):InstanceConfig|undefined;
 endpoint(agent:WindowsAgent,cleanup?:boolean):Promise<NativeMachineEndpoint>;
 admit(name:string,config:InstanceConfig):void;
 instructions(name:string,config:InstanceConfig):string;
 menu(name:string):Array<{name:string;[key:string]:unknown}>;
 allowed(name:string,tool:string,args:Record<string,unknown>):boolean;
 published(name:string,daemon:Daemon):boolean;
 freshNotice?(name:string,provider?:"codex"|"claude-code"):Promise<void>|void;
 invoke(daemon:Daemon,input:{tool:string;args:Record<string,unknown>;operationId:string},current:()=>boolean,name:string):Promise<{result:unknown;error?:string}>;
}
interface Binding {native:RuntimeNativePaneLifecycle;lease:PaneMcpAuthorityLease;bind(daemon:Daemon):void}
export class NativePaneManager {
 private bindings=new Map<string,Binding>();
 private preparing=new Set<string>();
 constructor(private options:NativePaneManagerOptions){}
 private directory(id:string):string {
  if(!UUID.test(id))throw Error("Invalid native agent identity");
  const root=join(this.options.home,"native-panes");mkdirSync(root,{recursive:true,mode:0o700});
  const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||process.getuid&&(stat.uid!==process.getuid()||!!(stat.mode&0o077)))throw Error("Unsafe native pane registry");
  const directory=join(root,id);mkdirSync(directory,{recursive:true,mode:0o700});const own=lstatSync(directory);
  if(!own.isDirectory()||own.isSymbolicLink()||process.getuid&&(own.uid!==process.getuid()||!!(own.mode&0o077)))throw Error("Unsafe native pane registry");return directory;
 }
 private load(file:string):Manifest|null {
  try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024||process.getuid&&(stat.uid!==process.getuid()||!!(stat.mode&0o077)))throw Error("Unsafe native launch manifest");
   const value=JSON.parse(readFileSync(file,"utf8")) as Manifest;
   if(value?.version!==1||!/^([a-f0-9]{64})$/.test(value.configuration)||Object.keys(value).some(key=>!["version","machineId","configuration","launch","exited","fresh"].includes(key))||value.machineId!=="local"&&!UUID.test(value.machineId))throw Error("Invalid native launch manifest");validateRuntimePaneLaunch(value.launch);if(!value.launch.launchId||!UUID.test(value.launch.launchId))throw Error("Native launch identity is missing");
   if(value.exited){const exit=validateRuntimePaneSnapshot(value.exited);if(exit.state!=="exited"||exit.agentId!==value.launch.agentId||exit.instance!==value.launch.instance||exit.paneId!==value.launch.paneId||exit.launchId!==value.launch.launchId)throw Error("Native exit manifest scope differs");}
   if(value.fresh){const fresh=value.fresh,previous=validateRuntimePaneSnapshot(fresh.previous);
    if(Object.keys(fresh).some(key=>!["previous","automatic","announced","previousLaunch","sessionId","decisionLaunchId"].includes(key))||typeof fresh.automatic!=="boolean"||fresh.announced!==undefined&&fresh.announced!==true
     ||!["claude-code","codex"].includes(value.launch.cli)||value.launch.sessionId!==undefined||previous.state!=="exited"||previous.noLaunch||!previous.sessionId&&(value.launch.cli!=="codex"||fresh.automatic)
     ||previous.agentId!==value.launch.agentId||previous.instance!==value.launch.instance||previous.launchId===value.launch.launchId||previous.sessionId===value.launch.launchId)throw Error("Invalid fresh pane intent");
    if(value.launch.cli==="codex"){
     const old=validateRuntimePaneLaunch(fresh.previousLaunch);
     if(old.cli!=="codex"||old.agentId!==previous.agentId||old.instance!==previous.instance||old.paneId!==previous.paneId||old.launchId!==previous.launchId
       ||(typeof fresh.decisionLaunchId!=="string"||!UUID.test(fresh.decisionLaunchId)||fresh.decisionLaunchId===value.launch.launchId)
       ||fresh.sessionId!==undefined&&(typeof fresh.sessionId!=="string"||!UUID.test(fresh.sessionId)||fresh.sessionId===previous.sessionId))throw Error("Invalid fresh Codex binding");
    }else if(fresh.previousLaunch!==undefined||fresh.sessionId!==undefined||fresh.decisionLaunchId!==undefined)throw Error("Unexpected Claude fresh binding");}
   return value;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
 }
 private save(file:string,value:Manifest):void{atomicWriteFileSync(file,JSON.stringify(value),{mode:0o600});}
 private configurationHash(agent:WindowsAgent,config:InstanceConfig):string{
  return runtimeJobDigest({cli:agent.cli,cwd:agent.cwd,sandbox:config.native_sandbox,model:config.model||"",prompt:config.systemPrompt||"",workflow:config.workflow??null,
   ...(config.general_topic?{general:true,binding:config.native_general_binding}: {})});
 }
 private newManifest(name:string,config:InstanceConfig,agent:WindowsAgent,machineId:string,resume=true,identity?:Pick<RuntimePaneLaunch,"paneId"|"launchId">):Manifest{
  const launch=validateRuntimePaneLaunch({cli:agent.cli,cwd:agent.cwd,sandbox:config.native_sandbox,instructions:this.options.instructions(name,config),
   ...(config.model?{model:config.model}:{}),agentId:agent.id,instance:name,paneId:identity?.paneId??randomUUID(),launchId:identity?.launchId??randomUUID(),
   columns:120,rows:40,...(resume&&agent.threadId?{sessionId:agent.threadId}:{}),mcpTools:this.options.menu(name).map(tool=>tool.name),
   ...(config.general_topic?{generalWorkspace:{bindingId:config.native_general_binding,packHash:loadGeneralKnowledge(agent.cli as "codex"|"claude-code").hash}}: {})});
  return {version:1,machineId,configuration:this.configurationHash(agent,config),launch};
 }
 private freshIntent(file:string,manifest:Manifest,automatic:boolean,config:InstanceConfig,agent:WindowsAgent):Manifest{
  const previous=manifest.exited?.sessionId?manifest.exited:manifest.launch.cli==="codex"?manifest.fresh?.previous??manifest.exited:undefined;
  const previousLaunch=manifest.exited?.sessionId?manifest.launch:manifest.fresh?.previousLaunch??manifest.launch;
  if(!previous||!previous.sessionId&&(agent.cli!=="codex"||automatic)||!manifest.exited||!["claude-code","codex"].includes(manifest.launch.cli))throw Error("A fresh conversation requires its previous positive exit");
  // The previous launch can have obsolete cold settings; only its positive exit is carried into this decision.
  const next:Manifest={...this.newManifest(manifest.launch.instance,config,agent,manifest.machineId,false),fresh:{previous,automatic,...(agent.cli==="codex"?{previousLaunch,decisionLaunchId:manifest.launch.launchId}: {})}};
  this.save(file,next);return next;
 }
 private bindFreshCodex(file:string,manifest:Manifest,observed:RuntimePaneSnapshot):Manifest{
  const fresh=manifest.fresh,launch=manifest.launch;
  if(launch.cli!=="codex"||!fresh||!observed.sessionId||observed.sessionId===fresh.previous.sessionId
    ||observed.launchId!==launch.launchId||observed.paneId!==launch.paneId||observed.agentId!==launch.agentId||observed.instance!==launch.instance
    ||fresh.sessionId!==undefined&&fresh.sessionId!==observed.sessionId)throw Error("Fresh Codex observed identity differs");
  const next={...manifest,fresh:{...fresh,sessionId:observed.sessionId}};this.save(file,next);
  this.options.store.pinFreshCodexSession(launch.agentId,fresh.previous,observed);return next;
 }
 private recordExit(file:string,manifest:Manifest,snapshot:RuntimePaneSnapshot):Manifest{
  if(manifest.launch.cli==="codex"&&manifest.fresh?.sessionId&&snapshot.sessionId!==undefined&&snapshot.sessionId!==manifest.fresh.sessionId)throw Error("Fresh Codex exit conversation differs");
  let next=manifest;
  if(manifest.launch.cli==="codex"&&manifest.fresh&&snapshot.sessionId&&snapshot.sessionId!==manifest.fresh.previous.sessionId
    &&this.options.store.get(snapshot.agentId).threadId!==snapshot.sessionId)next=this.bindFreshCodex(file,manifest,snapshot);
  next={...next,exited:snapshot};this.save(file,next);
  const profile=this.options.store.get(snapshot.agentId);
  if(!snapshot.noLaunch&&!profile.threadId&&snapshot.sessionId&&profile.activeId)this.options.store.pinPaneSession(snapshot.agentId,snapshot.launchId,snapshot.sessionId);
  if(this.options.store.get(snapshot.agentId).activeId){
   if(!snapshot.noLaunch&&next.launch.cli==="codex"&&next.fresh?.previous.sessionId&&!snapshot.sessionId)this.options.store.releaseUnpinnedCodexPane(snapshot.agentId,next.fresh.previous,snapshot);
   else this.options.store.releasePane(snapshot.agentId,snapshot);
  }
  if(!snapshot.noLaunch&&(!snapshot.sessionId||!profile.threadId))this.options.store.setPaneRecovery(snapshot.agentId,{kind:"session-unconfirmed",launchId:snapshot.launchId,sessionId:this.options.store.get(snapshot.agentId).threadId,...(next.launch.cli==="codex"?{provider:"codex" as const}:{})});
  return next;
 }
 private async sessionState(endpoint:NativeMachineEndpoint,previous:RuntimePaneSnapshot,supported:boolean):Promise<"absent"|"saved"|"unknown">{
  if(!previous.sessionId)return "unknown"; // A positive process exit is independent of a provider conversation pin.
  if(!supported)throw new NativePaneRecoveryError({kind:"host-upgrade",launchId:previous.launchId}); // Use the existing host-upgrade recovery, never a conversation decision.
  const raw=await endpoint.call({action:"session-proof",paneId:previous.paneId,launchId:previous.launchId});
  try{const proof=validateRuntimePaneSessionProof(raw);if(runtimeJobDigest(proof.snapshot)===runtimeJobDigest(previous))return proof.state;}
  catch{/* A reachable malformed result cannot prove absence. */}
  return "unknown";
 }
 /** Prepare metadata and helper authority first; acquire() alone may reserve and spawn. */
 async prepare(name:string,config:InstanceConfig,assertCurrent:()=>void):Promise<RuntimeNativePaneLifecycle> {
  const id=config.native_agent_id;if(!id||!UUID.test(id)||this.preparing.has(id))throw Error("Native pane preparation already has an owner or lacks an identity");
  this.preparing.add(id);try{return await this.prepareOwned(name,config,assertCurrent);}catch(error){if(error instanceof NativePaneRecoveryError){assertCurrent();this.options.store.setPaneRecovery(id,error.recovery);}throw error;}finally{this.preparing.delete(id);}
 }
 private async prepareOwned(name:string,config:InstanceConfig,assertCurrent:()=>void):Promise<RuntimeNativePaneLifecycle> {
  config=structuredClone(config);
  assertCurrent();this.options.admit(name,config);
  const id=config.native_agent_id;if(!id||!UUID.test(id))throw Error("Native pane profile is missing");
  let agent=this.options.store.get(id);if(agent.fleet_instance!==name||agent.machineId!==config.machine_id||agent.cli!==config.backend||agent.cwd!==config.working_directory)throw Error("Native pane profile scope differs");
  if(config.general_topic&&(!agent.machineId||!UUID.test(config.native_general_binding??"")))throw Error("Windows General requires its prepared paired-machine binding");
  const directory=this.directory(id),file=join(directory,"active.json");let manifest=this.load(file);
  if(manifest&&(manifest.launch.agentId!==id||manifest.launch.instance!==name||manifest.machineId!==(agent.machineId??"local")))throw Error("Native launch manifest scope differs");
  if(this.bindings.has(id))throw Error("Native pane still has a coordinator owner");
  const missingSession=()=>new NativePaneRecoveryError({kind:"session-unconfirmed",launchId:manifest!.launch.launchId,sessionId:agent.threadId,...(agent.cli==="codex"?{provider:"codex" as const}:{})});
  const endpoint=await this.options.endpoint(agent);
  assertCurrent();this.options.admit(name,config);
  if(endpoint.machineId!==(agent.machineId??"local"))throw Error("Native endpoint machine scope differs");
  assertAuditedNativePaneVersion(agent.cli,endpoint.version(agent.cli));
  const inventory:unknown=await endpoint.call({action:"list"});
  assertCurrent();this.options.admit(name,config);
  if(!inventory||typeof inventory!=="object"||!UUID.test((inventory as any).hostBootId)||!Array.isArray((inventory as any).panes)||(inventory as any).panes.length>4096)throw Error("Native host identity is unconfirmed");
  const latest=this.options.store.get(id);
  if(runtimeJobDigest({id:latest.id,cli:latest.cli,cwd:latest.cwd,machineId:latest.machineId,activeId:latest.activeId,paneLaunchId:latest.paneLaunchId,threadId:latest.threadId,paused:latest.paused})!==runtimeJobDigest({id:agent.id,cli:agent.cli,cwd:agent.cwd,machineId:agent.machineId,activeId:agent.activeId,paneLaunchId:agent.paneLaunchId,threadId:agent.threadId,paused:agent.paused}))throw Error("Native profile changed during host observation");
  const hostBootId=(inventory as any).hostBootId as string,panes=((inventory as any).panes as unknown[]).map(validateRuntimePaneSnapshot);
  if ((inventory as any).capabilities?.openDisposition !== true) throw new NativePaneRecoveryError({kind:"host-upgrade",...(manifest?{launchId:manifest.launch.launchId}: {})});
  if(config.general_topic&&(inventory as any).capabilities?.generalWorkspace!==true)throw new NativePaneRecoveryError({kind:"host-upgrade",...(manifest?{launchId:manifest.launch.launchId}: {})});
  const sameAgent=panes.filter(row=>row.agentId===id&&row.state!=="exited");
  if(sameAgent.length>1||sameAgent.some(row=>!manifest||row.paneId!==manifest.launch.paneId||row.launchId!==manifest.launch.launchId||row.instance!==name))throw Error("Another live or unknown native pane must be reconciled first");
  let preparedFresh=false;
  if(manifest&&!manifest.exited&&!agent.activeId&&!panes.some(row=>row.paneId===manifest!.launch.paneId)){
   // Factory metadata alone is not an open: reserve() and the pane receipt precede every RPC which may spawn.
   try{lstatSync(join(directory,`${manifest.launch.launchId}.pane.json`));}
   catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;if(manifest.fresh)preparedFresh=true;else manifest=null;}
  }
  if(manifest&&!manifest.exited&&!preparedFresh){
   const matches=panes.filter(row=>row.paneId===manifest!.launch.paneId);
   if(matches.length>1)throw Error("Native host returned duplicate retained panes");
   const ended=matches[0],old=manifest.launch;
   if(ended?.state==="exited"){
    const session=agent.threadId??old.sessionId??ended.sessionId??(old.cli==="claude-code"?old.launchId:undefined);
    if(manifest.fresh&&agent.cli==="codex"&&ended.sessionId&&ended.sessionId!==manifest.fresh.previous.sessionId){
     manifest=this.bindFreshCodex(file,manifest,ended);agent=this.options.store.get(id);
    }
    const pendingCodex=agent.cli==="codex"&&manifest.fresh&&!manifest.fresh.sessionId&&agent.threadId===manifest.fresh.previous.sessionId&&!ended.sessionId;
    if(ended.agentId!==id||ended.instance!==name||ended.launchId!==old.launchId||session!==undefined&&ended.sessionId!==session&&!pendingCodex&&agent.threadId!==ended.sessionId)throw Error("Native retained exit scope differs");
    // The host reconciles exact helper exits before listing. Persist its positive evidence before releasing the slot.
    manifest={...manifest,exited:ended};this.save(file,manifest);
   } else if (!ended || ended.state === "unknown" || ended.hostBootId !== hostBootId) {
    throw new NativePaneRecoveryError({kind:"exit-unconfirmed",launchId:old.launchId,...(ended?{hostBootId:ended.hostBootId}:{})});
   }
  }
  if(manifest?.exited){
   if(!manifest.exited.noLaunch&&!manifest.exited.sessionId){
    // The process is positively gone even if it exited before reporting its first provider UUID.
    manifest=this.recordExit(file,manifest,manifest.exited);agent=this.options.store.get(id);
    throw missingSession();
   }
   if(!manifest.exited.noLaunch&&manifest.exited.sessionId&&!agent.threadId&&agent.activeId){
    this.options.store.pinPaneSession(id,manifest.exited.launchId,manifest.exited.sessionId);agent=this.options.store.get(id);
   }
   if(!manifest.exited.noLaunch&&!agent.threadId)throw new NativePaneRecoveryError({kind:"exit-unconfirmed",launchId:manifest.launch.launchId,hostBootId:manifest.exited.hostBootId});
   if(agent.activeId){this.options.store.releasePane(id,manifest.exited);agent=this.options.store.get(id);}
   if(!manifest.exited.noLaunch){
    const epoch=endpoint.epoch(),before=runtimeJobDigest(agent);
    // RPC failures stay retryable; only a reachable result can hold the session. Older hosts use the upgrade hold.
    const state=await this.sessionState(endpoint,manifest.exited,(inventory as any).capabilities?.[agent.cli==="codex"?"codexSessionProof":"claudeSessionProof"]===true);
    assertCurrent();this.options.admit(name,config);
    if(!endpoint.online()||endpoint.epoch()!==epoch||runtimeJobDigest(this.options.store.get(id))!==before)throw Error("Native profile or transport changed during session proof");
    if(state==="absent"&&!manifest.fresh){manifest=this.freshIntent(file,manifest,true,config,agent);preparedFresh=true;}
    else if(state!=="saved")throw missingSession();
    else manifest=null;
   }else if(manifest.fresh)throw missingSession();else manifest=null;
  }
  if(preparedFresh&&manifest?.fresh){
   // No open receipt/reservation exists: refresh the unlaunched intent's settings, retaining its chosen UUIDs.
   const current=this.newManifest(name,config,agent,manifest.machineId,false,manifest.launch);
   const refreshed={...manifest,configuration:current.configuration,launch:current.launch};
   if(runtimeJobDigest(refreshed)!==runtimeJobDigest(manifest))this.save(file,refreshed);
   manifest=refreshed;if(agent.cli==="claude-code")this.options.store.replacePaneSession(id,manifest.fresh!.previous,manifest.launch.launchId!);agent=this.options.store.get(id);
  }
  // Hot identity metadata and bundled instruction-template edits do not retire a live pane on coordinator update.
  const configurationHash=this.configurationHash(agent,config);
  if(config.general_topic&&(!manifest||preparedFresh)){
   const request={action:"general-workspace" as const,bindingId:config.native_general_binding!,instance:name,cli:agent.cli as "codex"|"claude-code",packHash:loadGeneralKnowledge(agent.cli as "codex"|"claude-code").hash};
   const epoch=endpoint.epoch(),before=runtimeJobDigest(agent),raw=await endpoint.call(request);
   assertCurrent();this.options.admit(name,config);
   if(!endpoint.online()||endpoint.epoch()!==epoch||runtimeJobDigest(this.options.store.get(id))!==before)throw Error("General profile or transport changed during workspace preparation");
   if(generalWorkspaceUpgrade(raw,request))throw new NativePaneRecoveryError({kind:"host-upgrade"});
   if(validateGeneralWorkspaceReceipt(raw,request).cwd.toLowerCase()!==agent.cwd.toLowerCase())throw Error("General workspace does not match its retained profile");
  }
  if(manifest){
   const old=manifest.launch;
   if(manifest.configuration!==configurationHash)throw Error("Retained native launch settings differ; close its owned pane before applying changes");
   if(agent.activeId&&agent.paneLaunchId!==old.launchId)throw Error("Native profile has a different active owner");
  }else{
   if(agent.activeId)throw Error("Native profile outcome is unknown; no replacement was started");
   manifest=this.newManifest(name,config,agent,endpoint.machineId);this.save(file,manifest);
  }
  let retained=manifest;const launch=retained.launch;
  let daemon:Daemon|undefined,binding:Binding,closed=false;
  const current=():boolean=>{
   if(closed||!endpoint.online()||this.bindings.get(id)!==binding)return false;
   const observed=binding.native.snapshot();if(observed?.state==="unknown"||observed?.state==="exited")return false;
   try{if(!daemon||!this.options.published(name,daemon))assertCurrent();this.options.admit(name,config);const now=this.options.config(name),profile=this.options.store.get(id);
    return !!now&&now.native_adapter==="pane"&&now.native_agent_id===id&&now.machine_id===agent.machineId&&now.backend===launch.cli&&now.working_directory===launch.cwd&&(now.model||undefined)===launch.model&&now.native_sandbox===launch.sandbox
     &&profile.paneLaunchId===launch.launchId&&profile.activeId===launch.launchId&&!profile.paused;
   }catch{return false;}
  };
  const owned=()=>!!daemon&&current()&&this.options.published(name,daemon);
  const lease=new PaneMcpAuthorityLease(join(directory,`${launch.launchId}.mcp.json`),{
   machineId:endpoint.machineId,owner:{hostBootId,paneId:launch.paneId,launchId:launch.launchId!,agentId:id,instance:name},current,transportEpoch:()=>endpoint.epoch(),
   menu:()=>this.options.menu(name),allowed:(tool,args)=>current()&&this.options.allowed(name,tool,args),
   invoke:(input,proof)=>{if(!owned()||!proof())throw Error("Native daemon is not published");return this.options.invoke(daemon!,input,()=>owned()&&proof(),name);},
   responseWritten:operationId=>daemon?.paneToolResponseWritten(operationId,owned),
  });
  const native:RuntimeNativePaneLifecycle=new RuntimeNativePaneLifecycle({endpoint,launch,receiptFile:join(directory,`${launch.launchId}.pane.json`),...(launch.cli==="codex"&&retained.fresh?{freshPrevious:retained.fresh.previous}:{}),
   admit:()=>{assertCurrent();this.options.admit(name,config);},reserve:launchId=>{this.options.store.reservePane(id,launchId);},pin:(launchId,sessionId)=>{
    if(launch.cli==="codex"&&retained.fresh){const observed=native.port.ownedSnapshot();if(!observed||observed.launchId!==launchId||observed.sessionId!==sessionId)throw Error("Fresh Codex observation differs");retained=this.bindFreshCodex(file,retained,observed);}
    else this.options.store.pinPaneSession(id,launchId,sessionId);
   },
   exited:snapshot=>{retained=this.recordExit(file,retained,snapshot);},mcpProof:()=>lease.serving()?"alive":"unknown",
   bindDaemon:value=>binding.bind(value),acquired:async()=>{
    this.options.store.setPaneRecovery(id,undefined);
    if(retained.fresh&&!retained.fresh.announced){retained={...retained,fresh:{...retained.fresh,announced:true}};this.save(file,retained);if(retained.fresh!.automatic)await this.options.freshNotice?.(name,launch.cli);}
   },
   releaseAuthority:()=>{closed=true;lease.close();if(this.bindings.get(id)===binding)this.bindings.delete(id);},
  });
  const snapshot=native.port.ownedSnapshot();
  if(agent.threadId&&snapshot?.sessionId!==agent.threadId&&launch.sessionId!==agent.threadId
   &&!(retained.fresh&&(launch.cli==="codex"?retained.fresh.previous.sessionId===agent.threadId:launch.launchId===agent.threadId)))throw Error("Native profile conversation pin differs from its launch receipt");
  binding={native,lease,bind:value=>{if(daemon&&daemon!==value)throw Error("Native daemon binding changed");daemon=value;}};this.bindings.set(id,binding);
  return native;
 }
 /** Administrator chooses a new conversation for this exact stopped, held pin. No provider files are changed. */
 async startFresh(name:string,config:InstanceConfig,launchId:string,sessionId:string|null,assertCurrent:()=>void):Promise<void>{
  config=structuredClone(config);
  const id=config.native_agent_id;if(!id||this.preparing.has(id)||this.bindings.has(id))throw Error("Native pane preparation still has an owner");
  this.preparing.add(id);try{
   assertCurrent();this.options.admit(name,config);const agent=this.options.store.get(id),file=join(this.directory(id),"active.json"),manifest=this.load(file);
   // A replay consumes its already-committed UUID only after the original decision's proof is rechecked.
   const replay=!!(manifest?.fresh&&!manifest.exited&&!manifest.fresh.announced&&(manifest.fresh.decisionLaunchId??manifest.fresh.previous.launchId)===launchId&&(manifest.fresh.previous.sessionId??null)===sessionId);
   const previous=replay?manifest!.fresh!.previous:manifest?.exited?.sessionId?manifest.exited:manifest?.fresh?.previous??manifest?.exited;
   const targetLaunchId=replay?(manifest!.fresh!.decisionLaunchId??previous?.launchId):manifest?.exited?.launchId;
   if(!manifest||!previous||!["claude-code","codex"].includes(manifest.launch.cli)||targetLaunchId!==launchId||(previous.sessionId??null)!==sessionId||(agent.threadId??null)!==sessionId
    ||agent.activeId||agent.paneLaunchId||agent.fleet_instance!==name||agent.cwd!==config.working_directory||agent.cli!==config.backend||agent.machineId!==config.machine_id
    ||manifest.machineId!==(agent.machineId??"local")||manifest.launch.instance!==name||manifest.launch.agentId!==id
    ||agent.paneRecovery?.kind!=="session-unconfirmed"||agent.paneRecovery.launchId!==launchId||(agent.paneRecovery.sessionId??null)!==sessionId)throw Error(t("native_pane.changed"));
   const unopened=()=>{if(!replay)return;try{lstatSync(join(this.directory(id),`${manifest.launch.launchId}.pane.json`));throw Error("Fresh pane launch outcome is unconfirmed");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}};
   unopened();const endpoint=await this.options.endpoint(agent);assertCurrent();this.options.admit(name,config);
   if(endpoint.machineId!==manifest.machineId)throw Error("Native fresh-session machine differs");
   assertAuditedNativePaneVersion(agent.cli,endpoint.version(agent.cli));const epoch=endpoint.epoch();
   const raw=await endpoint.call({action:"list"});assertCurrent();this.options.admit(name,config);
   if(!endpoint.online()||endpoint.epoch()!==epoch)throw Error("Native fresh-session transport changed");
   if(!raw||typeof raw!=="object"||!Array.isArray((raw as any).panes)||(raw as any).panes.map(validateRuntimePaneSnapshot).some((row:RuntimePaneSnapshot)=>row.agentId===id&&row.state!=="exited"))throw Error("A native process exit is still unconfirmed");
   const state=await this.sessionState(endpoint,previous,(raw as any).capabilities?.[agent.cli==="codex"?"codexSessionProof":"claudeSessionProof"]===true);
   assertCurrent();this.options.admit(name,config);unopened();
   if(!endpoint.online()||endpoint.epoch()!==epoch)throw Error("Native fresh-session transport changed");
   if(runtimeJobDigest(this.options.store.get(id))!==runtimeJobDigest(agent))throw Error(t("native_pane.changed"));
   if(state==="saved"){
    if(replay||previous!==manifest.exited){
     // The unused intent never opened. Return to its exact positive exit; the original per-launch receipt is untouched.
     const prior=this.newManifest(name,config,agent,manifest.machineId,true,previous);
     if(agent.cli==="codex"&&manifest.fresh?.previousLaunch)prior.launch=manifest.fresh.previousLaunch;
     this.save(file,{...prior,exited:previous});
    }
    this.options.store.setPaneRecovery(id,undefined);throw Error(t("native_pane.saved_available"));
   }
   const next=replay?{...manifest,...this.newManifest(name,config,agent,manifest.machineId,false,manifest.launch),fresh:manifest.fresh}
    :this.freshIntent(file,manifest,false,config,agent);
   if(replay)this.save(file,next);if(agent.cli==="claude-code")this.options.store.replacePaneSession(id,previous,next.launch.launchId!);
  }catch(error){if(error instanceof NativePaneRecoveryError){assertCurrent();this.options.store.setPaneRecovery(id,error.recovery);}throw error;}
  finally{this.preparing.delete(id);}
 }
 /** Explicit admin attestation, bound to the held launch; no keys, tool calls or process signals. */
 async recover(name:string,config:InstanceConfig,launchId:string,confirmedStopped:boolean,assertCurrent:()=>void):Promise<void>{
  const id=config.native_agent_id;if(!id||!UUID.test(id)||this.preparing.has(id))throw Error("Native pane preparation is in flight");
  this.preparing.add(id);
  try {
   assertCurrent();this.options.admit(name,config);
   const agent=this.options.store.get(id),file=join(this.directory(id),"active.json"),manifest=this.load(file);
   if(agent.paneRecovery?.kind==="session-unconfirmed")throw Error(t("native_pane.refresh_for_session"));
   if(confirmedStopped!==true||!manifest||manifest.launch.launchId!==launchId||agent.activeId!==launchId||agent.paneLaunchId!==launchId
    ||manifest.launch.agentId!==id||manifest.launch.instance!==name||manifest.machineId!==(agent.machineId??"local")||agent.fleet_instance!==name)throw Error(t("native_pane.changed"));
   const pin=agent.threadId??manifest.launch.sessionId??(manifest.launch.cli==="claude-code"?manifest.launch.launchId:undefined);
   if(!pin)throw Error(t("native_pane.no_pin"));
   const bound=this.bindings.get(id)?.native.port.ownedSnapshot();
   if(bound&&bound.launchId!==launchId)throw Error("Native recovery has another coordinator owner");
   const endpoint=await this.options.endpoint(agent);assertCurrent();this.options.admit(name,config);
   if(endpoint.machineId!==manifest.machineId)throw Error("Native recovery machine differs");
   const raw=await endpoint.call({action:"list"});assertCurrent();this.options.admit(name,config);
   if(!raw||typeof raw!=="object"||!Array.isArray((raw as any).panes)||(raw as any).capabilities?.recovery!==true)throw new NativePaneRecoveryError({kind:"host-upgrade",launchId});
   const rows=((raw as any).panes as unknown[]).map(validateRuntimePaneSnapshot),pane=rows.find(row=>row.paneId===manifest.launch.paneId);
   // A host can die after recording Codex's UUID but before its profile commit. Bind it only AFTER the exact recovered exit.
   const pendingFresh=manifest.launch.cli==="codex"&&manifest.fresh&&agent.threadId===manifest.fresh.previous.sessionId
    &&(pane?.sessionId?pane.sessionId!==pin&&(!manifest.fresh.sessionId||manifest.fresh.sessionId===pane.sessionId):!manifest.fresh.sessionId);
   if(rows.filter(row=>row.paneId===manifest.launch.paneId).length!==1||!pane||pane.launchId!==launchId||pane.agentId!==id||pane.instance!==name
    ||pane.sessionId!==pin&&!pendingFresh||rows.some(row=>row.agentId===id&&row.paneId!==pane.paneId&&row.state!=="exited"))throw Error(t("native_pane.scope"));
   const ended=validateRuntimePaneSnapshot(await endpoint.call({action:"recover",paneId:pane.paneId,launchId,hostBootId:pane.hostBootId,confirmedStopped:true}));
   assertCurrent();this.options.admit(name,config);
   if(ended.state!=="exited"||ended.paneId!==pane.paneId||ended.launchId!==launchId||ended.agentId!==id||ended.instance!==name||ended.hostBootId!==pane.hostBootId
    ||pane.sessionId!==ended.sessionId)throw Error("Native recovery exit scope differs");
   const binding=this.bindings.get(id);
   if(binding)await binding.native.port.recordConfirmedExit(ended,assertCurrent);
   assertCurrent();this.options.admit(name,config);
   this.save(file,{...manifest,exited:ended});
   if(!agent.threadId)this.options.store.pinPaneSession(id,launchId,pin);
   if(!this.bindings.has(id))this.recordExit(file,manifest,ended);
   this.options.store.setPaneRecovery(id,manifest.launch.cli==="codex"&&manifest.fresh&&!ended.sessionId?{kind:"session-unconfirmed",provider:"codex",launchId,sessionId:pin}:undefined);
  } finally {this.preparing.delete(id);}
 }
 /** Close only the retained exact launch. Offline, missing, or unknown exit remains reserved. */
 async closeRetained(name:string,config:InstanceConfig,assertCurrent:()=>void):Promise<void>{
  assertCurrent();const id=config.native_agent_id;if(!id||!UUID.test(id))throw Error("Native close profile is missing");
  const agent=this.options.store.get(id),directory=this.directory(id),file=join(directory,"active.json"),manifest=this.load(file);
  if(agent.fleet_instance!==name||agent.machineId!==config.machine_id)throw Error("Native close profile scope differs");
  const bound=this.bindings.get(id);if(bound){await bound.native.release("close");return;}
  if(!manifest){if(agent.activeId)throw Error("Native close intent is unconfirmed");return;}
  if(manifest.machineId!==(agent.machineId??"local")||manifest.launch.instance!==name||manifest.launch.agentId!==id)throw Error("Native close manifest scope differs");
  if(manifest.exited){if(agent.activeId)this.recordExit(file,manifest,manifest.exited);return;}
  const receiptFile=join(directory,`${manifest.launch.launchId}.pane.json`);
  // No open intent or reservation was ever committed: this prepared factory cannot have started a process.
  try{lstatSync(receiptFile);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;if(!agent.activeId)return;throw Error("Native open intent is missing; its process outcome is unknown");}
  const endpoint=await this.options.endpoint(agent,true);assertCurrent();
  if(endpoint.machineId!==manifest.machineId)throw Error("Native close endpoint differs");
  const native:RuntimeNativePaneLifecycle=new RuntimeNativePaneLifecycle({endpoint,launch:manifest.launch,receiptFile,
   admit:assertCurrent,reserve:()=>{throw Error("Close never reserves a new launch");},pin:()=>{},mcpProof:()=>"unknown",releaseAuthority:()=>{},
   exited:snapshot=>{this.recordExit(file,manifest,snapshot);},
  });
  await native.release("close");
 }
 async handle(machineId:string,raw:PaneMcpBody,transport:()=>boolean):Promise<unknown>{
  const body=validatePaneMcpBody(raw),binding=this.bindings.get(body.owner.agentId);
  if(!binding)throw Error("Native pane tool owner is unavailable");return binding.lease.handle(machineId,body,transport);
 }
}
