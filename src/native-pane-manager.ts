import { t } from "./locale.js";
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
import {validateRuntimePaneLaunch,validateRuntimePaneSnapshot,type RuntimePaneLaunch,type RuntimePaneSnapshot} from "./runtime-pane-protocol.js";
import {validatePaneMcpBody,type PaneMcpBody} from "./runtime-pane-mcp-protocol.js";
import type {PaneEndpoint} from "./runtime-pane-port.js";
import type {WindowsAgent,WindowsAgents} from "./windows-agents.js";
import type {InstanceConfig} from "./types.js";
import type {Daemon} from "./daemon.js";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
interface Manifest {version:1;machineId:string;configuration:string;launch:RuntimePaneLaunch;exited?:RuntimePaneSnapshot}
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
   if(value?.version!==1||!/^([a-f0-9]{64})$/.test(value.configuration)||Object.keys(value).some(key=>!["version","machineId","configuration","launch","exited"].includes(key))||value.machineId!=="local"&&!UUID.test(value.machineId))throw Error("Invalid native launch manifest");validateRuntimePaneLaunch(value.launch);if(!value.launch.launchId||!UUID.test(value.launch.launchId))throw Error("Native launch identity is missing");
   if(value.exited){const exit=validateRuntimePaneSnapshot(value.exited);if(exit.state!=="exited"||exit.agentId!==value.launch.agentId||exit.instance!==value.launch.instance||exit.paneId!==value.launch.paneId||exit.launchId!==value.launch.launchId)throw Error("Native exit manifest scope differs");}
   return value;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
 }
 private save(file:string,value:Manifest):void{atomicWriteFileSync(file,JSON.stringify(value),{mode:0o600});}
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
  const directory=this.directory(id),file=join(directory,"active.json");let manifest=this.load(file);
  if(manifest&&(manifest.launch.agentId!==id||manifest.launch.instance!==name||manifest.machineId!==(agent.machineId??"local")))throw Error("Native launch manifest scope differs");
  if(this.bindings.has(id))throw Error("Native pane still has a coordinator owner");
  const endpoint=await this.options.endpoint(agent);assertCurrent();this.options.admit(name,config);
  if(endpoint.machineId!==(agent.machineId??"local"))throw Error("Native endpoint machine scope differs");
  assertAuditedNativePaneVersion(agent.cli,endpoint.version(agent.cli));
  const inventory=await endpoint.call({action:"list"});assertCurrent();this.options.admit(name,config);
  if(!inventory||typeof inventory!=="object"||!UUID.test((inventory as any).hostBootId)||!Array.isArray((inventory as any).panes)||(inventory as any).panes.length>4096)throw Error("Native host identity is unconfirmed");
  const latest=this.options.store.get(id);
  if(runtimeJobDigest({id:latest.id,cli:latest.cli,cwd:latest.cwd,machineId:latest.machineId,activeId:latest.activeId,paneLaunchId:latest.paneLaunchId,threadId:latest.threadId,paused:latest.paused})!==runtimeJobDigest({id:agent.id,cli:agent.cli,cwd:agent.cwd,machineId:agent.machineId,activeId:agent.activeId,paneLaunchId:agent.paneLaunchId,threadId:agent.threadId,paused:agent.paused}))throw Error("Native profile changed during host observation");
  const hostBootId=(inventory as any).hostBootId as string,panes=((inventory as any).panes as unknown[]).map(validateRuntimePaneSnapshot);
  if ((inventory as any).capabilities?.openDisposition !== true) throw new NativePaneRecoveryError({kind:"host-upgrade",...(manifest?{launchId:manifest.launch.launchId}: {})});
  const sameAgent=panes.filter(row=>row.agentId===id&&row.state!=="exited");
  if(sameAgent.length>1||sameAgent.some(row=>!manifest||row.paneId!==manifest.launch.paneId||row.launchId!==manifest.launch.launchId||row.instance!==name))throw Error("Another live or unknown native pane must be reconciled first");
  if(manifest&&!manifest.exited&&!agent.activeId&&!panes.some(row=>row.paneId===manifest!.launch.paneId)){
   // Factory metadata alone is not an open: reserve() and the pane receipt precede every RPC which may spawn.
   try{lstatSync(join(directory,`${manifest.launch.launchId}.pane.json`));}
   catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;manifest=null;}
  }
  if(manifest&&!manifest.exited){
   const matches=panes.filter(row=>row.paneId===manifest!.launch.paneId);
   if(matches.length>1)throw Error("Native host returned duplicate retained panes");
   const ended=matches[0],old=manifest.launch;
   if(ended?.state==="exited"){
    const session=agent.threadId??old.sessionId??ended.sessionId??(old.cli==="claude-code"?old.launchId:undefined);
    if(ended.agentId!==id||ended.instance!==name||ended.launchId!==old.launchId||session!==undefined&&ended.sessionId!==session)throw Error("Native retained exit scope differs");
    // The host reconciles exact helper exits before listing. Persist its positive evidence before releasing the slot.
    manifest={...manifest,exited:ended};this.save(file,manifest);
   } else if (!ended || ended.state === "unknown" || ended.hostBootId !== hostBootId) {
    throw new NativePaneRecoveryError({kind:"exit-unconfirmed",launchId:old.launchId,...(ended?{hostBootId:ended.hostBootId}:{})});
   }
  }
  if(manifest?.exited){
   if(!manifest.exited.noLaunch&&!manifest.exited.sessionId){
    throw new NativePaneRecoveryError({kind:"exit-unconfirmed",launchId:manifest.launch.launchId,hostBootId:manifest.exited.hostBootId});
   }
   if(!manifest.exited.noLaunch&&manifest.exited.sessionId&&!agent.threadId&&agent.activeId){
    this.options.store.pinPaneSession(id,manifest.exited.launchId,manifest.exited.sessionId);agent=this.options.store.get(id);
   }
   if(!manifest.exited.noLaunch&&!agent.threadId)throw new NativePaneRecoveryError({kind:"exit-unconfirmed",launchId:manifest.launch.launchId,hostBootId:manifest.exited.hostBootId});
   if(agent.activeId){this.options.store.releasePane(id,manifest.exited);agent=this.options.store.get(id);}
   manifest=null;
  }
  const instructions=this.options.instructions(name,config);
  const configuration={cli:agent.cli,cwd:agent.cwd,sandbox:config.native_sandbox,instructions,...(config.model?{model:config.model}:{})};
  // Hot identity metadata and bundled instruction-template edits do not retire a live pane on coordinator update.
  const configurationHash=runtimeJobDigest({cli:agent.cli,cwd:agent.cwd,sandbox:config.native_sandbox,model:config.model||"",prompt:config.systemPrompt||"",workflow:config.workflow??null});
  if(manifest){
   const old=manifest.launch;
   if(manifest.configuration!==configurationHash)throw Error("Retained native launch settings differ; close its owned pane before applying changes");
   if(agent.activeId&&agent.paneLaunchId!==old.launchId)throw Error("Native profile has a different active owner");
  }else{
   if(agent.activeId)throw Error("Native profile outcome is unknown; no replacement was started");
   const launch=validateRuntimePaneLaunch({...configuration,agentId:id,instance:name,paneId:randomUUID(),launchId:randomUUID(),columns:120,rows:40,...(agent.threadId?{sessionId:agent.threadId}:{}),mcpTools:this.options.menu(name).map(tool=>tool.name)});
   manifest={version:1,machineId:endpoint.machineId,configuration:configurationHash,launch};this.save(file,manifest);
  }
  const retained=manifest,launch=retained.launch;
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
  const native=new RuntimeNativePaneLifecycle({endpoint,launch,receiptFile:join(directory,`${launch.launchId}.pane.json`),
   admit:()=>{assertCurrent();this.options.admit(name,config);},reserve:launchId=>{this.options.store.reservePane(id,launchId);},pin:(launchId,sessionId)=>this.options.store.pinPaneSession(id,launchId,sessionId),
   exited:snapshot=>{this.save(file,{...retained,exited:snapshot});this.options.store.releasePane(id,snapshot);},mcpProof:()=>lease.serving()?"alive":"unknown",
   bindDaemon:value=>binding.bind(value),acquired:()=>this.options.store.setPaneRecovery(id,undefined),
   releaseAuthority:()=>{closed=true;lease.close();if(this.bindings.get(id)===binding)this.bindings.delete(id);},
  });
  const snapshot=native.port.ownedSnapshot();
  if(agent.threadId&&snapshot?.sessionId!==agent.threadId&&launch.sessionId!==agent.threadId)throw Error("Native profile conversation pin differs from its launch receipt");
  binding={native,lease,bind:value=>{if(daemon&&daemon!==value)throw Error("Native daemon binding changed");daemon=value;}};this.bindings.set(id,binding);
  return native;
 }
 /** Explicit admin attestation, bound to the held launch; no keys, tool calls or process signals. */
 async recover(name:string,config:InstanceConfig,launchId:string,confirmedStopped:boolean,assertCurrent:()=>void):Promise<void>{
  const id=config.native_agent_id;if(!id||!UUID.test(id)||this.preparing.has(id))throw Error("Native pane preparation is in flight");
  this.preparing.add(id);
  try {
   assertCurrent();this.options.admit(name,config);
   const agent=this.options.store.get(id),file=join(this.directory(id),"active.json"),manifest=this.load(file);
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
   if(rows.filter(row=>row.paneId===manifest.launch.paneId).length!==1||!pane||pane.launchId!==launchId||pane.agentId!==id||pane.instance!==name
    ||pane.sessionId!==pin||rows.some(row=>row.agentId===id&&row.paneId!==pane.paneId&&row.state!=="exited"))throw Error(t("native_pane.scope"));
   const ended=validateRuntimePaneSnapshot(await endpoint.call({action:"recover",paneId:pane.paneId,launchId,hostBootId:pane.hostBootId,confirmedStopped:true}));
   assertCurrent();this.options.admit(name,config);
   if(ended.state!=="exited"||ended.paneId!==pane.paneId||ended.launchId!==launchId||ended.agentId!==id||ended.instance!==name||ended.hostBootId!==pane.hostBootId
    ||pane.sessionId!==ended.sessionId)throw Error("Native recovery exit scope differs");
   const binding=this.bindings.get(id);
   if(binding)await binding.native.port.recordConfirmedExit(ended,assertCurrent);
   assertCurrent();this.options.admit(name,config);
   this.save(file,{...manifest,exited:ended});
   if(!agent.threadId)this.options.store.pinPaneSession(id,launchId,pin);
   if(!this.bindings.has(id))this.options.store.releasePane(id,ended);
   this.options.store.setPaneRecovery(id,undefined);
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
  if(manifest.exited){if(agent.activeId)this.options.store.releasePane(id,manifest.exited);return;}
  const receiptFile=join(directory,`${manifest.launch.launchId}.pane.json`);
  // No open intent or reservation was ever committed: this prepared factory cannot have started a process.
  try{lstatSync(receiptFile);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;if(!agent.activeId)return;throw Error("Native open intent is missing; its process outcome is unknown");}
  const endpoint=await this.options.endpoint(agent,true);assertCurrent();
  if(endpoint.machineId!==manifest.machineId)throw Error("Native close endpoint differs");
  const native=new RuntimeNativePaneLifecycle({endpoint,launch:manifest.launch,receiptFile,
   admit:assertCurrent,reserve:()=>{throw Error("Close never reserves a new launch");},pin:()=>{},mcpProof:()=>"unknown",releaseAuthority:()=>{},
   exited:snapshot=>{this.save(file,{...manifest,exited:snapshot});this.options.store.releasePane(id,snapshot);},
  });
  await native.release("close");
 }
 async handle(machineId:string,raw:PaneMcpBody,transport:()=>boolean):Promise<unknown>{
  const body=validatePaneMcpBody(raw),binding=this.bindings.get(body.owner.agentId);
  if(!binding)throw Error("Native pane tool owner is unavailable");return binding.lease.handle(machineId,body,transport);
 }
}
