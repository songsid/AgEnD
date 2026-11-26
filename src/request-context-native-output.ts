import {validateNativeExecInputProof} from "./native-exec-input.js";
/** One live/import projector. The admitted route selects the destination; existing chat visibility remains unchanged. */
import type {DeliveryOutbox} from "./delivery-outbox.js";
import type {FleetWindowsRuntime,NativeExecutionResult} from "./fleet-windows-runtime.js";
import type {RequestContextV1} from "./request-context-protocol.js";
import type {NativeHistoryMessage,WebChatHistory} from "./web-chat-history.js";
import {webChatReplyRef} from "./web-chat-history.js";
import {requestHumanReplyTarget} from "./request-context-human-resolver.js";
import {requestContextDeliveryChildId} from "./request-context-returns.js";
import {requestContextDisplayView} from "./request-context-view.js";
export function projectRequestContextNativeOutput(box:DeliveryOutbox,instance:string,task:NativeExecutionResult,
 completion:ReturnType<FleetWindowsRuntime["requestContextCompletion"]>,ports:{
  admitted(root:RequestContextV1):boolean;history:Pick<WebChatHistory,"findByReplyId">;
  session(handle:string):{owner?:{adapterId:string;userId:string}}|null|undefined;
 }):Pick<NativeHistoryMessage,"replyTo"|"requestProvenance">|null {
 if(task.id!==completion.claim.requestId||!task.finishedAt||task.outcomeConfirmed!==true||!task.execInputProof)return null;
 validateNativeExecInputProof(task.execInputProof,completion.claim);
 const ref=completion.reference;
 if(!completion.current()||ref.instance!==instance)return null;
 const context=box.requestContext(ref.contextId);
 if(!context||context.ref.rootContextId!==ref.rootContextId||context.source.instance!==instance||context.source.incarnation!==ref.incarnation)return null;
 const view=requestContextDisplayView(context),local={...(view?{requestProvenance:view}:{})};
 let peer=false;
 if(ref.inputId?.startsWith("delivery:")){
  const match=/^delivery:([a-f0-9-]{36}):([1-9][0-9]*)$/.exec(ref.inputId),op=match&&box.requestContextForDelivery(match[1]!);
  if(!match||task.id!==match[1]||!op||op.binding.rootContextId!==context.ref.rootContextId||requestContextDeliveryChildId(match[1]!,op.binding.target)!==context.ref.contextId)return null;
  const row=box.get(match[1]!);
  if(!row||row.state!=="delivered"||row.attemptNo!==Number(match[2])||!box.queryStatusForInstance(instance,{deliveryId:row.deliveryId}).items[0]?.consumed_at)return null;
  peer=true;
 }else {
  if(!ref.inputId?.startsWith("human:")||context.rootEvidenceRef!==ref.inputId)return null;
  const receipt=box.getHumanReceipt(ref.inputId.slice("human:hmsg-".length));
  if(!receipt||receipt.state!=="delivered"||receipt.proof_tag!=="owned-native-exec"||receipt.wire_sha256!==completion.claim.wireSha256)return null;
 }
 const target=requestHumanReplyTarget(box,{token:task.id,inputId:ref.inputId!,context,owner:completion.owner,wireSha256:completion.claim.wireSha256},completion.current,ports.admitted);
 if(!target)return peer?local:null; // Receiving peers have local history and their separately registered report_result.
 const original=target.messageId?ports.history.findByReplyId(instance,target.messageId):undefined;
 const session=target.webRoute?ports.session(target.webRoute.sessionHandle):undefined;
 if(target.webRoute&&!session&&!original)return null;
 if(!completion.current())return null;
 // Never mark channel:true: this projector did not post anything to a platform channel.
 return {...local,...(original?{replyTo:webChatReplyRef(original)}:{})};
}
