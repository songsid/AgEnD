/** Resolve only the physical outbox attempt currently owned by this target, at the final write. */
import type {DeliveryOutbox,OutboxDelivery} from "./delivery-outbox.js";
import type {RequestContextRuntimeOwner,PreparedRequestContextInput} from "./request-context-turns.js";
import {requestContextDigest} from "./request-context-store.js";
export interface RequestDeliveryResolverPorts {
 readonly instance:string;readonly managerBootId:string;
 current():boolean;
 runtimeOwner():Readonly<RequestContextRuntimeOwner>|null;
 consumptionCurrent(delivery:OutboxDelivery):boolean;
}
export function makeRequestDeliveryInputResolver(box:DeliveryOutbox,ports:RequestDeliveryResolverPorts){
 return {prepare(inputId:string,wireSha256:string,owner:Readonly<RequestContextRuntimeOwner>):PreparedRequestContextInput|null{
  if(!inputId.startsWith("delivery:"))return null;
  const match=/^delivery:([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}):([1-9][0-9]*)$/.exec(inputId);
  if(!match||!/^[a-f0-9]{64}$/.test(wireSha256))throw Error("Request delivery input is unavailable");
  const attempt=Number(match[2]),id=match[1]!;let expected:string|null=null;
  const current=()=>{
   if(!ports.current()||owner.instance!==ports.instance||requestContextDigest(ports.runtimeOwner())!==requestContextDigest(owner))return false;
   const delivery=box.get(id);
   if(!delivery||delivery.kind!=="fleet_inbound"||delivery.targetInstance!==ports.instance||delivery.managerBootId!==ports.managerBootId
    ||delivery.targetDaemonBootId!==owner.daemonBootId||delivery.attemptNo!==attempt||!["delivering","submission_started"].includes(delivery.state)
    ||!Number.isSafeInteger(attempt)||!ports.consumptionCurrent(delivery))return false;
   const image=requestContextDigest(delivery);if(expected!==null&&image!==expected)return false;expected=image;
   return ports.current()&&requestContextDigest(ports.runtimeOwner())===requestContextDigest(owner);
  };
  if(!current())throw Error("Request delivery attempt is no longer current");
  return box.prepareRequestContextDeliveryInput(id,attempt,owner,wireSha256,current);
 }};
}
