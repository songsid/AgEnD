import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { SchedulerDb } from "./db.js";
import type { Schedule, CreateScheduleParams, UpdateScheduleParams, SchedulerConfig, ScheduleRun, ScheduleRetry, ScheduleRetryDrop } from "./types.js";
import { validateTimezone } from "../config.js";

/** #1426: how a pending retry ended without running, reported for the escalation. */
export type RetryDroppedHandler = (schedule: Schedule, retry: ScheduleRetry, reason: ScheduleRetryDrop) => void;

export class Scheduler {
  /** #1426: an attempt waiting for a reset time gives the window this long to settle before it looks again. */
  static readonly RETRY_RESET_GRACE_MS = 60_000;
  /** #1426: with no reset time to wait for, the retry looks again this often. */
  static readonly RETRY_POLL_MS = 15 * 60_000;
  /** #1426: a 5h window resets within 5h; past this a retry is given up even if no next occurrence comes first. */
  static readonly RETRY_MAX_WAIT_MS = 5 * 60 * 60_000 + 15 * 60_000;
  /** Cap how far back we look for missed fires on init. Avoids dumping
   * dozens of "morning standup" pings on the user after a long outage,
   * while still recovering from short crashes/restarts. */
  private static readonly CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000;
  /** Node clamps larger setTimeout delays to 1ms. Re-arm long schedules in chunks. */
  private static readonly MAX_TIMEOUT_MS = 2_147_000_000;
  /** Admission failures leave one-shot schedules pending instead of losing their run. */
  private static readonly ONE_SHOT_FAILURE_RETRY_MS = 30_000;

  readonly db: SchedulerDb;
  private jobs: Map<string, Cron> = new Map();
  private oneShotTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** #1426: the timer of each schedule's pending retry. */
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onRetryDropped: RetryDroppedHandler;
  private onTrigger: (schedule: Schedule, runId: string, retry?: ScheduleRetry) => void | Promise<void>;
  private config: SchedulerConfig;
  private isValidInstance: (name: string) => boolean;
  /** IDs of schedules whose onTrigger is currently in flight; guards against
   * a manual trigger and a cron firing (or two cron fires) overlapping. */
  private executing = new Set<string>();

  constructor(
    dbPath: string,
    onTrigger: (schedule: Schedule, runId: string, retry?: ScheduleRetry) => void | Promise<void>,
    config: SchedulerConfig,
    isValidInstance: (name: string) => boolean,
    onRetryDropped: RetryDroppedHandler = () => {},
  ) {
    this.db = new SchedulerDb(dbPath);
    this.onTrigger = onTrigger;
    this.config = config;
    this.isValidInstance = isValidInstance;
    this.onRetryDropped = onRetryDropped;
  }

  init(): void {
    this.db.pruneOldRuns();
    // Catch-up first: an occurrence missed while the fleet was down supersedes the retry of an older one.
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
        // Catch up only the first missed occurrence after the last recorded
        // run. Choosing the latest occurrence would replay stale channel work
        // after a long shutdown.
        const scheduled = cron.nextRun(new Date(refMs));
        if (!scheduled) continue;
        const scheduledMs = scheduled.getTime();
        if (scheduledMs > now) continue;     // not yet due
        if (scheduledMs < cutoff) continue;  // too old, don't spam
        if (this.executing.has(schedule.id)) continue;
        // The expected fire time stays stable if the process dies after outbox
        // commit but before last_triggered_at advances.
        this.runWithLock(schedule, scheduled.toISOString());
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
    const retryTimer = this.retryTimers.get(id);
    if (retryTimer) { clearTimeout(retryTimer); this.retryTimers.delete(id); }
    this.db.delete(id);   // its pending retry goes with it (ON DELETE CASCADE)
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
  private runWithLock(schedule: Schedule, runId: string = randomUUID(), retry?: ScheduleRetry): void {
    // #1426: any other run of the schedule — its next occurrence, a catch-up, a manual trigger — supersedes a pending
    // retry of an earlier occurrence: never run twice.
    if (!retry) this.supersedeRetry(schedule, runId);
    this.executing.add(schedule.id);
    const finish = (consumeOneShot = true) => {
      this.executing.delete(schedule.id);
      // #1426: a one-shot whose run was deferred stays until its retry has run or been given up.
      if (schedule.at && this.db.getRetry(schedule.id)) return;
      if (schedule.at) {
        // A one-shot is consumed after the delivery attempt settles, so
        // onTrigger can still record its run while the parent row exists. If
        // admission throws before its durable ACK, retain it and retry later.
        this.stopJob(schedule.id);
        if (consumeOneShot) {
          try { this.db.delete(schedule.id); } catch { /* scheduler may be shutting down */ }
        } else if (schedule.silent) {
          const pending = this.db.get(schedule.id);
          if (pending?.enabled) this.registerOneShot(pending, Scheduler.ONE_SHOT_FAILURE_RETRY_MS);
        } else {
          // Non-silent callbacks may already have posted a channel message
          // before a later bookkeeping step rejects. Re-running them could
          // duplicate that visible side effect; preserve the prior consume-on-
          // failure behavior for those schedules.
          try { this.db.delete(schedule.id); } catch { /* scheduler may be shutting down */ }
        }
      }
    };
    let result: void | Promise<void>;
    try {
      result = this.onTrigger(schedule, runId, retry);
    } catch (err) {
      finish(!schedule.silent);
      throw err;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).then(() => finish(), () => finish(!schedule.silent));
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

  // ── #1426: the one retry of a rate-limit-deferred occurrence ──

  getRetry(scheduleId: string): ScheduleRetry | null {
    return this.db.getRetry(scheduleId);
  }

  /**
   * Arrange the one retry of an occurrence the rate limit deferred: due at the window's reset (plus a grace) when the
   * statusline gave one, else after RETRY_POLL_MS. It must come before its deadline — the schedule's next occurrence
   * after this one, or RETRY_MAX_WAIT_MS — or there is no retry: the deadline's kind says why.
   */
  deferForRetry(
    schedule: Schedule,
    runId: string,
    deferral: { deferredPct: number; resetsAtMs: number | null; nowMs?: number },
  ): ScheduleRetry | { dropped: ScheduleRetryDrop; retry: ScheduleRetry } {
    const nowMs = deferral.nowMs ?? Date.now();
    const next = this.nextOccurrenceAfter(schedule, runId, nowMs);
    const cap = nowMs + Scheduler.RETRY_MAX_WAIT_MS;
    const retry: ScheduleRetry = {
      schedule_id: schedule.id,
      run_id: runId,
      deferred_at_ms: nowMs,
      deferred_pct: deferral.deferredPct,
      resets_at_ms: deferral.resetsAtMs,
      due_at_ms: this.retryDueAt(deferral.resetsAtMs, nowMs),
      deadline_ms: next !== null && next < cap ? next : cap,
      deadline_kind: next !== null && next < cap ? "next_occurrence" : "cap",
    };
    if (retry.due_at_ms >= retry.deadline_ms) return { dropped: this.deadlineDrop(retry), retry };
    this.db.putRetry(retry);
    this.armRetry(retry);
    return retry;
  }

  /**
   * The retry found the limit still in force and must look again later (reset time unknown, or a new one learnt): the
   * same retry, re-armed — unless that would reach its deadline, which ends it.
   */
  postponeRetry(retry: ScheduleRetry, resetsAtMs: number | null, nowMs = Date.now()): ScheduleRetry | { dropped: ScheduleRetryDrop; retry: ScheduleRetry } {
    const next: ScheduleRetry = { ...retry, resets_at_ms: resetsAtMs, due_at_ms: this.retryDueAt(resetsAtMs, nowMs) };
    if (next.due_at_ms >= next.deadline_ms) {
      this.endRetry(retry);
      return { dropped: this.deadlineDrop(next), retry: next };
    }
    this.db.putRetry(next);
    this.armRetry(next);
    return next;
  }

  /**
   * The retry is running now (or was given up by the caller): remove it, first — a crash after this loses the retry
   * rather than running the occurrence twice. True when this call removed it. A one-shot it kept alive is consumed.
   */
  endRetry(retry: ScheduleRetry): boolean {
    const timer = this.retryTimers.get(retry.schedule_id);
    if (timer) { clearTimeout(timer); this.retryTimers.delete(retry.schedule_id); }
    const removed = this.db.deleteRetry(retry.schedule_id, retry.run_id);
    if (removed) this.consumeOneShotAfterRetry(retry.schedule_id);
    return removed;
  }

  private retryDueAt(resetsAtMs: number | null, nowMs: number): number {
    return resetsAtMs !== null && resetsAtMs > nowMs ? resetsAtMs + Scheduler.RETRY_RESET_GRACE_MS : nowMs + Scheduler.RETRY_POLL_MS;
  }

  private deadlineDrop(retry: ScheduleRetry): ScheduleRetryDrop {
    return retry.deadline_kind === "next_occurrence" ? "superseded" : "expired";
  }

  /** The schedule's first regular occurrence after `runId` (a cron instant), at or after now; null for a one-shot. */
  private nextOccurrenceAfter(schedule: Schedule, runId: string, nowMs: number): number | null {
    if (!schedule.cron) return null;
    try {
      const cron = new Cron(schedule.cron, { timezone: schedule.timezone });
      const fromMs = Date.parse(runId);
      const from = Number.isFinite(fromMs) ? new Date(Math.max(fromMs, nowMs - 1)) : new Date(nowMs);
      return cron.nextRun(from)?.getTime() ?? null;
    } catch {
      return null;
    }
  }

  /** Another run of the schedule is starting: a pending retry of an earlier occurrence is superseded by it. */
  private supersedeRetry(schedule: Schedule, runId: string): void {
    const pending = this.db.getRetry(schedule.id);
    if (!pending || pending.run_id === runId) return;
    if (!this.endRetry(pending)) return;
    this.onRetryDropped(schedule, pending, "superseded");
  }

  private consumeOneShotAfterRetry(scheduleId: string): void {
    const schedule = this.db.get(scheduleId);
    if (!schedule?.at || this.executing.has(scheduleId)) return;
    this.stopJob(scheduleId);
    try { this.db.delete(scheduleId); } catch { /* scheduler may be shutting down */ }
  }

  private armRetry(retry: ScheduleRetry): void {
    const existing = this.retryTimers.get(retry.schedule_id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, retry.due_at_ms - Date.now());
    const timer = setTimeout(() => {
      this.retryTimers.delete(retry.schedule_id);
      if (delay > Scheduler.MAX_TIMEOUT_MS) { this.armRetry(retry); return; }   // a long wait, in chunks
      this.fireRetry(retry.schedule_id, retry.run_id);
    }, Math.min(delay, Scheduler.MAX_TIMEOUT_MS));
    this.retryTimers.set(retry.schedule_id, timer);
  }

  private fireRetry(scheduleId: string, runId: string): void {
    const retry = this.db.getRetry(scheduleId);
    if (!retry || retry.run_id !== runId) return;              // superseded or replaced meanwhile
    const schedule = this.db.get(scheduleId);
    if (!schedule || !schedule.enabled) { this.endRetry(retry); return; }
    if (Date.now() >= retry.deadline_ms) {
      // A deadline reached while waiting (a clock jump, a long suspend): never run at or after it.
      if (this.endRetry(retry)) this.onRetryDropped(schedule, retry, this.deadlineDrop(retry));
      return;
    }
    if (this.executing.has(scheduleId)) {
      this.armRetry({ ...retry, due_at_ms: Date.now() + Scheduler.ONE_SHOT_FAILURE_RETRY_MS });
      return;
    }
    this.runWithLock(schedule, retry.run_id, retry);
  }

  private registerAllJobs(): void {
    for (const schedule of this.db.list()) {
      if (schedule.enabled) {
        this.registerJob(schedule);
      }
    }
    // #1426: pending retries survive a restart (and a reload): re-armed from what was persisted.
    for (const retry of this.db.listRetries()) this.armRetry(retry);
  }

  private registerJob(schedule: Schedule): void {
    if (schedule.at) {
      this.registerOneShot(schedule);
      return;
    }
    if (!schedule.cron) return;
    const job = new Cron(schedule.cron, { timezone: schedule.timezone }, currentJob => {
      const current = this.db.get(schedule.id);
      if (!current || !current.enabled) return;
      // Skip if a previous fire (or manual trigger) is still in flight —
      // avoids overlapping runs of the same schedule.
      if (this.executing.has(current.id)) return;
      // currentRun() is callback wall-clock time, not the cron occurrence. A
      // delayed callback must still use the scheduled instant so restart
      // catch-up derives the same durable outbox key.
      const runId = this.cronRunAtOrBefore(currentJob, new Date())?.toISOString() ?? null;
      if (runId) this.runWithLock(current, runId);
    });
    this.jobs.set(schedule.id, job);
  }

  /** Return the latest actual cron occurrence at or before the observation. */
  private cronRunAtOrBefore(cron: Cron, observedAt: Date): Date | null {
    // Croner enumerates previous runs strictly before its reference and drops
    // milliseconds. Advance to the following whole second so an occurrence in
    // the observed second remains eligible, while never selecting a future
    // occurrence for seconds-based schedules.
    const exclusiveBoundary = Math.floor(observedAt.getTime() / 1_000) * 1_000 + 1_000;
    return cron.previousRuns(1, new Date(exclusiveBoundary))[0] ?? null;
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
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private registerOneShot(schedule: Schedule, retryDelayMs = 0): void {
    const atMs = this.parseAt(schedule.at!);
    const arm = () => {
      const current = this.db.get(schedule.id);
      if (!current || !current.enabled || !current.at) {
        this.oneShotTimers.delete(schedule.id);
        return;
      }
      const remaining = Math.max(atMs - Date.now(), retryDelayMs);
      if (remaining > Scheduler.MAX_TIMEOUT_MS) {
        const timer = setTimeout(arm, Scheduler.MAX_TIMEOUT_MS);
        this.oneShotTimers.set(schedule.id, timer);
        return;
      }
      const timer = setTimeout(() => {
        this.oneShotTimers.delete(schedule.id);
        const due = this.db.get(schedule.id);
        if (!due || !due.enabled || !due.at || this.executing.has(due.id)) return;
        this.runWithLock(due, new Date(atMs).toISOString());
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
