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
      const first = out.trim().split("\n")[0];
      resolve(code === 0 && first ? first : null);   // the answer first, then the exit
      markExited();
    });
  });
  answer.catch(() => { /* the caller reads it through `answer` */ });
  return { answer, exited, kill: () => { try { child?.kill("SIGKILL"); } catch { /* already gone */ } } };
}

/** One probe child and what it has said: subscribed to once, at spawn, however many callers wait on it. */
interface Slot {
  /** Spawn order: a fresh probe accepts only a child spawned after it asked. */
  seq: number;
  child: ProbeChild;
  answer: ProbeResult | undefined;
  exited: boolean;
  /** Callers waiting for this child to answer or exit; each removes itself when woken or at its own deadline. */
  waiters: Set<() => void>;
}

/**
 * Probe answers per binary, reused for BINARY_PROBE_TTL_MS (monotonic clock); concurrent probes of one binary share
 * one answer. `fresh: true` wants a lookup that starts after it asked (an install just ran): it skips the cached and
 * the shared answer and accepts only a child spawned after its request, waiting (within its own deadline) for an older
 * child of that binary to exit first. Callers that waited together share the next child. An answer is accepted only
 * while the caller's deadline holds; the newest caller of a binary stores it, `invalidate()` discards what running
 * probes learn, and an unknown answer is never cached.
 *
 * Bounded state (#1498 review): each child is subscribed to once, at spawn (its answer, its exit, and one kill timer at
 * the deadline); a waiting caller is a removable entry with its own timer, gone when it is woken or its deadline
 * passes. A child that never exits keeps its reservation (one per binary, PROBE_MAX_RUNNING in all), not the callers.
 */
export class BinaryProbe {
  private cache = new Map<string, { at: number; path: string | null }>();
  private shared = new Map<string, Promise<ProbeResult>>();
  private newest = new Map<string, object>();
  private running = new Map<string, Slot>();
  private spawnSeq = 0;

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
    const minSeq = opts.fresh ? this.spawnSeq + 1 : 0;
    const result = this.attempt(binary, token, minSeq, this.now() + this.deadlineMs).catch((): ProbeResult => UNKNOWN);
    this.shared.set(binary, result);
    void result.then(() => { if (this.shared.get(binary) === result) this.shared.delete(binary); });
    return result;
  }

  /** Probe children not yet exited, stuck ones included: the physical cost the limits bound. */
  get runningCount(): number { return this.running.size; }

  /** Forget every answer (or one binary's); probes already running will not store theirs. */
  invalidate(binary?: string): void {
    for (const map of [this.cache, this.shared, this.newest] as Map<string, unknown>[]) {
      if (binary === undefined) map.clear(); else map.delete(binary);
    }
  }

  private async attempt(binary: string, token: object, minSeq: number, deadline: number): Promise<ProbeResult> {
    let target: Slot | undefined;
    for (;;) {
      // Re-checked on every step, so also when an answer is taken: one that arrives after the caller's deadline is not
      // an answer, whichever of its event and the deadline timer ran first (#1498 review).
      if (this.now() >= deadline) return UNKNOWN;
      if (target) {
        if (target.answer) return this.accept(binary, token, target.answer);
        if (!(await this.waitOn(target, deadline))) return UNKNOWN;
        continue;
      }
      const slot = this.running.get(binary);
      if (slot && slot.seq >= minSeq) { target = slot; continue; }            // started after we asked: share it
      if (slot) { if (!(await this.waitOn(slot, deadline))) return UNKNOWN; continue; }   // an older child: let it go
      if (this.running.size >= this.maxRunning) return UNKNOWN;
      target = this.spawnSlot(binary);
    }
  }

  /** The answer, taken (and stored by the newest caller); the loop has re-checked the caller's deadline just before. */
  private accept(binary: string, token: object, answer: ProbeResult): ProbeResult {
    if (answer.known && this.newest.get(binary) === token) this.cache.set(binary, { at: this.now(), path: answer.path });
    return answer;
  }

  private spawnSlot(binary: string): Slot {
    const slot: Slot = { seq: ++this.spawnSeq, child: this.spawnProbe(binary), answer: undefined, exited: false, waiters: new Set() };
    this.running.set(binary, slot);
    const wake = () => { for (const waiter of [...slot.waiters]) waiter(); };
    // No answer by the deadline: kill it. It stays reserved until it has actually exited.
    const kill = setTimeout(() => { if (!slot.answer) slot.child.kill(); }, this.deadlineMs);
    kill.unref?.();
    const answered = slot.child.answer.then((path): ProbeResult => ({ known: true, path }), (): ProbeResult => UNKNOWN);
    void answered.then((answer) => {
      clearTimeout(kill);
      slot.answer ??= answer;
      wake();
    });
    // An answer that settled before the exit is the answer; a child that exits without one answered unknown.
    void slot.child.exited.then(() => Promise.race([answered, Promise.resolve(UNKNOWN)])).then((answer) => {
      clearTimeout(kill);
      slot.exited = true;
      slot.answer ??= answer;
      if (this.running.get(binary) === slot) this.running.delete(binary);
      wake();
    });
    return slot;
  }

  /** Until this child answers or exits (true), or the deadline passes (false); the caller is then forgotten. */
  private waitOn(slot: Slot, deadline: number): Promise<boolean> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (woken: boolean) => { clearTimeout(timer); slot.waiters.delete(wake); resolve(woken); };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), remaining);
      timer.unref?.();
      slot.waiters.add(wake);
    });
  }
}

/** The fleet process's shared probe. */
export const binaryProbe = new BinaryProbe();
