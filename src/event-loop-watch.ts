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
 * #1235: how much CPU the process itself got during a stall. A probe ticks every PROBE_MS; a tick that arrives late
 * measures a stall, and the process's CPU time (user + system, all its threads) over that same gap says what the stall
 * was: CPU close to the gap — this process was running (its own synchronous work); CPU far below it — the process was
 * waiting: starved by other load on the host, or blocked in a system call (a slow disk). The two need opposite fixes.
 */
export const STALL_PROBE_MS = 1_000;
/** CPU share of a stall at or above which the process was running it; at or below STALL_WAITING_SHARE it was waiting. */
export const STALL_BUSY_SHARE = 0.7;
export const STALL_WAITING_SHARE = 0.3;

interface StallProbe { lagMs: number; wallMs: number; cpuMs: number; at: number; }

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
  /** Test seams for the CPU-share probe (#1235). */
  cpuUsage?: () => NodeJS.CpuUsage;
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
  // The CPU-share probe (#1235): the worst late tick since the last check.
  const cpuUsage = opts.cpuUsage ?? (() => process.cpuUsage());
  const probeMs = opts.probeMs ?? STALL_PROBE_MS;
  let probeAt = performance.now();
  let probeCpu = cpuUsage();
  let worstProbe: StallProbe | null = null;
  const probe = (): void => {
    const now = performance.now();
    const cpu = cpuUsage();
    const wallMs = now - probeAt;
    const lagMs = wallMs - probeMs;
    const cpuMs = (cpu.user - probeCpu.user + cpu.system - probeCpu.system) / 1_000;
    probeAt = now; probeCpu = cpu;
    if (lagMs > 0 && (!worstProbe || lagMs > worstProbe.lagMs)) worstProbe = { lagMs, wallMs, cpuMs, at: now };
  };
  const probeTimer = setInterval(probe, probeMs);
  probeTimer.unref?.();
  const cpuShareOf = (p: StallProbe) => {
    const share = p.wallMs > 0 ? Math.min(1, p.cpuMs / p.wallMs) : 0;
    const verdict = share >= STALL_BUSY_SHARE ? "running" : share <= STALL_WAITING_SHARE ? "waiting" : "mixed";
    return { stallWallMs: Math.round(p.wallMs), processCpuMs: Math.round(p.cpuMs), share: Math.round(share * 100) / 100, verdict };
  };

  let lastCheckAt = performance.now();
  const check = (): number => {
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
      // The probe's worst late tick covers this window's stall when it saw one at least half as long; otherwise the
      // probe tick did not land in it (it ticks once a second), and saying nothing beats a guess.
      const cpu = stallProbe && stallProbe.lagMs >= maxMs / 2 ? cpuShareOf(stallProbe) : null;
      const load = (opts.loadAverage ?? loadavg)().map(v => Math.round(v * 100) / 100);
      const cores = opts.cores ?? availableParallelism();
      const cpuText = cpu
        ? `; the process got ${cpu.processCpuMs}ms of CPU in a ${cpu.stallWallMs}ms gap (${cpu.verdict === "running" ? "it was running: its own synchronous work"
          : cpu.verdict === "waiting" ? "it was waiting: starved by other load on the host, or blocked in a system call" : "partly running, partly waiting"})`
        : "";
      opts.logger.warn({
        maxMs,
        syncWork,
        gcPauses: gcWork,
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        meanMs: Math.round(histogram.mean / 1e6),
        cpu,
        hostLoad: { load1: load[0], load5: load[1], load15: load[2], cores },
      }, `Event loop stalled for ${maxMs}ms — Discord slash commands (3s to acknowledge) and gateway heartbeats arriving then could be missed${syncWork.length ? `; slow sync work: ${syncWork.map(entry => `${entry.caller}=${entry.durationMs}ms${entry.count ? ` (${entry.count} calls)` : ""}`).join(", ")}` : "; slow sync work: unknown"}${gcWork.length ? `; GC pauses: ${gcWork.map(entry => `kind ${entry.kind}=${entry.durationMs}ms`).join(", ")}` : ""}${cpuText}; host load ${load.join("/")} on ${cores} cores`);
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
