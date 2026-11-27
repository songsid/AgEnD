import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {Daemon} from "../src/daemon.js";
import {FleetManager} from "../src/fleet-manager.js";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import type {RequestContextPolicyPort} from "../src/request-context-policy.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
function rig(){
 const home=mkdtempSync(join(tmpdir(),"candidate-owner-s230-")),box=new DeliveryOutbox(join(home,"box.db"),"manager",{requestContextDispatchVersion:1});
 cleanup.push(()=>rmSync(home,{recursive:true,force:true}),()=>box.close());
 const config:any={working_directory:home,backend:"claude-code",log_level:"silent"};let current=true,incarnation="inc";
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{deliveryOutbox:box,managerBootId:"manager",lifecycle:{daemons:new Map()},fleetConfig:{instances:{worker:config}},contactGeneration:()=>incarnation,adapters:new Map(),worlds:new Map()});
 const policy:RequestContextPolicyPort={installedMode:()=>null,instructionMode:()=>"active",assert:()=>{throw Error("Candidate cannot serve input");}};
 const stage=()=>fm.prepareRequestContextDaemonOwner("worker",config,policy,{assertRegistration:()=>{}},()=>current);
 const daemon=(name="worker",given=config):any=>new Daemon(name,given,home,true,undefined,undefined,{info(){},warn(){},error(){},debug(){},child(){return this;}}as any);
 return {box,fm,config,policy,stage,daemon,current:(v:boolean)=>current=v,incarnation:(v:string)=>incarnation=v};
}
it("one controlled preparation supplies the rendering policy and actual pre-start C/D binding without publishing",()=>{
 const f=rig(),stage=f.stage(),daemon=f.daemon();expect(stage.bound()).toBe(false);expect(stage.preparation.policy).toBe(f.policy);expect(f.box.requestContextWork.read("worker")).toBeNull();
 stage.configure(daemon,f.config,stage.preparation);expect(daemon.requestContextCallsRequired()).toBe(true);expect(daemon.captureRequestContextOwner()).toMatchObject({instance:"worker",incarnation:"inc",workGeneration:stage.work.identity().workGeneration});
 expect(()=>stage.sealRegistered()).toThrow(/not bound/);f.fm.daemons.set("worker",daemon);daemon.bindRequestContextPolicy(f.policy);stage.sealRegistered();expect(stage.bound()).toBe(true);
 expect(f.fm.requestContextPolicy).toBeUndefined();expect(f.fm.requestContextHumanAdmission).toBeUndefined();expect(f.box.requestContextWork.read("worker")).toBeNull();
 f.fm.daemons.set("worker",f.daemon());expect(stage.bound()).toBe(false);expect(stage.preparation.current()).toBe(false);
});
it.each(["config","policy","name","owner","incarnation"])("a changed %s refuses controlled binding and creates no work row",kind=>{
 const f=rig(),stage=f.stage();let given=f.config,offered=stage.preparation;
 if(kind==="config")given={...f.config,model:"other"};if(kind==="policy")offered={...offered,policy:{...f.policy}};if(kind==="owner")f.current(false);if(kind==="incarnation")f.incarnation("replacement");
 expect(()=>stage.configure(f.daemon(kind==="name"?"other":"worker",given),given,offered)).toThrow(/changed/);expect(f.box.requestContextWork.read("worker")).toBeNull();
});
it("an unstarted candidate cannot be bound twice or hot-bound after a pane exists",()=>{
 const f=rig(),stage=f.stage(),daemon=f.daemon();stage.configure(daemon,f.config,stage.preparation);
 expect(()=>stage.configure(f.daemon(),f.config,stage.preparation)).toThrow(/changed/);
 const other=f.stage(),running=f.daemon();running.tmux={};expect(()=>other.configure(running,f.config,other.preparation)).toThrow(/before/);expect(other.preparation.current()).toBe(false);
});
it("a disposed candidate cannot supply later work identity or startup permission",()=>{
 const f=rig(),stage=f.stage();stage.dispose();expect(stage.preparation.current()).toBe(false);expect(()=>stage.work.identity()).toThrow(/owner changed/);
});

it("a partial activated database cannot be mistaken for permission to stage a new work identity",()=>{
 const f=rig();f.box.activateRequestContextBarrier();expect(()=>f.stage()).toThrow(/Installation/);expect(f.box.requestContextWork.read("worker")).toBeNull();
});
