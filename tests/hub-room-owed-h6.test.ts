import {afterEach,expect,it,vi} from "vitest";
import Database from "better-sqlite3";
import {randomUUID,randomBytes} from "node:crypto";
import {HubRoomAskAdapter,migrateRoomAsks,type RoomAskOptions} from "../src/hub/member/room-ask.js";
const dbs:Database.Database[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
async function world(modern=true,locale:"en"|"zh-TW"="en",confirm=true,cold=false){
 const db=new Database(":memory:");dbs.push(db);migrateRoomAsks(db);let live=true,launched=!cold;const generation=randomUUID(),exposureId=randomUUID(),inputs:any[]=[],sent:any[]=[],reminders:any[]=[];
 const link={current:()=>live,features:new Set(["welcome-caps-v1","room-ask-v1",...(modern?["room-answer-status-v1"]:[])]),sendAnswer:vi.fn(async(value:any)=>{sent.push(value);})};
 const options:RoomAskOptions={db,bindingKey:"owned-h6",encryptionKey:randomBytes(32),current:()=>live,locale,generation:()=>launched?generation:null,localExposure:id=>id===exposureId?{agent:"Notes",consentId:"consent",revision:1,token:"owned"}:null,deliver:async input=>{await input.beforeInput();inputs.push(input);launched=true;return true;}};
 (options as any).remind=async(input:any)=>{if(!input.stillCurrent()||!await input.beforeInput())return false;reminders.push(input);return true;};
 const create=()=>{const a=new HubRoomAskAdapter(options) as any;a.connected(link);return a;};const adapter=create();
 adapter.accept({messageId:randomUUID(),roomId:randomUUID(),roomName:"Release",exposureId,asker:{name:"Reader"},text:"Question",context:[]},link);await adapter.settled();if(confirm)adapter.inputHandoff(inputs[0].correlationId,"Notes",generation);
 return {adapter,create,options,link,inputs,sent,reminders,generation,retire:()=>{live=false;}};
}
it.each(["en","zh-TW"] as const)("H6 warns locally without sending a room answer (%s)",async locale=>{
 const w=await world(true,locale),warning=w.adapter.replyWarning("Notes");expect(warning).toContain("Release");expect(warning).toContain("Reader");expect(warning).toContain(w.inputs[0].correlationId);expect(warning).toContain("report_result");expect(w.sent).toEqual([]);expect(w.adapter.replyWarning("Other")).toBeUndefined();w.adapter.close();
});
it("H6 one reminder then second completed turn marks No answer, duplicate/restart does not repeat it, late answer stays real",async()=>{
 const w=await world();await w.adapter.turnEnded("Notes",w.generation,"turn-one");expect(w.reminders).toHaveLength(1);expect(w.sent).toHaveLength(0);
 await w.adapter.turnEnded("Notes",w.generation,"turn-one");expect(w.reminders).toHaveLength(1);w.adapter.close();const restored=w.create();
 await restored.turnEnded("Notes",w.generation,"turn-one");expect(w.sent).toHaveLength(0);
 await restored.turnEnded("Notes",w.generation,"turn-two");expect(w.sent).toHaveLength(1);expect(w.sent[0]).toMatchObject({text:"",notAnswered:"finished-without-answer"});expect(restored.acknowledge(w.sent[0],w.link)).toBe(true);
 await restored.turnEnded("Notes",w.generation,"turn-three");expect(w.reminders).toHaveLength(1);expect(w.sent).toHaveLength(1);
 expect(await restored.report({caller:"Notes",correlationId:w.inputs[0].correlationId,text:"Late actual answer"})).toMatchObject({ok:true});expect(w.sent[1]).toMatchObject({text:"Late actual answer"});expect(w.sent[1]).not.toHaveProperty("notAnswered");restored.close();
});
it("H6 old Hub gets local warning/reminder but never an empty marker; retired generation/owner stops local obligations",async()=>{
 const w=await world(false);await w.adapter.turnEnded("Notes",w.generation,"one");await w.adapter.turnEnded("Notes",w.generation,"two");expect(w.reminders).toHaveLength(1);expect(w.sent).toEqual([]);
 expect(w.adapter.replyWarning("Notes")).toBeTypeOf("string");w.retire();expect(w.adapter.replyWarning("Notes")).toBeUndefined();await w.adapter.turnEnded("Notes",w.generation,"three");expect(w.sent).toEqual([]);w.adapter.close();
});

it("H6 requires actual input and a reminder handoff before escalation, and never repeats an uncertain reminder",async()=>{
 const unconfirmed=await world(true,"en",false);await unconfirmed.adapter.turnEnded("Notes",unconfirmed.generation,"one");expect(unconfirmed.reminders).toEqual([]);unconfirmed.adapter.close();
 const w=await world();let attempts=0;(w.options as any).remind=async(input:any)=>{attempts++;if(await input.beforeInput())throw Error("uncertain after handoff");return false;};
 await w.adapter.turnEnded("Notes",w.generation,"one");await w.adapter.flush();expect(attempts).toBe(1);expect(w.sent).toEqual([]);await w.adapter.turnEnded("Notes",randomUUID(),"foreign");expect(w.sent).toEqual([]);w.adapter.close();
});
it("H6 a real answer wins while the No-answer marker is in flight",async()=>{
 const w=await world();await w.adapter.turnEnded("Notes",w.generation,"one");let release!:()=>void,started=false;
 w.link.sendAnswer.mockImplementation(async(value:any)=>{w.sent.push(value);if(value.notAnswered){started=true;await new Promise<void>(r=>{release=r;});}});
 const marking=w.adapter.turnEnded("Notes",w.generation,"two");await vi.waitFor(()=>expect(started).toBe(true));expect(await w.adapter.report({caller:"Notes",correlationId:w.inputs[0].correlationId,text:"Real answer"})).toMatchObject({ok:true});release();await marking;
 const marker=w.sent.find(v=>v.notAnswered);expect(w.adapter.acknowledge(marker,w.link)).toBe(true);expect(w.sent.find(v=>v.text==="Real answer")).not.toHaveProperty("notAnswered");w.adapter.close();
});

it("H6 a cold agent binds the owned generation at positive input and still gets its reminder",async()=>{
 const w=await world(true,"en",true,true);expect(w.inputs[0].roomContextGeneration).toBeUndefined();expect(w.adapter.replyWarning("Notes")).toContain("report_result");await w.adapter.turnEnded("Notes",w.generation,"one");expect(w.reminders).toHaveLength(1);w.adapter.close();
});
