import { isDeepStrictEqual } from 'node:util';
import { monitoringConfig, HOST_MONITORING_KEYS, type HostMonitoringConfig } from './host-monitoring-config.js';
import { HostMonitoring, disabledHostHealth, type HostHealthSnapshot, type HostMonitoringProvider } from './host-monitoring.js';

interface Options {
  history?:import('./host-monitoring-history.js').HostMonitoringHistory;
  supported(): boolean;
  committed(): HostMonitoringConfig;
  raw(): { monitoring?: unknown };
  /** Synchronous atomic config commit; must throw on failure. */
  pin(patch: Array<{path:string[];value:boolean}>): void;
  factory(): HostMonitoringProvider;
}
/** Runtime-only bridge. Loading config, opening Settings and reading the cache cannot activate it. */
export class HostMonitoringRuntime {
  private active = false;
  private applying = false;
  private pinned = false;
  private collector: HostMonitoring | null = null;
  private failure: string | null = null;
  private appliedDrive: string | undefined;
  constructor(private readonly options: Options) {}
  available(): boolean { return this.active && this.pinned && this.options.supported(); }
  start(): void { if (this.active) return; this.active = true; this.apply(); }
  stop(): void { this.active = false; this.pinned=false; this.collector?.setRuntimeActive(false);this.options.history?.shutdown(); }
  snapshot(): HostHealthSnapshot {
    if (this.failure) return {...disabledHostHealth(),platformSupported:this.options.supported(),state:'failed',reason:this.failure};
    const snapshot=this.collector?.snapshot() ?? disabledHostHealth(),history=this.options.history?.status();
    snapshot.platformSupported=this.options.supported();
    if(history){snapshot.history=history;if(!snapshot.enabled&&(history.state==='stopping'||history.state==='failed')){snapshot.state=history.state;snapshot.reason=history.reason;}}
    return snapshot;
  }
  apply(): void {
    if (!this.active || this.applying) return;
    this.applying=true;
    try {
      const committed=monitoringConfig(this.options.committed()),raw=this.options.raw(),normalized=monitoringConfig(raw.monitoring);
      // A concurrent monitoring edit is adopted by the normal reload, not overwritten by default materialisation.
      if (!isDeepStrictEqual(committed,normalized)) throw Error('monitoring_config_changed');
      if(!committed.enabled)this.options.history?.configure(false);
      const values=raw.monitoring as Partial<HostMonitoringConfig> | undefined;
      const missing=HOST_MONITORING_KEYS.filter(k=>!Object.hasOwn(values ?? {},k));
      if (missing.length) this.options.pin(missing.map(key=>({path:['monitoring',key],value:false})));
      this.pinned=true;this.failure=null;
      if (!this.options.supported()) {this.collector?.setRuntimeActive(false);return;}
      this.options.history?.configure(committed.enabled);
      if(this.options.history?.blocked()){this.collector?.setRuntimeActive(false);return;}
      // No factory, buffer or timer is created for a default-off installation.
      if (committed.enabled) this.collector ??= new HostMonitoring({factory:this.options.factory,onSnapshot:snapshot=>this.options.history?.ingest(snapshot)});
      if (this.collector && this.appliedDrive !== committed.wsl_drive) this.collector.configure({...committed,enabled:false});
      this.appliedDrive=committed.wsl_drive;
      this.collector?.configure(committed);
      this.collector?.setRuntimeActive(true);
    } catch {
      this.pinned=false;this.failure='monitoring_config_not_committed';
      this.collector?.setRuntimeActive(false);
    } finally { this.applying=false; }
  }
}
