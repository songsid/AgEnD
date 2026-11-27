/** All start/stop/process/IPC ports are inert doubles. These tests never launch a Fleet or provider. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {FleetManager} from "../src/fleet-manager.js";
import {InstanceLifecycle} from "../src/instance-lifecycle.js";
import {SettingsRouteLifetime} from "../src/settings-route-lifetime.js";
import {SettingsExecution} from "../src/settings-transaction.js";
import {RequestContextPreparedWork} from "../src/request-context-work.js";
import {RequestContextPendingWork} from "../src/request-context-pending-work.js";
import {setProcessFleetLock,releaseProcessFleetLock} from "../src/fleet-lock.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function rig(){
 const h=mkdtempSync(join(tmpdir(),"owned-relaunch-"));cleanup.push(()=>rmSync(h,{recursive:true,force:true}));
 const record={pid:process.pid,nonce:randomUUID(),createdAt:new Date().toISOString(),role:"fleet" as const},path=join(h,"fleet.lock"),serialized=JSON.stringify(record);
 writeFileSync(path,serialized);setProcessFleetLock({path,record,serialized});cleanup.push(()=>releaseProcessFleetLock());
 let fenced=true,proof=true,drained=true,fail:string|null=null,failAfterPublish=false,afterStart:(name:string)=>void=()=>{};
 const fence={current:()=>fenced&&proof,owned:()=>fenced},admission={available:()=>!fenced},policy={assert:()=>{throw Error("fenced");},installedMode:()=>null,instructionMode:()=>"active" as const};
 const box=new DeliveryOutbox(join(h,"delivery-outbox.db"));cleanup.push(()=>box.close());const connection=box.stageRequestContextConnection(fence),registration=connection.drain(()=>"fleet").registration();
 const configurations:any={one:{backend:"claude-code",working_directory:h},two:{backend:"codex",working_directory:h}},events:string[]=[],map=new Map<string,any>(),created:any[]=[],works=new Map<string,RequestContextPreparedWork>();
 const instance=(name:string,generation:number)=>{
  let retired=false,retireProof=true;
  const value:any={name,generation,getConfigSnapshot:()=>structuredClone(configurations[name]),
   getRequestContextLaunchSpec:()=>({config:structuredClone(configurations[name]),topicMode:true,kind:name==="two"?"classic":"fleet-topic"}),
   captureRequestContextIdle:vi.fn(async()=>({daemonBootId:`boot-${generation}`,spawnGeneration:generation,launchFenceEpoch:generation,deliveryEpoch:0,current:()=>!retired})),
   captureRequestContextRetirement:vi.fn(async()=>({daemonBootId:`boot-${generation}`,spawnGeneration:generation,launchFenceEpoch:generation,windowId:`window-${generation}`,panePid:10+generation,retired:vi.fn(async()=>retired&&retireProof)})),
   seedRequestContextReplacement:vi.fn(),prepareRequestContextStartupRetirement:vi.fn(()=>({retired:vi.fn(async()=>retired&&retireProof)})),
   stop:vi.fn(async()=>{events.push(`stop:${name}:${generation}`);retired=true;if(map.get(name)===value)map.delete(name);}),
   setRetireProof:(next:boolean)=>{retireProof=next;},retired:()=>retired};return value;
 };
 map.set("one",instance("one",1));map.set("two",instance("two",2));const originals=[...map.values()];
 const m:any=Object.create(FleetManager.prototype);Object.assign(m,{dataDir:h,managerBootId:"manager",deliveryOutbox:box,requestContextAdmission:admission,requestContextPendingWork:new RequestContextPendingWork(),
  lifecycle:{daemons:map,stopIfCurrent:vi.fn(async(name:string,value:any)=>{if(map.get(name)!==value)return false;await value.stop();return true;})},
  hubAgentConfig:(name:string)=>configurations[name]??null,contactGeneration:(name:string)=>`${name}-${configurations[name]?.backend??"removed"}`,
  prepareRequestContextDaemonOwner:(name:string,config:any,port:any,_registration:any,current:()=>boolean)=>{
   const work=new RequestContextPreparedWork(box.requestContextWork,name,m.contactGeneration(name),current,true);works.set(name,work);let registered=false,candidate:any;
   return {work,preparation:{policy:port,current:()=>work.current()},configure:(value:any,_actual:any,offered:any)=>{expect(offered.policy).toBe(port);expect(work.current()).toBe(true);candidate=value;candidate.requestContextPolicy=port;},
    sealRegistered:()=>{expect(map.get(name)).toBe(candidate);registered=true;},bound:()=>registered&&work.current()&&map.get(name)===candidate,dispose:()=>work.dispose()};
  },
  startInstance:vi.fn(async(name:string,config:any,topic:boolean,kind:string)=>{
   const prepared=m.prepareRequestContextStart?.(name,config);events.push(`start:${name}:${prepared?"candidate":"legacy"}:${kind}:${topic}`);
   if(prepared)expect(originals.every(value=>value.retired())).toBe(true);
   const candidate=instance(name,10+created.length);created.push(candidate);m.configureRequestContextBeforeStart?.(name,candidate,config,prepared);
   if(fail===name&&!failAfterPublish&&prepared){fail=null;throw Error("fixture startup failure");}
   map.set(name,candidate);afterStart(name);
   if(fail===name&&prepared){fail=null;throw Error("fixture startup failure");}
  })});
 return {m,box,connection,registration,fence,policy,events,map,originals,created,works,configurations,
  prepare:()=>m.prepareRequestContextPersistentRelaunch(policy,registration,fence,()=>drained),open:()=>{fenced=false;},invalidate:()=>{proof=false;},busy:()=>{drained=false;},
  fail:(name:string,published=false)=>{fail=name;failAfterPublish=published;},afterStart:(fn:(name:string)=>void)=>{afterStart=fn;}};
}
it("the exact persistent roster retires before any replacement, stages work before commit and preserves each launch kind",async()=>{
 const r=rig(),stage=await r.prepare();expect(stage.ready()).toBe(true);expect(r.box.requestContextWork.read("one")).toBeNull();
 expect(r.created[0].seedRequestContextReplacement).toHaveBeenCalledWith(expect.objectContaining({spawnGeneration:1,launchFenceEpoch:1}));
 expect(r.events.slice(0,2)).toEqual(["stop:one:1","stop:two:2"]);expect(r.events).toContain("start:two:candidate:classic:true");
 expect(()=>r.policy.assert()).toThrow(/fenced/);expect(()=>stage.seal()).toThrow(/not committed/);
 r.box.requestContextInstallation().activate({epoch:"e",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},{owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>stage.ready(),0,()=>stage.retain());
 stage.seal();stage.releaseStartHooks();r.open();expect(stage.executionCurrent()).toBe(true);expect(r.works.get("one")?.current()).toBe(true);
 r.map.set("later",{});expect(r.works.get("one")?.current()).toBe(true);expect(stage.executionCurrent()).toBe(true);
 await expect(stage.rollback()).rejects.toThrow(/cannot revert/);
});
it.each([false,true])("startup failure (published=%s) proves all candidate resources gone and relaunches legacy conversations",async published=>{
 const r=rig();r.fail("two",published);await expect(r.prepare()).rejects.toThrow(/fixture startup failure/);
 expect(r.created.slice(0,2).every(value=>value.retired())).toBe(true);expect(r.events).toContain("start:one:legacy:fleet-topic:true");expect(r.events).toContain("start:two:legacy:classic:true");
 expect(r.m.prepareRequestContextStart).toBeUndefined();expect(r.box.requestContextInstallation().read()).toBeNull();expect(r.works.get("one")?.current()).toBe(false);
 r.connection.restore();expect(r.box.recoverForBoot("legacy")).toEqual({queued:0,reconciliationPending:0});
});
it("a failed old-process retirement never starts a candidate or guesses that Stop was enough",async()=>{
 const r=rig();r.originals[0].setRetireProof(false);await expect(r.prepare()).rejects.toThrow(/admission stays fenced/);
 expect(r.m.startInstance).not.toHaveBeenCalled();expect(r.box.requestContextInstallation().read()).toBeNull();
});
it("a producer arrival invalidates preparation; rollback ignores that arrival only to restore owned legacy agents",async()=>{
 const r=rig();r.afterStart(name=>{if(name==="one")r.invalidate();});await expect(r.prepare()).rejects.toThrow(/not ready|changed/);
 expect(r.events).toContain("start:one:legacy:fleet-topic:true");expect(r.events).toContain("start:two:legacy:classic:true");expect(r.box.requestContextInstallation().read()).toBeNull();
});
it("rollback never resurrects a deleted or retargeted original from its captured configuration",async()=>{
 const r=rig();r.afterStart(name=>{if(name==="one")r.configurations.two={...r.configurations.two,backend:"muse"};});
 await expect(r.prepare()).rejects.toThrow(/not ready|changed/);expect(r.events.some(value=>value.startsWith("start:two:"))).toBe(false);
 expect(r.events).toContain("start:one:legacy:fleet-topic:true");
});
it("unresolved durable legacy work refuses before stopping any launch",async()=>{
 const r=rig();r.busy();await expect(r.prepare()).rejects.toThrow(/changed/);expect(r.m.lifecycle.stopIfCurrent).not.toHaveBeenCalled();expect(r.m.startInstance).not.toHaveBeenCalled();
});

it("native/IPC staging runs only after old launches retire and unwinds before legacy replacements",async()=>{
 const r=rig();r.fail("two");let staged=false;
 const after=vi.fn(async()=>{expect(r.originals.every(value=>value.retired())).toBe(true);expect(r.map.size).toBe(0);staged=true;return async()=>{expect(r.created.every(value=>value.retired())).toBe(true);staged=false;r.events.push("native-stage-undone");};});
 await expect(r.m.prepareRequestContextPersistentRelaunch(r.policy,r.registration,r.fence,()=>true,after)).rejects.toThrow(/fixture startup failure/);
 expect(after).toHaveBeenCalledOnce();expect(staged).toBe(false);expect(r.events.indexOf("native-stage-undone")).toBeLessThan(r.events.indexOf("start:one:legacy:fleet-topic:true"));
});


it("a confirmed Settings restart follows each exact stopped route and carries its execution into candidate startup",async()=>{
 const r=rig(),follow=vi.fn(async(_name:string,stop:()=>Promise<unknown>)=>{await stop();});
 const execution=new SettingsExecution({current:()=>true,snapshot:()=>"same settings",followStop:follow});
 try{
  const stage=await r.m.prepareRequestContextPersistentRelaunch(r.policy,r.registration,r.fence,()=>true,undefined,execution);
  expect(follow.mock.calls.map(call=>call[0])).toEqual(["one","two"]);
  expect(r.m.startInstance.mock.calls.every((call:any[])=>call[6]===execution)).toBe(true);
  execution.cancel();await stage.rollback(); // Cleanup does not depend on an expired decision.
  expect(r.events).toContain("start:one:legacy:fleet-topic:true");
 }finally{execution.close();}
});

it("first-On relaunch follows General through the real lifecycle queue without borrowing another card",async()=>{
 const r=rig(),lifecycle=new InstanceLifecycle({setTopicIcon:vi.fn(),ipcStoppingInstances:new Set(),instanceIpcClients:new Map(),sessionRegistry:new Map()} as any);
 Object.assign(lifecycle,{daemons:r.map});r.m.lifecycle=lifecycle;
 const route=new SettingsRouteLifetime("one",()=>true,()=>lifecycle.epochOf("one"),()=>false);
 const other=new SettingsRouteLifetime("one",()=>true,()=>lifecycle.epochOf("one"),()=>false);
 const execution=new SettingsExecution({current:route.current,snapshot:()=>"same settings",followStop:route.followStop.bind(route)});
 try{
  const stage=await r.m.prepareRequestContextPersistentRelaunch(r.policy,r.registration,r.fence,()=>true,undefined,execution);
  expect(stage.ready()).toBe(true);expect(lifecycle.epochOf("one")).toBe(2);expect(lifecycle.epochOf("two")).toBe(2);
  expect(route.current()).toBe(true);expect(other.current()).toBe(false);expect(r.box.requestContextInstallation().read()).toBeNull();
  await stage.rollback();
 }finally{execution.close();}
});
