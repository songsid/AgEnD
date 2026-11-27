/** Recovery CAS only, no live stop or inferred process retirement. */
import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function rig(){
 const dir=mkdtempSync(join(tmpdir(),"recovery-resolution-"));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));const box=new DeliveryOutbox(join(dir,"outbox.db"),"fixture",{requestContextDispatchVersion:1});cleanup.push(()=>box.close());box.activateRequestContextBarrier();
 const store=box.requestContextRecovery;
 const pointer=()=>{const id=randomUUID();store.retain({ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"fixture",initiatingActor:{kind:"unknown",reason:"unproved-recovery"},ingress:"restricted-room",source:{instance:"worker",incarnation:"current"},sourceAudience:{kind:"instance",ref:id}});
 return {instance:"worker",incarnation:"current",workGeneration:"work",contextId:id};};
 const first=pointer();store.save("worker",first);return {box,store,first,pointer};
}
it("explicit retirement clears exactly the confirmed pointer, while its historical context remains readable",()=>{
 const r=rig();let seen:any;expect(r.store.clear(r.first,pointer=>{seen=pointer;return true;})).toBe(true);
 expect(Object.isFrozen(seen)).toBe(true);expect(r.store.pointer("worker")).toBeNull();expect(r.box.requestContext(r.first.contextId)).not.toBeNull();
 expect(r.store.clear(r.first,()=>{throw Error("No new effect on an absent pointer");})).toBe(false);
});
it("a stale stop-work card cannot clear newer work under the same incarnation",()=>{
 const r=rig(),next=r.pointer();r.store.save("worker",next);expect(()=>r.store.clear(r.first,()=>true)).toThrow(/changed/);expect(r.store.pointer("worker")).toEqual(next);
});
it.each(["before","after"])("unproved retirement %s the deletion keeps recovery intact",when=>{
 const r=rig();let checks=0;expect(()=>r.store.clear(r.first,()=>when==="before"?false:++checks===1)).toThrow(/retirement/);expect(r.store.pointer("worker")).toEqual(r.first);
});
it("changed incarnation or work-generation evidence does not erase the retained pointer",()=>{
 const r=rig();for(const patch of [{incarnation:"replacement"},{workGeneration:"new work"}]){
  expect(()=>r.store.clear({...r.first,...patch},()=>true)).toThrow(/changed/);expect(r.store.pointer("worker")).toEqual(r.first);
 }
});

it("a promise or truthy placeholder is not synchronous retirement evidence",()=>{
 const r=rig();for(const value of [Promise.resolve(true),"yes",{}]){
  expect(()=>r.store.clear(r.first,()=>value as any)).toThrow(/unproved/);expect(r.store.pointer("worker")).toEqual(r.first);
 }
});
