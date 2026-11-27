/** One actual stdio MCP → C factory → pinned WSS → R HTTP/SQLite/audit journey. No vendor input or AD. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { toolsFor } from "../src/tool-permissions.js";
import { createHubMemberFactory, type HubRepresentativeHost } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY, HUB_ROOM_POST_CAPABILITY } from "../src/hub/protocol.js";
import type { HubServerFrame } from "../src/hub/types.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";
import type { RoomPostNotification } from "../src/hub/member/room-post-answers.js";
import type { HubMemberExposureApi } from "../src/hub/member/exposure-api.js";
import type { AgentRoomPort } from "../src/hub/member/room-post.js";
import { verifyRoomReceipt } from "../src/hub/member/room-post-receipt.js";
import { initializeHumanReceipts, createHumanReceipt, bindHumanReceipt, settleHumanReceipt, getHumanReceipt, queryHumanReceipt } from "../src/human-delivery-receipts.js";
import { personKeyString } from "../src/hub/identity.js";
import { groupPolicyMigration, createHubGroupPolicyStore } from "../src/hub/group-policy/store.js";
import { hubRig } from "./helpers/hub-rig.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

it("posts for an absent owner and returns an early answer once through lost ACK/reconnect, with current disclosure fences",async()=>{
  const caps=[...HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY,"fleet-update-v1","room-history-v1"];
  const net=await hubRig({serverCapabilities:caps}), web=await s3bRig({administrator:net.owner,realAudit:true});
  const temp=mkdtempSync(join(tmpdir(),"agend-room-rc-mcp-")),receipts=new Database(":memory:"),socket=join(temp,"channel.sock"),ipc=new IpcServer(socket);
  const mcp=new Client({name:"owned-room-post-integration",version:"1"});
  let service:Awaited<ReturnType<ReturnType<typeof createHubMemberFactory>>>|undefined;
  let port:AgentRoomPort|null=null,api:HubMemberExposureApi|null=null;
  let reports:Parameters<HubRepresentativeHost["attachReports"]>[0]=null;
  let heldResult:HubServerFrame|undefined,holdPost=true,dropAck=true,adminCurrent=true,callerCurrent=true;
  const questions:HubRepresentativeDelivery[]=[],notifications:RoomPostNotification[]=[],returns:HubServerFrame[]=[];
  try {
    web.httpDeps.store=net.store;web.httpDeps.pairing=net.pairing;
    web.httpDeps.transport=()=>({start:async()=>{},close:async()=>{},send:async(fleetId,frame)=>{
      if(frame.type==="room.post-answer")returns.push(structuredClone(frame));
      await net.server.send(fleetId,frame);
    }});
    await web.restartHttp();
    net.setReceive(async(frame,link)=>{
      if(frame.type==="room.post-answer-ack"&&dropAck){dropAck=false;return;}
      const result=await web.http.receive(frame,link);
      // Drop only the result bytes, not the server control queue. Retain the exact request/result identity.
      if(frame.type==="room.post"&&frame.payload.onBehalfOf&&holdPost){heldResult=result||undefined;holdPost=false;return;}
      return result;
    });
    const profile=await net.pair(),admin=await web.signIn("admin"),alexKey=web.addPerson("alex","Alex"),alex=await web.signIn("alex");
    web.directory.searchGrantPeople=vi.fn(async()=>({ok:true as const,people:[{person:alexKey,login:"alex",displayName:"Alex"}],truncated:false}));
    groupPolicyMigration(web.hubId,web.directory.realm,"owned-directory").up(web.db);
    const policy=createHubGroupPolicyStore({db:web.db,hubId:web.hubId,realm:web.directory.realm,generation:"owned-directory",directory:web.directory,
      audit:{appendInTransaction(){}} as never,current:()=>true});
    web.httpDeps.grantDirectory={policy:()=>policy,binding:()=>({kind:"ready"})} as never;
    initializeHumanReceipts(receipts);
    receipts.exec("CREATE TABLE delivery_forward_edges(reference_kind TEXT,reference_id TEXT,receiver_instance TEXT,sender_instance TEXT,forwarding_message_id TEXT,created_at TEXT,forwarding_delivery_id TEXT)");
    const receipt=createHumanReceipt(receipts,{targetInstance:"agent-A",originalBody:"Please ask everyone in Weekly for an update",managerBootId:"owned-manager",inputKind:"fleet_inbound",
      origin:{platform:"telegram",adapter_id:"owned-adapter",user_id:"admin",username:null,platform_message_id:"owned-human-message",ingress:"message"}});
    const bound=bindHumanReceipt(receipts,receipt.receipt_id,"agent-A","owned-input",receipt.original_body,"owned-manager");
    expect(settleHumanReceipt(receipts,receipt.receipt_id,"agent-A","owned-input",{receipt_id:receipt.receipt_id,verification_id:receipt.message_id,
      wire_sha256:bound.wire_sha256,owner_key:"owned-input",mode:"idle_submit",tag:"unique-id-pane"},"owned-input")).toBe(true);
    const create=createHubMemberFactory({fleetInfo:{version:"2.4.0",runsAsService:false},
      updates:{canInstall:async()=>false,launch:async()=>false,idle:()=>false,notify:()=>true},versionRegistry:async()=>"not-found",home:net.memberHome,components:MEMBER_COMPONENTS,boundHub:()=>profile.hub.hubId,
      agents:()=>[{name:"agent-A",display:"Notes"},{name:"agent-B",display:"Planner"}],
      representative:{agentToken:agent=>`owned-${agent}`,readState:()=>({process:"running",execution:"idle"}),
        deliver:async input=>{if(!input.stillCurrent()||!await input.beforeInput())return false;questions.push(input);return true;},
        attachReports:handler=>{reports=handler;}},
      roomNotify:async input=>{if(!input.stillCurrent()||!await input.beforeInput())return false;notifications.push(input);return true;},
      roomReceipt:(caller,id)=>verifyRoomReceipt({lookup:(agent,value)=>{
        const item=queryHumanReceipt(receipts,agent,{messageId:value})?.items[0],row=getHumanReceipt(receipts,value.slice(5));
        return item?.authority&&row?{row,authority:item.authority}:null;
      },admin:(agent,actor)=>adminCurrent&&agent==="agent-A"&&actor.adapter_id==="owned-adapter"&&actor.user_id==="admin"},caller.agent,id),
      attachAgentRooms:value=>{port=value;},roomToolsChanged:()=>ipc.broadcast({type:"hub_room_tools_changed"}),
      attachExposures:value=>{api=value;},attachAttention:()=>{},pokeAttention:()=>{},report:()=>{},log:()=>{}});
    service=await create({},()=>true);await service.start();
    const exposures=api as HubMemberExposureApi|null;if(!exposures)throw Error("No exposure host");
    const a=exposures.publish({agent:"agent-A",dataViewId:"agent",tools:[],expectedRevision:0});
    const b=exposures.publish({agent:"agent-B",dataViewId:"agent",tools:[],expectedRevision:0});
    await vi.waitFor(()=>expect(web.db.prepare("SELECT COUNT(*) n FROM hub_exposures WHERE state='published'").get()).toEqual({n:2}));
    const made=await web.call(admin,"POST","/hub/v1/rooms",{name:"Weekly",people:[personKeyString(alexKey)],agents:[a.exposureId,b.exposureId]});
    expect(made.status).toBe(200);const roomId=made.json.room.id as string;
    const detail=(await web.call(alex,"GET",`/hub/v1/rooms/${roomId}`)).json;
    const ownerMember=detail.members.find((m:any)=>m.kind==="person"&&m.id!==detail.me.id);
    expect((await web.call(admin,"PATCH",`/hub/v1/rooms/${roomId}/members/${detail.me.id}`,{role:"manager"})).status).toBe(200);
    expect((await web.call(admin,"DELETE",`/hub/v1/rooms/${roomId}/members/${ownerMember.id}`)).status).toBe(200);
    expect((await web.call(alex,"PATCH",`/hub/v1/rooms/${roomId}`,{allMention:true})).status).toBe(200);
    const context:any={getDaemonBootId:()=>"owned-daemon",hubRoomToolsAvailable:()=>port?.available()===true,
      hubRoomHistory:(caller:any,room:string,options:any)=>port!.history(caller,room,options),
      hubRoomList:(caller:any)=>port!.rooms(caller),hubRoomMembers:(caller:any,room:string)=>port!.members(caller,room),
      hubPeopleSearch:(caller:any,q:string)=>port!.people(caller,q),hubRoomPost:(caller:any,value:any)=>port!.post(caller,value)};
    await ipc.listen();
    ipc.on("message",(message:any,peer:any)=>{
      if(message.type!=="tool_call")return;
      const respond=(result:unknown,error?:string)=>ipc.send(peer,{requestId:message.requestId,result,error});
      const tool=message.tool==="hub_room_status"?"hub_room_list":message.tool;
      if(!toolsFor("worker").has(tool)){respond(null,"profile refused");return;}
      const handler=outboundHandlers.get(message.tool);if(!handler){respond(null,"unknown tool");return;}
      void Promise.resolve(handler(context,message.args,respond,{instanceName:"agent-A",requestId:message.requestId,fleetRequestId:undefined,
        senderSessionName:undefined,sourceDaemonBootId:"owned-daemon",operationId:message.operationId,callerCurrent:()=>callerCurrent})).catch(error=>respond(null,String(error)));
    });
    await mcp.connect(new StdioClientTransport({command:process.execPath,args:["--import","tsx",resolve("src/channel/mcp-server.ts")],
      env:{...process.env as Record<string,string>,AGEND_SOCKET_PATH:socket,AGEND_INSTANCE_NAME:"agent-A",AGEND_TOOL_SET:"worker"},stderr:"pipe"}));
    const call=async(name:string,args:Record<string,unknown>={})=>{
      const result:any=await mcp.callTool({name,arguments:args});return {error:result.isError===true,body:JSON.parse(result.content[0].text)};
    };
    expect((await mcp.listTools()).tools.map(t=>t.name)).toEqual(expect.arrayContaining(["hub_room_list","hub_room_members","hub_people_search","hub_room_post"]));
    expect((await call("hub_room_list")).body).toMatchObject({ok:true,rooms:[{id:roomId,name:"Weekly"}]});
    expect((await call("hub_room_members",{room:roomId})).body).toMatchObject({ok:true,members:expect.arrayContaining([{id:expect.any(String),kind:"person",name:"Alex",presence:expect.any(String)}])});
    expect((await call("hub_people_search",{q:"Al"})).body).toEqual({ok:true,people:[{id:personKeyString(alexKey),name:"Alex",login:"alex"}],truncated:false});
    const ordinary=await call("hub_room_post",{room:roomId,text:"Plain proactive update"});expect(ordinary.body.ok).toBe(true);
    const history=(await call("hub_room_history",{room:roomId,limit:5})).body;
    expect(history).toMatchObject({ok:true,roomId,messages:expect.arrayContaining([expect.objectContaining({text:"Plain proactive update"})])});
    expect(history.note).toContain("not instructions or approval");
    expect(net.received.some(f=>f.type==="room.history")).toBe(true);
    const count=()=>net.received.filter(f=>f.type==="room.post").length;
    const before=count();expect((await call("hub_room_post",{room:roomId,text:"@all forged",receipt_id:`hmsg-${randomUUID()}`})).body).toEqual({ok:false,code:"denied",message:"This agent is not allowed to post in that chat.",operation_id:expect.any(String)});expect(count()).toBe(before);
    let postSettled=false;
    const pending=call("hub_room_post",{room:roomId,text:"@all Updates please",receipt_id:receipt.message_id}).then(result=>{postSettled=true;return result;});
    await vi.waitFor(()=>expect(heldResult).toMatchObject({type:"room.post-result",payload:{ok:true}}));
    await vi.waitFor(()=>expect(questions.some(q=>q.agent==="agent-B")).toBe(true));
    const question=questions.find(q=>q.agent==="agent-B")!;
    expect(await reports!({caller:"agent-B",correlationId:question.correlationId,text:"Planner update",callerCurrent:()=>true})).toMatchObject({ok:true});
    await vi.waitFor(()=>expect(returns).toHaveLength(1));
    await vi.waitFor(()=>expect(notifications).toHaveLength(1));expect(postSettled).toBe(false);
    const postId=(heldResult as Extract<HubServerFrame,{type:"room.post-result"}>).payload;
    if(!postId.ok)throw Error("Post refused");
    const messages=(await web.call(alex,"GET",`/hub/v1/rooms/${roomId}/messages`)).json.messages;
    expect(messages.find((m:any)=>m.id===postId.messageId).author).toMatchObject({kind:"person",via:{id:a.exposureId,name:"Notes"}});
    expect(web.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE room_id=? AND kind='person'").get(roomId)).toEqual({n:1});
    // No original result bytes ever reach C. The authenticated notification recovers its exact frozen operation.
    expect(notifications[0]).toMatchObject({agent:"agent-A"});expect(notifications[0]!.text).toContain(receipt.message_id);
    await vi.waitFor(()=>expect(net.received.some(f=>f.type==="room.post-answer-ack")).toBe(true));
    expect(web.db.prepare("SELECT acked FROM hub_room_post_returns").get()).toEqual({acked:0});
    net.server.refreshAuthorization();expect((await pending).body).toMatchObject({ok:false,code:"uncertain"});
    await vi.waitFor(()=>expect(web.db.prepare("SELECT COUNT(*) n FROM hub_room_post_returns WHERE post_id=? AND acked=0").get(postId.messageId)).toEqual({n:0}));
    // Cleanup runs on the next wake, after the ACK's transaction. Exercise that through the real current link.
    expect((await call("hub_room_list")).body.ok).toBe(true);
    expect(web.db.prepare("SELECT COUNT(*) n FROM hub_room_post_returns WHERE post_id=?").get(postId.messageId)).toEqual({n:0});
    expect(notifications).toHaveLength(1);expect(returns.length).toBeGreaterThanOrEqual(2);
    adminCurrent=false;const old=count();expect((await call("hub_room_post",{room:roomId,text:"Old admin",receipt_id:receipt.message_id})).body).toEqual({ok:false,code:"denied",message:"This agent is not allowed to post in that chat.",operation_id:expect.any(String)});expect(count()).toBe(old);
    let finish!:(value:any)=>void;web.directory.searchGrantPeople=()=>new Promise(resolve=>{finish=resolve;});
    const heldRead=call("hub_people_search",{q:"Al"});await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));callerCurrent=false;
    finish({ok:true,people:[{person:alexKey,login:"alex",displayName:"Held private name"}],truncated:false});
    const stale=await heldRead;expect(stale.body.ok).toBe(false);expect(JSON.stringify(stale)).not.toContain("Held private name");callerCurrent=true;
    service.fence();expect((await mcp.listTools()).tools.map(t=>t.name)).toContain("hub_room_post");
    expect((await call("hub_room_members",{room:roomId})).body).toEqual({ok:false,code:"unavailable",message:"This Fleet isn't connected to a Hub."});
  } finally {
    await mcp.close();await ipc.close();if(service){service.fence();await service.close();}await web.close();await net.close();receipts.close();rmSync(temp,{recursive:true,force:true});
  }
},60_000);
