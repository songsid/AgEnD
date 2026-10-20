// #1956 item 3: the fleet's tmux (and stty) commands, started by a small helper process instead of the fleet itself.
//
// Node starts a child process by forking the parent synchronously, and that fork costs in proportion to the parent's
// resident memory: on a 550 MB fleet a spawn holds the event loop ~17 ms on an idle host, and ~110 ms (up to 750 ms)
// on a busy one (daemon.log's "tmux.spawn"). The helper is a small node process started once with the fleet; the fleet
// writes a request to its stdin (a pipe write, ~0.05 ms) and the helper's own, cheap fork runs the command.
//
// Semantics are the direct call's: the same file (by absolute path, from an allowlist: tmux and stty), argv, env,
// timeout, maxBuffer and stdin input; the same result ({ stdout, stderr }) or error (code, signal, killed, stdout,
// stderr). Requests run concurrently; a caller that awaits its call before the next keeps its order.
//
// A command never runs twice. The helper writes "started" to its stdout with a synchronous write BEFORE it forks:
//   - a call the helper has not said "started" for may go direct — but only once the helper is gone (killed, and its
//     output read to the end, which carries every "started" it wrote), so it can never start the command later;
//   - a call it has said "started" for is the helper's: its answer, or — if none comes by its deadline — the error a
//     timed-out direct call would give. It is never run again directly.
// A helper taken as wedged while commands it started still run is not killed (that would not stop them, and their calls
// would fail though they ran): it gets no more calls, its stdin is ended, and it exits once they have answered.
// A helper that is not running, or not trusted, is not used: the call goes direct, as before. Only the fleet starts
// and restarts the helper (start/maintain, from its own lifecycle and timer), never a tool handler.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { measureSyncWork } from "./sync-work-attribution.js";

export interface HelperExecOptions {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to the command's stdin, then closed (load-buffer). */
  input?: string;
}
export interface HelperExecResult { stdout: string; stderr: string }
type ExecError = Error & { code?: number | string | null; signal?: string | null; killed?: boolean; cmd?: string; stdout?: string; stderr?: string };

/** The binaries the helper may start (by name; resolved to absolute paths on PATH when the helper starts). */
export const HELPER_BINARIES = ["tmux", "stty"] as const;
/** How long a request may wait for the helper's "started" before the helper is taken as wedged. */
export const HELPER_START_TIMEOUT_MS = 1500;
/** After "started": how long past the command's own timeout its answer may take (no timeout: this alone). */
export const HELPER_ANSWER_GRACE_MS = 5000;
export const HELPER_NO_TIMEOUT_DEADLINE_MS = 120_000;
const RESTART_BACKOFF_MIN_MS = 1000, RESTART_BACKOFF_MAX_MS = 60_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;   // execFile's

/**
 * The helper's program (`node -e`): JSON lines in on stdin, JSON lines out on stdout. It exits when its stdin ends
 * (the fleet went away) or its parent no longer exists (the fleet died while something else held the pipe).
 */
export const HELPER_SOURCE = String.raw`
"use strict";
const { execFile } = require("node:child_process");
const { writeSync } = require("node:fs");
const allow = new Set(JSON.parse(process.argv[1] || "[]"));
const parent = Number(process.argv[2]) || process.ppid;     // the fleet passes none (tests: a given pid)
function send(o) {
  const b = Buffer.from(JSON.stringify(o) + "\n");
  let off = 0;
  while (off < b.length) {
    try { off += writeSync(1, b, off); }
    catch (e) { if (e && e.code === "EAGAIN") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); continue; } process.exit(0); }
  }
}
let running = 0, ending = false;
function finish() { if (ending && running === 0) process.exit(0); }
function handle(line) {
  let r; try { r = JSON.parse(line); } catch { return; }
  if (!r || typeof r.id !== "number") return;
  if (typeof r.file !== "string" || !allow.has(r.file) || !Array.isArray(r.args)) return send({ id: r.id, refused: "not-allowed" });
  send({ id: r.id, started: true });                          // in the pipe before the fork: see the fleet side
  let child;
  running++;
  try {
    child = execFile(r.file, r.args, { timeout: r.timeout || 0, maxBuffer: r.maxBuffer || 1048576, env: r.env || process.env, encoding: "utf8" },
      (err, stdout, stderr) => {
        send({ id: r.id, done: true, stdout: String(stdout || ""), stderr: String(stderr || ""),
          error: err ? { message: err.message, code: err.code === undefined ? null : err.code, signal: err.signal || null, killed: !!err.killed } : null });
        running--; finish();
      });
  } catch (e) {
    running--;
    send({ id: r.id, done: true, stdout: "", stderr: "", error: { message: String(e && e.message || e), code: e && e.code || null, signal: null, killed: false } });
    return finish();
  }
  if (typeof r.input === "string") {
    if (child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(r.input); }
  }
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handle(line); } });
// Its stdin ended (the fleet stopped, or no longer trusts it): every request has been read; it exits once the commands
// it started have answered.
process.stdin.on("end", () => { ending = true; finish(); });
process.stdin.on("close", () => { ending = true; finish(); });
// Its parent gone (the fleet died while something else holds the pipe): process.ppid is read once by node, so ask
// whether that process still exists (ESRCH: it does not).
setInterval(() => { try { process.kill(parent, 0); } catch (e) { if (e && e.code === "ESRCH") process.exit(0); } }, 1000);
`;

/** The absolute path `name` resolves to on this PATH (an executable file), or null. */
export function resolveOnPath(name: string, path: string | undefined): string | null {
  if (isAbsolute(name)) return name;
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

interface Pending {
  id: number;
  started: boolean;
  settled: boolean;
  file: string; abs: string; args: string[]; opts: HelperExecOptions;
  resolve(r: HelperExecResult): void;
  reject(e: unknown): void;
  direct(): void;
  startTimer: ReturnType<typeof setTimeout> | null;
  answerTimer: ReturnType<typeof setTimeout> | null;
}

export interface ExecHelperOptions {
  /** The direct call, used when the helper isn't (or can no longer be) used for a call. */
  direct(file: string, args: string[], opts: HelperExecOptions): Promise<HelperExecResult>;
  /** Start the helper process (tests: another program). */
  spawnHelper?(allow: string[]): ChildProcess;
  /** The PATH binaries are resolved on (default: the fleet's, when the helper starts). */
  path?(): string | undefined;
  now?(): number;
  startTimeoutMs?: number;
  answerGraceMs?: number;
  log?(event: string, detail?: Record<string, unknown>): void;
}

export class ExecHelper {
  private proc: ChildProcess | null = null;
  private allow = new Map<string, string>();               // name → absolute path
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private trusted = false;
  private backoffMs = RESTART_BACKOFF_MIN_MS;
  private restartAt = 0;
  private stopped = false;
  private resolvedPath: { path: string | undefined; byName: Map<string, string | null> } | null = null;
  constructor(private readonly options: ExecHelperOptions) {}

  private now(): number { return this.options.now ? this.options.now() : performance.now(); }

  /** Whether calls go to the helper now. */
  usable(): boolean { return this.trusted && this.proc !== null && !this.stopped; }

  /** Start the helper (the fleet's own start and timer only). */
  start(): void {
    if (this.proc || this.stopped) return;
    const path = this.options.path ? this.options.path() : process.env.PATH;
    this.allow = new Map();
    for (const name of HELPER_BINARIES) { const abs = resolveOnPath(name, path); if (abs) this.allow.set(name, abs); }
    let proc: ChildProcess;
    try {
      proc = this.options.spawnHelper
        ? this.options.spawnHelper([...this.allow.values()])
        : spawn(process.execPath, ["-e", HELPER_SOURCE, JSON.stringify([...this.allow.values()])], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      this.options.log?.("start_failed", { error: (err as Error).message });
      this.scheduleRestart();
      return;
    }
    this.proc = proc;
    this.trusted = true;
    proc.unref();
    (proc.stdin as unknown as { unref?(): void } | null)?.unref?.();
    (proc.stdout as unknown as { unref?(): void } | null)?.unref?.();
    proc.stdin?.on("error", () => this.retire(proc, "stdin_error"));
    const decoder = new StringDecoder("utf8");
    let buf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buf += decoder.write(chunk);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); this.receive(line); }
    });
    // `close`: the process is gone and its stdout read to the end — every "started" it wrote has been seen.
    proc.on("close", () => this.gone(proc));
    proc.on("error", () => this.retire(proc, "process_error"));
  }

  /** The fleet's timer: start a helper that is not running, after the backoff. */
  maintain(): void {
    if (this.stopped || this.proc || this.now() < this.restartAt) return;
    this.start();
  }

  /** A fleet started again after a stop may start the helper again. */
  reopen(): void { this.stopped = false; this.restartAt = 0; this.backoffMs = RESTART_BACKOFF_MIN_MS; }

  /** The fleet is stopping: no more calls go to the helper; its stdin ends, and it exits once its commands have answered. */
  stop(): void {
    this.stopped = true;
    const proc = this.proc;
    if (proc) { this.trusted = false; try { proc.stdin?.end(); } catch { /* gone */ } }
  }

  /**
   * A command, through the helper when it can be used, else directly — exactly once either way. `direct` is the
   * caller's own call as it has always been made (so a direct call is byte-for-byte the old one); default: directExec.
   */
  exec<R = HelperExecResult>(file: string, args: string[], opts: HelperExecOptions = {}, direct?: () => Promise<R>): Promise<R> {
    const goDirect = (): Promise<R> => (direct ? direct() : this.options.direct(file, args, opts) as unknown as Promise<R>);
    const abs = this.usable() ? this.absoluteFor(file, opts.env) : null;
    if (!abs) return goDirect();
    return new Promise<R>((resolve, reject) => {
      const p: Pending = { id: this.nextId++, started: false, settled: false, file, abs, args, opts, resolve: resolve as (r: HelperExecResult) => void, reject, startTimer: null, answerTimer: null,
        direct: () => { goDirect().then(resolve, reject); } };
      this.pending.set(p.id, p);
      this.holdOpen();
      const request = { id: p.id, file: abs, args, timeout: opts.timeout ?? 0, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        env: opts.env ?? process.env, ...(opts.input !== undefined ? { input: opts.input } : {}) };
      try { this.proc!.stdin!.write(JSON.stringify(request) + "\n"); }
      catch { this.pending.delete(p.id); this.retire(this.proc!, "write_failed"); goDirect().then(resolve, reject); return; }
      // The fleet's own loop may have been held (a GC, a long sync read, its own spawn) while the "started" sat in the
      // pipe: the timers phase runs before the poll that would read it, so look once that poll has run (setImmediate).
      p.startTimer = setTimeout(() => {
        p.startTimer = null;
        setImmediate(() => { if (!p.started && !p.settled) this.retire(this.proc, "no_start"); });
      }, this.options.startTimeoutMs ?? HELPER_START_TIMEOUT_MS);
      p.startTimer.unref?.();
    });
  }

  /** The helper's absolute path for `file` when the call would start the same binary; else null (the call goes direct). */
  private absoluteFor(file: string, env: NodeJS.ProcessEnv | undefined): string | null {
    const name = HELPER_BINARIES.find((n) => n === file);
    const allowed = name ? this.allow.get(name) : [...this.allow.values()].find((v) => v === file);
    if (!allowed) return null;
    if (isAbsolute(file)) return file === allowed ? allowed : null;
    // The call's PATH must resolve the name to the helper's binary (memoized per PATH string).
    const path = (env ?? process.env).PATH;
    if (!this.resolvedPath || this.resolvedPath.path !== path) this.resolvedPath = { path, byName: new Map() };
    let resolved = this.resolvedPath.byName.get(file);
    if (resolved === undefined) { resolved = resolveOnPath(file, path); this.resolvedPath.byName.set(file, resolved); }
    return resolved === allowed ? allowed : null;
  }

  private receive(line: string): void {
    let m: { id?: number; started?: boolean; done?: boolean; refused?: string; stdout?: string; stderr?: string;
      error?: { message: string; code: number | string | null; signal: string | null; killed: boolean } | null };
    try { m = JSON.parse(line); } catch { return; }
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p || p.settled) return;
    if (m.refused) {                                            // never started: direct is safe
      this.settle(p);
      p.direct();
      return;
    }
    if (m.started) {
      p.started = true;
      if (p.startTimer) { clearTimeout(p.startTimer); p.startTimer = null; }
      const limit = (p.opts.timeout && p.opts.timeout > 0 ? p.opts.timeout : HELPER_NO_TIMEOUT_DEADLINE_MS) + (this.options.answerGraceMs ?? HELPER_ANSWER_GRACE_MS);
      p.answerTimer = setTimeout(() => {
        p.answerTimer = null;
        if (p.settled) return;
        this.settle(p);
        p.reject(this.timeoutError(p));
        this.retire(this.proc, "no_answer");
      }, limit);
      p.answerTimer.unref?.();
      return;
    }
    if (m.done) {
      this.settle(p);
      this.backoffMs = RESTART_BACKOFF_MIN_MS;
      const stdout = m.stdout ?? "", stderr = m.stderr ?? "";
      if (!m.error) { p.resolve({ stdout, stderr }); return; }
      // The message names the command as the direct call would ("tmux …", not the helper's absolute path).
      const message = p.abs !== p.file ? m.error.message.replace(p.abs, p.file) : m.error.message;
      const err = new Error(message) as ExecError;
      err.code = m.error.code; err.signal = m.error.signal; err.killed = m.error.killed;
      err.cmd = [p.file, ...p.args].join(" "); err.stdout = stdout; err.stderr = stderr;
      p.reject(err);
    }
  }

  /**
   * While a call waits on it, the helper keeps the process alive, as a direct call's child would; with none waiting it
   * never does (the fleet's exit is not held up by an idle helper).
   */
  private holdOpen(): void {
    const proc = this.proc;
    if (!proc) return;
    const hold = this.pending.size > 0;
    if (hold) proc.ref(); else proc.unref();
    const out = proc.stdout as unknown as { ref?(): void; unref?(): void } | null;
    if (hold) out?.ref?.(); else out?.unref?.();
  }

  private settle(p: Pending): void {
    p.settled = true;
    this.pending.delete(p.id);
    if (!this.pending.size) this.holdOpen();
    if (p.startTimer) { clearTimeout(p.startTimer); p.startTimer = null; }
    if (p.answerTimer) { clearTimeout(p.answerTimer); p.answerTimer = null; }
  }

  /** What a direct call that timed out would have rejected with. */
  private timeoutError(p: Pending): ExecError {
    const err = new Error(`Command failed: ${[p.file, ...p.args].join(" ")}`) as ExecError;
    err.code = null; err.signal = "SIGTERM"; err.killed = true; err.cmd = [p.file, ...p.args].join(" "); err.stdout = ""; err.stderr = "";
    return err;
  }

  /**
   * Stop trusting this helper and end it; the calls it never started go direct once it is gone (gone()). Taken as
   * wedged (no_start) while commands it started still run, it is not killed — killing it would not stop them, and their
   * calls would fail though they ran: its stdin is ended, and it exits once they have answered (or their deadline kills it).
   */
  private retire(proc: ChildProcess | null, why: string): void {
    if (!proc || proc !== this.proc) return;
    if (this.trusted) this.options.log?.("retired", { why });
    this.trusted = false;
    if (why === "no_start" && [...this.pending.values()].some((p) => p.started)) {
      try { proc.stdin?.end(); } catch { /* gone */ }
      return;
    }
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
  }

  /** The helper is gone and its output has been read to the end. */
  private gone(proc: ChildProcess): void {
    if (proc !== this.proc) return;
    this.proc = null;
    this.trusted = false;
    for (const p of [...this.pending.values()]) {
      this.settle(p);
      if (p.started) p.reject(this.timeoutError(p));             // it may have run: never again
      else p.direct();                                           // it never started, and now never will
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    this.restartAt = this.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RESTART_BACKOFF_MAX_MS);
  }
}

/** execFile as a promise, the way the direct call has always run it (with its sync-work attribution done by callers). */
export function directExec(file: string, args: string[], opts: HelperExecOptions): Promise<HelperExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { ...(opts.timeout ? { timeout: opts.timeout } : {}), ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
      ...(opts.env ? { env: opts.env } : {}), encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) { Object.assign(err, { stdout, stderr }); reject(err); } else resolve({ stdout, stderr });
    });
    if (opts.input !== undefined) { child.stdin?.on("error", reject); child.stdin?.end(opts.input); }
  });
}

/**
 * The fleet's one helper. Until the fleet starts it (and whenever it can't be used) every call is the direct one, its
 * synchronous fork attributed as before (#1235's "tmux.spawn").
 */
export const tmuxExecHelper = new ExecHelper({
  direct: (file, args, opts) => measureSyncWork("tmux.spawn", () => directExec(file, args, opts)),
});
