import {Worker} from 'node:worker_threads';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HostMonitoringHistory} from '../src/host-monitoring-history.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
const roots:string[]=[],histories:HostMonitoringHistory[]=[];
afterEach(async()=>{for(const h of histories.splice(0)){h.configure(false);await vi.waitFor(()=>expect(h.status().state).toBe('off'),{timeout:5000});}for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function sample(){const s=disabledHostHealth(),at=Date.now();s.enabled=true;s.state='sampling';s.platform='linux';s.cpu={status:'ok',sampledAt:at,attemptedAt:at,value:{usedPercent:73,logicalCpus:4,loadAverage:null}};s.disks={status:'ok',sampledAt:at,attemptedAt:at,value:{volumes:[{id:'a'.repeat(16),roles:['state'],totalBytes:20*1024**3,availableBytes:8*1024**3,usedPercent:60,sampledAt:at}]}};return s;}
describe('real isolated SQLite worker',()=>{
 it('a withdrawn shared write permission refuses a queued append without opening SQLite',async()=>{
  const root=await mkdtemp(join(tmpdir(),'monitor-withdrawn-'));roots.push(root);
  const history=new HostMonitoringHistory({path:join(root,'monitoring.sqlite'),factory:(path,control)=>{
   Atomics.store(new Int32Array(control),1,0);
   return new Worker(`const {workerData}=require('node:worker_threads');import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.entry,workerData.entry));`,{eval:true,execArgv:[],workerData:{path,control,entry:new URL('../src/host-monitoring-history-worker.ts',import.meta.url).href}});
  }});histories.push(history);history.configure(true);history.ingest(sample());
  await vi.waitFor(()=>expect(history.status().state).toBe('failed'),{timeout:5000});expect(await readdir(root)).toEqual([]);
  history.configure(false);await vi.waitFor(()=>expect(history.status().state).toBe('off'),{timeout:5000});histories.splice(histories.indexOf(history),1);
 });
 it('writes/queries numerically, then physically closes and removes only its store',async()=>{
  const root=await mkdtemp(join(tmpdir(),'monitor-worker-'));roots.push(root);const history=new HostMonitoringHistory({path:join(root,'monitoring.sqlite')});histories.push(history);
  history.configure(false);await vi.waitFor(()=>expect(history.status().state).toBe('off'));expect(await readdir(root)).toEqual([]);
  history.configure(true);expect((await history.query('1h',['cpu.used'])).ok).toBe(false);expect(await readdir(root)).toEqual([]);
  history.ingest(sample());await vi.waitFor(()=>expect(history.status().stats?.rows).toBeGreaterThan(0),{timeout:5000});
  const answer=await history.query('1h',['cpu.used']);expect(answer.ok).toBe(true);if(answer.ok){expect(answer.value.series[0].buckets.filter(b=>b.count).map(b=>b.average)).toEqual([73]);expect(answer.value.series[0].buckets.length).toBeLessThanOrEqual(240);}
  history.configure(false);await vi.waitFor(()=>expect(history.status().state).toBe('off'),{timeout:5000});expect(await readdir(root)).toEqual([]);histories.splice(histories.indexOf(history),1);
 });
});
