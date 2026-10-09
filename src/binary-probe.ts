import { spawn } from "node:child_process";

/**
 * Whether a backend's executable is on PATH, without blocking the fleet (#1490).
 *
 * `/ui/backends` used to run `execFileSync("which", …)` seven times per request, each with a 2 s timeout, on the fleet's
 * event loop: up to ~14 s of blocking per request on a slow or broken PATH. The same `which` now runs as an
 * asynchronous child process. Not an in-process fs walk: on a dead network mount `access`/`stat` can stay pending
 * forever, each one holding a thread of the libuv pool the whole process shares (fs, DNS, crypto), and nothing can
 * cancel it (#1498 review). A child is outside that pool and can be killed.
 *
 * Every probe answers within PROBE_DEADLINE_MS: the path, null (not on PATH), or unknown (no answer in time, `which`
 * could not run, or no probe could be admitted). A child counts as running until it has actually exited, not until
 * its deadline: at most one per binary and PROBE_MAX_RUNNING in all, so a PATH that hangs every lookup costs a fixed
 * number of stuck processes, never one per request.
 */

export type ProbeResult = { known: true; path: string | null } | { known: false };

/** A running probe: its answer (path or null), a kill switch, and proof that the process is gone. */
export interface ProbeChild {
  answer: Promise<string | null>;
  kill(): void;
  exited: Promise<void>;
}

/** How long a known answer is reused: long enough that a polled route rarely probes, short enough to see installs. */
export const BINARY_PROBE_TTL_MS = 30_000;
/** The old synchronous lookup's timeout, now a deadline on the answer instead of a block on the event loop. */
export const PROBE_DEADLINE_MS = 2_000;
/** Probe processes that may exist at once, stuck ones included (the backend catalog has seven binaries). */
export const PROBE_MAX_RUNNING = 8;

const UNKNOWN: ProbeResult = { known: false };

/** `which <binary>` as a child process. */
export function spawnWhich(binary: string): ProbeChild {
  return spawnProbeCommand("which", [binary]);
}

/**
 * One probe process: exit 0 with output → the first line, any other exit → null, failing to start → rejection.
 * `exited` settles on `close` (or a spawn that never produced a process). Exported so tests can run one that hangs.
 */
export function spawnProbeCommand(command: string, args: string[]): ProbeChild {
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => { markExited = resolve; });
  let child: ReturnType<typeof spawn> | undefined;
  const answer = new Promise<string | null>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    child = proc;
    let out = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => { if (out.length < 4096) out += chunk; });
    proc.once("error", (error) => {
      reject(error);
      if (proc.pid === undefined) markExited();
    });
    proc.once("close", (code) => {
      markExited();
      const first = out.trim().split("\n")[0];
      resolve(code === 0 && first ? first : null);
    });
  });
  answer.catch(() => { /* the caller reads it through `answer` */ });
  return { answer, exited, kill: () => { try { child?.kill("SIGKILL"); } catch { /* already gone */ } } };
}

/**
 * Probe answers per binary, reused for BINARY_PROBE_TTL_MS (monotonic clock); concurrent probes of one binary share
 * one answer. `fresh: true` wants a lookup that starts now (an install just ran): it skips the cached and the shared
 * answer and, if that binary's previous child is still running, waits for it to exit within its own deadline. Only
 * the newest probe of a binary stores its answer, `invalidate()` discards what running probes learn, and an unknown
 * answer is never cached.
 */
export class BinaryProbe {
  private cache = new Map<string, { at: number; path: string | null }>();
  private shared = new Map<string, Promise<ProbeResult>>();
  private newest = new Map<string, object>();
  /** The child per binary until it exits, with the answer it is producing (for a probe that waited on its predecessor). */
  private running = new Map<string, { child: ProbeChild; result: Promise<ProbeResult> }>();

  constructor(
    private readonly spawnProbe: (binary: string) => ProbeChild = spawnWhich,
    private readonly now: () => number = () => performance.now(),
    private readonly ttlMs = BINARY_PROBE_TTL_MS,
    private readonly deadlineMs = PROBE_DEADLINE_MS,
    private readonly maxRunning = PROBE_MAX_RUNNING,
  ) {}

  /** Never rejects; settles within the deadline. */
  probe(binary: string, opts: { fresh?: boolean } = {}): Promise<ProbeResult> {
    if (!opts.fresh) {
      const joined = this.shared.get(binary);
      if (joined) return joined;
      const cached = this.cache.get(binary);
      if (cached && this.now() - cached.at < this.ttlMs) return Promise.resolve({ known: true, path: cached.path });
    }
    const token = {};
    this.newest.set(binary, token);
    const result = this.attempt(binary, token).catch((): ProbeResult => UNKNOWN);
    this.shared.set(binary, result);
    void result.then(() => { if (this.shared.get(binary) === result) this.shared.delete(binary); });
    return result;
  }

  /** Probe processes not yet exited, stuck ones included: the physical cost the limits bound. */
  get runningCount(): number { return this.running.size; }

  /** Forget every answer (or one binary's); probes already running will not store theirs. */
  invalidate(binary?: string): void {
    for (const map of [this.cache, this.shared, this.newest] as Map<string, unknown>[]) {
      if (binary === undefined) map.clear(); else map.delete(binary);
    }
  }

  private async attempt(binary: string, token: object): Promise<ProbeResult> {
    const deadline = this.now() + this.deadlineMs;
    const previous = this.running.get(binary);
    if (previous && (await this.within(previous.child.exited.then(() => true), deadline)) === undefined) return UNKNOWN;
    // Another probe that waited with this one started a child after both asked: its answer is fresh enough for both.
    const started = this.running.get(binary);
    if (started) return (await this.within(started.result, deadline)) ?? UNKNOWN;
    if (this.running.size >= this.maxRunning) return UNKNOWN;

    const child = this.spawnProbe(binary);
    const result = child.answer.then((path): ProbeResult => ({ known: true, path }), (): ProbeResult => UNKNOWN);
    const entry = { child, result };
    this.running.set(binary, entry);
    void child.exited.then(() => { if (this.running.get(binary) === entry) this.running.delete(binary); });
    const answer = await this.within(result, deadline);
    if (answer === undefined) { child.kill(); return UNKNOWN; }   // it stays counted as running until it exits
    if (answer.known && this.newest.get(binary) === token) this.cache.set(binary, { at: this.now(), path: answer.path });
    return answer;
  }

  /** The promise's value if it settles before the deadline, else undefined. */
  private within<T>(promise: Promise<T>, deadline: number): Promise<T | undefined> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), remaining);
      timer.unref?.();
      promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
    });
  }
}

/** The fleet process's shared probe. */
export const binaryProbe = new BinaryProbe();
