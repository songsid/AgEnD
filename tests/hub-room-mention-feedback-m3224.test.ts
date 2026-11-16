import Database from "better-sqlite3";
import {randomBytes,randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {HubRoomMentionFeedback,HUB_ROOM_MENTION_FEEDBACK_MIGRATION,verifyRoomMentionFeedback,type RoomFeedbackSource} from "../src/hub/member/room-mention-feedback.js";
import {formatRoomMentionFeedback} from "../src/hub/room-mention-feedback-model.js";
import type {HubRoomNotification} from "../src/hub/member/room-notification.js";
const close:(()=>void)[]=[];afterEach(()=>{for(const c of close.splice(0))c();});
function fixture(deliver?:(input:HubRoomNotification)=>Promise<boolean>){
 const db=new Database(":memory:");HUB_ROOM_MENTION_FEEDBACK_MIGRATION.up(db);close.push(()=>db.close());
 let token="current",live=true;
 const source:RoomFeedbackSource={agent:"notes",exposureId:randomUUID(),revision:1,consentId:randomUUID(),token};
 const value={id:randomUUID(),refusals:[{code:"personal-people-only" as const,name:"Private notes"}]};
 const sent=vi.fn(deliver??(async input=>await input.beforeInput()));
 const options={db,binding:"issuer/fleet/owner",encryptionKey:randomBytes(32),current:(s:RoomFeedbackSource)=>live&&s.exposureId===source.exposureId&&s.token===token,deliver:sent};
 const queue=new HubRoomMentionFeedback(options);close.push(()=>queue.close());
 return {db,source,value,options,queue,sent,revoke:()=>{token="replaced";},offline:()=>{live=false;}};
}
describe("exact-operation mention refusal notifications",()=>{
 it("commits encrypted intent before input and de-duplicates ACK replays",async()=>{
  const f=fixture();expect(f.queue.receive(f.value,f.source,"answer:question:answer")).toBe(true);await f.queue.settled();
  expect(f.sent).toHaveBeenCalledTimes(1);expect(f.sent.mock.calls[0][0]).toMatchObject({agent:"notes",id:f.value.id,kind:"mention-feedback"});
  expect(f.sent.mock.calls[0][0].text).toContain("Not delivered: Private notes is a personal agent and answers people only.");
  expect(f.db.prepare("SELECT state FROM hub_room_mention_feedback").get()).toEqual({state:"delivered"});
  expect(JSON.stringify(f.db.prepare("SELECT * FROM hub_room_mention_feedback").get())).not.toContain("Private notes");
  expect(f.queue.receive(f.value,f.source,"answer:question:answer")).toBe(true);await f.queue.settled();expect(f.sent).toHaveBeenCalledTimes(1);
  expect(f.queue.receive(f.value,f.source,"answer:another-question:answer")).toBe(false);
 });
 it("rechecks the same consent/lifecycle immediately before input",async()=>{
  let input:HubRoomNotification|undefined,done!:(value:boolean)=>void;
  const held=new Promise<boolean>(resolve=>{done=resolve;}),f=fixture(async value=>{input=value;return held;});
  f.queue.receive(f.value,f.source,"post:operation:post");await Promise.resolve();await Promise.resolve();expect(input).toBeDefined();
  f.revoke();expect(await input!.beforeInput()).toBe(false);done(false);await f.queue.settled();
  expect(f.db.prepare("SELECT state FROM hub_room_mention_feedback").get()).toEqual({state:"queued"});f.queue.flush();await f.queue.settled();expect(f.sent).toHaveBeenCalledTimes(1);
 });
 it("holds an interrupted input across restart instead of replaying it",async()=>{
  let done!:(value:boolean)=>void;const held=new Promise<boolean>(resolve=>{done=resolve;});
  const f=fixture(async value=>{expect(await value.beforeInput()).toBe(true);return held;});f.queue.receive(f.value,f.source,"answer:question:answer");
  for(let n=0;n<8;n++)await Promise.resolve();expect(f.db.prepare("SELECT state FROM hub_room_mention_feedback").get()).toEqual({state:"input"});
  f.queue.close();const next=new HubRoomMentionFeedback(f.options);close.push(()=>next.close());
  expect(f.db.prepare("SELECT state FROM hub_room_mention_feedback").get()).toEqual({state:"held"});
  next.flush();await next.settled();
  expect(f.db.prepare("SELECT state FROM hub_room_mention_feedback").get()).toEqual({state:"held"});expect(f.sent).toHaveBeenCalledTimes(1);done(false);await f.queue.settled();
 });
 it("refuses a different pairing and tampered feedback before recovery",async()=>{
  const f=fixture();f.queue.receive(f.value,f.source,"answer:question:answer");await f.queue.settled();
  expect(()=>verifyRoomMentionFeedback({...f.options,binding:"other-owner"})).toThrow(expect.objectContaining({code:"uncertain"}));
  f.db.prepare("UPDATE hub_room_mention_feedback SET value=?").run(Buffer.alloc(40).toString("base64"));
  expect(()=>new HubRoomMentionFeedback(f.options)).toThrow(expect.objectContaining({code:"uncertain"}));
 });
 it("uses the agreed English and Traditional Chinese refusal",()=>{
  const f=fixture();expect(formatRoomMentionFeedback(f.value,"zh-TW")).toBe("沒有送出：Private notes 是個人 Agent，只回答人的提問。");
 });
});
