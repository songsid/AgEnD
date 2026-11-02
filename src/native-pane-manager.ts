/** Fleet-owned native launch registry. No process IDs, credentials or provider paths cross this boundary. */
import {lstatSync,readFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {atomicWriteFileSync} from "./atomic-write.js";
import {runtimeJobDigest} from "./runtime-client-store.js";
import {RuntimeNativePaneLifecycle} from "./native-pane-lifecycle.js";
import {PaneMcpAuthorityLease} from "./runtime-pane-mcp.js";
import {validateRuntimePaneLaunch,validateRuntimePaneSnapshot,type RuntimePaneLaunch,type RuntimePaneSnapshot} from "./runtime-pane-protocol.js";
import {validatePaneMcpBody,type PaneMcpBody} from "./runtime-pane-mcp-protocol.js";
import type {PaneEndpoint} from "./runtime-pane-port.js";
import type {WindowsAgent,WindowsAgents} from "./windows-agents.js";
import type {InstanceConfig} from "./types.js";
import type {Daemon} from "./daemon.js";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
interface Manifest {version:1;machineId:string;launch:RuntimePaneLaunch;exited?:RuntimePaneSnapshot}
export interface NativeMachineEndpoint extends PaneEndpoint {epoch():string|null; version(provider:string):string|null}
export interface NativePaneManagerOptions {
 home:string;
 store:WindowsAgents;
 config(name:string):InstanceConfig|undefined;
 endpoint(agent:WindowsAgent):Promise<NativeMachineEndpoint>;
 admit(name:string,config:InstanceConfig):void;
 instructions(name:string,config:InstanceConfig):string;
 menu(name:string):Array<{name:string;[key:string]:unknown}>;
 allowed(name:string,tool:string,args:Record<string,unknown>):boolean;
 published(name:string,daemon:Daemon):boolean;
 invoke(daemon:Daemon,input:{tool:string;args:Record<string,unknown>;operationId:string},current:()=>boolean):Promise<{result:unknown;error?:string}>;
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
   if(value?.version!==1||Object.keys(value).some(key=>!["version","machineId","launch","exited"].includes(key))||value.machineId!=="local"&&!UUID.test(value.machineId))throw Error("Invalid native launch manifest");validateRuntimePaneLaunch(value.launch);if(!value.launch.launchId||!UUID.test(value.launch.launchId))throw Error("Native launch identity is missing");
   if(value.exited){const exit=validateRuntimePaneSnapshot(value.exited);if(exit.state!=="exited"||exit.agentId!==value.launch.agentId||exit.instance!==value.launch.instance||exit.paneId!==value.launch.paneId||exit.launchId!==value.launch.launchId)throw Error("Native exit manifest scope differs");}
   return value;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
 }
 private save(file:string,value:Manifest):void{atomicWriteFileSync(file,JSON.stringify(value),{mode:0o600});}
 /** Prepare metadata and helper authority first; acquire() alone may reserve and spawn. */
 async prepare(name:string,config:InstanceConfig,assertCurrent:()=>void):Promise<RuntimeNativePaneLifecycle> {
  const id=config.native_agent_id;if(!id||!UUID.test(id)||this.preparing.has(id))throw Error("Native pane preparation already has an owner or lacks an identity");
  this.preparing.add(id);try{return await this.prepareOwned(name,config,assertCurrent);}finally{this.preparing.delete(id);}
 }
 private async prepareOwned(name:string,config:InstanceConfig,assertCurrent:()=>void):Promise<RuntimeNativePaneLifecycle> {
  assertCurrent();this.options.admit(name,config);
  const id=config.native_agent_id;if(!id||!UUID.test(id))throw Error("Native pane profile is missing");
  let agent=this.options.store.get(id);if(agent.fleet_instance!==name||agent.machineId!==config.machine_id||agent.cli!==config.backend||agent.cwd!==config.working_directory)throw Error("Native pane profile scope differs");
  const directory=this.directory(id),file=join(directory,"active.json");let manifest=this.load(file);
  if(manifest&&(manifest.launch.agentId!==id||manifest.launch.instance!==name||manifest.machineId!==(agent.machineId??"local")))throw Error("Native launch manifest scope differs");
  if(this.bindings.has(id))throw Error("Native pane still has a coordinator owner");
  const endpoint=await this.options.endpoint(agent);assertCurrent();this.options.admit(name,config);
  if(endpoint.machineId!==(agent.machineId??"local"))throw Error("Native endpoint machine scope differs");
  const version=endpoint.version(agent.cli),expected=agent.cli==="codex"?"0.165.0":agent.cli==="claude-code"?"2.1.316":null;
  if(!expected||!version||version.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0]!==expected)throw Error("This native CLI version has not passed persistent-pane acceptance");
  const inventory=await endpoint.call({action:"list"});assertCurrent();this.options.admit(name,config);
  if(!inventory||typeof inventory!=="object"||!UUID.test((inventory as any).hostBootId)||!Array.isArray((inventory as any).panes)||(inventory as any).panes.length>4096)throw Error("Native host identity is unconfirmed");
  const latest=this.options.store.get(id);
  if(runtimeJobDigest({id:latest.id,cli:latest.cli,cwd:latest.cwd,machineId:latest.machineId,activeId:latest.activeId,paneLaunchId:latest.paneLaunchId,threadId:latest.threadId,paused:latest.paused})!==runtimeJobDigest({id:agent.id,cli:agent.cli,cwd:agent.cwd,machineId:agent.machineId,activeId:agent.activeId,paneLaunchId:agent.paneLaunchId,threadId:agent.threadId,paused:agent.paused}))throw Error("Native profile changed during host observation");
  const hostBootId=(inventory as any).hostBootId as string,panes=((inventory as any).panes as unknown[]).map(validateRuntimePaneSnapshot);
  const sameAgent=panes.filter(row=>row.agentId===id&&row.state!=="exited");
  if(sameAgent.length>1||sameAgent.some(row=>!manifest||row.paneId!==manifest.launch.paneId||row.launchId!==manifest.launch.launchId||row.instance!==name))throw Error("Another live or unknown native pane must be reconciled first");
  if(manifest?.exited){
   if(agent.activeId){this.options.store.releasePane(id,manifest.exited);agent=this.options.store.get(id);}
   manifest=null;
  }
  const instructions=this.options.instructions(name,config);
  const configuration={cli:agent.cli,cwd:agent.cwd,sandbox:config.native_sandbox,instructions,...(config.model?{model:config.model}:{})};
  if(manifest){
   const old=manifest.launch;
   if(runtimeJobDigest({cli:old.cli,cwd:old.cwd,sandbox:old.sandbox,instructions:old.instructions,...(old.model?{model:old.model}:{})})!==runtimeJobDigest(configuration))throw Error("Retained native launch settings differ; close its owned pane before applying changes");
   if(agent.activeId&&agent.paneLaunchId!==old.launchId)throw Error("Native profile has a different active owner");
  }else{
   if(agent.activeId)throw Error("Native profile outcome is unknown; no replacement was started");
   const launch=validateRuntimePaneLaunch({...configuration,agentId:id,instance:name,paneId:randomUUID(),launchId:randomUUID(),columns:120,rows:40,...(agent.threadId?{sessionId:agent.threadId}:{}),mcpTools:this.options.menu(name).map(tool=>tool.name)});
   manifest={version:1,machineId:endpoint.machineId,launch};this.save(file,manifest);
  }
  const retained=manifest,launch=retained.launch;
  let daemon:Daemon|undefined,binding:Binding,closed=false;
  const current=():boolean=>{
   if(closed||!endpoint.online()||this.bindings.get(id)!==binding)return false;
   try{assertCurrent();this.options.admit(name,config);const now=this.options.config(name),profile=this.options.store.get(id);
    return !!now&&now.native_adapter==="pane"&&now.native_agent_id===id&&now.machine_id===agent.machineId&&now.backend===launch.cli&&now.working_directory===launch.cwd&&(now.model||undefined)===launch.model&&now.native_sandbox===launch.sandbox
     &&profile.paneLaunchId===launch.launchId&&profile.activeId===launch.launchId&&!profile.paused;
   }catch{return false;}
  };
  const owned=()=>!!daemon&&current()&&this.options.published(name,daemon);
  const lease=new PaneMcpAuthorityLease(join(directory,`${launch.launchId}.mcp.json`),{
   machineId:endpoint.machineId,owner:{hostBootId,paneId:launch.paneId,launchId:launch.launchId!,agentId:id,instance:name},current,transportEpoch:()=>endpoint.epoch(),
   menu:()=>this.options.menu(name),allowed:(tool,args)=>current()&&this.options.allowed(name,tool,args),
   invoke:(input,proof)=>{if(!owned()||!proof())throw Error("Native daemon is not published");return this.options.invoke(daemon!,input,()=>owned()&&proof());},
   responseWritten:operationId=>daemon?.paneToolResponseWritten(operationId,owned),
  });
  const native=new RuntimeNativePaneLifecycle({endpoint,launch,receiptFile:join(directory,`${launch.launchId}.pane.json`),
   admit:()=>{assertCurrent();this.options.admit(name,config);},reserve:launchId=>{this.options.store.reservePane(id,launchId);},pin:(launchId,sessionId)=>this.options.store.pinPaneSession(id,launchId,sessionId),
   exited:snapshot=>{this.save(file,{...retained,exited:snapshot});this.options.store.releasePane(id,snapshot);},mcpProof:()=>lease.serving()?"alive":"unknown",
   bindDaemon:value=>binding.bind(value),
   releaseAuthority:()=>{closed=true;lease.close();if(this.bindings.get(id)===binding)this.bindings.delete(id);},
  });
  const snapshot=native.port.ownedSnapshot();
  if(agent.threadId&&snapshot?.sessionId!==agent.threadId&&launch.sessionId!==agent.threadId)throw Error("Native profile conversation pin differs from its launch receipt");
  binding={native,lease,bind:value=>{if(daemon&&daemon!==value)throw Error("Native daemon binding changed");daemon=value;}};this.bindings.set(id,binding);
  return native;
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
  const endpoint=await this.options.endpoint(agent);assertCurrent();
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
