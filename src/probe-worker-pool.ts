/** A caller can time out before its isolate has actually stopped. */
export interface ProbeWorker<T> {
  promise: Promise<T | null>;
  stopped: Promise<void>;
  terminate(): void;
}

interface Job {
  key: string;
  start: () => ProbeWorker<unknown>;
  resolve: (value: unknown | null) => void;
  onTimeout?: () => void;
  onError?: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  handle?: ProbeWorker<unknown>;
  settled: boolean;
  deadlineAt: number;
}

/** Shared admission limit, including workers still completing termination. */
export class ProbeWorkerPool {
  private queued: Job[] = [];
  private active = new Set<Job>();
  private activeKeys = new Set<string>();
  private closed = false;

  constructor(private readonly concurrency = 2) {}

  run<T>(key: string, start: () => ProbeWorker<T>, options: {
    deadlineMs: number;
    onTimeout?: () => void;
    onError?: (error: unknown) => void;
  }): Promise<T | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => {
      const job: Job = { key, start, resolve: value => resolve(value as T | null),
        onTimeout: options.onTimeout, onError: options.onError, settled: false,
        deadlineAt: performance.now() + options.deadlineMs };
      // Includes queue time: commands retain their existing response deadline.
      job.timer = setTimeout(() => {
        this.expire(job);
        this.pump();
      }, options.deadlineMs);
      this.queued.push(job);
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    for (const job of [...this.queued, ...this.active]) {
      this.settle(job, null);
      this.cancel(job);
    }
    this.queued = [];
  }

  /** Restart keeps old physical reservations until those isolates stop. */
  reopen(): void { this.closed = false; }

  private expire(job: Job): void {
    if (job.settled) return;
    this.settle(job, null);
    try { job.onTimeout?.(); } catch { /* logging must not break cancellation */ }
    this.cancel(job);
  }

  private cancel(job: Job): void {
    try { job.handle?.terminate(); }
    catch (error) {
      try { job.onError?.(error); } catch { /* keep the occupied slot */ }
    }
  }

  private settle(job: Job, result: unknown | null): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.resolve(result);
  }

  private release(job: Job): void {
    if (!this.active.delete(job)) return;
    this.activeKeys.delete(job.key);
    this.pump();
  }

  private pump(): void {
    this.queued = this.queued.filter(job => {
      // Releasing a worker can run between two due timer callbacks. Recheck
      // the clock so an already-expired queued job is never briefly spawned.
      if (!job.settled && performance.now() >= job.deadlineAt) this.expire(job);
      return !job.settled;
    });
    while (!this.closed && this.active.size < this.concurrency) {
      // Ordinary/vendor flights remain distinct, but never write the same
      // backend's account cache concurrently. Other backends can progress.
      const index = this.queued.findIndex(job => !this.activeKeys.has(job.key));
      if (index < 0) return;
      const job = this.queued.splice(index, 1)[0]!;
      // An earlier constructor can consume the remaining time before failing.
      // Recheck every admission even if its deadline timer has not run yet.
      if (performance.now() >= job.deadlineAt) {
        this.expire(job);
        continue;
      }
      this.active.add(job);
      this.activeKeys.add(job.key);
      try {
        const handle = job.handle = job.start();
        handle.promise.then(value => {
          if (performance.now() >= job.deadlineAt) this.expire(job);
          else this.settle(job, value);
        }, error => {
          try { job.onError?.(error); } catch { /* diagnostics are best effort */ }
          this.settle(job, null);
          this.cancel(job);
        });
        // A timed-out result does NOT free the physical worker slot.
        handle.stopped.then(() => this.release(job), error => {
          try { job.onError?.(error); } catch { /* keep the occupied slot */ }
        });
      } catch (error) {
        try { job.onError?.(error); } catch { /* diagnostics are best effort */ }
        this.settle(job, null);
        this.active.delete(job);
        this.activeKeys.delete(job.key);
      }
    }
  }
}
