import {HUB_ROOM_MEMBERS_CAPABILITY} from "../src/hub/room-members-model.js";
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
it("H5 actual TLS negotiates the bounded members RPC while the legacy request/result remains strict",async()=>{
 const caps=[...hubCaps,HUB_FLEET_UPDATE_CAPABILITY,HUB_ROOM_MEMBERS_CAPABILITY],net=await network(caps),web=await s3bRig({administrator:net.owner,realAudit:true});close.push(()=>web.close());
 web.httpDeps.transport=()=>net.server;web.httpDeps.store=net.store;web.httpDeps.pairing=net.pairing;await web.restartHttp();net.setReceive((frame,link)=>web.http.receive(frame,link));
 const member=net.client(undefined,undefined,[...memberCaps,HUB_FLEET_UPDATE_CAPABILITY]);await member.value.start();const l=member.state.link!,exposureId=randomUUID();
 expect(l.features.has(HUB_ROOM_MEMBERS_CAPABILITY)).toBe(true);expect(net.server.features(l.profile.fleetId)?.has(HUB_ROOM_MEMBERS_CAPABILITY)).toBe(true);
 await l.send({v:1,type:"exposure.snapshot",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{revision:1,exposures:[{id:exposureId,fleetId:l.profile.fleetId,owner:net.owner,displayName:"Notes",revision:1,state:"published",dataViewId:"notes",allowedTools:[],policyDigest:"a".repeat(64)}]}});
 await vi.waitFor(()=>expect(web.db.prepare("SELECT id FROM hub_exposures").get()).toEqual({id:exposureId}));const admin=await web.signIn("admin");
 const made=await web.call(admin,"POST","/hub/v1/rooms",{name:"Lookup",purpose:"Release questions",agents:[exposureId]});expect(made.status).toBe(200);
 const query=await l.exchange({v:1,type:"room.members",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{exposureId,room:made.json.room.id,v2:true,query:"notes",limit:1}},"room.members-result");
 expect(query).toMatchObject({payload:{ok:true,v2:true,purpose:"Release questions",counts:{people:1,agents:1,matched:1,returned:1},members:[{name:"Notes",intro:""}]}});
 const legacy=await l.exchange({v:1,type:"room.members",requestId:randomUUID(),linkEpoch:l.linkEpoch,payload:{exposureId,room:made.json.room.id}},"room.members-result");expect(legacy.type).toBe("room.members-result");expect(Object.keys(legacy.payload)).toEqual(["ok","roomId","members"]);
 const old=await network(memberCaps),peer=old.client(undefined,undefined,memberCaps);await peer.value.start();expect(peer.state.link!.features.has(HUB_ROOM_MEMBERS_CAPABILITY)).toBe(false);
 await expect(peer.state.link!.send({v:1,type:"room.members",requestId:randomUUID(),linkEpoch:peer.state.link!.linkEpoch,payload:{exposureId,room:made.json.room.id,v2:true}})).rejects.toMatchObject({code:"incompatible"});
});
