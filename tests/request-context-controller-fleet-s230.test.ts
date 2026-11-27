import {ContactHeldError} from "../src/contact-auth-service.js";
import {captureRequestContextCall} from "../src/request-context-call.js";
import {RequestContextLocalTurns} from "../src/request-context-turns.js";
import type {RequestContextV1} from "../src/request-context-protocol.js";
import {randomUUID} from "node:crypto";
import {requestContextDigest} from "../src/request-context-store.js";
/** Real controller/installer/serving stores; every physical port is an inert double. Never a live Fleet start. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {FleetManager} from "../src/fleet-manager.js";
import {RequestContextReferenceMap} from "../src/request-context-fence.js";
import {RequestContextPendingWork} from "../src/request-context-pending-work.js";
import {SettingsExecution} from "../src/settings-transaction.js";
import {acquireFleetLock,setProcessFleetLock,releaseProcessFleetLock} from "../src/fleet-lock.js";
const clean:Array<()=>void>=[];afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();vi.restoreAllMocks();});
function manager(home:string){
 const m:any=Object.assign(Object.create(FleetManager.prototype),{dataDir:home,configPath:join(home,"fleet.yaml"),managerBootId:`manager-${Math.random()}`,fleetConfig:{instances:{},defaults:{}},
  lifecycle:{daemons:new Map()},requestContextPendingWork:new RequestContextPendingWork(),requestContextFleetCalls:new RequestContextReferenceMap((row:any)=>row.root,(_row:any,id:string)=>id),instanceIpcClients:new Map(),
  requestContextRetirementProofs:new Map(),requestContextRootRetired:(_drain:any,root:string)=>m.requestContextRetirementProofs.get(root)?.current()===true,requestContextCutoverErrors:[],settingsRuntimeRevision:0,
  logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()},emitSseEvent:vi.fn(),needsYou:{poke:vi.fn()},scheduleDeliveryOutboxPump:vi.fn(),
  initializeWorkingRecovery:vi.fn(),sweepContactAuthorizationOutcomes:vi.fn(),createWakeCoordinator:()=>({start(){},kick(){}}),
  requestContextActivationLease:()=>({current:()=>true,release:vi.fn()}),postFleetSecurityNotice:vi.fn(),
  retireRequestContextNativeFactories:vi.fn(async()=>{m.requestContextNativeGraph=undefined;m.nativeMcpStore=null;m.fleetWindowsRuntime=null;m.paneManager=null;}),
  nativeInstanceRuntime:()=>m.fleetWindowsRuntime??=native(),nativePanes:async()=>m.paneManager??=native(),
  adapters:new Map(),worlds:new Map(),contactDefaultApprovers:()=>[],getDeliveryEpoch:()=>0});
 function native(){const registration=m.requestContextNativeGraph.registration;return {drainRevision:"native",offRevision:"native",drainView:()=>({registration,revision:"native",references:[],unknown:false}),offView:()=>({registration,revision:"native",references:[],unknown:false}),requestContextPhysicallyIdle:()=>true,requestContextStops:()=>[]};}
 m.ensureDeliveryOutbox();clean.push(()=>{clearTimeout(m.requestContextDrainTimer);clearInterval(m.requestContextCollectionTimer);clearInterval(m.replyObligationTimer);m.deliveryOutbox?.close();});return m;
}
function rig(allowSyntheticEnable=true){const h=mkdtempSync(join(tmpdir(),"controller-fleet-"));clean.push(()=>rmSync(h,{recursive:true,force:true}));setProcessFleetLock(acquireFleetLock(h));clean.push(()=>releaseProcessFleetLock());const m=manager(h);
 // Full-mode proofs deliberately bypass only the production release guard.
 if(allowSyntheticEnable)m.requestContextControl.ports.enableUnavailable=()=>false;
 const actor=()=>{const execution=new SettingsExecution({current:()=>true,snapshot:()=>"stable"});clean.push(()=>execution.close());return {binding:"verified-owner",verified:true,person:{platform:"host"as const,adapterId:"host",userId:"operator",label:"Operator"},execution,current:()=>true};};
 return {h,m,actor};}
it("actual default Off exposes the stable Settings host and passive reads create no activation artifact",()=>{
 const r=rig();expect(r.m.requestContextControl).toBeDefined();expect(r.m.requestContextControl.read(r.actor())).toMatchObject({phase:"off",everActivated:false,attempted:false});
 const db=new Database(join(r.h,"delivery-outbox.db"),{readonly:true});try{expect(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'request_context_%'").get()).toEqual({n:0});}finally{db.close();}
 expect(r.m.postFleetSecurityNotice).not.toHaveBeenCalled();expect(r.m.requestContextAdmission).toBeUndefined();
});
it("the actual confirmed controller commits and publishes once, then drains to capable Off without a legacy fallback",async()=>{
 const r=rig(),actor=r.actor(),host=r.m.requestContextControl,view=host.read(actor);
 const on=await host.change({revision:view.revision,action:"enable"},actor);expect(on).toMatchObject({enabled:true,phase:"on",everActivated:true});expect(r.m.postFleetSecurityNotice).toHaveBeenCalledOnce();expect(r.m.requestContextAdmission.available()).toBe(true);
 const next=r.actor(),offered=host.read(next);await host.change({revision:offered.revision,action:"disable"},next);
 const state=r.m.deliveryOutbox.requestContextInstallation().read();expect(state.mode).toBe("draining");r.m.requestContextModes.off.advance(state.revision);
 expect(host.read(r.actor())).toMatchObject({phase:"off",everActivated:true});expect(r.m.requestContextAdmission.available()).toBe(true);expect(r.m.requestContextPolicy.installedMode()).toBe("off");
});
it("an actual failed publication followed by a new boot can turn Off using real reconstructed ports and empty known registries",async()=>{
 const r=rig();r.m.bindRequestContextServingPublication=()=>{throw Error("fixture publication failure");};const actor=r.actor(),view=r.m.requestContextControl.read(actor);
 await expect(r.m.requestContextControl.change({revision:view.revision,action:"enable"},actor)).rejects.toThrow(/publication failure/);expect(r.m.deliveryOutbox.requestContextInstallation().read().mode).toBe("active");expect(r.m.requestContextAdmission.available()).toBe(false);
 r.m.deliveryOutbox.close();releaseProcessFleetLock();setProcessFleetLock(acquireFleetLock(r.h));const restarted=manager(r.h);await restarted.prepareRequestContextCapableBoot(()=>false);
 expect(restarted.requestContextAdmission.available()).toBe(false);const owner=r.actor(),offered=restarted.requestContextControl.read(owner);await restarted.requestContextControl.change({revision:offered.revision,action:"disable"},owner);
 const draining=restarted.deliveryOutbox.requestContextInstallation().read();restarted.requestContextModes.off.advance(draining.revision);
 expect(restarted.requestContextControl.read(r.actor())).toMatchObject({phase:"off",everActivated:true});expect(restarted.requestContextAdmission.available()).toBe(true);
});
it("update exclusion loss cannot leave a floor or notice behind",async()=>{
 const r=rig();r.m.requestContextActivationLease=()=>null;const actor=r.actor(),view=r.m.requestContextControl.read(actor);
 const blocked=await r.m.requestContextControl.change({revision:view.revision,action:"enable"},actor);expect(blocked).toMatchObject({phase:"blocked",everActivated:false});expect(r.m.deliveryOutbox.requestContextInstallation().read()).toBeNull();expect(r.m.postFleetSecurityNotice).not.toHaveBeenCalled();
});

it("same-boot failed publication also retains a genuine prepared Off path after the failed browser decision",async()=>{
 const r=rig();r.m.bindRequestContextServingPublication=()=>{throw Error("fixture bind failure");};const actor=r.actor(),host=r.m.requestContextControl,view=host.read(actor);
 await expect(host.change({revision:view.revision,action:"enable"},actor)).rejects.toThrow(/bind failure/);
 expect(r.m.requestContextModes.current()).toBe(true);expect(r.m.requestContextAdmission.available()).toBe(false);
 const owner=r.actor(),offered=host.read(owner);await host.change({revision:offered.revision,action:"disable"},owner);
 const state=r.m.deliveryOutbox.requestContextInstallation().read();r.m.requestContextModes.off.advance(state.revision);
 expect(host.read(r.actor())).toMatchObject({phase:"off",everActivated:true});expect(r.m.requestContextAdmission.available()).toBe(true);
});

it("the actual blocked Settings attempt reaches Needs you and the projected control SSE, without default-Off nagging",async()=>{
 const r=rig(),host=r.m.requestContextControl;host.read(r.actor());expect(r.m.needsYouItems()).toEqual([]);
 r.m.requestContextActivationLease=()=>null;const actor=r.actor(),view=host.read(actor);
 await host.change({revision:view.revision,action:"enable"},actor);
 const items=r.m.needsYouItems();expect(items).toHaveLength(1);expect(items[0]).toMatchObject({reason:"request_context_cutover",requestContextCutover:{attempted:true,phase:"blocked"}});
 expect(r.m.needsYouItems()[0].since).toBe(items[0].since);
 expect(r.m.emitSseEvent).toHaveBeenCalledWith("request-context-control",expect.objectContaining({attempted:true,phase:"blocked"}));
 expect(r.m.emitSseEvent).toHaveBeenCalledWith("needs",{items});
});

it("failed cold construction before Modes assignment can retry behind the held fence and complete explicit Off",async()=>{
 const r=rig(),host=r.m.requestContextControl,actor=r.actor();await host.change({revision:host.read(actor).revision,action:"enable"},actor);
 r.m.deliveryOutbox.close();releaseProcessFleetLock();setProcessFleetLock(acquireFleetLock(r.h));const cold=manager(r.h),prepare=cold.prepareRequestContextDrainOwners.bind(cold);
 cold.prepareRequestContextDrainOwners=vi.fn().mockRejectedValueOnce(Error("fixture construction failure")).mockImplementation(prepare);
 await expect(cold.prepareRequestContextCapableBoot(()=>false)).rejects.toThrow(/construction failure/);expect(cold.requestContextModes).toBeUndefined();
 const owner=r.actor(),view=cold.requestContextControl.read(owner);await cold.requestContextControl.change({revision:view.revision,action:"disable"},owner);
 const state=cold.deliveryOutbox.requestContextInstallation().read();cold.requestContextModes.off.advance(state.revision);expect(cold.requestContextControl.read(r.actor())).toMatchObject({phase:"off",everActivated:true});
});
it("a stopped same-manager assembly reconstructs from durable mode with no reuse of its old serving graph",async()=>{
 const r=rig(),host=r.m.requestContextControl,actor=r.actor();await host.change({revision:host.read(actor).revision,action:"enable"},actor);
 const old=r.m.requestContextBoot,oldAdmission=r.m.requestContextAdmission;r.m.shuttingDown=true;oldAdmission.changed();await r.m.resetStoppedRequestContextAssembly();
 expect(oldAdmission.available()).toBe(false);expect(r.m.deliveryOutbox).toBeNull();expect(r.m.requestContextNativeGraph).toBeUndefined();
 releaseProcessFleetLock();setProcessFleetLock(acquireFleetLock(r.h));r.m.shuttingDown=false;r.m.ensureDeliveryOutbox();await r.m.prepareRequestContextCapableBoot(r.m.requestContextRootRetired);await r.m.prepareRequestContextFutureOwners();r.m.requestContextModes.publish(()=>true);
 expect(r.m.requestContextBoot).not.toBe(old);expect(r.m.requestContextAdmission).not.toBe(oldAdmission);expect(r.m.requestContextPolicy.installedMode()).toBe("active");expect(oldAdmission.available()).toBe(false);
});

it("the production collector uses F's exact proof and E's atomic retention rules, never age alone",async()=>{
 const r=rig(),actor=r.actor(),host=r.m.requestContextControl;
 await host.change({revision:host.read(actor).revision,action:"enable"},actor);
 const box=r.m.deliveryOutbox,root=randomUUID(),context={ref:{version:1 as const,contextId:root,rootContextId:root},rootEvidenceRef:"collector-fixture",initiatingActor:{kind:"unknown" as const,reason:"unproved-recovery" as const},ingress:"restricted-room" as const,source:{instance:"worker",incarnation:"current"},sourceAudience:{kind:"instance" as const,ref:root}},payload={type:"fleet_inbound",content:"fixture",meta:{}},operationId=randomUUID();
 const delivery=box.admitWithRequestContext({operationId,sourceKey:operationId,sourceInstance:"worker",sourceDaemonBootId:"fixture",targetInstance:"target",kind:"fleet_inbound",payload},context,{version:1,operationId,contextId:root,rootContextId:root,source:context.source,target:{instance:"target",incarnation:"current"},verb:"send_to_instance",payloadSha256:requestContextDigest(payload)}).delivery;
 r.m.collectRequestContextRoots();expect(box.requestContext(root)).not.toBeNull();
 (box as any).db.prepare("UPDATE deliveries SET state='failed',finished_at='2000-01-01T00:00:00Z',updated_at='2000-01-01T00:00:00Z' WHERE delivery_id=?").run(delivery.deliveryId);
 const drain=r.m.requestContextModes.drain,registration=drain.registration(),revision="fixture";
 const remove=drain.register("daemon-calls","fixture",{registration,revision:()=>revision,inspect:()=>({registration,revision,references:[],unknown:true})});
 r.m.collectRequestContextRoots();expect(box.requestContext(root)).not.toBeNull();remove();r.m.logger.debug.mockClear();
 r.m.collectRequestContextRoots();expect(r.m.logger.debug.mock.calls).toEqual([]);expect(box.requestContext(root)).toBeNull();expect(box.get(delivery.deliveryId)).toBeUndefined();expect(r.m.requestContextRetirementProofs.size).toBe(0);
});

it.each(["owner","free-room","restricted-room","guest","hub"] as const)("confirmed production assembly carries %s through C, the installed policy, E/I, B and receiving C",async ingress=>{
 const r=rig(),admin={platform:"host"as const,adapterId:"host",userId:"operator",label:"Operator"};
 r.m.contactGeneration=()=>"current";r.m.contactAdminOf=(_name:string,person:any)=>person.userId==="operator";r.m.requestContextNativeAdmissionCurrent=()=>true;
 r.m.contactService=()=>({host:{store:r.m.deliveryOutbox.contactAuthorizations,defaultApprovers:()=>[admin],changed:vi.fn()}});
 const actor=r.actor(),host=r.m.requestContextControl;await host.change({revision:host.read(actor).revision,action:"enable"},actor);
 const box=r.m.deliveryOutbox,id=randomUUID(),context:RequestContextV1={ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"matrix",ingress,source:{instance:"a",incarnation:"current"},
  initiatingActor:ingress==="hub"?{kind:"person",platform:"hub",hubId:randomUUID(),id:"directory/demo",displayName:"Demo person"}:{kind:"person",platform:"discord",userId:"outside",displayName:"Demo person"},sourceAudience:{kind:ingress==="hub"?"hub":"room",ref:randomUUID()}};
 const owner=(instance:string)=>({instance,incarnation:"current",workGeneration:"matrix-work",daemonBootId:`boot-${instance}`,spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0}),wire=requestContextDigest("matrix wire"),inputId=randomUUID(),registration=r.m.requestContextNativeGraph.registration;
 const turns=new RequestContextLocalTurns({registration,input:()=>({inputId,wireSha256:wire,owner:owner("a"),context,proof:{kind:"independent"}}),context:key=>box.requestContext(key),retain:value=>box.requestContextRecovery.retain(value),canManage:()=>false,recovery:()=>null,saveRecovery:()=>{}});
 const snapshot=turns.beforeWrite(inputId,wire,owner("a")),lease=captureRequestContextCall(snapshot,value=>turns.isCurrent(value,owner("a")));
 const send=(sourceContext:RequestContextV1,target:string,call=lease)=>{const op=randomUUID();return r.m.requestContextRelay.admit({operationId:op,sourceInstance:sourceContext.source.instance,sourceDaemonBootId:call.snapshot.owner.daemonBootId,targetInstance:target,targetSession:target,kind:"fleet_inbound",payload:{type:"fleet_inbound",content:"Matrix message",meta:{request_kind:"query",from_instance:sourceContext.source.instance}}},{instance:sourceContext.source.instance,tool:"send_to_instance",args:{instance_name:target},admission:{coverage:"covered",lease:call}},()=>true);};
 let deliveryId:string;
 if(ingress==="restricted-room"||ingress==="guest"){
  let ticket="";try{send(context,"b");}catch(error){if(!(error instanceof ContactHeldError))throw error;ticket=error.result.authorization_id;}expect(ticket).not.toBe("");
  const principal={person:admin,binding:"matrix-owner",verified:true,current:()=>true},card=r.m.requestContactCardsPort.read(ticket,principal);
  const decided=r.m.requestContactCardsPort.decide(ticket,{snapshot:card.snapshot,decision:"approve-once"},principal);deliveryId=decided.ticket.deliveryId!;
  const clock=vi.spyOn(box.contactAuthorizations as any,"now").mockReturnValue(Date.now()+2*60_000);
  (FleetManager.prototype as any).sweepContactAuthorizationOutcomes.call(r.m);(FleetManager.prototype as any).sweepContactAuthorizationOutcomes.call(r.m);clock.mockRestore();
  const notices=box.listPending().filter((row:any)=>row.payload.meta?.source==="agend-system");expect(notices).toHaveLength(1);
  expect(box.requestContextForDelivery(notices[0].deliveryId).binding.rootContextId).toBe(id);expect(notices[0].payload.meta).not.toHaveProperty("authority");expect(r.m.logger.error).not.toHaveBeenCalled();
 }else deliveryId=send(context,"b").deliveryId;
 expect(box.requestContextForDelivery(deliveryId).binding.rootContextId).toBe(id);
 const delivered=box.get(deliveryId);expect(delivered.payload.content.includes("Hub")).toBe(ingress==="hub");
 if(ingress==="hub")for(const tool of ["get_fleet_config","get_web_settings","get_instance_logs","get_usage","get_cache_report"])expect(()=>r.m.requestContextPolicy.assert({instance:"a",tool,args:{},admission:{coverage:"covered",lease}})).toThrow();
 const claim=box.claimNext(r.m.managerBootId,()=>"boot-b",new Set())!;expect(claim.deliveryId).toBe(deliveryId);
 const prepared=box.prepareRequestContextDeliveryInput(deliveryId,claim.attemptNo,owner("b"),wire,()=>true),receiver=new RequestContextLocalTurns({registration,input:()=>prepared,context:key=>box.requestContext(key),retain:value=>box.requestContextRecovery.retain(value),canManage:()=>false,recovery:()=>null,saveRecovery:()=>{}});
 const received=receiver.beforeWrite(prepared.inputId,wire,owner("b"));expect(received.context.initiatingActor).toEqual(context.initiatingActor);expect(received.context.ref.rootContextId).toBe(id);
 const nextLease=captureRequestContextCall(received,value=>receiver.isCurrent(value,owner("b")));expect(send(received.context,"c",nextLease).state).toBe("queued");
 turns.ended(snapshot,owner("a"));expect(()=>send(context,"d")).toThrow();
});
it("an unmapped first-On failure remains visible after rollback and logs its private cause only to the daemon",async()=>{
 const r=rig(),host=r.m.requestContextControl,actor=r.actor(),view=host.read(actor),cause=Error("PRIVATE_STOP_FAILURE");
 r.m.prepareRequestContextFirstOnAssembly=vi.fn().mockRejectedValueOnce(cause);
 await expect(host.change({revision:view.revision,action:"enable"},actor)).rejects.toBe(cause);
 expect(host.read(r.actor())).toMatchObject({enabled:false,everActivated:false,phase:"blocked",enableFailed:true});
 expect(r.m.needsYouItems()).toContainEqual(expect.objectContaining({reason:"request_context_cutover",requestContextCutover:expect.objectContaining({enableFailed:true})}));
 expect(r.m.logger.warn).toHaveBeenCalledWith({err:cause},"Request-context enable did not finish");
 expect(JSON.stringify(host.snapshot())).not.toContain("PRIVATE_STOP_FAILURE");expect(r.m.deliveryOutbox.requestContextInstallation().read()).toBeNull();
 expect(r.m.postFleetSecurityNotice).not.toHaveBeenCalled();
});

it("S-274: the production release guard refuses On before relaunch, activation or publication", async()=>{
 const r=rig(false),actor=r.actor(),view=r.m.requestContextControl.read(actor);
 expect(view).toMatchObject({enabled:false,enableUnavailable:true});
 const stage=vi.spyOn(r.m,"prepareRequestContextFirstOnAssembly");
 await expect(r.m.requestContextControl.change({revision:view.revision,action:"enable"},actor)).rejects.toThrow("request-context-enable-unavailable");
 expect(stage).not.toHaveBeenCalled();expect(r.m.deliveryOutbox.requestContextInstallation().read()).toBeNull();
 expect(r.m.postFleetSecurityNotice).not.toHaveBeenCalled();expect(r.m.requestContextAdmission).toBeUndefined();
});

it("M-3896 the verified owner settles an exact uncertain input through the real draining controller",async()=>{
 const {nativeHumanOrigin}=await import("../src/human-delivery-receipts.js");
 const {readRequestContextResolution}=await import("../src/request-context-resolution.js");
 const r=rig(),host=r.m.requestContextControl,owner=()=>({...r.actor(),binding:"a".repeat(64)}),onOwner=owner();
 const {acquireRequestContextActivationLease}=await import("../src/request-context-update-guard.js");
 const {acquireHomeUpdateLock}=await import("../src/home-update-lock.js");
 const {takeExclusiveLease}=await import("../src/state-lease.js");
 let sequence=0;const lockDeps={pid:process.pid,processStart:()=>"Thu Nov 26 01:00:00 2026",exists:()=>true,newToken:()=>String(++sequence).padStart(32,"0"),now:()=>new Date(),log:()=>{}};

 await host.change({revision:host.read(onOwner).revision,action:"enable"},onOwner);
 const box=r.m.deliveryOutbox,saved=box.createHumanReceiptWithRequestContext({targetInstance:"worker",originalBody:"Synthetic waiting input",origin:nativeHumanOrigin("discord","fixture","person","Person",false,"synthetic-message")!,inputKind:"fleet_inbound",managerBootId:r.m.managerBootId},
  {incarnation:"current",room:null,web:null,route:{kind:"room",adapterId:"fixture",chatId:"synthetic-room"},platform:()=>"discord"});
 const db=(box as any).db,root=saved.context.ref.rootContextId;
 db.prepare("UPDATE human_delivery_receipts SET state='uncertain' WHERE receipt_id=?").run(saved.receipt.receipt_id);
 const offOwner=owner();await host.change({revision:host.read(offOwner).revision,action:"disable"},offOwner);
 let actor=owner(),view=host.read(actor),blocker=view.blockers.find((row:any)=>row.id.startsWith(`work:${root}:`));
 expect(blocker).toMatchObject({kind:"work",labels:["worker"],families:["human-input"],action:"stop-work"});
 const before=box.getHumanReceipt(saved.receipt.receipt_id);
 r.m.requestContextActivationLease=()=>acquireRequestContextActivationLease(r.h,"/fixture/install",lockDeps,{current:()=>true});
 // A crash/failure after fencing cannot turn an uncertain receipt into delivery.
 const stop=vi.spyOn(r.m,"stopRequestContextWork").mockRejectedValueOnce(Error("retirement unavailable"));
 await expect(host.change({revision:view.revision,action:"resolve",blockerId:blocker.id,resolution:"stop-work"},actor)).rejects.toThrow(/retirement/);
 stop.mockRestore();const firstEpoch=r.m.requestContextModes.drain.retainedEpoch(root);expect(firstEpoch).toBeTruthy();expect(readRequestContextResolution(db,root)).toBeNull();
 actor=owner();view=host.read(actor);blocker=view.blockers.find((row:any)=>row.id.startsWith(`work:${root}:`));
 const originalStop=r.m.stopRequestContextWork.bind(r.m);
 const guardedStop=vi.spyOn(r.m,"stopRequestContextWork").mockImplementation(async(...args:any[])=>{
  // The attempted restore cannot acquire either exclusion anywhere between the
  // durable root fence and its resolution COMMIT.
  expect(acquireHomeUpdateLock(r.h,{spec:"go-back",installPrefix:"/fixture/previous"},lockDeps).ok).toBe(false);
  expect(takeExclusiveLease(r.h,0).ok).toBe(false);
  return originalStop(...args);
 });
 await host.change({revision:view.revision,action:"resolve",blockerId:blocker.id,resolution:"stop-work"},actor);
 guardedStop.mockRestore();
 const released=takeExclusiveLease(r.h,0);expect(released.ok).toBe(true);if(released.ok)released.lease.release();
 expect(r.m.requestContextModes.drain.retainedEpoch(root)).not.toBe(firstEpoch);
 expect(box.getHumanReceipt(saved.receipt.receipt_id)).toEqual(before);
 expect(readRequestContextResolution(db,root)?.receipts[0].receiptId).toBe(saved.receipt.receipt_id);
 const state=box.requestContextInstallation().read();r.m.requestContextModes.off.advance(state.revision);
 expect(host.read(owner())).toMatchObject({phase:"off",everActivated:true});
});

it("M-3896 the owner can acknowledge a plain terminal legacy result before first On",async()=>{
 const r=rig(),box=r.m.deliveryOutbox,operationId=randomUUID();
 const row=box.admit({operationId,sourceKey:operationId,sourceInstance:"source",sourceDaemonBootId:"old-boot",targetInstance:"target",kind:"fleet_inbound",payload:{content:"Synthetic legacy message"}}).delivery;
 const db=(box as any).db;db.prepare("UPDATE deliveries SET state='uncertain',finished_at='2026-11-26T00:00:00Z' WHERE delivery_id=?").run(row.deliveryId);
 const host=r.m.requestContextControl,actor=r.actor(),view=host.read(actor),blocker=view.blockers.find((value:any)=>value.id.startsWith("legacy-uncertain:"));
 expect(blocker).toMatchObject({kind:"legacy",labels:["source → target"],action:"acknowledge"});
 const resolved=await host.change({revision:view.revision,action:"resolve",blockerId:blocker.id,resolution:"acknowledge"},actor);
 expect(resolved.blockers).toEqual([]);expect(box.get(row.deliveryId).state).toBe("uncertain");
 expect(db.prepare("SELECT acknowledged_at FROM deliveries WHERE delivery_id=?").get(row.deliveryId).acknowledged_at).toBeTruthy();
 expect(box.requestContextInstallation().read()).toBeNull();
});
