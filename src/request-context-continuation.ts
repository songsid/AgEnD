/** Admission leases for already admitted deliveries. Correlations and model-supplied root ids grant nothing. */
import type {DeliveryOutbox,OutboxDelivery} from "./delivery-outbox.js";
import type {RequestContextPublication} from "./request-context-installation.js";
import type {RequestContextContinuation} from "./request-context-admission.js";
import {requestContextDigest} from "./request-context-store.js";

/** A queued candidate is inspected without claiming it. Re-claim/state changes need a fresh lease. */
export function requestDeliveryContinuation<T extends object>(box:DeliveryOutbox,publication:RequestContextPublication<T>,
  delivery:OutboxDelivery,current:()=>boolean):RequestContextContinuation|null {
  const operation=box.requestContextForDelivery(delivery.deliveryId);
  if(!operation)return null;
  const deliveryImage=requestContextDigest(delivery),operationImage=requestContextDigest(operation);
  const valid=()=>{
    try{
      if(!current()||!box.isOpen)return false;
      const row=box.get(delivery.deliveryId),binding=box.requestContextForDelivery(delivery.deliveryId);
      return !!row&&!!binding&&["queued","delivering","submission_started"].includes(row.state)
        &&requestContextDigest(row)===deliveryImage&&requestContextDigest(binding)===operationImage&&current();
    }catch{return false;}
  };
  if(!valid())throw Error("Request continuation delivery changed");
  return publication.continuation(operation.binding.rootContextId,valid);
}
