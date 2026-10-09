/**
 * #1231: say when the fleet's event loop stalls.
 *
 * Every instance's daemon, every channel adapter and the web UI share this one
 * Node event loop. A Discord slash command must be acknowledged within 3 s of
 * being sent, and that acknowledgement can only start once the loop gets to
 * the interactionCreate event — so any synchronous stretch (a whole-file read,
 * a blocking child process) long enough to eat that window shows up to the user
 * as "The application did not respond", with nothing in any log. This puts the
 * stall in the log, with how long it was, so the cause can be found instead of
 * guessed at. Observation only: it changes nothing about scheduling.
 */
import { closeSyncWorkBursts, slowSyncWorkSince } from "./sync-work-attribution.js";
import { performance, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { availableParallelism, loadavg } from "node:os";

/**
 * #1235: was the event loop's thread running during a stall, or waiting? A probe ticks every STALL_PROBE_MS; a tick
 * that arrives late spans a stall, and the CPU time over that same gap bounds what the thread did in it. Only what the
 * bounds prove is said:
 *  - CPU is the main thread's own (`process.threadCpuUsage`) where Node has it. Otherwise it is the whole process's,
 *    workers included, which can exceed the gap on several cores: an upper bound on the main thread, nothing more.
 *  - The gap is the expected interval plus the late part. The late part got at least `cpu − interval` of CPU (the
 *    interval may have been busy too) and at most `cpu`. "running" needs the lower bound, from the main thread's own
 *    CPU, at STALL_BUSY_SHARE of the late part or more; "waiting" needs the upper bound at STALL_WAITING_SHARE or less.
 *    Anything between is "unclear".
 *  - What is reported is the window's longest probe gap, as itself: its own times, length and CPU. Nothing ties it to
 *    the histogram's maximum — two stalls of similar length in one window are indistinguishable by length (#1400
 *    review) — so the WARN never says the gap held that stall. Gaps late by less than half the stall threshold are not
 *    reported at all.
 * Running and waiting need opposite fixes: the fleet's own synchronous work, or the host's load and slow system calls.
 */
export const STALL_PROBE_MS = 100;
/** Share of the late part with CPU at or above which the thread was running; at or below STALL_WAITING_SHARE, waiting. */
export const STALL_BUSY_SHARE = 0.7;
export const STALL_WAITING_SHARE = 0.3;

type CpuSource = "main-thread" | "process";
interface StallProbe { lateMs: number; wallMs: number; cpuMs: number; endedAt: number; }

/** A stall at least this long (of Discord's 3000 ms acknowledgement window) is logged. */
export const EVENT_LOOP_STALL_MS = 1_000;
export const EVENT_LOOP_CHECK_MS = 30_000;
export const GC_PAUSE_WARN_MS = 200;

interface GcEntry { startTime: number; duration: number; detail?: { kind?: number }; }
interface GcObserver { observe(options: { entryTypes: string[] }): void; takeRecords(): GcEntry[]; disconnect(): void; }
interface GcPause { kind: number | "unknown"; durationMs: number; startedAt: number; endedAt: number; }

/** The part of perf_hooks' IntervalHistogram this uses (values in nanoseconds). */
export interface LoopDelayHistogram {
  readonly max: number;
  readonly mean: number;
  percentile(p: number): number;
  reset(): void;
  enable(): boolean;
  disable(): boolean;
}

export interface EventLoopWatch {
  /** Read the histogram since the last check; logs and returns the worst stall in ms. */
  check(): number;
  stop(): void;
}

export function startEventLoopWatch(opts: {
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
  intervalMs?: number;
  thresholdMs?: number;
  histogram?: LoopDelayHistogram;
  /** Test seam; production observes V8 GC without a polling timer. */
  gcObserver?: (receive: (entries: GcEntry[]) => void) => GcObserver;
  /** Test seams for the CPU probe (#1235). `cpuUsage` with `cpuSource` stands in for the CPU clock Node offers. */
  cpuUsage?: () => NodeJS.CpuUsage;
  cpuSource?: CpuSource;
  wallClock?: () => number;
  loadAverage?: () => number[];
  cores?: number;
  probeMs?: number;
}): EventLoopWatch {
  const thresholdMs = opts.thresholdMs ?? EVENT_LOOP_STALL_MS;
  const histogram = opts.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const gcPauses: GcPause[] = [];
  let stopped = false;
  const receiveGc = (entries: GcEntry[]): void => {
    if (stopped) return;
    for (const entry of entries) {
      if (!Number.isFinite(entry.duration) || !Number.isFinite(entry.startTime) || entry.duration < GC_PAUSE_WARN_MS) continue;
      const pause: GcPause = { kind: entry.detail?.kind ?? "unknown", durationMs: Math.round(entry.duration),
        startedAt: entry.startTime, endedAt: entry.startTime + entry.duration };
      gcPauses.push(pause);
      if (gcPauses.length > 64) gcPauses.shift();
      opts.logger.warn({ gcPause: pause }, `GC paused for ${pause.durationMs}ms (kind ${pause.kind})`);
    }
  };
  const gcObserver = opts.gcObserver?.(receiveGc) ?? new PerformanceObserver(list => receiveGc(list.getEntries()));
  gcObserver.observe({ entryTypes: ["gc"] });
  // The CPU probe (#1235): the longest late gap since the last check.
  const threadCpuUsage = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
  const cpuSource: CpuSource = opts.cpuSource ?? (opts.cpuUsage || typeof threadCpuUsage !== "function" ? "process" : "main-thread");
  const cpuUsage = opts.cpuUsage ?? (cpuSource === "main-thread" ? () => threadCpuUsage!.call(process) : () => process.cpuUsage());
  const wallClock = opts.wallClock ?? Date.now;
  const probeMs = opts.probeMs ?? STALL_PROBE_MS;
  let probeAt = performance.now();
  let probeCpu = cpuUsage();
  let worstProbe: StallProbe | null = null;
  /** Close the gap since the last tick (a tick, or a window's end) and start the next one here. */
  const probe = (): void => {
    const now = performance.now();
    const cpu = cpuUsage();
    const wallMs = now - probeAt;
    const lateMs = wallMs - probeMs;
    const cpuMs = (cpu.user - probeCpu.user + cpu.system - probeCpu.system) / 1_000;
    probeAt = now; probeCpu = cpu;
    if (lateMs > 0 && (!worstProbe || lateMs > worstProbe.lateMs)) worstProbe = { lateMs, wallMs, cpuMs, endedAt: wallClock() };
  };
  const probeTimer = setInterval(probe, probeMs);
  probeTimer.unref?.();
  const describeGap = (p: StallProbe) => {
    const verdict = p.cpuMs <= STALL_WAITING_SHARE * p.lateMs ? "waiting"
      : cpuSource === "main-thread" && p.cpuMs - (p.wallMs - p.lateMs) >= STALL_BUSY_SHARE * p.lateMs ? "running"
      : "unclear";
    return {
      gapStartedAt: new Date(p.endedAt - p.wallMs).toISOString(), gapEndedAt: new Date(p.endedAt).toISOString(),
      gapMs: Math.round(p.wallMs), lateMs: Math.round(p.lateMs), cpuMs: Math.round(p.cpuMs), cpuOf: cpuSource, verdict,
    } as const;
  };

  let lastCheckAt = performance.now();
  const check = (): number => {
    // The window ends here for the probe too: a gap still open (a stall that ended just before this check ran) is this
    // window's, and the next window's first gap starts now — never a gap that crosses the boundary.
    probe();
    const now = performance.now();
    // Flush entries whose asynchronous observer callback has not run yet.
    receiveGc(gcObserver.takeRecords());
    const gcWork = gcPauses.filter(entry => entry.endedAt > lastCheckAt && entry.startedAt <= now).map(entry => ({ ...entry }));
    const syncWork = slowSyncWorkSince(lastCheckAt, now);
    // This window is sampled: work after this point is the next window's, never added to what was just reported.
    closeSyncWorkBursts();
    lastCheckAt = now;
    const maxMs = Math.round(histogram.max / 1e6);
    const stallProbe = worstProbe;
    worstProbe = null;
    if (maxMs >= thresholdMs) {
      // The window's longest probe gap, as itself — not as the maximum's stall, which it cannot be shown to be.
      const longestProbeGap = stallProbe && stallProbe.lateMs >= thresholdMs / 2 ? describeGap(stallProbe) : null;
      const load = (opts.loadAverage ?? loadavg)().map(v => Math.round(v * 100) / 100);
      const cores = opts.cores ?? availableParallelism();
      const gap = longestProbeGap;
      const gapText = gap
        ? `; longest probe gap in this window: ${gap.gapMs}ms (${gap.lateMs}ms late, ending ${gap.gapEndedAt}), in which ${gap.cpuOf === "main-thread" ? "the main thread" : "the whole process (all threads)"} got ${gap.cpuMs}ms of CPU: ${gap.verdict === "running" ? "the thread was running through that gap (synchronous work in this process)"
          : gap.verdict === "waiting" ? "the thread was not running for most of that gap (blocked in a system call, or starved by other load on the host)"
          : "not enough to tell running from waiting"}`
        : "";
      opts.logger.warn({
        maxMs,
        syncWork,
        gcPauses: gcWork,
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        meanMs: Math.round(histogram.mean / 1e6),
        longestProbeGap,
        hostLoad: { load1: load[0], load5: load[1], load15: load[2], cores },
      }, `Event loop stalled for ${maxMs}ms — Discord slash commands (3s to acknowledge) and gateway heartbeats arriving then could be missed${syncWork.length ? `; slow sync work: ${syncWork.map(entry => `${entry.caller}=${entry.durationMs}ms${entry.count ? ` (${entry.count} calls)` : ""}`).join(", ")}` : "; slow sync work: unknown"}${gcWork.length ? `; GC pauses: ${gcWork.map(entry => `kind ${entry.kind}=${entry.durationMs}ms`).join(", ")}` : ""}${gapText}; host load ${load.join("/")} on ${cores} cores`);
    }
    histogram.reset();
    return maxMs;
  };
  const timer = setInterval(check, opts.intervalMs ?? EVENT_LOOP_CHECK_MS);
  timer.unref?.();
  return {
    check,
    stop: () => { stopped = true; clearInterval(timer); clearInterval(probeTimer); gcObserver.disconnect(); histogram.disable(); },
  };
}
