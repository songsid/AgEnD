import { performance } from "node:perf_hooks";

export interface SlowSyncWork { caller: string; durationMs: number; endedAt: number; }
const CAPACITY = 64;
const MIN_MS = 50;
const recent: SlowSyncWork[] = [];

/** Observation only; record slow synchronous stretches without per-call logs or timers. */
export function measureSyncWork<T>(caller: string, operation: () => T): T {
  const startedAt = performance.now();
  try { return operation(); }
  finally {
    const endedAt = performance.now();
    const durationMs = endedAt - startedAt;
    if (durationMs >= MIN_MS) {
      recent.push({ caller, durationMs: Math.round(durationMs), endedAt });
      if (recent.length > CAPACITY) recent.shift();
    }
  }
}

export function slowSyncWorkSince(since: number, until: number): SlowSyncWork[] {
  return recent.filter(entry => entry.endedAt > since && entry.endedAt <= until).map(entry => ({ ...entry }));
}
export function resetSyncWorkAttributionForTests(): void { recent.length = 0; }
