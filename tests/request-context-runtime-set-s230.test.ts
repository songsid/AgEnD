/** Actual collector; cached coordinator/endpoint objects only, no listener, worker or provider. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FleetManager} from "../src/fleet-manager.js";
import {acquireFleetLock,setProcessFleetLock,releaseProcessFleetLock} from "../src/fleet-lock.js";
const homes:string[]=[];afterEach(()=>{releaseProcessFleetLock();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
function rig(){const h=mkdtempSync(join(tmpdir(),"runtime-set-"));homes.push(h);setProcessFleetLock(acquireFleetLock(h));let generation=1,negotiated=0,live=true;
 const machines:any[]=[{id:"remote",name:"Demo computer",status:"online",paneProtocol:1,runtimeInfo:{capabilities:["request-context-call-v1","native-exec-input-v1"]}}];
 const hub={listMachines:()=>machines.map(row=>({...row})),machine:(id:string)=>machines.find(row=>row.id===id)??null,requestContextReadiness:(id:string)=>machines.find(row=>row.id===id)?.status==="online"&&live?{id,generation:`attachment:${generation}`,connected:true,requestContextVersion:negotiated}:null};
 const graph={},m:any=Object.assign(Object.create(FleetManager.prototype),{dataDir:h,managerBootId:"manager",fleetConfig:{instances:{exec:{runtime:"windows",native_adapter:"exec",machine_id:"remote"}}},runtimeHub:hub,currentRequestContextNativeGraph:()=>graph,localNativePaneEndpoint:vi.fn(()=>{throw Error("No local pane launch");}),runtimeCoordinator:vi.fn(()=>{negotiated=1;return hub;})});
 return {m,machines,hub,generation:()=>generation++,offline:()=>{live=false;},version:(v:number)=>negotiated=v};
}
it("preflight distinguishes capable advertisements from legacy-host negotiation 0, and reads construct nothing",async()=>{
 const r=rig(),set=r.m.captureRequestContextRuntimeSet();expect(set.advertised()).toEqual([]);expect(r.m.runtimeCoordinator).not.toHaveBeenCalled();expect(()=>set.prove()).toThrow(/not prepared/);
 await set.prepare();expect(set.prove().current()).toBe(true);expect(r.m.localNativePaneEndpoint).not.toHaveBeenCalled();
});
it("a disconnected originally connected runtime never disappears from the required set",async()=>{
 const r=rig();r.m.fleetConfig.instances={};const set=r.m.captureRequestContextRuntimeSet();await set.prepare();const proof=set.prove();r.machines[0].status="offline";
 expect(set.snapshot().requiredPeers).toEqual(["remote"]);expect(proof.current()).toBe(false);expect(()=>set.prove()).toThrow(/negotiation/);
});
it.each(["generation","downgrade","arrival","config"])("a %s change between preparation and commit invalidates the exact runtime proof",async kind=>{
 const r=rig(),set=r.m.captureRequestContextRuntimeSet();await set.prepare();const proof=set.prove();
 if(kind==="generation")r.generation();if(kind==="downgrade")r.version(0);if(kind==="arrival")r.machines.push({...r.machines[0],id:"second"});if(kind==="config")r.m.fleetConfig.instances.extra={runtime:"windows",machine_id:"second"};expect(proof.current()).toBe(false);
});
it("a peer missing the required exec input capability is a named upgrade blocker",()=>{const r=rig();r.machines[0].runtimeInfo.capabilities=["request-context-call-v1"];const set=r.m.captureRequestContextRuntimeSet();expect(set.advertised()).toEqual(["remote"]);expect(set.labels()).toEqual([{id:"remote",label:"Demo computer"}]);});
it("local pane transport is constructed only when required, and its actual attachment is part of the proof",async()=>{
 const r=rig();r.m.runtimeHub=null;r.m.fleetConfig.instances={pane:{runtime:"windows",native_adapter:"pane"}};let attachment="one";
 r.m.localNativePaneEndpoint=vi.fn(async()=>{r.m.localPaneRelay={online:()=>true,requestContextReadiness:()=>({id:"local",generation:attachment,connected:true,requestContextVersion:1})};});
 const set=r.m.captureRequestContextRuntimeSet();await set.prepare();expect(r.m.runtimeCoordinator).not.toHaveBeenCalled();const proof=set.prove();attachment="two";expect(proof.current()).toBe(false);
});
