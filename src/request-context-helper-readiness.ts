/** Actual replacement launch observations; a version advertisement or a prepared policy is not a helper connection. */
import type {Daemon} from "./daemon.js";
import {requestContextDigest} from "./request-context-store.js";
export function captureRequestContextHelpers(owners:readonly {name:string;daemon:Daemon;prepared:{bound():boolean}}[],
 currentDaemon:(name:string)=>Daemon|undefined){
 const read=()=>owners.map(row=>{
  try{
   const helper=row.daemon.requestContextHelperReadiness(),bound=row.prepared.bound()&&currentDaemon(row.name)===row.daemon;
   return {name:row.name,boot:row.daemon.bootId,generation:helper?.generation??null,
    ready:bound&&helper?.version===1&&helper.ready===true&&!!helper.generation};
  }catch{return {name:row.name,boot:null,generation:null,ready:false};}
 }).sort((a,b)=>a.name.localeCompare(b.name));
 const initial=read(),sha256=requestContextDigest(initial),ready=initial.every(row=>row.ready);
 return Object.freeze({ready,sha256,unready:Object.freeze(initial.filter(row=>!row.ready).map(row=>row.name)),
  current:()=>{try{const next=read();return ready&&next.every(row=>row.ready)&&requestContextDigest(next)===sha256;}catch{return false;}}});
}
