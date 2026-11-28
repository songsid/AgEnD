import type { HostMonitoringConfig } from './host-monitoring-config.js';

export const HOST_SAMPLE_MS = 30_000;
export const DISK_SAMPLE_MS = 60_000;
export type MonitoringPlatform = 'linux' | 'wsl' | 'darwin';
export interface CpuReading { usedPercent: number | null; logicalCpus: number; loadAverage: number[] | null }
export type MemoryDetails = {kind:'darwin';kernelPressure:1|2|4|null;compressedBytes:number|null;storedBytes:number|null;swapUsedBytes:number|null} | {kind:'linux'|'wsl';pressureSignal:string|null;psiSomeAvg60:number|null;psiFullAvg10:number|null;/** M-3916: host-wide PSI (other distros/containers included), shown only; psi* above are the fleet cgroup's own. */hostPsiSomeAvg60?:number|null;hostPsiFullAvg10?:number|null};
export interface MemoryReading { totalBytes: number; availableBytes: number | null; availableKind: string; pressure: string; swapTotalBytes: number | null; swapFreeBytes: number | null; details?: MemoryDetails }
export interface DiskVolume { id: string; roles: string[]; totalBytes: number | null; availableBytes: number | null; usedPercent: number | null; sampledAt: number | null; reason?: string; shared?: boolean; sharedGroup?: string; drive?: string }
export interface DiskReading { volumes: DiskVolume[]; backingDrive?: 'identified' | 'unknown' | 'not-applicable'; availableDrives?: string[] }
export interface Reading<T> { value: T | null; sampledAt?: number; reason?: string }
export interface Metric<T> { value: T | null; sampledAt: number | null; attemptedAt: number | null; status: 'ok' | 'unavailable' | 'stale'; reason?: string }
export interface MonitoringProbe<T> { result: Promise<T | null>; stopped: Promise<void>; cancel(): void }
export interface HostMonitoringProvider {
  readonly platform: MonitoringPlatform;
  host(): { cpu: Reading<CpuReading>; memory: Reading<MemoryReading> };
  disks(): MonitoringProbe<DiskReading>;
  /** Resolves only when all physically owned commands have closed. */
  stop(): Promise<void>;
}
export interface HostHealthSnapshot {
  platformSupported?: boolean;
  version: 1; enabled: boolean; state: 'off' | 'starting' | 'sampling' | 'stopping' | 'failed';
  platform: MonitoringPlatform | null; reason?: string;
  history?: import('./host-monitoring-history.js').HostHistoryStatus;
  footprint?: import('./host-monitoring-footprint.js').FootprintSnapshot;
  alerts?: import('./host-monitoring-alerts.js').HostAlertsSnapshot;
  cpu: Metric<CpuReading>; memory: Metric<MemoryReading>; disks: Metric<DiskReading>;
}
const empty = <T>(): Metric<T> => ({ value:null, sampledAt:null, attemptedAt:null, status:'unavailable' });
export function disabledHostHealth(): HostHealthSnapshot {
  return { version:1, enabled:false, state:'off', platform:null, cpu:empty(), memory:empty(), disks:empty() };
}
interface Options { factory: () => HostMonitoringProvider; now?: () => number; onSnapshot?:(snapshot:HostHealthSnapshot)=>void }

/** No factory, probe, timer or file is touched until both the runtime and explicit opt-in are active. */
export class HostMonitoring {
  private readonly now: () => number;
  private desired = false;
  private runtime = false;
  private provider: HostMonitoringProvider | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private epoch = 0;
  private diskTicks = 0;
  private diskGeneration = 0;
  private diskFlight: MonitoringProbe<DiskReading> | null = null;
  private stopping: Promise<void> | null = null;
  private stopFailed = false;
  private current: HostHealthSnapshot = disabledHostHealth();
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; }

  configure(config: HostMonitoringConfig): void { this.desired = config.enabled === true; this.reconcile(); }
  setRuntimeActive(active: boolean): void { this.runtime = active; this.reconcile(); }

  /** A cache read, including stale decoration; never calls a provider or changes sampling deadlines. */
  snapshot(): HostHealthSnapshot {
    const value = structuredClone(this.current), now = this.now();
    value.enabled = this.desired;
    for (const [key, interval] of [['cpu',HOST_SAMPLE_MS],['memory',HOST_SAMPLE_MS],['disks',DISK_SAMPLE_MS]] as const) {
      const metric = value[key];
      if (metric.status === 'ok' && metric.sampledAt !== null && now - metric.sampledAt >= interval * 2) metric.status = 'stale';
    }
    return value;
  }

  private reconcile(): void {
    if (!this.runtime || !this.desired) { this.beginStop(); return; }
    if (this.stopping || this.stopFailed || this.provider) return;
    this.current = { ...disabledHostHealth(), enabled:true, state:'starting' };
    try { this.provider = this.options.factory(); }
    catch { this.current.state = 'failed'; this.current.reason = 'collector_start_failed'; return; }
    this.current.platform = this.provider.platform;
    this.diskTicks = 0;
    const epoch = ++this.epoch;
    this.timer = setInterval(() => this.sample(epoch), HOST_SAMPLE_MS);
    this.timer.unref?.();
    this.sample(epoch);
  }

  private update<T>(previous: Metric<T>, reading: Reading<T>, at: number): Metric<T> {
    return reading.value === null
      ? { ...previous, attemptedAt:at, status:'unavailable', reason:reading.reason ?? 'unavailable' }
      : { value:reading.value, sampledAt:reading.sampledAt ?? at, attemptedAt:at, status:'ok', ...(reading.reason ? { reason:reading.reason } : {}) };
  }

  private publish(): void {try{this.options.onSnapshot?.(this.snapshot());}catch{/* History failure cannot stop the host cache. */}}

  private sample(epoch: number): void {
    const provider = this.provider;
    if (!provider || epoch !== this.epoch || !this.runtime || !this.desired || this.stopping) return;
    const at = this.now();
    try {
      const host = provider.host();
      this.current.cpu = this.update(this.current.cpu, host.cpu, at);
      this.current.memory = this.update(this.current.memory, host.memory, at);
    } catch {
      this.current.cpu = this.update(this.current.cpu, { value:null, reason:'host_read_failed' }, at);
      this.current.memory = this.update(this.current.memory, { value:null, reason:'host_read_failed' }, at);
    }
    this.current.state = 'sampling';
    this.publish();
    if (this.diskTicks > 0) this.diskTicks--;
    if (this.diskFlight || this.diskTicks > 0) return;
    this.diskTicks = DISK_SAMPLE_MS / HOST_SAMPLE_MS;
    const generation = ++this.diskGeneration;
    let flight: MonitoringProbe<DiskReading>;
    try { flight = provider.disks(); }
    catch { this.current.disks = this.update(this.current.disks, { value:null, reason:'disk_read_failed' }, at); this.publish();return; }
    this.diskFlight = flight;
    void flight.result.then(value => {
      if (epoch !== this.epoch || generation !== this.diskGeneration || this.provider !== provider || !this.runtime || !this.desired) return;
      this.current.disks = this.update(this.current.disks, { value }, this.now());
      this.publish();
    }, () => {
      if (epoch === this.epoch && generation === this.diskGeneration && this.provider === provider && this.runtime && this.desired) {
        this.current.disks = this.update(this.current.disks, { value:null, reason:'disk_read_failed' }, this.now());this.publish();
      }
    });
    // Logical timeout/result is not physical completion. No queued catch-up batch.
    void flight.stopped.then(() => { if (this.diskFlight === flight) this.diskFlight = null; }, () => { /* fail closed: keep reservation */ });
  }

  private beginStop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stopping || this.stopFailed) return;
    const provider = this.provider;
    if (!provider) { this.current = disabledHostHealth(); return; }
    this.epoch++;
    this.current = { ...disabledHostHealth(), state:'stopping' };
    try { this.diskFlight?.cancel(); } catch { /* provider.stop retains physical ownership */ }
    let stopped: Promise<void>;
    try { stopped = provider.stop(); } catch { stopped = Promise.reject(Error('stop unconfirmed')); }
    const stopping = this.stopping = Promise.all([stopped, this.diskFlight?.stopped ?? Promise.resolve()]).then(() => {
      if (this.stopping !== stopping) return;
      this.provider = null;
      this.diskFlight = null;
      this.stopping = null;
      this.current = disabledHostHealth();
      this.reconcile();
    }, () => {
      this.stopping = null;
      this.stopFailed = true;
      this.current = { ...disabledHostHealth(), state:'failed', reason:'collector_stop_unconfirmed' };
    });
  }
}
