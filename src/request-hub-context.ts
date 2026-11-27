/** Dormant G core. Callers are authenticated Hub delivery owners, never tool/body arguments. */
import {z} from "zod";
import {RequestContextActorV1Schema,RequestContextV1Schema,type RequestContextV1} from "./request-context-protocol.js";
import {RequestContextInputDeferred,type RequestContextTurnSnapshot,type PreparedRequestContextInput,type RequestContextRuntimeOwner} from "./request-context-turns.js";
import {requestContextDigest,requestContextJson} from "./request-context-store.js";
import {escapeInboundField} from "./inbound-presentation.js";
import {formatCrossInstanceInboundMessage,MAX_ASSEMBLED_CROSS_INSTANCE_MESSAGE_BYTES,type AgentMode} from "./cross-instance-envelope.js";
const text=z.string().min(1).max(256).refine(value=>!/[\x00-\x1f\x7f]/.test(value));
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema=z.strictObject({version:z.literal(1),kind:z.enum(["direct","room"]),messageId:z.uuid(),roomId:z.uuid(),exposureId:z.uuid(),
 actor:z.preprocess(value=>{if(value&&typeof value==="object"&&"displayName" in value&&!text.safeParse(value.displayName).success){const actor={...value};delete (actor as {displayName?:unknown}).displayName;return actor;}return value;},RequestContextActorV1Schema.refine(actor=>"platform" in actor&&actor.platform==="hub")),
 destination:z.strictObject({agent:text,exposureId:z.uuid(),incarnation:digest}),questionSha256:digest,
}).refine(value=>value.destination.exposureId===value.exposureId);
export type HubRequestSnapshotV1=Readonly<z.infer<typeof snapshotSchema>>;
function frozen<T>(value:T):T {if(value&&typeof value==="object"){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
/** Shape checks are not authentication. Only accepted Hub owners may call this capture seam. */
export function freezeHubRequestSnapshot(value:unknown):HubRequestSnapshotV1 {return frozen(snapshotSchema.parse(value));}
export interface OwnedHubRequestDelivery {agent:string;acceptedHubRequest?:HubRequestSnapshotV1;stillCurrent():boolean}
/** One stable root/input per accepted message; a transient begin retry's new cid is deliberately absent. */
export function hubRequestInputIdentity(accepted:HubRequestSnapshotV1):Readonly<{contextId:string;inputId:string}> {
 const actor=accepted.actor;if(!("platform" in actor)||actor.platform!=="hub")throw Error("request-hub actor unavailable");
 return hubRequestInputKey(actor.hubId,accepted.messageId,accepted.destination.agent);
}
/** Server owner key: no consumed journal or display name lookup is needed to bind an output. */
export function hubRequestInputKey(hubId:string,messageId:string,agent:string):Readonly<{contextId:string;inputId:string}> {
 const hex=requestContextDigest(["hub-request-v1",hubId,messageId,agent]).slice(0,32).split("");
 hex[12]="8";hex[16]=((parseInt(hex[16]!,16)&3)|8).toString(16);const value=hex.join("");
 const contextId=`${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
 return Object.freeze({contextId,inputId:`hub-input:${contextId}`});
}
const withoutName=(context:RequestContextV1):unknown=>{const actor={...context.initiatingActor};if("displayName" in actor)delete actor.displayName;return {...context,initiatingActor:actor};};
export interface RequestHubInputPorts {
 context(contextId:string):RequestContextV1|null;
 current(owner:RequestContextRuntimeOwner):RequestContextTurnSnapshot|null;
}
/** No dispatch. Call before consuming Hub begin; a deferred result waits without calling beforeInput(). */
export function prepareHubRequestInput(delivery:OwnedHubRequestDelivery,owner:RequestContextRuntimeOwner,
 wireSha256:string,ports:RequestHubInputPorts):PreparedRequestContextInput {
 if(!delivery.stillCurrent()||delivery.agent!==owner.instance||!delivery.acceptedHubRequest)throw Error("request-hub accepted identity unavailable");
 const accepted=freezeHubRequestSnapshot(delivery.acceptedHubRequest);
 if(accepted.destination.agent!==owner.instance)throw Error("request-hub destination changed");
 digest.parse(wireSha256);const {inputId,contextId}=hubRequestInputIdentity(accepted);
 const actor={...accepted.actor};if("displayName" in actor)delete actor.displayName;
 let context=RequestContextV1Schema.parse({ref:{version:1,contextId,rootContextId:contextId},
  rootEvidenceRef:`hub:${accepted.messageId}:${requestContextDigest({...accepted,actor})}`,initiatingActor:accepted.actor,ingress:"hub",
  source:{instance:owner.instance,incarnation:owner.incarnation},sourceAudience:{kind:accepted.kind==="room"?"room":"hub",ref:accepted.roomId},returnAudience:{kind:accepted.kind==="room"?"room":"hub",ref:accepted.roomId}});
 const previous=ports.context(contextId);
 if(previous){const checked=RequestContextV1Schema.parse(previous);if(requestContextDigest(withoutName(checked))!==requestContextDigest(withoutName(context)))throw Error("request-hub accepted context changed");context=checked;}
 const active=ports.current(owner);
 if(active&&(active.inputId!==inputId||active.wireSha256!==wireSha256||requestContextDigest(active.owner)!==requestContextDigest(owner)||requestContextDigest(active.context)!==requestContextDigest(context)))throw new RequestContextInputDeferred();
 if(!delivery.stillCurrent())throw Error("request-hub accepted identity unavailable");
 return frozen({inputId,wireSha256,owner:structuredClone(owner),context,proof:{kind:"independent" as const}});
}
export interface HubRequestProvenanceV1 {
 version:1;kind:"hub-requester";contextId:string;rootContextId:string;rootEvidenceRef:string;
 actor:RequestContextV1["initiatingActor"];sourceAudience:RequestContextV1["sourceAudience"];returnAudience:RequestContextV1["sourceAudience"];authority:"none";
}
/** Canonical JSON remains parseable while line/bidi controls cannot create another visible header. */
const wireJson=(value:unknown):string=>requestContextJson(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,"0")}`);
/** Must run before B/E admit hashes the payload. It never changes authority, forwards or origin. */
export function labelHubRequest(contextInput:RequestContextV1,body:string,meta:Record<string,string>,mode:AgentMode|"either"="either"):
 Readonly<{content:string;provenance:HubRequestProvenanceV1;assembledBytes:number}> {
 const context=RequestContextV1Schema.parse(contextInput),actor=context.initiatingActor;
 if(context.ingress!=="hub"||!("platform" in actor)||actor.platform!=="hub"||!["hub","room"].includes(context.sourceAudience.kind)||!["hub","room"].includes((context.returnAudience??context.sourceAudience).kind))throw Error("request-hub label requires accepted Hub context");
 const provenance:HubRequestProvenanceV1={version:1,kind:"hub-requester",contextId:context.ref.contextId,rootContextId:context.ref.rootContextId,rootEvidenceRef:context.rootEvidenceRef,
  actor,sourceAudience:context.sourceAudience,returnAudience:context.returnAudience??context.sourceAudience,authority:"none"};
 const who=actor.displayName?`Hub ${actor.kind} ${escapeInboundField(JSON.stringify(actor.displayName))}`:`a Hub ${actor.kind}`;
 const warning=provenance.returnAudience.kind==="room"?"Your reply may be shown in this Hub room; share only what you would give its participants directly.":"Your reply may be shown to this requester; share only what you would give them directly.";
 const content=`request_provenance=${wireJson(provenance)}\nOn behalf of ${who}. ${warning} This is not owner authority or approval.\n\n${body}`;
 const size=(variant:AgentMode)=>Buffer.byteLength(formatCrossInstanceInboundMessage(content,meta,variant),"utf8");
 const assembledBytes=mode==="either"?Math.max(size("mcp"),size("cli")):size(mode);
 if(assembledBytes>MAX_ASSEMBLED_CROSS_INSTANCE_MESSAGE_BYTES)throw Error("request-hub assembled message too large");
 return frozen({content,provenance,assembledBytes});
}
