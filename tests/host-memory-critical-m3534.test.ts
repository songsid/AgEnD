import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,statSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {HOST_ALERT_DEFAULTS,HostAlertWindow,validateHostAlertRule,type HostAlertRule,type HostAlertRecord} from '../src/host-monitoring-alert-policy.js';
import {defaultHostAlertSettings,parseHostAlertSettings,readHostAlertSettings,writeHostAlertSettings,hostAlertSettingsPath,type HostAlertSettings} from '../src/host-monitoring-alert-settings.js';
import {HostMonitoringAlerts} from '../src/host-monitoring-alerts.js';import {emptyHostAlerts,type HostAlertDocument} from '../src/host-monitoring-alert-store.js';
import {prepareSettingsEffect} from '../src/settings-effect.js';
const minute=60000;
const memory=(criticalOnly:boolean):HostAlertRule=>({...HOST_ALERT_DEFAULTS.memory,criticalOnly} as HostAlertRule);
const settings=(criticalOnly:boolean):HostAlertSettings=>({...defaultHostAlertSettings(),general:true,rules:{memory:memory(criticalOnly)}});
function sample(w:HostAlertWindow,at:number,value:number|null){return w.observe({sampledAt:at,monotonicAt:at,wallAt:at,value});}
async function tick(){for(let i=0;i<50;i++)await Promise.resolve();}
const warning:HostAlertRecord={key:'memory',kind:'memory',level:'warning',revision:1,openedAt:1,updatedAt:1,value:1,threshold:1};
function document(record=warning):HostAlertDocument{const d=emptyHostAlerts();d.active=[structuredClone(record)];d.pending=[{key:record.key,revision:record.revision,transition:'opened',token:'a'.repeat(32),attempts:0,nextAttemptAt:0}];return d;}
function coordinator(initial=document()){
 let stored=structuredClone(initial),sequence=1;const now=1000000;
 const read=vi.fn(async()=>({ok:true,value:{sequence,document:structuredClone(stored)}}));
 const save=vi.fn(async(expected:number,next:HostAlertDocument)=>{expect(expected).toBe(sequence);stored=structuredClone(next);return{ok:true,value:{sequence:++sequence,document:structuredClone(stored)}};});
 let ack:((ok:boolean)=>void)|undefined;const deliver=vi.fn((_:unknown,callback:(ok:boolean)=>void)=>{ack=callback;return true;});
 const service=new HostMonitoringAlerts({persistence:{incidentRead:read,incidentSave:save},now:()=>now,monotonic:()=>now,deliver});
 return{service,read,save,deliver,stored:()=>structuredClone(stored),ack:(ok:boolean)=>ack!(ok)};
}
describe('memory critical-only rule',()=>{
 it('accepts only a boolean memory option, preserves fixed pressure thresholds and persists the sidecar',()=>{
  const dir=mkdtempSync(join(tmpdir(),'memory-critical-'));try{
   for(const value of [false,true]){const next=settings(value);expect(parseHostAlertSettings(next)).toEqual(next);writeHostAlertSettings(dir,next);expect(readHostAlertSettings(dir)).toEqual(next);expect(statSync(hostAlertSettingsPath(dir)).mode&0o777).toBe(0o600);}
   for(const value of ['true',1,null])expect(()=>validateHostAlertRule({...memory(true),criticalOnly:value}as any)).toThrow();
   expect(()=>validateHostAlertRule({...HOST_ALERT_DEFAULTS.cpu,criticalOnly:true}as any)).toThrow();
   expect(()=>validateHostAlertRule({...memory(true),warning:0.5})).toThrow('invalid_alert_pressure');
   const diff=prepareSettingsEffect('PUT','/api/settings/fleet/host-alerts',settings(true),{config:{instances:{}}as any,classic:{},hostAlertSettings:()=>settings(false)}).diff;
   expect(diff?.summary.join(' ')).toContain('critical only on');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it.each([undefined,false])('keeps the elevated warning default when the option is %s',option=>{
  const w=new HostAlertWindow('memory',option===undefined?HOST_ALERT_DEFAULTS.memory:memory(option));
  sample(w,0,1);for(let at=30000;at<2*minute;at+=30000)expect(sample(w,at,1)).toBeNull();expect(sample(w,2*minute,1)?.record.level).toBe('warning');
 });
 it('never warns at elevated, still opens urgent after a critical minute and recovers only after two normal minutes',()=>{
  const w=new HostAlertWindow('memory',memory(true));for(let at=0;at<=10*minute;at+=30000)expect(sample(w,at,1)).toBeNull();expect(w.snapshot()).toBeNull();
  sample(w,10.5*minute,2);expect(sample(w,11*minute,2)).toBeNull();expect(sample(w,11.5*minute,2)?.record.level).toBe('urgent');
  for(let at=12*minute;at<=15*minute;at+=30000)expect(sample(w,at,1)).toBeNull();expect(w.snapshot()?.level).toBe('urgent');
  sample(w,15.5*minute,0);sample(w,16*minute,0);sample(w,16.5*minute,null); // missing data resets recovery
  sample(w,17*minute,0);sample(w,17.5*minute,0);sample(w,18*minute,0);sample(w,18.5*minute,0);expect(w.snapshot()?.level).toBe('urgent');expect(sample(w,19*minute,0)?.kind).toBe('resolved');
 });
 it('retires and durably removes a restored warning and its queued message before any new sample or delivery',async()=>{
  const f=coordinator();f.service.configure(true,settings(true));f.service.ready();await tick();
  expect(f.service.snapshot().state).toBe('ready');expect(f.service.snapshot().active).toEqual([]);expect(f.stored().active).toEqual([]);expect(f.stored().pending).toEqual([]);expect(f.stored().resolved[0]).toMatchObject({key:'memory',level:'warning',revision:2,resolvedAt:1000000});expect(f.save).toHaveBeenCalledOnce();expect(f.deliver).not.toHaveBeenCalled();
 });
 it('turning the option on retires an existing warning and fences its old in-flight receipt',async()=>{
  const f=coordinator();f.service.configure(true,settings(false));f.service.ready();await tick();expect(f.deliver).toHaveBeenCalledOnce();
  f.service.configure(true,settings(true));await tick();expect(f.service.snapshot().active).toEqual([]);expect(f.stored().pending).toEqual([]);const retired=f.stored();f.ack(true);await tick();expect(f.stored()).toEqual(retired);expect(f.deliver).toHaveBeenCalledOnce();
 });
 it('does not retire an urgent memory incident or another resource warning',async()=>{
  const urgent={...warning,level:'urgent' as const,value:2,threshold:2},f=coordinator(document(urgent));f.service.configure(true,settings(true));f.service.ready();await tick();expect(f.service.snapshot().active[0]).toMatchObject(urgent);expect(f.save).not.toHaveBeenCalled();expect(f.deliver).toHaveBeenCalledOnce();
  const other=coordinator(document({...warning,key:'cpu',kind:'cpu',value:95,threshold:90}));other.service.configure(true,settings(true));other.service.ready();await tick();expect(other.service.snapshot().active).toHaveLength(1);expect(other.save).not.toHaveBeenCalled();
 });
 it('does no retirement I/O while off and fails visibly without delivery if retirement cannot persist',async()=>{
  const f=coordinator();f.service.configure(false,settings(true));f.service.ready();await tick();expect(f.read).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();
  f.save.mockResolvedValueOnce({ok:false}as any);f.service.configure(true,settings(true));await tick();expect(f.service.snapshot().state).toBe('failed');expect(f.deliver).not.toHaveBeenCalled();expect(f.stored().active).toHaveLength(1);
 });
 it('keeps retirement history bounded and drops an outbox entry pruned by that bound',async()=>{
  const initial=document();initial.resolved=Array.from({length:500},(_,i)=>({...warning,key:'cpu',kind:'cpu' as const,revision:i+1,resolvedAt:2}));initial.pending.push({key:'cpu',revision:1,transition:'resolved',token:'b'.repeat(32),attempts:0,nextAttemptAt:0});
  const f=coordinator(initial);f.service.configure(true,settings(true));f.service.ready();await tick();expect(f.service.snapshot().state).toBe('ready');expect(f.stored().resolved).toHaveLength(500);expect(f.stored().resolved.at(-1)).toMatchObject({key:'memory',revision:2});expect(f.stored().pending).toEqual([]);expect(f.deliver).not.toHaveBeenCalled();
 });

});
