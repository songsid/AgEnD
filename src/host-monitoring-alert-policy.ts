/** Pure alert windows: callers supply samples and clocks; importing this module does no work. */
export type HostAlertKind = 'cpu' | 'memory' | 'filesystem' | 'backing-drive' | 'inodes';
export type HostAlertLevel = 'warning' | 'urgent';
export interface HostAlertRule {
  kind: HostAlertKind; direction: 'above' | 'below'; warning: number; urgent: number; clear: number;
  warningMs: number; urgentMs: number; clearMs: number; warningSamples: number; urgentSamples: number; intervalMs: number;
}
export interface HostAlertRecord {
  key: string; kind: HostAlertKind; level: HostAlertLevel; revision: number;
  openedAt: number; updatedAt: number; value: number; threshold: number;
  lastSentAt?: number; acknowledgedAt?: number; acknowledgedBy?: string;
  snoozedUntil?: number; snoozedLevel?: HostAlertLevel; resolvedAt?: number;
}
export interface HostAlertSample { sampledAt: number; monotonicAt: number; wallAt: number; value: number | null }
export interface HostAlertTransition { kind: 'opened' | 'escalated' | 'deescalated' | 'resolved'; record: HostAlertRecord }
const minute = 60_000, GiB = 1024 ** 3;
export const HOST_ALERT_WARNING_REPEAT_MS = 6 * 60 * minute;
export const HOST_ALERT_URGENT_REPEAT_MS = 60 * minute;
export const HOST_ALERT_MAX_SNOOZE_MS = 24 * 60 * minute;
export const HOST_ALERT_DEFAULTS: Readonly<Record<HostAlertKind, Readonly<HostAlertRule>>> = {
  cpu: { kind:'cpu', direction:'above', warning:90, urgent:98, clear:80, warningMs:5*minute, urgentMs:10*minute, clearMs:5*minute, warningSamples:1, urgentSamples:1, intervalMs:30_000 },
  memory: { kind:'memory', direction:'above', warning:1, urgent:2, clear:0, warningMs:2*minute, urgentMs:minute, clearMs:2*minute, warningSamples:1, urgentSamples:1, intervalMs:30_000 },
  filesystem: { kind:'filesystem', direction:'above', warning:85, urgent:95, clear:80, warningMs:0, urgentMs:0, clearMs:10*minute, warningSamples:2, urgentSamples:2, intervalMs:minute },
  'backing-drive': { kind:'backing-drive', direction:'below', warning:60*GiB, urgent:30*GiB, clear:65*GiB, warningMs:0, urgentMs:0, clearMs:10*minute, warningSamples:2, urgentSamples:1, intervalMs:minute },
  inodes: { kind:'inodes', direction:'above', warning:85, urgent:95, clear:80, warningMs:0, urgentMs:0, clearMs:10*minute, warningSamples:2, urgentSamples:2, intervalMs:minute },
};
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const hostAlertKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
/** Volume capacity is a cached value, never a request-time filesystem probe. */
export function validateHostAlertRule(rule: HostAlertRule, capacity?: number): void {
  if (!rule || typeof rule!=='object' || Array.isArray(rule) || Object.keys(rule).some(key=>!['kind','direction','warning','urgent','clear','warningMs','urgentMs','clearMs','warningSamples','urgentSamples','intervalMs'].includes(key))) throw Error('invalid_alert_rule');
  const base = Object.hasOwn(HOST_ALERT_DEFAULTS,rule.kind) ? HOST_ALERT_DEFAULTS[rule.kind] : undefined;
  if (!base || rule.direction !== base.direction || ![rule.warning,rule.urgent,rule.clear].every(number)) throw Error('invalid_alert_rule');
  if (rule.direction === 'above' ? !(rule.clear < rule.warning && rule.warning < rule.urgent) : !(rule.urgent < rule.warning && rule.warning < rule.clear)) throw Error('invalid_alert_order');
  if (rule.kind !== 'backing-drive' && Math.max(rule.warning,rule.urgent,rule.clear) > (rule.kind === 'memory' ? 2 : 100)) throw Error('invalid_alert_threshold');
  if (rule.kind === 'memory' && (rule.warning!==1 || rule.urgent!==2 || rule.clear!==0)) throw Error('invalid_alert_pressure');
  if (rule.kind === 'backing-drive' && ![rule.warning,rule.urgent,rule.clear].every(Number.isSafeInteger)) throw Error('invalid_alert_bytes');
  if (rule.kind === 'backing-drive' && capacity !== undefined && (!number(capacity) || rule.clear > capacity)) throw Error('invalid_alert_capacity');
  for (const duration of [rule.warningMs,rule.urgentMs,rule.clearMs]) if (!Number.isSafeInteger(duration) || duration < 0 || duration > HOST_ALERT_MAX_SNOOZE_MS) throw Error('invalid_alert_duration');
  for (const count of [rule.warningSamples,rule.urgentSamples]) if (!Number.isSafeInteger(count) || count < 1 || count > 120) throw Error('invalid_alert_samples');
  if (!Number.isSafeInteger(rule.intervalMs) || rule.intervalMs < 30_000 || rule.intervalMs > minute) throw Error('invalid_alert_interval');
}
interface Streak { since: number; count: number }
/** One resource, one incident. Transient monotonic dwell is deliberately not restored after restart. */
export class HostAlertWindow {
  private incident: HostAlertRecord | null;
  private warning: Streak | null = null;
  private urgent: Streak | null = null;
  private recovery: Streak | null = null;
  private lastSample: number | null = null;
  private lastMonotonic: number | null = null;
  private revision: number;
  readonly rule: Readonly<HostAlertRule>;
  constructor(readonly key: string, rule: HostAlertRule, restored?: HostAlertRecord) {
    if (!hostAlertKey(key)) throw Error('invalid_alert_key');
    validateHostAlertRule(rule); this.rule = { ...rule };
    if (restored && (restored.key !== key || restored.kind !== rule.kind || restored.resolvedAt !== undefined)) throw Error('invalid_restored_alert');
    this.incident = restored ? structuredClone(restored) : null; this.revision = restored?.revision ?? 0;
  }
  snapshot(): HostAlertRecord | null { return this.incident ? structuredClone(this.incident) : null; }
  private reset(): void { this.warning=null; this.urgent=null; this.recovery=null; }
  private streak(previous: Streak | null, qualifies: boolean, at: number): Streak | null {
    return qualifies ? previous ? { since:previous.since, count:previous.count+1 } : { since:at, count:1 } : null;
  }
  observe(sample: HostAlertSample): HostAlertTransition | null {
    if (![sample.sampledAt,sample.monotonicAt,sample.wallAt].every(number)) throw Error('invalid_alert_clock');
    if (sample.value === null || !number(sample.value) || (this.rule.kind==='memory' ? ![0,1,2].includes(sample.value) : this.rule.kind==='backing-drive' ? !Number.isSafeInteger(sample.value) : sample.value>100)) { this.reset(); return null; }
    // Owner-fenced collector snapshots are ordered by arrival; source wall time may move backwards.
    if (this.lastSample !== null && sample.sampledAt === this.lastSample) return null;
    if (this.lastMonotonic !== null && (sample.monotonicAt < this.lastMonotonic || sample.monotonicAt-this.lastMonotonic > this.rule.intervalMs*2)) this.reset();
    this.lastSample=sample.sampledAt; this.lastMonotonic=sample.monotonicAt;
    const at=sample.monotonicAt, value=sample.value, r=this.rule;
    const warning = r.direction === 'above' ? value >= r.warning : value < r.warning;
    const urgent = r.direction === 'above' ? value >= r.urgent : value < r.urgent;
    const clear = r.kind === 'cpu' ? value < r.clear : r.direction === 'above' ? value <= r.clear : value >= r.clear;
    this.warning=this.streak(this.warning,warning,at); this.urgent=this.streak(this.urgent,urgent,at); this.recovery=this.streak(this.recovery,clear,at);
    const met=(s:Streak|null, ms:number, count:number)=>!!s && at-s.since>=ms && s.count>=count;
    if (this.incident && met(this.recovery,r.clearMs,1)) {
      const record={...this.incident,updatedAt:sample.wallAt,value,resolvedAt:sample.wallAt,revision:++this.revision};
      this.incident=null; this.reset(); return {kind:'resolved',record};
    }
    const next: HostAlertLevel | null = met(this.urgent,r.urgentMs,r.urgentSamples) ? 'urgent' : met(this.warning,r.warningMs,r.warningSamples) ? 'warning' : null;
    if (!this.incident && next) {
      this.incident={key:this.key,kind:r.kind,level:next,revision:++this.revision,openedAt:sample.wallAt,updatedAt:sample.wallAt,value,threshold:next==='urgent'?r.urgent:r.warning};
      return {kind:'opened',record:this.snapshot()!};
    }
    if (this.incident) {
      this.incident.value=value; this.incident.updatedAt=sample.wallAt;
      if (next && next !== this.incident.level && (next==='urgent' || !urgent)) {
        this.incident.level=next; this.incident.threshold=next==='urgent'?r.urgent:r.warning; this.incident.revision=++this.revision;
        return {kind:next==='urgent'?'escalated':'deescalated',record:this.snapshot()!};
      }
    }
    return null;
  }
  reminderDue(wallAt: number): boolean {
    if (!number(wallAt)) throw Error('invalid_alert_clock');
    const i=this.incident; if (!i) return false;
    if (i.snoozedUntil !== undefined && wallAt < i.snoozedUntil && !(i.level==='urgent' && i.snoozedLevel==='warning')) return false;
    return i.lastSentAt === undefined || wallAt-i.lastSentAt >= (i.level==='urgent'?HOST_ALERT_URGENT_REPEAT_MS:HOST_ALERT_WARNING_REPEAT_MS);
  }
  /** Call only after a successful external delivery, with its captured incident revision. */
  delivered(revision: number, wallAt: number): boolean {
    if (!number(wallAt)) throw Error('invalid_alert_clock');
    if (!this.incident || this.incident.revision!==revision || wallAt<(this.incident.lastSentAt??0)) return false;
    this.incident.lastSentAt=wallAt; return true;
  }
  acknowledge(actor: string, wallAt: number): void {
    if (!hostAlertKey(actor) || !number(wallAt)) throw Error('invalid_alert_ack');
    if (this.incident) { this.incident.acknowledgedBy=actor; this.incident.acknowledgedAt=wallAt; }
  }
  snooze(wallAt: number, durationMs: number): void {
    if (!number(wallAt) || !Number.isSafeInteger(durationMs) || durationMs<minute || durationMs>HOST_ALERT_MAX_SNOOZE_MS) throw Error('invalid_alert_snooze');
    if (this.incident) { this.incident.snoozedLevel=this.incident.level; this.incident.snoozedUntil=wallAt+durationMs; }
  }
}
