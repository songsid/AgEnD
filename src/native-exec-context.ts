/** IDs-only native journal reference. Routes, people and active C tokens stay out of this file. */
import {createHash} from "node:crypto";
export interface NativeExecContextReference {readonly version:1;readonly inputId:string|null;readonly instance:string;readonly incarnation:string;readonly contextId:string;readonly rootContextId:string}
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function validateNativeExecContextReference(value:unknown):Readonly<NativeExecContextReference>{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Native context reference is invalid");
 const r=value as Record<string,unknown>;
 if(Object.keys(r).sort().join(",")!=="contextId,incarnation,inputId,instance,rootContextId,version"||r.version!==1
  ||r.inputId!==null&&(typeof r.inputId!=="string"||r.inputId.length<1||r.inputId.length>256)
  ||![r.instance,r.incarnation].every(x=>typeof x==="string"&&x.length>0&&x.length<=256)
  ||typeof r.contextId!=="string"||!uuid.test(r.contextId)||typeof r.rootContextId!=="string"||!uuid.test(r.rootContextId))throw Error("Native context reference is invalid");
 return Object.freeze({version:1,inputId:r.inputId as string|null,instance:r.instance as string,incarnation:r.incarnation as string,contextId:r.contextId,rootContextId:r.rootContextId});
}
export function nativeExecContextInputKey(ref:NativeExecContextReference):string{return hash([ref.instance,ref.incarnation,ref.inputId]);}
export function nativeExecContextReferenceDigest(ref:NativeExecContextReference):string{return hash([ref.version,ref.instance,ref.incarnation,ref.inputId,ref.contextId,ref.rootContextId]);}
