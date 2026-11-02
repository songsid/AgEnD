/** Windows-only stdio relay. EOF detaches its link; the independently owned pane host keeps running. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { RuntimePaneLink, type PaneLinkOptions } from "./runtime-pane-link.js";
import { PaneStdioFramer,paneStdioInput,paneStdioOutput,PANE_STDIO_LIMIT,type PaneStdioOutput } from "./runtime-pane-stdio-protocol.js";
interface Pending {resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}
export function serveLocalPaneRelay(input:Readable,output:Writable,open:(options:PaneLinkOptions)=>Promise<RuntimePaneLink>=RuntimePaneLink.open):()=>void{
 const framer=new PaneStdioFramer(),pending=new Map<string,Pending>();let link:RuntimePaneLink|undefined,epoch="",online=false,maxAgents=4,requests=0,closed=false,initializing=false,lastLease=0,leaseGeneration=0;
 const current=()=>!closed&&online&&performance.now()-lastLease<15_000;
 const stop=()=>{if(closed)return;closed=true;online=false;clearTimeout(initTimer);clearInterval(leaseTimer);for(const row of pending.values()){clearTimeout(row.timer);row.reject(Error("Local pane relay detached"));}pending.clear();void link?.stop();input.off("data",data);input.pause();};
 const send=(value:PaneStdioOutput)=>{if(closed)throw Error("Local pane relay closed");const frame=JSON.stringify(paneStdioOutput(value))+"\n";if(Buffer.byteLength(frame)>PANE_STDIO_LIMIT+1||output.writableLength+Buffer.byteLength(frame)>PANE_STDIO_LIMIT*2)throw Error("Local pane output backpressure");output.write(frame);};
 const data=(bytes:Buffer)=>{try{framer.feed(bytes,raw=>{
  const value=paneStdioInput(raw);
  if(value.type==="init"){
   if(initializing||link||epoch)throw Error("Local pane init already exists");initializing=true;epoch=value.epoch;maxAgents=value.maxAgents;online=true;lastLease=performance.now();
   // The coordinator supplies an opaque installation digest, never a user-chosen path.
   // Keep the path short for PS5.1 Job exit receipts; the descriptor still verifies the full digest.
   const directory=join(process.env.LOCALAPPDATA||join(homedir(),"AppData","Local"),"AgEnD","pane-adapter",value.scope.slice(0,16),"state");
   void open({directory,server:"http://127.0.0.1",machineId:value.scope,online:current,maxAgents:()=>maxAgents,epoch:()=>epoch,
    output:snapshot=>{if(!link)return;try{send({type:"output",epoch,snapshot});}catch{stop();}},
    mcp:(body,owner)=>new Promise((resolve,reject)=>{
     if(!link||!current()||!owner()||pending.size>=32){reject(Error("Local pane MCP admission refused"));return;}
     const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error("Local pane MCP result unconfirmed"));},90_000);timer.unref();pending.set(id,{resolve,reject,timer});
     try{send({type:"mcp.request",id,epoch,body});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);stop();}
    })}).then(value=>{if(closed){void value.stop();return;}link=value;clearTimeout(initTimer);send({type:"hello",epoch,hostBootId:link.hostBootId});}).catch(()=>{stop();output.destroy();});return;
  }
  if(value.epoch!==epoch||!link)throw Error("Local pane owner is not ready");
  if(value.type==="lease"){if(!value.online)leaseGeneration++;online=value.online;lastLease=performance.now();maxAgents=value.maxAgents;link.connectionChanged();return;}
  if(value.type==="mcp.result"){const row=pending.get(value.id);if(!row)return;pending.delete(value.id);clearTimeout(row.timer);if(value.ok&&current())row.resolve(value.result);else row.reject(Error("Local pane tool result unavailable"));return;}
  if(!current()||requests>=64)throw Error("Local pane request admission refused");requests++;const owner=link;
  const generation=leaseGeneration;void owner.request(value.request,()=>current()&&link===owner&&generation===leaseGeneration).then(result=>{send({type:"response",epoch,id:value.id,ok:true,result});},()=>{send({type:"response",epoch,id:value.id,ok:false});}).catch(()=>stop()).finally(()=>{requests--;});
 });}catch{stop();output.destroy();}};
 const leaseTimer=setInterval(()=>{if(online&&performance.now()-lastLease>=15_000){online=false;leaseGeneration++;}link?.connectionChanged();},5000);leaseTimer.unref();
 const initTimer=setTimeout(()=>{stop();output.destroy();},125_000);initTimer.unref();input.on("data",data);input.once("end",stop);input.once("error",stop);output.once("error",stop);output.once("close",stop);return stop;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.platform!=="win32")throw Error("Local pane relay requires native Windows Node");serveLocalPaneRelay(process.stdin,process.stdout);
}
