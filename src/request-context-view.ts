import {escapeInboundField} from "./inbound-presentation.js";
/** An inert display projection of B-validated delivery metadata, never body-inferred authority. */
import {z} from "zod";
import type {RequestContextV1} from "./request-context-protocol.js";
import type {DeliveryOutbox} from "./delivery-outbox.js";
import {labelHubRequest} from "./request-hub-context.js";
const schema=z.strictObject({version:z.literal(1),kind:z.literal("hub-requester"),contextId:z.uuid(),rootContextId:z.uuid(),hubId:z.string().min(1).max(256),actorId:z.string().min(1).max(256),actorKind:z.enum(["person","agent","assistant"]),displayName:z.string().min(1).max(256).refine(s=>!/[\x00-\x1f\x7f]/.test(s)).optional(),audience:z.enum(["room","hub"]),authority:z.literal("none"),refused:z.literal(true).optional()});
export type RequestProvenanceView=z.infer<typeof schema>;
export function requestProvenanceView(value:unknown):RequestProvenanceView|undefined {const result=schema.safeParse(value);return result.success?result.data:undefined;}
/** Only server-owned validated context/lease owners call this, including a refusal before any operation is admitted. */
export function requestContextDisplayView(context:RequestContextV1):RequestProvenanceView|null {
 const actor=context.initiatingActor,audience=context.returnAudience??context.sourceAudience;
 if(context.ingress!=="hub"||!("platform"in actor)||actor.platform!=="hub"||!["hub","room"].includes(audience.kind))return null;
 const name=actor.displayName?escapeInboundField(actor.displayName):undefined;
 return schema.parse({version:1,kind:"hub-requester",contextId:context.ref.contextId,rootContextId:context.ref.rootContextId,hubId:actor.hubId,actorId:actor.id,actorKind:actor.kind,...(name&&name.length<=256?{displayName:name}:{}),audience:audience.kind,authority:"none"});
}
export function requestDeliveryView(box:DeliveryOutbox,deliveryId:string):{view:RequestProvenanceView;body:string}|null {
 const operation=box.requestContextForDelivery(deliveryId);if(!operation)return null;
 const context=box.requestContext(operation.binding.contextId),delivery=box.get(deliveryId);if(!context||!delivery)return null;
 const actor=context.initiatingActor;if(context.ingress!=="hub"||!("platform"in actor)||actor.platform!=="hub")return null;
 const audience=context.returnAudience??context.sourceAudience;
 if(!["hub","room"].includes(audience.kind))return null;
 const meta=delivery.payload.meta;if(!meta||typeof meta!=="object"||Array.isArray(meta)||Object.values(meta).some(v=>typeof v!=="string")||typeof delivery.payload.content!=="string")throw Error("Request provenance image unavailable");
 const prefix=labelHubRequest(context,"",meta as Record<string,string>).content;
 if(!delivery.payload.content.startsWith(prefix))throw Error("Request provenance image differs");
 return {body:delivery.payload.content.slice(prefix.length),view:requestContextDisplayView(context)!};
}
