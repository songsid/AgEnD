/** Bounded incident banks, owned by the history worker in the later integration slice. No import-time I/O. */
import { openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, unlinkSync, constants } from 'node:fs';
import { createHash, randomFillSync } from 'node:crypto';
import { dirname } from 'node:path';
import { hostAlertKey, type HostAlertRecord, type HostAlertKind } from './host-monitoring-alert-policy.js';

export const HOST_ALERT_RESERVE_BYTES = 4 * 1024 ** 2;
const HEADER_BYTES = 4096, MAX_ACTIVE = 64, MAX_RESOLVED = 500;
export interface HostAlertPending {
  key: string; revision: number; transition: 'opened' | 'escalated' | 'reminder' | 'resolved';
  token: string; attempts: number; nextAttemptAt: number;
}
export interface HostAlertDocument { version: 1; active: HostAlertRecord[]; resolved: HostAlertRecord[]; pending: HostAlertPending[] }
export const emptyHostAlerts = (): HostAlertDocument => ({version:1,active:[],resolved:[],pending:[]});
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key=>allowed.includes(key));
const kinds: HostAlertKind[] = ['cpu','memory','filesystem','backing-drive','inodes'];
const recordKeys = ['key','kind','level','revision','openedAt','updatedAt','value','threshold','lastSentAt','acknowledgedAt','acknowledgedBy','snoozedUntil','snoozedLevel','resolvedAt'];
function record(value: unknown, resolved: boolean): value is HostAlertRecord {
  if (!object(value) || !keys(value,recordKeys) || !hostAlertKey(value.key) || !kinds.includes(value.kind as HostAlertKind)
    || !['warning','urgent'].includes(value.level as string) || !integer(value.revision) || value.revision<1
    || ![value.openedAt,value.updatedAt,value.value,value.threshold].every(finite)) return false;
  if (value.kind === 'backing-drive' && (![value.value,value.threshold].every(integer))) return false;
  if (value.kind !== 'backing-drive' && ((value.value as number)>100 || (value.threshold as number)>100)) return false;
  if (value.kind === 'memory' && (![0,1,2].includes(value.value as number) || ![1,2].includes(value.threshold as number))) return false;
  for (const key of ['lastSentAt','acknowledgedAt','snoozedUntil','resolvedAt']) if (value[key] !== undefined && !finite(value[key])) return false;
  if ((value.resolvedAt !== undefined) !== resolved) return false;
  if ((value.acknowledgedAt !== undefined) !== (value.acknowledgedBy !== undefined) || (value.acknowledgedBy !== undefined && !hostAlertKey(value.acknowledgedBy))) return false;
  if ((value.snoozedUntil !== undefined) !== (value.snoozedLevel !== undefined) || (value.snoozedLevel !== undefined && !['warning','urgent'].includes(value.snoozedLevel as string))) return false;
  return true;
}
export function validateHostAlertDocument(value: unknown): asserts value is HostAlertDocument {
  if (!object(value) || !keys(value,['version','active','resolved','pending']) || value.version!==1
    || !Array.isArray(value.active) || value.active.length>MAX_ACTIVE || !Array.from(value.active).every(item=>record(item,false))
    || !Array.isArray(value.resolved) || value.resolved.length>MAX_RESOLVED || !Array.from(value.resolved).every(item=>record(item,true))
    || !Array.isArray(value.pending) || value.pending.length>MAX_ACTIVE) throw Error('invalid_incident_document');
  if (new Set(value.active.map(item=>item.key)).size!==value.active.length) throw Error('duplicate_incident');
  const pendingKeys=new Set<string>();
  for (const p of value.pending) {
    if (!object(p) || !keys(p,['key','revision','transition','token','attempts','nextAttemptAt']) || !hostAlertKey(p.key)
      || !integer(p.revision) || p.revision<1 || !['opened','escalated','reminder','resolved'].includes(p.transition as string)
      || typeof p.token!=='string' || !/^[a-f0-9]{32}$/.test(p.token) || !integer(p.attempts) || p.attempts>100 || !finite(p.nextAttemptAt)
      || pendingKeys.has(p.key)) throw Error('invalid_incident_pending');
    const source=p.transition==='resolved'?value.resolved:value.active;
    if (!source.some(item=>item.key===p.key && item.revision===p.revision)) throw Error('unbound_incident_pending');
    pendingKeys.add(p.key);
  }
}
interface Bank { index: number; sequence: number; document: HostAlertDocument }
interface Options { reserveBytes?: number; beforeHeader?(): void }
/** Explicit open only; callers serialize access and stop the owning worker before deleting either fixed bank. */
export class HostAlertReserve {
  readonly files: readonly string[];
  readonly bankBytes: number;
  private fds: number[] = [];
  private current: Bank | null = null;
  private failed = false;
  constructor(historyPath: string, private readonly options: Options = {}) {
    const total=options.reserveBytes??HOST_ALERT_RESERVE_BYTES;
    if (!Number.isSafeInteger(total) || total<128*1024 || total>HOST_ALERT_RESERVE_BYTES || total%(2*HEADER_BYTES)!==0) throw Error('invalid_incident_budget');
    this.bankBytes=total/2; this.files=[historyPath+'.incidents',historyPath+'.incidents.tmp'];
  }
  private write(fd: number, bytes: Buffer, offset: number): void {
    let done=0;
    while(done<bytes.length){const n=writeSync(fd,bytes,done,bytes.length-done,offset+done);if(n<=0)throw Error('incident_short_write');done+=n;}
  }
  private read(fd: number, size: number, offset: number): Buffer {
    const bytes=Buffer.alloc(size);let done=0;
    while(done<size){const n=readSync(fd,bytes,done,size-done,offset+done);if(!n)throw Error('incident_short_read');done+=n;}
    return bytes;
  }
  private load(index: number): Bank | null {
    try {
      const header=this.read(this.fds[index],HEADER_BYTES,0),end=header.indexOf(0);
      if (end<1) return null;
      const h=JSON.parse(header.subarray(0,end).toString('utf8'));
      if (!object(h) || !keys(h,['format','version','sequence','length','sha256']) || h.format!=='agend-host-incidents' || h.version!==1
        || !integer(h.sequence) || h.sequence<1 || !integer(h.length) || h.length<1 || h.length>this.bankBytes-HEADER_BYTES
        || typeof h.sha256!=='string' || !/^[a-f0-9]{64}$/.test(h.sha256)) return null;
      const bytes=this.read(this.fds[index],h.length,HEADER_BYTES);
      if (createHash('sha256').update(String(h.sequence)+':').update(bytes).digest('hex')!==h.sha256) return null;
      const document: unknown=JSON.parse(bytes.toString('utf8')); validateHostAlertDocument(document);
      return {index,sequence:h.sequence,document};
    } catch { return null; }
  }
  open(): { sequence: number; document: HostAlertDocument } {
    if(this.fds.length)throw Error('incident_store_already_open');
    const created: string[]=[];
    try {
      // Existing banks are never truncated or replaced; half-created state is a visible failure, not empty history.
      let fresh=true;
      for(const path of this.files){
        let fd:number;
        try {fd=openSync(path,constants.O_RDWR|constants.O_NOFOLLOW);fresh=false;}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created.push(path);}
        this.fds.push(fd);
        const info=fstatSync(fd);
        if(!info.isFile() || info.nlink!==1 || (info.mode&0o777)!==0o600 || (typeof process.getuid==='function' && info.uid!==process.getuid()))throw Error('unsafe_incident_file');
        if(created.includes(path)){
          // Non-compressible allocation avoids sparse/truncate/zero-block optimism on compressed filesystems.
          const allocation=Buffer.alloc(64*1024);
          for(let at=0;at<this.bankBytes;at+=allocation.length){randomFillSync(allocation);this.write(fd,allocation.subarray(0,Math.min(allocation.length,this.bankBytes-at)),at);}
          this.write(fd,Buffer.alloc(HEADER_BYTES),0);
          fsyncSync(fd);
          const allocated=fstatSync(fd);
          if(!Number.isFinite(allocated.blocks) || allocated.blocks*512<this.bankBytes)throw Error('incident_reservation_unconfirmed');
        } else if(info.size!==this.bankBytes)throw Error('invalid_incident_file_size');
      }
      if(created.length && !fresh)throw Error('incomplete_incident_banks');
      this.failed=false;
      if(fresh){
        this.current={index:1,sequence:0,document:emptyHostAlerts()};
        const initial=this.commit(0,emptyHostAlerts());
        const directory=openSync(dirname(this.files[0]),constants.O_RDONLY|constants.O_NOFOLLOW);
        try{fsyncSync(directory);}finally{closeSync(directory);}
        return initial;
      }
      const banks=[this.load(0),this.load(1)].filter((b):b is Bank=>b!==null).sort((a,b)=>b.sequence-a.sequence);
      if(!banks.length || (banks.length===2 && banks[0].sequence===banks[1].sequence))throw Error('incident_store_corrupt');
      this.current=banks[0]; return this.snapshot();
    } catch(error){this.close();for(const path of created)try{unlinkSync(path);}catch{/* Only this open's newly-created files. */}throw error;}
  }
  snapshot(): { sequence: number; document: HostAlertDocument } {
    if(!this.current || this.failed)throw Error('incident_store_unavailable');
    return {sequence:this.current.sequence,document:structuredClone(this.current.document)};
  }
  commit(expectedSequence: number, document: HostAlertDocument): { sequence: number; document: HostAlertDocument } {
    if(!this.current || this.failed || this.fds.length!==2)throw Error('incident_store_unavailable');
    if(expectedSequence!==this.current.sequence || expectedSequence>=Number.MAX_SAFE_INTEGER)throw Error('incident_store_conflict');
    validateHostAlertDocument(document);
    const payload=Buffer.from(JSON.stringify(document));
    if(payload.length>this.bankBytes-HEADER_BYTES)throw Error('incident_store_full');
    const sequence=expectedSequence+1,index=1-this.current.index;
    const json=Buffer.from(JSON.stringify({format:'agend-host-incidents',version:1,sequence,length:payload.length,sha256:createHash('sha256').update(String(sequence)+':').update(payload).digest('hex')}));
    const header=Buffer.alloc(HEADER_BYTES);json.copy(header);
    try {
      this.write(this.fds[index],payload,HEADER_BYTES);fsyncSync(this.fds[index]);
      this.options.beforeHeader?.();
      this.write(this.fds[index],header,0);fsyncSync(this.fds[index]);
      this.current={index,sequence,document:structuredClone(document)};return this.snapshot();
    }catch(error){this.failed=true;throw error;}
  }
  close(): void { for(const fd of this.fds)try{closeSync(fd);}catch{/* close all owned handles */}this.fds=[];this.current=null; }
}
