import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DeliveryOutbox, type ClaimedOutboxDelivery } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { nativeHumanOrigin, webHumanOrigin } from "../src/human-delivery-receipts.js";
import { markRetainedHumanControl, retainedHumanControl } from "../src/retained-human-control.js";
const homes:string[]=[],boxes:DeliveryOutbox[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const box of boxes.splice(0))if(box.isOpen)box.close();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
function rig(kind:"native"|"web"="web",before?:(box:DeliveryOutbox,id:string,deliveryId:string)=>void,body="synthetic control"){
 const h=mkdtempSync(join(tmpdir(),"retained-human-"));homes.push(h);const path=join(h,"box.db"),old=new DeliveryOutbox(path,"old");boxes.push(old);
 const origin=kind==="native"?nativeHumanOrigin("discord","fixture-bot","demo-person","Demo person",false,"native-message")!
  :webHumanOrigin(false,undefined,{platform:"discord",adapter_id:"fixture-bot",user_id:"demo-person",session_handle:"0123456789abcdef"});
 const receipt=old.createHumanReceipt({targetInstance:"worker",originalBody:body,origin,inputKind:"fleet_inbound",managerBootId:"old"});
 const payload={type:"fleet_inbound",content:body,meta:{source:kind==="web"?"web":"discord",human_receipt_id:receipt.receipt_id,verification_id:receipt.message_id}};
 const key=`human-control:${receipt.receipt_id}`,delivery=old.admit({sourceKey:key,operationId:key,sourceInstance:"agend-system",sourceDaemonBootId:"old",targetInstance:"worker",kind:"human_control",payload}).delivery;
 before?.(old,receipt.receipt_id,delivery.deliveryId);old.close();const box=new DeliveryOutbox(path,"new");boxes.push(box);box.recoverForBoot("new");
 const claimed=box.claimNext("new",()=>"worker-new",new Set());
 return {h,path,box,receipt,payload,delivery,claimed,control:()=>{
  const value:Record<string,unknown>={};markRetainedHumanControl(value,claimed!);return retainedHumanControl(value)!;
 }};
}
it.each(["native","web"] as const)("real retained %s dispatch after restart binds its original receipt without creating authority or a peer sender",async(kind)=>{
 const r=rig(kind);expect(r.claimed).toBeDefined();expect(r.box.getHumanReceipt(r.receipt.receipt_id)).toMatchObject({state:"uncertain",manager_boot_id:"old",owner_key:null});
 const m:any=Object.create(FleetManager.prototype),daemon:any=new EventEmitter();
 daemon.bootId="worker-new";daemon.captureHumanReceiptOwner=()=>"daemon-owner";daemon.humanReceiptWire=(content:string,meta:any)=>`[hid:${meta.verification_id}]\n${content}`;
 Object.assign(m,{managerBootId:"new",deliveryOutbox:r.box,lifecycle:{daemons:new Map([["worker",daemon]])},fleetConfig:{instances:{}},
  humanReceiptOwner:()=>"current-owner",waitForDurableLaneRelease:async()=>{},deliveryWorkerMode:()=>"off",contactDeliveryCurrent:()=>true,logger:{warn(){},error(){}}});
 const captured:any[]=[];
 m.deliverToInstance=vi.fn(async(target:string,payload:Record<string,unknown>,options:any)=>{
  expect(target).toBe("worker");expect(options.isCrossInstance).toBe(false);expect((payload.meta as any).from_instance).toBeUndefined();
  expect(retainedHumanControl(payload)).toBeDefined();const prepared=m.bindHumanReceiptPayload(target,{...payload});captured.push(prepared);
  expect(r.box.begin(r.claimed!.deliveryId,"worker-new",r.claimed!.attemptNo)).toBe("begun");
  const bound=r.box.getHumanReceipt(r.receipt.receipt_id)!;expect(bound.manager_boot_id).toBe("new");expect(bound.origin_json).toBe(r.receipt.origin_json);expect(bound.authority_json).toBe(r.receipt.authority_json);
  daemon.emit("human_receipt_result",{receipt_id:bound.receipt_id,owner_key:"current-owner",proof:{tag:"unique-id-pane",mode:"idle_submit",receipt_id:bound.receipt_id,verification_id:bound.message_id,owner_key:"current-owner",wire_sha256:bound.wire_sha256}});
  r.box.complete(r.claimed!.deliveryId,"worker-new",r.claimed!.attemptNo,"delivered");return true;
 });
 await m.dispatchDurableDelivery(r.claimed!);expect(m.deliverToInstance).toHaveBeenCalledOnce();expect(captured).toHaveLength(1);
 expect(r.box.getHumanReceipt(r.receipt.receipt_id)).toMatchObject({state:"delivered",message_id:r.receipt.message_id,original_body:r.receipt.original_body,origin_json:r.receipt.origin_json,authority_json:r.receipt.authority_json});
 expect(r.box.claimNext("new",()=>"worker-new",new Set())).toBeUndefined();
});
it("serialized or string lookalikes cannot manufacture the private dispatch proof",()=>{
 const r=rig(),value:Record<string,unknown>={};markRetainedHumanControl(value,r.claimed!);
 expect(retainedHumanControl({...value})).toBe(retainedHumanControl(value));expect(Object.isFrozen(retainedHumanControl(value))).toBe(true);
 expect(retainedHumanControl(JSON.parse(JSON.stringify(value)))).toBeUndefined();expect(retainedHumanControl({"retained-human-control":r.control()})).toBeUndefined();
});
it("a previously bound receipt is never reassigned even when no Enter marker exists",()=>{
 const r=rig("web",(box,id)=>{box.bindHumanReceipt(id,"worker","old-owner","old wire","old");});
 expect(()=>r.box.bindRetainedHumanControlReceipt(r.control(),r.receipt.receipt_id,"worker","new-owner","new wire","new",()=>true)).toThrow("Human verification owner is unavailable");
 expect(r.box.getHumanReceipt(r.receipt.receipt_id)).toMatchObject({manager_boot_id:"old",owner_key:"old-owner",wire_body:"old wire"});
});
it("a past begun-then-aborted attempt is not adopted from absence of an Enter marker",()=>{
 const r=rig("web",(box,_id,deliveryId)=>{const first=box.claimNext("old",()=>"worker-old",new Set())!;expect(first.deliveryId).toBe(deliveryId);box.begin(deliveryId,"worker-old",first.attemptNo);box.abort(deliveryId,"worker-old",first.attemptNo,"fixture abort");});
 expect(r.claimed).toBeDefined();expect(()=>r.box.bindRetainedHumanControlReceipt(r.control(),r.receipt.receipt_id,"worker","new-owner","wire","new",()=>true)).toThrow("Human verification owner is unavailable");
 expect(r.box.getHumanReceipt(r.receipt.receipt_id)?.manager_boot_id).toBe("old");
});
it.each(["attempt","target","payload","owner"] as const)("a stale %s cannot transfer receipt ownership",key=>{
 const r=rig(),control=r.control();const selected=key==="attempt"?{...control,attemptNo:control.attemptNo+1}:key==="target"?{...control,targetDaemonBootId:"other"}:key==="payload"?{...control,payloadSha256:"0".repeat(64)}:control;
 expect(()=>r.box.bindRetainedHumanControlReceipt(selected,r.receipt.receipt_id,"worker","new-owner","wire","new",()=>key!=="owner")).toThrow();
 expect(r.box.getHumanReceipt(r.receipt.receipt_id)).toMatchObject({manager_boot_id:"old",owner_key:null,wire_body:null});
});
it("final owner loss rolls back both the boot transfer and wire binding",()=>{
 const r=rig();let calls=0;expect(()=>r.box.bindRetainedHumanControlReceipt(r.control(),r.receipt.receipt_id,"worker","new-owner","wire","new",()=>++calls===1)).toThrow();
 expect(r.box.getHumanReceipt(r.receipt.receipt_id)).toMatchObject({manager_boot_id:"old",owner_key:null,wire_body:null});
});

it("a delivery marker proves a receipt only through its exact typed current owner/wire binding",()=>{
 const r=rig(),wire=`[agend-delivery-id:${r.claimed!.deliveryId}]\n[hid:${r.receipt.message_id}]\nsynthetic control`;
 const bound=r.box.bindRetainedHumanControlReceipt(r.control(),r.receipt.receipt_id,"worker","new-owner",wire,"new",()=>true);
 const check=(boot="worker-new",attempt=r.claimed!.attemptNo,id=r.receipt.receipt_id,owner="new-owner",hash=bound.wire_sha256!)=>r.box.ownsHumanControlReceipt(r.claimed!.deliveryId,boot,attempt,id,owner,hash);
 expect(check()).toBe(true);expect(check("other")).toBe(false);expect(check("worker-new",r.claimed!.attemptNo+1)).toBe(false);expect(check("worker-new",r.claimed!.attemptNo,"other")).toBe(false);expect(check("worker-new",r.claimed!.attemptNo,r.receipt.receipt_id,"other")).toBe(false);expect(check("worker-new",r.claimed!.attemptNo,r.receipt.receipt_id,"new-owner","0".repeat(64))).toBe(false);
 const db=new Database(r.path);try{db.prepare("UPDATE deliveries SET kind='fleet_inbound' WHERE delivery_id=?").run(r.claimed!.deliveryId);expect(check()).toBe(false);}finally{db.close();}
});

it("raw input is not adopted from an absent durable begin record",()=>{
 const r=rig("web",undefined,"/raw synthetic control");
 expect(()=>r.box.bindRetainedHumanControlReceipt(r.control(),r.receipt.receipt_id,"worker","new-owner","wire","new",()=>true)).toThrow("Human verification owner is unavailable");
 expect(r.box.getHumanReceipt(r.receipt.receipt_id)).toMatchObject({manager_boot_id:"old",owner_key:null,wire_body:null});
});
