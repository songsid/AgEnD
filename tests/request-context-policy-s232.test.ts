import {randomUUID} from "node:crypto";
import {expect,it} from "vitest";
import {captureRequestContextCall,type RequestContextCallAdmission} from "../src/request-context-call.js";
import {assertRequestContextOperation,REQUEST_CONTEXT_POLICY_COPY,RequestContextPolicyError} from "../src/request-context-policy.js";
import {requestContextDigest} from "../src/request-context-store.js";
import type {RequestContextV1} from "../src/request-context-protocol.js";
function fixture(ingress:RequestContextV1["ingress"]="hub",audience:"hub"|"room"="hub"){
 const id=randomUUID(),room=randomUUID();let live=true;
 const context:RequestContextV1={ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"fixture",ingress,initiatingActor:ingress==="hub"?{kind:"person",platform:"hub",hubId:"demo-hub",id:"directory/demo-person"}:{kind:"person",platform:"discord",userId:"demo-person"},source:{instance:"demo-source",incarnation:"v1"},sourceAudience:{kind:audience,ref:room}};
 const lease=captureRequestContextCall({token:randomUUID(),inputId:"admitted",context,wireSha256:requestContextDigest("input"),owner:{instance:"demo-source",incarnation:"v1",workGeneration:"work",daemonBootId:"boot",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0}},()=>live);
 const admission:RequestContextCallAdmission={coverage:"covered",lease};
 return {context,room,admission,live:(value:boolean)=>{live=value;},call:(tool:string,args:Record<string,unknown>={})=>assertRequestContextOperation({instance:"demo-source",tool,args,admission})};
}
it.each(["send_to_instance","request_information","report_result"])("permits covered Hub %s without replacing its actor or root",tool=>{const f=fixture();expect(f.call(tool,{target_instance:"demo-target"})).toMatchObject({kind:"relay",tool,context:f.context});});
it.each(["create","update","move","done","attach","watch","unwatch","claim","release","upload","create_project","move_project"])("task %s refuses before any delayed work is made",action=>{const f=fixture();expect(()=>f.call("task",{action})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.tasks);});
it.each(["list","get","mine","projects"])("task %s remains a role-checked read",action=>{expect(fixture().call("task",{action}).kind).toBe("read");});
it.each(["create_schedule","update_schedule","delete_schedule","create_instance","deploy_template","create_team","post_decision","update_decision"])("%s cannot create a durable outside derivative",tool=>{expect(()=>fixture().call(tool)).toThrow(REQUEST_CONTEXT_POLICY_COPY.en[tool.endsWith("_schedule")?"schedules":["create_instance","deploy_template"].includes(tool)?"agents":tool==="create_team"?"teams":"decisions"]);});
it.each(["set_web_settings","update_instance_config","update_fleet_defaults","restart_instance","set_display_name","reply","edit_message","hub_set_intro","set_web_widget"])("Hub %s never gains owner authority from a contact release",tool=>{expect(()=>fixture().call(tool,{rootApproved:true,authority:"owner"})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.settings);});
it("broadcast has its own plain refusal rather than a partial send loop",()=>{expect(()=>fixture().call("broadcast")).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.broadcast);});
it.each([{forwards:["old-owner-receipt"]},{meta:{forwards:"old-owner-receipt"}},{receiptId:"owner-receipt"}])("forwards cannot be hidden in another message shape",args=>{expect(()=>fixture().call("send_to_instance",args)).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.forwards);});
it.each([{steer:true},{requestedKind:"steer"},{kind:"steer"},{type:"steer"}])("requested steering refuses even if a backend would downgrade",args=>{expect(()=>fixture().call("send_to_instance",args)).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.steer);});
it("raw task display kind and actual delegate tool both refuse",()=>{const f=fixture();expect(()=>f.call("send_to_instance",{request_kind:"task"})).toThrow();expect(()=>f.call("delegate_task",{request_kind:"message"})).toThrow();});
it("composites are expanded before policy, including old member tools",()=>{const f=fixture();expect(f.call("emoji_sticker",{action:"list_emojis"})).toMatchObject({kind:"read",tool:"list_emojis"});expect(()=>f.call("emoji_sticker",{action:"set_persona_emoji",args:{emoji:"x"}})).toThrow();expect(()=>f.call("web_appearance",{action:"set_web_widget",args:{name:"x"}})).toThrow();});
it("a stale call or different instance cannot substitute a later caller",()=>{const f=fixture();expect(()=>assertRequestContextOperation({instance:"other",tool:"get_fleet_status",args:{},admission:f.admission})).toThrow();f.live(false);expect(()=>f.call("send_to_instance")).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.stale);});
it("missing/unknown coverage asks once without borrowing a body label or owner",()=>{
 const permit=assertRequestContextOperation({instance:"demo-source",tool:"send_to_instance",args:{owner:"operator",requestContext:fixture().context}});expect(permit).toMatchObject({kind:"needs-approval"});expect(permit.context).toBeUndefined();
 expect(assertRequestContextOperation({instance:"demo-source",tool:"send_to_instance",args:{},admission:{coverage:"not-covered",reason:"interrupted-launch"}}).kind).toBe("needs-approval");
 expect(()=>assertRequestContextOperation({instance:"demo-source",tool:"report_result",args:{target_instance:"agend-hub"}})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.uncovered);
});
it("ordinary covered owner work keeps existing role/go-ahead policy",()=>{expect(fixture("owner").call("create_schedule").kind).toBe("ordinary");});
it.each(["restricted-room","free-room","guest"]as const)("%s cannot create an untracked durable derivative",ingress=>{expect(()=>fixture(ingress).call("task",{action:"create"})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.outside);});
it("Hub posting stays in its exact original audience and cannot carry a receipt",()=>{const f=fixture();expect(f.call("hub_room_post",{room:f.room}).kind).toBe("hub-post");expect(()=>f.call("hub_room_post",{room:"a-room-name"})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.audience);expect(()=>f.call("hub_room_post",{room:f.room,receipt_id:"owner"})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.forwards);});
it("all refusal codes have short EN/zh-TW copy and no operation is implied sent",()=>{for(const code of Object.keys(REQUEST_CONTEXT_POLICY_COPY.en)as Array<keyof typeof REQUEST_CONTEXT_POLICY_COPY.en>){const error=new RequestContextPolicyError(code,"zh-TW");expect(error.message).toBe(REQUEST_CONTEXT_POLICY_COPY["zh-TW"][code]);expect(error.code).toBe(`request-context-${code}`);expect(error.message.length).toBeLessThan(80);}});

it("an uncovered contact cannot forward an old owner receipt while asking for approval",()=>{
 expect(()=>assertRequestContextOperation({instance:"demo-source",tool:"send_to_instance",args:{instance_name:"other",forwards:["old-owner-receipt"]},admission:{coverage:"not-covered",reason:"interrupted-launch"}})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.forwards);
});

it.each(["get_fleet_config","get_web_settings","get_instance_logs","get_usage","get_cache_report"])("%s cannot disclose owner Fleet state through a Hub root",tool=>{
 expect(()=>fixture().call(tool)).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.fleet);expect(fixture("owner").call(tool).kind).toBe("ordinary");
});
it("other supported Hub reads keep their existing role-checked route",()=>{
 for(const tool of ["list_instances","get_fleet_status","hub_room_members","list_schedules"])expect(fixture().call(tool).kind).toBe("read");
});

it('room history under Hub ingress stays in the original group room; owner reads remain available',()=>{
 const room=fixture('hub','room');expect(room.call('hub_room_history',{room:room.room}).kind).toBe('read');
 expect(()=>room.call('hub_room_history',{room:randomUUID()})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.room);
 expect(()=>room.call('hub_room_history',{room:'same-room-name'})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.room);
 expect(()=>fixture('hub').call('hub_room_history',{room:room.room})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.room);
 expect(fixture('owner').call('hub_room_history',{room:randomUUID()}).kind).toBe('ordinary');
 expect(()=>assertRequestContextOperation({instance:'demo-source',tool:'hub_room_history',args:{room:room.room}})).toThrow(REQUEST_CONTEXT_POLICY_COPY.en.uncovered);
});
