/** Native restart reconciliation never opens coordinator paths or retires tmux windows. */
import type {DeliveryOutbox} from "./delivery-outbox.js";
import type {NativePaneLifecycle} from "./native-pane-lifecycle.js";
export async function reconcileNativePaneTarget(
 outbox:Pick<DeliveryOutbox,"getReconciliationCandidates"|"reconcileAttempt">,
 name:string,native:NativePaneLifecycle,current:()=>boolean,
):Promise<boolean>{
 for(const candidate of outbox.getReconciliationCandidates(name)){
  if(!current())return false;
  const reference=candidate.attempt.runtimeTranscript;
  let matched=false,proof="native-transcript-unconfirmed; old delivery will not be replayed";
  if(reference&&!candidate.attempt.runtimeTranscriptInvalid&&native.current(reference)){
   const needle=candidate.kind==="raw_paste"&&typeof candidate.payload.content==="string"?{rawText:candidate.payload.content}:candidate.deliveryId;
   let reader:ReturnType<NativePaneLifecycle["proofReader"]>|undefined;
   try{
    reader=native.proofReader(reference,needle);
    for(let n=0;n<8;n++){
     const before=reader.readPosition,look=await reader.look();
     if(!current())return false;
     if(!native.current(reference))break;
     if(look==="user"||look==="absorbed"||look==="queued"){matched=true;proof=`native-transcript-marker-${look}`;break;}
     if(look==="unavailable"||look==="pending"||reader.readPosition===before)break;
    }
   }catch{/* No negative native proof ever authorizes replay. */}
   finally{reader?.close();}
  }
  if(!current())return false;
  // The runner may still be working on the same pane. Never manufacture exit or absence proof to retry the input.
  if(!outbox.reconcileAttempt(candidate.deliveryId,candidate.attempt.targetDaemonBootId,candidate.attempt.attemptNo,matched?"delivered":"uncertain",proof))return false;
 }
 return current();
}
