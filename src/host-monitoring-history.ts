import {Worker} from 'node:worker_threads';
import type {HistoryAnswer,HistoryStats} from './host-monitoring-history-store.js';
import {cleanupHistory} from './host-monitoring-history-files.js';
import {HistoryWatermark,historyQuery,hostHistoryPoints,type HistoryPoint} from './host-monitoring-history-policy.js';
import type {HostHealthSnapshot} from './host-monitoring.js';

export interface HistoryIsolate {
  on(event:'message'|'error'|'exit',listener:(...args:any[])=>void):unknown;
  postMessage(value:unknown):void;terminate():Promise<number>;unref():unknown;
}
export interface HostHistoryStatus {
  state:'off'|'waiting'|'recording'|'paused'|'stopping'|'failed';reason?:string;stats?:HistoryStats;
}
export type HostHistoryResult={ok:true;value:HistoryAnswer}|{ok:false;reason:string};
interface Options {
  path:string;now?:()=>number;monotonic?:()=>number;
  factory?:(path:string,control:SharedArrayBuffer)=>HistoryIsolate;
  cleanup?:(path:string)=>Promise<void>;
  unblocked?:()=>void;
}
const createIsolate=(path:string,control:SharedArrayBuffer):HistoryIsolate=>import.meta.url.endsWith('.ts')
  ?new Worker(`const {workerData}=require('node:worker_threads');import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.entry,workerData.entry));`,{eval:true,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:64},workerData:{path,control,entry:new URL('./host-monitoring-history-worker.ts',import.meta.url).href}})
  :new Worker(new URL('./host-monitoring-history-worker.js',import.meta.url),{execArgv:[],resourceLimits:{maxOldGenerationSizeMb:64},workerData:{path,control}});
interface Flight {id:number;timer:ReturnType<typeof setTimeout>;resolve:(value:any)=>void}

/** One owned persistence worker, one request in flight, at most two host frames buffered. */
export class HostMonitoringHistory {
  private readonly now:()=>number;
  private readonly monotonic:()=>number;
  private enabled=false;
  private initialized=false;
  private stopped=false;
  private cleanupFailed=false;
  private failed=false;
  private watermark=new HistoryWatermark();
  private worker:HistoryIsolate|null=null;
  private control:Int32Array|null=null;
  private ready=false;
  private exit:Promise<void>|null=null;
  private closing:Promise<void>|null=null;
  private startupTimer:ReturnType<typeof setTimeout>|null=null;
  private flight:Flight|null=null;
  private sequence=0;
  private pending=new Map<string,HistoryPoint>();
  private lastFlush=-Infinity;
  private lastWall=-Infinity;
  private permitGeneration=0;
  private permitted=false;
  private current:HostHistoryStatus={state:'off'};
  constructor(private readonly options:Options){this.now=options.now??Date.now;this.monotonic=options.monotonic??(()=>performance.now());}
  status():HostHistoryStatus {return structuredClone(this.current);}
  blocked():boolean {return !!this.closing||this.cleanupFailed;}
  configure(enabled:boolean):void {
    if(this.initialized&&this.enabled===enabled&&!this.stopped)return;
    this.initialized=true;this.enabled=enabled;this.stopped=false;
    if(!enabled){void this.finish(true);return;}
    if(this.cleanupFailed)return;
    this.failed=false;if(this.closing)return;this.lastWall=-Infinity;this.lastFlush=-Infinity;this.watermark=new HistoryWatermark();this.current={state:'waiting'};
  }
  /** Shutdown retains enabled history; disabling removes it only after physical worker exit. */
  shutdown():void {this.stopped=true;void this.finish(!this.enabled);}
  ingest(snapshot:HostHealthSnapshot):void {
    if(!this.enabled||this.stopped||this.blocked()||this.failed)return;
    const at=this.now();
    if(at<this.lastWall){this.permitted=false;if(this.control)Atomics.store(this.control,1,0);this.permitGeneration++;this.pending.clear();this.current={...this.current,state:'paused',reason:'clock_changed'};return;}
    this.lastWall=at;
    const permit=this.watermark.permit(snapshot,this.monotonic());
    if(!permit.ok){this.permitted=false;if(this.control)Atomics.store(this.control,1,0);this.permitGeneration++;this.pending.clear();this.current={...this.current,state:'paused',reason:permit.reason};return;}
    this.permitted=true;if(this.control)Atomics.store(this.control,1,1);
    for(const point of hostHistoryPoints(snapshot,at))this.pending.set(`${point.series}:${Math.floor(at/30000)}`,point);
    // Discard old buffered frames rather than queuing a catch-up stream behind a slow disk.
    const frames=[...new Set([...this.pending.values()].map(p=>Math.floor(p.at/30000)))].sort((a,b)=>b-a).slice(0,2);
    for(const [key,point]of this.pending)if(!frames.includes(Math.floor(point.at/30000)))this.pending.delete(key);
    if(!this.pending.size)return;
    if(!this.worker)this.start();
    if(this.ready&&!this.flight&&(frames.length>=2||this.monotonic()-this.lastFlush>=60000))void this.flush();
  }
  private start():void {
    if(this.worker||!this.enabled||this.blocked()||this.failed||this.stopped)return;
    const control=new SharedArrayBuffer(8);this.control=new Int32Array(control);Atomics.store(this.control,0,1);Atomics.store(this.control,1,1);
    let worker:HistoryIsolate;
    try{worker=(this.options.factory??createIsolate)(this.options.path,control);}catch{this.fail('history_start_failed');return;}
    this.worker=worker;worker.unref();
    this.exit=new Promise<void>(resolve=>worker.on('exit',()=>{
      if(this.worker===worker){this.worker=null;this.ready=false;this.clearStartup();this.complete({ok:false,reason:'history_unavailable'});if(!this.closing&&!this.stopped)this.fail('history_worker_exited');}
      resolve();
    }));
    worker.on('error',()=>{this.fail('history_io_failed');this.complete({ok:false});void worker.terminate();});
    worker.on('message',message=>{
      if(this.worker!==worker)return;
      if(message?.op==='ready'){
        this.clearStartup();if(!this.enabled||this.stopped||this.closing){worker.postMessage({op:'close'});return;}
        this.ready=true;if(this.permitted){this.current={state:'recording',stats:message.stats};void this.flush();}return;
      }
      if(message?.op==='failed'){this.fail('history_io_failed');void worker.terminate();return;}
      if(message?.id===this.flight?.id)this.complete(message);
    });
    this.startupTimer=setTimeout(()=>{this.fail('history_timeout');void worker.terminate();},2000);this.startupTimer.unref?.();
  }
  private clearStartup(){if(this.startupTimer)clearTimeout(this.startupTimer);this.startupTimer=null;}
  private fail(reason:string){this.failed=true;this.pending.clear();this.current={...this.current,state:'failed',reason};this.clearStartup();}
  private complete(value:any){const flight=this.flight;if(!flight)return;this.flight=null;clearTimeout(flight.timer);flight.resolve(value);}
  private request(message:Record<string,unknown>):Promise<any> {
    if(!this.worker||!this.ready||this.flight||this.closing||!this.enabled||this.stopped)return Promise.resolve({ok:false,reason:'history_busy'});
    const worker=this.worker,id=++this.sequence;
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{if(this.flight?.id===id){this.complete({ok:false,reason:'history_timeout'});this.fail('history_timeout');void worker.terminate();}},2000);timer.unref?.();
      this.flight={id,timer,resolve};
      try{worker.postMessage({...message,id});}catch{this.complete({ok:false,reason:'history_unavailable'});this.fail('history_io_failed');}
    });
  }
  private async flush():Promise<void> {
    if(!this.pending.size||this.flight||!this.ready||!this.permitted)return;
    const generation=this.permitGeneration;
    const points=[...this.pending.values()].slice(-64);this.pending.clear();this.lastFlush=this.monotonic();
    const answer=await this.request({op:'append',points,now:this.now()});
    if(!this.enabled||this.stopped||this.closing||generation!==this.permitGeneration)return;
    if(!answer.ok){this.fail('history_io_failed');return;}
    this.current={state:answer.value.paused?'paused':'recording',...(answer.value.paused?{reason:'history_busy'}:{}),stats:answer.value.stats};
  }
  async query(range:unknown,series:unknown):Promise<HostHistoryResult> {
    try{historyQuery(range,series,this.now());}catch{return {ok:false,reason:'invalid_history_query'};}
    if(!this.enabled||this.stopped||this.blocked()||this.failed||this.current.state!=='recording')return {ok:false,reason:this.current.reason??'history_unavailable'};
    const answer=await this.request({op:'query',range,series,now:this.now()});
    if(!this.enabled||this.stopped||this.closing)return {ok:false,reason:'history_unavailable'};
    return answer.ok?{ok:true,value:answer.value}:{ok:false,reason:'history_unavailable'};
  }
  private finish(remove:boolean):Promise<void> {
    if(this.closing)return this.closing;
    this.permitted=false;if(this.control)Atomics.store(this.control,1,0);this.permitGeneration++;this.pending.clear();this.clearStartup();this.complete({ok:false,reason:'history_unavailable'});
    if(this.control)Atomics.store(this.control,0,0);
    const worker=this.worker,physical=this.exit;
    this.current={state:'stopping'};
    const closing=this.closing=(async()=>{
      if(worker){try{worker.postMessage({op:'close'});}catch{void worker.terminate();}
        const timer=setTimeout(()=>{void worker.terminate();},2000);timer.unref?.();
        try{await physical;}finally{clearTimeout(timer);}
      }
      if(remove)await(this.options.cleanup??cleanupHistory)(this.options.path);
    })().then(()=>{
      if(this.closing!==closing)return;this.closing=null;this.control=null;this.exit=null;this.cleanupFailed=false;
      this.current={state:this.enabled&&!this.stopped?'waiting':'off'};this.options.unblocked?.();
    },()=>{this.closing=null;this.cleanupFailed=true;this.current={state:'failed',reason:'history_cleanup_failed'};this.options.unblocked?.();});
    return closing;
  }
}
