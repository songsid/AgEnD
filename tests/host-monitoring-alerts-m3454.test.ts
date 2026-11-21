import {describe,it,expect,vi} from 'vitest';
import {HostMonitoringAlerts} from '../src/host-monitoring-alerts.js';
import {emptyHostAlerts,type HostAlertDocument} from '../src/host-monitoring-alert-store.js';
import {defaultHostAlertSettings} from '../src/host-monitoring-alert-settings.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
const GiB=1024**3,key='disk:'+'a'.repeat(16);
async function tick(){for(let i=0;i<40;i++)await Promise.resolve();}
function fixture(initial=emptyHostAlerts()){
 let now=1000000,mono=0,sequence=1,document=structuredClone(initial),token=0;
 const read=vi.fn(async()=>({ok:true,value:{sequence,document:structuredClone(document)}}));
 const save=vi.fn(async(expected:number,next:HostAlertDocument)=>{expect(expected).toBe(sequence);document=structuredClone(next);return {ok:true,value:{sequence:++sequence,document:structuredClone(document)}};});
 let callback:((ok:boolean)=>void)|undefined;const deliver=vi.fn((_:any,ack:(ok:boolean)=>void)=>{callback=ack;return true;});
 const settings={...defaultHostAlertSettings(),general:true};
 const service=new HostMonitoringAlerts({persistence:{incidentRead:read,incidentSave:save},now:()=>now,monotonic:()=>mono,token:()=> (++token).toString(16).padStart(32,'0'),deliver});
 function sample(free:number|null=20*GiB){const s=disabledHostHealth();s.enabled=true;s.state='sampling';s.disks={status:free===null?'unavailable':'ok',sampledAt:now,attemptedAt:now,value:{volumes:[{id:'a'.repeat(16),roles:['wsl-backing'],totalBytes:500*GiB,availableBytes:free,usedPercent:10,sampledAt:now}]}};return s;}
 return {service,settings,read,save,deliver,sample,stored:()=>document,ack:(ok:boolean)=>callback!(ok),advance(ms=60000){now+=ms;mono+=ms;},async start(){service.configure(true,settings);service.ready();await tick();},async observe(free?:number|null){service.ingest(sample(free));await tick();}};
}
describe('durable owner-fenced host alerts',()=>{
 it('does no work while off; persists before delivery and stamps only successful callback',async()=>{
  const f=fixture();f.service.ingest(f.sample());f.service.ready();expect(f.read).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();expect(f.deliver).not.toHaveBeenCalled();
  await f.start();await f.observe();expect(f.deliver).toHaveBeenCalledTimes(1);expect(f.save).toHaveBeenCalledTimes(1);expect(f.stored().active[0].lastSentAt).toBeUndefined();expect(f.stored().pending).toHaveLength(1);
  f.ack(false);await tick();expect(f.stored().active[0].lastSentAt).toBeUndefined();expect(f.stored().pending[0].attempts).toBe(1);
  f.advance();await f.observe();expect(f.deliver).toHaveBeenCalledTimes(2);f.ack(true);await tick();expect(f.stored().active[0].lastSentAt).toBeDefined();expect(f.stored().pending).toHaveLength(0);
  const calls=f.save.mock.calls.length;f.advance();await f.observe();expect(f.save).toHaveBeenCalledTimes(calls);expect(f.deliver).toHaveBeenCalledTimes(2);
 });
 it('retains acknowledged and snoozed issues; urgency bypasses warning snooze; missing data never recovers',async()=>{
  const f=fixture();await f.start();await f.observe(50*GiB);f.advance();await f.observe(50*GiB);f.ack(true);await tick();
  let record=f.service.snapshot().active[0];expect(record.level).toBe('warning');expect(await f.service.act(key,record.revision,'admin:1')).toBe(true);expect(f.service.snapshot().active[0].acknowledgedBy).toBe('admin:1');
  expect(await f.service.act(key,record.revision,'admin:1',86400000)).toBe(true);f.advance();await f.observe();expect(f.service.snapshot().active[0].level).toBe('urgent');expect(f.deliver).toHaveBeenCalledTimes(2);f.ack(true);await tick();
  for(let i=0;i<12;i++){f.advance();await f.observe(null);}expect(f.service.snapshot().active).toHaveLength(1);
  for(let i=0;i<11;i++){f.advance();await f.observe(80*GiB);}expect(f.service.snapshot().active).toHaveLength(0);expect(f.service.snapshot().resolved).toHaveLength(1);expect(f.deliver).toHaveBeenCalledTimes(3);
 });
 it('fences an old callback through Off/re-enable and keeps at most one physical delivery',async()=>{
  const f=fixture();await f.start();await f.observe();f.service.configure(false);const calls=f.save.mock.calls.length;
  await f.start();f.advance();await f.observe();expect(f.deliver).toHaveBeenCalledTimes(1);f.ack(true);await tick();expect(f.deliver).toHaveBeenCalledTimes(2);expect(f.save.mock.calls.length).toBe(calls);
  expect(f.service.snapshot().active[0].lastSentAt).toBeUndefined();
 });
 it('restores pending retries and revisions, and invalid actions do not fail monitoring',async()=>{
  const f=fixture();await f.start();await f.observe();const restored=fixture(f.stored());await restored.start();
  expect(restored.deliver).toHaveBeenCalledTimes(1);const record=restored.service.snapshot().active[0];expect(await restored.service.act(key,record.revision+1,'admin:1')).toBe(false);expect(await restored.service.act(key,record.revision,'bad actor')).toBe(false);expect(restored.service.snapshot().state).toBe('ready');
 });
 it('coalesces simultaneous incidents into one message and accepts synchronous delivery callbacks',async()=>{
  const f=fixture();await f.start();const s=f.sample();s.disks.value!.volumes.push({...s.disks.value!.volumes[0],id:'b'.repeat(16)});f.deliver.mockImplementation((_,ack)=>{expect(f.stored().active).toHaveLength(2);ack(true);return true;});f.service.ingest(s);await tick();expect(f.deliver).toHaveBeenCalledTimes(1);expect(f.stored().pending).toHaveLength(0);expect(f.stored().active.every(r=>r.lastSentAt!==undefined)).toBe(true);
 });
 it('releases queued admin edits when an earlier durable transition fails',async()=>{
  const f=fixture();await f.start();let finish!:(value:any)=>void;f.save.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})as any);f.service.ingest(f.sample());await tick();let result:any='pending';void f.service.act(key,1,'admin:1').then(value=>{result=value});finish({ok:false});await tick();expect(result).toBe(false);expect(f.service.snapshot().state).toBe('failed');
 });
 it('does not report an in-flight edit successful after Off revokes its epoch',async()=>{
  const f=fixture();f.settings.general=false;await f.start();await f.observe();let finish!:()=>void;f.save.mockImplementationOnce((sequence,document)=>new Promise(resolve=>{finish=()=>resolve({ok:true,value:{sequence:sequence+1,document}})})as any);const action=f.service.act(key,1,'admin:1');await tick();f.service.configure(false);finish();await tick();expect(await action).toBe(false);expect(f.service.snapshot().state).toBe('off');
 });
 it('fails visibly on persistence refusal without calling delivery',async()=>{
  const f=fixture();await f.start();f.save.mockResolvedValueOnce({ok:false} as any);await f.observe();expect(f.service.snapshot().state).toBe('failed');expect(f.deliver).not.toHaveBeenCalled();
 });
});
