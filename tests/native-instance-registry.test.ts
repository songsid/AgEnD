import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { WindowsAgents } from "../src/windows-agents.js";
import type { WindowsCliBridge, WindowsCliTask, WindowsRunOptions } from "../src/windows-cli.js";
import type { NativeTaskInput } from "../src/windows-cli-worker.js";
import type { FleetConfig } from "../src/types.js";
import { loadFleetConfig } from "../src/config.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { isWindowsInstance, nativeAgentId, nativeInstanceConfig, nativeInstanceName, registerWindowsProfiles, syncWindowsProfile } from "../src/native-instance-registry.js";

const dirs:string[]=[];
const request="12345678-1234-4321-abcd-123456789012",thread="12345678-1234-4321-abcd-123456789013";
const input={name:"Master",cwd:"J:\\Work",cli:"codex",sandbox:"read-only",instructions:"Original instructions"};
afterEach(()=>{for(const dir of dirs.splice(0)){if(!resolve(dir).startsWith(resolve(tmpdir())+"/")&&!resolve(dir).startsWith(resolve(tmpdir())+"\\"))throw Error("Unsafe scratch directory");rmSync(dir,{recursive:true,force:true});}});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"agend-native-registry-"));dirs.push(dir);
  const start=vi.fn((value:NativeTaskInput,_auth:()=>boolean,_options:WindowsRunOptions):WindowsCliTask=>({id:value.requestId,cli:value.cli,cwd:value.cwd,sandbox:value.sandbox,status:"starting",startedAt:1,output:""}));
  const cancel=vi.fn((id:string)=>({id,status:"cancelling"}));
  const bridge={start,cancel,get:vi.fn(()=>null),releaseUnknown:vi.fn(),prepareWorkspace:vi.fn(async(id:string)=>`C:\\Users\\Test\\.agend\\workspaces\\${id}`)} as unknown as WindowsCliBridge;
  return{dir,start,cancel,bridge,store:new WindowsAgents(dir,bridge),fleet:{defaults:{backend:"claude-code",model:"opus",systemPrompt:"Linux prompt"},instances:{}} as FleetConfig};
}
describe("common native instance registry",()=>{
  it("imports legacy Windows profiles once without changing identities, workspaces or conversations",async()=>{
    const f=fixture(),agent=await f.store.create(input);
    f.store.send(agent.id,{requestId:request,prompt:"hello"},()=>true);
    f.start.mock.calls[0][2].onSettled!({...f.start.mock.results[0].value,status:"completed",threadId:thread,outcomeConfirmed:true,output:"answer"});
    const before=readFileSync(join(f.dir,"windows-agents.json"),"utf8"),save=vi.fn();
    expect(registerWindowsProfiles(f.fleet,f.store,save)).toBe(true);
    const name=nativeInstanceName(agent.id),config=f.fleet.instances[name];
    expect(config).toMatchObject({runtime:"windows",native_agent_id:agent.id,display_name:"Master",working_directory:"J:\\Work",backend:"codex",model:"",systemPrompt:"Original instructions",native_sandbox:"read-only"});
    expect(f.store.get(agent.id)).toMatchObject({threadId:thread,turns:[{output:"answer"}]});
    const after=JSON.parse(readFileSync(join(f.dir,"windows-agents.json"),"utf8"));
    expect(after.agents[0].fleet_instance).toBe(name);delete after.agents[0].fleet_instance;
    expect(after).toEqual(JSON.parse(before));
    expect(registerWindowsProfiles(f.fleet,f.store,save)).toBe(false);expect(save).toHaveBeenCalledTimes(1);
  });
  it("preserves common settings on repeated registration and rolls back a failed config save",async()=>{
    const f=fixture(),agent=await f.store.create(input),name=nativeInstanceName(agent.id);
    expect(()=>registerWindowsProfiles(f.fleet,f.store,()=>{throw Error("disk full");})).toThrow("disk full");
    expect(f.fleet.instances).toEqual({});expect(f.store.list()).toHaveLength(1);
    registerWindowsProfiles(f.fleet,f.store,()=>{});
    f.fleet.instances[name].display_name="Common identity";
    expect(registerWindowsProfiles(f.fleet,f.store,()=>{throw Error("must not save");})).toBe(false);
    expect(f.fleet.instances[name].display_name).toBe("Common identity");
    f.fleet.instances[name]={...f.fleet.instances[name],runtime:"wsl",native_agent_id:undefined};
    expect(registerWindowsProfiles(f.fleet,f.store,()=>{})).toBe(false);
  });
  it("does not resurrect a previously registered profile removed from the common Fleet configuration",async()=>{
    const f=fixture(),agent=await f.store.create(input),name=nativeInstanceName(agent.id);
    registerWindowsProfiles(f.fleet,f.store,()=>{});delete f.fleet.instances[name];
    expect(registerWindowsProfiles(f.fleet,new WindowsAgents(f.dir,f.bridge),()=>{throw Error("must not resurrect");})).toBe(false);
    expect(f.fleet.instances).toEqual({});
  });
  it("loads Windows defaults without inheriting a Linux CLI model or prompt",async()=>{
    const f=fixture(),agent=await f.store.create({...input,instructions:""});
    f.fleet.instances[nativeInstanceName(agent.id)]=nativeInstanceConfig(agent);
    const path=join(f.dir,"fleet.yaml");writeFileSync(path,yaml.dump(f.fleet));
    const loaded=loadFleetConfig(path);
    expect(loaded.instances[nativeInstanceName(agent.id)]).toMatchObject({runtime:"windows",model:"",systemPrompt:"",working_directory:agent.cwd});
    expect(validateFleetConfig(f.fleet).valid).toBe(true);
    expect(isWindowsInstance({runtime:"windows"})).toBe(true);expect(nativeAgentId({runtime:"windows"})).toBeNull();
    expect(()=>nativeInstanceName("../unsafe")).toThrow(/agent id/);
  });
  it("rejects malformed native identity, permission and path config rather than using a Linux runtime",async()=>{
    const f=fixture(),agent=await f.store.create(input),base=nativeInstanceConfig(agent);
    for(const patch of [{runtime:"remote"},{native_agent_id:"../unsafe"},{working_directory:"/mnt/j/Work"},{native_sandbox:"danger-full-access"},{backend:"mock"},{backend:"grok"}]){
      expect(validateFleetConfig({...f.fleet,instances:{native:{...base,...patch}}}).valid).toBe(false);
    }
    expect(validateFleetConfig({...f.fleet,instances:{native:{...base,runtime:"wsl"}}}).valid).toBe(false);
    expect(validateFleetConfig({...f.fleet,instances:{one:base,two:{...base,native_agent_id:agent.id.toUpperCase()}}}).valid).toBe(false);
  });
  it("syncs editable common settings without losing session or rewriting an unchanged profile",async()=>{
    const f=fixture(),agent=await f.store.create(input),config=nativeInstanceConfig(agent),changed=vi.fn();f.store.subscribe(changed);
    expect(syncWindowsProfile(config,f.store).id).toBe(agent.id);expect(changed).not.toHaveBeenCalled();
    config.display_name="Shared name";config.description="Shared description";config.systemPrompt="Updated instructions";config.model="gpt-5.5";
    expect(syncWindowsProfile(config,f.store)).toMatchObject({name:"Shared name",description:"Shared description",instructions:"Updated instructions",model:"gpt-5.5"});
    expect(changed).toHaveBeenCalledTimes(1);
    f.store.send(agent.id,{requestId:request,prompt:"hello"},()=>true);
    expect(f.start.mock.calls[0][0].prompt).toContain("Updated instructions");
    f.start.mock.calls[0][2].onSettled!({...f.start.mock.results[0].value,status:"completed",threadId:thread,outcomeConfirmed:true});
    config.systemPrompt="Newest instructions";syncWindowsProfile(config,f.store);
    f.store.send(agent.id,{requestId:thread,prompt:"next"},()=>true);
    expect(f.start.mock.calls[1][0].prompt).toContain("Newest instructions");expect(f.start.mock.calls[1][2].resumeSessionId).toBe(thread);
  });
  it("refuses active edits and CLI/workspace changes for a resumed conversation",async()=>{
    const f=fixture(),agent=await f.store.create(input);
    f.store.send(agent.id,{requestId:request,prompt:"hello"},()=>true);
    expect(()=>f.store.update(agent.id,{model:"gpt-5.5"})).toThrow(/finish/);expect(()=>f.store.remove(agent.id)).toThrow(/finish/);
    expect(f.store.cancel(agent.id)?.id).toBe(request);expect(f.cancel).toHaveBeenCalledWith(request);
    f.start.mock.calls[0][2].onSettled!({...f.start.mock.results[0].value,status:"completed",threadId:thread,outcomeConfirmed:true});
    expect(()=>f.store.update(agent.id,{cli:"claude-code"})).toThrow(/new conversation/);
    expect(()=>f.store.update(agent.id,{cwd:"J:\\Other"})).toThrow(/new conversation/);
    expect(()=>f.store.update(agent.id,{description:"changed"},()=>false)).toThrow(/Authorization/);
  });
  it("persists pause/remove/restore without deleting provider history or workspace state",async()=>{
    const f=fixture(),agent=await f.store.create(input),listener=vi.fn(),off=f.store.subscribe(listener);
    f.store.setPaused(agent.id,true);expect(new WindowsAgents(f.dir,f.bridge).get(agent.id).paused).toBe(true);
    expect(()=>f.store.send(agent.id,{requestId:request,prompt:"hello"},()=>true)).toThrow(/paused/);
    f.store.setPaused(agent.id,false);off();const count=listener.mock.calls.length;
    const snapshot=f.store.remove(agent.id);expect(f.store.list()).toEqual([]);expect(listener).toHaveBeenCalledTimes(count);
    f.store.restore(snapshot);expect(f.store.get(agent.id).cwd).toBe(agent.cwd);
    expect(f.store.cancel(agent.id)).toBeNull();
  });
  it("notifies runtime observers after durable settlement and reports missing-session failure",async()=>{
    const f=fixture(),agent=await f.store.create(input),settled=vi.fn();
    const observations:boolean[]=[];f.store.subscribe(()=>observations.push(f.store.get(agent.id).blocked));
    f.store.send(agent.id,{requestId:request,prompt:"hello"},()=>true,{onSettled:task=>{expect(new WindowsAgents(f.dir,f.bridge).get(agent.id).activeId).toBeUndefined();settled(task);}});
    f.start.mock.calls[0][2].onSettled!({...f.start.mock.results[0].value,status:"completed",outcomeConfirmed:true});
    expect(observations).toEqual([false,false]);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({status:"failed",error:expect.stringContaining("no conversation id")}));
  });
});
it("persistent panes are an explicit Windows-only opt-in and never inferred from provider or global switches",async()=>{
 const {isNativePaneInstance,isNativeExecInstance}=await import("../src/native-instance-registry.js"),f=fixture(),agent=await f.store.create(input),base=nativeInstanceConfig(agent);
 expect(isNativeExecInstance(base)).toBe(true);expect(isNativePaneInstance(base)).toBe(false);expect(isNativePaneInstance({...base,native_adapter:"pane"})).toBe(true);expect(isNativeExecInstance({...base,native_adapter:"pane"})).toBe(false);expect(isNativePaneInstance({runtime:"wsl",native_adapter:"pane"})).toBe(false);
 for(const native_adapter of ["exec","pane"])expect(validateFleetConfig({...f.fleet,instances:{native:{...base,native_adapter}}}).errors).toEqual([]);
 for(const patch of [{native_adapter:"unknown"},{runtime:"wsl",native_adapter:"pane"},{backend:"grok",native_adapter:"pane"}])expect(validateFleetConfig({...f.fleet,instances:{native:{...base,...patch}}}).valid).toBe(false);
});
