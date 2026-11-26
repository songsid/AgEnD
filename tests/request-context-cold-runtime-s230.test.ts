import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {RuntimeCoordinator} from "../src/runtime-coordinator.js";
const homes:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
function fixture(){const home=mkdtempSync(join(tmpdir(),"cold-runtime-"));homes.push(home);const path=join(home,"runtime-machines.json");return {home,path,save:(commands:unknown[])=>writeFileSync(path,JSON.stringify({version:1,machines:[],pairings:[],commands}))};}
const command=(task?:unknown)=>({id:randomUUID(),machineId:randomUUID(),operation:"run",digest:"0".repeat(64),payload:{},createdAt:1,state:"accepted",seq:0,...(task?{task}:{})});
it("cold inspection never starts the coordinator, normalizes its state or starts a heartbeat",()=>{
 const f=fixture(),pending=command(),uncertain=command({status:"completed",finishedAt:2,outcomeConfirmed:false}),confirmed=command({status:"completed",finishedAt:2,outcomeConfirmed:true});f.save([pending,uncertain,confirmed]);
 const bytes=readFileSync(f.path),timer=vi.spyOn(globalThis,"setInterval");
 const view=RuntimeCoordinator.requestContextPendingRunsOnDisk(f.home);
 expect(view.runs.map(row=>row.id)).toEqual([pending.id,uncertain.id]);expect(view.revision).toMatch(/^[a-f0-9]{64}$/);
 expect(readFileSync(f.path)).toEqual(bytes);expect(timer).not.toHaveBeenCalled();
});
it.each(["starting","running","cancelling"])("a cold %s command remains activity evidence",status=>{
 const f=fixture(),row=command({status});f.save([row]);expect(RuntimeCoordinator.requestContextPendingRunsOnDisk(f.home).runs).toHaveLength(1);
});
it("absent is empty, but malformed state or outcome never means idle",()=>{
 const f=fixture();expect(RuntimeCoordinator.requestContextPendingRunsOnDisk(f.home)).toEqual({revision:"absent",runs:[]});
 f.save([command({status:"completed",finishedAt:2,outcomeConfirmed:"yes"})]);expect(()=>RuntimeCoordinator.requestContextPendingRunsOnDisk(f.home)).toThrow(/outcome/);
 f.save([{...command(),state:"unknown"}]);expect(()=>RuntimeCoordinator.requestContextPendingRunsOnDisk(f.home)).toThrow(/command/);
 writeFileSync(f.path,"broken");expect(()=>RuntimeCoordinator.requestContextPendingRunsOnDisk(f.home)).toThrow();
});
