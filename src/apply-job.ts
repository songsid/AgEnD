/**
 * A Settings "Apply" that the user can watch, and that survives the restart it
 * asks for.
 *
 * The old path was `POST /api/settings/reload` → SIGHUP → nothing. The page said
 * "changes applied" the moment the signal was sent, while the reconcile was
 * still stopping and starting agents behind it, and a change that restarts AgEnD
 * itself killed the only place the answer lived.
 *
 * Two properties carry the whole design:
 *
 * 1. **The job is on disk, not in the process.** A fleet-impact change takes the
 *    fleet process down with it. An in-memory job dies there, `GET` starts
 *    answering 404, and the page shows "restarting…" forever (#722/#748 are the
 *    same shape). The replacement process reads the marker, settles whatever was
 *    still in flight, and can answer for a job it never started.
 * 2. **The client owns the idempotency key.** A server-minted job id cannot stop
 *    a duplicate: on a phone the POST leaves, the answer never arrives, and the
 *    retry is a second request the server has no way to recognise. A key the
 *    client generates before the first attempt makes the retry identifiable, so
 *    it returns the original job instead of applying everything twice.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const FILE = "settings-apply-jobs.json";

/** How long a finished job stays answerable, and how long a key is honoured. */
export const APPLY_JOB_RETENTION_MS = 30 * 60_000;
/**
 * Wall clock, not a step count: the user is looking at a spinner, and the thing
 * they need to be told is that it has been N seconds, not which internal phase
 * it is in. Generous — a reconcile that restarts several agents on a loaded
 * machine is slow but fine.
 */
export const APPLY_JOB_DEADLINE_MS = 120_000;
/** At most this many jobs are kept, newest first. */
const MAX_JOBS = 20;

/** Outcome of asking the fleet to restart itself for a Settings change. */
export type SelfRestartResult =
  | { ok: true; jobId: string; reused?: boolean }
  | { ok: false; status: 409 | 429 | 503; error: string; retryAfterSeconds?: number };

/** The row for the fleet process itself, as opposed to one of its agents. */
export const APPLY_FLEET_TARGET = "fleet";

export type ApplyTargetKind = "hot" | "restart";
/**
 * `restart-required` is a terminal state, not a stalled one: the change is saved
 * and valid, and a running fleet process cannot adopt it. Reporting it as done
 * would tell the user AgEnD is on the new configuration when it is not.
 */
export type ApplyTargetStatus = "pending" | "running" | "done" | "failed" | "restart-required";
export type ApplyJobStatus = "running" | "done" | "failed";

export interface ApplyTarget {
  /** Instance name, or `fleet` for the process-level row. */
  target: string;
  kind: ApplyTargetKind;
  status: ApplyTargetStatus;
  error?: string;
  /**
   * Who finished the row, when it was not this job's own work:
   * `fleet-restart` — a process restart applied it;
   * `no-change`     — the plan expected work the reconcile found unnecessary.
   */
  settled_by?: "fleet-restart" | "no-change";
}

export interface ApplyJob {
  id: string;
  /** The client's idempotency key. */
  key: string;
  status: ApplyJobStatus;
  startedAt: number;
  finishedAt?: number;
  targets: ApplyTarget[];
  /** Deadline for "still working" messaging; it never cancels the work. */
  deadlineMs: number;
  /** The process that created the job, so a restart is detectable. */
  pid: number;
  error?: string;
  /**
   * The idempotency key of the self-restart this job's fleet row was consumed
   * by. Stored on the job rather than in memory because the process it belongs
   * to is about to be replaced — a retry after the restart has to find it.
   */
  restart_key?: string;
}

interface JobFile {
  jobs: ApplyJob[];
}

function isTerminal(status: ApplyJobStatus): boolean {
  return status === "done" || status === "failed";
}

/** Everything a caller needs to render, computed rather than stored so it stays
 * true while the job is being read long after the last write. */
export interface ApplyJobView extends ApplyJob {
  elapsed_ms: number;
  /** Past the deadline and still working — say so instead of spinning silently. */
  overdue: boolean;
  /** Human sentence for the overdue case; empty otherwise. */
  message: string;
}

export function viewOf(job: ApplyJob, now = Date.now()): ApplyJobView {
  const elapsed = Math.max(0, (job.finishedAt ?? now) - job.startedAt);
  const overdue = !isTerminal(job.status) && elapsed > job.deadlineMs;
  return {
    ...job,
    elapsed_ms: elapsed,
    overdue,
    message: overdue ? `Still restarting (${Math.round(elapsed / 1000)}s)` : "",
  };
}

/**
 * The jobs file. Small, rewritten whole on every transition — a settings apply
 * happens at human speed, so the simplest durable thing is the right one.
 */
/** Just enough of a logger for the one thing this module has to report. */
export interface ApplyJobLogger {
  warn(data: unknown, message: string): void;
}

export class ApplyJobStore {
  private jobs: ApplyJob[] = [];

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly logger?: ApplyJobLogger,
  ) {
    this.jobs = this.read();
  }

  private path(): string {
    return join(this.dataDir, FILE);
  }

  private read(): ApplyJob[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path(), "utf-8")) as Partial<JobFile>;
      if (!Array.isArray(parsed.jobs)) return [];
      return parsed.jobs.filter(job =>
        typeof job?.id === "string"
        && typeof job?.key === "string"
        && typeof job?.startedAt === "number"
        && Array.isArray(job?.targets));
    } catch {
      // Missing or corrupt: an unreadable history must not stop the user from
      // applying settings.
      return [];
    }
  }

  private write(): void {
    const path = this.path();
    const temp = `${path}.${process.pid}.${this.now()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ jobs: this.jobs } satisfies JobFile), { mode: 0o600 });
      renameSync(temp, path);
    } catch (err) {
      try { unlinkSync(temp); } catch { /* never created */ }
      // A full or read-only data dir means this job will not survive a restart.
      // Swallowing that silently is how the symptom becomes "progress just
      // vanished" with nothing to look at.
      this.logger?.warn({ err, path }, "Settings apply job could not be persisted");
    }
  }

  private prune(): void {
    const cutoff = this.now() - APPLY_JOB_RETENTION_MS;
    this.jobs = this.jobs
      .filter(job => (job.finishedAt ?? job.startedAt) >= cutoff)
      .slice(0, MAX_JOBS);
  }

  /**
   * A job created in an earlier process cannot still be running in this one.
   *
   * The restart is what applied the config: every agent came up from the saved
   * file. So rows left pending or running are done — recorded as settled by the
   * restart rather than by the job, because "who finished this" is exactly what
   * the user is trying to find out.
   */
  settleAfterRestart(): ApplyJob[] {
    const settled: ApplyJob[] = [];
    for (const job of this.jobs) {
      if (isTerminal(job.status)) continue;
      // Only a job from another process. The health server accepts requests a
      // little before startup finishes, so an apply started seconds ago in THIS
      // process would otherwise be declared finished by a restart that already
      // happened. (A recycled pid would leave such a job running until its
      // deadline reports it — the harmless direction.)
      if (job.pid === process.pid) continue;
      for (const row of job.targets) {
        if (row.status === "done" || row.status === "failed") continue;
        row.status = "done";
        row.settled_by = "fleet-restart";
      }
      job.status = "done";
      job.finishedAt = this.now();
      settled.push(job);
    }
    if (settled.length) this.write();
    return settled;
  }

  get(id: string): ApplyJob | null {
    return this.jobs.find(job => job.id === id) ?? null;
  }

  /** The job whose fleet row a given self-restart key already consumed. */
  findByRestartKey(key: string): ApplyJob | null {
    return this.jobs.find(job => job.restart_key === key) ?? null;
  }

  /** The live job for a key, if the client is retrying rather than re-applying. */
  findByKey(key: string): ApplyJob | null {
    const cutoff = this.now() - APPLY_JOB_RETENTION_MS;
    return this.jobs.find(job => job.key === key && (job.finishedAt ?? job.startedAt) >= cutoff) ?? null;
  }

  create(key: string, targets: Array<Pick<ApplyTarget, "target" | "kind">>, deadlineMs = APPLY_JOB_DEADLINE_MS): ApplyJob {
    const job: ApplyJob = {
      id: randomUUID(),
      key,
      status: "running",
      startedAt: this.now(),
      targets: targets.map(row => ({ ...row, status: "pending" })),
      deadlineMs,
      pid: process.pid,
    };
    this.jobs.unshift(job);
    this.prune();
    this.write();
    return job;
  }

  /** Mutate one job and persist. Every transition hits the disk, because the
   * transition we care most about is the last one before the process dies. */
  update(id: string, mutate: (job: ApplyJob) => void): ApplyJob | null {
    const job = this.get(id);
    if (!job) return null;
    mutate(job);
    this.write();
    return job;
  }

  setTargetStatus(id: string, target: string, status: ApplyTargetStatus, error?: string): void {
    this.update(id, job => {
      const row = job.targets.find(item => item.target === target);
      if (!row) return;
      row.status = status;
      if (error) row.error = error;
    });
  }

  finish(id: string, error?: string): void {
    this.update(id, job => {
      for (const row of job.targets) {
        if (row.status !== "pending" && row.status !== "running") continue;
        if (error) { row.status = "failed"; row.error = error; continue; }
        // The plan forecast work the reconcile then found unnecessary. Saying
        // plain "done" would read as "this agent was restarted".
        row.status = "done";
        row.settled_by = "no-change";
      }
      job.status = error ? "failed" : job.targets.some(row => row.status === "failed") ? "failed" : "done";
      job.finishedAt = this.now();
      if (error) job.error = error;
    });
  }

  /** Test/introspection seam. */
  all(): ApplyJob[] {
    return this.jobs;
  }
}
