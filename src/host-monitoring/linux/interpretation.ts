import type {cpus} from 'node:os';
import type {MemoryPressureSnapshot} from '../../memory-pressure.js';
import type {CpuReading,MemoryReading,Reading} from '../../host-monitoring.js';
import {MONITOR_OUTPUT_BYTES,MONITOR_MOUNT_BYTES} from '../transport.js';
import {isAbsolute} from 'node:path';
export interface MonitorMount { id: string; path: string; type: string; local: boolean; drive?: string }
const unescapeMount = (s: string) => s.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const NETWORK = new Set(['nfs','nfs4','cifs','smbfs','sshfs','fuse.sshfs','afs','9p']);
export function parseMonitorMounts(text: string | null): MonitorMount[] {
  if (!text || Buffer.byteLength(text) > MONITOR_MOUNT_BYTES) return [];
  const rows=text.trim().split('\n');if(rows.length>512)return [];
  const mounts: MonitorMount[] = [];
  for (const row of rows) {
    const halves = row.split(' - '), left = halves[0]?.split(' '), right = halves[1]?.split(' ');
    if (halves.length !== 2 || left.length < 6 || !right || right.length < 3) continue;
    const path = unescapeMount(left[4]), source = unescapeMount(right[1]), type = right[0];
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) continue;
    const local = !NETWORK.has(type) && !type.startsWith('fuse.');
    mounts.push({ id:left[2], path, type, local });
  }
  return mounts;
}
export function monitorMountFor(mounts: MonitorMount[], path: string): MonitorMount | null {
  return mounts.filter(m => path === m.path || path.startsWith(m.path === '/' ? '/' : m.path + '/')).sort((a,b) => b.path.length - a.path.length)[0] ?? null;
}
export function parseMonitorDf(text: string | null): { totalBytes: number; availableBytes: number; usedPercent: number } | null {
  if (!text || Buffer.byteLength(text) > MONITOR_OUTPUT_BYTES) return null;
  const rows = text.trim().split(/\r?\n/);
  if (rows.length !== 2 || !/^Filesystem\s/.test(rows[0])) return null;
  const match = /^.+?\s+(\d+)\s+(\d+)\s+(-?\d+)\s+\d+%\s+.+$/.exec(rows[1]);
  if (!match) return null;
  const [total, used, free] = match.slice(1).map(Number);
  if (![total,used,Math.abs(free)].every(Number.isSafeInteger) || total <= 0 || used < 0 || free > total || used > total) return null;
  const totalBytes = total * 1024, availableBytes = Math.max(0, free) * 1024;
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) return null;
  return { totalBytes, availableBytes, usedPercent:used + Math.max(0,free) ? used / (used + Math.max(0, free)) * 100 : 100 };
}
export class MonitorCpu {
  private previous: Array<{ idle:number; total:number }> | null = null;
  sample(rows: ReturnType<typeof cpus>, load: number[]): CpuReading {
    const result: CpuReading = { usedPercent:null, logicalCpus:Math.min(rows.length,1024), loadAverage:load.length === 3 && load.every(n => Number.isFinite(n) && n >= 0) ? [...load] : null };
    const current = rows.slice(0,1024).map(c => ({idle:c.times.idle,total:Object.values(c.times).reduce((a,b) => a+b,0)}));
    if (rows.length > 1024 || !current.length || current.some(c => !Number.isSafeInteger(c.total) || !Number.isSafeInteger(c.idle) || c.idle < 0 || c.total < c.idle)) { this.previous = null; return result; }
    const before = this.previous; this.previous = current;
    if (!before || before.length !== current.length) return result;
    let idle = 0, total = 0;
    for (let i=0;i<current.length;i++) {
      const dt = current[i].total-before[i].total, di = current[i].idle-before[i].idle;
      if (dt <= 0 || di < 0 || di > dt) return result;
      total += dt; idle += di;
    }
    result.usedPercent = (total-idle)/total*100;
    return result;
  }
}

export function interpretMemory(snapshot:MemoryPressureSnapshot):Reading<MemoryReading>{
 const m=snapshot.memory;if(!m||!Number.isSafeInteger(m.totalBytes)||m.totalBytes<=0)return{value:null,reason:'memory_unavailable'};
 const pressure=snapshot.signal==='recovery'?'normal':['normal','elevated','critical'].includes(snapshot.level)?snapshot.level:'unknown';
 return{value:{totalBytes:m.totalBytes,availableBytes:m.availableBytes,availableKind:m.availableKind,pressure,swapTotalBytes:m.swapTotalBytes,swapFreeBytes:m.swapFreeBytes,details:{kind:'linux',pressureSignal:snapshot.signal==='recovery'?null:snapshot.signal??null,psiSomeAvg60:m.linuxPsi?.someAvg60??null,psiFullAvg10:m.linuxPsi?.fullAvg10??null,hostPsiSomeAvg60:m.linuxHostPsi?.someAvg60??null,hostPsiFullAvg10:m.linuxHostPsi?.fullAvg10??null}},...(snapshot.sampledAt!==null?{sampledAt:snapshot.sampledAt}:{})};
}
