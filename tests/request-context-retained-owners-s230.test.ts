/** Real pre-start C/D owners with private SQLite and inert Daemons: no start/stop/provider port is invoked. */
import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {FleetManager} from "../src/fleet-manager.js";
import {Daemon} from "../src/daemon.js";
import {RequestContextReferenceMap} from "../src/request-context-fence.js";
import {RequestContextPendingWork} from "../src/request-context-pending-work.js";
import {setProcessFleetLock,releaseProcessFleetLock} from "../src/fleet-lock.js";
const clean:Array<()=>void>=[];afterEach(()=>{for(const f of clean.splice(0).reverse())f();});
function rig(native=false,staging=false){
 const h=mkdtempSync(join(tmpdir(),"retained-owners-"));clean.push(()=>rmSync(h,{recursive:true,force:true}));
 const record={pid:process.pid,nonce:randomUUID(),createdAt:new Date().toISOString(),role:"fleet" as const},path=join(h,"fleet.lock"),serialized=JSON.stringify(record);writeFileSync(path,serialized);setProcessFleetLock({path,record,serialized});clean.push(()=>releaseProcessFleetLock());
 const box=new DeliveryOutbox(join(h,"delivery-outbox.db"),"manager",staging?{}:{requestContextDispatchVersion:1,requestContextRelayVersion:1});clean.push(()=>box.close());
 const connection=staging?box.stageRequestContextConnection({current:()=>true}):null;
 if(!staging)box.requestContextInstallation().activate({epoch:"e",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},{owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>true,0);
 const config:any={working_directory:h,backend:"claude-code",log_level:"silent",...(native?{runtime:"windows",native_adapter:"exec",machine_id:"fixture"}:{})},logger:any={info(){},warn(){},error(){},debug(){},child(){return this;}};
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{dataDir:h,deliveryOutbox:box,managerBootId:"manager",lifecycle:{daemons:new Map()},fleetConfig:{instances:{worker:config}},adapters:new Map(),worlds:new Map(),logger,getInstanceDir:(name:string)=>join(h,"instances",name),getDeliveryEpoch:()=>0,contactDeliveryCurrent:()=>true});
 const admission={available:()=>false,subscribe:()=>()=>{},arrived(){},changed(){},wait:async()=>false};fm.attachRequestContextAdmission(admission);
 fm.hubAgentIncarnation("worker",config,true,true);const incarnation=fm.contactGeneration("worker"),work={instance:"worker",incarnation,generation:randomUUID()};if(!staging)box.requestContextWork.retain(work);
 let live=true;const policy:any={installedMode:()=>null,instructionMode:()=>"active",assert:()=>{throw Error("not published");}},registration=(connection?connection.drain(()=>"fleet"):box.requestContextDrain(()=>"fleet")).registration();
 const factory=fm.installRequestContextRetainedOwners(policy,registration,()=>live,[],staging?{firstOnStage:connection!,deferStartHooks:true}:{});
 const daemon=(cfg=config):any=>new Daemon("worker",cfg,h,true,undefined,undefined,logger);
 const bind=async(cfg=config)=>{await factory.beforeStart("worker",cfg);const prepared=fm.prepareRequestContextStart("worker",cfg),d=daemon(cfg);fm.configureRequestContextBeforeStart("worker",d,cfg,prepared);d.bindRequestContextPolicy(policy);fm.daemons.set("worker",d);fm.requestContextOwnerStarted("worker",d);return d;};
 const retire=(d:any)=>{d.startupAborted=true;fm.daemons.delete("worker");};
 return {h,fm,box,config,work,factory,policy,registration,daemon,bind,retire,connection,live:(value:boolean)=>{live=value;}};
}
it("capable boot binds retained work before startup and exposes no serving input or restored turn",async()=>{
 const r=rig(),d=await r.bind();expect(d.captureRequestContextOwner()).toMatchObject({incarnation:r.work.incarnation,workGeneration:r.work.generation});expect(d.requestContextTurnSnapshot()).toBeNull();
 expect(r.factory.hub("worker")).not.toBeNull();expect(r.factory.turnView(randomUUID())).toMatchObject({registration:r.registration,references:[],unknown:false});expect(r.fm.requestContextPolicy).toBeUndefined();
});
it("a normal restart proves its exact prior resource receipt and keeps work while fencing the old daemon",async()=>{
 const r=rig(),old=await r.bind(),before=old.captureRequestContextOwner();r.retire(old);const next=await r.bind();
 expect(next.captureRequestContextOwner().workGeneration).toBe(before.workGeneration);expect(next.captureRequestContextOwner().spawnGeneration).toBeGreaterThan(before.spawnGeneration);
 expect(next.captureRequestContextOwner().launchFenceEpoch).toBeGreaterThan(before.launchFenceEpoch);expect(()=>old.captureRequestContextOwner()).toThrow(/no longer current|owner changed/);
});
it("a live or unretired prior owner is never hot-bound or replaced",async()=>{
 const r=rig(),d=await r.bind();await expect(r.factory.beforeStart("worker",r.config)).rejects.toThrow(/still running/);
 r.fm.daemons.delete("worker");await expect(r.factory.beforeStart("worker",r.config)).rejects.toThrow(/not retired/);expect(r.box.requestContextWork.read("worker")).toEqual(r.work);expect(d.requestContextCallsRequired()).toBe(true);
});
it("a recorded successor registers only after the old factory's exact resource retirement",async()=>{
 const r=rig(),old=await r.bind();r.retire(old);const cfg={...r.config,backend:"codex"};r.fm.fleetConfig.instances.worker=cfg;r.fm.observeHubAgentIncarnations(true);
 const next=await r.bind(cfg);expect(next.captureRequestContextOwner().incarnation).not.toBe(r.work.incarnation);expect(next.captureRequestContextOwner().workGeneration).not.toBe(r.work.generation);
});
it("a missing previously registered row never becomes first birth on restart",async()=>{
 const r=rig(),old=await r.bind();r.retire(old);(r.box as any).db.prepare("DELETE FROM request_context_work_v1 WHERE instance='worker'").run();
 await expect(r.factory.beforeStart("worker",r.config)).rejects.toThrow(/consumed/);expect(r.box.requestContextWork.read("worker")).toBeNull();
});
it("native boot constructs a distinct retained C lane without a provider or MCP grant",async()=>{
 const r=rig(true);await r.factory.beforeStart("worker",r.config);expect(r.factory.execOwner("worker")).toMatchObject({instance:"worker",incarnation:r.work.incarnation,workGeneration:r.work.generation});
 expect(r.factory.execTurns("worker").current(r.factory.execOwner("worker"))).toBeNull();expect(()=>r.factory.execOwner("other")).toThrow(/unavailable/);expect(r.fm.fleetWindowsRuntime).toBeUndefined();
});
it("lost process ownership refuses further registration and native owner lookup",async()=>{
 const r=rig(true);await r.factory.beforeStart("worker",r.config);r.live(false);expect(r.factory.current()).toBe(false);await expect(r.factory.beforeStart("worker",r.config)).rejects.toThrow(/changed/);expect(()=>r.factory.execOwner("worker")).toThrow(/unavailable/);
});

it("an unconfigured preparation can be superseded but its stale start can never acquire the new owner",async()=>{
 const r=rig();await r.factory.beforeStart("worker",r.config);const old=r.fm.prepareRequestContextStart("worker",r.config);
 await r.factory.beforeStart("worker",r.config);expect(old.current()).toBe(false);
 expect(()=>r.fm.configureRequestContextBeforeStart("worker",r.daemon(),r.config,old)).toThrow(/differs/);
 const fresh=r.fm.prepareRequestContextStart("worker",r.config),d=r.daemon();r.fm.configureRequestContextBeforeStart("worker",d,r.config,fresh);expect(d.requestContextCallsRequired()).toBe(true);
});
it("an idle native lane survives repeated profile preparation without changing its C identity",async()=>{
 const r=rig(true);await r.factory.beforeStart("worker",r.config);const lane=r.factory.execTurns("worker"),owner=r.factory.execOwner("worker");
 await r.factory.beforeStart("worker",r.config);expect(r.factory.execTurns("worker")).toBe(lane);expect(r.factory.execOwner("worker")).toEqual(owner);
});

it("first-On native owners stage without schemas or hooks, retain only in the activation COMMIT, then attach",async()=>{
 const r=rig(true,true);await r.factory.beforeStart("worker",r.config);const owner=r.factory.execOwner("worker");
 expect(r.box.requestContextWork.read("worker")).toBeNull();expect(r.fm.prepareRequestContextStart).toBeUndefined();expect(()=>r.factory.retain()).toThrow(/ready/);
 r.box.requestContextInstallation().activate({epoch:"first",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},{owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>r.connection!.current(),0,()=>r.factory.retain());
 r.factory.seal();r.factory.attach();expect(r.box.requestContextWork.read("worker")?.generation).toBe(owner.workGeneration);expect(r.factory.execOwner("worker")).toEqual(owner);await expect(r.factory.disposeStaged()).rejects.toThrow(/cannot revert/);
});
it("abandoning a first-On native preparation disposes only its staged owners and leaves no compatibility floor",async()=>{
 const r=rig(true,true);await r.factory.beforeStart("worker",r.config);await r.factory.disposeStaged();expect(r.factory.current()).toBe(false);expect(r.fm.prepareRequestContextStart).toBeUndefined();expect(r.box.requestContextInstallation().read()).toBeNull();
 r.connection!.restore();expect(()=>r.box.activateRequestContextBarrier()).toThrow(/v1/);
});

it("whole-Fleet drain views include calls and Hub inputs and never silently omit a missing turn view",async()=>{
 const r=rig(),d=await r.bind(),root=randomUUID();
 expect(r.factory.callView(root)).toMatchObject({registration:r.registration,references:[],unknown:false});
 expect(r.factory.inputView(root)).toMatchObject({registration:r.registration,references:[],unknown:false});
 const revision=r.factory.revision();d.requestContextTurnDrainView=()=>null;
 expect(r.factory.turnView(root).unknown).toBe(true);expect(r.factory.revision()).not.toBe(revision);
});
it("an unregistered live daemon makes every aggregate incomplete instead of disappearing from the drain proof",async()=>{
 const r=rig();await r.bind();const root=randomUUID(),revision=r.factory.callRevision();
 r.fm.daemons.set("unregistered",r.daemon());
 expect(r.factory.turnView(root).unknown).toBe(true);expect(r.factory.callView(root).unknown).toBe(true);expect(r.factory.inputView(root).unknown).toBe(true);
 expect(r.factory.callRevision()).not.toBe(revision);
});

it("queued reply recovery protects its captured root even before the paste queue runs, then releases that exact registration",async()=>{
 const r=rig(),d=await r.bind(),root=randomUUID();let release!:()=>void;
 d.pasteLock=new Promise<void>(resolve=>{release=resolve;});d.currentReplyRecovery=()=>null;
 d.workingTurnRequestContext={generation:42,snapshot:{context:{ref:{rootContextId:root}}}};
 const before=r.factory.inputRevision();d.queueReplyRecoveryPrompt({generation:42});
 expect(r.factory.inputView(root).references).toHaveLength(1);expect(r.factory.inputRevision()).not.toBe(before);
 expect(r.factory.inputView(randomUUID()).references).toEqual([]);
 release();await d.pasteLock;expect(r.factory.inputView(root)).toMatchObject({references:[],unknown:false});
});

it("a missing retained work row invalidates aggregate revisions even when the turn is empty",async()=>{
 const r=rig();await r.bind();const root=randomUUID(),before=r.factory.revision();
 (r.box as any).db.prepare("DELETE FROM request_context_work_v1 WHERE instance='worker'").run();
 expect(r.factory.turnView(root).unknown).toBe(true);expect(r.factory.callView(root).unknown).toBe(true);expect(r.factory.inputView(root).unknown).toBe(true);
 expect(r.factory.revision()).not.toBe(before);
});

it("a root-retirement fence refuses queued recovery without throwing from the timer path or leaking a reference",async()=>{
 const r=rig(),d=await r.bind(),root=randomUUID(),context={ref:{version:1 as const,contextId:root,rootContextId:root},rootEvidenceRef:"outside",
  initiatingActor:{kind:"unknown" as const,reason:"unidentified" as const},ingress:"restricted-room" as const,source:{instance:"worker",incarnation:r.work.incarnation},sourceAudience:{kind:"room" as const,ref:root}};
 r.box.requestContextRecovery.retain(context);r.box.requestContextDrain(()=>"fleet").fence(root);
 d.workingTurnRequestContext={generation:42,snapshot:{context}};let refused=0;d.reportUnrecoveredReplyDrop=()=>{refused++;};
 expect(()=>d.queueReplyRecoveryPrompt({generation:42})).not.toThrow();expect(refused).toBe(1);expect(r.factory.inputView(root).references).toEqual([]);
});

it("failed first-On Fleet-call registration restores only an empty disconnected map and cannot revive an old stage",()=>{
 const r=rig(false,true),original=new RequestContextReferenceMap<string,any>(()=>null,()=>"legacy");
 Object.assign(r.fm,{requestContextFleetCalls:original,instanceIpcClients:new Map(),requestContextPendingWork:new RequestContextPendingWork()});
 const stage=r.fm.stageRequestContextFleetRegistration(r.registration,()=>true);expect(stage.current()).toBe(true);
 expect(r.fm.requestContextFleetDrainView(randomUUID()).registration).toBe(r.registration);
 const finish=r.fm.requestContextPendingWork.begin("worker");expect(()=>stage.restore()).toThrow(/cannot revert/);finish();
 r.fm.requestContextFleetCalls.set("active",{call:{id:"call",admission:{coverage:"not-covered"}}});expect(()=>stage.restore()).toThrow(/cannot revert/);r.fm.requestContextFleetCalls.clear();
 stage.restore();expect(r.fm.requestContextFleetCalls).toBe(original);expect(stage.current()).toBe(false);
 const fresh=r.fm.stageRequestContextFleetRegistration(r.connection!.drain(()=>"fleet").registration(),()=>true);expect(stage.current()).toBe(false);fresh.restore();
});
it("a committed floor forbids restoring the first-On Fleet-call map",()=>{
 const r=rig(false,true),original=new RequestContextReferenceMap<string,any>(()=>null,()=>"legacy");
 Object.assign(r.fm,{requestContextFleetCalls:original,instanceIpcClients:new Map(),requestContextPendingWork:new RequestContextPendingWork()});
 const stage=r.fm.stageRequestContextFleetRegistration(r.registration,()=>true);
 r.box.requestContextInstallation().activate({epoch:"first",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},{owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>true,0);
 expect(()=>stage.restore()).toThrow(/cannot revert/);expect(r.fm.requestContextFleetCalls).not.toBe(original);expect(stage.current()).toBe(true);
});

it("ordinary positive Stop retirement removes only the exact live registry owner, preserving its work and recovery history",async()=>{
 const r=rig(),old=await r.bind(),before=r.box.requestContextWork.read("worker"),launch=old.captureRequestContextOwner();r.retire(old);
 expect(r.factory.turnView(randomUUID()).unknown).toBe(true);
 await r.fm.requestContextOwnerStopped("worker",old,async()=>false);expect(r.factory.turnView(randomUUID()).unknown).toBe(true);
 await r.fm.requestContextOwnerStopped("worker",old,async()=>true);
 expect(r.factory.turnView(randomUUID())).toMatchObject({references:[],unknown:false});expect(r.box.requestContextWork.read("worker")).toEqual(before);
 const next=await r.bind();expect(next).not.toBe(old);expect(next.captureRequestContextOwner().workGeneration).toBe(before!.generation);expect(next.captureRequestContextOwner().spawnGeneration).toBeGreaterThan(launch.spawnGeneration);expect(next.captureRequestContextOwner().launchFenceEpoch).toBeGreaterThan(launch.launchFenceEpoch);
});
