import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { bindHumanReceipt, createHumanReceipt, getHumanReceipt, initializeHumanReceipts, queryHumanReceipt, settleHumanReceipt } from "../src/human-delivery-receipts.js";
import { verifyRoomReceipt } from "../src/hub/member/room-post-receipt.js";
import type { HumanAuthority } from "../src/authority/web-authority.js";
import { HubRoomPostAdapter, type RoomPostLink } from "../src/hub/member/room-post.js";

const dbs: Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function fixture(web=false) {
  const db=new Database(":memory:");dbs.push(db);initializeHumanReceipts(db);
  db.exec("CREATE TABLE delivery_forward_edges(reference_kind TEXT, reference_id TEXT,receiver_instance TEXT,sender_instance TEXT,forwarding_message_id TEXT,created_at TEXT,forwarding_delivery_id TEXT)");
  let admin=true, revoked=false;
  const authority:HumanAuthority={kind:"web-verified",actor:{adapter_id:"owned-adapter",user_id:"admin"},authority_epoch:1,
    session:{handle:"owned-session",peer:"loopback",signed_in_at:"2026-11-14T00:00:00Z",authorized_at:"2026-11-14T00:00:00Z"}};
  const row=createHumanReceipt(db,{targetInstance:"agent-A",originalBody:"Please post this to Weekly",managerBootId:"owned-boot",inputKind:"fleet_inbound",
    origin:web?{platform:"web",adapter_id:null,user_id:null,username:null,platform_message_id:null,ingress:"web",authority}
      :{platform:"discord",adapter_id:"owned-adapter",user_id:"admin",username:null,platform_message_id:"message-A",ingress:"message"}});
  const bound=bindHumanReceipt(db,row.receipt_id,"agent-A","owned-pane",row.original_body,"owned-boot");
  const settle=()=>settleHumanReceipt(db,row.receipt_id,"agent-A","owned-pane",{receipt_id:row.receipt_id,verification_id:row.message_id,owner_key:"owned-pane",wire_sha256:bound.wire_sha256,mode:"idle_submit",tag:"unique-id-pane"},"owned-pane");
  const options={lookup:(agent:string,id:string)=>{
    const item=queryHumanReceipt(db,agent,{messageId:id})?.items[0];
    const saved=getHumanReceipt(db,id.slice(5));
    return item&&saved?{row:saved,authority:revoked?{kind:"none" as const,actor:null,authority_epoch:2}:item.authority!}:null;
  },admin:(_agent:string,actor:{adapter_id:string;user_id:string})=>admin&&actor.adapter_id==="owned-adapter"&&actor.user_id==="admin"};
  return {db,row,options,settle,removeAdmin:()=>{admin=false;},revoke:()=>{revoked=true;}};
}
it("requires an accessible delivered receipt with an owned positive proof and original bytes",()=>{
  const h=fixture();expect(verifyRoomReceipt(h.options,"agent-A",h.row.message_id)).toBeNull();
  expect(h.settle()).toBe(true);
  expect(verifyRoomReceipt(h.options,"agent-A",h.row.message_id)?.current()).toBe(true);
  expect(verifyRoomReceipt(h.options,"agent-A",h.row.message_id.slice(0,13))).toBeNull();
  expect(verifyRoomReceipt(h.options,"agent-B",h.row.message_id)).toBeNull();
  h.db.prepare("INSERT INTO delivery_forward_edges VALUES('human',?,'agent-B','agent-A','forward-A','now','delivery-A')").run(h.row.receipt_id);
  expect(verifyRoomReceipt(h.options,"agent-B",h.row.message_id)?.current()).toBe(true);
  h.db.prepare("UPDATE human_delivery_receipts SET original_body='changed'").run();
  expect(verifyRoomReceipt(h.options,"agent-A",h.row.message_id)).toBeNull();
});
it("rechecks current admin and web authority without accepting peer or guest authority",()=>{
  const h=fixture(true);h.settle();const proof=verifyRoomReceipt(h.options,"agent-A",h.row.message_id);
  expect(proof?.current()).toBe(true);h.revoke();expect(proof?.current()).toBe(false);
  const p=fixture();p.settle();const admin=verifyRoomReceipt(p.options,"agent-A",p.row.message_id);
  expect(admin?.current()).toBe(true);p.removeAdmin();expect(admin?.current()).toBe(false);
});
it("refuses malformed, raw-paste and mismatched platform proof even if state says delivered",()=>{
  const h=fixture();h.settle();
  for(const [field,value] of [["proof_mode","raw_paste"],["proof_tag","unknown"],["wire_body","tampered"],["authority_json",JSON.stringify({kind:"platform",actor:{adapter_id:"other",user_id:"admin"},authority_epoch:0})]]) {
    const original=h.db.prepare(`SELECT ${field} AS value FROM human_delivery_receipts`).get() as {value:string};
    h.db.prepare(`UPDATE human_delivery_receipts SET ${field}=?`).run(value);
    expect(verifyRoomReceipt(h.options,"agent-A",h.row.message_id)).toBeNull();
    h.db.prepare(`UPDATE human_delivery_receipts SET ${field}=?`).run(original.value);
  }
});
it("allows follow-ups before 24 h, refuses new posts at the boundary, and preserves accepted posts and answers",async()=>{
  const h=fixture();h.settle();
  const delivered=Date.parse(getHumanReceipt(h.db,h.row.receipt_id)!.delivered_at!);
  let now=delivered+24*60*60*1000-1;
  const receiptOptions={...h.options,now:()=>now};
  const exposureId=randomUUID(),roomId=randomUUID(),operationId=randomUUID();
  const notify=vi.fn(async(input:{beforeInput():Promise<boolean>})=>input.beforeInput());
  const adapter=new HubRoomPostAdapter({db:h.db,binding:"owned-binding",encryptionKey:Buffer.alloc(32,17),current:()=>true,
    local:()=>({exposureId,revision:1,consentId:"owned-consent",token:"owned-token"}),
    receipt:(caller,id)=>verifyRoomReceipt(receiptOptions,caller.agent,id),notify});
  const link:RoomPostLink={features:new Set(["welcome-caps-v1","room-ask-v1","room-post-v1"]),current:()=>true,
    list:async()=>({ok:true,exposureId,rooms:[]}),ack:vi.fn(),
    post:vi.fn(async()=>({ok:true as const,roomId,messageId:randomUUID(),at:now}))};
  adapter.connected(link);
  try {
    const caller={agent:"agent-A",current:()=>true},input={room:roomId,text:"@all Update",operationId,receiptId:h.row.message_id};
    const accepted=await adapter.post(caller,input);expect(accepted.ok).toBe(true);
    expect((await adapter.post(caller,{...input,operationId:randomUUID(),text:"Follow-up"})).ok).toBe(true);
    const lost={...input,operationId:randomUUID(),text:"Lost result"},committed={ok:true as const,roomId,messageId:randomUUID(),at:now};
    vi.mocked(link.post).mockRejectedValueOnce(Error("committed result lost"));
    expect(await adapter.post(caller,lost)).toEqual({ok:false,code:"uncertain"});
    now=delivered+24*60*60*1000;
    expect(await adapter.post(caller,{...input,operationId:randomUUID()})).toMatchObject({ok:false,code:"denied",reason:expect.stringContaining("Ask your owner again")});
    now++;
    expect(await adapter.post(caller,{...input,operationId:randomUUID()})).toMatchObject({ok:false,code:"denied"});
    expect(link.post).toHaveBeenCalledTimes(3);
    expect(await adapter.post(caller,input)).toEqual(accepted);
    vi.mocked(link.post).mockResolvedValueOnce(committed);
    expect(await adapter.post(caller,lost)).toEqual(committed);
    expect(link.post).toHaveBeenLastCalledWith({exposureId,room:roomId,text:lost.text,idempotencyKey:lost.operationId,onBehalfOf:{receiptId:h.row.message_id}});
    if(!accepted.ok)throw Error("Expected accepted post");
    const answer={id:randomUUID(),idempotencyKey:operationId,postId:accepted.messageId,roomId,exposureId,
      receiptId:h.row.message_id,message:{id:randomUUID(),author:{name:"Planner"},text:"Answer",at:now}};
    expect(adapter.receiveAnswer(answer,link)).toBe(true);await adapter.answersSettled();
    expect(notify).toHaveBeenCalledTimes(1);expect(link.ack).toHaveBeenCalledWith(answer.id);
  } finally {adapter.close();}
});
