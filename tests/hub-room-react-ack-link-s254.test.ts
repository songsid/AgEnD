/** Owned pinned TLS/WSS + HTTP/SQLite; inert member input, no live Fleet/CLI/directory/model. */
import {afterEach,expect,it,vi} from "vitest";
import {randomBytes,randomUUID} from "node:crypto";
import Database from "better-sqlite3";
import {hubRig} from "./helpers/hub-rig.js";
import {hubListenerPorts} from "./helpers/hub-listener-ports.js";
import {s3bRig} from "./helpers/hub-s3b-rig.js";
import {HubRoomAskAdapter,migrateRoomAsks,type RoomAskLink} from "../src/hub/member/room-ask.js";
import {HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY,HUB_FLEET_UPDATE_CAPABILITY} from "../src/hub/protocol.js";
const memberCaps=[...HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY,HUB_FLEET_UPDATE_CAPABILITY];
const close:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const fn of close.splice(0).reverse())await fn();vi.restoreAllMocks();});
async function network(ack=true){
 const ports=hubListenerPorts();close.push(()=>ports.close());
 const net=await hubRig({memberPort:await ports.next(),serverCapabilities:[...memberCaps,...(ack?["room-react-ack-v1"]:[])]});close.push(()=>net.close());await net.pair();return net;
}
it("negotiated real exchange stores a visible reaction, answers the Hub delivery and durably stops the member obligation",async()=>{
 const net=await network(),web=await s3bRig({administrator:net.owner,realAudit:true});close.push(()=>web.close());
 web.httpDeps.transport=()=>net.server;web.httpDeps.store=net.store;web.httpDeps.pairing=net.pairing;await web.restartHttp();net.setReceive((frame,link)=>web.http.receive(frame,link));
 const db=new Database(":memory:");close.push(()=>{db.close();});migrateRoomAsks(db);
 const exposureId=randomUUID(),generation=randomUUID(),inputs:any[]=[],reminders:any[]=[],markers:any[]=[];let bridge:RoomAskLink;
 const adapter=new HubRoomAskAdapter({db,bindingKey:"s254-link",encryptionKey:randomBytes(32),current:()=>true,generation:()=>generation,
  localExposure:id=>id===exposureId?{agent:"Notes",consentId:"owned",revision:1,token:"owned"}:null,
  deliver:async x=>{if(!await x.beforeInput())return false;inputs.push(x);return true;},remind:async x=>{reminders.push(x);return true;}});close.push(()=>adapter.close());
 const member=net.client(async frame=>{if(frame.type==="room.ask")adapter.accept(frame.payload,bridge);},undefined,memberCaps);await member.value.start();const link=member.state.link!;
 expect(link.features.has("room-react-ack-v1")).toBe(true);
 bridge={current:()=>link.current(),features:link.features,sendAnswer:async x=>{markers.push(x);await link.send({v:1,type:"room.answer",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload:x});},
  sendReact:async payload=>{const result=await link.exchange({v:1,type:"room.react",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload},"room.react-result");if(result.type!=="room.react-result")throw Error("wrong result");return result.payload;}};adapter.connected(bridge);
 await link.send({v:1,type:"exposure.snapshot",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload:{revision:1,exposures:[{id:exposureId,fleetId:link.profile.fleetId,owner:net.owner,displayName:"Notes",revision:1,state:"published",dataViewId:"notes",allowedTools:[],policyDigest:"a".repeat(64)}]}});
 await vi.waitFor(()=>expect(web.db.prepare("SELECT id FROM hub_exposures").get()).toEqual({id:exposureId}));
 const admin=await web.signIn("admin"),room=(await web.call(admin,"POST","/hub/v1/rooms",{name:"Weekly",agents:[exposureId]})).json.room.id;
 const post=await web.call(admin,"POST",`/hub/v1/rooms/${room}/messages`,{text:"Thanks, received.",mentions:[exposureId],idempotencyKey:randomUUID()});expect(post.status).toBe(200);
 await vi.waitFor(()=>expect(inputs).toHaveLength(1));await adapter.settled();adapter.inputHandoff(inputs[0].correlationId,"Notes",generation);
 const result=await adapter.react({caller:"Notes",correlationId:inputs[0].correlationId,emoji:"👍"});expect(result).toMatchObject({ok:true});expect(adapter.questionSettled(inputs[0].correlationId,"Notes")).toBe(true);
 await adapter.turnEnded("Notes",generation,"one");await adapter.turnEnded("Notes",generation,"two");expect(reminders).toEqual([]);expect(markers).toEqual([]);
 const messages=(await web.call(admin,"GET",`/hub/v1/rooms/${room}/messages`)).json.messages,question=messages.find((m:any)=>m.id===post.json.id);
 expect(question.ask).toEqual({total:1,answered:1,working:0,later:0});expect(question.reactions).toMatchObject([{emoji:"👍",count:1,members:[exposureId]}]);
 expect(messages.find((m:any)=>m.answerTo===question.id)).toMatchObject({stage:"working"});
 expect(db.prepare("SELECT COUNT(*) n FROM hub_room_reaction_acks").get()).toEqual({n:1});
});
it("older peer does not negotiate acknowledgement and a forged acknowledgement result cannot resolve its pending exchange",async()=>{
 const net=await network(false);
 const member=net.client(undefined,undefined,memberCaps);await member.value.start();const link=member.state.link!;expect(link.features.has("room-react-ack-v1")).toBe(false);
 net.setReceive(async(frame)=>frame.type==="room.react"?{v:1,type:"room.react-result",requestId:frame.requestId,linkEpoch:frame.linkEpoch,payload:{messageId:frame.payload.messageId,ok:true,acknowledged:true}}:undefined);
 const payload={messageId:randomUUID(),roomId:randomUUID(),exposureId:randomUUID(),emoji:"👍"};
 await expect(link.send({v:1,type:"room.react",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload:{...payload,acknowledge:true}})).rejects.toMatchObject({code:"incompatible"});
 await expect(link.exchange({v:1,type:"room.react",requestId:randomUUID(),linkEpoch:link.linkEpoch,payload},"room.react-result")).rejects.toBeTruthy();
});
