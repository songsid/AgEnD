import {describe,it,expect} from 'vitest';
import {HostAlertWindow,HOST_ALERT_DEFAULTS as rules,validateHostAlertRule,HOST_ALERT_WARNING_REPEAT_MS,HOST_ALERT_URGENT_REPEAT_MS} from '../src/host-monitoring-alert-policy.js';
const minute=60_000,GiB=1024**3;
function sample(window:HostAlertWindow,at:number,value:number|null,wall=at,id=at){return window.observe({sampledAt:id,monotonicAt:at,wallAt:wall,value});}
function cpu(window:HostAlertWindow,from:number,to:number,value:number){let result;for(let at=from;at<=to;at+=30_000)result=sample(window,at,value)??result;return result;}
describe('resource alert windows (pure, injected clocks)',()=>{
 it('tracks warning and urgent dwell independently, without warning resetting the urgent streak',()=>{
  const w=new HostAlertWindow('cpu',rules.cpu);
  expect(cpu(w,0,4.5*minute,99)).toBeUndefined();expect(sample(w,5*minute,99)?.kind).toBe('opened');expect(w.snapshot()?.level).toBe('warning');
  cpu(w,5.5*minute,9.5*minute,99);expect(sample(w,10*minute,99)?.kind).toBe('escalated');expect(w.snapshot()?.level).toBe('urgent');
 });
 it('counts distinct filesystem samples, never cache publications of the same reading',()=>{
  const w=new HostAlertWindow('volume_1',rules.filesystem);expect(sample(w,0,96)).toBeNull();
  expect(sample(w,30_000,96,30_000,0)).toBeNull();expect(sample(w,minute,96)?.record.level).toBe('urgent');
 });
 it('backing-drive urgent is immediate, warning requires two samples; comparisons use raw bytes',()=>{
  const w=new HostAlertWindow('backing',rules['backing-drive']);expect(sample(w,0,60*GiB)).toBeNull();expect(sample(w,minute,60*GiB-1)).toBeNull();expect(sample(w,2*minute,60*GiB-1)?.record.level).toBe('warning');
  const urgent=new HostAlertWindow('backing',rules['backing-drive']);expect(sample(urgent,0,30*GiB-1)?.record.level).toBe('urgent');
 });
 it('memory uses critical for one minute and normal for two minutes',()=>{
  const w=new HostAlertWindow('memory',rules.memory);expect(sample(w,0,2)).toBeNull();expect(sample(w,30_000,2)).toBeNull();expect(sample(w,minute,2)?.record.level).toBe('urgent');
  cpu(w,1.5*minute,3*minute,0);expect(w.snapshot()).not.toBeNull();expect(sample(w,3.5*minute,0)?.kind).toBe('resolved');expect(w.snapshot()).toBeNull();
 });
 it('requires full recovery dwell, retains incidents through missing data and resets unproved recovery',()=>{
  const w=new HostAlertWindow('cpu',rules.cpu);cpu(w,0,5*minute,92);cpu(w,5.5*minute,9*minute,79);expect(w.snapshot()).not.toBeNull();sample(w,9.5*minute,null);cpu(w,10*minute,14.5*minute,79);expect(w.snapshot()).not.toBeNull();expect(sample(w,15*minute,79)?.kind).toBe('resolved');
 });
 it('CPU at exactly 80 does not clear, and long gaps do not count as continuous dwell',()=>{
  const w=new HostAlertWindow('cpu',rules.cpu);sample(w,0,99);expect(sample(w,6*minute,99)).toBeNull();cpu(w,6.5*minute,11*minute,99);expect(w.snapshot()?.level).toBe('warning');cpu(w,11.5*minute,20*minute,80);expect(w.snapshot()).not.toBeNull();
 });
 it('monotonic rollback restarts dwell; wall jumps never finish it early',()=>{
  const w=new HostAlertWindow('cpu',rules.cpu);sample(w,0,95,10**12,1);sample(w,30_000,95,2*10**12,2);expect(w.snapshot()).toBeNull();sample(w,100,95,2*10**12,3);expect(w.snapshot()).toBeNull();
 });
 it('restores delivery time but no dwell, so missing or one normal sample cannot clear a restarted incident',()=>{
  const first=new HostAlertWindow('cpu',rules.cpu);cpu(first,0,5*minute,95);const rev=first.snapshot()!.revision;expect(first.delivered(rev,100_000)).toBe(true);
  const w=new HostAlertWindow('cpu',rules.cpu,first.snapshot()!);expect(w.reminderDue(50_000)).toBe(false);expect(w.reminderDue(100_000+HOST_ALERT_WARNING_REPEAT_MS-1)).toBe(false);expect(w.reminderDue(100_000+HOST_ALERT_WARNING_REPEAT_MS)).toBe(true);
  sample(w,0,null);sample(w,30_000,0);expect(w.snapshot()).not.toBeNull();
 });
 it('ack remains visible, warning snooze is bounded and urgent escalation bypasses it',()=>{
  const w=new HostAlertWindow('cpu',rules.cpu);cpu(w,0,5*minute,99);w.acknowledge('admin_1',5*minute);w.snooze(5*minute,60*minute);expect(w.snapshot()?.acknowledgedBy).toBe('admin_1');expect(w.reminderDue(6*minute)).toBe(false);
  cpu(w,5.5*minute,10*minute,99);expect(w.snapshot()?.level).toBe('urgent');expect(w.reminderDue(10*minute)).toBe(true);expect(()=>w.snooze(10*minute,25*60*minute)).toThrow('invalid_alert_snooze');
 });
 it('only a successful current-revision receipt advances reminder time; stale delivery is refused',()=>{
  const w=new HostAlertWindow('backing',rules['backing-drive']);sample(w,0,50*GiB);sample(w,minute,50*GiB);const old=w.snapshot()!.revision;sample(w,2*minute,20*GiB);expect(w.delivered(old,2*minute)).toBe(false);expect(w.snapshot()?.lastSentAt).toBeUndefined();
  const current=w.snapshot()!.revision;expect(w.delivered(current,3*minute)).toBe(true);expect(w.delivered(current,minute)).toBe(false);expect(w.reminderDue(3*minute+HOST_ALERT_URGENT_REPEAT_MS-1)).toBe(false);expect(w.reminderDue(3*minute+HOST_ALERT_URGENT_REPEAT_MS)).toBe(true);
 });
 it.each([{warning:NaN},{urgent:80},{clear:95},{warningSamples:0},{intervalMs:1},{warningMs:Infinity},{other:true}])('rejects malformed/incorrectly ordered CPU rule %j',patch=>{expect(()=>validateHostAlertRule({...rules.cpu,...patch})).toThrow();});
 it('validates backing thresholds against a supplied cached volume capacity and rejects path keys',()=>{
  expect(()=>validateHostAlertRule({...rules['backing-drive']},64*GiB)).toThrow('invalid_alert_capacity');expect(()=>new HostAlertWindow('/private/path',rules.cpu)).toThrow('invalid_alert_key');
 });
 it('declines invalid metric values instead of treating them as healthy or urgent samples',()=>{
  const w=new HostAlertWindow('memory',rules.memory);sample(w,0,2);sample(w,30_000,9);expect(sample(w,minute,2)).toBeNull();expect(w.snapshot()).toBeNull();
  expect(()=>validateHostAlertRule({...rules.cpu,kind:'__proto__'}as any)).toThrow('invalid_alert_rule');
  expect(()=>validateHostAlertRule({...rules.memory,warning:0.5})).toThrow('invalid_alert_pressure');
 });
 it('de-escalation updates the same incident and acknowledges remain through missing data',()=>{
  const w=new HostAlertWindow('backing',rules['backing-drive']);sample(w,0,20*GiB);const opened=w.snapshot()!.openedAt;w.acknowledge('admin_1',0);
  expect(sample(w,minute,50*GiB)?.kind).toBe('deescalated');expect(sample(w,2*minute,50*GiB)).toBeNull();expect(w.snapshot()).toMatchObject({level:'warning',openedAt:opened,acknowledgedBy:'admin_1'});
  sample(w,3*minute,null);expect(w.snapshot()?.level).toBe('warning');
 });

 it('keeps monotonic dwell working when the source wall timestamp rolls backwards',()=>{
  const w=new HostAlertWindow('cpu',rules.cpu);let result;for(let at=0;at<=5*minute;at+=30_000)result=sample(w,at,95,900_000+at,at===0?1_000_000:900_000+at)??result;
  expect(result?.kind).toBe('opened');expect(w.snapshot()?.level).toBe('warning');
 });

});
