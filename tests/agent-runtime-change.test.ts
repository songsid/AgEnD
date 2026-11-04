import {describe,it,expect,vi} from "vitest";
import {AgentRuntimeChanges,type AgentRuntimeChangeHost} from "../src/agent-runtime-change.js";
import {WebChatHistory} from "../src/web-chat-history.js";
const requestId="12345678-1234-4321-abcd-123456789012",machineId="22345678-1234-4321-abcd-123456789012";
const held=()=>{let release!:()=>void;const promise=new Promise<void>(yes=>{release=yes;});return {promise,release};};
function rig(){
 let config:any={working_directory:"/project",backend:"claude-code",display_name:"Helper",description:"Keep me",tags:["review"],topic_id:17,channel_id:"chat",tool_set:"worker",dashboard:{tasks:false}},epoch=0,valid=true,idle=true,generation="boot-a";
 const original=config,history=new WebChatHistory();history.record({instance:"agent-1",sender:"You",role:"user",text:"Keep this history",ts:new Date(0).toISOString()});
 const discard=vi.fn(),undo=vi.fn(),targetCurrent=vi.fn(()=>true);
 const prepare=vi.fn(async(_name:string,before:any,target:any,_current:()=>boolean)=>({config:{...before,runtime:target.runtime,machine_id:target.machineId,backend:target.backend,working_directory:target.directory||"C:\\managed",model:target.model,native_agent_id:"new-profile"},discard,current:targetCurrent}));
 const stop=vi.fn(async()=>{epoch++;}),save=vi.fn((_name:string,before:any,next:any)=>{expect(config).toBe(before);config=next;});
 const host:AgentRuntimeChangeHost={config:()=>config,defaults:()=>({backend:"claude-code"}),generation:()=>generation,epoch:()=>epoch,transition:async(_name,run)=>run(stop),idle:()=>idle,prepare,closed:vi.fn(async()=>true),fresh:vi.fn(()=>undo),save,changed:vi.fn()};
 const service=new AgentRuntimeChanges(host),target=()=>({requestId,expectedRevision:service.describe("agent-1").revision,runtime:"windows",machineId,backend:"grok",sandbox:"workspace-write",startNewConversation:true});
 return {service,host,prepare,stop,save,discard,undo,targetCurrent,original,history,target,allowed:()=>valid,get:()=>config,
  setValid:(v:boolean)=>{valid=v;},setIdle:(v:boolean)=>{idle=v;},advance:()=>{epoch++;},setGeneration:(v:string)=>{generation=v;},replace:()=>{config={...config};}};
}
describe("Agent runtime ownership",()=>{
 it("claims before allocation, reuses an identical retry and preserves one Fleet identity and chat history",async()=>{
  const r=rig(),wait=held(),implementation=r.prepare.getMockImplementation()!;r.prepare.mockImplementationOnce(async(...args)=>{await wait.promise;return implementation(...args);});
  const body=r.target(),one=r.service.change("agent-1",body,r.allowed),two=r.service.change("agent-1",body,r.allowed);
  expect(two).toBe(one);await vi.waitFor(()=>expect(r.prepare).toHaveBeenCalledOnce());
  expect(()=>r.service.change("agent-1",{...body,requestId:machineId},r.allowed)).toThrow("already in progress");
  expect(()=>r.service.change("agent-1",{...body,backend:"codex"},r.allowed)).toThrow("another change");
  wait.release();expect(await one).toMatchObject({name:"agent-1",historyPreserved:true,started:false});
  expect(r.save).toHaveBeenCalledOnce();expect(r.stop).toHaveBeenCalledOnce();expect(r.get()).toMatchObject({display_name:"Helper",description:"Keep me",tags:["review"],topic_id:17,channel_id:"chat",tool_set:"worker",dashboard:{tasks:false},backend:"grok",machine_id:machineId});
  expect(r.history.list("agent-1").map(row=>row.text)).toEqual(["Keep this history"]);expect(r.original.backend).toBe("claude-code");
  expect(await r.service.change("agent-1",body,r.allowed)).toMatchObject({ok:true});expect(r.prepare).toHaveBeenCalledOnce();
 });
 it.each(["authority","source","epoch","generation","busy","target"])("rejects a held preparation after %s changes and never retargets the old conversation",async kind=>{
  const r=rig(),wait=held(),implementation=r.prepare.getMockImplementation()!;let current!:()=>boolean;
  r.prepare.mockImplementationOnce(async(...args)=>{current=args[3];await wait.promise;return implementation(...args);});
  const result=r.service.change("agent-1",r.target(),r.allowed);const assertion=expect(result).rejects.toThrow();
  await vi.waitFor(()=>expect(r.prepare).toHaveBeenCalledOnce());
  if(kind==="authority")r.setValid(false);if(kind==="source")r.replace();if(kind==="epoch")r.advance();if(kind==="generation")r.setGeneration("boot-b");if(kind==="busy")r.setIdle(false);if(kind==="target")r.targetCurrent.mockReturnValue(false);
  if(kind!=="target"){expect(current()).toBe(false);r.setValid(true);r.setIdle(true);r.setGeneration("boot-a");}
  wait.release();await assertion;expect(r.save).not.toHaveBeenCalled();expect(r.stop).not.toHaveBeenCalled();expect(r.discard).toHaveBeenCalledOnce();
 });
 it("rechecks after a held exit proof and retains the old configuration on an unconfirmed exit",async()=>{
  const r=rig(),wait=held();vi.mocked(r.host.closed).mockImplementation(async()=>{await wait.promise;return false;});
  const result=r.service.change("agent-1",r.target(),r.allowed),assertion=expect(result).rejects.toThrow("exit is unconfirmed");
  await vi.waitFor(()=>expect(r.host.closed).toHaveBeenCalledOnce());expect(r.save).not.toHaveBeenCalled();wait.release();await assertion;
  expect(r.get()).toBe(r.original);expect(r.discard).toHaveBeenCalledOnce();expect(r.host.fresh).not.toHaveBeenCalled();
 });
 it("does not save if authority expires while exit evidence is held",async()=>{
  const r=rig(),wait=held();vi.mocked(r.host.closed).mockImplementation(async()=>{await wait.promise;return true;});
  const result=r.service.change("agent-1",r.target(),r.allowed),assertion=expect(result).rejects.toThrow("revoked");
  await vi.waitFor(()=>expect(r.host.closed).toHaveBeenCalledOnce());r.setValid(false);wait.release();await assertion;expect(r.save).not.toHaveBeenCalled();expect(r.discard).toHaveBeenCalledOnce();
 });
 it("rejects a second epoch during stop instead of following a replacement owner",async()=>{
  const r=rig();r.stop.mockImplementation(async()=>{r.advance();r.advance();});
  await expect(r.service.change("agent-1",r.target(),r.allowed)).rejects.toThrow("source owner");expect(r.save).not.toHaveBeenCalled();
 });
 it("checks the reviewed revision again after transition queueing and before preparing",async()=>{
  const r=rig(),wait=held();r.host.transition=async(_name,run)=>{await wait.promise;return run(r.stop);};
  const result=r.service.change("agent-1",r.target(),r.allowed),assertion=expect(result).rejects.toThrow("while waiting");r.replace();r.advance();wait.release();await assertion;expect(r.prepare).not.toHaveBeenCalled();
 });
 it("rolls back fresh-session pointers on a failed Linux save, while a successful move does not restore them",async()=>{
  const r=rig(),body={...r.target(),runtime:"wsl",machineId:undefined,directory:"/new-project"};r.save.mockImplementationOnce(()=>{throw Error("disk error");});
  await expect(r.service.change("agent-1",body,r.allowed)).rejects.toThrow("disk error");expect(r.undo).toHaveBeenCalledOnce();expect(r.discard).toHaveBeenCalledOnce();expect(r.get()).toBe(r.original);
  await expect(r.service.change("agent-1",{...body,requestId:machineId,expectedRevision:r.service.describe("agent-1").revision},r.allowed)).resolves.toMatchObject({runtime:"wsl"});
  expect(r.undo).toHaveBeenCalledOnce();expect(r.get().working_directory).toBe("/new-project");
 });
 it("requires reviewed fresh-conversation intent and never maps a Windows machine into a Linux target",()=>{
  const r=rig();expect(()=>r.service.change("agent-1",{...r.target(),startNewConversation:false},r.allowed)).toThrow();
  expect(()=>r.service.change("agent-1",{...r.target(),runtime:"wsl"},r.allowed)).toThrow();
  expect(()=>r.service.change("agent-1",{...r.target(),expectedRevision:"0".repeat(64)},r.allowed)).toThrow("reopen");expect(r.prepare).not.toHaveBeenCalled();
 });
});
