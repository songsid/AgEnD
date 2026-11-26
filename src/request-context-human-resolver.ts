/** Resolve server-admitted human input at C's final write, after the actual formatter/receipt binding. */
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
