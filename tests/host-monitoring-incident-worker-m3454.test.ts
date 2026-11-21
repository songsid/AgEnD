import {EventEmitter} from 'node:events';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HostMonitoringHistory,type HistoryIsolate} from '../src/host-monitoring-history.js';
import {emptyHostAlerts} from '../src/host-monitoring-alert-store.js';
class Isolate extends EventEmitter implements HistoryIsolate {
 sent:any[]=[];terminate=vi.fn(async()=>0);unref=vi.fn();postMessage(value:any){this.sent.push(value);}
 ready(){this.emit('message',{op:'ready'});}
 answer(value:any){this.emit('message',{id:this.sent.at(-1).id,ok:true,value});}
}
async function tick(){for(let i=0;i<12;i++)await Promise.resolve();}
afterEach(()=>vi.useRealTimers());
describe('shared incident persistence ownership',()=>{
 it('starts only on opt-in, before a disk sample, without granting SQLite writes',async()=>{
  vi.useFakeTimers();const worker=new Isolate(),factory=vi.fn(),cleanup=vi.fn(async()=>{}),ready=vi.fn();let control!:Int32Array;
  const history=new HostMonitoringHistory({path:'/fixture/history',incidents:true,incidentReady:ready,cleanup,factory:(_,buffer)=>{factory();control=new Int32Array(buffer);return worker;}});
  expect((await history.incidentRead()).ok).toBe(false);expect(factory).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  history.configure(true);expect(factory).toHaveBeenCalledTimes(1);expect(Array.from(control)).toEqual([1,0]);worker.ready();expect(ready).toHaveBeenCalledTimes(1);
  const first=history.incidentRead(),second=history.incidentSave(1,emptyHostAlerts());expect((await history.incidentRead()).reason).toBe('incident_busy');expect(worker.sent).toHaveLength(1);
  worker.answer({sequence:1,document:emptyHostAlerts()});expect((await first).ok).toBe(true);expect(worker.sent.at(-1).op).toBe('incident-save');
  history.configure(false);expect(Array.from(control)).toEqual([0,0]);expect((await second).ok).toBe(false);expect(cleanup).not.toHaveBeenCalled();
  worker.emit('exit');await tick();expect(cleanup).toHaveBeenCalledTimes(1);expect(history.status().state).toBe('off');expect(vi.getTimerCount()).toBe(0);
 });
 it('does not launch the queued save when the current request times out',async()=>{
  vi.useFakeTimers();const worker=new Isolate();const history=new HostMonitoringHistory({path:'/fixture/history',incidents:true,factory:()=>worker,cleanup:async()=>{}});
  history.configure(true);worker.ready();const first=history.incidentRead(),queued=history.incidentSave(1,emptyHostAlerts());
  await vi.advanceTimersByTimeAsync(2000);expect((await first).ok).toBe(false);expect((await queued).ok).toBe(false);expect(worker.sent).toHaveLength(1);expect(worker.terminate).toHaveBeenCalledTimes(1);
  history.configure(false);worker.emit('exit');await tick();
 });
 it('reads and commits preallocated banks with history permission withdrawn, without opening SQLite',async()=>{
  const root=await mkdtemp(join(tmpdir(),'host-incident-worker-'));let read:Promise<any>|undefined;
  const history=new HostMonitoringHistory({path:join(root,'history.sqlite'),incidents:true,incidentReady:()=>{read=history.incidentRead();}});
  try {
   history.configure(true);await vi.waitFor(()=>expect(read).toBeDefined());const loaded=await read!;expect(loaded.ok).toBe(true);expect(loaded.value.document).toEqual(emptyHostAlerts());
   expect((await readdir(root)).sort()).toEqual(['history.sqlite.incidents','history.sqlite.incidents.tmp']);
   const saved=await history.incidentSave(loaded.value.sequence,emptyHostAlerts());expect(saved.ok).toBe(true);expect(saved.value.sequence).toBe(loaded.value.sequence+1);
  }finally{history.configure(false);await vi.waitFor(()=>expect(history.status().state).toBe('off'),{timeout:5000});expect(await readdir(root)).toEqual([]);await rm(root,{recursive:true,force:true});}
 });
});
