import {afterEach,describe,expect,it,vi} from 'vitest';
import {HostMonitoring} from '../src/host-monitoring.js';
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
function deferred<T>(){let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve}}
function fixture(){
 const stop=deferred<void>(), diskPhysical=deferred<void>();let diskValue=deferred<any>();
 const provider={platform:'linux' as const,host:vi.fn(()=>({cpu:{value:{usedPercent:25,logicalCpus:4,loadAverage:[1,2,3]}},memory:{value:null,reason:'memory_unavailable'}})),disks:vi.fn(()=>({result:diskValue.promise,stopped:diskPhysical.promise,cancel:vi.fn()})),stop:vi.fn(()=>stop.promise)};
 const factory=vi.fn(()=>provider);const monitoring=new HostMonitoring({factory,now:()=>Date.now()});return{monitoring,provider,factory,stop,diskPhysical,diskValue};
}
afterEach(()=>vi.useRealTimers());
describe('lazy host monitoring lifecycle',()=>{
 it('creates no provider or monitoring timer when off or before runtime start; snapshot is passive',()=>{
  vi.useFakeTimers();const f=fixture();f.monitoring.configure({enabled:false,agent_footprint:false});
  for(let i=0;i<50;i++)expect(f.monitoring.snapshot().state).toBe('off');
  f.monitoring.configure({enabled:true,agent_footprint:false});expect(f.factory).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  f.monitoring.setRuntimeActive(true);expect(f.factory).toHaveBeenCalledTimes(1);expect(f.provider.host).toHaveBeenCalledTimes(1);
 });
 it('samples host every30s, disks every60s, without a backlog or overlapping physical disk flight',async()=>{
  vi.useFakeTimers();const f=fixture();f.monitoring.setRuntimeActive(true);f.monitoring.configure({enabled:true,agent_footprint:false});
  expect(f.provider.disks).toHaveBeenCalledTimes(1);f.diskValue.resolve({volumes:[],backingDrive:'not-applicable'});await flush();
  await vi.advanceTimersByTimeAsync(120_000);expect(f.provider.host).toHaveBeenCalledTimes(5);expect(f.provider.disks).toHaveBeenCalledTimes(1);
  f.diskPhysical.resolve();await flush();await vi.advanceTimersByTimeAsync(30_000);expect(f.provider.disks).toHaveBeenCalledTimes(2);
 });
 it('fences late results and waits for physical stop before enabling a new provider',async()=>{
  vi.useFakeTimers();const f=fixture();f.monitoring.setRuntimeActive(true);f.monitoring.configure({enabled:true,agent_footprint:false});
  f.monitoring.configure({enabled:false,agent_footprint:false});expect(vi.getTimerCount()).toBe(0);expect(f.provider.stop).toHaveBeenCalledTimes(1);expect(f.monitoring.snapshot().state).toBe('stopping');
  f.monitoring.configure({enabled:true,agent_footprint:false});expect(f.factory).toHaveBeenCalledTimes(1);
  f.diskValue.resolve({volumes:[{id:'late'}],backingDrive:'identified'});await flush();expect(f.monitoring.snapshot().disks.value).toBeNull();
  f.stop.resolve();await flush();expect(f.factory).toHaveBeenCalledTimes(1);
  f.diskPhysical.resolve();await flush();expect(f.factory).toHaveBeenCalledTimes(2);
 });
 it('never restarts after an off request while an old provider is draining',async()=>{
  vi.useFakeTimers();const f=fixture();f.monitoring.setRuntimeActive(true);f.monitoring.configure({enabled:true,agent_footprint:false});f.monitoring.setRuntimeActive(false);
  f.monitoring.configure({enabled:false,agent_footprint:false});f.stop.resolve();f.diskPhysical.resolve();await flush();expect(f.monitoring.snapshot().state).toBe('off');expect(f.factory).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it('does not overwrite a newer disk result with an old logically late result',async()=>{
  vi.useFakeTimers();const f=fixture(),newResult=deferred<any>();let calls=0;
  f.provider.disks.mockImplementation(()=>++calls===1?{result:f.diskValue.promise,stopped:Promise.resolve(),cancel:vi.fn()}:{result:newResult.promise,stopped:Promise.resolve(),cancel:vi.fn()});
  f.monitoring.setRuntimeActive(true);f.monitoring.configure({enabled:true,agent_footprint:false});await flush();
  await vi.advanceTimersByTimeAsync(60_000);newResult.resolve({volumes:[],backingDrive:'identified'});await flush();
  f.diskValue.resolve({volumes:[],backingDrive:'unknown'});await flush();expect(f.monitoring.snapshot().disks.value?.backingDrive).toBe('identified');
 });
 it('does not let a wall-clock correction suspend the disk cadence',async()=>{
  vi.useFakeTimers();const f=fixture();f.provider.disks.mockImplementation(()=>({result:Promise.resolve({volumes:[],backingDrive:'not-applicable'}),stopped:Promise.resolve(),cancel:vi.fn()}));
  f.monitoring.setRuntimeActive(true);f.monitoring.configure({enabled:true,agent_footprint:false});await flush();vi.setSystemTime(Date.now()-3_600_000);
  await vi.advanceTimersByTimeAsync(60_000);expect(f.provider.disks).toHaveBeenCalledTimes(2);
 });
 it('retains ownership after unconfirmed stop instead of spawning duplicates',async()=>{
  vi.useFakeTimers();const stop=deferred<void>();const provider={platform:'linux',host:()=>({cpu:{value:null},memory:{value:null}}),disks:()=>({result:Promise.resolve({volumes:[]}),stopped:Promise.resolve(),cancel(){}}),stop:()=>Promise.reject(Error('not stopped'))};
  const factory=vi.fn(()=>provider);const m=new HostMonitoring({factory:factory as any});m.setRuntimeActive(true);m.configure({enabled:true,agent_footprint:false});m.configure({enabled:false,agent_footprint:false});await flush();m.configure({enabled:true,agent_footprint:false});expect(factory).toHaveBeenCalledTimes(1);expect(m.snapshot().state).toBe('failed');expect(vi.getTimerCount()).toBe(0);
 });
});
