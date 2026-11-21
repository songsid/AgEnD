import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,statSync,readFileSync,writeFileSync,openSync,writeSync,closeSync,symlinkSync,linkSync,readdirSync,chmodSync,ftruncateSync}from'node:fs';
import {createHash}from'node:crypto';
import {join}from'node:path';import {tmpdir}from'node:os';
import {HostAlertReserve,emptyHostAlerts,validateHostAlertDocument,type HostAlertDocument}from'../src/host-monitoring-alert-store.js';
import {cleanupHistory,historyFiles}from'../src/host-monitoring-history-files.js';
import {historyBudget}from'../src/host-monitoring-history-policy.js';
const roots:string[]=[],stores:HostAlertReserve[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(options:ConstructorParameters<typeof HostAlertReserve>[1]={}){const root=mkdtempSync(join(tmpdir(),'host-alerts-'));roots.push(root);const path=join(root,'host-monitoring.sqlite');const s=new HostAlertReserve(path,options);stores.push(s);return {root,path,s};}
const document=():HostAlertDocument=>({version:1,active:[{key:'cpu',kind:'cpu',level:'warning',revision:1,openedAt:1,updatedAt:2,value:95,threshold:90}],resolved:[],pending:[]});
describe('bounded physically reserved incident banks',()=>{
 it('allocates nothing on construction, physically preallocates exactly the shared reserved budget only on open',()=>{
  const f=fixture();expect(readdirSync(f.root)).toEqual([]);expect(f.s.open().document).toEqual(emptyHostAlerts());
  let allocated=0;for(const path of f.s.files){const st=statSync(path);expect(st.size).toBe(f.s.bankBytes);expect(st.mode&0o777).toBe(0o600);allocated+=st.blocks*512;}
  expect(f.s.bankBytes*2).toBe(historyBudget().reserveBytes);expect(allocated).toBeGreaterThanOrEqual(f.s.bankBytes*2);expect(readdirSync(f.root).sort()).toEqual(['host-monitoring.sqlite.incidents','host-monitoring.sqlite.incidents.tmp']);
 });
 it('persists bounded records and recovers the greatest checksum-valid bank without changing file sizes',()=>{
  const f=fixture(),first=f.s.open(),next=f.s.commit(first.sequence,document());expect(next.sequence).toBe(2);next.document.active[0].value=0;expect(f.s.snapshot().document.active[0].value).toBe(95);f.s.close();
  expect(f.s.open()).toEqual({sequence:2,document:document()});for(const path of f.s.files)expect(statSync(path).size).toBe(f.s.bankBytes);
 });
 it('a torn inactive payload cannot commit its header; reopen recovers the previous durable bank',()=>{
  let tear=false;const f=fixture({beforeHeader:()=>{if(tear)throw Error('injected interruption')}});const first=f.s.open();f.s.commit(first.sequence,document());tear=true;const changed=document();changed.active[0].value=99;
  expect(()=>f.s.commit(2,changed)).toThrow('injected interruption');expect(()=>f.s.commit(2,changed)).toThrow('incident_store_unavailable');f.s.close();tear=false;expect(f.s.open()).toEqual({sequence:2,document:document()});
 });
 it('checksum failure falls back to the other bank; two invalid banks fail visibly rather than silently losing incidents',()=>{
  const f=fixture();f.s.open();f.s.commit(1,document());f.s.close();const corrupt=(path:string)=>{const fd=openSync(path,'r+');try{const bytes=readFileSync(path),at=bytes.indexOf(Buffer.from('\"value\":95'),4096);writeSync(fd,Buffer.from(at>=0?'8':'x'),0,1,at>=0?at+8:4096);}finally{closeSync(fd);}};
  corrupt(f.s.files[1]);expect(f.s.open().sequence).toBe(1);f.s.close();corrupt(f.s.files[0]);expect(()=>f.s.open()).toThrow('incident_store_corrupt');
 });
 it('rejects stale sequence, invalid state and oversized bounded payload without altering either bank',()=>{
  const f=fixture({reserveBytes:128*1024});f.s.open();const before=f.s.files.map(p=>readFileSync(p));expect(()=>f.s.commit(0,document())).toThrow('incident_store_conflict');expect(()=>f.s.commit(1,{...document(),extra:true}as any)).toThrow('invalid_incident_document');
  const full=emptyHostAlerts();for(let i=0;i<500;i++)full.resolved.push({...document().active[0],key:'x'.repeat(120)+i,resolvedAt:3,acknowledgedBy:'a'.repeat(128),acknowledgedAt:2});expect(()=>f.s.commit(1,full)).toThrow('incident_store_full');expect(f.s.files.map(p=>readFileSync(p))).toEqual(before);
 });
 it.each(['symlink','hardlink']as const)('refuses an unsafe existing %s and leaves its target intact',kind=>{
  const f=fixture(),other=join(f.root,'other');writeFileSync(other,'unchanged',{mode:0o600});if(kind==='symlink')symlinkSync(other,f.s.files[0]);else linkSync(other,f.s.files[0]);expect(()=>f.s.open()).toThrow();expect(readFileSync(other,'utf8')).toBe('unchanged');
 });
 it('never silently initializes half-created or wrong-permission state',()=>{
  const f=fixture();writeFileSync(f.s.files[0],Buffer.alloc(f.s.bankBytes),{mode:0o600});expect(()=>f.s.open()).toThrow('incomplete_incident_banks');expect(readdirSync(f.root)).toEqual(['host-monitoring.sqlite.incidents']);
 });
 it('enforces active/resolved/outbox caps, one pending per resource and revision-bound delivery',()=>{
  const d=document();d.active=Array.from({length:65},(_,i)=>({...d.active[0],key:'key'+i}));expect(()=>validateHostAlertDocument(d)).toThrow();
  const p=document();p.pending=[{key:'cpu',revision:2,transition:'opened',token:'a'.repeat(32),attempts:0,nextAttemptAt:1}];expect(()=>validateHostAlertDocument(p)).toThrow('unbound_incident_pending');p.pending[0].revision=1;p.pending.push({...p.pending[0]});expect(()=>validateHostAlertDocument(p)).toThrow('invalid_incident_pending');
 });
 it('rejects existing public permissions without changing the original file',()=>{
  const f=fixture();f.s.open();f.s.close();chmodSync(f.s.files[0],0o644);expect(()=>f.s.open()).toThrow('unsafe_incident_file');expect(statSync(f.s.files[0]).mode&0o777).toBe(0o644);
 });
 it('keeps resolved history and pending documents strictly bounded and telemetry-only',()=>{
  const d=emptyHostAlerts();d.resolved=Array.from({length:501},()=>({...document().active[0],resolvedAt:3}));expect(()=>validateHostAlertDocument(d)).toThrow('invalid_incident_document');
  const invalid=document();(invalid.active[0]as any).commandline='hidden';expect(()=>validateHostAlertDocument(invalid)).toThrow('invalid_incident_document');
 });

 it('persists an actual revision-bound pending receipt and its acknowledged incident',()=>{
  const f=fixture();f.s.open();const d=document();d.active[0].acknowledgedAt=2;d.active[0].acknowledgedBy='admin_1';
  d.pending=[{key:'cpu',revision:1,transition:'opened',token:'a'.repeat(32),attempts:1,nextAttemptAt:20}];
  f.s.commit(1,d);f.s.close();expect(f.s.open().document).toEqual(d);
 });
 it('existing Off cleanup removes only its known incident banks and preserves the drive sidecar',async()=>{
  const f=fixture();f.s.open();const pref=join(f.root,'host-monitoring-settings.json');writeFileSync(pref,'{"version":1,"wsl_drive":"D"}');
  expect(f.s.files.every(path=>historyFiles(f.path).includes(path))).toBe(true);f.s.close();await cleanupHistory(f.path);
  expect(readdirSync(f.root)).toEqual(['host-monitoring-settings.json']);
 });

 it('binds sequence metadata to the payload digest before ranking recovery banks',()=>{
  const f=fixture();f.s.open();f.s.commit(1,document());f.s.close();const bytes=readFileSync(f.s.files[1]),header=JSON.parse(bytes.subarray(0,bytes.indexOf(0)).toString());header.sequence=900;
  const replacement=Buffer.alloc(4096);replacement.write(JSON.stringify(header));const fd=openSync(f.s.files[1],'r+');try{writeSync(fd,replacement,0,replacement.length,0);}finally{closeSync(fd);}
  expect(f.s.open().sequence).toBe(1);
 });

 it('refuses sparse incident arrays rather than committing a JSON null that cannot be restored',()=>{
  const d=emptyHostAlerts();d.active=new Array(1);expect(()=>validateHostAlertDocument(d)).toThrow('invalid_incident_document');
 });

 it('refuses checksum-valid existing banks whose tails became sparse, without repairing incident state',()=>{
  const f=fixture({reserveBytes:128*1024});f.s.open();f.s.commit(1,document());f.s.close();
  for(const path of f.s.files){
   const bytes=readFileSync(path),h=JSON.parse(bytes.subarray(0,bytes.indexOf(0)).toString()),payload=bytes.subarray(4096,4096+h.length);
   expect(createHash('sha256').update(String(h.sequence)+':').update(payload).digest('hex')).toBe(h.sha256);
   const fd=openSync(path,'r+');try{ftruncateSync(fd,4096+h.length);ftruncateSync(fd,f.s.bankBytes);}finally{closeSync(fd);}
   expect(statSync(path).size).toBe(f.s.bankBytes);expect(statSync(path).blocks*512).toBeLessThan(f.s.bankBytes);
   expect(readFileSync(path).subarray(0,4096+h.length)).toEqual(bytes.subarray(0,4096+h.length));
  }
  const sparse=f.s.files.map(path=>readFileSync(path));expect(()=>f.s.open()).toThrow('incident_reservation_unconfirmed');
  expect(f.s.files.map(path=>readFileSync(path))).toEqual(sparse);
 });
 it('accepts fully allocated existing banks at the same bounded budget without changing their data',()=>{
  const f=fixture({reserveBytes:128*1024});f.s.open();f.s.commit(1,document());f.s.close();const bytes=f.s.files.map(path=>readFileSync(path));
  expect(f.s.open()).toEqual({sequence:2,document:document()});for(const path of f.s.files)expect(statSync(path).blocks*512).toBeGreaterThanOrEqual(f.s.bankBytes);expect(f.s.files.map(path=>readFileSync(path))).toEqual(bytes);
 });

});
