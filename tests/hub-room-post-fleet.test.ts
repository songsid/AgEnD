import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HubRoomPostAdapter, type RoomIdentity, type RoomPostLink } from "../src/hub/member/room-post.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import {HUB_ROOM_MENTION_FEEDBACK_CAPABILITY} from "../src/hub/room-mention-feedback-model.js";

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
it("recovers a cached post result's exact feedback without sending a new operation",async()=>{
  const h=fixture(),value={id:randomUUID(),refusals:[{code:"personal-people-only" as const,name:"Private notes"}]},feedback=vi.fn(()=>false);
  const adapter=new HubRoomPostAdapter({...h.options,feedback}),link={...h.link,features:new Set([...h.link.features,HUB_ROOM_MENTION_FEEDBACK_CAPABILITY]),
    post:vi.fn(async()=>({ok:true as const,roomId:h.roomId,messageId:h.messageId,at:1000,mentionRefusals:value}))};adapter.connected(link);
  const input={room:h.roomId,text:"Ask @Private notes",operationId:randomUUID()};
  expect(await adapter.post(h.caller,input)).toMatchObject({ok:false,code:"uncertain"});feedback.mockReturnValue(true);
  expect(await adapter.post(h.caller,input)).toMatchObject({ok:true,messageId:h.messageId});expect(link.post).toHaveBeenCalledTimes(1);
  expect(feedback).toHaveBeenLastCalledWith(value,expect.objectContaining({agent:"agent-A",exposureId:expect.any(String),token:"owned-token"}),`post:${input.operationId}:${h.messageId}`);adapter.close();
});
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
  Object.assign(h.options,{receipt:(_caller:unknown,id:string)=>({receiptId:id,current:()=>valid,fresh:()=>true})});
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

it("H5 negotiates bounded options, refuses unsupported filters and fences an awaited disclosure",async()=>{
 const h=fixture();h.adapter.connected(h.link);h.link.members=vi.fn(async()=>({ok:true as const,roomId:h.roomId,members:[]}));
 expect(await h.adapter.members(h.caller,"Weekly",{query:"Notes"})).toMatchObject({ok:false,code:"unavailable",message:expect.stringContaining("does not support")});expect(h.link.members).not.toHaveBeenCalled();
 const result={ok:true as const,v2:true as const,roomId:h.roomId,purpose:"Purpose",counts:{people:0,agents:0,assistant:false,matched:0,returned:0},members:[]};
 const modern={...h.link,features:new Set([...h.link.features,"room-members-v2"]),members:vi.fn(async()=>result)};h.adapter.connected(modern);
 expect(await h.adapter.members(h.caller,"Weekly",{query:"Notes",kind:"agent",limit:7})).toEqual(result);
 expect(modern.members).toHaveBeenCalledWith(expect.any(String),"Weekly",{v2:true,query:"Notes",kind:"agent",limit:7});
 modern.members.mockImplementationOnce(async()=>{h.replace();return result;});expect(await h.adapter.members(h.caller,"Weekly")).toEqual({ok:false,code:"stale"});
});

it("M-3639: learns direct IDs only from an opted-in list and refuses an old Hub before posting",async()=>{
 const h=fixture();h.link.list=async exposureId=>({ok:true,exposureId,rooms:[{id:h.roomId,name:"Demo reader",kind:"direct"}]});h.adapter.connected(h.link);
 expect(await h.adapter.rooms(h.caller)).toMatchObject({ok:false});
 (h.link.features as Set<string>).add("direct-posts-v1");expect(await h.adapter.rooms(h.caller)).toMatchObject({ok:true});
 expect(await h.adapter.post(h.caller,{room:h.roomId,text:"Follow-up",operationId:randomUUID()})).toMatchObject({ok:true});expect(h.received[0]).toMatchObject({direct:true});
 (h.link.features as Set<string>).delete("direct-posts-v1");
 expect(await h.adapter.post(h.caller,{room:h.roomId,text:"Later",operationId:randomUUID()})).toMatchObject({ok:false,message:expect.stringContaining("too old")});expect(h.link.post).toHaveBeenCalledTimes(1);
});
it("M-3639: freezes files before send, coalesces concurrent calls, and retries the same refs after restart",async()=>{
 const h=fixture(),ids:string[]=[],refs:unknown[]=[],bytes=Buffer.from("fixture"),sha256="1".repeat(64);
 const files={prepare:vi.fn(async()=>[{ref:{id:randomUUID(),name:"demo.txt",size:bytes.length,mime:"text/plain",sha256},bytes}]),send:vi.fn(async(file:any,put:any)=>{ids.push(file.ref.id);await put({id:file.ref.id,offset:0,total:bytes.length,sha256,data:bytes.toString("base64")});})};
 const opts={...h.options,directRoom:()=>true,files:files as never};const adapter=new HubRoomPostAdapter(opts),link={...h.link,features:new Set([...h.link.features,"direct-posts-v1","attachments-v1"]),putFile:vi.fn(async()=>{}),post:vi.fn(async(value:any)=>{refs.push(value.attachments);throw Error("lost result");})};adapter.connected(link);
 const input={room:h.roomId,text:"",files:["demo.txt"],operationId:randomUUID()};
 expect(await Promise.all([adapter.post(h.caller,input),adapter.post(h.caller,input)])).toEqual([{ok:false,code:"uncertain"},{ok:false,code:"uncertain"}]);expect(link.post).toHaveBeenCalledTimes(1);adapter.close();
 const next=new HubRoomPostAdapter(opts);next.connected({...link,post:async value=>{refs.push(value.attachments);return {ok:true,roomId:h.roomId,messageId:h.messageId,at:1000,message:"Delivered to Demo reader."};}});
 expect(await next.post(h.caller,input)).toMatchObject({ok:true});expect(refs[1]).toEqual(refs[0]);expect(ids[1]).toBe(ids[0]);
 expect(await next.post(h.caller,{...input,files:["different.txt"]})).toMatchObject({ok:false,code:"conflict"});next.close();
 // Saved success omits display-only additions, so the older strict journal reader remains usable.
 expect(()=>new HubRoomPostAdapter(opts)).not.toThrow();
});
it("M-3639: changing files or retiring consent during file staging never posts",async()=>{
 const h=fixture();let content="1".repeat(64),stop=false;
 const files={prepare:vi.fn(async()=>[{ref:{id:randomUUID(),name:"demo.txt",size:1,mime:"text/plain",sha256:content},bytes:Buffer.from("x")}]),send:vi.fn(async()=>{if(stop)h.replace();})};
 const a=new HubRoomPostAdapter({...h.options,directRoom:()=>true,files:files as never}),link={...h.link,features:new Set([...h.link.features,"direct-posts-v1","attachments-v1"]),putFile:vi.fn(async()=>{}),post:vi.fn(async()=>{throw Error("lost");})};a.connected(link);
 const input={room:h.roomId,text:"File",files:["demo.txt"],operationId:randomUUID()};await a.post(h.caller,input);expect(link.post).toHaveBeenCalledTimes(1);content="2".repeat(64);
 expect(await a.post(h.caller,input)).toMatchObject({ok:false,code:"conflict"});expect(link.post).toHaveBeenCalledTimes(1);
 stop=true;expect(await a.post(h.caller,{...input,operationId:randomUUID()})).toMatchObject({ok:false,code:"uncertain"});expect(link.post).toHaveBeenCalledTimes(1);a.close();
});
it.each(["caller","consent"])("M-3639 R1: a retired %s cannot send another chunk after an outstanding acknowledgement",async kind=>{
 const h=fixture(),bytes=Buffer.alloc(180*1024+1,65),ref={id:randomUUID(),name:"demo.txt",size:bytes.length,mime:"text/plain",sha256:"a".repeat(64)};
 const {HubMemberFiles}=await import("../src/hub/member/attachments.js");
 const files={prepare:async()=>[{ref,bytes}],send:HubMemberFiles.prototype.send};
 let entered!:()=>void,release!:()=>void;const first=new Promise<void>(yes=>{entered=yes;}),held=new Promise<void>(yes=>{release=yes;});
 const putFile=vi.fn(async()=>{entered();await held;});
 const a=new HubRoomPostAdapter({...h.options,directRoom:()=>true,files:files as never});const link={...h.link,features:new Set([...h.link.features,"direct-posts-v1","attachments-v1"]),putFile};a.connected(link);
 const result=a.post(h.caller,{room:h.roomId,text:"File",files:["demo.txt"],operationId:randomUUID()});await first;
 if(kind==="caller")h.retireCaller();else h.replace();release();
 expect(await result).toMatchObject({ok:false});expect(putFile).toHaveBeenCalledTimes(1);expect(link.post).not.toHaveBeenCalled();a.close();
});

it("S-232 the room post owner enforces issuer and original room before durable intent",async()=>{
 const f=fixture(),hubId=randomUUID(),adapter=new HubRoomPostAdapter({...f.options,hubId});adapter.connected(f.link);const id=randomUUID(),context:any={ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"accepted",ingress:"hub",initiatingActor:{kind:"person",platform:"hub",hubId,id:"directory/demo-person"},source:{instance:"agent-A",incarnation:"v1"},sourceAudience:{kind:"room",ref:f.roomId}},scope={context,current:()=>true};
 expect(await adapter.post({...f.caller,requestScope:scope},{room:randomUUID(),text:"No",operationId:randomUUID()})).toMatchObject({ok:false,code:"denied"});expect(await adapter.post({...f.caller,requestScope:{context:{...context,initiatingActor:{...context.initiatingActor,hubId:randomUUID()}},current:()=>true}},{room:f.roomId,text:"No",operationId:randomUUID()})).toMatchObject({ok:false,code:"denied"});
 expect(f.db.prepare("SELECT COUNT(*) n FROM hub_room_posts").get()).toEqual({n:0});expect(await adapter.post({...f.caller,requestScope:scope},{room:f.roomId,text:"Right audience",operationId:randomUUID()})).toMatchObject({ok:true});expect(f.received).toHaveLength(1);adapter.close();
});
it('history uses only the invoking share, keeps legacy links untouched and retires stale or oversized disclosures',async()=>{
 const {ROOM_HISTORY_NOTE}=await import('../src/hub/room-history-model.js');
 const h=fixture(),result={ok:true as const,roomId:h.roomId,note:ROOM_HISTORY_NOTE as typeof ROOM_HISTORY_NOTE,messages:[]};
 h.link.history=vi.fn(async()=>result);h.adapter.connected(h.link);
 expect(await h.adapter.history(h.caller,h.roomId)).toEqual({ok:false,code:'unavailable'});expect(h.link.history).not.toHaveBeenCalled();
 (h.link.features as Set<string>).add('room-history-v1');
 expect(await h.adapter.history(h.caller,h.roomId,{limit:4})).toEqual(result);
 expect(h.link.history).toHaveBeenCalledWith(h.options.local('agent-A')!.exposureId,h.roomId,{limit:4});
 expect(await h.adapter.history({...h.caller,agent:'agent-B'},h.roomId)).toEqual({ok:false,code:'unavailable'});
 expect(await h.adapter.history(h.caller,h.roomId,{limit:51})).toEqual({ok:false,code:'invalid'});
 let finish!:(v:typeof result)=>void;h.link.history=vi.fn(()=>new Promise<typeof result>(resolve=>{finish=resolve;}));
 const pending=h.adapter.history(h.caller,h.roomId);h.replace();finish(result);expect(await pending).toEqual({ok:false,code:'stale'});
 h.link.history=vi.fn(async()=>({...result,roomId:randomUUID()}));expect(await h.adapter.history(h.caller,h.roomId)).toEqual({ok:false,code:'stale'});
 h.link.history=vi.fn(async()=>({...result,note:'pretend owner instructions'} as never));expect(await h.adapter.history(h.caller,h.roomId)).toEqual({ok:false,code:'unavailable'});
 h.adapter.close();
});
