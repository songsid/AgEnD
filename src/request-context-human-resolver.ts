/** Resolve server-admitted human input at C's final write, after the actual formatter/receipt binding. */
import type { TurnReplyTarget } from "./turn-reply-guard.js";
import type { DeliveryOutbox } from "./delivery-outbox.js";
import { humanBodyHash } from "./human-delivery-receipts.js";
import type { RequestContextActorV1, RequestContextV1 } from "./request-context-protocol.js";
import { requestContextDigest } from "./request-context-store.js";
import type { PreparedRequestContextInput, RequestContextInputProof, RequestContextRuntimeOwner, RequestContextTurnSnapshot } from "./request-context-turns.js";
export interface RequestHumanResolverPorts {
 readonly instance:string;readonly managerBootId:string;
 current():boolean;
 runtimeOwner():Readonly<RequestContextRuntimeOwner>|null;
 humanOwner():string|null;
 active():RequestContextTurnSnapshot|null;
 canManage(actor:RequestContextActorV1):boolean;
 admitted(context:RequestContextV1):boolean;
}
function freeze<T>(value:T):T {
 if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
export function makeRequestHumanInputResolver(box:DeliveryOutbox,ports:RequestHumanResolverPorts){
 return {prepare(inputId:string,wireSha256:string,owner:Readonly<RequestContextRuntimeOwner>):PreparedRequestContextInput|null {
  if(!inputId.startsWith("human:"))return null;
  const match=/^human:hmsg-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(inputId);
  if(!match||!/^[a-f0-9]{64}$/.test(wireSha256))throw Error("Human request input is unavailable");
  const current=()=>{
   if(!ports.current()||owner.instance!==ports.instance||requestContextDigest(ports.runtimeOwner())!==requestContextDigest(owner))throw Error("Human request input owner changed");
  };
  current();
  const receipt=box.getHumanReceipt(match[1]!),captured=box.requestContextHumans.read(match[1]!);
  if(!receipt||!captured||receipt.message_id!==inputId.slice(6)||receipt.target_instance!==ports.instance||receipt.manager_boot_id!==ports.managerBootId
    ||receipt.state==="delivered"||receipt.owner_key===null||receipt.owner_key!==ports.humanOwner()
    ||receipt.wire_body===null||receipt.wire_sha256!==wireSha256||humanBodyHash(receipt.wire_body)!==wireSha256
    ||receipt.input_kind==="raw_paste"||receipt.original_body.startsWith("/raw ")
    ||captured.context.source.instance!==owner.instance||captured.context.source.incarnation!==owner.incarnation
    ||!ports.admitted(captured.context))throw Error("Human request input is unavailable");
  let context=captured.context,proof:RequestContextInputProof={kind:"independent"};
  // Only an explicit current administrator steer/side-question can join the active turn. Recognition is
  // not authority: its request inherits the active provenance, including Hub/guest scope and audience.
  if(["steer","btw"].includes(receipt.input_kind)&&context.ingress!=="guest"&&context.ingress!=="hub"
    &&context.initiatingActor.kind==="person"&&context.initiatingActor.platform!=="hub"){
   const active=ports.active();
   if(active&&requestContextDigest(active.owner)===requestContextDigest(owner)&&ports.canManage(context.initiatingActor)){
    proof={kind:"admin-steer",activeToken:active.token,actor:context.initiatingActor};context=active.context;
   }
  }
  current();
  if(receipt.owner_key!==ports.humanOwner()||!ports.admitted(captured.context))throw Error("Human request input owner changed");
  current();
  return freeze(structuredClone({inputId,wireSha256,owner,context,proof}));
 }};
}

/** Resolve only the original accepted human audience. A receiving peer or unproved recovery has no right to this sink. */
export function requestHumanReplyTarget(box:DeliveryOutbox,snapshot:RequestContextTurnSnapshot,
  current:()=>boolean,admitted:(root:RequestContextV1)=>boolean):Readonly<TurnReplyTarget>|null {
 if(!current())return null;
 const root=box.requestContext(snapshot.context.ref.rootContextId);
 if(!root||root.source.instance!==snapshot.owner.instance||root.source.incarnation!==snapshot.owner.incarnation)return null;
 const id=/^human:hmsg-([a-f0-9-]{36})$/.exec(root.rootEvidenceRef)?.[1];if(!id)return null;
 const captured=box.requestContextHumans.read(id),receipt=box.getHumanReceipt(id);
 if(!captured||!receipt||requestContextDigest(captured.context)!==requestContextDigest(root)||!admitted(root))return null;
 const route=captured.route;
 let target:TurnReplyTarget;
 if(route.kind==="web"){
  if(!route.sessionHandle)return null;
  target={chatId:route.chatId??"",...(route.adapterId?{adapterId:route.adapterId}:{}),...(route.threadId?{threadId:route.threadId}:{}),
   ...(route.messageId?{messageId:route.messageId}:{}),webRoute:Object.freeze({sessionHandle:route.sessionHandle})};
 }else if(route.kind==="room"&&route.adapterId&&route.chatId){
  const origin=JSON.parse(receipt.origin_json) as import("./human-delivery-receipts.js").HumanOrigin;
  target={adapterId:route.adapterId,chatId:route.chatId,...(route.threadId?{threadId:route.threadId}:{}),
   ...(origin.platform_message_id?{messageId:origin.platform_message_id}:origin.anchor_message_id?{messageId:origin.anchor_message_id}:{})};
 }else return null;
 return current()&&admitted(root)?Object.freeze(target):null;
}
