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
  const fleetId=randomUUID(),caps=["welcome-caps-v1","room-ask-v1",...(modern?[HUB_ROOM_CONTEXT_CAPABILITY,...(brief?["room-brief-v1"]:[])]:[])];
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

it("H4 confirms first brief and roster with the same consumed-input receipt; unchanged has no reminder",async()=>{
 const w=await world();await w.state();await w.post("History");const first:any=await w.ask("One");
 expect(first.brief).toEqual({kind:"first",purpose:"Release questions",people:2,agents:1});
 const retry:any=await w.ask("Still unconfirmed");expect(retry.brief.kind).toBe("first");
 await w.input(first);const next:any=await w.ask("Two");expect(next.brief).toBeUndefined();expect(next.contextState.after).toBe(first.contextState.through);
 await r!.restartHttp();await w.state();const again:any=await w.ask("After Hub restart");expect(again.brief).toBeUndefined();
 const reset=randomUUID();await w.state(reset);const fresh:any=await w.ask("After context reset");expect(fresh.brief.kind).toBe("first");expect(fresh.contextState.after).toBe(0);
});
it("H4 membership deltas follow confirmed snapshots and late receipts cannot regress them",async()=>{
 const w=await world();await w.state();const first:any=await w.ask("One");await w.input(first);
 const person=r!.addPerson("reader","Reader");await r!.signIn("reader");await r!.call(w.admin,"POST",`/hub/v1/rooms/${w.roomId}/members`,{kind:"person",id:personKeyString(person)});
 const changed:any=await w.ask("Changed"),overlap:any=await w.ask("Overlap");
 expect(changed.brief).toEqual({kind:"delta",joined:[{kind:"person",name:"Reader"}],left:[],omitted:0});
 expect(overlap.brief).toEqual(changed.brief);await w.input(overlap);await w.input(first);
 expect((await w.ask("No change") as any).brief).toBeUndefined();
});
it("H4 old Fleet retains its strict ask without any brief",async()=>{
 const w=await world(false);const ask:any=await w.ask("Legacy");expect(ask.brief).toBeUndefined();expect(ask.contextState).toBeUndefined();
});

it("H4 context-only peer stays strict; upgrading sends a full brief/window together; a new room membership resets both",async()=>{
 const w=await world(true,false);await w.state();await w.post("Old history");const legacy:any=await w.ask("Context only");
 expect(legacy.contextState.after).toBe(0);expect(legacy.brief).toBeUndefined();expect(()=>roomAskSchema.omit({brief:true}).parse(legacy)).not.toThrow();await w.input(legacy);
 expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_room_brief_positions").get()).toEqual({n:0});
 (w.link.features as Set<string>).add("room-brief-v1");const upgraded:any=await w.ask("Upgraded");expect(upgraded.brief.kind).toBe("first");expect(upgraded.contextState.after).toBe(0);expect(upgraded.context.map((m:any)=>m.text)).toContain("Old history");await w.input(upgraded);
 const member=r!.db.prepare("SELECT id FROM hub_room_members WHERE room_id=? AND subject=?").get(w.roomId,w.exposure.id) as {id:string};
 expect((await r!.call(w.admin,"DELETE",`/hub/v1/rooms/${w.roomId}/members/${member.id}`)).status).toBe(200);
 expect((await r!.call(w.admin,"POST",`/hub/v1/rooms/${w.roomId}/members`,{kind:"agent",id:w.exposure.id})).status).toBe(200);
 const rejoined:any=await w.ask("Joined again");expect(rejoined.brief.kind).toBe("first");expect(rejoined.contextState.after).toBe(0);expect(rejoined.context.map((m:any)=>m.text)).not.toContain("Old history");
});
