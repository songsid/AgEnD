/** Server-private output constraint. Tool arguments and correlation strings cannot construct this port. */
import type {RequestContextCallAdmission} from "./request-context-call.js";
import type {RequestContextV1} from "./request-context-protocol.js";
import {hubRequestInputKey} from "./request-hub-context.js";
export interface RequestHubOutputScope {readonly context:RequestContextV1|null;current():boolean}
export function captureRequestHubOutput(admission:RequestContextCallAdmission|undefined):RequestHubOutputScope {
 const context=admission?.coverage==="covered"?structuredClone(admission.lease.snapshot.context):null;
 return Object.freeze({context,current:()=>admission?.coverage==="covered"&&admission.lease.current()});
}
/** The owning Hub adapter supplies the immutable issuer, accepted message and current destination. */
export function requestHubQuestionMatches(scope:RequestHubOutputScope|undefined,hubId:string|undefined,messageId:string,agent:string):boolean {
 if(!scope)return true; // Dormant until L installs the server-private policy.
 const c=scope.context,a=c?.initiatingActor;
 return !!c&&!!a&&c.ingress==="hub"&&"platform"in a&&a.platform==="hub"&&a.hubId===hubId
  &&c.ref.rootContextId===hubRequestInputKey(hubId!,messageId,agent).contextId&&scope.current();
}
export function requestHubRoomMatches(scope:RequestHubOutputScope|undefined,hubId:string|undefined,room:string):boolean {
 if(!scope)return true;
 const c=scope.context,a=c?.initiatingActor;
 return !!c&&!!a&&c.ingress==="hub"&&"platform"in a&&a.platform==="hub"&&a.hubId===hubId
  &&["hub","room"].includes(c.sourceAudience.kind)&&c.sourceAudience.ref===room&&scope.current();
}

/** A sensitive room read is bound to the original group audience, never a 1:1 or later return target. */
export function requestHubHistoryMatches(scope:RequestHubOutputScope|undefined,hubId:string|undefined,room:string):boolean {
 if(!scope)return true; // With request-context Off, the documented no-relay rule is guidance only.
 const c=scope.context;if(!c||!scope.current())return false;
 if(c.ingress!=="hub")return true;
 const a=c.initiatingActor;
 return "platform"in a&&a.platform==="hub"&&a.hubId===hubId&&c.sourceAudience.kind==="room"&&c.sourceAudience.ref===room;
}
