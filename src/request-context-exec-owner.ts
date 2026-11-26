/** Native exec C owner. A run's grant and positive input belong to this exact owner, never a fabricated Daemon. */
import {createHash} from "node:crypto";
import type {DeliveryOutbox,OutboxDelivery} from "./delivery-outbox.js";
import type {RequestContextDaemonWork} from "./request-context-start.js";
import type {RequestContextRegistrationGate} from "./request-context-fence.js";
import type {RequestContextActorV1,RequestContextV1} from "./request-context-protocol.js";
import {requestContextDigest} from "./request-context-store.js";
import {makeRequestHumanInputResolver} from "./request-context-human-resolver.js";
import {makeRequestDeliveryInputResolver} from "./request-context-delivery-resolver.js";
import {RequestContextLocalTurns,RequestContextInputDeferred,type RequestContextRuntimeOwner,type RequestContextTurnSnapshot} from "./request-context-turns.js";
import {nativeExecInputBytes,nativeExecInputRequestDigest,validateNativeExecInputClaim,validateNativeExecInputProof,type NativeExecInputClaim,type NativeExecInputProof,type NativeExecInputOptions} from "./native-exec-input.js";
import type {NativeTaskInput} from "./windows-cli-worker.js";
export interface RequestContextExecOwnerPorts {
 readonly instance:string;readonly managerBootId:string;readonly work:RequestContextDaemonWork;readonly registration:RequestContextRegistrationGate;
 /** Exact process/work ownership, independent of browser lifetime and admission readiness. */
 current():boolean;incarnation():string;deliveryEpoch():number;
 admitted(context:RequestContextV1):boolean;canManage(actor:RequestContextActorV1):boolean;
 consumptionCurrent(delivery:OutboxDelivery):boolean;
}
export type RequestContextExecOwner = ReturnType<typeof createRequestContextExecOwner>;
export type RequestContextExecInput = ReturnType<RequestContextExecOwner["prepare"]>;
export function createRequestContextExecOwner(box:DeliveryOutbox,ports:RequestContextExecOwnerPorts){
 let alive=true;
 const owner=():Readonly<RequestContextRuntimeOwner>=>{
  if(!alive||!ports.current()||!ports.work.current())throw Error("Native request owner changed");
  const work=ports.work.identity(),deliveryEpoch=ports.deliveryEpoch();
  if(work.incarnation!==ports.incarnation()||!Number.isSafeInteger(deliveryEpoch)||deliveryEpoch<0)throw Error("Native request owner changed");
  return Object.freeze({instance:ports.instance,incarnation:work.incarnation,workGeneration:work.workGeneration,daemonBootId:ports.managerBootId,spawnGeneration:0,launchFenceEpoch:0,deliveryEpoch});
 };
 const owned=()=>{try{owner();return true;}catch{return false;}};
 type Human=ReturnType<DeliveryOutbox["prepareRequestContextNativeHumanInput"]>;
 const humans=new Map<string,{human:Human;resolver:ReturnType<typeof makeRequestHumanInputResolver>}>();
 const frames=new Map<string,{finish():void}>();
 const delivery=makeRequestDeliveryInputResolver(box,{instance:ports.instance,managerBootId:ports.managerBootId,current:owned,runtimeOwner:owner,consumptionCurrent:ports.consumptionCurrent});
 let turns:RequestContextLocalTurns;
 turns=new RequestContextLocalTurns({...box.requestContextRecovery.ports(ports.instance,(id,wire,actual)=>{
  if(!owned()||requestContextDigest(owner())!==requestContextDigest(actual))throw Error("Native request owner changed");
  if(id.startsWith("human:")){
   const captured=humans.get(id);if(!captured)throw Error("Native human input is not prepared");
   return captured.resolver.prepare(id,wire,actual);
  }
  return delivery.prepare(id,wire,actual);
 },ports.canManage),registration:ports.registration});
 return Object.freeze({owner,turns,current:owned,idle:()=>{try{return frames.size===0&&turns.current(owner())===null;}catch{return false;}},
  prepare:(inputId:string|null,task:NativeTaskInput,options:NativeExecInputOptions,value:Readonly<NativeExecInputClaim>)=>{
   const expectedOwner=owner(),claim=validateNativeExecInputClaim(value),wire=nativeExecInputBytes(task,options).toString("utf8");
   if(claim.requestId!==task.requestId||claim.requestSha256!==nativeExecInputRequestDigest(task,options)||claim.wireSha256!==requestContextDigestBytes(wire))throw Error("Native request input composition changed");
   if(frames.size||turns.current(expectedOwner))throw new RequestContextInputDeferred();
   let human:Human|undefined,peer:{id:string;attempt:number;operationImage:string}|undefined;
   if(inputId?.startsWith("human:")){
    const id=/^human:hmsg-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(inputId)?.[1];if(!id)throw Error("Native human input is unavailable");
    const accepted=box.requestContextHumans.read(id);if(!accepted||!ports.admitted(accepted.context))throw Error("Accepted native human input is unavailable");
    ports.registration.assertRegistration(accepted.context.ref.rootContextId);
    human=box.prepareRequestContextNativeHumanInput({receiptId:id,instance:ports.instance,managerBootId:ports.managerBootId,owner:expectedOwner,claim,wire,current:()=>owned()&&requestContextDigest(owner())===requestContextDigest(expectedOwner)});
    const prepared=human;
    humans.set(inputId,{human:prepared,resolver:makeRequestHumanInputResolver(box,{instance:ports.instance,managerBootId:ports.managerBootId,current:prepared.current,runtimeOwner:owner,humanOwner:()=>prepared.ownerKey,active:()=>turns.current(owner()),admitted:ports.admitted,canManage:ports.canManage})});
   }else if(inputId!==null){
    const match=/^delivery:([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}):([1-9][0-9]*)$/.exec(inputId);
    if(!match)throw Error("Native exec input kind is unsupported");
    const operation=box.requestContextForDelivery(match[1]!);if(!operation)throw Error("Native request operation is unavailable");ports.registration.assertRegistration(operation.binding.rootContextId);
    peer={id:match[1]!,attempt:Number(match[2]),operationImage:requestContextDigest(operation)};
   }
   let snapshot:RequestContextTurnSnapshot|null=null,finished=false,written=false,resolve!:(value:boolean)=>void;
   const ready=new Promise<boolean>(done=>resolve=done),key=inputId??`unmapped:${claim.requestId}`;
   const current=()=>{try{return !finished&&owned()&&requestContextDigest(owner())===requestContextDigest(expectedOwner)&&(!snapshot||turns.isCurrent(snapshot,expectedOwner));}catch{return false;}};
   const frame=Object.freeze({inputId,wireSha256:claim.wireSha256,claim,inputReady:()=>ready,current,
    bind:(value:RequestContextTurnSnapshot)=>{
     if(!current()||snapshot||requestContextDigest(value.owner)!==requestContextDigest(expectedOwner)||value.wireSha256!==claim.wireSha256||inputId!==null&&value.inputId!==inputId||!turns.isCurrent(value,expectedOwner))throw Error("Native request input binding changed");
     snapshot=value;
    },
    written:(value:Readonly<NativeExecInputProof>)=>{
     validateNativeExecInputProof(value,claim);if(!current()||!snapshot)throw Error("Native request input owner changed");if(written)return;
     if(human)human.written(value);
     if(peer){
      const row=box.get(peer.id),operation=box.requestContextForDelivery(peer.id);
      if(!row||!operation||requestContextDigest(operation)!==peer.operationImage||row.targetInstance!==ports.instance||row.managerBootId!==ports.managerBootId||row.targetDaemonBootId!==expectedOwner.daemonBootId||row.attemptNo!==peer.attempt||!["submission_started","delivered","uncertain"].includes(row.state))throw Error("Native request delivery attempt changed");
      if(row.state==="submission_started"&&!box.complete(peer.id,expectedOwner.daemonBootId,peer.attempt,"delivered","Owned native input write confirmed"))throw Error("Native request delivery attempt changed");
      if(box.markConsumed(peer.id,expectedOwner.daemonBootId,peer.attempt,"turn","Owned native input write confirmed")==="ignored")throw Error("Native request delivery attempt changed");
     }
     written=true;resolve(true);
    },
    finish:()=>{
     if(finished)return;finished=true;resolve(false);if(frames.get(key)===frame)frames.delete(key);
     if(inputId&&humans.get(inputId)?.human===human)humans.delete(inputId);human?.dispose();
    },
   });
   frames.set(key,frame);return frame;
  },
  dispose:()=>{alive=false;for(const frame of [...frames.values()])frame.finish();},
 });
}
// Actual bytes, rather than the structured-store JSON digest.
const requestContextDigestBytes=(value:string)=>createHash("sha256").update(value).digest("hex");
