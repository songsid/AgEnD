import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { bindHumanReceipt, createHumanReceipt, getHumanReceipt, initializeHumanReceipts, queryHumanReceipt, settleHumanReceipt } from "../src/human-delivery-receipts.js";
import { verifyRoomReceipt } from "../src/hub/member/room-post-receipt.js";
import type { HumanAuthority } from "../src/authority/web-authority.js";

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
