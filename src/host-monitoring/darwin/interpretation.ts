import type {cpus} from 'node:os';
import type {MemoryPressureSnapshot} from '../../memory-pressure.js';
import type {CpuReading,MemoryReading,Reading} from '../../host-monitoring.js';
import {MONITOR_OUTPUT_BYTES,MONITOR_MOUNT_BYTES} from '../transport.js';
import {isAbsolute} from 'node:path';
/** Read only one known plist string key; duplicate/malformed identities are not evidence of a shared container. */
export function parseApfsContainer(text: string | null): string | null {
  if (!text || Buffer.byteLength(text) > MONITOR_OUTPUT_BYTES) return null;
  const rows = [...text.matchAll(/<key>APFSContainerReference<\/key>\s*<string>(disk\d+)<\/string>/g)];
  return rows.length === 1 ? rows[0][1] : null;
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
 const pressure=m.darwinPressureLevel===1?'normal':m.darwinPressureLevel===2?'elevated':m.darwinPressureLevel===4?'critical':'unknown';
 return{value:{totalBytes:m.totalBytes,availableBytes:m.availableBytes,availableKind:'reclaimable-estimate',pressure,swapTotalBytes:m.swapTotalBytes,swapFreeBytes:m.swapFreeBytes,details:{kind:'darwin',kernelPressure:m.darwinPressureLevel??null,compressedBytes:m.darwinCompressedBytes??null,storedBytes:m.darwinStoredBytes??null,swapUsedBytes:m.swapTotalBytes!==null&&m.swapFreeBytes!==null?Math.max(0,m.swapTotalBytes-m.swapFreeBytes):null}},...(snapshot.sampledAt!==null?{sampledAt:snapshot.sampledAt}:{})};
}

/** Compression diagnostics come from the already bounded vm_stat response. */
export function parseDarwinCompression(text:string,totalBytes:number):{darwinCompressedBytes:number|null;darwinStoredBytes:number|null}{
 const unknown={darwinCompressedBytes:null,darwinStoredBytes:null};if(Buffer.byteLength(text)>MONITOR_OUTPUT_BYTES||!Number.isSafeInteger(totalBytes)||totalBytes<=0)return unknown;
 const headers=[...text.matchAll(/^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)\s*$/gm)];if(headers.length!==1||[...text.matchAll(/^Mach Virtual Memory Statistics:/gm)].length!==1)return unknown;
 const page=Number(headers[0][1]);if(!Number.isSafeInteger(page)||page<1024||page>1024*1024||Math.log2(page)%1!==0)return unknown;
 const read=(name:string,maximum:number)=>{const rows=[...text.matchAll(new RegExp('^Pages '+name+':\\s+(\\d+)\\.\\s*$','gm'))];if(rows.length!==1||[...text.matchAll(new RegExp('^Pages '+name+':','gm'))].length!==1)return null;const bytes=Number(rows[0][1])*page;return Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=maximum?bytes:null;};
 return{darwinCompressedBytes:read('occupied by compressor',totalBytes),darwinStoredBytes:read('stored in compressor',Number.MAX_SAFE_INTEGER)};
}
