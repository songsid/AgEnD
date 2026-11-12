/** Owned-fixture observation only. No SQL arguments, keys, cookies or file contents are recorded. */
import { Session } from 'node:inspector';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
export async function startDiagnostics(rig:any,out:string) {
 const inspector=new Session();inspector.connect();
 const post=(method:string)=>new Promise<any>((resolve,reject)=>inspector.post(method as any,(e,r)=>e?reject(e):resolve(r)));
 const started=performance.now(),cpu=process.cpuUsage(),elu=performance.eventLoopUtilization(),delay=monitorEventLoopDelay({resolution:10});delay.enable();
 const stat=()=>{try{return readFileSync('/sys/fs/cgroup/cpu.stat','utf8');}catch{return null;}};
 const before=stat(),totals=new Map<string,{calls:number,totalMs:number,maxMs:number}>(),restore:Array<()=>void>=[];
 const timed=(name:string,fn:Function,self:any,args:any[])=>{const t=performance.now();try{return fn.apply(self,args);}finally{const elapsed=performance.now()-t,v=totals.get(name)??{calls:0,totalMs:0,maxMs:0};v.calls++;v.totalMs+=elapsed;v.maxMs=Math.max(v.maxMs,elapsed);totals.set(name,v);}};
 const fs=createRequire(import.meta.url)('node:fs');
 for(const name of ['fsyncSync','fdatasyncSync','readFileSync','openSync','lstatSync','fstatSync']){
  const original=fs[name],wrapped=function(this:any,...args:any[]){return timed('fs.'+name,original,this,args);};fs[name]=wrapped;restore.push(()=>{if(fs[name]===wrapped)fs[name]=original;});
 }
 syncBuiltinESMExports();
 const databases=[...new Set([rig.db,rig.deps.companyJoin.codes.deps.db])],owners=new WeakMap<object,number>();
 const prototype=Object.getPrototypeOf(rig.db.prepare('SELECT 1'));
 for(const action of ['run','get','all']){const original=prototype[action];const wrapped=function(this:any,...args:any[]){const owner=owners.get(this);return owner===undefined?original.apply(this,args):timed('db'+owner+'.statement.'+action,original,this,args);};prototype[action]=wrapped;restore.push(()=>{if(prototype[action]===wrapped)prototype[action]=original;});}
 for(const [index,db] of databases.entries())for(const method of ['prepare','exec','pragma']){
  const original=db[method];const wrapped=function(this:any,...args:any[]){const value=timed('db'+index+'.'+method,original,this,args);if(method==='prepare')owners.set(value,index);return value;};db[method]=wrapped;restore.push(()=>{if(db[method]===wrapped)db[method]=original;});
 }
 let gcMs=0,gcMaxMs=0,gcCount=0;const gc=new PerformanceObserver(list=>{for(const e of list.getEntries()){gcMs+=e.duration;gcMaxMs=Math.max(gcMaxMs,e.duration);gcCount++;}});gc.observe({entryTypes:['gc']});
 await post('Profiler.enable');await post('Profiler.start');let stopped=false;
 return {async stop(){if(stopped)return;stopped=true;const profile=await post('Profiler.stop');inspector.disconnect();delay.disable();gc.disconnect();
  for(const f of restore.reverse())f();syncBuiltinESMExports();
  writeFileSync(join(out,'diagnostic-3713.cpuprofile'),JSON.stringify(profile.profile));
  writeFileSync(join(out,'diagnostic-3713.json'),JSON.stringify({source:process.env.CAMPAIGN_SHA,observed:'Only the combined wave; profiling/timing overhead is disclosed, no product code or deadlines changed.',elapsedMs:performance.now()-started,cpu:process.cpuUsage(cpu),eventLoop:performance.eventLoopUtilization(elu),delay:{maxMs:delay.max/1e6,p99Ms:delay.percentile(99)/1e6,meanMs:delay.mean/1e6},gc:{count:gcCount,totalMs:gcMs,maxMs:gcMaxMs},sqlFs:[...totals].map(([name,v])=>({name,...v})),cpuStatBefore:before,cpuStatAfter:stat()},null,2));
 }};
}
