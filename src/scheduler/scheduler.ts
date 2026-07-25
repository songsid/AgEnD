import { Cron } from "croner";
import { SchedulerDb } from "./db.js";
import type { Schedule, CreateScheduleParams, UpdateScheduleParams, SchedulerConfig, ScheduleRun } from "./types.js";
import { validateTimezone } from "../config.js";

export class Scheduler {
  /** Cap how far back we look for missed fires on init. Avoids dumping
   * dozens of "morning standup" pings on the user after a long outage,
   * while still recovering from short crashes/restarts. */
  private static readonly CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000;
  /** Node clamps larger setTimeout delays to 1ms. Re-arm long schedules in chunks. */
  private static readonly MAX_TIMEOUT_MS = 2_147_000_000;

  readonly db: SchedulerDb;
  private jobs: Map<string, Cron> = new Map();
  private oneShotTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onTrigger: (schedule: Schedule) => void | Promise<void>;
  private config: SchedulerConfig;
  private isValidInstance: (name: string) => boolean;
  /** IDs of schedules whose onTrigger is currently in flight; guards against
   * a manual trigger and a cron firing (or two cron fires) overlapping. */
  private executing = new Set<string>();

  constructor(
    dbPath: string,
    onTrigger: (schedule: Schedule) => void | Promise<void>,
    config: SchedulerConfig,
    isValidInstance: (name: string) => boolean,
  ) {
    this.db = new SchedulerDb(dbPath);
    this.onTrigger = onTrigger;
    this.config = config;
    this.isValidInstance = isValidInstance;
  }

  init(): void {
    this.db.pruneOldRuns();
    this.runCatchUp();
    this.registerAllJobs();
  }

  /**
   * On startup, fire any schedule whose most recent expected run was missed
   * within the catch-up window. Only one catch-up fire per schedule — we
   * don't replay every missed minute of `* * * * *`. Schedules that haven't
   * been triggered yet use `created_at` as the reference point so a new
   * schedule registered while the daemon was down still gets caught up.
   */
  private runCatchUp(): void {
    const now = Date.now();
    const cutoff = now - Scheduler.CATCHUP_WINDOW_MS;
    for (const schedule of this.db.list()) {
      if (!schedule.enabled) continue;
      if (schedule.at) continue; // one-shots are registered directly below

      const refIso = schedule.last_triggered_at ?? schedule.created_at;
      // SQLite datetime('now') stores UTC without 'Z' suffix — append it for correct parsing
      const refMs = Date.parse(refIso.endsWith("Z") ? refIso : refIso + "Z");
      if (Number.isNaN(refMs)) continue;

      try {
        if (!schedule.cron) continue;
        const cron = new Cron(schedule.cron, { timezone: schedule.timezone });
        const next = cron.nextRun(new Date(refMs));
        if (!next) continue;
        const nextMs = next.getTime();
        if (nextMs > now) continue;       // not yet due
        if (nextMs < cutoff) continue;    // too old, don't spam
        if (this.executing.has(schedule.id)) continue;
        this.runWithLock(schedule);
      } catch {
        // Bad cron expression or croner edge case — skip rather than crash init
        continue;
      }
    }
  }

  reload(): void {
    this.stopAllJobs();
    this.registerAllJobs();
  }

  shutdown(): void {
    this.stopAllJobs();
    this.db.close();
  }

  create(params: CreateScheduleParams): Schedule {
    const tz = params.timezone ?? this.config.default_timezone;
    validateTimezone(tz, "timezone");
    this.validateTiming(params.cron, params.at, tz);

    // `__`-prefixed target names are reserved for fleet-internal use.
    if (params.target.startsWith("__")) throw new Error("Reserved target name");
    if (!this.isValidInstance(params.target)) {
      throw new Error(`Instance "${params.target}" not found in fleet config.`);
    }

    const schedule = this.db.create(params, this.config.max_schedules);
    this.registerJob(schedule);
    return schedule;
  }

  list(target?: string): Schedule[] {
    return this.db.list(target);
  }

  get(id: string): Schedule | null {
    return this.db.get(id);
  }

  update(id: string, params: UpdateScheduleParams): Schedule {
    const existing = this.db.get(id);
    if (!existing) throw new Error(`Schedule "${id}" not found`);
    if (params.timezone !== undefined) {
      validateTimezone(params.timezone, "timezone");
    }
    if (params.cron !== undefined && params.at !== undefined) {
      throw new Error("cron and at are mutually exclusive");
    }
    const nextCron = params.cron !== undefined ? params.cron : params.at !== undefined ? null : existing.cron;
    const nextAt = params.at !== undefined ? params.at : params.cron !== undefined ? null : existing.at;
    this.validateTiming(nextCron, nextAt, params.timezone ?? existing.timezone);

    if (params.target !== undefined) {
      if (params.target.startsWith("__")) throw new Error("Reserved target name");
      if (!this.isValidInstance(params.target)) throw new Error(`Instance "${params.target}" not found in fleet config.`);
    }

    const updated = this.db.update(id, params);
    this.stopJob(id);
    if (updated.enabled) {
      this.registerJob(updated);
    }
    return updated;
  }

  delete(id: string): void {
    this.stopJob(id);
    this.db.delete(id);
  }

  trigger(id: string): void {
    const schedule = this.db.get(id);
    if (!schedule) throw new Error(`Schedule "${id}" not found.`);
    if (this.executing.has(id)) {
      throw new Error(`Schedule "${id}" is already running.`);
    }
    this.runWithLock(schedule);
  }

  /** Invoke onTrigger while holding the per-schedule lock. Cleans up when
   * the callback returns synchronously, throws, or settles a returned Promise. */
  private runWithLock(schedule: Schedule): void {
    this.executing.add(schedule.id);
    const finish = () => {
      this.executing.delete(schedule.id);
      if (schedule.at) {
        // A one-shot is consumed after the delivery attempt settles, so
        // onTrigger can still record its run while the parent row exists.
        this.stopJob(schedule.id);
        try { this.db.delete(schedule.id); } catch { /* scheduler may be shutting down */ }
      }
    };
    let result: void | Promise<void>;
    try {
      result = this.onTrigger(schedule);
    } catch (err) {
      finish();
      throw err;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).then(finish, finish);
    } else {
      finish();
    }
  }

  deleteByInstanceOrThread(instanceName: string, threadId: string): number {
    const affected = this.db.list().filter(
      (s) => s.target === instanceName || s.reply_thread_id === threadId,
    );
    for (const s of affected) {
      this.stopJob(s.id);
    }
    return this.db.deleteByInstanceOrThread(instanceName, threadId);
  }

  recordRun(scheduleId: string, status: string, detail?: string): void {
    this.db.recordRun(scheduleId, status, detail);
  }

  getRuns(scheduleId: string, limit?: number): ScheduleRun[] {
    return this.db.getRuns(scheduleId, limit);
  }

  private registerAllJobs(): void {
    for (const schedule of this.db.list()) {
      if (schedule.enabled) {
        this.registerJob(schedule);
      }
    }
  }

  private registerJob(schedule: Schedule): void {
    if (schedule.at) {
      this.registerOneShot(schedule);
      return;
    }
    if (!schedule.cron) return;
    const job = new Cron(schedule.cron, { timezone: schedule.timezone }, () => {
      const current = this.db.get(schedule.id);
      if (!current || !current.enabled) return;
      // Skip if a previous fire (or manual trigger) is still in flight —
      // avoids overlapping runs of the same schedule.
      if (this.executing.has(current.id)) return;
      this.runWithLock(current);
    });
    this.jobs.set(schedule.id, job);
  }

  private stopJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
    const timer = this.oneShotTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.oneShotTimers.delete(id);
    }
  }

  private stopAllJobs(): void {
    for (const [, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    for (const timer of this.oneShotTimers.values()) clearTimeout(timer);
    this.oneShotTimers.clear();
  }

  private registerOneShot(schedule: Schedule): void {
    const atMs = this.parseAt(schedule.at!);
    const arm = () => {
      const current = this.db.get(schedule.id);
      if (!current || !current.enabled || !current.at) {
        this.oneShotTimers.delete(schedule.id);
        return;
      }
      const remaining = atMs - Date.now();
      if (remaining > Scheduler.MAX_TIMEOUT_MS) {
        const timer = setTimeout(arm, Scheduler.MAX_TIMEOUT_MS);
        this.oneShotTimers.set(schedule.id, timer);
        return;
      }
      const timer = setTimeout(() => {
        this.oneShotTimers.delete(schedule.id);
        const due = this.db.get(schedule.id);
        if (!due || !due.enabled || !due.at || this.executing.has(due.id)) return;
        this.runWithLock(due);
      }, Math.max(0, remaining));
      this.oneShotTimers.set(schedule.id, timer);
    };
    arm();
  }

  private validateTiming(cron: string | null | undefined, at: string | null | undefined, timezone: string): void {
    const hasCron = typeof cron === "string" && cron.trim().length > 0;
    const hasAt = typeof at === "string" && at.trim().length > 0;
    if (hasCron === hasAt) {
      throw new Error("Exactly one of cron or at is required");
    }
    if (hasCron) {
      try {
        new Cron(cron!, { timezone });
      } catch (err) {
        throw new Error(`Invalid cron expression: ${(err as Error).message}`);
      }
      return;
    }
    this.parseAt(at!);
  }

  private parseAt(at: string): number {
    // Require an explicit UTC offset (or Z) so a fleet restart on a host with a
    // different local timezone cannot silently move the scheduled instant.
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(at)) {
      throw new Error("Invalid at datetime: use ISO-8601 with timezone offset");
    }
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp)) {
      throw new Error("Invalid at datetime: use ISO-8601 with timezone offset");
    }
    return timestamp;
  }
}
