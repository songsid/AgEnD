/** Main-loop-owned local Windows relay. Process death detaches; terminal ownership is never inferred from a PID. */
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { NativeMachineEndpoint } from "./native-pane-manager.js";
import type { RuntimeCoordinatorEvent } from "./runtime-coordinator.js";
import { PaneStdioFramer,paneStdioInput,paneStdioOutput,PANE_STDIO_LIMIT,type PaneStdioInput } from "./runtime-pane-stdio-protocol.js";
import { validateRuntimePaneShutdown, type RuntimePaneRequest } from "./runtime-pane-protocol.js";
import type { PaneMcpBody } from "./runtime-pane-mcp-protocol.js";
interface Pending {resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}
export interface LocalPaneOptions {
 scope:string;admit():void;maxAgents():number;version(provider:string):string|null;
 launch():Promise<ChildProcess>;mcp(body:PaneMcpBody,current:()=>boolean):Promise<unknown>;
 /** S-35: the relay's own stderr (bounded) — it was discarded, so a relay that exited at once left no trace. */
 diagnostic?(text:string):void;
}
export class LocalPaneEndpoint implements NativeMachineEndpoint {
 readonly machineId="local";private readonly attachment=randomUUID();private child:ChildProcess|undefined;private connected=false;private stopped=false;private mcpPending=0;private cleanupOnly=false;private lastLease=0;
 private pending=new Map<string,Pending>();private listeners=new Set<(event:RuntimeCoordinatorEvent)=>void>();private interval:ReturnType<typeof setInterval>|undefined;
 private hostBootId:string|undefined;
 private constructor(private options:LocalPaneOptions){}
 static async open(options:LocalPaneOptions):Promise<LocalPaneEndpoint>{
  const endpoint=new LocalPaneEndpoint(options);options.admit();const child=await options.launch();endpoint.child=child;
  try{options.admit();await endpoint.attach(child);options.admit();return endpoint;}catch(error){endpoint.stop();throw error;}
 }
 online():boolean{if(this.stopped||!this.connected||performance.now()-this.lastLease>=15_000)return false;if(this.cleanupOnly)return true;try{this.options.admit();return true;}catch{return false;}}
 /** Irreversible transport drain: only exact snapshot/close RPC remains; no new helper work or input. */
 beginCleanup():void{this.cleanupOnly=true;}
 epoch():string|null{return this.online()?this.attachment:null;}
 version(provider:string):string|null{return this.options.version(provider);}
 subscribe(listener:(event:RuntimeCoordinatorEvent)=>void):()=>void{this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 private send(value:PaneStdioInput):void{
  if(this.stopped||!this.child?.stdin?.writable)throw Error("Local pane relay is disconnected");const frame=JSON.stringify(paneStdioInput(value))+"\n";
  if(Buffer.byteLength(frame)>PANE_STDIO_LIMIT+1||this.child.stdin.writableLength+Buffer.byteLength(frame)>PANE_STDIO_LIMIT*2)throw Error("Local pane relay backpressure");this.child.stdin.write(frame);
 }
 private attach(child:ChildProcess):Promise<void>{
  return new Promise((resolve,reject)=>{
   if(!child.stdin||!child.stdout){reject(Error("Local pane relay streams are unavailable"));return;}
   const framer=new PaneStdioFramer();let ready=false;const timer=setTimeout(()=>{reject(Error("Local pane relay startup unconfirmed"));this.stop();},125_000);timer.unref();
   const lost=()=>{clearTimeout(timer);if(!ready)reject(Error("Local pane relay startup unconfirmed"));this.stop();};child.once("error",lost);child.once("exit",lost);child.stdout?.once("end",lost);child.stdout?.once("close",lost);child.stdin?.on("error",lost);
   let told=0;child.stderr?.setEncoding?.("utf8");child.stderr?.on("data",(part:string|Buffer)=>{if(told>=8_192||!this.options.diagnostic)return;const text=String(part).replace(/[\p{Cc}\p{Cf}]+/gu," ").trim().slice(0,8_192-told);told+=text.length;if(text)try{this.options.diagnostic(text);}catch{/* a diagnostic never affects the relay */}});
   child.stdout?.on("data",(bytes:Buffer)=>{try{framer.feed(bytes,raw=>{
    const value=paneStdioOutput(raw);if(value.epoch!==this.attachment)throw Error("Local pane relay epoch differs");
    if(!ready){if(value.type!=="hello")throw Error("Local pane relay not ready");this.hostBootId=value.hostBootId;ready=true;clearTimeout(timer);this.connected=true;this.lastLease=performance.now();this.lease();this.interval=setInterval(()=>this.lease(),5000);this.interval.unref();resolve();return;}
    if(value.type==="hello")throw Error("Duplicate local pane hello");
    if(value.type==="output"){for(const listener of this.listeners)listener({type:"pane",machineId:"local",pane:value.snapshot});return;}
    if(value.type==="response"){const row=this.pending.get(value.id);if(!row)return;this.pending.delete(value.id);clearTimeout(row.timer);if(value.ok)row.resolve(value.result);else row.reject(Error("Local pane operation unconfirmed; inspect its owned receipt"));return;}
    if(this.cleanupOnly){this.send({type:"mcp.result",epoch:this.attachment,id:value.id,ok:false});return;}
    if(this.mcpPending>=32)throw Error("Local pane MCP backlog");this.mcpPending++;const current=()=>!this.cleanupOnly&&this.online();
    void this.options.mcp(value.body,current).then(result=>{if(current())this.send({type:"mcp.result",epoch:this.attachment,id:value.id,ok:true,result});},()=>{if(current())this.send({type:"mcp.result",epoch:this.attachment,id:value.id,ok:false});}).catch(()=>this.stop()).finally(()=>{this.mcpPending--;});
   });}catch{lost();}});
   try{this.send({type:"init",scope:this.options.scope,epoch:this.attachment,maxAgents:this.options.maxAgents()});}catch(error){clearTimeout(timer);reject(error);this.stop();}
  });
 }
 private lease():void{if(this.stopped)return;if(!this.online()){this.stop();return;}this.lastLease=performance.now();try{this.send({type:"lease",epoch:this.attachment,online:this.online(),maxAgents:this.options.maxAgents()});}catch{this.stop();}}
 call(request:RuntimePaneRequest):Promise<unknown>{
  if(this.cleanupOnly&&!["snapshot","close","list","shutdown"].includes(request.action))return Promise.reject(Error("Local pane relay only permits owned cleanup"));
  if(!this.online()||this.pending.size>=64)return Promise.reject(Error("Local pane relay unavailable or busy"));
  return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{this.pending.delete(id);reject(Error("Local pane result unconfirmed; input was not replayed"));},125_000);timer.unref();this.pending.set(id,{resolve,reject,timer});try{this.send({type:"request",epoch:this.attachment,id,request});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
 }
 /** Explicit switch-off only. The host independently refuses while any launch or outcome remains unconfirmed. */
 async shutdownHost():Promise<void>{
  if(!this.cleanupOnly||!this.hostBootId)throw Error("Local pane host shutdown lacks a cleanup owner");
  validateRuntimePaneShutdown(await this.call({action:"shutdown",hostBootId:this.hostBootId}),this.hostBootId);
 }
 /** Only close stdio; never signal a Windows process or close a terminal here. */
 stop():void{if(this.stopped)return;this.stopped=true;this.connected=false;clearInterval(this.interval);this.child?.stdin?.end();this.child?.stdout?.destroy();this.child?.stderr?.destroy();for(const row of this.pending.values()){clearTimeout(row.timer);row.reject(Error("Local pane relay detached; process state is retained"));}this.pending.clear();for(const listener of this.listeners)listener({type:"machine",machineId:"local"});this.listeners.clear();}
}
