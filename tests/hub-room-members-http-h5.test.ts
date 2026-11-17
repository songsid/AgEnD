/** Actual Hub HTTP/SQLite/audit with inert member links; no Fleet, vendor CLI or directory connection. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { HUB_ROOM_CONTEXT_CAPABILITY } from "../src/hub/room-context-model.js";
import { roomAskSchema } from "../src/hub/protocol.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";
let r:Awaited<ReturnType<typeof s3bRig>>|undefined;
afterEach(async()=>{await r?.close();r=undefined;});
async function world(modern=true,brief=true){
  r=await s3bRig({realAudit:true});
  const alex=r.addPerson("alex","Alex"),a=await r.signIn("alex"),admin=await r.signIn("admin");
  const fleetId=randomUUID(),caps=["welcome-caps-v1","room-ask-v1","room-post-v1",...(modern?[HUB_ROOM_CONTEXT_CAPABILITY,...(brief?["room-brief-v1","room-members-v2"]:[])]:[])];
  const link=r.link(fleetId,r.admin,1,caps),exposure:HubExposure={id:randomUUID(),fleetId,owner:r.admin,displayName:"Notes",revision:1,state:"published",dataViewId:"agent",allowedTools:[],policyDigest:"b".repeat(64)};
  await r.http.receive(r.frame("exposure.snapshot",{revision:1,exposures:[exposure]},link) as never,link);
  const made=await r.call(admin,"POST","/hub/v1/rooms",{name:"Weekly",purpose:"Release questions",people:[personKeyString(alex)]});
  expect(made.status).toBe(200);const roomId=made.json.room.id;
  expect((await r.call(admin,"POST",`/hub/v1/rooms/${roomId}/members`,{kind:"agent",id:exposure.id})).status).toBe(200);
  const generation=randomUUID();
  const state=(g=generation,l=link)=>r!.http.receive(r!.frame("room.context-state",{exposureId:exposure.id,generation:g},l) as never,l);
  const input=(ask:HubRoomAsk,g=generation,l=link)=>r!.http.receive(r!.frame("room.context-input",{messageId:ask.messageId,exposureId:exposure.id,generation:g},l) as never,l);
  const post=async(text:string,mentions:string[]=[],replyTo?:string)=>{
    const got=await r!.call(a,"POST",`/hub/v1/rooms/${roomId}/messages`,{text,mentions,idempotencyKey:randomUUID(),...(replyTo?{replyTo}:{})});
    expect(got.status).toBe(200);return got.json;
  };
  const asks=()=>r!.sent.filter(s=>s.frame.type==="room.ask").map(s=>s.frame.payload as HubRoomAsk);
  // Reconnect may replay another frozen delivery; select this parent by its exact question identity.
  const ask=async(text:string,replyTo?:string)=>{await post(text,[exposure.id],replyTo);await vi.waitFor(()=>expect(asks().some(a=>a.text===text)).toBe(true));return asks().find(a=>a.text===text)!;};
  return {link,caps,fleetId,exposure,roomId,generation,state,input,post,ask,admin};
}


it("H5 bounded lookup starts with purpose and counts, includes intros only on agents and preserves legacy shape",async()=>{
 const w=await world();const result:any=await r!.http.receive(r!.frame("room.members",{exposureId:w.exposure.id,room:w.roomId,v2:true,limit:1},w.link) as never,w.link);
 expect(result.payload).toMatchObject({ok:true,v2:true,purpose:"Release questions",counts:{people:2,agents:1,matched:3,returned:1},members:[{kind:"agent",name:"Notes",intro:""}]});expect(result.payload.next_cursor).toBeTypeOf("string");expect(Buffer.byteLength(JSON.stringify(result.payload))).toBeLessThanOrEqual(8192);
 const next:any=await r!.http.receive(r!.frame("room.members",{exposureId:w.exposure.id,room:w.roomId,v2:true,limit:1,cursor:result.payload.next_cursor},w.link) as never,w.link);expect(next.payload.members[0].kind).toBe("person");expect(next.payload.members[0].intro).toBeUndefined();
 const legacy:any=await r!.http.receive(r!.frame("room.members",{exposureId:w.exposure.id,room:w.roomId},w.link) as never,w.link);expect(Object.keys(legacy.payload)).toEqual(["ok","roomId","members"]);expect(legacy.payload.members[0].intro).toBeUndefined();
});
it("H5 keyword and kind filter authorized roster; unknown capability cannot request v2",async()=>{
 const w=await world();const query:any=await r!.http.receive(r!.frame("room.members",{exposureId:w.exposure.id,room:w.roomId,v2:true,query:"aLeX",kind:"person"},w.link) as never,w.link);expect(query.payload).toMatchObject({ok:true,counts:{matched:1,returned:1},members:[{name:"Alex",kind:"person"}]});
 (w.link.features as Set<string>).delete("room-members-v2");expect(await r!.http.receive(r!.frame("room.members",{exposureId:w.exposure.id,room:w.roomId,v2:true},w.link) as never,w.link)).toMatchObject({payload:{ok:false,code:"unavailable"}});
});
