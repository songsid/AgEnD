/** Actual Fleet assembly, publication, registries and SQLite; every physical process/transport is inert. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FleetManager} from "../src/fleet-manager.js";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {RequestContextReferenceMap} from "../src/request-context-fence.js";
import {RequestContextPendingWork} from "../src/request-context-pending-work.js";
import {acquireFleetLock,setProcessFleetLock,releaseProcessFleetLock} from "../src/fleet-lock.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
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
 return {fm,box,prepare:()=>fm.prepareRequestContextFirstOnAssembly(()=>legacy,()=>transports,()=>false),transports:(value:boolean)=>transports=value,legacy:(value:boolean)=>legacy=value};
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
