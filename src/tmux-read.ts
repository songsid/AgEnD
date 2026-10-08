import { execFile, type ChildProcess } from "node:child_process";
import { measureSyncWork } from "./sync-work-attribution.js";

export const TMUX_READ_MAX_BYTES = 1024 * 1024;
export const TMUX_READ_QUEUE_LIMIT = 256;
export const TMUX_CONTROL_ATTEMPT_MS = 2_000;
export const TMUX_FALLBACK_CHILDREN = 2;

/** Internal read operations only. No arbitrary command/format capability. */
export type TmuxReadQuery = { session: string } & (
  | { kind: "capture"; window: string; history?: number; joined?: boolean }
  | { kind: "windows" }
  | { kind: "pane"; window: string; field: "id" | "status" | "pid" }
  | { kind: "tty"; window: string }
);

export interface TmuxReadPort {
  isFor(session: string, socket: string | null): boolean;
  read(query: TmuxReadQuery, timeoutMs?: number): Promise<string>;
}

export class TmuxReadError extends Error {
  constructor(readonly kind: "transport" | "command" | "limit" | "timeout" | "stopped", message: string) {
    super(message);
  }
}

export function tmuxReadArgs(query: TmuxReadQuery): string[] {
  const target = "window" in query ? `${query.session}:${query.window}` : query.session;
  if (/[\x00-\x1f\x7f]/u.test(target)) throw new TmuxReadError("command", "Invalid tmux read target");
  switch (query.kind) {
    case "windows": return ["list-windows", "-t", target, "-F", "#{window_id}|||#{window_name}"];
    case "pane": return ["list-panes", "-t", target, "-F", {
      id: "#{pane_id}", status: "#{pane_dead} #{pane_dead_status}", pid: "#{pane_pid}",
    }[query.field]];
    case "tty": return ["display-message", "-p", "-t", target, "#{pane_tty}"];
    case "capture": {
      const args = ["capture-pane", "-t", target, "-p"];
      if (query.joined) args.push("-J");
      if (query.history !== undefined) {
        if (!Number.isSafeInteger(query.history)) throw new TmuxReadError("command", "Invalid tmux history size");
        args.push("-S", `-${query.history}`);
      }
      return args;
    }
  }
}

/** tmux's command lexer, not a shell: quoted parts concatenate into one token. */
export function tmuxCommandToken(value: string): string {
  if (/[\x00-\x1f\x7f]/u.test(value)) throw new TmuxReadError("command", "Invalid tmux command token");
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface ReadJob {
  args: string[];
  deadline: number;
  lifetime: number;
  resolve: (output: string) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  done: boolean;
  child?: ChildProcess;
}

interface ControlReadTransport {
  ready(): boolean;
  execute(args: string[], deadline: number): Promise<string>;
  retire(): void;
}

function killReadChild(child?: ChildProcess): void {
  try { child?.kill(); } catch { /* physical ownership still waits for exit */ }
}

/** One logical FIFO shared by control and fallback; physical children can outlive a job. */
export class TmuxReadLane {
  private jobs: ReadJob[] = [];
  private active: ReadJob | null = null;
  private physical = new Set<ReadJob>();
  private stopped = false;
  private lifetime = 0;

  constructor(private socket: string | null, private control: ControlReadTransport) {}

  start(): void { this.stopped = false; }
  wake(): void { this.pump(); }

  stop(): void {
    this.stopped = true;
    this.lifetime++;
    for (const job of [this.active, ...this.jobs]) {
      if (job) this.finish(job, new TmuxReadError("stopped", "tmux read client stopped"));
    }
    for (const job of this.physical) killReadChild(job.child);
  }

  read(args: string[], timeoutMs: number): Promise<string> {
    if (this.stopped) return Promise.reject(new TmuxReadError("stopped", "tmux read client stopped"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TmuxReadError("timeout", "tmux read deadline expired"));
    if (this.jobs.length + Number(this.active !== null) >= TMUX_READ_QUEUE_LIMIT) {
      return Promise.reject(new TmuxReadError("limit", "tmux read queue full"));
    }
    return new Promise((resolve, reject) => {
      const job = {
        args, deadline: performance.now() + timeoutMs, lifetime: this.lifetime, resolve, reject, done: false,
      } as ReadJob;
      job.timer = setTimeout(() => {
        if (this.active === job && !job.child) this.control.retire();
        killReadChild(job.child);
        this.finish(job, new TmuxReadError("timeout", "tmux read deadline expired"));
      }, Math.max(1, Math.floor(timeoutMs)));
      this.jobs.push(job);
      this.pump();
    });
  }

  private current(job: ReadJob): boolean {
    return !job.done && !this.stopped && job.lifetime === this.lifetime && performance.now() < job.deadline;
  }

  private finish(job: ReadJob, error?: unknown, output = ""): void {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    this.jobs = this.jobs.filter(item => item !== job);
    if (this.active === job) this.active = null;
    if (error) job.reject(error); else job.resolve(output);
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.active) return;
    const job = this.jobs[0];
    if (!job) return;
    if (!this.current(job)) {
      this.finish(job, new TmuxReadError("timeout", "tmux read deadline expired"));
      return;
    }
    if (!this.control.ready() && this.physical.size >= TMUX_FALLBACK_CHILDREN) return;
    this.jobs.shift();
    this.active = job;
    void this.run(job);
  }

  private async run(job: ReadJob): Promise<void> {
    if (this.control.ready()) {
      try {
        const remaining = job.deadline - performance.now();
        const attempt = performance.now() + Math.min(TMUX_CONTROL_ATTEMPT_MS, remaining / 2);
        const result = await this.control.execute(job.args, attempt);
        if (!this.current(job)) throw new TmuxReadError("timeout", "tmux read deadline expired");
        this.finish(job, undefined, result);
        return;
      } catch (error) {
        if (job.done) return;
        if (!(error instanceof TmuxReadError) || error.kind !== "transport") {
          this.finish(job, error);
          return;
        }
      }
    }
    if (!this.current(job)) {
      this.finish(job, new TmuxReadError("timeout", "tmux read deadline expired"));
      return;
    }
    // A timed-out fallback child keeps its physical slot until actual exit.
    if (this.physical.size >= TMUX_FALLBACK_CHILDREN) {
      this.active = null;
      this.jobs.unshift(job);
      return;
    }
    this.physical.add(job);
    const release = () => { this.physical.delete(job); this.pump(); };
    try {
      const args = this.socket ? ["-L", this.socket, ...job.args] : job.args;
      const child = measureSyncWork("tmux.spawn", () => execFile("tmux", args, {
        timeout: Math.max(1, Math.floor(job.deadline - performance.now())), maxBuffer: TMUX_READ_MAX_BYTES,
      }, (error, stdout) => {
        // execFile's callback proves completion; mock callbacks can be synchronous.
        release();
        if (job.done) return;
        if (!this.current(job)) this.finish(job, new TmuxReadError("timeout", "tmux read deadline expired"));
        else this.finish(job, error ? new TmuxReadError("command", "tmux fallback read failed") : undefined, String(stdout));
      }));
      job.child = child;
      child?.once("exit", release);
      child?.once("close", release);
      if (job.done && this.physical.has(job)) killReadChild(child);
    } catch (error) {
      release(); // native spawn threw before returning a child
      this.finish(job, error);
    }
  }
}
