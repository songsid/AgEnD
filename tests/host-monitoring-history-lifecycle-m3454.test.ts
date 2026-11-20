import {EventEmitter} from 'node:events';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {HostMonitoringHistory,type HistoryIsolate} from '../src/host-monitoring-history.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
const GiB=1024**3;
function sample(free=8*GiB){const s=disabledHostHealth();s.enabled=true;s.state='sampling';s.platform='linux';s.cpu={status:'ok',sampledAt:30000,attemptedAt:30000,value:{usedPercent:40,logicalCpus:4,loadAverage:null}};s.disks={status:'ok',sampledAt:30000,attemptedAt:30000,value:{volumes:[{id:'a'.repeat(16),roles:['state'],availableBytes:free,totalBytes:20*GiB,usedPercent:60,sampledAt:30000}]}};return s;}
class Isolate extends EventEmitter implements HistoryIsolate {
 sent:any[]=[];terminate=vi.fn(async()=>0);unref=vi.fn();postMessage(value:any){this.sent.push(value);}
 ready(){this.emit('message',{op:'ready',stats:{bytes:100}});}
 answer(value:any={paused:false,stats:{bytes:200}}){const last=this.sent.at(-1);this.emit('message',{id:last.id,ok:true,value});}
}
function fixture(cleanup=vi.fn(async()=>{})){
 let now=30000,mono=0;const worker=new Isolate(),factory=vi.fn(()=>worker),unblocked=vi.fn();let control:SharedArrayBuffer;
 const history=new HostMonitoringHistory({path:'/fixture/host-monitoring.sqlite',now:()=>now,monotonic:()=>mono,factory:(path,c)=>{control=c;return factory();},cleanup,unblocked});
 return {history,worker,factory,cleanup,unblocked,control:()=>new Int32Array(control),advance(ms:number){now+=ms;mono+=ms;}};
}
async function tick(){for(let i=0;i<8;i++)await Promise.resolve();}
afterEach(()=>vi.useRealTimers());
describe('owned history persistence lifecycle',()=>{
 it('off reads create no worker or timer; startup false does one exact cleanup',async()=>{
  vi.useFakeTimers();const f=fixture();for(let i=0;i<3;i++){f.history.status();await f.history.query('1h',['cpu.used']);}expect(f.factory).not.toHaveBeenCalled();expect(f.cleanup).not.toHaveBeenCalled();
  f.history.configure(false);f.history.configure(false);await tick();expect(f.cleanup).toHaveBeenCalledTimes(1);expect(f.history.status().state).toBe('off');expect(vi.getTimerCount()).toBe(0);
 });
 it('cannot open history from queries, missing disks or low-water readings',async()=>{
  const f=fixture();f.history.configure(true);await f.history.query('1h',['cpu.used']);f.history.ingest(disabledHostHealth());f.history.ingest(sample(GiB));expect(f.factory).not.toHaveBeenCalled();expect(f.history.status().reason).toBe('low_space');
 });
 it('fences a late append reply after low space and requires ten minutes above recovery',async()=>{
  vi.useFakeTimers();const f=fixture();f.history.configure(true);f.history.ingest(sample());f.worker.ready();expect(f.worker.sent.at(-1).op).toBe('append');
  f.history.ingest(sample(GiB));expect(Atomics.load(f.control(),1)).toBe(0);f.worker.answer();await tick();expect(f.history.status()).toMatchObject({state:'paused',reason:'low_space'});
  f.advance(60000);f.history.ingest(sample());expect(f.worker.sent).toHaveLength(1);f.advance(599999);f.history.ingest(sample());expect(f.worker.sent).toHaveLength(1);
  f.advance(1);f.history.ingest(sample());expect(f.worker.sent).toHaveLength(2);f.worker.answer();await tick();expect(f.history.status().state).toBe('recording');
  f.history.configure(false);f.worker.emit('exit');await tick();
 });
 it('keeps at most two frames and one request in flight, with no catch-up stream',async()=>{
  vi.useFakeTimers();const f=fixture();f.history.configure(true);f.history.ingest(sample());f.worker.ready();
  for(let i=0;i<20;i++){f.advance(30000);f.history.ingest(sample());}expect(f.worker.sent).toHaveLength(1);expect((await f.history.query('1h',['cpu.used'])).ok).toBe(false);
  f.worker.answer();await tick();f.advance(30000);f.history.ingest(sample());expect(f.worker.sent).toHaveLength(2);expect(f.worker.sent[1].points.length).toBeLessThanOrEqual(6);expect(f.worker.sent[1].points.every((p:any)=>p.at>=600000)).toBe(true);
  f.history.configure(false);f.worker.emit('exit');await tick();
 });
 it('revokes worker permission before close, waits for physical exit, and blocks a replacement',async()=>{
  vi.useFakeTimers();const f=fixture();f.history.configure(true);f.history.ingest(sample());f.worker.ready();f.history.configure(false);
  expect(Atomics.load(f.control(),0)).toBe(0);expect(f.history.blocked()).toBe(true);expect(f.cleanup).not.toHaveBeenCalled();
  f.history.configure(true);f.history.ingest(sample());expect(f.factory).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(2000);expect(f.worker.terminate).toHaveBeenCalledTimes(1);expect(f.cleanup).not.toHaveBeenCalled();
  f.worker.emit('exit');await tick();expect(f.cleanup).toHaveBeenCalledTimes(1);expect(f.history.status().state).toBe('waiting');expect(f.history.blocked()).toBe(false);
 });
 it('cleanup failure is explicit and prevents re-enabling or replacement',async()=>{
  const f=fixture(vi.fn(async()=>{throw Error('fixture denied')}));f.history.configure(false);await tick();expect(f.history.status()).toMatchObject({state:'failed',reason:'history_cleanup_failed'});
  f.history.configure(true);f.history.ingest(sample());expect(f.factory).not.toHaveBeenCalled();expect(f.history.blocked()).toBe(true);
 });
 it('a stuck write times out without another queued write or automatic worker restart',async()=>{
  vi.useFakeTimers();const f=fixture();f.history.configure(true);f.history.ingest(sample());f.worker.ready();await vi.advanceTimersByTimeAsync(2000);
  expect(f.worker.terminate).toHaveBeenCalledTimes(1);expect(f.history.status().state).toBe('failed');f.worker.emit('exit');f.advance(30000);f.history.ingest(sample());expect(f.factory).toHaveBeenCalledTimes(1);
  f.history.configure(false);await tick();expect(f.cleanup).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it('runtime shutdown retains enabled files and refuses a late query result',async()=>{
  vi.useFakeTimers();const f=fixture();f.history.configure(true);f.history.ingest(sample());f.worker.ready();f.worker.answer();await tick();const query=f.history.query('1h',['cpu.used']);
  f.history.shutdown();expect(await query).toEqual({ok:false,reason:'history_unavailable'});f.worker.emit('exit');await tick();expect(f.cleanup).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
});
