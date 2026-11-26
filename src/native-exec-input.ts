/** Owned native input evidence. Built-ins only: the standalone Windows worker loads this module. */
import type {ChildProcess} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {buildNativeInvocation,nativeProvider,type NativeProviderTask} from "./windows-cli-providers.js";
export const NATIVE_EXEC_INPUT_CAPABILITY="native-exec-input-v1" as const;
const id=/^[A-Za-z0-9-]{16,80}$/,uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i,sha=/^[a-f0-9]{64}$/;
export type NativeExecInputTransport="stdin-text"|"stdin-json"|"file";
export interface NativeExecInputClaim {readonly v:1;readonly requestId:string;readonly token:string;readonly requestSha256:string;readonly wireSha256:string}
export interface NativeExecInputProof extends NativeExecInputClaim {readonly transport:NativeExecInputTransport;readonly inputSha256:string}
export interface NativeExecInputOptions {readonly context?:string;readonly resumeSessionId?:string;readonly personal?:true;readonly answerOnly?:true}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==="object"&&!Array.isArray(value);}
const hash=(bytes:string|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
/** Bind logical composition before launch, including the worker's context suffix and personal-stage choice. */
export function nativeExecInputRequestDigest(task:NativeProviderTask&{requestId:string},options:NativeExecInputOptions):string {
 return hash(JSON.stringify([task.requestId,task.cli,task.cwd,task.prompt,task.sandbox,task.model??null,
  options.context||null,options.resumeSessionId??null,options.personal===true,options.answerOnly===true]));
}
/** Fleet exec has no personal stage: predict exactly the bytes the existing provider formatter will deliver. */
export function nativeExecInputBytes(task:NativeProviderTask&{requestId:string},options:NativeExecInputOptions):Buffer {
 if(options.personal||options.answerOnly)throw Error("Personal exec input needs its owned staged bytes");
 const prompt=options.context?`${task.prompt}\n\nAgEnD task context:\n${options.context}`:task.prompt;
 const composed={...task,prompt};
 const invocation=buildNativeInvocation(composed,{resumeSessionId:options.resumeSessionId,promptFile:"C:/AgEnD/owned-prompt.txt"});
 return Buffer.from(nativeProvider(task.cli).promptTransport==="file"?prompt:invocation.stdin,"utf8");
}
export function validateNativeExecInputClaim(value:unknown):Readonly<NativeExecInputClaim>{
 if(!object(value)||Object.keys(value).sort().join(",")!=="requestId,requestSha256,token,v,wireSha256"||value.v!==1
  ||typeof value.requestId!=="string"||!id.test(value.requestId)||typeof value.token!=="string"||!uuid.test(value.token)
  ||typeof value.requestSha256!=="string"||!sha.test(value.requestSha256)||typeof value.wireSha256!=="string"||!sha.test(value.wireSha256))throw Error("Native exec input claim is invalid");
 return Object.freeze({v:1,requestId:value.requestId,token:value.token,requestSha256:value.requestSha256,wireSha256:value.wireSha256});
}
export function claimNativeExecInput(task:NativeProviderTask&{requestId:string},options:NativeExecInputOptions):Readonly<NativeExecInputClaim>{
 return validateNativeExecInputClaim({v:1,requestId:task.requestId,token:randomUUID(),requestSha256:nativeExecInputRequestDigest(task,options),wireSha256:hash(nativeExecInputBytes(task,options))});
}
export function validateNativeExecInputProof(value:unknown,expected?:NativeExecInputClaim):Readonly<NativeExecInputProof>{
 if(!object(value)||Object.keys(value).sort().join(",")!=="inputSha256,requestId,requestSha256,token,transport,v,wireSha256"
  ||!["stdin-text","stdin-json","file"].includes(String(value.transport))||typeof value.inputSha256!=="string"||!sha.test(value.inputSha256))throw Error("Native exec input proof is invalid");
 const claim=validateNativeExecInputClaim({v:value.v,requestId:value.requestId,requestSha256:value.requestSha256,token:value.token,wireSha256:value.wireSha256});
 if(expected&&(claim.requestId!==expected.requestId||claim.token!==expected.token||claim.requestSha256!==expected.requestSha256||claim.wireSha256!==expected.wireSha256))throw Error("Native exec input proof belongs to another run");
 if(value.inputSha256!==claim.wireSha256)throw Error("Native exec input bytes differ");
 return Object.freeze({...claim,transport:value.transport as NativeExecInputTransport,inputSha256:value.inputSha256});
}
/** Construct only for the main child, after all provider/personal setup. No timer or terminal status supplies evidence. */
export class NativeExecInputWitness {
 private spawned=false;private written=false;private failed=false;private closed=false;private emitted=false;
 private readonly proof:Readonly<NativeExecInputProof>;
 constructor(claim:NativeExecInputClaim,task:NativeProviderTask&{requestId:string},options:NativeExecInputOptions,
  transport:NativeExecInputTransport,inputBytes:string|Uint8Array,private readonly publish:(proof:Readonly<NativeExecInputProof>)=>void){
  const expected=validateNativeExecInputClaim(claim);
  if(expected.requestId!==task.requestId||expected.requestSha256!==nativeExecInputRequestDigest(task,options)||transport!==nativeProvider(task.cli).promptTransport)throw Error("Native exec input composition changed");
  this.proof=validateNativeExecInputProof({...expected,transport,inputSha256:hash(inputBytes)},expected);
 }
 spawnedMain():void{this.spawned=true;this.maybePublish();}
 stdinFinished(error?:Error|null):void{if(error)this.failed=true;else this.written=true;this.maybePublish();}
 failedInput():void{this.failed=true;}
 closedMain():void{this.closed=true;}
 private maybePublish():void{
  if(this.emitted||this.failed||this.closed||!this.spawned||this.proof.transport!=="file"&&!this.written)return;
  this.emitted=true;this.publish(this.proof);
 }
}

/** Attach before any cancel-on-spawn observer, then write once after the worker installed its other child handlers. */
export function prepareNativeExecInputWrite(child:Pick<ChildProcess,"once"|"stdin">,witness:NativeExecInputWitness,stdin:string):()=>void {
 const pipe=child.stdin;if(!pipe)throw Error("Native exec input pipe is unavailable");
 child.once("spawn",()=>witness.spawnedMain());
 child.once("error",()=>witness.failedInput());
 child.once("close",()=>witness.closedMain());
 pipe.once("error",()=>witness.failedInput());
 let written=false;
 return ()=>{
  if(written)throw Error("Native exec input was already written");written=true;
  pipe.end(stdin,"utf8",(error?:Error|null)=>witness.stdinFinished(error));
 };
}
