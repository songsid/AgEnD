import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HubRoomAskAdapter, migrateRoomAsks, migrateRoomContextReceipts, type RoomAsk, type RoomAskLink } from "../src/hub/member/room-ask.js";
import { HUB_ROOM_CONTEXT_CAPABILITY } from "../src/hub/room-context-model.js";
import { RoomConversationGeneration } from "../src/hub-room-conversation.js";

const dbs:Database.Database[]=[],roots:string[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(modern=true){
  const db=new Database(":memory:");dbs.push(db);migrateRoomAsks(db);migrateRoomContextReceipts(db);
  const exposureId=randomUUID(),roomId=randomUUID();let generation=randomUUID();
  const deliver=vi.fn(async(input:any)=>{expect(await input.beforeInput()).toBe(true);return true;});
  const options={db,bindingKey:"issuer/fleet/owner",encryptionKey:Buffer.alloc(32,23),current:()=>true,
    localExposure:(id:string)=>id===exposureId?{agent:"Notes",consentId:"consent",revision:1,token:"token"}:null,
    generation:()=>generation,deliver};
  const create=()=>new HubRoomAskAdapter(options),adapter=create();
  const link:RoomAskLink={current:()=>true,features:new Set(["welcome-caps-v1","room-ask-v1",...(modern?[HUB_ROOM_CONTEXT_CAPABILITY]:[])]),
    sendAnswer:vi.fn(async()=>{}),contextState:vi.fn(async value=>({...value,ok:true})),contextInput:vi.fn(async value=>({...value,ok:true}))};
  adapter.connected(link);
  const ask=():RoomAsk=>({messageId:randomUUID(),roomId,roomName:"Weekly",exposureId,asker:{name:"Alex"},text:"Question",context:[],
    ...(modern?{contextState:{generation,after:0,through:5}}:{})});
  return {db,adapter,create,link,deliver,ask,generation:()=>generation,reset:()=>{generation=randomUUID();},exposureId};
}
it("IPC acceptance never advances context; exact positive input receipts survive a lost ACK and adapter restart",async()=>{
  const h=fixture(),ask=h.ask();h.adapter.accept(ask,h.link);await h.adapter.settled();
  expect(h.link.contextInput).not.toHaveBeenCalled();
  const cid=h.deliver.mock.calls[0][0].correlationId;
  vi.mocked(h.link.contextInput!).mockRejectedValueOnce(Error("ACK lost"));
  h.adapter.inputHandoff(cid,"Notes",h.generation());await h.adapter.flushContextInputs();
  expect(h.db.prepare("SELECT COUNT(*) n FROM hub_room_context_outbox").get()).toEqual({n:1});
  h.adapter.close();const restored=h.create();restored.connected({...h.link});
  await restored.flushContextInputs();
  expect(h.link.contextInput).toHaveBeenLastCalledWith({messageId:ask.messageId,exposureId:h.exposureId,generation:h.generation()});
  expect(h.db.prepare("SELECT COUNT(*) n FROM hub_room_context_outbox").get()).toEqual({n:0});
  restored.inputHandoff(cid,"Notes",h.generation());await restored.flushContextInputs();
  expect(h.link.contextInput).toHaveBeenCalledTimes(2);expect(h.deliver).toHaveBeenCalledTimes(1);restored.close();
});
it("refuses old frozen deltas after reset and refuses receipts from another agent or generation",async()=>{
  const h=fixture(),ask=h.ask();h.adapter.accept(ask,h.link);await h.adapter.settled();
  const cid=h.deliver.mock.calls[0][0].correlationId,old=h.generation();
  h.adapter.inputHandoff(cid,"Other",old);h.adapter.inputHandoff(cid,"Notes",randomUUID());
  expect(h.link.contextInput).not.toHaveBeenCalled();
  h.reset();expect(()=>h.adapter.accept(ask,h.link)).toThrow();
  h.adapter.inputHandoff(cid,"Notes",old);expect(h.link.contextInput).not.toHaveBeenCalled();
  const fresh=h.ask();h.adapter.accept(fresh,h.link);await h.adapter.settled();
  expect(h.deliver).toHaveBeenCalledTimes(2);expect(h.deliver.mock.calls[1][0].roomContextGeneration).toBe(h.generation());h.adapter.close();
});
it("keeps the complete legacy ask path without sending new fields or receipt frames",async()=>{
  const h=fixture(false);h.adapter.accept(h.ask(),h.link);await h.adapter.settled();
  expect(h.deliver.mock.calls[0][0]).not.toHaveProperty("roomContextGeneration");
  h.adapter.inputHandoff(h.deliver.mock.calls[0][0].correlationId,"Notes",h.generation());
  await h.adapter.flushContextInputs();expect(h.link.contextState).not.toHaveBeenCalled();expect(h.link.contextInput).not.toHaveBeenCalled();h.adapter.close();
});
it("keeps a generation across reattachment, rotates on restart/clear/session change, and ignores repeat session observations",()=>{
  const dir=mkdtempSync(join(tmpdir(),"agend-room-context-"));roots.push(dir);
  const first=new RoomConversationGeneration(dir);first.start(false);const a=first.current();
  first.observeSession("session-A");expect(first.current()).toBe(a);
  const attached=new RoomConversationGeneration(dir);attached.start(true);expect(attached.current()).toBe(a);
  attached.observeSession("session-A");expect(attached.current()).toBe(a);
  attached.observeSession("session-B");const b=attached.current();expect(b).not.toBe(a);
  attached.reset();const c=attached.current();expect(c).not.toBe(b);
  attached.start(false);expect(attached.current()).not.toBe(c);
});
it("keeps a frozen answer retryable across a conversation reset without advancing the new cursor",async()=>{
  const h=fixture(),ask=h.ask();h.adapter.accept(ask,h.link);await h.adapter.settled();
  const cid=h.deliver.mock.calls[0][0].correlationId;
  expect(await h.adapter.report({correlationId:cid,caller:"Notes",text:"Frozen answer"})).toMatchObject({ok:true});
  expect(h.link.sendAnswer).toHaveBeenCalledTimes(1);
  h.reset();const next={...h.link};h.adapter.connected(next);await h.adapter.flush();
  expect(h.link.sendAnswer).toHaveBeenCalledTimes(2);
  const answer=vi.mocked(h.link.sendAnswer).mock.calls[0][0];
  expect(vi.mocked(h.link.sendAnswer).mock.calls[1][0]).toEqual(answer);
  expect(h.adapter.acknowledge({messageId:ask.messageId,answerId:answer.answerId},next)).toBe(true);
  expect(h.link.contextInput).not.toHaveBeenCalled();h.adapter.close();
});
