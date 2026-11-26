/** Real cancellation capture with inert store/bridge doubles; no worker/provider is started. */
import {expect,it,vi} from "vitest";
import {FleetWindowsRuntime} from "../src/fleet-windows-runtime.js";
import {RequestContextReferenceMap} from "../src/request-context-fence.js";
function rig(){
 const runs=new RequestContextReferenceMap<string,any>(row=>row.rootContextId,row=>row.requestId),agents=new Map([["worker",{activeId:"run-a"}],["other",{activeId:"run-b"}]]);
 const runtime:any=Object.assign(Object.create(FleetWindowsRuntime.prototype),{requestContextRuns:runs,requestContextLifecycle:{},retired:false,id:(name:string)=>name,
  store:{get:(id:string)=>agents.get(id),cancel:vi.fn(),requestContextActiveExecutions:()=>[...agents].filter(([,row])=>row.activeId).map(([agentId,row])=>({agentId,requestId:row.activeId}))},
  closeMcp:vi.fn(),changed:vi.fn(),bridge:{get:()=>null}});
 runs.set("worker",{requestId:"run-a",rootContextId:"root-a",retire:()=>runs.delete("worker")});runs.set("other",{requestId:"run-b",rootContextId:"root-b",retire:()=>runs.delete("other")});
 return {runtime,runs,agents};
}
it("stop-work captures only its own native root and waits for positive settlement, not cancel acceptance",()=>{
 const r=rig(),stops=r.runtime.requestContextStops("root-a");expect(stops.map((row:any)=>row.instance)).toEqual(["worker"]);
 stops[0].stop(()=>true);expect(r.runtime.store.cancel).toHaveBeenCalledExactlyOnceWith("worker");expect(stops[0].retired()).toBe(false);
 r.agents.get("worker")!.activeId="";expect(stops[0].retired()).toBe(false);r.runs.delete("worker");expect(stops[0].retired()).toBe(true);expect(r.runs.has("other")).toBe(true);
});
it("a replaced native run or revoked confirmation cannot cancel a newer run with the same name",()=>{
 const r=rig(),stop=r.runtime.requestContextStops("root-a")[0];expect(()=>stop.stop(()=>false)).toThrow(/changed/);
 r.agents.get("worker")!.activeId="new-run";expect(()=>stop.stop(()=>true)).toThrow(/changed/);expect(r.runtime.store.cancel).not.toHaveBeenCalled();
 r.runtime.requestContextLifecycle={};expect(stop.retired()).toBe(false);
});
