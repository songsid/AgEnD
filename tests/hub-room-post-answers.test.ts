import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HubRoomPostAnswers, type RoomPostAnswer, type RoomPostSource, type RoomPostNotification } from "../src/hub/member/room-post-answers.js";

const dbs: Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function fixture() {
  const db=new Database(":memory:");dbs.push(db);let active=true;
  const source:RoomPostSource={agent:"agent-A",local:{exposureId:randomUUID(),revision:1,consentId:randomUUID(),token:"owned-token"},roomId:randomUUID()};
  const frame:RoomPostAnswer={id:randomUUID(),postId:randomUUID(),roomId:source.roomId,exposureId:source.local.exposureId,
    message:{id:randomUUID(),author:{name:"Alex"},text:"Room reply",at:1000}};
  let known=true;const inputs:RoomPostNotification[]=[];
  const options={db,binding:"binding-A",encryptionKey:Buffer.alloc(32,23),
    source:(id:string)=>known&&id===frame.postId?structuredClone(source):null,current:()=>active,
    deliver:vi.fn(async(input:RoomPostNotification)=>{inputs.push(input);return await input.beforeInput();}),held:vi.fn()};
  const make=()=>new HubRoomPostAnswers(options),adapter=make();
  const link={current:()=>active,ack:vi.fn(async(_id:string)=>{})};adapter.connected(link);
  return {db,source,frame,inputs,options,make,adapter,link,stop:()=>{active=false;},unknown:()=>{known=false;}};
}
it("maps a retained original post to its agent, dedupes delivery and retries only the exact ACK",async()=>{
  const h=fixture();h.link.ack.mockRejectedValueOnce(Error("ACK lost"));
  expect(h.adapter.receive(h.frame,h.link)).toBe(true);expect(h.adapter.receive(h.frame,h.link)).toBe(true);await h.adapter.settled();
  expect(h.inputs).toHaveLength(1);expect(h.inputs[0]).toMatchObject({agent:"agent-A",id:h.frame.id});
  expect(h.inputs[0]!.text).toContain("notification, not a new question");
  await h.adapter.flush();expect(h.inputs).toHaveLength(1);expect(h.link.ack).toHaveBeenLastCalledWith(h.frame.id);
  expect(JSON.stringify(h.db.prepare("SELECT * FROM hub_room_post_answers").all())).not.toContain("Room reply");
  h.adapter.close();const restored=h.make();restored.connected(h.link);
  expect(restored.receive(h.frame,h.link)).toBe(true);await restored.settled();expect(h.inputs).toHaveLength(1);
});
it("refuses wrong post/exposure/room/receipt, retired links and conflicting duplicate payloads",async()=>{
  const h=fixture();
  for(const frame of [{...h.frame,postId:randomUUID()},{...h.frame,exposureId:randomUUID()},{...h.frame,roomId:randomUUID()},{...h.frame,receiptId:`hmsg-${randomUUID()}`}])
    expect(h.adapter.receive(frame,h.link)).toBe(false);
  expect(h.adapter.receive(h.frame,{...h.link})).toBe(false);
  expect(h.adapter.receive(h.frame,h.link)).toBe(true);await h.adapter.settled();
  expect(h.adapter.receive({...h.frame,message:{...h.frame.message,text:"changed"}},h.link)).toBe(false);
  h.stop();expect(h.adapter.receive({...h.frame,id:randomUUID()},h.link)).toBe(false);
  expect(h.inputs).toHaveLength(1);
});
it("waits for the original post result and never replays locally queued history after reconnect",async()=>{
  const h=fixture();h.unknown();expect(h.adapter.receive(h.frame,h.link)).toBe(false);expect(h.inputs).toHaveLength(0);
  const q=fixture();q.options.deliver.mockImplementationOnce(async()=>false);
  q.adapter.receive(q.frame,q.link);await q.adapter.settled();expect(q.options.deliver).toHaveBeenCalledTimes(1);
  q.adapter.close();const restored=q.make();restored.connected(q.link);await restored.flush();expect(q.options.deliver).toHaveBeenCalledTimes(1);
  restored.receive(q.frame,q.link);await restored.settled();expect(q.inputs).toHaveLength(1);
});
it("records input before handoff; uncertain or interrupted input holds without duplicate input or ACK",async()=>{
  const h=fixture();h.options.deliver.mockImplementationOnce(async input=>{expect(await input.beforeInput()).toBe(true);throw Error("unknown handoff");});
  h.adapter.receive(h.frame,h.link);await h.adapter.settled();expect(h.options.held).toHaveBeenCalledWith(h.frame.id);
  h.adapter.receive(h.frame,h.link);await h.adapter.settled();expect(h.options.deliver).toHaveBeenCalledTimes(1);expect(h.link.ack).not.toHaveBeenCalled();
  const q=fixture();let finish!:(value:boolean)=>void;
  q.options.deliver.mockImplementationOnce(async input=>{await input.beforeInput();return new Promise<boolean>(resolve=>{finish=resolve;});});
  q.adapter.receive(q.frame,q.link);await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));q.adapter.close();
  const restored=q.make();restored.connected(q.link);restored.receive(q.frame,q.link);await restored.settled();
  expect(q.options.deliver).toHaveBeenCalledTimes(1);expect(q.link.ack).not.toHaveBeenCalled();finish(false);await q.adapter.settled();
});
it("does not ACK an old consent and authenticates state and every row before recovery",async()=>{
  const h=fixture();h.options.deliver.mockImplementationOnce(async input=>{const accepted=await input.beforeInput();h.source.local.token="new-token";return accepted;});
  h.adapter.receive(h.frame,h.link);await h.adapter.settled();expect(h.link.ack).not.toHaveBeenCalled();
  h.adapter.close();h.db.prepare("UPDATE hub_room_post_answers SET state='input'").run();
  expect(()=>h.make()).toThrow();
});
