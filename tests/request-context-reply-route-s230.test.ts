import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {FleetManager} from "../src/fleet-manager.js";
import {ReplyDeduper} from "../src/reply-dedup.js";
import {assertRequestContextOperation} from "../src/request-context-policy.js";
import {captureRequestContextCall} from "../src/request-context-call.js";
import {Daemon} from "../src/daemon.js";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {webHumanOrigin,admittedHumanWebIngress,nativeHumanOrigin} from "../src/human-delivery-receipts.js";
import {requestHumanReplyTarget} from "../src/request-context-human-resolver.js";
import {TurnReplyGuard} from "../src/turn-reply-guard.js";
import type {RequestContextTurnSnapshot} from "../src/request-context-turns.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
function rig(web=true){
 const home=mkdtempSync(join(tmpdir(),"reply-route-s230-")),box=new DeliveryOutbox(join(home,"box.db"),"manager",{requestContextDispatchVersion:1});
 cleanup.push(()=>rmSync(home,{recursive:true,force:true}),()=>box.close());box.activateRequestContextBarrier();
 const handle="0123456789abcdef",origin=web?webHumanOrigin(false,undefined,undefined,true,handle):nativeHumanOrigin("telegram","fixture","person","Person",false,"message-one")!;
 const saved=box.createHumanReceiptWithRequestContext({targetInstance:"worker",originalBody:"question",origin,inputKind:"fleet_inbound",managerBootId:"manager"},
  {incarnation:"agent-v1",room:null,web:web?admittedHumanWebIngress(origin):null,route:web?{kind:"web",sessionHandle:handle}:{kind:"room",adapterId:"fixture",chatId:"chat-one",threadId:"thread-one"},platform:()=>"telegram"});
 const snapshot:RequestContextTurnSnapshot={token:randomUUID(),context:saved.context,inputId:`human:${saved.receipt.message_id}`,wireSha256:"a".repeat(64),owner:{instance:"worker",incarnation:"agent-v1",workGeneration:randomUUID(),daemonBootId:randomUUID(),spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0}};
 let current=true,admitted=true;
 const target=()=>requestHumanReplyTarget(box,snapshot,()=>current,()=>admitted);
 return {box,saved,snapshot,target,handle,current:(v:boolean)=>current=v,admitted:(v:boolean)=>admitted=v};
}
it("the unknown guest's admitted browser survives independently of identity and serialized body fields",()=>{
 const f=rig();expect(f.saved.context.initiatingActor.kind).toBe("unknown");expect(f.target()).toEqual({chatId:"",webRoute:{sessionHandle:f.handle}});
 expect(JSON.parse(f.saved.receipt.origin_json)).not.toHaveProperty("sessionHandle");expect(JSON.parse(f.saved.receipt.authority_json!).kind).toBe("none");
 f.current(false);expect(f.target()).toBeNull();f.current(true);f.admitted(false);expect(f.target()).toBeNull();
});
it("the native route is read from accepted evidence, including the original message anchor",()=>{
 const f=rig(false);expect(f.target()).toEqual({adapterId:"fixture",chatId:"chat-one",threadId:"thread-one",messageId:"message-one"});
});
it("a receiving peer and a replaced source incarnation cannot acquire the original human's sink",()=>{
 const f=rig();for(const owner of [{...f.snapshot.owner,instance:"peer"},{...f.snapshot.owner,incarnation:"replacement"}])
 expect(requestHumanReplyTarget(f.box,{...f.snapshot,owner},()=>true,()=>true)).toBeNull();
});
it("an unproved recovery's diagnostic old context never supplies a human return destination",()=>{
 const f=rig(),id=randomUUID(),context={...f.saved.context,ref:{version:1 as const,contextId:id,rootContextId:id},rootEvidenceRef:`unproved-recovery:${f.saved.context.ref.rootContextId}`};f.box.requestContextRecovery.retain(context);
 expect(requestHumanReplyTarget(f.box,{...f.snapshot,context},()=>true,()=>true)).toBeNull();
});
it("no pre-arm evidence authorises a route, and queue-time last-chat changes cannot redirect an armed guest",()=>{
 const f=rig(),guard=new TurnReplyGuard(),binding=f.snapshot.token;
 guard.beginToolAttempt(true);expect(guard.captureReplyRoute(binding)).toBeNull();
 const target=f.target()!;guard.arm({chatId:""},Date.now(),{binding,target});const lease=guard.captureReplyRoute(binding)!;
 let lastChat="second-guest";expect(lastChat).toBe("second-guest");expect(lease.target.webRoute?.sessionHandle).toBe(f.handle);expect(lease.current()).toBe(true);
 // A steering input shares the request token and adds an obligation; it cannot replace this request's audience.
 guard.arm({chatId:"admin-chat"},Date.now(),{binding,target:{chatId:lastChat,webRoute:{sessionHandle:"f".repeat(16)}}});
 expect(guard.captureReplyRoute(binding)!.target).toEqual(target);expect(lease.current()).toBe(true);
 guard.cancelByUser();expect(lease.current()).toBe(false);expect(guard.captureReplyRoute(binding)).toBeNull();
});
it("a stale generation, missing proof or new binding refuses rather than borrowing the newest route",()=>{
 const guard=new TurnReplyGuard(),first=randomUUID(),second=randomUUID(),target={chatId:"",webRoute:{sessionHandle:"0123456789abcdef"}};
 guard.arm(target,Date.now(),{binding:first,target});const lease=guard.captureReplyRoute(first)!;
 target.webRoute.sessionHandle="f".repeat(16);expect(lease.target.webRoute?.sessionHandle).toBe("0123456789abcdef");expect(Object.isFrozen(lease.target.webRoute)).toBe(true);
 guard.complete(lease.generation);guard.arm({chatId:"second"},Date.now(),{binding:second,target:{chatId:"second"}});
 expect(lease.current()).toBe(false);expect(guard.captureReplyRoute(first)).toBeNull();
 const next=guard.captureReplyRoute(second)!;guard.arm({chatId:"unproved"});expect(next.current()).toBe(false);expect(guard.captureReplyRoute(second)).toBeNull();
});

it("the actual positive-write arm uses the accepted route even for a mapped peer return, never lastChat or peer meta",()=>{
 const f=rig(),guard=new TurnReplyGuard();let epochCurrent=true;
 const daemon:any={isDeliveryEpochCurrent:()=>epochCurrent,deliveryEpoch:1,replyDraft:{reset:()=>{}},requestContextTurnSnapshot:()=>f.snapshot,
  requestContextLifecycle:{replyTarget:()=>f.target()},turnReplyGuard:guard,pendingWork:{lastInboundTimestamp:()=>Date.now()},publishWorkingState:()=>{},nativePaneLifecycle:{},
  logger:{debug:()=>{}},lastChatId:"newer-chat",lastThreadId:"newer-thread"};
 expect(guard.captureReplyRoute(f.snapshot.token)).toBeNull();
 (Daemon.prototype as any).markTurnStarted.call(daemon,{source:"peer",from_instance:"peer",chat_id:"forged-peer-chat"},"owned mapped return");
 expect(guard.captureReplyRoute(f.snapshot.token)!.target).toEqual(f.target());
 expect(guard.snapshot()!.target).toMatchObject({chatId:"",webRoute:{sessionHandle:f.handle}});
 epochCurrent=false;(Daemon.prototype as any).markTurnStarted.call(daemon,{source:"web",chat_id:"late"},"late paste");
 expect(guard.snapshot()!.target.chatId).toBe("");
});

function fleetSink(){
 const f=rig(),guard=new TurnReplyGuard(),target={adapterId:"fixture",chatId:"guest-a-room",threadId:"guest-a-thread",webRoute:{sessionHandle:f.handle}};
 guard.arm(target,Date.now(),{binding:f.snapshot.token,target});const replyRoute=guard.captureReplyRoute(f.snapshot.token)!;
 let live=true;const admission={coverage:"covered"as const,lease:captureRequestContextCall(f.snapshot,()=>live)};
 const sendText=vi.fn(async(chatId:string,_text:string,opts:any)=>({chatId,threadId:opts?.threadId,messageId:"sent-one"})),wrong=vi.fn();
 const adapter:any={id:"fixture",type:"telegram",sendText,react:vi.fn(async()=>{}),editMessage:vi.fn(async()=>{}),supportsReplyButtons:false};
 const frames:any[]=[],records:any[]=[],world={adapter};
 const manager:any=Object.assign(Object.create(FleetManager.prototype),{
  requestContextCallOf:()=>({id:"owned-call",admission,replyRoute,current:()=>live}),requestContextPolicy:{assert:assertRequestContextOperation},
  touchActivity:()=>{},setTopicIcon:()=>{},webChatIdentity:()=>({generation:1}),hubRoomReplyWarning:()=>undefined,
  instanceIpcClients:new Map([["worker",{send:(frame:any)=>{frames.push(frame);return true;}}]]),checkToolPermission:()=>({allowed:true}),
  classicHubPrivateBlocked:()=>false,worlds:new Map([["fixture",world]]),isWebOnlyFleet:()=>false,restrictedClassicRouting:()=>null,
  fleetConfig:{instances:{worker:{topic_id:"guest-b-thread"}}},getAdapterForInstance:()=>({sendText:wrong}),adapter:{sendText:wrong},getInstanceAdapterId:()=>"wrong",
  webChannelEchoTails:new Map(),replyStickerProblem:vi.fn(async()=>null),replyDeduper:new ReplyDeduper(),
  landedInOwnChannel:()=>true,afterReplyRouted:(...args:any[])=>{records.push(args);return Promise.resolve();},
  logger:{info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}},eventLog:null,
 });
 const send=async(tool="reply",extra:any={})=>{
  const count=frames.length;
  await (FleetManager.prototype as any).handleOutboundFromInstance.call(manager,"worker",{tool,args:{text:"Answer for A",message_id:"native-message",chat_id:"guest-b-room",thread_id:"guest-b-thread",...extra},adapterId:"wrong",senderSessionName:"guest-b-agent",fleetRequestId:`r${count}`});
  await vi.waitFor(()=>expect(frames.length).toBeGreaterThan(count));return frames.at(-1);
 };
 return {...f,guard,manager,target,send,sendText,wrong,adapter,records,world,live:(value:boolean)=>live=value};
}
it("the real Fleet sink answers guest A in A's captured room after B moved both last-chat and config",async()=>{
 const f=fleetSink(),result=await f.send();expect(result.error).toBeUndefined();expect(f.sendText).toHaveBeenCalledWith("guest-a-room","Answer for A",expect.objectContaining({threadId:"guest-a-thread"}));expect(f.wrong).not.toHaveBeenCalled();
 expect(f.records[0]?.[1]).toMatchObject({chat_id:"guest-a-room",thread_id:"guest-a-thread"});expect(f.records[0]?.[4]).toBe(true); // Existing channel/admin visibility is unchanged.
});
it.each(["react","edit_message"])("the real %s sink uses only the captured room",async tool=>{
 const f=fleetSink(),result=await f.send(tool,{emoji:"👍"});expect(result.error).toBeUndefined();const calls=tool==="react"?f.adapter.react.mock.calls:f.adapter.editMessage.mock.calls;
 expect(calls[0]?.[0]).toBe("guest-a-room");expect(calls[0]).toContain("guest-a-thread");expect(f.wrong).not.toHaveBeenCalled();
});
it.each(["cancel","call","world"])("a stale %s cannot commit a reply after asynchronous sticker preparation",async kind=>{
 const f=fleetSink();f.manager.replyStickerProblem=async()=>{if(kind==="cancel")f.guard.cancelByUser();if(kind==="call")f.live(false);if(kind==="world")f.manager.worlds.set("fixture",{adapter:{...f.adapter}});return null;};
 const result=await f.send();expect(result.error).toBeTruthy();expect(f.sendText).not.toHaveBeenCalled();expect(f.wrong).not.toHaveBeenCalled();expect(f.records).toEqual([]);
});
it("the policy never accepts a missing, stale or different-turn route, even for an unknown guest",()=>{
 const f=fleetSink(),admission=f.manager.requestContextCallOf({}).admission,route=f.manager.requestContextCallOf({}).replyRoute;
 for(const replyRoute of [undefined,{...route,binding:randomUUID()},{...route,current:()=>false}])
 expect(()=>assertRequestContextOperation({instance:"worker",tool:"reply",args:{chat_id:"forged"},admission,replyRoute})).toThrow();
});

it.each([true,false])("a scoped web reaction keeps existing visibility and mirrors only the captured room visible=%s",async visible=>{
 const f=fleetSink(),route=f.manager.requestContextCallOf({}).replyRoute,own=vi.fn(async()=>{}),other=vi.fn(async()=>{}),addReaction=vi.fn(()=>({added:true,message:{boot:"boot",id:1,reactions:[]}}));
 Object.assign(f.manager,{statusEmojiAvoidList:()=>[],webSessions:{findByHandle:()=>({tier:"guest",owner:{adapterId:"fixture",userId:"guest-a"}})},guestScope:()=>new Set(["worker"]),guestOwnRoom:()=>false,
  webChatHistory:{findByReplyId:()=>({instance:"worker",from:visible?"fixture:guest-a":"fixture:guest-b"}),addReaction},emitSseEvent:vi.fn(),
  webEchoCopies:new Map([["web-message",[{adapter:{type:"telegram",react:own},adapterId:"fixture",chatId:"guest-a-room",threadId:"guest-a-thread",messageId:"copy-a"},{adapter:{type:"telegram",react:other},adapterId:"fixture",chatId:"guest-b-room",threadId:"guest-b-thread",messageId:"copy-b"}]]])});
 const result=await f.manager.reactToWebMessage("worker","web-message","👍",route);
 expect(result.ok).toBe(visible);if(result.ok)expect(await result.mirrored).toBe(1);expect(addReaction).toHaveBeenCalledTimes(visible?1:0);expect(own).toHaveBeenCalledTimes(visible?1:0);expect(other).not.toHaveBeenCalled();
});
it("a web reply with no platform destination uses its original instance conversation without a fallback bot",async()=>{
 const f=fleetSink(),guard=new TurnReplyGuard(),target={chatId:"",webRoute:{sessionHandle:f.handle}};
 guard.arm(target,Date.now(),{binding:f.snapshot.token,target});const original=f.manager.requestContextCallOf({});f.manager.requestContextCallOf=()=>({...original,replyRoute:guard.captureReplyRoute(f.snapshot.token)});
 const result=await f.send();expect(result.error).toBeUndefined();expect(f.sendText).not.toHaveBeenCalled();expect(f.wrong).not.toHaveBeenCalled();expect(f.records[0]?.[1].chat_id).toBe("");expect(f.records[0]?.[4]).toBe(false);
});

it.each(["en","zh-TW"] as const)("a covered descendant without a delivered route names its missing destination, not an unknown person (%s)",locale=>{
 const f=rig(false),context={...f.snapshot.context,ref:{...f.snapshot.context.ref,contextId:randomUUID(),parentContextId:f.snapshot.context.ref.contextId},source:{instance:"peer",incarnation:"peer-inc"}},snapshot={...f.snapshot,context,owner:{...f.snapshot.owner,instance:"peer",incarnation:"peer-inc"}};
 const lease=captureRequestContextCall(snapshot,()=>true);
 expect(()=>assertRequestContextOperation({instance:"peer",tool:"reply",args:{text:"Fixture"},admission:{coverage:"covered",lease}},locale)).toThrow(expect.objectContaining({code:"request-context-destination",message:locale==="en"?"Not sent: reply through the agent that asked.":"未送出：請透過提出請求的 Agent 回覆。"}));
});
