/** One owned exec run's human receipt; never a pane proof, model argument or restored active turn. */
import type Database from "better-sqlite3";
import {bindHumanReceipt,getHumanReceipt,humanBodyHash} from "./human-delivery-receipts.js";
import {humanReceiptMarker} from "./inbound-presentation.js";
import {RequestHumanInputStore} from "./request-context-human.js";
import {requestContextDigest,requestContextJson} from "./request-context-store.js";
import type {RequestContextRuntimeOwner} from "./request-context-turns.js";
import {validateNativeExecInputClaim,validateNativeExecInputProof,type NativeExecInputClaim,type NativeExecInputProof} from "./native-exec-input.js";
export function prepareRequestNativeHumanInput(db:Database.Database,ready:()=>void,input:{
 receiptId:string;instance:string;managerBootId:string;owner:Readonly<RequestContextRuntimeOwner>;claim:Readonly<NativeExecInputClaim>;wire:string;current():boolean;
}){
 const {receiptId,instance,managerBootId,wire}=input,ownerCurrent=input.current.bind(input);
 const owner=Object.freeze(structuredClone(input.owner)),claim=validateNativeExecInputClaim(input.claim);
 if(owner.instance!==instance||owner.daemonBootId!==managerBootId
  ||![owner.instance,owner.incarnation,owner.workGeneration,owner.daemonBootId].every(v=>typeof v==="string"&&v.length>0&&v.length<=256)
  ||![owner.spawnGeneration,owner.launchFenceEpoch,owner.deliveryEpoch].every(v=>Number.isSafeInteger(v)&&v>=0)
  ||humanBodyHash(wire)!==claim.wireSha256)throw Error("Native human input composition changed");
 const ownerKey=requestContextJson(["native-exec-v1",managerBootId,owner,claim]);
 let alive=true;
 const owned=()=>{try{ready();return alive&&ownerCurrent();}catch{return false;}};
 const context=()=>{
  const accepted=new RequestHumanInputStore(db,ready).read(receiptId),row=getHumanReceipt(db,receiptId);
  if(!accepted||!row||row.target_instance!==instance||row.manager_boot_id!==managerBootId||row.input_kind!=="fleet_inbound"
    ||row.original_body.startsWith("/raw ")||accepted.context.source.instance!==owner.instance||accepted.context.source.incarnation!==owner.incarnation)throw Error("Accepted native human input is unavailable");
  return {accepted,row};
 };
 if(!owned())throw Error("Native human input owner changed");
 const acceptedImage=requestContextDigest(context().accepted.context);
 db.transaction(()=>{
  ready();const {row}=context();
  if(row.state!=="queued"||row.proof_tag!==null||row.proof_mode!==null||row.delivered_at!==null||row.owner_key!==null&&row.owner_key!==ownerKey
    ||!["compact","legacy"].some(dialect=>wire.includes(humanReceiptMarker(row.message_id,dialect as "compact"|"legacy"))))throw Error("Native human input is not an untouched receipt");
  bindHumanReceipt(db,receiptId,instance,ownerKey,wire,managerBootId);
  if(!owned()||requestContextDigest(context().accepted.context)!==acceptedImage)throw Error("Native human input owner changed");
 })();
 const current=()=>{
  try{if(!owned())return false;const {row,accepted}=context();
   const proofState=row.state==="delivered"?row.proof_tag==="owned-native-exec"&&row.proof_mode==="native_exec"&&row.delivered_at!==null:row.proof_tag===null&&row.proof_mode===null&&row.delivered_at===null;
   return proofState&&requestContextDigest(accepted.context)===acceptedImage&&row.owner_key===ownerKey&&row.wire_sha256===claim.wireSha256&&row.wire_body===wire;}catch{return false;}
 };
 return Object.freeze({inputId:`human:hmsg-${receiptId}`,ownerKey,wireSha256:claim.wireSha256,current,
  written:(value:Readonly<NativeExecInputProof>):boolean=>{
   const proof=validateNativeExecInputProof(value,claim);
   if(!current())throw Error("Native human input owner changed");
   return db.transaction(()=>{
    ready();if(!current())throw Error("Native human input owner changed");const {row}=context();
    if(row.state==="delivered"){
     if(row.proof_tag!=="owned-native-exec"||row.proof_mode!=="native_exec")throw Error("Native human input proof differs");
     return true;
    }
    if(proof.inputSha256!==row.wire_sha256||humanBodyHash(row.wire_body!)!==row.wire_sha256||humanBodyHash(row.original_body)!==row.original_sha256)throw Error("Native human input bytes differ");
    const now=Date.now(),at=new Date(now).toISOString();
    if(db.prepare("UPDATE human_delivery_receipts SET state='delivered',proof_tag='owned-native-exec',proof_mode='native_exec',updated_at=?,delivered_at=? WHERE receipt_id=? AND target_instance=? AND manager_boot_id=? AND owner_key=? AND wire_sha256=? AND state!='delivered'")
      .run(at,at,receiptId,instance,managerBootId,ownerKey,claim.wireSha256).changes!==1)throw Error("Native human input owner changed");
    db.prepare("INSERT INTO usage_message_hours (instance,hour,count) VALUES (?,?,1) ON CONFLICT(instance,hour) DO UPDATE SET count=count+1").run(instance,Math.floor(now/3_600_000)*3_600_000);
    ready();if(!current())throw Error("Native human input owner changed");
    return true;
   })();
  },dispose:()=>{
   alive=false;if(!db.open)return;ready();
   db.prepare("UPDATE human_delivery_receipts SET state='uncertain',updated_at=? WHERE receipt_id=? AND target_instance=? AND manager_boot_id=? AND owner_key=? AND wire_sha256=? AND state='queued'")
     .run(new Date().toISOString(),receiptId,instance,managerBootId,ownerKey,claim.wireSha256);
  },
 });
}
