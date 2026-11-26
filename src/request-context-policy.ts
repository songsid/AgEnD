import {labelUnprovedRequest} from "./request-context-unproved-label.js";
/** Dormant H operation policy. Installation belongs to L; arguments never supply a call admission. */
import {expandCompositeCall} from "./channel/mcp-tools.js";
import type {RequestContextCallAdmission} from "./request-context-call.js";
import {labelHubRequest} from "./request-hub-context.js";
import type {NewOutboxDelivery} from "./delivery-outbox.js";
import type {RequestOperationBindingV1,RequestContextV1} from "./request-context-protocol.js";
import {getLocale,type Locale} from "./locale.js";

export const REQUEST_CONTEXT_POLICY_COPY={
 en:{fleet:"Not available for Hub requests: this shows the owner's own Fleet details.",uncovered:"Nothing changed: we can't tell who asked for this.",interrupted:"This agent was interrupted; this contact needs one approval.",stale:"Not sent: the originating request is no longer current.",forwards:"Not sent: Hub requests can't forward owner approvals.",steer:"Not sent: this request can't interrupt another task.",broadcast:"Not sent: choose one agent for this message.",deferred:"Nothing changed: Hub requests can't assign tasks.",tasks:"Nothing changed: Hub requests can't create or change task cards.",schedules:"Nothing changed: Hub requests can't create or change scheduled work.",agents:"Nothing changed: Hub requests can't create agents.",teams:"Nothing changed: Hub requests can't create teams.",decisions:"Nothing changed: Hub requests can't create or change shared rules.",outside:"Nothing changed: this request can't change tasks, schedules, agents, teams or rules.",settings:"Nothing changed: ask the owner to start a new request.",audience:"Not sent: this reply must stay in its original Hub conversation.",invalid:"Not sent: this operation is not supported for this request."},
 "zh-TW":{fleet:"Hub 的請求不能用：這會顯示擁有者自己的機群資料。",uncovered:"沒有變更：無法確認這是誰的要求。",interrupted:"這個 Agent 曾中斷；這次聯絡需要核准一次。",stale:"未送出：原本的請求已不再有效。",forwards:"未送出：Hub 請求不能轉交擁有者核准。",steer:"未送出：這個請求不能插入另一項工作。",broadcast:"未送出：請選一個 Agent 接收這則訊息。",deferred:"沒有變更：Hub 的請求不能轉交任務。",tasks:"沒有變更：Hub 的請求不能新增或修改任務卡。",schedules:"沒有變更：Hub 的請求不能新增或修改排程的工作。",agents:"沒有變更：Hub 的請求不能建立 Agent。",teams:"沒有變更：Hub 的請求不能建立團隊。",decisions:"沒有變更：Hub 的請求不能新增或修改共用規則。",outside:"沒有變更：這個請求不能改動任務、排程、Agent、團隊或共用規則。",settings:"沒有變更：請由擁有者另外提出這件事。",audience:"未送出：這個回覆只能留在原本的 Hub 對話。",invalid:"未送出：這個請求不支援這項操作。"},
}as const;
export type RequestContextPolicyCode=keyof typeof REQUEST_CONTEXT_POLICY_COPY.en;
export class RequestContextPolicyError extends Error {
 readonly code:string;
 constructor(readonly reason:RequestContextPolicyCode,locale:Locale=getLocale()) {super(REQUEST_CONTEXT_POLICY_COPY[locale][reason]);this.name="RequestContextPolicyError";this.code=`request-context-${reason}`;}
}
const READS=new Set(["download_attachment","list_instances","describe_instance","list_teams","list_models","get_fleet_status","get_fleet_config","get_web_settings","get_usage","get_effort","get_instance_logs","kiro_engine_status","get_cache_report","get_usage_report","list_decisions","list_schedules","list_deployments","validate_config","delivery_status","contact_state","hub_room_list","hub_room_members","hub_people_search","list_emojis","preview_emojis","list_stickers","preview_stickers","get_web_theme","get_web_appearance","preview_web_appearance","office_view","office_pack_check","office_pack_list"]);
const HUB_PRIVATE_READS=new Set(["get_fleet_config","get_web_settings","get_instance_logs","get_usage","get_cache_report"]);
const TASK_READS=new Set(["list","get","mine","projects"]);
const CONTACTS=new Set(["send_to_instance","request_information","report_result","delegate_task","broadcast"]);
const DERIVATIVES=new Set(["post_decision","update_decision","create_schedule","update_schedule","delete_schedule","create_instance","deploy_template","create_team"]);
export interface RequestContextOperation {
 instance:string;tool:string;args:Record<string,unknown>;admission?:RequestContextCallAdmission;
}
export interface RequestContextOperationPermit {
 readonly kind:"ordinary"|"read"|"needs-approval"|"relay"|"hub-answer"|"hub-react"|"hub-post";
 readonly tool:string;readonly args:Record<string,unknown>;readonly context?:RequestContextV1;
}
const localRecoveryAudience=(context:RequestContextV1):boolean=>context.sourceAudience.kind==="instance"&&context.returnAudience?.kind==="instance"&&context.returnAudience.ref===context.sourceAudience.ref;
const hasForward=(args:Record<string,unknown>):boolean=>{
 const values=[args.forwards,(args.meta&&typeof args.meta==="object"?(args.meta as Record<string,unknown>).forwards:undefined),args.receiptId,args.receipt_id];
 return values.some(value=>value!==undefined&&value!==null&&(Array.isArray(value)?value.length>0:typeof value==="string"?value.length>0:true));
};
/** Uses canonical server tool/action plus D's immutable lease; never looks up a later active turn. */
export function assertRequestContextOperation(input:RequestContextOperation,locale:Locale=getLocale()):RequestContextOperationPermit {
 const refuse=(code:RequestContextPolicyCode):never=>{throw new RequestContextPolicyError(code,locale);};
 const expanded=expandCompositeCall(input.tool,input.args);if("error"in expanded)return refuse("invalid");
 const {name:tool,args}=expanded,read=READS.has(tool)||tool==="task"&&TASK_READS.has(String(args.action));
 const admission=input.admission;
 if(admission?.coverage!=="covered"){
  if(read)return {kind:"read",tool,args};
  if(["send_to_instance","request_information","report_result"].includes(tool)&&(args.target_instance??args.instance_name)!=="agend-hub"){
   if(hasForward(args))return refuse("forwards");
   if(args.steer!==undefined&&args.steer!==false)return refuse("steer");
   if(args.request_kind==="task")return refuse("deferred");
   return {kind:"needs-approval",tool,args};
  }
  return refuse("uncovered");
 }
 const {lease}=admission;
 if(!lease.current()||lease.snapshot.owner.instance!==input.instance)return refuse("stale");
 const context=lease.snapshot.context,hub=context.ingress==="hub";
 // Initial shared rollout cannot create durable outside derivatives without their parent contract.
 if(context.ingress!=="owner"&&(DERIVATIVES.has(tool)||tool==="task"&&!read))return refuse(hub?tool==="task"?"tasks":tool.endsWith("_schedule")?"schedules":["create_instance","deploy_template"].includes(tool)?"agents":tool==="create_team"?"teams":"decisions":"outside");
 if(context.initiatingActor.kind==="unknown"&&!read&&!CONTACTS.has(tool))return refuse("settings");
 if(context.initiatingActor.kind==="unknown"){
  if(hub&&!localRecoveryAudience(context))return refuse("uncovered");
  if(hub&&HUB_PRIVATE_READS.has(tool))return refuse("fleet");
  if(["send_to_instance","request_information","report_result"].includes(tool)&&(args.target_instance??args.instance_name)!=="agend-hub"){
   if(hasForward(args))return refuse("forwards");
   if(args.steer!==undefined&&args.steer!==false||args.requestedKind==="steer"||args.kind==="steer"||args.type==="steer")return refuse("steer");
   if(args.request_kind==="task")return refuse("deferred");
   return {kind:"needs-approval",tool,args,context};
  }
  if(hub&&read)return {kind:"read",tool,args,context};
  if(hub)return refuse(tool==="broadcast"?"broadcast":"uncovered");
 }
 if(!hub)return {kind:"ordinary",tool,args,context};
 return hubOperation(context,tool,args,read,locale);
}
function hubOperation(context:RequestContextV1,tool:string,args:Record<string,unknown>,read:boolean,locale:Locale):RequestContextOperationPermit {
 const refuse=(code:RequestContextPolicyCode):never=>{throw new RequestContextPolicyError(code,locale);};
 if(!("platform"in context.initiatingActor)||context.initiatingActor.platform!=="hub")return refuse("uncovered");
 if(HUB_PRIVATE_READS.has(tool))return refuse("fleet");
 if(tool==="broadcast")return refuse("broadcast");
 if(tool==="delegate_task")return refuse("deferred");
 if(CONTACTS.has(tool)){
  if(hasForward(args))return refuse("forwards");
  if(args.steer!==undefined&&args.steer!==false||args.requestedKind==="steer"||args.kind==="steer"||args.type==="steer")return refuse("steer");
  if(args.request_kind==="task")return refuse("deferred");
  const target=args.target_instance??args.instance_name;
  return {kind:target==="agend-hub"?"hub-answer":"relay",tool,args,context};
 }
 if(read)return {kind:"read",tool,args,context};
 if(tool==="hub_room_post"){
  if(hasForward(args))return refuse("forwards");
  const audience=context.returnAudience??context.sourceAudience;
  if(!["hub","room"].includes(audience.kind)||args.room!==audience.ref)return refuse("audience");
  return {kind:"hub-post",tool,args,context}; // The real Hub owner must also check issuer/current sharing/room/mute.
 }
 if(tool==="react"&&typeof args.message_id==="string"&&/^hub-room-[a-f0-9-]{36}$/.test(args.message_id))return {kind:"hub-react",tool,args,context}; // Owning adapter checks exact question, never the prefix alone.
 return refuse("settings");
}

export interface RequestContextPolicyPort {
 assert(input:RequestContextOperation):RequestContextOperationPermit;
 /** L's one publication predicate. Staged ports are not an installed Fleet. Never read from model/config arguments. */
 installed?():boolean;
 installedMode?():"active"|"draining"|"off"|null;
 /** Rendering only: an exact fenced replacement may stage its launch instructions before publication. Never serving authority. */
 instructionMode?():"active"|"draining"|"off"|null;
}
/** Mode is required for serving decisions; a capable Off/Draining installation is not Active. */
export function requestContextInstalledMode(policy:RequestContextPolicyPort|undefined):"active"|"draining"|"off"|null {
 try {
  if(policy?.installedMode){const mode=policy.installedMode();return mode==="active"||mode==="draining"||mode==="off"?mode:null;}
  // Compatibility for H's explicit trusted test/embedding port. L supplies the mode-aware publication.
  return policy?.installed?.()===true?"active":null;
 }catch{return null;}
}
export function requestContextPolicyInstalled(policy:RequestContextPolicyPort|undefined):boolean {return requestContextInstalledMode(policy)!==null;}
/** Instructions/managed skills only. An explicit candidate mode never changes installedMode or admission. */
export function requestContextInstructionMode(policy:RequestContextPolicyPort|undefined):"active"|"draining"|"off"|null {
 try {
  const mode=policy?.instructionMode?policy.instructionMode():requestContextInstalledMode(policy);
  return mode==="active"||mode==="draining"||mode==="off"?mode:null;
 }catch{return null;}
}
export interface RequestContextPolicyContext {requestContextPolicy?:RequestContextPolicyPort;readonly requestContextCallAdmission?:RequestContextCallAdmission}
export function requireRequestContextPolicy(ctx:RequestContextPolicyContext,instance:string,tool:string,args:Record<string,unknown>,admission?:RequestContextCallAdmission):RequestContextOperationPermit|undefined {
 return ctx.requestContextPolicy?.assert({instance,tool,args,admission:admission??ctx.requestContextCallAdmission});
}
/** Immutable persisted images have no live originating lease after a hold; only static constraints are revalidated here. */
export function assertRequestHubContactImage(context:RequestContextV1,binding:RequestOperationBindingV1,delivery:NewOutboxDelivery):boolean {
 if(context.ingress!=="hub")return false;
 if(context.initiatingActor.kind==="unknown"){
  if(!localRecoveryAudience(context))throw new RequestContextPolicyError("uncovered");
  const payload=delivery.payload,meta=payload.meta;
  if(!["send_to_instance","request_information","report_result"].includes(binding.verb)||binding.target.instance==="agend-hub"||delivery.kind!=="fleet_inbound"||delivery.requestedKind==="steer"||payload.type!=="fleet_inbound"||typeof payload.content!=="string"||!meta||typeof meta!=="object"||Array.isArray(meta)||Object.values(meta).some(value=>typeof value!=="string"))throw new RequestContextPolicyError("invalid");
  if(hasForward({forwards:delivery.forwards,meta}))throw new RequestContextPolicyError("forwards");
  if((meta as Record<string,string>).request_kind==="task")throw new RequestContextPolicyError("deferred");
  const routing=meta as Record<string,string>,prefix=labelUnprovedRequest(context,"",routing);
  if(!payload.content.startsWith(prefix))throw new RequestContextPolicyError("invalid");
  labelUnprovedRequest(context,payload.content.slice(prefix.length),routing);
  return false; // Unknown Hub recovery always needs its own decision; it is never M-3661 pass-through.
 }
 if(!("platform"in context.initiatingActor)||context.initiatingActor.platform!=="hub")return false;
 const payload=delivery.payload as Record<string,unknown>,meta=payload.meta;
 if(!meta||typeof meta!=="object"||Array.isArray(meta)||Object.values(meta).some(value=>typeof value!=="string")||typeof payload.content!=="string")throw new RequestContextPolicyError("invalid");
 const permit=hubOperation(context,binding.verb,{forwards:delivery.forwards,meta,steer:delivery.kind==="steer"||delivery.requestedKind==="steer"||payload.type==="steer",request_kind:(meta as Record<string,string>).request_kind,target_instance:binding.target.instance},false,getLocale());
 if(permit.kind!=="relay"&&permit.kind!=="hub-answer")throw new RequestContextPolicyError("invalid");
 const routing=meta as Record<string,string>,prefix=labelHubRequest(context,"",routing).content;
 if(!payload.content.startsWith(prefix))throw new RequestContextPolicyError("invalid");
 labelHubRequest(context,payload.content.slice(prefix.length),routing);return true;
}
