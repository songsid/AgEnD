import {HUB_ROOM_BRIEF_CAPABILITY} from "../src/hub/room-brief-model.js";
/** Owned pinned TLS/WSS and HTTP/SQLite; inert agent delivery, no CLI/Fleet/AD. */
import Database from "better-sqlite3";
import { randomUUID,randomBytes } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import { hubListenerPorts } from "./helpers/hub-listener-ports.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HUB_CAPABILITIES,HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY,HUB_FLEET_UPDATE_CAPABILITY,encodeServerFrame } from "../src/hub/protocol.js";
import { HUB_FLEET_INFO_CAPABILITY } from "../src/hub/fleet-info.js";
import { HUB_RECOMMENDATION_CAPABILITY } from "../src/hub/recommendation-model.js";
import { HUB_ROOM_CONTEXT_CAPABILITY } from "../src/hub/room-context-model.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { HubRoomAskAdapter,migrateRoomAsks,migrateRoomContextReceipts,type RoomAskLink,type RoomAsk } from "../src/hub/member/room-ask.js";
import type { HubMemberLink } from "../src/hub/client.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";
const memberCaps=[...HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY];
const hubCaps=[...memberCaps,HUB_FLEET_INFO_CAPABILITY,HUB_RECOMMENDATION_CAPABILITY,HUB_ROOM_CONTEXT_CAPABILITY];
const close:(()=>Promise<void>)[]=[];
let ports: ReturnType<typeof hubListenerPorts> | null = null;
afterEach(async()=>{try{for(const f of close.splice(0).reverse())await f();}finally{vi.restoreAllMocks();ports=null;}});
async function network(serverCapabilities=hubCaps,optIn=true){
  if(!ports){const lease=ports=hubListenerPorts();close.push(()=>lease.close());}
  const net=await hubRig({memberPort:await ports.next(),serverCapabilities,clientRoomContext:optIn});close.push(()=>net.close());await net.pair();return net;
}
it("keeps legacy hello16 and modern17 without a context name, and admits the bounded welcome offer only with local opt-in",async()=>{
  expect([...HUB_CAPABILITIES,...memberCaps]).toHaveLength(16);expect(hubCaps).toHaveLength(16);
  const net=await network([...hubCaps,HUB_FLEET_UPDATE_CAPABILITY]);
  const received=vi.spyOn(net.server as any,"receive");
  const c=net.client(undefined,undefined,[...memberCaps,HUB_FLEET_UPDATE_CAPABILITY]);await c.value.start();
  const hello=received.mock.calls.find(args=>(args[0] as any).type==="hello")![0] as any;
  expect(hello.payload.capabilities).toHaveLength(17);expect(hello.payload.capabilities).not.toContain(HUB_ROOM_CONTEXT_CAPABILITY);
  expect(c.state.link!.features.has(HUB_ROOM_CONTEXT_CAPABILITY)).toBe(true);
  await expect(c.state.link!.send({v:1,type:"room.context-state",requestId:randomUUID(),linkEpoch:c.state.link!.linkEpoch,payload:{exposureId:randomUUID(),generation:randomUUID(),brief:true}})).rejects.toMatchObject({code:"incompatible"});
  expect(()=>encodeServerFrame({v:1,type:"welcome",requestId:randomUUID(),linkEpoch:1,payload:{selectedVersion:1,hubId:net.identity.hubId,fleetId:randomUUID(),linkEpoch:1,revocationVersion:0,capabilities:hubCaps}})).not.toThrow();
  const old=await network(hubCaps,false),legacy=old.client(undefined,undefined,memberCaps);await legacy.value.start();
  expect(legacy.state.link!.features.has(HUB_ROOM_CONTEXT_CAPABILITY)).toBe(false);
  await expect(legacy.state.link!.send({v:1,type:"room.context-state",requestId:randomUUID(),linkEpoch:legacy.state.link!.linkEpoch,payload:{exposureId:randomUUID(),generation:randomUUID()}})).rejects.toMatchObject({code:"incompatible"});
  expect(legacy.state.link!.current()).toBe(true);
});
it("a strict16-cap old Hub gets the existing one-time update-only hello fallback and no new context frames",async()=>{
  const net=await network(memberCaps),server=net.server as any,original=server.receive.bind(server),hellos:string[][]=[];
  vi.spyOn(server,"receive").mockImplementation(async(...args:any[])=>{const frame=args[0];if(frame.type==="hello"){hellos.push(frame.payload.capabilities);if(frame.payload.capabilities.length>16)throw new HubProtocolError("incompatible");}return original(...args);});
  const c=net.client(undefined,undefined,[...memberCaps,HUB_FLEET_UPDATE_CAPABILITY]);await c.value.start();
  expect(hellos.map(v=>v.length)).toEqual([17,16]);expect(hellos[1]).toEqual(hellos[0].filter(v=>v!==HUB_FLEET_UPDATE_CAPABILITY));
  expect(c.state.link!.features.has(HUB_ROOM_CONTEXT_CAPABILITY)).toBe(false);expect(net.received.some(f=>f.type==="room.context-state")).toBe(false);
});
it("confirms actual input across a lost ACK/reconnect, then sends a delta and a reset full window over the current link",async()=>{
  const net=await network([...hubCaps,HUB_FLEET_UPDATE_CAPABILITY,HUB_ROOM_BRIEF_CAPABILITY]),web=await s3bRig({administrator:net.owner,realAudit:true});close.push(()=>web.close());
  const db=new Database(":memory:");close.push(async()=>{db.close();});migrateRoomAsks(db);migrateRoomContextReceipts(db);
  web.httpDeps.transport=()=>net.server;web.httpDeps.store=net.store;web.httpDeps.pairing=net.pairing;await web.restartHttp();
  let generation=randomUUID(),drop=true;
  net.setReceive(async(frame,link)=>{const reply=await web.http.receive(frame,link);if(frame.type==="room.context-input"&&drop){drop=false;return;}return reply;});
  const profile=new (await import("../src/hub/profile.js")).HubMemberProfileStore(net.memberHome,net.identity.hubId).readProfile();
  const exposureId=randomUUID(),inputs:HubRepresentativeDelivery[]=[],asks:RoomAsk[]=[];
  const adapter=new HubRoomAskAdapter({db,bindingKey:`${profile.fleetId}/owned`,encryptionKey:randomBytes(32),current:()=>true,generation:()=>generation,
    localExposure:id=>id===exposureId?{agent:"Notes",consentId:exposureId,revision:1,token:"owned"}:null,
    deliver:async input=>{if(!input.stillCurrent()||!await input.beforeInput())return false;inputs.push(input);return true;}});close.push(async()=>{adapter.close();});
  const bridges=new WeakMap<HubMemberLink,RoomAskLink>();
  const bridge=(link:HubMemberLink)=>{let b=bridges.get(link);if(b)return b;b={current:()=>link.current(),features:link.features,
    sendAnswer:answer=>link.send({v:1,type:"room.answer",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload:answer}),
    contextState:async payload=>{const r=await link.exchange({v:1,type:"room.context-state",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload},"room.context-state-result");if(r.type!=="room.context-state-result")throw Error("type");return r.payload;},
    contextInput:async payload=>{const r=await link.exchange({v:1,type:"room.context-input",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload},"room.context-input-result");if(r.type!=="room.context-input-result")throw Error("type");return r.payload;}};bridges.set(link,b);return b;};
  const member=net.client(async(frame,link)=>{const b=bridge(link);adapter.connected(b);if(frame.type==="room.ask"){asks.push(frame.payload);adapter.accept(frame.payload,b);}},undefined,[...memberCaps,HUB_FLEET_UPDATE_CAPABILITY]);
  await member.value.start();adapter.connected(bridge(member.state.link!));
  const l=member.state.link!;await l.send({v:1,type:"exposure.snapshot",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{revision:1,exposures:[{id:exposureId,fleetId:profile.fleetId,owner:net.owner,displayName:"Notes",revision:1,state:"published",dataViewId:"notes",allowedTools:[],policyDigest:"a".repeat(64)}]}});
  await vi.waitFor(()=>expect(web.db.prepare("SELECT id FROM hub_exposures").get()).toEqual({id:exposureId}));
  expect(net.server.features(profile.fleetId)?.has(HUB_ROOM_BRIEF_CAPABILITY)).toBe(false);
  await adapter.refreshContexts([{agent:"Notes",exposureId}]);expect(net.server.features(profile.fleetId)?.has(HUB_ROOM_BRIEF_CAPABILITY)).toBe(true);const admin=await web.signIn("admin");
  const made=await web.call(admin,"POST","/hub/v1/rooms",{name:"Context RC",agents:[exposureId]});expect(made.status).toBe(200);const room=made.json.room.id;
  const post=async(text:string,mention=false)=>{const r=await web.call(admin,"POST",`/hub/v1/rooms/${room}/messages`,{text,mentions:mention?[exposureId]:[],idempotencyKey:randomUUID()});expect(r.status).toBe(200);return r.json;};
  await post("Earlier history");await post("First question",true);await vi.waitFor(()=>expect(inputs).toHaveLength(1));await adapter.settled();
  expect(asks[0].context.map(v=>v.text)).toEqual(["Earlier history"]);
  expect(asks[0].brief).toEqual({kind:"first",purpose:"",people:1,agents:1});
  expect(web.db.prepare("SELECT * FROM hub_room_brief_positions").all()).toEqual([]);
  expect(web.db.prepare("SELECT * FROM hub_room_context_positions").all()).toEqual([]); // IPC admitted, not yet input.
  adapter.inputHandoff(inputs[0].correlationId,"Notes",generation);
  await vi.waitFor(()=>expect(web.db.prepare("SELECT last_sequence FROM hub_room_context_positions").get()).toMatchObject({last_sequence:asks[0].contextState!.through}));
  expect(db.prepare("SELECT COUNT(*) n FROM hub_room_context_outbox").get()).toEqual({n:1});
  const syncs=member.state.syncs;net.server.refreshAuthorization();await vi.waitFor(()=>expect(member.state.syncs).toBeGreaterThan(syncs));
  await vi.waitFor(()=>expect(member.state.link!.current()).toBe(true));adapter.connected(bridge(member.state.link!));
  await adapter.refreshContexts([{agent:"Notes",exposureId}]);await adapter.flushContextInputs();
  await vi.waitFor(()=>expect(db.prepare("SELECT COUNT(*) n FROM hub_room_context_outbox").get()).toEqual({n:0}));expect(inputs).toHaveLength(1);
  await post("New history");await post("Second question",true);await vi.waitFor(()=>expect(inputs).toHaveLength(2));await adapter.settled();
  expect(asks.find(a=>a.text==="Second question")!.context.map(v=>v.text)).toEqual(["New history"]);
  expect(asks.find(a=>a.text==="Second question")!.brief).toBeUndefined();
  generation=randomUUID();await adapter.refreshContexts([{agent:"Notes",exposureId}]);await post("After reset",true);
  await vi.waitFor(()=>expect(inputs).toHaveLength(3));await adapter.settled();
  expect(asks.find(a=>a.text==="After reset")!.context.map(v=>v.text)).toContain("Earlier history");
  expect(inputs[2].roomContextGeneration).toBe(generation);
  expect(asks.find(a=>a.text==="After reset")!.brief?.kind).toBe("first");
});
