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
import { slowSyncWorkSince } from "./sync-work-attribution.js";
import { performance, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

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
  let lastCheckAt = performance.now();
  const check = (): number => {
    const now = performance.now();
    // Flush entries whose asynchronous observer callback has not run yet.
    receiveGc(gcObserver.takeRecords());
    const gcWork = gcPauses.filter(entry => entry.endedAt > lastCheckAt && entry.startedAt <= now).map(entry => ({ ...entry }));
    const syncWork = slowSyncWorkSince(lastCheckAt, now);
    lastCheckAt = now;
    const maxMs = Math.round(histogram.max / 1e6);
    if (maxMs >= thresholdMs) {
      opts.logger.warn({
        maxMs,
        syncWork,
        gcPauses: gcWork,
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        meanMs: Math.round(histogram.mean / 1e6),
      }, `Event loop stalled for ${maxMs}ms — Discord slash commands (3s to acknowledge) and gateway heartbeats arriving then could be missed${syncWork.length ? `; slow sync work: ${syncWork.map(entry => `${entry.caller}=${entry.durationMs}ms`).join(", ")}` : "; slow sync work: unknown"}${gcWork.length ? `; GC pauses: ${gcWork.map(entry => `kind ${entry.kind}=${entry.durationMs}ms`).join(", ")}` : ""}`);
    }
    histogram.reset();
    return maxMs;
  };
  const timer = setInterval(check, opts.intervalMs ?? EVENT_LOOP_CHECK_MS);
  timer.unref?.();
  return {
    check,
    stop: () => { stopped = true; clearInterval(timer); gcObserver.disconnect(); histogram.disable(); },
  };
}
