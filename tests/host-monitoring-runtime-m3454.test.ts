import {afterEach,describe,expect,it,vi} from 'vitest';
import {HostMonitoringRuntime} from '../src/host-monitoring-runtime.js';
afterEach(()=>vi.useRealTimers());
function fixture(raw:any={}) {
 const config:{enabled:boolean;agent_footprint:boolean;wsl_drive?:string}={enabled:false,agent_footprint:false},events:string[]=[];
 const provider={platform:'linux' as const,host:()=>({cpu:{value:null},memory:{value:null}}),disks:()=>({result:Promise.resolve({volumes:[]}),stopped:Promise.resolve(),cancel(){}}),stop:vi.fn(async()=>{})};
 const pin=vi.fn((patches:Array<{path:string[];value:boolean}>)=>{events.push('commit');raw.monitoring ??={};for(const patch of patches)raw.monitoring[patch.path[1]]=patch.value;});
 const read=vi.fn(()=>raw),factory=vi.fn(()=>{events.push('factory');return provider;});
 const runtime=new HostMonitoringRuntime({supported:()=>true,committed:()=>config,raw:read,pin,factory});
 return {runtime,config,raw,pin,read,factory,events,provider};
}
describe('committed host monitoring runtime bridge',()=>{
 it('cannot read config, discover providers or allocate timers before runtime start',()=>{
  vi.useFakeTimers();const f=fixture();for(let i=0;i<10;i++){f.runtime.apply();f.runtime.snapshot();expect(f.runtime.available()).toBe(false);}
  expect(f.read).not.toHaveBeenCalled();expect(f.factory).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('durably pins absent defaults false without starting a default-off provider',()=>{
  vi.useFakeTimers();const f=fixture();f.runtime.start();
  expect(f.raw.monitoring).toEqual({enabled:false,agent_footprint:false});expect(f.pin).toHaveBeenCalledTimes(1);expect(f.runtime.available()).toBe(true);
  expect(f.factory).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);f.runtime.stop();
 });
 it('commits missing false before the first opted-in factory and does not recurse from the writer',()=>{
  vi.useFakeTimers();const f=fixture({monitoring:{enabled:true}});f.config.enabled=true;
  f.pin.mockImplementationOnce(patches=>{f.events.push('commit');for(const patch of patches)f.raw.monitoring[patch.path[1]]=patch.value;f.runtime.apply();});
  f.runtime.start();expect(f.events).toEqual(['commit','factory']);expect(f.raw.monitoring.agent_footprint).toBe(false);f.runtime.stop();
 });
 it('refuses collection when pinning fails and never overwrites a concurrent monitoring edit',()=>{
  vi.useFakeTimers();const f=fixture({monitoring:{enabled:true}});f.config.enabled=true;f.pin.mockImplementation(()=>{throw Error('disk full')});f.runtime.start();
  expect(f.runtime.available()).toBe(false);expect(f.factory).not.toHaveBeenCalled();expect(f.runtime.snapshot().reason).toBe('monitoring_config_not_committed');
  const concurrent=fixture({monitoring:{enabled:true,agent_footprint:false}});concurrent.runtime.start();expect(concurrent.pin).not.toHaveBeenCalled();expect(concurrent.factory).not.toHaveBeenCalled();expect(concurrent.raw.monitoring.enabled).toBe(true);
 });
 it('applies only committed enable/disable and never restarts from an apply after shutdown',async()=>{
  vi.useFakeTimers();const f=fixture();f.runtime.start();f.config.enabled=true;f.raw.monitoring.enabled=true;f.runtime.apply();expect(f.factory).toHaveBeenCalledTimes(1);
  f.config.enabled=false;f.raw.monitoring.enabled=false;f.runtime.apply();expect(f.provider.stop).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  await Promise.resolve();f.runtime.stop();f.config.enabled=true;f.raw.monitoring.enabled=true;f.runtime.apply();expect(f.factory).toHaveBeenCalledTimes(1);expect(f.runtime.available()).toBe(false);
 });
 it('drains the old provider when the explicit backing-drive selection changes',async()=>{
  vi.useFakeTimers();const f=fixture({monitoring:{enabled:true,agent_footprint:false}});f.config.enabled=true;f.runtime.start();
  f.config.wsl_drive='E';f.raw.monitoring.wsl_drive='E';f.runtime.apply();
  expect(f.provider.stop).toHaveBeenCalledTimes(1);expect(f.factory).toHaveBeenCalledTimes(1);
  for(let i=0;i<12;i++)await Promise.resolve();expect(f.factory).toHaveBeenCalledTimes(2);f.runtime.stop();
 });
});
