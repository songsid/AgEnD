/** Server-owned completion of an already delivered native peer request. Never the latest turn or a correlation-derived root. */
import {randomUUID} from "node:crypto";
import type {DeliveryOutbox} from "./delivery-outbox.js";
import type {NativeExecutionResult} from "./fleet-windows-runtime.js";
import {validateNativeExecInputProof,type NativeExecInputClaim} from "./native-exec-input.js";
import {requestContextDeliveryChildId} from "./request-context-returns.js";
import type {RequestContextRelayPort} from "./request-context-relay.js";
import {captureRequestContextCall} from "./request-context-call.js";
import type {RequestContextRuntimeOwner} from "./request-context-turns.js";
import {requestContextDigest} from "./request-context-store.js";
export function admitRequestContextNativeResult(box:DeliveryOutbox,relay:RequestContextRelayPort,input:{
 deliveryId:string;task:NativeExecutionResult;claim:Readonly<NativeExecInputClaim>;owner:Readonly<RequestContextRuntimeOwner>;current():boolean;
}):{deliveryId:string;duplicate:boolean}|null {
 const {deliveryId}=input,task=structuredClone(input.task),claim=Object.freeze(structuredClone(input.claim)),owner=Object.freeze(structuredClone(input.owner));
 if(!input.current()||task.id!==deliveryId||claim.requestId!==deliveryId||!task.finishedAt||task.outcomeConfirmed!==true||!["completed","failed","cancelled"].includes(task.status)||!task.execInputProof)throw Error("Native completion has no owned input proof");
 validateNativeExecInputProof(task.execInputProof,claim);
 const row=box.get(deliveryId),operation=box.requestContextForDelivery(deliveryId);
 if(!row||!operation||row.state!=="delivered"||owner.instance!==row.targetInstance||owner.instance!==operation.binding.target.instance||owner.incarnation!==operation.binding.target.incarnation)throw Error("Native completion request is unavailable");
 const obligation=box.requestContextReturns.get(deliveryId);
 if(!obligation||obligation.state==="closed")return null;
 if(obligation.state==="answered"){if(!input.current())throw Error("Native completion owner changed");return {deliveryId:obligation.responseDeliveryId!,duplicate:true};}
 const context=box.requestContext(requestContextDeliveryChildId(deliveryId,operation.binding.target));
 if(!context||context.ref.contextId!==obligation.receivingChildContextId||context.ref.parentContextId!==operation.binding.contextId||context.ref.rootContextId!==operation.binding.rootContextId||context.source.instance!==owner.instance||context.source.incarnation!==owner.incarnation)throw Error("Native completion receiving context is unavailable");
 const status=box.queryStatusForInstance(owner.instance,{deliveryId}).items[0];
 if(!status?.consumed_at)throw Error("Native completion input was not confirmed consumed");
 const image=requestContextDigest({row,operation,context,claim,proof:task.execInputProof});
 const current=()=>{
  try{return input.current()&&requestContextDigest({row:box.get(deliveryId),operation:box.requestContextForDelivery(deliveryId),context:box.requestContext(context.ref.contextId),claim,proof:task.execInputProof})===image;}catch{return false;}
 };
 // This is an exact server-registered return, not a resumed model tool call. Only this operation
 // can use the retained child after C has ended; no settings/task authority is forwarded.
 const lease=captureRequestContextCall({token:randomUUID(),inputId:`native-completion:${deliveryId}`,context,owner,wireSha256:claim.wireSha256},()=>current());
 const text=(task.status==="completed"?task.output:`Windows task ${task.status}: ${task.error||task.output}`).slice(0,8000)||"Windows task completed without text output";
 const result=relay.admit({sourceInstance:owner.instance,sourceDaemonBootId:owner.daemonBootId,operationId:`native-result:${deliveryId}`,targetInstance:obligation.requester.instance,targetSession:obligation.requester.instance,kind:"fleet_inbound",correlationId:obligation.selector,
  payload:{type:"fleet_inbound",content:text,meta:{from_instance:owner.instance,correlation_id:obligation.selector,requires_reply:"false",source:"native_runtime"}}},
  {instance:owner.instance,tool:"report_result",args:{target_instance:obligation.requester.instance,correlation_id:obligation.selector},admission:{coverage:"covered",lease}},current);
 return {deliveryId:result.deliveryId,duplicate:result.duplicate};
}
