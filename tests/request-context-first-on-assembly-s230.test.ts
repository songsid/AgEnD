/** Actual Fleet assembly, publication, registries and SQLite; every physical process/transport is inert. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as helperReadiness from "../src/request-context-helper-readiness.js";
import {FleetManager} from "../src/fleet-manager.js";
import {captureRequestContextEnableOffer} from "../src/request-context-enable-offer.js";
import {SettingsExecution} from "../src/settings-transaction.js";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {RequestContextReferenceMap} from "../src/request-context-fence.js";
import {RequestContextPendingWork} from "../src/request-context-pending-work.js";
import {acquireFleetLock,setProcessFleetLock,releaseProcessFleetLock} from "../src/fleet-lock.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())fn();});
function rig(){
 const h=mkdtempSync(join(tmpdir(),"first-on-assembly-"));cleanup.push(()=>rmSync(h,{recursive:true,force:true}));setProcessFleetLock(acquireFleetLock(h));cleanup.push(()=>releaseProcessFleetLock());
 const box=new DeliveryOutbox(join(h,"delivery-outbox.db"),"manager");cleanup.push(()=>box.close());
 let transports=true,legacy=true;
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{dataDir:h,managerBootId:"manager",deliveryOutbox:box,fleetConfig:{instances:{}},
  requestContextPendingWork:new RequestContextPendingWork(),requestContextFleetCalls:new RequestContextReferenceMap((row:any)=>row.root,(_row:any,id:string)=>id),instanceIpcClients:new Map(),
  lifecycle:{daemons:new Map()},scheduleDeliveryOutboxPump:vi.fn(),wakeCoordinator:{kick:vi.fn()},
  retireRequestContextNativeFactories:vi.fn(async()=>{fm.requestContextNativeGraph=undefined;fm.nativeMcpStore=null;fm.fleetWindowsRuntime=null;fm.paneManager=null;}),
  nativeInstanceRuntime:()=>fm.fleetWindowsRuntime??=(native()),nativePanes:async()=>fm.paneManager??=(native()),
  prepareRequestContextServingOwners:vi.fn((current:()=>boolean)=>({current,policy:{assert:()=>({kind:"read",tool:"fixture",args:{}})},relay:{},cards:{},api:{},human:()=>({}),hub:()=>null})),
 });
 function native(){const registration=fm.requestContextNativeGraph.registration;return {drainRevision:"native",offRevision:"native",drainView:()=>({registration,revision:"native",references:[],unknown:false}),offView:()=>({registration,revision:"native",references:[],unknown:false}),requestContextPhysicallyIdle:()=>true};}
 return {fm,box,prepare:(execution?:SettingsExecution)=>fm.prepareRequestContextFirstOnAssembly(()=>legacy,()=>transports,()=>false,captureRequestContextEnableOffer(h),execution),transports:(value:boolean)=>transports=value,legacy:(value:boolean)=>legacy=value};
}
it("first On stages all owners while input is fenced, commits one floor and publishes the exact retained graph",async()=>{
 const r=rig(),stage=await r.prepare();expect(stage.ready()).toBe(true);expect(r.box.requestContextInstallation().read()).toBeNull();
 expect(stage.policy.instructionMode()).toBe("active");expect(stage.policy.installedMode()).toBeNull();expect(()=>stage.policy.assert({instance:"one",tool:"reply",args:{}})).toThrow();
 expect(r.fm.requestContextAdmission.available()).toBe(false);
 const state=r.box.requestContextInstallation().activate({epoch:"first",owner:stage.boot.owner.owner,activatedAt:1,invalidates:[],offeredLatestDeadline:null},stage.boot.owner,{current:()=>true,release(){}},stage.ready,0,stage.initialize);
 expect(r.fm.prepareRequestContextServingOwners).toHaveBeenCalledOnce();expect(r.fm.requestContextAdmission.available()).toBe(false);
 expect(stage.publish()).toEqual(state);expect(r.fm.requestContextAdmission.available()).toBe(true);expect(stage.policy.installedMode()).toBe("active");
 expect(stage.boot.publication.captureExecution().portsCurrent()).toBe(true);await expect(stage.rollback()).rejects.toThrow(/cannot revert/);
});
it("a negotiated port loss before commit unwinds the whole preparation, restores legacy admission and changes no durable floor",async()=>{
 const r=rig(),stage=await r.prepare();r.transports(false);expect(stage.ready()).toBe(false);
 expect(()=>r.box.requestContextInstallation().activate({epoch:"first",owner:stage.boot.owner.owner,activatedAt:1,invalidates:[],offeredLatestDeadline:null},stage.boot.owner,{current:()=>true,release(){}},stage.ready,0,stage.initialize)).toThrow(/changed/);
 await stage.rollback();expect(r.box.requestContextInstallation().read()).toBeNull();expect(r.fm.requestContextAdmission.available()).toBe(true);expect(stage.policy.instructionMode()).toBeNull();expect(r.fm.requestContextNativeGraph).toBeUndefined();
 const retry=await (async()=>{r.transports(true);return r.prepare();})();expect(retry.ready()).toBe(true);expect(stage.ready()).toBe(false);await retry.rollback();
});
it("an initialization failure rolls back every durable change and still permits exact owner rollback",async()=>{
 const r=rig(),stage=await r.prepare();
 expect(()=>r.box.requestContextInstallation().activate({epoch:"first",owner:stage.boot.owner.owner,activatedAt:1,invalidates:[],offeredLatestDeadline:null},stage.boot.owner,{current:()=>true,release(){}},stage.ready,0,()=>{stage.initialize();throw Error("fixture initializer failed");})).toThrow(/initializer failed/);
 expect(r.box.requestContextInstallation().read()).toBeNull();await stage.rollback();expect(r.fm.requestContextAdmission.available()).toBe(true);
});

it("confirmation currency gates COMMIT but the consumed decision cannot revoke already-committed process ownership",async()=>{
 const r=rig(),execution=new SettingsExecution({current:()=>true,snapshot:()=>"unchanged settings"});
 try{
  const stage=await r.prepare(execution);
  execution.commit(()=>r.box.requestContextInstallation().activate({epoch:"first",owner:stage.boot.owner.owner,activatedAt:1,invalidates:[],offeredLatestDeadline:null},stage.boot.owner,{current:()=>true,release(){}},stage.ready,0,stage.initialize));
  expect(stage.ready()).toBe(false);expect(stage.publish().mode).toBe("active");expect(r.fm.requestContextAdmission.available()).toBe(true);
 }finally{execution.close();}
});
it("revoking the confirmed actor during preparation prevents activation and still permits safety cleanup",async()=>{
 const r=rig();let role=true;const execution=new SettingsExecution({current:()=>role,snapshot:()=>"unchanged settings"});
 try{const stage=await r.prepare(execution);role=false;expect(stage.ready()).toBe(false);
  expect(()=>r.box.requestContextInstallation().activate({epoch:"first",owner:stage.boot.owner.owner,activatedAt:1,invalidates:[],offeredLatestDeadline:null},stage.boot.owner,{current:()=>true,release(){}},stage.ready,0,stage.initialize)).toThrow(/changed/);
  await stage.rollback();expect(r.box.requestContextInstallation().read()).toBeNull();expect(r.fm.requestContextAdmission.available()).toBe(true);
 }finally{execution.close();}
});

it("the assembled On owner drains to capable Off through the same eight registries and keeps ordinary ingress open",async()=>{
 const r=rig(),stage=await r.prepare();expect(()=>stage.off.begin(0,()=>true)).toThrow(/unavailable/);
 r.box.requestContextInstallation().activate({epoch:"first",owner:stage.boot.owner.owner,activatedAt:1,invalidates:[],offeredLatestDeadline:null},stage.boot.owner,{current:()=>true,release(){}},stage.ready,0,stage.initialize);
 stage.publish();const original=stage.boot.publication.captureExecution();
 expect(stage.off.begin(1,()=>true).mode).toBe("draining");expect(r.fm.requestContextAdmission.available()).toBe(false);expect(original.executionCurrent()).toBe(true);
 expect(stage.off.advance(2).state.mode).toBe("off");expect(stage.policy.installedMode()).toBe("off");expect(r.fm.requestContextAdmission.available()).toBe(true);
 expect(stage.boot.publication.captureExecution().portsCurrent()).toBe(true);expect(original.executionCurrent()).toBe(false);
 expect(r.fm.requestContextNativeGraph).toBeDefined();expect(r.fm.prepareRequestContextOwnerRegistration).toBeTypeOf("function");
});

it("the owning activation transaction refuses a record that differs from the confirmed Go back offer",async()=>{
 const r=rig(),stage=await r.prepare();
 expect(()=>r.box.requestContextInstallation().activate({epoch:"first",owner:stage.boot.owner.owner,activatedAt:1,invalidates:["20261126T120000Z-aabbccdd"],offeredLatestDeadline:100},stage.boot.owner,{current:()=>true,release(){}},stage.ready,0,stage.initialize)).toThrow(/offer differs/);
 expect(r.box.requestContextInstallation().read()).toBeNull();await stage.rollback();expect(r.fm.requestContextAdmission.available()).toBe(true);
});

it("a replacement waits for an actual helper-ready observation while admission stays closed",async()=>{
 const r=rig(),observe=vi.spyOn(helperReadiness,"captureRequestContextHelpers");
 observe.mockReturnValueOnce({ready:false,sha256:"not-ready",unready:["fixture-agent"],current:()=>false});
 const pending=r.prepare();await vi.waitFor(()=>expect(observe).toHaveBeenCalled());expect(r.fm.requestContextAdmission.available()).toBe(false);
 const stage=await pending;expect(observe.mock.calls.length).toBeGreaterThan(1);expect(stage.ready()).toBe(true);await stage.rollback();
});
it("elapsed helper wait never counts as a ready connection and restores unpublished owners",async()=>{
 const r=rig();let clock=0,reads=0;vi.spyOn(performance,"now").mockImplementation(()=>clock);
 vi.spyOn(helperReadiness,"captureRequestContextHelpers").mockImplementation(()=>{if(++reads===2)clock=30_001;return {ready:false,sha256:"not-ready",unready:["fixture-agent"],current:()=>false};});
 await expect(r.prepare()).rejects.toMatchObject({code:"request-context-owner-not-ready",agent:"fixture-agent"});
 expect(r.box.requestContextInstallation().read()).toBeNull();expect(r.fm.requestContextAdmission.available()).toBe(true);expect(r.fm.requestContextNativeGraph).toBeUndefined();
});
