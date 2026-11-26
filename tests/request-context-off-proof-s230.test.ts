/** Private SQLite and real registries only. No Fleet, provider or process is started. */
import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {REQUEST_CONTEXT_DRAIN_FAMILIES} from "../src/request-context-drain.js";
import {RequestContextReferenceMap} from "../src/request-context-fence.js";
import {requestContextDigest} from "../src/request-context-store.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function rig(){
 const home=mkdtempSync(join(tmpdir(),"off-proof-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const box=new DeliveryOutbox(join(home,"outbox.db"),"manager",{requestContextDispatchVersion:1});cleanup.push(()=>box.close());
 const installation=box.requestContextInstallation(),owner={owner:"fleet",current:()=>true};
 installation.activate({epoch:"first",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},owner,{current:()=>true,release(){}},()=>true,0);
 const drain=box.requestContextDrain(()=>"fleet"),maps=new Map<string,RequestContextReferenceMap<string,string>>();
 const register=()=>{for(const family of REQUEST_CONTEXT_DRAIN_FAMILIES){const registration=drain.registration(),map=new RequestContextReferenceMap<string,string>(root=>root,(_root,id)=>id);map.installRegistration(registration);maps.set(family,map);drain.register(family,family,{registration,revision:()=>map.revision,inspect:root=>map.view(root)});}};
 const context=()=>{const id=randomUUID();return {ref:{version:1 as const,contextId:id,rootContextId:id},rootEvidenceRef:"synthetic",initiatingActor:{kind:"person" as const,platform:"discord" as const,userId:"person"},ingress:"owner" as const,source:{instance:"source",incarnation:"source-current"},sourceAudience:{kind:"instance" as const,ref:id}};};
 const admit=()=>{const c=context(),id=randomUUID(),input={sourceInstance:"source",sourceDaemonBootId:"source-boot",targetInstance:"target",sourceKey:id,operationId:id,kind:"fleet_inbound",payload:{content:"synthetic"}};
  return box.admitWithRequestContext(input,c,{version:1,operationId:id,contextId:c.ref.contextId,rootContextId:c.ref.rootContextId,source:c.source,target:{instance:"target",incarnation:"target-current"},verb:"send_to_instance",payloadSha256:requestContextDigest(input.payload)}).delivery;};
 return {box,installation,owner,drain,maps,register,context,admit};
}
it("even an empty installation snapshot requires every known memory family",()=>{
 const r=rig();r.installation.beginOff(1,r.owner);expect(()=>r.drain.proveOff(r.installation,()=>true)).toThrow(/missing:turns/);
 r.register();const proof=r.drain.proveOff(r.installation,()=>true);expect(proof.current()).toBe(true);
 expect(r.installation.finishOff(2,r.owner,proof).mode).toBe("off");expect(proof.current()).toBe(true);
});
it("Off waits for old deliveries but never waits on the independent roots parked after its boundary",()=>{
 const r=rig();r.register();const old=r.admit();r.installation.beginOff(1,r.owner);const fresh=r.admit();
 expect(()=>r.drain.proveOff(r.installation,()=>true)).toThrow(old.deliveryId);
 (r.box as any).db.prepare("UPDATE deliveries SET state='delivered',finished_at=? WHERE delivery_id=?").run(new Date().toISOString(),old.deliveryId);
 const proof=r.drain.proveOff(r.installation,()=>true);expect(r.installation.finishOff(2,r.owner,proof).mode).toBe("off");
 expect(r.box.get(fresh.deliveryId)?.state).toBe("queued");expect(r.box.requestContextForDelivery(old.deliveryId)).not.toBeNull();
});
it("global-fence loss and participant ABA invalidate final Off; an independent retry can finish",()=>{
 const r=rig();r.register();const context=r.context();r.box.requestContextRecovery.retain(context);r.installation.beginOff(1,r.owner);
 let held=true;const proof=r.drain.proveOff(r.installation,()=>held);held=false;
 expect(()=>r.installation.finishOff(2,r.owner,proof)).toThrow(/work/);expect(r.installation.read()?.mode).toBe("draining");held=true;
 const map=r.maps.get("registered-work")!;map.set("queued-recovery",context.ref.rootContextId);expect(proof.current()).toBe(false);map.delete("queued-recovery");expect(proof.current()).toBe(false);
 expect(r.installation.finishOff(2,r.owner,r.drain.proveOff(r.installation,()=>held)).mode).toBe("off");
});
it("a missing durable root without its owned retirement tombstone is unavailable, never an empty drain",()=>{
 const r=rig();r.register();const context=r.context();r.box.requestContextRecovery.retain(context);r.installation.beginOff(1,r.owner);
 (r.box as any).db.prepare("DELETE FROM request_contexts_v1 WHERE context_id=?").run(context.ref.contextId);
 expect(()=>r.drain.proveOff(r.installation,()=>true)).toThrow(/context-unavailable/);
});
it.each(REQUEST_CONTEXT_DRAIN_FAMILIES)("an isolated live %s reference blocks installation Off",family=>{
 const r=rig();r.register();const context=r.context();r.box.requestContextRecovery.retain(context);r.installation.beginOff(1,r.owner);
 const map=r.maps.get(family)!;map.set("owned-reference",context.ref.rootContextId);
 expect(()=>r.drain.proveOff(r.installation,()=>true)).toThrow(/owned-reference/);
 map.delete("owned-reference");expect(r.drain.proveOff(r.installation,()=>true).current()).toBe(true);
});
it("a root legitimately collected during Draining is recognized by its owned retirement tombstone",()=>{
 const r=rig();r.register();const context=r.context();r.box.requestContextRecovery.retain(context);r.installation.beginOff(1,r.owner);
 const epoch=r.drain.fence(context.ref.rootContextId),retirement=r.drain.prove(context.ref.rootContextId,epoch);
 (r.box as any).retireRequestContextRoot(context.ref.rootContextId,()=>retirement.current());
 expect(r.installation.finishOff(2,r.owner,r.drain.proveOff(r.installation,()=>true)).mode).toBe("off");
});
it("a durable reference appearing after the first final check rolls back Off in the same transaction",()=>{
 const r=rig();r.register();const context={...r.context(),ingress:"restricted-room" as const};r.box.requestContextRecovery.retain(context);r.installation.beginOff(1,r.owner);
 const proof=r.drain.proveOff(r.installation,()=>true);let checks=0;
 const raced={...proof,current:()=>{const valid=proof.current();if(++checks===1)r.box.requestContextRecovery.save("source",{instance:"source",incarnation:"source-current",workGeneration:"work",contextId:context.ref.contextId});return valid;}};
 expect(()=>r.installation.finishOff(2,r.owner,raced)).toThrow(/work/);
 expect(r.installation.read()?.mode).toBe("draining");expect(r.box.requestContextRecovery.pointer("source")).toBeNull();
});
it("untouched queued human input is parked across Off without an ingress approval; bound or uncertain input is not guessed empty",async()=>{
 const {nativeHumanOrigin}=await import("../src/human-delivery-receipts.js");
 for(const state of ["untouched","bound","uncertain"] as const){
  const r=rig();r.register();const origin=nativeHumanOrigin("discord","fixture","person","Demo",false,"message")!;
  const input=r.box.createHumanReceiptWithRequestContext({targetInstance:"source",originalBody:"synthetic queued chat",origin,inputKind:"fleet_inbound",managerBootId:"manager"},
    {incarnation:"source-current",room:null,web:null,route:{kind:"instance"},platform:()=>"discord"});
  if(state==="bound")r.box.bindHumanReceipt(input.receipt.receipt_id,"source","owner","synthetic wire","manager");
  if(state==="uncertain")r.box.markHumanReceiptUncertain(input.receipt.receipt_id,"source");
  r.installation.beginOff(1,r.owner);
  if(state==="untouched"){
   expect([...r.installation.drainRoots()]).toEqual([]);expect(r.installation.finishOff(2,r.owner,r.drain.proveOff(r.installation,()=>true)).mode).toBe("off");
   expect(r.box.getHumanReceipt(input.receipt.receipt_id)?.state).toBe("queued");expect(r.box.requestContextHumans.read(input.receipt.receipt_id)?.context).toEqual(input.context);
  }else expect(()=>r.drain.proveOff(r.installation,()=>true)).toThrow(/human-input/);
 }
});
