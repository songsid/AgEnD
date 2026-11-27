import {afterEach,expect,it,vi} from "vitest";
import Database from "better-sqlite3";
import {randomBytes,randomUUID} from "node:crypto";
import {HubRoomAskAdapter,migrateRoomAsks,verifyRoomAskJournal,type RoomAskOptions,type RoomAskLink} from "../src/hub/member/room-ask.js";
const dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
async function world(ack=true,locale:"en"|"zh-TW"="en"){
 const db=new Database(":memory:");dbs.push(db);migrateRoomAsks(db);
 let live=true,reply:any=null;const generation=randomUUID(),exposureId=randomUUID(),inputs:any[]=[],sent:any[]=[],reacts:any[]=[],reminders:any[]=[];
 const ask={messageId:randomUUID(),roomId:randomUUID(),exposureId,roomName:"Weekly",asker:{name:"Reader"},text:"Thanks!",context:[]};
 reply={messageId:ask.messageId,ok:true,acknowledged:true};
 const link:RoomAskLink={current:()=>live,features:new Set(["welcome-caps-v1","room-ask-v1","room-answer-buttons-v1","room-answer-status-v1",...(ack?["room-react-ack-v1"]:[])]),sendAnswer:async x=>{sent.push(x);},sendReact:async x=>{reacts.push(x);return typeof reply==="function"?reply():reply;}};
 const options:RoomAskOptions={db,bindingKey:"owned-s254",encryptionKey:randomBytes(32),locale,current:()=>live,generation:()=>generation,
  localExposure:id=>id===exposureId?{agent:"Notes",consentId:"owned",revision:1,token:"owned"}:null,
  deliver:async x=>{if(!await x.beforeInput())return false;inputs.push(x);return true;},remind:async x=>{if(!x.stillCurrent()||!await x.beforeInput!())return false;reminders.push(x);return true;}};
 const create=()=>{const a=new HubRoomAskAdapter(options);a.connected(link);return a;},adapter=create();adapter.accept(ask,link);await adapter.settled();const cid=inputs[0].correlationId;adapter.inputHandoff(cid,"Notes",generation);
 return {db,options,adapter,create,ask,link,cid,generation,inputs,sent,reacts,reminders,setReply:(r:any)=>reply=r,retire:()=>live=false,
  react:()=>adapter.react({caller:"Notes",correlationId:cid,emoji:"👍"})!};
}
it("accepted acknowledgement completes the ask, survives reopen and never emits reminder or missing-answer marker",async()=>{
 const w=await world(),legacy=w.db.prepare("SELECT value FROM hub_room_asks").get();
 expect(await w.react()).toMatchObject({ok:true});
 expect(w.adapter.questionSettled(w.cid,"Notes")).toBe(true);
 expect(w.reacts[0]).toMatchObject({messageId:w.ask.messageId,acknowledge:true,emoji:"👍"});expect(w.adapter.hasOpenQuestion("Notes")).toBe(false);expect(w.adapter.replyWarning("Notes")).toBeUndefined();
 await w.adapter.turnEnded("Notes",w.generation,"one");await w.adapter.turnEnded("Notes",w.generation,"two");expect(w.sent).toEqual([]);expect(w.reminders).toEqual([]);
 expect(w.db.prepare("SELECT value FROM hub_room_asks").get()).toEqual(legacy);verifyRoomAskJournal(w.db,w.options);
 w.adapter.close();const reopened=w.create();expect(reopened.questionSettled(w.cid,"Notes")).toBe(true);expect(reopened.accept(w.ask,w.link)).toBe("duplicate");await reopened.settled();expect(w.inputs).toHaveLength(1);
 await reopened.turnEnded("Notes",w.generation,"three");expect(w.sent).toEqual([]);expect(w.reminders).toEqual([]);reopened.close();
});
it.each(["refused","missing-ack","wrong-message","dropped","stale"])("%s reaction does not complete the ask",async mode=>{
 const w=await world();
 w.setReply(mode==="refused"?{messageId:w.ask.messageId,ok:false,code:"revoked"}:mode==="missing-ack"?{messageId:w.ask.messageId,ok:true}:mode==="wrong-message"?{messageId:randomUUID(),ok:true,acknowledged:true}:()=>{if(mode==="stale"){w.retire();return {messageId:w.ask.messageId,ok:true,acknowledged:true};}throw Error("closed");});
 expect(await w.react()).toMatchObject({ok:false});expect(w.adapter.questionSettled(w.cid,"Notes")).toBe(false);expect(w.db.prepare("SELECT COUNT(*) n FROM hub_room_reaction_acks").get()).toEqual({n:0});w.adapter.close();
});
it("an older Hub keeps gesture behavior and its ask stays owed",async()=>{
 const w=await world(false);w.setReply({messageId:w.ask.messageId,ok:true});expect(await w.react()).toMatchObject({ok:true,message:"Reacted in the Hub room."});expect(w.reacts[0]).not.toHaveProperty("acknowledge");expect(w.adapter.questionSettled(w.cid,"Notes")).toBe(false);expect(w.inputs[0].text).toContain("older Hub connection");await w.adapter.turnEnded("Notes",w.generation,"one");expect(w.reminders).toHaveLength(1);w.adapter.close();
});
it.each(["en","zh-TW"] as const)("prompt and reminder explain acknowledgement-only completion (%s)",async locale=>{
 const w=await world(true,locale);expect(w.inputs[0].text).toContain(locale==="en"?"only acknowledges or thanks":"只是確認或道謝");expect(w.adapter.replyWarning("Notes")).toContain(locale==="en"?"stops reminders":"不再提醒");expect(w.inputs[0].text).toContain("report_result");w.adapter.close();
});
it("an already queued reminder cannot input after the reaction completes",async()=>{
 const w=await world();let reminder:any,release!:()=>void;const wait=new Promise<void>(r=>release=r);w.options.remind=async x=>{reminder=x;await wait;return x.stillCurrent()&&await x.beforeInput!();};
 const ending=w.adapter.turnEnded("Notes",w.generation,"one");await vi.waitFor(()=>expect(reminder).toBeTruthy());expect(await w.react()).toMatchObject({ok:true});expect(reminder.stillCurrent()).toBe(false);expect(await reminder.beforeInput()).toBe(false);release();await ending;expect(w.sent).toEqual([]);w.adapter.close();
});
it("corrupt companion is refused without rewriting the legacy ask",async()=>{
 const w=await world();await w.react();w.adapter.close();const row=w.db.prepare("SELECT value FROM hub_room_asks").get();w.db.prepare("UPDATE hub_room_reaction_acks SET value='broken'").run();expect(()=>w.create()).toThrow();expect(w.db.prepare("SELECT value FROM hub_room_asks").get()).toEqual(row);
});

it("a pending acknowledgement serializes against a concurrent text answer and second reaction",async()=>{
 const w=await world();let resolve!:(v:any)=>void;w.setReply(()=>new Promise(r=>resolve=r));const reaction=w.react();await vi.waitFor(()=>expect(resolve).toBeTruthy());
 expect(await w.adapter.report({caller:"Notes",correlationId:w.cid,text:"Concurrent"})).toMatchObject({ok:false});expect(await w.react()).toMatchObject({ok:false});
 resolve({messageId:w.ask.messageId,ok:true,acknowledged:true});expect(await reaction).toMatchObject({ok:true});expect(w.sent).toEqual([]);expect(w.adapter.questionSettled(w.cid,"Notes")).toBe(true);w.adapter.close();
});
