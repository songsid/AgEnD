import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetWindowsRuntime } from "../src/fleet-windows-runtime.js";
import { WindowsAgents } from "../src/windows-agents.js";
import { nativeInstanceName } from "../src/native-instance-registry.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { validateNativeTask, type NativeTaskInput } from "../src/windows-cli-worker.js";
import type { WindowsCliBridge, WindowsCliTask, WindowsRunOptions } from "../src/windows-cli.js";
import type { FleetConfig } from "../src/types.js";

const token="i".repeat(48),dirs:string[]=[];
class CaptureRes extends ServerResponse {
  status=0;body="";
  override writeHead(status:number):this{this.status=status;return this;}
  override end(value?:unknown):this{this.body+=String(value??"");this.emit("capture:end");return this;}
}
function request(method:string,path:string,body?:unknown):IncomingMessage {
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method=method;req.url=path;req.headers={host:"localhost","x-agend-token":token};return req;
}
async function call(ctx:WebApiContext,method:string,path:string,body?:unknown){
  const req=request(method,path,body),res=new CaptureRes(req);
  const ended=new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(Error("Handler did not finish")),3000);res.once("capture:end",()=>{clearTimeout(timer);done();});});
  expect(handleWebRequest(req,res,new URL(path,"http://localhost"),ctx)).toBe(true);await ended;
  return{status:res.status,body:JSON.parse(res.body)};
}
beforeEach(()=>vi.stubEnv("AGEND_WINDOWS_CLI","1"));
afterEach(()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0)){const prefix=resolve(tmpdir())+(process.platform==="win32"?"\\":"/");if(!resolve(dir).startsWith(prefix))throw Error("Unsafe scratch directory");rmSync(dir,{recursive:true,force:true});}});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"agend-native-web-integration-"));dirs.push(dir);
  const tasks=new Map<string,WindowsCliTask>(),settlements=new Map<string,(task:WindowsCliTask)=>void>();let active:string|null=null;
  const start=vi.fn((raw:NativeTaskInput,_auth:()=>boolean,options:WindowsRunOptions={})=>{
    const input=validateNativeTask(raw),old=tasks.get(input.requestId);if(old)return old;
    if(active)throw Error("A Windows CLI task is already running");
    const task:WindowsCliTask={id:input.requestId,cli:input.cli,cwd:input.cwd,sandbox:input.sandbox,status:"running",output:"",startedAt:Date.now()};
    active=task.id;tasks.set(task.id,task);if(options.onSettled)settlements.set(task.id,options.onSettled);return{...task};
  });
  const bridge={start,get:(id:string)=>tasks.get(id)??null,hasActiveTask:()=>active!==null,
    prepareWorkspace:vi.fn(async(id:string)=>`C:\\Users\\Test\\.agend\\workspaces\\${id}`),cancel:vi.fn(),releaseUnknown:vi.fn()} as unknown as WindowsCliBridge;
  const store=new WindowsAgents(dir,bridge),profile=await store.create({name:"Master",cwd:"J:\\Work",cli:"codex",sandbox:"read-only"});
  const fleet:FleetConfig={defaults:{},instances:{linux:{...structuredClone(DEFAULT_INSTANCE_CONFIG),working_directory:dir,backend:"codex"}}};
  const history=new WebChatHistory(),events:Array<{event:string;data:any}>=[],save=vi.fn();
  let runtime:FleetWindowsRuntime;
  const status=()=>({instances:Object.entries(fleet.instances).map(([name,cfg])=>({name,display_name:cfg.display_name,runtime:cfg.runtime??"wsl",status:cfg.runtime==="windows"?runtime.status(name):"running",execution_state:cfg.runtime==="windows"?runtime.execution(name):"idle",capabilities:cfg.runtime==="windows"?{terminal:false,attachments:false,chat:true}:undefined}))});
  const emit=(event:string,data:any)=>{events.push({event,data:event==="status"?status():data});if(event==="message")history.record(data);};
  const host={owner:{dataDir:dir},fleet:()=>fleet,save,emit,stopping:()=>false,history};
  runtime=new FleetWindowsRuntime(host,{store,bridge});runtime.register();
  const linuxDeliver=vi.fn(async()=>true);
  const makeContext=()=>({webToken:token,dataDir:dir,fleetConfig:fleet,instanceIpcClients:new Map(),daemons:new Map(),sseClients:new Set(),adapter:null,eventLog:null,
    logger:{info(){},debug(){},warn(){},error(){}},lastInboundUser:new Map(),webChatHistory:history,getUiStatus:status,emitSseEvent:emit,
    getInstanceDir:()=>dir,getInstanceStatus:(name:string)=>runtime.has(name)?runtime.status(name):"running",nativeInstanceRuntime:()=>runtime,
    deliverToInstance:async(name:string,payload:Record<string,unknown>,options:any)=>runtime.has(name)?runtime.deliver(name,payload,options):linuxDeliver(),
    lifecycle:{handleCreate:vi.fn()},saveFleetConfig:save} as unknown as WebApiContext);
  const complete=(id:string,output="Native answer")=>{const task=tasks.get(id)!;Object.assign(task,{status:"completed",output,threadId:profile.id,finishedAt:Date.now(),outcomeConfirmed:true});active=null;settlements.get(id)!(task);};
  return{dir,fleet,history,events,start,store,profile,name:nativeInstanceName(profile.id),runtime,host,bridge,makeContext,complete,save,linuxDeliver};
}

describe("Windows runtime through the ordinary web instance/chat surface",()=>{
  it("creates through /ui/instances and registers a normal runtime-aware Fleet identity",async()=>{
    const f=await fixture(),ctx=f.makeContext(),result=await call(ctx,"POST","/ui/instances",{runtime:"windows",topic_name:"General assistant",backend:"codex",sandbox:"read-only"});
    expect(result.status).toBe(201);const created=result.body;
    expect(f.fleet.instances[created.name]).toMatchObject({runtime:"windows",native_agent_id:created.agent.id,display_name:"General assistant",working_directory:created.agent.cwd});
    expect(created.agent.cwd).toBe(`C:\\Users\\Test\\.agend\\workspaces\\${created.agent.id}`);
    expect((ctx.lifecycle.handleCreate as any)).not.toHaveBeenCalled();expect(f.start).not.toHaveBeenCalled();
  });
  it("connects ordinary /ui/send to native UUIDs, shared history, status and replies",async()=>{
    const f=await fixture(),ctx=f.makeContext(),result=await call(ctx,"POST","/ui/send",{instance:f.name,message:"Synthetic message",clientId:"native-client-001"});
    expect(result.status).toBe(200);expect(result.body.sent).toBe(true);expect(f.start).toHaveBeenCalledOnce();
    const requestId=f.start.mock.calls[0][0].requestId;
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);expect(result.body.messageId).toBe(`native:${requestId}:user`);
    expect(f.history.list(f.name,10)).toMatchObject([{role:"user",text:"Synthetic message",messageId:result.body.messageId}]);
    expect(f.runtime.execution(f.name)).toBe("working");
    f.complete(requestId);
    expect(f.runtime.execution(f.name)).toBe("idle");expect(f.runtime.available(f.name)).toBe(true);
    const read=await call(ctx,"GET",`/ui/history?instance=${encodeURIComponent(f.name)}`);
    expect(read.body.messages).toMatchObject([{role:"user",text:"Synthetic message"},{role:"agent",text:"Native answer",messageId:`native:${requestId}:reply`}]);
    expect(f.events.filter(row=>row.event==="activity").map(row=>row.data.state)).toEqual(["working","idle"]);
  });
  it("deduplicates a browser retry after replacing the web context and reloading durable native state",async()=>{
    const f=await fixture(),body={instance:f.name,message:"Send once",clientId:"native-client-restart"};
    const first=await call(f.makeContext(),"POST","/ui/send",body),requestId=f.start.mock.calls[0][0].requestId;f.complete(requestId);
    const newStore=new WindowsAgents(f.dir,f.bridge),restored=new FleetWindowsRuntime(f.host,{store:newStore,bridge:f.bridge});
    const secondCtx=f.makeContext();secondCtx.nativeInstanceRuntime=()=>restored;secondCtx.deliverToInstance=async(name,payload,options)=>restored.deliver(name,payload,{stillCurrent:options?.stillCurrent});
    const repeated=await call(secondCtx,"POST","/ui/send",body);
    expect(repeated.status).toBe(200);expect(repeated.body).toMatchObject({repeated:true,messageId:first.body.messageId});expect(f.start).toHaveBeenCalledOnce();
    const changed=await call(f.makeContext(),"POST","/ui/send",{...body,message:"Different content"});expect(changed.status).toBe(409);expect(f.start).toHaveBeenCalledOnce();
    restored.importHistory();restored.importHistory();expect(f.history.list(f.name,20)).toHaveLength(2);
  });
  it("keeps native capabilities and paths out of the Linux terminal/upload branch",async()=>{
    const f=await fixture(),ctx=f.makeContext();
    const attachment=await call(ctx,"POST","/ui/send",{instance:f.name,message:"With file",attachments:["a".repeat(32)],clientId:"native-attachment"});
    expect(attachment.status).toBe(400);expect(f.start).not.toHaveBeenCalled();
    const linux=await call(ctx,"POST","/ui/send",{instance:"linux",message:"Existing Linux route",clientId:"linux-client-001"});
    expect(linux.status).toBe(200);expect(f.linuxDeliver).toHaveBeenCalledOnce();expect(f.start).not.toHaveBeenCalled();
  });
  it("does not resurrect a migrated profile after its common config entry is removed",async()=>{
    const f=await fixture();expect(f.store.get(f.profile.id).fleet_instance).toBe(f.name);
    delete f.fleet.instances[f.name];
    const newStore=new WindowsAgents(f.dir,f.bridge),restored=new FleetWindowsRuntime(f.host,{store:newStore,bridge:f.bridge});
    expect(restored.register()).toBe(false);expect(f.fleet.instances).not.toHaveProperty(f.name);expect(newStore.get(f.profile.id).id).toBe(f.profile.id);
  });
});
