import type { HostHealthSnapshot } from './host-monitoring.js';

export const HISTORY_BYTES = 64 * 1024 ** 2;
export const HISTORY_PAGE_BYTES = 4096;
export const HISTORY_SHM_BUDGET = 128 * 1024;
export const HISTORY_RAW_MS = 24 * 60 * 60 * 1000;
export const HISTORY_ROLLUP_MS = 30 * HISTORY_RAW_MS;
export const HISTORY_BUCKET_MS = 5 * 60 * 1000;
export const HISTORY_MAX_BUCKETS = 240;
const GiB = 1024 ** 3;

/** Leave room for one worst-case WAL and later bounded incident files, not just the database. */
export function historyBudget(maxBytes = HISTORY_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 ** 2 || maxBytes > HISTORY_BYTES) throw Error('invalid_history_budget');
  const reserveBytes = Math.min(4 * 1024 ** 2, Math.floor(maxBytes / 4));
  const maxPages = Math.floor((maxBytes - reserveBytes - HISTORY_SHM_BUDGET - 32) / (2 * HISTORY_PAGE_BYTES + 24));
  const dbBytes = maxPages * HISTORY_PAGE_BYTES, walBytes = 32 + maxPages * (HISTORY_PAGE_BYTES + 24);
  return { maxBytes, softBytes:Math.floor(maxBytes * 7/8), lowBytes:Math.floor(maxBytes * 3/4), reserveBytes, maxPages, dbBytes, walBytes,
    worstBytes:dbBytes + walBytes + HISTORY_SHM_BUDGET + reserveBytes };
}

export type HistoryPause = 'disk_unavailable' | 'backing_drive_unknown' | 'low_space' | 'recovering_space';
export class HistoryWatermark {
  private low = false;
  private recoveringAt: number | null = null;
  /** Monotonic time controls recovery; wall-clock adjustments cannot finish it early. */
  permit(snapshot: HostHealthSnapshot, monotonicNow: number): {ok:true} | {ok:false;reason:HistoryPause} {
    const unavailable = (reason:HistoryPause) => {this.recoveringAt=null;return {ok:false as const,reason};};
    if (snapshot.disks.status !== 'ok' || !snapshot.disks.value) return unavailable('disk_unavailable');
    const volumes=snapshot.disks.value.volumes;
    const state=volumes.find(v=>v.roles.includes('state'));
    const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
    if (!state || !valid(state.availableBytes)) return unavailable('disk_unavailable');
    const free=[state.availableBytes];
    if (snapshot.platform==='wsl') {
      const backing=volumes.find(v=>v.roles.includes('wsl-backing'));
      if (snapshot.disks.value.backingDrive!=='identified'||!backing||!valid(backing.availableBytes)) return unavailable('backing_drive_unknown');
      free.push(backing.availableBytes);
    }
    if (free.some(n=>n<2*GiB)) {this.low=true;return unavailable('low_space');}
    if (!this.low) return {ok:true};
    if (free.some(n=>n<=4*GiB)) return unavailable('recovering_space');
    if (this.recoveringAt===null || monotonicNow<this.recoveringAt) this.recoveringAt=monotonicNow;
    if (monotonicNow-this.recoveringAt<10*60*1000) return {ok:false,reason:'recovering_space'};
    this.low=false;this.recoveringAt=null;return {ok:true};
  }
}

export interface HistoryPoint {series:string;at:number;sourceAt:number;value:number}
export const historySeries = (value: unknown): value is string => typeof value==='string' &&
  /^(?:cpu\.used|memory\.(?:available|pressure)|swap\.free|disk\.[a-f0-9]{16}\.(?:available|used))$/.test(value);
/** Only numerical telemetry and opaque volume ids cross into history. No paths/names/native text. */
export function hostHistoryPoints(snapshot: HostHealthSnapshot, at:number): HistoryPoint[] {
  if (!snapshot.enabled||snapshot.state!=='sampling'||!Number.isSafeInteger(at)||at<0) return [];
  const points:HistoryPoint[]=[];
  const add=(series:string,value:unknown,sourceAt:number|null,max=Number.MAX_SAFE_INTEGER)=>{
    if (typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max&&sourceAt!==null&&Number.isSafeInteger(sourceAt)&&sourceAt>=0)
      points.push({series,at,sourceAt,value});
  };
  if (snapshot.cpu.status==='ok') add('cpu.used',snapshot.cpu.value?.usedPercent,snapshot.cpu.sampledAt,100);
  if (snapshot.memory.status==='ok'&&snapshot.memory.value) {
    const memory=snapshot.memory.value;
    add('memory.available',memory.availableBytes,snapshot.memory.sampledAt);
    add('swap.free',memory.swapFreeBytes,snapshot.memory.sampledAt);
    add('memory.pressure',({normal:1,elevated:2,critical:3} as Record<string,number>)[memory.pressure],snapshot.memory.sampledAt,3);
  }
  if (snapshot.disks.status==='ok') for (const disk of snapshot.disks.value?.volumes.slice(0,8)??[]) {
    if (!/^[a-f0-9]{16}$/.test(disk.id)) continue;
    add(`disk.${disk.id}.available`,disk.availableBytes,disk.sampledAt);
    add(`disk.${disk.id}.used`,disk.usedPercent,disk.sampledAt,100);
  }
  return points;
}

export const HISTORY_RANGES = {'1h':60*60*1000,'24h':HISTORY_RAW_MS,'7d':7*HISTORY_RAW_MS,'30d':HISTORY_ROLLUP_MS} as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;
export function historyQuery(range:unknown,series:unknown,now:number) {
  if (typeof range!=='string'||!Object.hasOwn(HISTORY_RANGES,range)||!Array.isArray(series)||series.length<1||series.length>24||!series.every(historySeries)||new Set(series).size!==series.length||!Number.isSafeInteger(now)||now<0) throw Error('invalid_history_query');
  const duration=HISTORY_RANGES[range as HistoryRange],resolution=range==='1h'?30_000:HISTORY_BUCKET_MS;
  const step=Math.max(resolution,Math.ceil(duration/HISTORY_MAX_BUCKETS/resolution)*resolution);
  const start=Math.max(0,now-duration);
  return {series:[...series] as string[],start,end:now,resolution,step,buckets:Math.max(1,Math.ceil((now-start)/step))};
}
