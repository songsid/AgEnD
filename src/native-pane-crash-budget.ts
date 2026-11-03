/** Metadata-only crash budget survives replacement native daemons; it never discards a conversation. */
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
interface State { version:1; sessionId:string; count:number; lastAt:number; crashes:number[] }
export interface NativeRestartPolicy { max_retries:number; backoff:"linear"|"exponential"; reset_after:number }
export type NativeRestartDecision = {kind:"normal"|"disabled"|"loop"|"exhausted";count:number}|{kind:"retry";count:number;delay:number};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class NativePaneCrashBudget {
 constructor(private file:string){}
 private load():State|null{
  try{
   const stat=lstatSync(this.file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||process.getuid&&(stat.uid!==process.getuid()||!!(stat.mode&0o077)))throw Error("Native crash budget is not an owned private file");
   const value=JSON.parse(readFileSync(this.file,"utf8")) as State;
   if(value?.version!==1||!UUID.test(value.sessionId)||!Number.isSafeInteger(value.count)||value.count<0||value.count>100000
    ||!Number.isSafeInteger(value.lastAt)||value.lastAt<0||!Array.isArray(value.crashes)||value.crashes.length>16
    ||value.crashes.some(at=>!Number.isSafeInteger(at)||at<0)||Object.keys(value).some(key=>!["version","sessionId","count","lastAt","crashes"].includes(key)))throw Error("Native crash budget is invalid; automatic resume is held");
   return value;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
 }
 reset(sessionId:string):void{
  if(!UUID.test(sessionId))throw Error("Native crash budget requires a pinned conversation");
  this.load();atomicWriteFileSync(this.file,JSON.stringify({version:1,sessionId,count:0,lastAt:0,crashes:[]}),{mode:0o600});
 }
 observe(sessionId:string,exitCode:number|undefined,policy:NativeRestartPolicy,now=Date.now()):NativeRestartDecision{
  if(!UUID.test(sessionId))throw Error("Native recovery requires its exact pinned conversation");
  if(!Number.isSafeInteger(now)||now<0||!Number.isFinite(policy.max_retries)||!Number.isFinite(policy.reset_after))throw Error("Invalid native restart policy or clock");
  if(exitCode===0)return{kind:"normal",count:0};
  const saved=this.load(),state:State=saved?.sessionId===sessionId?saved:{version:1,sessionId,count:0,lastAt:0,crashes:[]};
  if(policy.reset_after>0&&now-state.lastAt>policy.reset_after)state.count=0;
  state.count++;state.lastAt=now;state.crashes=state.crashes.filter(at=>at>now-300000);state.crashes.push(now);state.crashes=state.crashes.slice(-16);
  atomicWriteFileSync(this.file,JSON.stringify(state),{mode:0o600});
  if(policy.max_retries<=0)return{kind:"disabled",count:state.count};
  if(state.crashes.length>=3)return{kind:"loop",count:state.count};
  if(state.count>policy.max_retries)return{kind:"exhausted",count:state.count};
  const delay=policy.backoff==="exponential"?Math.min(2**Math.min(state.count-1,16)*1000,60000):state.count*1000;
  return{kind:"retry",count:state.count,delay};
 }
}
