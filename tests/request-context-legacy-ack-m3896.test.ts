import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {requestContextDigest} from "../src/request-context-store.js";
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function rig(scoped=false){
 const home=mkdtempSync(join(tmpdir(),"legacy-ack-m3896-")),box=new DeliveryOutbox(join(home,"box.db"),"fixture",{requestContextDispatchVersion:1});
 cleanup.push(()=>rmSync(home,{recursive:true,force:true}),()=>box.close());
 const op=randomUUID(),payload={type:"fleet_inbound",content:"Synthetic unknown result"},delivery={operationId:op,sourceKey:op,sourceInstance:"source",sourceDaemonBootId:"old-boot",targetInstance:"target",kind:"fleet_inbound",payload};
 let id:string;
 if(scoped){
  box.activateRequestContextBarrier();const root=randomUUID(),source={instance:"source",incarnation:"source-v1"};
  const context={ref:{version:1 as const,contextId:root,rootContextId:root},rootEvidenceRef:"synthetic",ingress:"owner" as const,initiatingActor:{kind:"person" as const,platform:"discord" as const,userId:"synthetic-person"},source,sourceAudience:{kind:"room" as const,ref:root}};
  id=box.admitWithRequestContext(delivery,context,{version:1,operationId:op,contextId:root,rootContextId:root,source,target:{instance:"target",incarnation:"target-v1"},verb:"send_to_instance",payloadSha256:requestContextDigest(payload)}).delivery.deliveryId;
 }else id=box.admit(delivery).delivery.deliveryId;
 const db=(box as any).db;db.prepare("UPDATE deliveries SET state='uncertain',finished_at='2026-11-26T00:00:00Z' WHERE delivery_id=?").run(id);
 const raw=()=>db.prepare("SELECT * FROM deliveries WHERE delivery_id=?").get(id);
 return {box,db,id,raw};
}
it("an earlier acknowledgement settles only an unscoped terminal uncertain inventory row",()=>{
 const f=rig();expect(f.box.requestContextControlInventory().deliveries.map(row=>row.id)).toContain(f.id);
 expect(f.box.acknowledge(f.id,"previous-admin")).toBe(true);
 expect(f.box.requestContextControlInventory().deliveries).toEqual([]);expect(f.raw().state).toBe("uncertain");
});
it("acknowledged scoped uncertainty still blocks, and cannot use the legacy acknowledgement CAS",()=>{
 const f=rig(true);f.box.acknowledge(f.id,"previous-admin");
 expect(f.box.requestContextControlInventory().deliveries.map(row=>row.id)).toContain(f.id);
 expect(()=>f.box.requestContextLegacyAcknowledgementImage(f.id)).toThrow(/stale/);
});
it("the owner acknowledgement is image-bound and changes no delivery outcome or payload",()=>{
 const f=rig(),before=f.raw(),image=f.box.requestContextLegacyAcknowledgementImage(f.id);
 expect(f.box.acknowledgeRequestContextLegacyDelivery(f.id,image,"verified-owner",()=>true)).toBe(true);
 const after=f.raw();expect({...after,acknowledged_at:before.acknowledged_at,acknowledged_by:before.acknowledged_by}).toEqual(before);
 expect(after.acknowledged_by).toBe("verified-owner");expect(after.state).toBe("uncertain");
});
it("changed rows and revoked owners refuse and roll back the acknowledgement",()=>{
 const f=rig(),image=f.box.requestContextLegacyAcknowledgementImage(f.id);
 f.db.prepare("UPDATE deliveries SET finished_at='2026-11-27T00:00:00Z' WHERE delivery_id=?").run(f.id);
 expect(()=>f.box.acknowledgeRequestContextLegacyDelivery(f.id,image,"verified-owner",()=>true)).toThrow(/stale/);
 const currentImage=f.box.requestContextLegacyAcknowledgementImage(f.id);let checks=0;
 expect(()=>f.box.acknowledgeRequestContextLegacyDelivery(f.id,currentImage,"verified-owner",()=>++checks===1)).toThrow(/stale/);
 expect(f.raw().acknowledged_at).toBeNull();
});
