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
async function world(modern=true){
  r=await s3bRig({realAudit:true});
  const alex=r.addPerson("alex","Alex"),a=await r.signIn("alex"),admin=await r.signIn("admin");
  const fleetId=randomUUID(),caps=["welcome-caps-v1","room-ask-v1",...(modern?[HUB_ROOM_CONTEXT_CAPABILITY]:[])];
  const link=r.link(fleetId,r.admin,1,caps),exposure:HubExposure={id:randomUUID(),fleetId,owner:r.admin,displayName:"Notes",revision:1,state:"published",dataViewId:"agent",allowedTools:[],policyDigest:"b".repeat(64)};
  await r.http.receive(r.frame("exposure.snapshot",{revision:1,exposures:[exposure]},link) as never,link);
  const made=await r.call(admin,"POST","/hub/v1/rooms",{name:"Weekly",people:[personKeyString(alex)]});
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
  return {link,caps,fleetId,exposure,roomId,generation,state,input,post,ask};
}
it("first/reset includes the full window; confirmed repeat uses only new posts plus its visible reply anchor",async()=>{
  const w=await world();expect(await w.state()).toMatchObject({type:"room.context-state-result",payload:{ok:true}});
  const old=await w.post("Old history"),first=await w.ask("First question");
  expect(first.context.map(v=>v.text)).toEqual(["Old history"]);expect(first.contextState?.after).toBe(0);
  expect(await w.input(first)).toMatchObject({type:"room.context-input-result",payload:{ok:true}});
  await w.post("New history");const second=await w.ask("Second question",old.id);
  expect(second.context.map(v=>v.text)).toEqual(["Old history","New history"]);
  expect(second.context[0].repliedTo).toBe(true);expect(second.context.some(v=>v.text==="First question")).toBe(false);
  const next=randomUUID();expect(await w.state(next)).toMatchObject({payload:{ok:true}});
  expect(await w.input(second,w.generation)).toMatchObject({payload:{ok:false,code:"stale"}});
  const reset=await w.ask("After reset");expect(reset.contextState).toMatchObject({generation:next,after:0});
  expect(reset.context.map(v=>v.text)).toContain("First question");
  expect(await w.state(w.generation)).toMatchObject({payload:{ok:false,code:"stale"}});
});
it("overlapping frozen windows cover their old floor; late/duplicate receipts never regress or skip the new cursor",async()=>{
  const w=await world();await w.state();await w.post("History");
  const first=await w.ask("One"),second=await w.ask("Two");
  expect(first.contextState?.after).toBe(0);expect(second.contextState?.after).toBe(0);
  expect(second.context.map(v=>v.text)).toContain("One");
  expect(await w.input(second)).toMatchObject({payload:{ok:true}});
  expect(await w.input(first)).toMatchObject({payload:{ok:true}});expect(await w.input(first)).toMatchObject({payload:{ok:true}});
  const third=await w.ask("Three");expect(third.context).toEqual([]);expect(third.contextState?.after).toBe(second.contextState?.through);
  const foreign=r!.link(randomUUID(),r!.admin,2,w.caps);
  expect(await w.input(third,w.generation,foreign)).toMatchObject({payload:{ok:false}});
});
it("ordinary reconnect preserves the cursor after re-negotiation; old peers retain their strict full-window ask",async()=>{
  const w=await world();await w.state();await w.post("History");const first=await w.ask("One");await w.input(first);
  w.link.alive=false;const next=r!.link(w.fleetId,r!.admin,2,w.caps);
  expect(await w.state(w.generation,next)).toMatchObject({payload:{ok:true}});
  const second=await w.ask("Two");expect(second.contextState?.after).toBe(first.contextState?.through);expect(second.context).toEqual([]);
  next.alive=false;const old=r!.link(w.fleetId,r!.admin,3,["welcome-caps-v1","room-ask-v1"]);
  await r!.http.receive(r!.frame("reconcile",{afterReceiptSequence:0,messages:[]},old) as never,old);
  const full=await w.ask("Legacy");expect(full.contextState).toBeUndefined();
  expect(full.context.map(v=>v.text)).toContain("History");expect(()=>roomAskSchema.omit({contextState:true}).parse(full)).not.toThrow();
});
it.each(["fleet","owner"] as const)("context input refuses a foreign %s before advancing the cursor",async kind=>{
  const w=await world();await w.state();const first=await w.ask("Scoped receipt");
  const before=r!.db.prepare("SELECT * FROM hub_room_context_positions").all();
  // Keep a current link and matching epoch: refusal must come from the binding guard, not an unrelated stale epoch.
  // These are inert API contexts, not a claim that a WSS peer can forge its authenticated identity.
  const foreign={...w.link,fleetId:kind==="fleet"?randomUUID():w.fleetId,
    owner:kind==="owner"?r!.addPerson("other","Other"):r!.admin};
  expect(await w.input(first,w.generation,foreign)).toMatchObject({type:"room.context-input-result",payload:{ok:false,code:"stale"}});
  expect(r!.db.prepare("SELECT * FROM hub_room_context_positions").all()).toEqual(before);
  expect(await w.input(first)).toMatchObject({payload:{ok:true}});
});
