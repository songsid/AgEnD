/**
 * #1995: croner 10.0.1 skips a job's FIRST occurrence when its "is it due?" clock reading falls just before the
 * occurrence and the clock steps forward across it before croner re-derives the next target (a WSL2 host resync or an
 * NTP step; an early timer wake plus the clock moving during the recompute is the same thing). Upstream:
 * https://github.com/hexagon/croner/issues/388 (fixed on croner's 11.0.0 dev line, not in 10.0.1 or the 10.x branch).
 * After a job's first fire croner anchors on that run, so the same step only makes a later occurrence late, not lost.
 * The missed-tick check (#2000) bounds the first-occurrence loss to a few minutes.
 *
 * Fully deterministic: global Date and setTimeout are replaced for the duration of each test (croner reads them at call
 * time); no real time passes. The first test pins the skip as observed today — when croner is upgraded to a
 * fixed version the first test fails on purpose: then change it to expect the run.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../src/scheduler/types.js";

const RealDate = Date, realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
type Timer = { id: number; at: number; fn: () => void };
let mono = 0, wallOffset = 0, seq = 0, timers: Timer[] = [], queue: number[] = [], injected = false;
const read = () => (queue.length ? queue.shift()! : mono + wallOffset);
class FakeDate extends RealDate {
  constructor(...a: unknown[]) { if (a.length === 0) super(read()); else super(...(a as [number])); }
  static now() { return read(); }
}
const T = RealDate.parse("2026-10-17T06:25:00.000Z");
let dir = "", scheduler: Scheduler | null = null, runs: string[] = [];

beforeEach(() => {
  mono = 1_000_000; wallOffset = 0; seq = 0; timers = []; queue = []; runs = []; injected = false;
  (globalThis as any).Date = FakeDate;
  (globalThis as any).setTimeout = (fn: () => void, d = 0) => { const t = { id: ++seq, at: mono + Math.max(1, Math.floor(Number(d) || 0)), fn }; timers.push(t); return { id: t.id, unref() {}, ref() {}, hasRef: () => true } as any; };
  (globalThis as any).clearTimeout = (h: any) => { if (h) timers = timers.filter(t => t.id !== h.id); };
  dir = mkdtempSync(join(tmpdir(), "croner-step-1995-"));
});
afterEach(() => {
  scheduler?.shutdown(); scheduler = null;
  (globalThis as any).Date = RealDate; (globalThis as any).setTimeout = realSetTimeout; (globalThis as any).clearTimeout = realClearTimeout;
  rmSync(dir, { recursive: true, force: true });
});

/** Run timers up to `untilWall`; at the first timer due at or after `stepAt - 5 ms`, inject the step before it runs. */
async function run(untilWall: number, stepAt: number | null) {
  let stepped = stepAt === null;
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = timers[0];
    if (!t || t.at + wallOffset > untilWall) break;
    timers.shift(); mono = Math.max(mono, t.at);
    if (!stepped && mono + wallOffset >= stepAt! - 5) {
      stepped = true; injected = true;
      queue = [stepAt! - 1];                       // croner's "is it due?" reading: 1 ms before the occurrence
      wallOffset += stepAt! + 700 - (mono + wallOffset);   // then the clock steps 700 ms past it
    }
    t.fn();
    await new Promise<void>(r => setImmediate(r));
  }
}
function start(wall: number) {
  wallOffset = wall - mono;
  scheduler = new Scheduler(join(dir, "s.db"), (_s, runId) => { runs.push(runId); }, { ...DEFAULT_SCHEDULER_CONFIG, default_timezone: "Asia/Taipei" }, () => true);
  scheduler.init();
  scheduler.create({ cron: "*/5 * * * *", message: "m", source: "w", target: "w", reply_chat_id: "1", reply_thread_id: null, timezone: "Asia/Taipei" });
}

it("croner 10.0.1 skips a job's first occurrence when the clock steps across it during the re-arm (upstream #388) — when this fails, croner is fixed: make it expect the run", async () => {
  start(T - 103_000);                              // off the missed-tick check's minute, so the step hits croner's timer
  await run(T + 60_000, T);                        // within a minute; the missed-tick check would only catch it at ~T+4 min
  expect(injected).toBe(true);                     // the step really happened, and its reading was consumed
  expect(queue).toEqual([]);
  expect(runs).not.toContain(new RealDate(T).toISOString());
});

it("after the first fire, the same step only makes an occurrence late, under its own run id", async () => {
  start(T - 7 * 60_000 + 17_000);                 // off the missed-tick check's minute, as above
  await run(T - 4 * 60_000, null);                 // T−5 min fires normally: the job is now anchored on that run
  expect(runs).toEqual([new RealDate(T - 5 * 60_000).toISOString()]);
  await run(T + 60_000, T);
  expect(runs).toEqual([new RealDate(T - 5 * 60_000).toISOString(), new RealDate(T).toISOString()]);
});
