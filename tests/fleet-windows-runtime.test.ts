import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetWindowsRuntime } from "../src/fleet-windows-runtime.js";
import { WindowsAgents } from "../src/windows-agents.js";
import { nativeInstanceName } from "../src/native-instance-registry.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { FleetConfig } from "../src/types.js";
import type { WindowsCliBridge, WindowsCliTask, WindowsRunOptions } from "../src/windows-cli.js";
import type { NativeTaskInput } from "../src/windows-cli-worker.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { authorizeExplicitInstanceRemoval } from "../src/instance-removal.js";

const roots:string[]=[];
const id="12345678-1234-4321-abcd-123456789012", thread="12345678-1234-4321-abcd-123456789013";
beforeEach(()=>vi.stubEnv("AGEND_WINDOWS_CLI","1"));
afterEach(()=>{vi.unstubAllEnvs();for(const dir of roots.splice(0)){if(!resolve(dir).startsWith(resolve(tmpdir())))throw Error("Unsafe scratch path");rmSync(dir,{recursive:true,force:true});}});
function fixture() {
  const home=mkdtempSync(join(tmpdir(),"agend-native-runtime-"));roots.push(home);
  const tasks=new Map<string,WindowsCliTask>(), callbacks=new Map<string,WindowsRunOptions>();let active=false;
  const start=vi.fn((input:NativeTaskInput,_auth:()=>boolean,options:WindowsRunOptions)=>{
    if(active)throw Error("A Windows CLI task is already running");
    active=true;callbacks.set(input.requestId,options);
    const task:WindowsCliTask={id:input.requestId,cli:input.cli,cwd:input.cwd,sandbox:input.sandbox,status:"running",startedAt:Date.now(),output:""};tasks.set(task.id,task);return {...task};
  });
  const bridge={start,get:(key:string)=>tasks.get(key)??null,hasActiveTask:()=>active,prepareWorkspace:async(key:string)=>`C:\\Users\\Test\\.agend\\workspaces\\${key}`,
    cancel:vi.fn((key:string)=>({...tasks.get(key),status:"cancelling"})),releaseUnknown:()=>{active=false;}} as unknown as WindowsCliBridge;
  const store=new WindowsAgents(home,bridge), history=new WebChatHistory();
  const fleet={defaults:{},instances:{linux:{working_directory:"/tmp/linux"}},teams:{}} as unknown as FleetConfig;
  const events:Array<{event:string;data:any}>=[];
  const save=vi.fn(), warn=vi.fn(), removed=vi.fn();let stopping=false;
  const runtime=new FleetWindowsRuntime({owner:{dataDir:home},fleet:()=>fleet,save,warn,removed,stopping:()=>stopping,history,emit:(event,data)=>{
    events.push({event,data});if(event==="message")history.record(data as any);
  }},{store,bridge});
  const create=()=>runtime.create({name:"Windows helper",cli:"codex",sandbox:"read-only",instructions:"Use native tools",tags:["tools"]},()=>true);
  const settle=(key=id,change:Partial<WindowsCliTask>={})=>{active=false;const task={...tasks.get(key)!,status:"completed" as const,output:"native reply",threadId:thread,outcomeConfirmed:true,finishedAt:Date.now(),...change};tasks.set(key,task);callbacks.get(key)?.onSettled?.(task);return task;};
  return {home,fleet,store,runtime,bridge,start,save,warn,removed,history,events,create,settle,stop:()=>{stopping=true;}};
}

describe("Fleet Windows runtime adapter",()=>{
  it("creates an ordinary runtime-tagged Fleet instance and rolls both identity stores back when config save fails",async()=>{
    const f=fixture();f.save.mockImplementationOnce(()=>expect(f.store.list()[0].fleet_instance).toBeUndefined());
    const made=await f.create();
    expect(made.name).toBe(nativeInstanceName(made.agent.id));
    expect(f.fleet.instances[made.name]).toMatchObject({runtime:"windows",native_agent_id:made.agent.id,display_name:"Windows helper",tags:["tools"],model:""});
    expect(f.store.get(made.agent.id).fleet_instance).toBe(made.name);
    expect(f.save).toHaveBeenCalledTimes(1);
    f.save.mockImplementationOnce(()=>{throw Error("disk unavailable");});
    await expect(f.runtime.create({name:"Rejected",cli:"codex",sandbox:"read-only"},()=>true)).rejects.toThrow("disk unavailable");
    expect(Object.keys(f.fleet.instances)).toHaveLength(2);expect(f.store.list()).toHaveLength(1);
  });
  it("keeps the committed instance and conversation when the repairable backlink write fails",async()=>{
    const f=fixture();vi.spyOn(f.store,"bindInstance").mockImplementationOnce(()=>{throw Error("backlink write failed");});
    const made=await f.create();
    expect(f.fleet.instances[made.name].native_agent_id).toBe(made.agent.id);expect(f.store.list()).toHaveLength(1);
    expect(f.store.get(made.agent.id).fleet_instance).toBeUndefined();expect(f.warn).toHaveBeenCalledTimes(1);
    f.runtime.register();expect(f.store.get(made.agent.id).fleet_instance).toBe(made.name);
  });
  it("commits common configuration under the existing Settings execution without invalidating its own write",async()=>{
    const f=fixture(), transaction=new SettingsExecution({current:()=>true,snapshot:()=>f.fleet});
    try {
      const made=await f.runtime.create({name:"Settings native",cli:"codex",sandbox:"read-only"},()=>transaction.current(),transaction);
      expect(transaction.completed).toBe(true);expect(f.fleet.instances[made.name].runtime).toBe("windows");
      expect(f.store.get(made.agent.id).fleet_instance).toBe(made.name);
    } finally { transaction.close(); }
  });
  it("migrates legacy identities and their conversations into the shared registry/history exactly once",async()=>{
    const f=fixture(), old=await f.store.create({name:"Legacy",cwd:"C:\\Work",sandbox:"read-only"});
    f.store.send(old.id,{requestId:id,prompt:"old question"},()=>true);f.settle();
    expect(f.runtime.register()).toBe(true);expect(f.runtime.register()).toBe(false);
    f.runtime.importHistory();f.runtime.importHistory();
    const name=nativeInstanceName(old.id);
    expect(f.history.list(name).map(message=>message.text)).toEqual(["old question","native reply"]);
    expect(f.runtime.get(name)?.threadId).toBe(thread);expect(f.fleet.instances.linux.working_directory).toBe("/tmp/linux");
  });
  it("does not import native turns again after persisted shared history is restored in later fleet processes",async()=>{
    const f=fixture(), old=await f.store.create({name:"Legacy",cwd:"C:\\Work",sandbox:"read-only"});
    f.store.send(old.id,{requestId:id,prompt:"same remembered question"},()=>true);f.settle();f.runtime.register();
    const name=nativeInstanceName(old.id);let rows:import("../src/web-chat-history.js").StoredWebChatMessage[]=[];
    f.history.setStore({schedule(_name,snapshot){rows=snapshot();},remove:async()=>{}});
    f.runtime.importHistory();expect(rows).toHaveLength(2);
    for(const boot of ["ab","ac"]){
      const restored=new WebChatHistory({boot}), emitted=vi.fn();restored.restore(name,rows);
      restored.setStore({schedule(_name,snapshot){rows=snapshot();},remove:async()=>{}});
      const runtime=new FleetWindowsRuntime({owner:{dataDir:f.home},fleet:()=>f.fleet,save:f.save,stopping:()=>false,history:restored,emit:(event,data)=>{
        emitted(event,data);if(event==="message")restored.record(data as any);
      }},{store:f.store,bridge:f.bridge});
      runtime.importHistory();expect(emitted).not.toHaveBeenCalled();
      expect(restored.list(name).map(m=>m.text)).toEqual(["same remembered question","native reply"]);
      expect(restored.list(name).map(m=>m.role)).toEqual(["user","agent"]);
    }
  });
  it("sends through the common facade, publishes the verified reply into shared chat, and preserves resume state",async()=>{
    const f=fixture(), {name,agent}=await f.create();
    f.history.record({instance:name,sender:"You",role:"user",text:"question",ts:new Date().toISOString(),messageId:`native:${id}:user`});
    await expect(f.runtime.deliver(name,{type:"fleet_inbound",requestId:id,content:"question",meta:{source:"web"}})).resolves.toBe(true);
    expect(f.runtime.execution(name)).toBe("working");expect(f.runtime.available(name)).toBe(false);
    expect(f.start.mock.calls[0][0]).toMatchObject({cli:"codex",cwd:agent.cwd,prompt:"Agent instructions:\nUse native tools\n\nUser task:\nquestion"});
    f.settle();expect(f.runtime.execution(name)).toBe("idle");expect(f.runtime.available(name)).toBe(true);
    expect(f.history.list(name).map(message=>message.role)).toEqual(["user","agent"]);
    f.runtime.importHistory();expect(f.history.list(name)).toHaveLength(2);
    await f.runtime.deliver(name,{requestId:thread,content:"next",meta:{source:"web"}});
    expect(f.start.mock.calls[1][2].resumeSessionId).toBe(thread);f.settle(thread);
  });
  it("shares the physical execution slot while keeping per-instance pause and settings in the common registry",async()=>{
    const f=fixture(), {name}=await f.create();
    f.runtime.update(name,{display_name:"Renamed",description:"Common settings",model:"gpt-5.5",tags:["shared"]},()=>true);
    expect(f.runtime.get(name)).toMatchObject({name:"Renamed",description:"Common settings",model:"gpt-5.5"});
    f.runtime.setPaused(name,true);expect(f.runtime.status(name)).toBe("paused");
    await f.runtime.deliver(name,{requestId:id,content:"wake",meta:{source:"web"}});
    expect(f.runtime.status(name)).toBe("running");expect(f.runtime.busy()).toBe(true);
    f.settle();f.runtime.remove(name,()=>true);expect(f.fleet.instances[name]).toBeUndefined();expect(f.store.list()).toEqual([]);
  });
  it("does not wake or run after the caller expires and never treats terminal paste as a headless message",async()=>{
    const f=fixture(), {name}=await f.create();f.runtime.setPaused(name,true);
    await expect(f.runtime.deliver(name,{content:"expired"},{stillCurrent:()=>false})).rejects.toThrow(/current/);
    expect(f.runtime.status(name)).toBe("paused");expect(f.start).not.toHaveBeenCalled();
    await expect(f.runtime.execute(name,{type:"raw_paste",content:"dangerous command"})).rejects.toThrow(/terminal/);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("saves removal and team cleanup together, then cleans shared metadata only after success",async()=>{
    const f=fixture(), {name,agent}=await f.create();
    f.fleet.teams={shared:{members:[name,"linux"],description:"Keep"},empty:{members:[name]}};
    f.save.mockImplementationOnce(()=>{expect(f.fleet.teams).toEqual({shared:{members:["linux"],description:"Keep"}});expect(f.removed).not.toHaveBeenCalled();throw Error("save failed");});
    expect(()=>f.runtime.remove(name,()=>true)).toThrow("save failed");
    expect(f.fleet.teams).toEqual({shared:{members:[name,"linux"],description:"Keep"},empty:{members:[name]}});
    expect(f.store.get(agent.id).name).toBe("Windows helper");expect(f.removed).not.toHaveBeenCalled();
    f.runtime.remove(name,()=>true);
    expect(f.fleet.teams).toEqual({shared:{members:["linux"],description:"Keep"}});expect(f.removed).toHaveBeenCalledWith(name,expect.objectContaining({runtime:"windows"}));
  });
  it("waits for terminal provider evidence for durable work and preserves failed/unknown outcomes",async()=>{
    const f=fixture(), {name}=await f.create(), beforeStart=vi.fn();
    const pending=f.runtime.execute(name,{requestId:id,content:"delegated work",meta:{from_instance:"linux"}},{beforeStart});
    expect(beforeStart).toHaveBeenCalledTimes(1);expect(f.history.list(name)[0].sender).toBe("linux");
    f.settle(id,{status:"failed",error:"connection lost",outcomeConfirmed:false});
    await expect(pending).resolves.toMatchObject({status:"failed",error:"connection lost",outcomeConfirmed:false});
    expect(f.runtime.status(name)).toBe("crashed");
  });
});

describe("Fleet native routing and durable lane",()=>{
  function manager() {
    const native={available:vi.fn(()=>true),get:vi.fn(()=>({blocked:false,paused:false})),busy:vi.fn(()=>false),setPaused:vi.fn(),cancel:vi.fn(),deliver:vi.fn(async()=>true),status:vi.fn(()=>"running"),execution:vi.fn(()=>"idle"),execute:vi.fn(async(..._args:any[]):Promise<any>=>({status:"completed",output:"result",outcomeConfirmed:true}))};
    const fm=Object.create(FleetManager.prototype) as any;
    fm.fleetConfig={instances:{win:{runtime:"windows"},linux:{working_directory:"/tmp"}}};fm.managerBootId="manager-boot";fm.shuttingDown=false;
    fm.nativeInstanceRuntime=()=>native;
    fm.lifecycle=new Proxy({},{get(){throw Error("Linux lifecycle must not be accessed for a Windows instance");}});
    Object.defineProperty(fm,"daemons",{value:new Map()});fm.scheduleDeliveryOutboxPump=vi.fn();fm.logger={warn:vi.fn(),debug:vi.fn()};
    const outbox={begin:vi.fn(()=>"begun"),complete:vi.fn(),retryBeforeBegin:vi.fn(),admit:vi.fn()};fm.deliveryOutbox=outbox;
    return {fm,native,outbox};
  }
  it("routes start/stop/wake/restart/status/delivery to the adapter before touching tmux lifecycle",async()=>{
    const {fm,native}=manager();
    await fm.startInstance("win",{runtime:"windows"},false,"fleet-topic",true);
    await fm.stopInstance("win");await fm.explicitWake("win");await fm.restartSingleInstance("win",{explicit:true});
    expect(fm.getInstanceStatus("win")).toBe("running");expect(fm.getInstanceExecutionState("win")).toBe("idle");
    await expect(fm.deliverToInstance("win",{content:"message"})).resolves.toBe(true);
    expect(native.deliver).toHaveBeenCalledTimes(1);expect(native.cancel).toHaveBeenCalledWith("win");
  });
  it("uses the manager generation only while the shared native slot can claim work",()=>{
    const {fm,native}=manager();expect(fm.deliveryBootId("win")).toBe("manager-boot");native.available.mockReturnValue(false);expect(fm.deliveryBootId("win")).toBeNull();
  });
  it("never inherits an external chat channel or Linux status watcher for native agents",async()=>{
    const {fm}=manager(), send=vi.fn();fm.adapter={sendText:send};fm.emitSseEvent=vi.fn();
    expect(fm.getAdapterForInstance("win")).toBeNull();expect(fm.getGroupIdForInstance("win")).toBe("");expect(fm.getInstanceAdapterId("win")).toBeUndefined();
    fm.startStatuslineWatcher("win");await fm.startWebChatProgress("win");await fm.sendCancelButton("win");
    expect(fm.notifyInstanceTopic("win","Local notice")).toBe(true);
    expect(fm.emitSseEvent).toHaveBeenCalledWith("message",expect.objectContaining({instance:"win",role:"status",text:"Local notice"}));expect(send).not.toHaveBeenCalled();
  });
  it("uses native cancellation and explicit removal without Linux teardown",async()=>{
    const {fm,native}=manager();Object.assign(fm,{deliveryEpochs:new Map(),instanceIdleWaiters:new Map(),lastInboundMsg:new Map(),webChatHistory:new WebChatHistory()});
    native.cancel.mockReturnValueOnce({id,status:"cancelling"});
    expect(fm.cancelInstance("win")).toBe(true);expect(fm.getDeliveryEpoch("win")).toBe(1);
    native.cancel.mockReturnValueOnce(null);expect(fm.cancelInstance("win")).toBe(false);
    const remove=vi.fn();(native as any).remove=remove;
    await expect(fm.removeInstance("win",{})).rejects.toThrow(/authorization/);
    await fm.removeInstance("win",authorizeExplicitInstanceRemoval("delete-instance-tool"));
    expect(remove).toHaveBeenCalledWith("win",expect.any(Function),undefined);
  });
  it("removes native schedules, history, search and preferences without deleting the Windows workspace",()=>{
    const {fm}=manager();Object.assign(fm,{deliveryEpochs:new Map(),instanceIdleWaiters:new Map(),lastActivity:new Map(),lastInboundUser:new Map(),rateLimitWarnedAt:new Map(),lastInboundMsg:new Map(),webChatHistory:new WebChatHistory(),
      scheduler:{list:vi.fn(()=>[{id:"win-schedule"}]),delete:vi.fn()},searchIndex:{removeInstance:vi.fn()}});
    const prefs={forgetInstance:vi.fn()}, files={forget:vi.fn()};
    for(const [key,value] of Object.entries({webPrefs:prefs,webFiles:files,themeStore:{forget:vi.fn()},webAppearance:{forget:vi.fn()},appearanceTools:{forget:vi.fn()},mods:{forgetInstance:vi.fn()}}))Object.defineProperty(fm,key,{value});
    fm.webChatHistory.record({instance:"win",sender:"You",text:"old",ts:new Date().toISOString()});
    fm.nativeInstanceRemoved("win");
    expect(fm.scheduler.list).toHaveBeenCalledWith("win");expect(fm.scheduler.delete).toHaveBeenCalledWith("win-schedule");
    expect(fm.webChatHistory.list("win")).toEqual([]);expect(fm.searchIndex.removeInstance).toHaveBeenCalledWith("win");expect(prefs.forgetInstance).toHaveBeenCalledWith("win");expect(files.forget).toHaveBeenCalledWith("win");
  });
  it("keeps the entire status frame available when one configured native profile is missing",()=>{
    const {fm,native}=manager(), home=mkdtempSync(join(tmpdir(),"agend-native-frame-"));roots.push(home);
    fm.dataDir=home;fm.fleetConfig={instances:{win:{runtime:"windows",working_directory:"C:\\Work"}},defaults:{}};
    native.get.mockImplementation(()=>{throw Error("profile missing");});fm.getPublicWebStatus=()=>({state:"closed"});fm.hostMemoryIndicator=()=>null;fm.webOnlyPromptPlace=()=>null;
    Object.defineProperty(fm,"webPrefs",{value:{rev:()=>0}});Object.defineProperty(fm,"themeStore",{value:{rev:()=>0}});fm.webChatHistory=new WebChatHistory();fm.startedAt=Date.now();
    const frame=fm.getUiStatus();expect(frame.instances).toHaveLength(1);expect(frame.instances[0]).toMatchObject({name:"win",runtime:"windows",status:"crashed",native_blocked:true,execution_state:null});
    expect(frame.instances[0].runtime_error).toContain("missing");expect(native.status).not.toHaveBeenCalled();
  });
  it("does not initialize native storage during startup or history restore when the opt-in feature is off",()=>{
    const {fm}=manager();vi.stubEnv("AGEND_WINDOWS_CLI","0");fm.nativeInstanceRuntime=vi.fn(()=>{throw Error("Native storage must not be opened");});
    expect(()=>fm.initializeNativeInstances()).not.toThrow();expect(()=>fm.initializeNativeInstances(true)).not.toThrow();expect(fm.nativeInstanceRuntime).not.toHaveBeenCalled();
  });
  it("isolates a malformed native store from the Linux fleet's startup and history restoration",()=>{
    const {fm}=manager(), home=mkdtempSync(join(tmpdir(),"agend-native-broken-startup-"));roots.push(home);writeFileSync(join(home,"windows-agents.json"),"{broken JSON");
    fm.dataDir=home;fm.nativeInstanceRuntime=FleetManager.prototype.nativeInstanceRuntime;fm.webChatHistory=new WebChatHistory();
    expect(()=>fm.initializeNativeInstances()).not.toThrow();expect(()=>fm.initializeNativeInstances(true)).not.toThrow();expect(fm.logger.warn).toHaveBeenCalledTimes(2);
    expect(fm.fleetConfig.instances.linux.working_directory).toBe("/tmp");
  });
  it("keeps status available when constructing the native store itself fails",()=>{
    const {fm}=manager(), home=mkdtempSync(join(tmpdir(),"agend-native-broken-frame-"));roots.push(home);writeFileSync(join(home,"windows-agents.json"),"{broken JSON");
    fm.dataDir=home;fm.nativeInstanceRuntime=FleetManager.prototype.nativeInstanceRuntime;fm.fleetConfig={instances:{win:{runtime:"windows"}},defaults:{}};
    fm.getPublicWebStatus=()=>({state:"closed"});fm.hostMemoryIndicator=()=>null;fm.webOnlyPromptPlace=()=>null;
    Object.defineProperty(fm,"webPrefs",{value:{rev:()=>0}});Object.defineProperty(fm,"themeStore",{value:{rev:()=>0}});fm.webChatHistory=new WebChatHistory();fm.startedAt=Date.now();
    expect(fm.getInstanceStatus("win")).toBe("crashed");expect(fm.getInstanceExecutionState("win")).toBeNull();
    expect(fm.getUiStatus().instances[0]).toMatchObject({name:"win",runtime:"windows",native_blocked:true,status:"crashed"});
  });
  it("completes the same durable outbox row and returns requested peer results with the original correlation id",async()=>{
    const {fm,native,outbox}=manager();
    native.execute.mockImplementationOnce(async(_name:any,_payload:any,opts:any)=>{opts.beforeStart();return {status:"completed",output:"native result",outcomeConfirmed:true};});
    const row={deliveryId:id,targetDaemonBootId:"manager-boot",attemptNo:1,targetInstance:"win",sourceInstance:"linux",kind:"fleet_inbound",correlationId:"peer-request",payload:{content:"question",meta:{requires_reply:"true"}}};
    await fm.dispatchDurableDelivery(row);
    expect(outbox.complete).toHaveBeenCalledWith(id,"manager-boot",1,"delivered","completed");
    expect(outbox.admit).toHaveBeenCalledWith(expect.objectContaining({sourceInstance:"win",targetInstance:"linux",correlationId:"peer-request",payload:expect.objectContaining({content:"native result",meta:expect.objectContaining({requires_reply:"false"})})}));
    expect(fm.scheduleDeliveryOutboxPump).toHaveBeenCalled();
  });
  it("fails unsupported terminal jobs without launching a native process, and keeps uncertain results non-retriable",async()=>{
    const {fm,native,outbox}=manager(), row={deliveryId:id,targetDaemonBootId:"manager-boot",attemptNo:1,targetInstance:"win",sourceInstance:"linux",kind:"raw_paste",payload:{content:"raw"}};
    await fm.dispatchDurableDelivery(row);expect(native.execute).not.toHaveBeenCalled();expect(outbox.complete).toHaveBeenCalledWith(id,"manager-boot",1,"failed",expect.stringContaining("terminal"));
    outbox.complete.mockClear();native.execute.mockImplementationOnce(async(_name:any,_payload:any,opts:any)=>{opts.beforeStart();return {status:"failed",output:"",error:"unknown",outcomeConfirmed:false};});
    await fm.dispatchDurableDelivery({...row,kind:"fleet_inbound"});expect(outbox.complete).toHaveBeenCalledWith(id,"manager-boot",1,"uncertain","unknown");expect(outbox.retryBeforeBegin).not.toHaveBeenCalled();
  });
});
