import {bindLinuxRootIdentities} from './host-monitoring-process-identity.js';
import {spawn} from './child-process.js';
import {lstat} from 'node:fs/promises';
import {cpus} from 'node:os';
import {FootprintAttribution,parseFootprintProcesses,FOOTPRINT_BYTES,FOOTPRINT_ROOTS,type FootprintRoot,type FootprintReading} from './host-monitoring-footprint-policy.js';
import type {MonitoringProbe} from './host-monitoring.js';
export interface FootprintInput extends FootprintRoot {files:string[]}
export interface FootprintSnapshot {enabled:boolean;status:'off'|'starting'|'ok'|'stale'|'unavailable'|'stopping';reading:FootprintReading|null;reason?:string}
export type ProcessRunner=()=>MonitoringProbe<string>;
/** Separate from disk probes: fixed columns, no command line, no shell, one bounded pipe. */
export const runFootprintProcesses:ProcessRunner=()=>{
 let result!:(value:string|null)=>void,closed!:()=>void,child:ReturnType<typeof spawn>|undefined,ended=false,bytes=0,parts:Buffer[]=[];
 const answer=new Promise<string|null>(resolve=>result=resolve),stopped=new Promise<void>(resolve=>closed=resolve);
 const finish=(value:string|null)=>{if(ended)return;ended=true;result(value);};
 const cancel=()=>{finish(null);child?.kill('SIGKILL');};
 const timer=setTimeout(cancel,1500);timer.unref();
 try{child=spawn('/bin/ps',['-ww','-A','-o','pid=,ppid=,rss=,time=,lstart='],{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',LANG:'C',TZ:'UTC'},stdio:['ignore','pipe','ignore']});
 child.stdout!.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>FOOTPRINT_BYTES){parts=[];cancel();}else if(!ended)parts.push(chunk);});
 child.on('error',()=>finish(null));child.on('close',code=>{clearTimeout(timer);finish(code===0?Buffer.concat(parts).toString('utf8'):null);parts=[];closed();});
 }catch{clearTimeout(timer);finish(null);closed();}
 return {result:answer,stopped,cancel};
};
interface Options {roots():FootprintInput[];identities?:typeof bindLinuxRootIdentities;runner?:ProcessRunner;now?:()=>number;monotonic?:()=>number;logicalCpus?:()=>number;fleetPid?:number;changed?():void}
/** A single 60-second flight. Logical timeout never releases physical process/stat ownership. */
export class HostFootprint {
 private enabled=false;private timer:ReturnType<typeof setInterval>|null=null;private flight:Promise<void>|null=null;private cancel:(()=>void)|null=null;private epoch=0;
 private policy=new FootprintAttribution();private value:FootprintSnapshot={enabled:false,status:'off',reading:null};
 constructor(private readonly options:Options){}
 snapshot():FootprintSnapshot {const copy=structuredClone(this.value);if(copy.status==='ok'&&copy.reading&&(this.options.now??Date.now)()-copy.reading.sampledAt>=120000)copy.status='stale';return copy;}
 configure(enabled:boolean):void {
  if(enabled===this.enabled)return;this.enabled=enabled;this.epoch++;
  if(!enabled){if(this.timer)clearInterval(this.timer);this.timer=null;this.cancel?.();this.value={enabled:false,status:this.flight?'stopping':'off',reading:null};this.policy.reset();return;}
  this.value={enabled:true,status:'starting',reading:null};this.timer=setInterval(()=>this.sample(),60000);this.timer.unref();this.sample();
 }
 async stop():Promise<void>{this.configure(false);await this.flight;}
 private sample():void {
  if(!this.enabled||this.flight)return;const epoch=this.epoch,wall=(this.options.now??Date.now)(),mono=(this.options.monotonic??(()=>performance.now()))();
  let inputs:FootprintInput[];try{inputs=this.options.roots();if(inputs.length>FOOTPRINT_ROOTS)throw Error();}catch{this.value={enabled:true,status:'unavailable',reading:null,reason:'root_limit'};return;}
  let probe:MonitoringProbe<string>;try{probe=(this.options.runner??runFootprintProcesses)();}catch{this.value={enabled:true,status:'unavailable',reading:null,reason:'process_unavailable'};return;}
  let expired=false;const timeout=setTimeout(()=>{expired=true;probe.cancel();if(this.enabled&&epoch===this.epoch)this.value={enabled:true,status:'unavailable',reading:null,reason:'sample_timeout'};},2000);timeout.unref();this.cancel=()=>{expired=true;probe.cancel();};
  const task=(async()=>{
   try{
    const processes=parseFootprintProcesses(await probe.result);if(!processes||expired)throw Error();
    // Injected inventories stay pure unless they explicitly provide an identity reader. Native Linux always binds.
    const binder=this.options.identities??(!this.options.runner&&process.platform==='linux'?bindLinuxRootIdentities:undefined);
    const rejected=binder?await binder(processes,inputs,()=>!expired&&this.enabled&&epoch===this.epoch):new Set<number>();
    if(expired||!this.enabled||epoch!==this.epoch)return;
    // Metadata only, at most four exact known files per root; eight asynchronous calls at a time.
    const metadata=new Map<string,number|null>(),inodes=new Map<string,Set<string>>();
    const files=inputs.filter(root=>root.pid>1&&!rejected.has(root.pid)).flatMap(root=>root.files.slice(0,4).map(path=>({root:root.id,path}))),seenPaths=new Set<string>();let cursor=0;
    for(const root of inputs)metadata.set(root.id,0);
    await Promise.all(Array.from({length:Math.min(8,files.length)},async()=>{while(cursor<files.length&&!expired){const item=files[cursor++];try{const info=await lstat(item.path);if(!info.isFile()||info.isSymbolicLink())throw Error();const key=`${info.dev}:${info.ino}`;const owners=inodes.get(key)??new Set<string>();owners.add(item.root);inodes.set(key,owners);if(!seenPaths.has(key)){seenPaths.add(key);metadata.set(item.root,metadata.get(item.root)===null?null:metadata.get(item.root)!+info.size);}else metadata.set(item.root,null);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')metadata.set(item.root,null);}}}));
    if(expired||!this.enabled||epoch!==this.epoch)return;
    const currentRoots=this.options.roots();if(currentRoots.length>FOOTPRINT_ROOTS)throw Error('root_limit');
    const current=new Map(currentRoots.map(root=>[root.id,root]));
    const roots=inputs.map(root=>{const live=current.get(root.id);return !rejected.has(root.pid)&&live&&live.owner===root.owner&&live.pid===root.pid?root:{...root,pid:0};});
    const reading=this.policy.sample(processes,roots,this.options.fleetPid??process.pid,wall,mono,(this.options.logicalCpus??(()=>cpus().length))(),[...inputs.map(root=>root.pid),...currentRoots.map(root=>root.pid)]);
    for(const owners of inodes.values())if(owners.size>1)for(const id of owners)metadata.set(id,null);
    for(const row of reading.rows)row.managedBytes=row.rssBytes===null?null:metadata.get(row.id)??null;
    this.value={enabled:true,status:'ok',reading};this.options.changed?.();
   }catch{if(this.enabled&&epoch===this.epoch){this.policy.reset();this.value={enabled:true,status:'unavailable',reading:null,reason:'process_unavailable'};}}
   finally{await probe.stopped;clearTimeout(timeout);}
  })();this.flight=task;
  void task.then(()=>{if(this.flight!==task)return;this.flight=null;this.cancel=null;if(!this.enabled)this.value={enabled:false,status:'off',reading:null};else if(epoch!==this.epoch)this.sample();},()=>{/* Retain reservation on unconfirmed physical stop. */});
 }
}
