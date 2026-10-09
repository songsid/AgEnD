import { performance } from "node:perf_hooks";

/** A slow synchronous stretch; `count` is set when it was a burst of back-to-back calls (their summed work). */
export interface SlowSyncWork { caller: string; durationMs: number; endedAt: number; count?: number; }
const CAPACITY = 64;
const MIN_MS = 50;
/**
 * Calls of one caller that start within this of the previous one's end are one burst: the loop never got free between
 * them, so a stall can be their sum. A fleet-wide sweep (every daemon's pane evaluation in one tick, N `tmux` spawns)
 * is a burst of calls each well under MIN_MS that block the loop together (#1235).
 */
const BURST_GAP_MS = 10;
const recent: SlowSyncWork[] = [];
interface Burst { endedAt: number; totalMs: number; count: number; entry: SlowSyncWork | null; }
const bursts = new Map<string, Burst>();

/** Observation only; record slow synchronous stretches without per-call logs or timers. */
export function measureSyncWork<T>(caller: string, operation: () => T): T {
  const startedAt = performance.now();
  try { return operation(); }
  finally { noteSyncWork(caller, startedAt); }
}

/**
 * Record a synchronous stretch that started at `startedAt` (performance.now) and ends now — for code that cannot be
 * wrapped in one closure (the synchronous tail after an await, up to its `finally`). Back-to-back calls of one caller
 * are summed into one entry; it is recorded once the sum reaches MIN_MS.
 */
export function noteSyncWork(caller: string, startedAt: number, endedAt = performance.now()): void {
  const durationMs = endedAt - startedAt;
  let burst = bursts.get(caller);
  if (!burst || startedAt - burst.endedAt > BURST_GAP_MS) {
    burst = { endedAt, totalMs: 0, count: 0, entry: null };
    bursts.set(caller, burst);
  }
  burst.totalMs += durationMs;
  burst.count++;
  burst.endedAt = endedAt;
  if (burst.totalMs < MIN_MS) return;
  if (!burst.entry) {
    burst.entry = { caller, durationMs: 0, endedAt };
    recent.push(burst.entry);
    if (recent.length > CAPACITY) recent.shift();
  }
  burst.entry.durationMs = Math.round(burst.totalMs);
  burst.entry.endedAt = endedAt;
  if (burst.count > 1) burst.entry.count = burst.count;
}

/**
 * End every open burst: the next call of any caller starts a new one. The stall watch calls this each time it has
 * sampled, so one window's work is never added to an entry it already reported, nor carried into the next window's
 * sum (#1385 review). Entries already recorded are kept as they are.
 */
export function closeSyncWorkBursts(): void { bursts.clear(); }

export function slowSyncWorkSince(since: number, until: number): SlowSyncWork[] {
  return recent.filter(entry => entry.endedAt > since && entry.endedAt <= until).map(entry => ({ ...entry }));
}
export function resetSyncWorkAttributionForTests(): void { recent.length = 0; bursts.clear(); }
