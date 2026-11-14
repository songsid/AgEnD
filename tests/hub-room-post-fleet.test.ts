import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HubRoomPostAdapter, type RoomIdentity, type RoomPostLink } from "../src/hub/member/room-post.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { TOOLS } from "../src/channel/mcp-tools.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db);
  let local: RoomIdentity | null = { exposureId: randomUUID(), revision: 1, consentId: randomUUID(), token: "owned-token" };
  let current = true, callerCurrent = true;
  const received: unknown[] = [], roomId = randomUUID(), messageId = randomUUID();
  const changed = vi.fn();
  const options = { db, binding: "owned-binding", encryptionKey: Buffer.alloc(32, 17), current: () => current,
    local: (agent: string) => agent === "agent-A" ? local : null, changed };
  const make = () => new HubRoomPostAdapter(options), adapter = make();
  const link: RoomPostLink = { features: new Set(["welcome-caps-v1", "room-ask-v1", "room-post-v1"]), current: () => current,
    list: vi.fn(async exposureId => ({ ok: true as const, exposureId, rooms: [{ id: roomId, name: "Weekly" }] })),
    post: vi.fn(async value => { received.push(value); return { ok: true as const, roomId, messageId, at: 1000 }; }) };
  const caller = { agent: "agent-A", current: () => callerCurrent };
  return { db, adapter, make, link, caller, received, roomId, messageId, changed, options,
    replace: () => { local = { ...local!, token: "replacement-token" }; }, withdraw: () => { local = null; },
    stop: () => { current = false; }, retireCaller: () => { callerCurrent = false; } };
}
it("offers the two MCP schemas and actual outbound handlers without caller identity arguments", () => {
  for (const name of ["hub_room_list", "hub_room_post"]) {
    const tool = TOOLS.find(t => t.name === name); expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).not.toHaveProperty("agent");
    expect(outboundHandlers.has(name)).toBe(true);
  }
});
it("requires all negotiated capabilities and a current reconciled link", async () => {
  const h = fixture(); expect(h.adapter.available()).toBe(false);
  h.adapter.connected(h.link); expect(h.adapter.available()).toBe(true);
  for (const cap of ["welcome-caps-v1", "room-ask-v1", "room-post-v1"]) {
    const features = new Set(h.link.features); features.delete(cap);
    h.adapter.connected({ ...h.link, features }); expect(h.adapter.available()).toBe(false);
    expect((await h.adapter.rooms(h.caller)).ok).toBe(false);
  }
  h.adapter.connected(h.link); h.stop(); expect(h.adapter.available()).toBe(false);
});
it("maps only the invoking agent and uses the authoritative room response", async () => {
  const h = fixture(); h.adapter.connected(h.link);
  expect(await h.adapter.rooms(h.caller)).toMatchObject({ ok: true, rooms: [{ name: "Weekly" }] });
  expect(await h.adapter.rooms({ ...h.caller, agent: "agent-B" })).toMatchObject({ ok: false });
  expect(h.link.list).toHaveBeenCalledTimes(1);
  expect(await h.adapter.post(h.caller, { room: "Weekly", text: "Update", operationId: randomUUID() })).toMatchObject({ ok: true, messageId: h.messageId });
  expect(h.received[0]).toMatchObject({ exposureId: expect.any(String), room: "Weekly", text: "Update" });
});
it("bounds members and people reads to the invoking exposure and retires held disclosures",async()=>{
  const h=fixture();h.adapter.connected(h.link);
  h.link.members=vi.fn(async()=>({ok:true as const,roomId:h.roomId,members:[{kind:"person" as const,id:"corp/person-A",name:"Alex",presence:"online"}]}));
  h.link.people=vi.fn(async()=>({ok:true as const,people:[{id:"corp/person-A",name:"Alex",login:"alex"}],truncated:false}));
  expect(await h.adapter.members(h.caller,"Weekly")).toMatchObject({ok:true,members:[{name:"Alex"}]});
  expect(h.link.members).toHaveBeenCalledWith(expect.any(String),"Weekly");
  expect(await h.adapter.people(h.caller,"Al")).toMatchObject({ok:true,people:[{login:"alex"}]});
  expect(await h.adapter.people(h.caller,"A")).toMatchObject({ok:false,code:"invalid"});
  expect(h.link.people).toHaveBeenCalledTimes(1);
  h.link.people=async()=>{h.replace();return {ok:true,people:[{id:"corp/person-A",name:"Alex",login:"alex"}],truncated:false};};
  expect(await h.adapter.people(h.caller,"Al")).toEqual({ok:false,code:"stale"});
  h.link.people=async()=>({ok:true,people:[{id:"corp/person-A",name:"Alex",login:"alex",dn:"not-for-disclosure"}],truncated:false});
  expect(await h.adapter.people(h.caller,"Al")).toEqual({ok:false,code:"unavailable"});
  h.link.members=async()=>({ok:false,code:"rate-limited",retryAt:2000});
  expect(await h.adapter.members(h.caller,"Weekly")).toEqual({ok:false,code:"rate-limited",retryAt:2000});
});
it("requires a fresh verified receipt, freezes its identity and rechecks after the post",async()=>{
  const h=fixture(),receiptId=`hmsg-${randomUUID()}`,operationId=randomUUID();h.adapter.connected(h.link);
  expect(await h.adapter.post(h.caller,{room:"Weekly",text:"@all Update",operationId,receiptId})).toEqual({ok:false,code:"denied"});
  expect(h.link.post).not.toHaveBeenCalled();
  let valid=true;
  Object.assign(h.options,{receipt:(_caller:unknown,id:string)=>({receiptId:id,current:()=>valid})});
  expect(await h.adapter.post(h.caller,{room:"Weekly",text:"@all Update",operationId,receiptId})).toMatchObject({ok:true});
  expect(h.received[0]).toMatchObject({onBehalfOf:{receiptId},idempotencyKey:operationId});
  expect(await h.adapter.post(h.caller,{room:"Weekly",text:"@all Update",operationId,receiptId:`hmsg-${randomUUID()}`})).toEqual({ok:false,code:"conflict"});
  h.link.post=async()=>{valid=false;return {ok:true,roomId:h.roomId,messageId:randomUUID(),at:1000};};
  expect(await h.adapter.post(h.caller,{room:"Weekly",text:"Second",operationId:randomUUID(),receiptId})).toEqual({ok:false,code:"uncertain"});
});
it("retires old caller/consent observations across an awaited response", async () => {
  const h = fixture(); h.adapter.connected(h.link);
  h.link.list = async exposureId => { h.replace(); return { ok: true, exposureId, rooms: [] }; };
  expect(await h.adapter.rooms(h.caller)).toMatchObject({ ok: false, code: "stale" });
  h.link.post = async () => { h.retireCaller(); return { ok: true, roomId: h.roomId, messageId: h.messageId, at: 1000 }; };
  expect(await h.adapter.post(h.caller, { room: h.roomId, text: "Update", operationId: randomUUID() })).toMatchObject({ ok: false, code: "uncertain" });
});
it("retains exact operation identity/body across an uncertain outcome and adapter restart", async () => {
  const h = fixture(), operationId = randomUUID(); h.adapter.connected(h.link);
  const post = h.link.post;
  h.link.post = vi.fn(async value => { h.received.push(value); throw Error("lost result"); });
  expect(await h.adapter.post(h.caller, { room: h.roomId, text: "Frozen", operationId })).toMatchObject({ ok: false, code: "uncertain" });
  h.adapter.close(); h.link.post = post;
  const second = h.make(); second.connected(h.link);
  expect(await second.post(h.caller, { room: h.roomId, text: "Changed", operationId })).toMatchObject({ ok: false, code: "conflict" });
  expect(await second.post(h.caller, { room: h.roomId, text: "Frozen", operationId })).toMatchObject({ ok: true });
  expect(h.received).toHaveLength(2); expect(h.received[0]).toEqual(h.received[1]);
  expect(JSON.stringify(h.db.prepare("SELECT * FROM hub_room_posts").all())).not.toContain("Frozen");
  expect(await second.post(h.caller, { room: h.roomId, text: "Frozen", operationId })).toMatchObject({ ok: true });
  expect(h.received).toHaveLength(2);
});
it("does not replay a prepared operation after the local consent changed", async () => {
  const h = fixture(), operationId = randomUUID(); h.adapter.connected(h.link);
  h.link.post = async () => { throw Error("unknown"); };
  await h.adapter.post(h.caller, { room: h.roomId, text: "Frozen", operationId }); h.replace();
  expect(await h.adapter.post(h.caller, { room: h.roomId, text: "Frozen", operationId })).toMatchObject({ ok: false, code: "stale" });
});
it("recovers a permanently lost post result only from the exact retained operation in a Hub reply",async()=>{
  const h=fixture(),operationId=randomUUID(),inputs:unknown[]=[];
  Object.assign(h.options,{notify:async(input:any)=>{if(!await input.beforeInput())return false;inputs.push(input);return true;}});
  h.link.ack=vi.fn();h.adapter.connected(h.link);h.link.post=async()=>{throw Error("post result permanently lost");};
  expect(await h.adapter.post(h.caller,{room:h.roomId,text:"Frozen",operationId})).toMatchObject({ok:false,code:"uncertain"});
  const reply={id:randomUUID(),idempotencyKey:operationId,postId:h.messageId,roomId:h.roomId,exposureId:h.options.local("agent-A")!.exposureId,
    message:{id:randomUUID(),author:{name:"Alex"},text:"Reply",at:1000}};
  expect(h.adapter.receiveAnswer(reply,h.link)).toBe(true);await h.adapter.answersSettled();expect(inputs).toHaveLength(1);
  expect(h.link.ack).toHaveBeenCalledWith(reply.id);h.adapter.close();
  const restored=h.make();restored.connected(h.link);expect(restored.receiveAnswer(reply,h.link)).toBe(true);await restored.answersSettled();expect(inputs).toHaveLength(1);
});
it("refuses reply recovery for an unknown operation, foreign body binding, retired consent or changed canonical post",async()=>{
  const h=fixture(),operationId=randomUUID();h.link.ack=vi.fn();h.adapter.connected(h.link);h.link.post=async()=>{throw Error("lost");};
  await h.adapter.post(h.caller,{room:h.roomId,text:"Frozen",operationId});
  const reply={id:randomUUID(),idempotencyKey:operationId,postId:h.messageId,roomId:h.roomId,exposureId:h.options.local("agent-A")!.exposureId,
    message:{id:randomUUID(),author:{name:"Alex"},text:"Reply",at:1000}};
  for(const change of [{idempotencyKey:randomUUID()},{roomId:randomUUID()},{exposureId:randomUUID()},{receiptId:`hmsg-${randomUUID()}`}])expect(h.adapter.receiveAnswer({...reply,...change},h.link)).toBe(false);
  expect(h.adapter.receiveAnswer(reply,h.link)).toBe(true);
  expect(h.adapter.receiveAnswer({...reply,id:randomUUID(),postId:randomUUID()},h.link)).toBe(false);
  h.replace();expect(h.adapter.receiveAnswer({...reply,id:randomUUID()},h.link)).toBe(false);
});
it("holds concurrent calls to the same durable identity and refuses a changed body", async () => {
  const h=fixture(),operationId=randomUUID(); h.adapter.connected(h.link);
  let release!:()=>void; const wait=new Promise<void>(r=>{release=r;});
  h.link.post=vi.fn(async()=>{await wait;return {ok:true as const,roomId:h.roomId,messageId:h.messageId,at:1000};});
  const value={room:h.roomId,text:"Frozen",operationId};
  const first=h.adapter.post(h.caller,value),second=h.adapter.post(h.caller,value);
  expect(h.link.post).toHaveBeenCalledTimes(1);
  expect(await h.adapter.post(h.caller,{...value,text:"Different"})).toMatchObject({ok:false,code:"conflict"});
  const third=h.adapter.post(h.caller,value); expect(h.link.post).toHaveBeenCalledTimes(1);
  release();expect((await first).ok).toBe(true);expect((await second).ok).toBe(true);expect((await third).ok).toBe(true);
});
it("authenticates every retained call and does not turn corrupt or foreign state into an empty store", async () => {
  const h=fixture(); h.adapter.connected(h.link);
  await h.adapter.post(h.caller,{room:h.roomId,text:"Frozen",operationId:randomUUID()});h.adapter.close();
  h.db.prepare("UPDATE hub_room_posts SET value=?").run(Buffer.alloc(32).toString("base64"));
  expect(()=>h.make()).toThrow();
});
it("does not send after withdrawal/close and rejects invalid text before creating an intent", async () => {
  const h=fixture();h.adapter.connected(h.link);
  expect(await h.adapter.post(h.caller,{room:h.roomId,text:" ",operationId:randomUUID()})).toMatchObject({ok:false,code:"invalid"});
  expect(h.db.prepare("SELECT count(*) AS n FROM hub_room_posts").get()).toEqual({n:0});
  h.withdraw();expect((await h.adapter.rooms(h.caller)).ok).toBe(false);h.adapter.close();
  expect(h.link.post).not.toHaveBeenCalled();expect(h.adapter.available()).toBe(false);
});
it("does not disclose an old-link list result or retry a rate-limit result automatically", async () => {
  const h=fixture();h.adapter.connected(h.link);
  h.link.list=async exposureId=>{h.adapter.connected({...h.link});return {ok:true,exposureId,rooms:[]};};
  expect(await h.adapter.rooms(h.caller)).toMatchObject({ok:false,code:"stale"});
  h.adapter.connected(h.link);h.link.post=vi.fn(async()=>({ok:false as const,code:"rate-limited" as const,retryAt:2000}));
  expect(await h.adapter.post(h.caller,{room:h.roomId,text:"Update",operationId:randomUUID()})).toEqual({ok:false as const,code:"rate-limited" as const,retryAt:2000});
  expect(h.link.post).toHaveBeenCalledTimes(1);
});
it("outbound admission refuses a sibling session, forged identity fields and a retired daemon", async () => {
  const post=vi.fn(async(_caller:any,_value:any)=>({ok:true,roomId:randomUUID(),messageId:randomUUID(),at:1000}));
  const ctx:any={hubRoomToolsAvailable:()=>true,hubRoomPost:post,getDaemonBootId:()=>"new-boot"};
  const handler=outboundHandlers.get("hub_room_post")!, reply=vi.fn();
  const meta={instanceName:"agent-A",requestId:1,fleetRequestId:undefined,senderSessionName:undefined,operationId:randomUUID(),sourceDaemonBootId:"new-boot"};
  await handler(ctx,{room:"Weekly",text:"Update"},reply,{...meta,senderSessionName:"external-sibling"});
  await handler(ctx,{room:"Weekly",text:"Update",agent:"agent-B"},reply,meta);
  await handler(ctx,{room:"Weekly",text:"Update"},reply,{...meta,sourceDaemonBootId:"old-boot"});
  expect(post).not.toHaveBeenCalled();
  await handler(ctx,{room:"Weekly",text:"Update"},reply,meta);expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]![0]).toMatchObject({agent:"agent-A"});
});
