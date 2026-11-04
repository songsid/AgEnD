/**
 * #3009 (#1880): say WHICH call the fleet's main thread is stuck in, while it is stuck.
 *
 * Twice a reporter's fleet stopped dead right after a login web terminal opened: nothing more in daemon.log, systemd's
 * watchdog fired at 60 s, its SIGABRT was not taken and only a cgroup SIGKILL ended it — a main thread in an
 * uninterruptible system call, not a JavaScript loop (an isolated run showed no lag at all). The event-loop watch
 * (event-loop-watch.ts) runs ON that thread, so it can only report a stall once the loop resumes: a stall that never
 * ends leaves no line. This one runs in a worker thread, which keeps running while the main thread is stuck.
 *
 * The main thread bumps a shared counter every HEARTBEAT_MS. The worker looks every CHECK_MS; once the counter has not
 * moved for STALL_REPORT_MS it appends ONE line to daemon.log (itself, synchronously — the logger's transport is fed by
 * the stuck thread) naming the main thread's kernel state, wait channel and current system call, read from
 * /proc/self/task/<pid>/{stat,wchan,syscall} (no root needed; `stack` too where the kernel allows it). A second line says
 * when the loop came back. Linux only (elsewhere /proc does not have these); never more than one report per stall;
 * observation only — it changes nothing about scheduling, and its worker never keeps the process alive.
 */
import { Worker } from "node:worker_threads";

export const HEARTBEAT_MS = 1_000;
export const CHECK_MS = 1_000;
/** Well inside systemd's 60 s watchdog, so the line is written before the SIGABRT. */
export const STALL_REPORT_MS = 15_000;

export interface StallReporter { stop(): void }

/**
 * The worker's body, as plain JavaScript (run with `eval: true`, so it needs no separate built file). Exported for the
 * test, which runs the same text against a fake /proc and a fake clock.
 */
export const STALL_WORKER_SOURCE = String.raw`
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const beat = new Int32Array(workerData.shared);
const { logFile, tid, stallMs, checkMs, procRoot } = workerData;
let seen = Atomics.load(beat, 0), since = Date.now(), reported = false;
const pad = n => String(n).padStart(2, "0");
const stamp = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); };
const read = name => { try { return fs.readFileSync(procRoot + "/" + tid + "/" + name, "utf8").trim(); } catch (e) { return "(" + (e && e.code || "unreadable") + ")"; } };
const write = (level, text) => { try { fs.appendFileSync(logFile, "[" + stamp() + "] " + level + ": " + text + "\n"); } catch { /* nothing else to tell */ } };
const tick = () => {
  const now = Date.now(), current = Atomics.load(beat, 0);
  if (current !== seen) {
    if (reported) write("WARN", "The fleet's main thread is running again after " + Math.round((now - since) / 1000) + " s (#3009 stall report)");
    seen = current; since = now; reported = false; return;
  }
  if (reported || now - since < stallMs) return;
  reported = true;
  const stat = read("stat"), close = stat.lastIndexOf(")"), state = close > 0 ? stat.slice(close + 2).split(" ")[0] : "?";
  const stack = read("stack").split("\n").slice(0, 12).join(" | ");
  write("ERROR", "The fleet's main thread has not run for " + Math.round((now - since) / 1000) + " s (#3009 stall report): state=" + state
    + " wchan=" + read("wchan") + " syscall=" + read("syscall") + " stack=" + stack);
};
const timer = setInterval(tick, checkMs);
require("node:worker_threads").parentPort.on("message", m => { if (m === "stop") { clearInterval(timer); process.exit(0); } });
`;

export function startStallReporter(opts: {
  logFile: string;
  /** Test seams: the reporter's thresholds and a fake /proc/self/task. */
  stallMs?: number; checkMs?: number; heartbeatMs?: number; procRoot?: string; tid?: number;
}): StallReporter | null {
  if (process.platform !== "linux" && !opts.procRoot) return null;
  const shared = new SharedArrayBuffer(4);
  const beat = new Int32Array(shared);
  let worker: Worker;
  try {
    worker = new Worker(STALL_WORKER_SOURCE, { eval: true, workerData: {
      shared, logFile: opts.logFile, tid: opts.tid ?? process.pid,
      stallMs: opts.stallMs ?? STALL_REPORT_MS, checkMs: opts.checkMs ?? CHECK_MS, procRoot: opts.procRoot ?? "/proc/self/task",
    } });
  } catch {
    return null;                                                    // a diagnostic: never a reason for the fleet not to start
  }
  worker.unref();
  worker.on("error", () => { /* a diagnostic that failed says nothing */ });
  const heartbeat = setInterval(() => { Atomics.add(beat, 0, 1); }, opts.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  return {
    stop(): void {
      clearInterval(heartbeat);
      try { worker.postMessage("stop"); } catch { /* already gone */ }
      void worker.terminate().catch(() => { /* already gone */ });
    },
  };
}
