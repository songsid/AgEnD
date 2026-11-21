/** Owner-fenced cache and delivery coordinator. All incident I/O belongs to the existing worker. */
import {randomBytes} from 'node:crypto';
import {HostAlertWindow,validateHostAlertRule,type HostAlertRecord,type HostAlertTransition} from './host-monitoring-alert-policy.js';
import {emptyHostAlerts,validateHostAlertDocument,type HostAlertDocument,type HostAlertPending} from './host-monitoring-alert-store.js';
import {defaultHostAlertSettings,parseHostAlertSettings,hostAlertRuleFor,type HostAlertSettings} from './host-monitoring-alert-settings.js';
import {hostAlertResources} from './host-monitoring-alert-resources.js';
import type {HostHealthSnapshot} from './host-monitoring.js';
type Answer={ok:boolean;value?:{sequence:number;document:HostAlertDocument};reason?:string};
interface Options {
 persistence:{incidentRead():Promise<Answer>;incidentSave(sequence:number,document:HostAlertDocument):Promise<Answer>};
 now?:()=>number;monotonic?:()=>number;token?:()=>string;
 deliver(records:Array<{transition:HostAlertPending['transition'];record:HostAlertRecord}>,ack:(delivered:boolean)=>void):boolean;
 changed?():void;
}
export interface HostAlertsSnapshot {state:'off'|'starting'|'ready'|'failed';reason?:string;needsYou:boolean;general:boolean;active:HostAlertRecord[];resolved:HostAlertRecord[];pending:number}
/** Queue bounds: one running operation, at most four explicit edits, one latest sample, one delivery receipt. */
export class HostMonitoringAlerts {
 private enabled=false;private workerReady=false;private epoch=0;private loaded=false;private failure:string|undefined;
 private settings=defaultHostAlertSettings();private sequence=0;private document=emptyHostAlerts();private windows=new Map<string,HostAlertWindow>();
 private busy=false;private edits:Array<{run:()=>Promise<void>;resolve:(ok:boolean)=>void}>=[];private latest:HostHealthSnapshot|null=null;
 private receipt:{flight:Flight;delivered:boolean}|null=null;private flight:Flight|null=null;
 private now:()=>number;private monotonic:()=>number;
 constructor(private readonly options:Options){this.now=options.now??Date.now;this.monotonic=options.monotonic??(()=>performance.now());}
 configure(enabled:boolean,settings:HostAlertSettings=this.settings):void {
  const next=parseHostAlertSettings(settings),changed=JSON.stringify(next)!==JSON.stringify(this.settings);this.settings=next;
  if(enabled===this.enabled&&!changed)return;
  this.enabled=enabled;if(!enabled)this.workerReady=false;this.epoch++;this.loaded=false;this.failure=undefined;this.document=emptyHostAlerts();this.windows.clear();this.latest=null;this.receipt=null;
  for(const edit of this.edits.splice(0))edit.resolve(false);this.publish();if(enabled&&this.workerReady)this.ready();
 }
 unavailable(reason='incident_settings_invalid'):void {if(this.enabled)this.fail(reason);}
 stop():void {this.workerReady=false;this.configure(false);}
 /** Called after the persistence worker is ready. No retries or extra timers while off. */
 ready():void {
  this.workerReady=true;if(!this.enabled||this.loaded||this.busy||this.failure)return;
  const epoch=this.epoch;this.busy=true;
  void this.options.persistence.incidentRead().then(answer=>{
   if(!this.current(epoch))return;
   if(!answer.ok||!answer.value)throw Error('incident_load_failed');validateHostAlertDocument(answer.value.document);
   this.sequence=answer.value.sequence;this.document=answer.value.document;
   for(const record of this.document.active)this.windows.set(record.key,new HostAlertWindow(record.key,hostAlertRuleFor(this.settings,record.key,record.kind),record));
   this.loaded=true;this.publish();
  }).catch(()=>{if(this.current(epoch))this.fail('incident_load_failed');}).finally(()=>{this.busy=false;this.drain();});
 }
 snapshot():HostAlertsSnapshot {return {state:!this.enabled?'off':this.failure?'failed':this.loaded?'ready':'starting',...(this.failure?{reason:this.failure}:{}),needsYou:this.settings.needsYou,general:this.settings.general,active:this.document.active.map(record=>{const live=this.windows.get(record.key)?.snapshot();return live?.revision===record.revision?{...structuredClone(record),value:live.value,updatedAt:live.updatedAt}:structuredClone(record);}),resolved:structuredClone(this.document.resolved.slice(-50)),pending:this.document.pending.length};}
 ingest(snapshot:HostHealthSnapshot):void {if(!this.enabled||this.failure||!snapshot.enabled)return;this.latest=structuredClone(snapshot);this.drain();}
 act(key:string,revision:number,actor:string,snoozeMs?:number):Promise<boolean> {
  if(!this.enabled||!this.loaded||this.failure||this.edits.length>=4||!this.windows.has(key)||this.windows.get(key)!.snapshot()?.revision!==revision)return Promise.resolve(false);
  if(!/^[a-zA-Z0-9:_-]{1,128}$/.test(actor)||(snoozeMs!==undefined&&(!Number.isSafeInteger(snoozeMs)||snoozeMs<60000||snoozeMs>86400000)))return Promise.resolve(false);
  return new Promise(resolve=>{this.edits.push({resolve,run:async()=>{
   const window=this.windows.get(key),record=window?.snapshot();if(!window||!record||record.revision!==revision)throw Error('stale_incident');
   if(snoozeMs===undefined)window.acknowledge(actor,this.now());else window.snooze(this.now(),snoozeMs);
   const document=structuredClone(this.document);document.active=document.active.map(r=>r.key===key?window.snapshot()!:r);await this.save(document,this.epoch);
  }});this.drain();});
 }
 private current(epoch:number){return this.enabled&&this.epoch===epoch;}
 private publish(){try{this.options.changed?.();}catch{/* Notification consumers cannot disrupt collection. */}}
 private fail(reason:string){this.failure=reason;this.latest=null;for(const edit of this.edits.splice(0))edit.resolve(false);this.publish();}
 private async save(document:HostAlertDocument,epoch:number):Promise<void>{
  validateHostAlertDocument(document);const answer=await this.options.persistence.incidentSave(this.sequence,document);
  if(!this.current(epoch))throw Error('incident_epoch_changed');
  if(!answer.ok||!answer.value)throw Error('incident_save_failed');validateHostAlertDocument(answer.value.document);
  this.sequence=answer.value.sequence;this.document=answer.value.document;this.publish();
 }
 private drain():void {
  if(this.busy||!this.enabled||this.failure)return;if(!this.loaded){if(this.workerReady)this.ready();return;}
  const epoch=this.epoch,receipt=this.receipt,edit=receipt?undefined:this.edits.shift(),sample=receipt||edit?null:this.latest;
  if(receipt)this.receipt=null;else if(sample)this.latest=null;
  if(!receipt&&!edit&&!sample){this.dispatch();return;}
  this.busy=true;
  void (receipt?this.received(receipt):edit?edit.run():this.observe(sample!,epoch)).then(()=>edit?.resolve(true),error=>{edit?.resolve(false);if(this.current(epoch)&&(error as Error)?.message!=='stale_incident')this.fail('incident_save_failed');}).finally(()=>{this.busy=false;this.drain();});
 }
 private pending(record:HostAlertRecord,transition:HostAlertPending['transition']):HostAlertPending {
  return {key:record.key,revision:record.revision,transition,token:(this.options.token??(()=>randomBytes(16).toString('hex')))(),attempts:0,nextAttemptAt:this.now()};
 }
 private async observe(snapshot:HostHealthSnapshot,epoch:number):Promise<void>{
  const document=structuredClone(this.document),now=this.now(),mono=this.monotonic(),seen=new Set<string>();let changed=false;
  for(const resource of hostAlertResources(snapshot,now)){
   seen.add(resource.key);let window=this.windows.get(resource.key);
   if(!window){if(this.windows.size>=64)throw Error('incident_capacity');const rule=hostAlertRuleFor(this.settings,resource.key,resource.kind);if(rule.kind!==resource.kind)throw Error('invalid_alert_resource');validateHostAlertRule(rule,this.settings.rules[resource.key]?resource.capacity:undefined);window=new HostAlertWindow(resource.key,rule,undefined,Math.max(0,...document.resolved.filter(r=>r.key===resource.key).map(r=>r.revision)));this.windows.set(resource.key,window);}
   const transition=window.observe({sampledAt:resource.sampledAt,monotonicAt:mono,wallAt:now,value:resource.value});
   if(transition){this.transition(document,transition);changed=true;}
   const record=window.snapshot();
   if(record&&this.settings.general&&window.reminderDue(now)&&!document.pending.some(p=>p.key===record.key)){
    if(document.pending.length>=64)throw Error('incident_capacity');document.pending.push(this.pending(record,'reminder'));changed=true;
   }
  }
  for(const [key,window] of this.windows)if(!seen.has(key))window.observe({sampledAt:now,monotonicAt:mono,wallAt:now,value:null});
  const cutoff=now-30*24*60*60_000;const retained=document.resolved.filter(r=>(r.resolvedAt??now)>=cutoff).slice(-500);
  const pendingResolved=new Set(document.pending.filter(p=>p.transition==='resolved').map(p=>p.token));
  // Retention must not leave an outbox entry whose record was pruned.
  document.pending=document.pending.filter(p=>p.transition!=='resolved'||retained.some(r=>r.key===p.key&&r.revision===p.revision));
  if(retained.length!==document.resolved.length||pendingResolved.size!==document.pending.filter(p=>p.transition==='resolved').length)changed=true;
  document.resolved=retained;
  if(changed)await this.save(document,epoch);else this.publish();
 }
 private transition(document:HostAlertDocument,transition:HostAlertTransition):void {
  const {record,kind}=transition;document.active=document.active.filter(r=>r.key!==record.key);document.pending=document.pending.filter(p=>p.key!==record.key);
  if(kind==='resolved')document.resolved.push(record);else document.active.push(record);
  if(this.settings.general&&kind!=='deescalated'){
   if(document.pending.length>=64)throw Error('incident_capacity');document.pending.push(this.pending(record,kind));
  }
 }
 private dispatch():void {
  if(this.flight||!this.settings.general||!this.loaded||!this.enabled||this.failure)return;
  const now=this.now(),entries=this.document.pending.filter(p=>p.nextAttemptAt<=now&&this.sendable(p,now));if(!entries.length)return;
  const flight:Flight={epoch:this.epoch,entries:structuredClone(entries)};this.flight=flight;let answered=false;
  const ack=(delivered:boolean)=>{if(answered)return;answered=true;if(this.flight!==flight)return;this.flight=null;if(this.current(flight.epoch)){this.receipt={flight,delivered};this.drain();}else this.drain();};
  const records=entries.map(p=>({transition:p.transition,record:structuredClone((p.transition==='resolved'?this.document.resolved:this.document.active).find(r=>r.key===p.key&&r.revision===p.revision)!)}));
  try{if(!this.options.deliver(records,ack))ack(false);}catch{ack(false);}
 }
 private sendable(p:HostAlertPending,now:number):boolean{
  const record=(p.transition==='resolved'?this.document.resolved:this.document.active).find(r=>r.key===p.key&&r.revision===p.revision);
  return !!record&&(p.transition==='resolved'||record.snoozedUntil===undefined||now>=record.snoozedUntil||(record.level==='urgent'&&record.snoozedLevel==='warning'));
 }
 private async received({flight,delivered}:{flight:Flight;delivered:boolean}):Promise<void>{
  if(!this.current(flight.epoch))return;const document=structuredClone(this.document);let changed=false;
  for(const entry of flight.entries){const p=document.pending.find(p=>p.token===entry.token&&p.revision===entry.revision);if(!p)continue;changed=true;
   if(delivered){document.pending=document.pending.filter(q=>q.token!==p.token);const records=p.transition==='resolved'?document.resolved:document.active;const record=records.find(r=>r.key===p.key&&r.revision===p.revision);if(record){record.lastSentAt=this.now();this.windows.get(p.key)?.delivered(p.revision,this.now());}}
   else{p.attempts=Math.min(100,p.attempts+1);p.nextAttemptAt=this.now()+Math.min(60*60_000,30_000*2**Math.min(7,p.attempts-1));}
  }
  if(changed)await this.save(document,flight.epoch);
 }
}
interface Flight {epoch:number;entries:HostAlertPending[]}
