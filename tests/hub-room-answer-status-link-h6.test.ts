import {HUB_ROOM_ANSWER_STATUS_CAPABILITY} from "../src/hub/room-answer-status-model.js";
import {HUB_ROOM_BRIEF_CAPABILITY} from "../src/hub/room-brief-model.js";
/** Owned pinned TLS/WSS and HTTP/SQLite; inert agent delivery, no CLI/Fleet/AD. */
import { randomUUID } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import { hubListenerPorts } from "./helpers/hub-listener-ports.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HUB_CAPABILITIES,HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY,HUB_FLEET_UPDATE_CAPABILITY } from "../src/hub/protocol.js";
import { HUB_FLEET_INFO_CAPABILITY } from "../src/hub/fleet-info.js";
import { HUB_RECOMMENDATION_CAPABILITY } from "../src/hub/recommendation-model.js";
import { HUB_ROOM_CONTEXT_CAPABILITY } from "../src/hub/room-context-model.js";
const memberCaps=[...HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY];
const hubCaps=[...memberCaps,HUB_FLEET_INFO_CAPABILITY,HUB_RECOMMENDATION_CAPABILITY,HUB_ROOM_CONTEXT_CAPABILITY];
const close:(()=>Promise<void>)[]=[];
let ports: ReturnType<typeof hubListenerPorts> | null = null;
afterEach(async()=>{try{for(const f of close.splice(0).reverse())await f();}finally{vi.restoreAllMocks();ports=null;}});
async function network(serverCapabilities=hubCaps,optIn=true){
  if(!ports){const lease=ports=hubListenerPorts();close.push(()=>lease.close());}
  const net=await hubRig({memberPort:await ports.next(),serverCapabilities,clientRoomContext:optIn});close.push(()=>net.close());await net.pair();return net;
}
it("H6 actual TLS gates the marker, acknowledges it without sealing the answer, and accepts a late real answer",async()=>{
 const net=await network([...hubCaps,HUB_FLEET_UPDATE_CAPABILITY,HUB_ROOM_ANSWER_STATUS_CAPABILITY]),web=await s3bRig({administrator:net.owner,realAudit:true});close.push(()=>web.close());
 web.httpDeps.transport=()=>net.server;web.httpDeps.store=net.store;web.httpDeps.pairing=net.pairing;await web.restartHttp();net.setReceive((frame,link)=>web.http.receive(frame,link));
 const asks:any[]=[],member=net.client(async frame=>{if(frame.type==="room.ask")asks.push(frame.payload);},undefined,[...memberCaps,HUB_FLEET_UPDATE_CAPABILITY]);await member.value.start();const l=member.state.link!,exposureId=randomUUID();
 expect(l.features.has(HUB_ROOM_ANSWER_STATUS_CAPABILITY)).toBe(true);
 await l.send({v:1,type:"exposure.snapshot",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{revision:1,exposures:[{id:exposureId,fleetId:l.profile.fleetId,owner:net.owner,displayName:"Notes",revision:1,state:"published",dataViewId:"notes",allowedTools:[],policyDigest:"a".repeat(64)}]}});
 await vi.waitFor(()=>expect(web.db.prepare("SELECT id FROM hub_exposures").get()).toEqual({id:exposureId}));const admin=await web.signIn("admin");const made=await web.call(admin,"POST","/hub/v1/rooms",{name:"Question",agents:[exposureId]}),roomId=made.json.room.id;expect(made.status).toBe(200);
 await web.call(admin,"POST",`/hub/v1/rooms/${roomId}/messages`,{text:"Question",mentions:[exposureId],idempotencyKey:randomUUID()});await vi.waitFor(()=>expect(asks).toHaveLength(1));
 const base={messageId:asks[0].messageId,roomId,exposureId};const mark=await l.exchange({v:1,type:"room.answer",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{...base,answerId:randomUUID(),text:"",notAnswered:"finished-without-answer"}},"room.answer-ack");expect(mark.type).toBe("room.answer-ack");
 expect((await web.call(admin,"GET",`/hub/v1/rooms/${roomId}/messages`)).json.messages.find((m:any)=>m.deliveryId===base.messageId||m.answerTo)?.stage).toBe("not-answered");
 await l.exchange({v:1,type:"room.answer",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{...base,answerId:randomUUID(),text:"Actual late answer"}},"room.answer-ack");expect((await web.call(admin,"GET",`/hub/v1/rooms/${roomId}/messages`)).json.messages.find((m:any)=>m.answerTo)?.text).toBe("Actual late answer");
 const old=await network(memberCaps),peer=old.client(undefined,undefined,memberCaps);await peer.value.start();expect(peer.state.link!.features.has(HUB_ROOM_ANSWER_STATUS_CAPABILITY)).toBe(false);
 await expect(peer.state.link!.send({v:1,type:"room.answer",requestId:randomUUID(),linkEpoch:peer.state.link!.linkEpoch,payload:{...base,answerId:randomUUID(),text:"",notAnswered:"finished-without-answer"}})).rejects.toMatchObject({code:"incompatible"});
});
