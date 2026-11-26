import {labelUnprovedRequest} from "./request-context-unproved-label.js";
/** Dormant H facade: one E/B admission path, never legacy origins or correlation releases. */
import type {DeliveryOutbox,NewOutboxDelivery} from "./delivery-outbox.js";
import type {RequestContactGateHost} from "./request-contact-gate.js";
import type {RequestContextOperation} from "./request-context-policy.js";
import {ContactHeldError} from "./contact-auth-service.js";
import {assertRequestContextOperation,RequestContextPolicyError} from "./request-context-policy.js";
import {labelOutsideRequest} from "./request-context-outside-label.js";
import {labelHubRequest} from "./request-hub-context.js";
import {requestContextDeliveryChildId} from "./request-context-returns.js";
import {requestContextDigest} from "./request-context-store.js";
import type {RequestContextV1} from "./request-context-protocol.js";
export type RequestRelayDelivery=Omit<NewOutboxDelivery,"sourceKey">;
export interface RequestContextRelayPort {
 admit(input:RequestRelayDelivery,operation:RequestContextOperation,current:()=>boolean):{deliveryId:string;state:string;duplicate:boolean;kind:string};
}
export interface RequestContextRelayHost extends RequestContactGateHost {
 incarnation(instance:string):string|null;
 accepted?(deliveryId:string,inserted:boolean):void;
}
/** Factory is explicit and requires activated H storage. Production installs none before L. */
export function makeRequestContextRelay(box:DeliveryOutbox,host:RequestContextRelayHost):RequestContextRelayPort {
 const gate=box.requestHubContactGate(host);
 return {admit(raw,operation,current){
  const input=structuredClone(raw),permit=assertRequestContextOperation(operation),source=host.incarnation(input.sourceInstance),target=host.incarnation(input.targetInstance);
  if(!current()||!source||!target||operation.instance!==input.sourceInstance||input.targetSession&&input.targetSession!==input.targetInstance)throw new RequestContextPolicyError("stale");
  if(!["send_to_instance","request_information","report_result"].includes(permit.tool)||!["ordinary","relay","needs-approval"].includes(permit.kind))throw new RequestContextPolicyError("invalid");
  let context=permit.context;
  if(context){if(context.source.instance!==input.sourceInstance||context.source.incarnation!==source||operation.admission?.coverage!=="covered"||input.sourceDaemonBootId!==operation.admission.lease.snapshot.owner.daemonBootId)throw new RequestContextPolicyError("stale");}
  else {
   const id=requestContextDeliveryChildId(requestContextDeliveryChildIdForOperation(input),{instance:input.sourceInstance,incarnation:source});
   context={ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:`unproved:${input.operationId}`,initiatingActor:{kind:"unknown",reason:"unproved-recovery"},ingress:"restricted-room",source:{instance:input.sourceInstance,incarnation:source},sourceAudience:{kind:"instance",ref:id}};
  }
  const payload=input.payload,meta=payload.meta;
  if(typeof payload.content!=="string"||!meta||typeof meta!=="object"||Array.isArray(meta)||Object.values(meta).some(v=>typeof v!=="string")||input.kind!=="fleet_inbound"||input.requestedKind==="steer"||payload.type!=="fleet_inbound")throw new RequestContextPolicyError("invalid");
  if(input.forwards?.length&&context.initiatingActor.kind==="unknown")throw new RequestContextPolicyError("forwards");
  const routing=meta as Record<string,string>;
  if(permit.kind==="needs-approval")routing.request_context_uncovered_reason=operation.admission?.coverage==="not-covered"?operation.admission.reason:"unbound-input";
  if(context.initiatingActor.kind==="unknown")payload.content=labelUnprovedRequest(context,payload.content,routing);
  else if(context.ingress==="hub")payload.content=labelHubRequest(context,payload.content,routing).content;
  else if(["guest","restricted-room","free-room"].includes(context.ingress))payload.content=labelOutsideRequest(context,payload.content,routing);
  const delivery:NewOutboxDelivery={...input,sourceKey:`request-contact:${input.sourceInstance}:${input.operationId}`},binding={version:1 as const,operationId:input.operationId,contextId:context.ref.contextId,rootContextId:context.ref.rootContextId,source:context.source,target:{instance:input.targetInstance,incarnation:target},verb:permit.tool,payloadSha256:requestContextDigest(payload)};
  if(!current()||operation.admission?.coverage==="covered"&&!operation.admission.lease.current())throw new RequestContextPolicyError("stale");
  let result:ReturnType<typeof gate.admit>;
  try{result=gate.admit(delivery,context,binding);}catch(error){
   if(error instanceof ContactHeldError&&routing.request_context_uncovered_reason==="interrupted-launch"&&error.result.authorization_state==="pending")throw new ContactHeldError({...error.result,message:new RequestContextPolicyError("interrupted").message});
   throw error;
  }
  host.accepted?.(result.delivery.deliveryId,result.inserted);
  return {deliveryId:result.delivery.deliveryId,state:result.delivery.state,duplicate:!result.inserted,kind:result.delivery.kind};
 }};
}
function requestContextDeliveryChildIdForOperation(input:RequestRelayDelivery):string {
 const h=requestContextDigest(["unproved-operation-v1",input.sourceInstance,input.operationId]).slice(0,32).split("");h[12]="8";h[16]=((parseInt(h[16]!,16)&3)|8).toString(16);const s=h.join("");return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
