import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
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
