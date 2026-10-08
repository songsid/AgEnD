/**
 * #1235: three ~1.1 s fleet stalls at 08:49:41 / 08:50:41 / 08:51:41 logged "slow sync work: unknown". The stall watch
 * reports every 30 s, so stalls in alternate windows at one phase are a ~60 s periodic task; the fleet-wide one is the
 * shared tmux control client's safety sweep, which runs every daemon's listener in one emit — each starts a
 * `tmux capture-pane` (a synchronous spawn) and later evaluates its pane. Each piece alone is well under the 50 ms the
 * attribution records, so their sum stayed unnamed. These pin the instrumentation that names it next time:
 *  - back-to-back calls of one caller are summed into one entry with a count;
 *  - every tmux spawn, the sweep's emit, and each daemon's synchronous pane evaluation are attributed.
 *
 * Nothing here starts a process, a tmux server or a fleet: child_process is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const io = vi.hoisted(() => ({ now: 0, spawnMs: 0, forbidden: vi.fn(() => { throw new Error("real process forbidden"); }) }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  // The spawn itself is the synchronous part: the clock moves inside the call, the result comes back later.
  execFile: vi.fn((_file: string, _args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    io.now += io.spawnMs;
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (err: Error | null, out: { stdout: string; stderr: string }) => void;
    setImmediate(() => cb(null, { stdout: "pane\n", stderr: "" }));
    return { stdin: null } as any;
  }),
  spawn: io.forbidden, spawnSync: io.forbidden, execSync: io.forbidden, execFileSync: io.forbidden, exec: io.forbidden, fork: io.forbidden,
}));

import { measureSyncWork, noteSyncWork, slowSyncWorkSince, resetSyncWorkAttributionForTests } from "../src/sync-work-attribution.js";
import { startEventLoopWatch } from "../src/event-loop-watch.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { TmuxControlClient, CONTROL_SAFETY_SWEEP_MS } from "../src/tmux-control.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const work = () => slowSyncWorkSince(-1, io.now + 1);
const dirs: string[] = [];
beforeEach(() => {
  io.now = 0; io.spawnMs = 0; io.forbidden.mockClear();
  resetSyncWorkAttributionForTests();
  vi.spyOn(performance, "now").mockImplementation(() => io.now);
});
afterEach(() => {
  expect(io.forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.useRealTimers(); resetSyncWorkAttributionForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("a burst of short synchronous calls is one attributed stretch", () => {
  it("back-to-back calls of one caller are summed, with their count, once the sum reaches 50 ms", () => {
    for (let i = 0; i < 25; i++) measureSyncWork("tmux.spawn", () => { io.now += 40; });
    expect(work()).toEqual([{ caller: "tmux.spawn", durationMs: 1000, endedAt: 1000, count: 25 }]);
  });

  it("calls with the loop free in between (a gap over 10 ms) are not summed: each stays under the bar", () => {
    for (let i = 0; i < 25; i++) { measureSyncWork("tmux.spawn", () => { io.now += 40; }); io.now += 11; }
    expect(work()).toEqual([]);
  });

  it("one call alone keeps today's shape (no count); different callers never merge", () => {
    measureSyncWork("a", () => { io.now += 60; });
    measureSyncWork("b", () => { io.now += 30; });
    measureSyncWork("c", () => { io.now += 30; });
    expect(work()).toEqual([{ caller: "a", durationMs: 60, endedAt: 60 }]);
  });

  it("noteSyncWork records a stretch that began before an await was resolved (the code after it, to its finally)", () => {
    const startedAt = io.now; io.now += 70;
    noteSyncWork("tail", startedAt);
    expect(work()).toEqual([{ caller: "tail", durationMs: 70, endedAt: 70 }]);
  });

  it("the stall line names the burst and how many calls it was", () => {
    const warn = vi.fn();
    const histogram = { max: 1_100e6, mean: 40e6, percentile: () => 200e6, enable: () => true, disable: () => true, reset: vi.fn() };
    const watch = startEventLoopWatch({ logger: { warn }, histogram, gcObserver: () => ({ observe() {}, disconnect() {}, takeRecords: () => [] }) });
    try {
      for (let i = 0; i < 20; i++) measureSyncWork("daemon.stateEvaluate:safety_sweep", () => { io.now += 55; });
      watch.check();
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("slow sync work: daemon.stateEvaluate:safety_sweep=1100ms (20 calls)"));
    } finally { watch.stop(); }
  });
});

describe("each stall window counts only its own work (#1385 review)", () => {
  function watch() {
    const warn = vi.fn();
    const histogram = { max: 1_100e6, mean: 40e6, percentile: () => 200e6, enable: () => true, disable: () => true, reset: vi.fn() };
    const w = startEventLoopWatch({ logger: { warn }, histogram, gcObserver: () => ({ observe() {}, disconnect() {}, takeRecords: () => [] }) });
    const lastSyncWork = () => warn.mock.calls.at(-1)![0].syncWork;
    return { w, lastSyncWork };
  }

  it("a burst reported in one window is not reported again, larger, in the next", () => {
    const { w, lastSyncWork } = watch();
    try {
      for (let i = 0; i < 3; i++) measureSyncWork("tmux.spawn", () => { io.now += 20; });
      w.check();
      expect(lastSyncWork()).toEqual([{ caller: "tmux.spawn", durationMs: 60, endedAt: 60, count: 3 }]);
      io.now += 5;   // within the burst gap: before the fix this extended the reported entry to 80 ms × 4
      measureSyncWork("tmux.spawn", () => { io.now += 20; });
      w.check();
      expect(lastSyncWork()).toEqual([]);   // this window had 20 ms in 1 call: under the bar, and only its own
    } finally { w.stop(); }
  });

  it("a sum still under the bar when a window is sampled is not carried into the next window", () => {
    const { w, lastSyncWork } = watch();
    try {
      for (let i = 0; i < 2; i++) measureSyncWork("tmux.spawn", () => { io.now += 20; });   // 40 ms: not recorded
      w.check();
      expect(lastSyncWork()).toEqual([]);
      io.now += 5;
      measureSyncWork("tmux.spawn", () => { io.now += 20; });   // carried, the sum would cross 50 ms here
      w.check();
      expect(lastSyncWork()).toEqual([]);
    } finally { w.stop(); }
  });

  it("a burst that is entirely inside the next window is still named there", () => {
    const { w, lastSyncWork } = watch();
    try {
      w.check();
      for (let i = 0; i < 4; i++) measureSyncWork("tmux.spawn", () => { io.now += 20; });
      w.check();
      expect(lastSyncWork()).toEqual([{ caller: "tmux.spawn", durationMs: 80, endedAt: 80, count: 4 }]);
    } finally { w.stop(); }
  });
});

describe("the periodic paths are attributed", () => {
  it("every tmux call's synchronous spawn is `tmux.spawn`; a sweep's worth of them adds up", async () => {
    io.spawnMs = 30;
    const panes = Array.from({ length: 20 }, (_, i) => new TmuxManager("agend", `@${i}`));
    const captures = panes.map(p => p.capturePane());   // one tick, like the sweep: no await between the spawns
    expect(work()).toEqual([{ caller: "tmux.spawn", durationMs: 600, endedAt: 600, count: 20 }]);
    await expect(Promise.all(captures)).resolves.toEqual(Array(20).fill("pane\n"));
  });

  it("the control client's safety sweep: every listener runs inside one attributed emit", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const client = new TmuxControlClient("agend");
    vi.spyOn(client as any, "connect").mockImplementation(() => {});
    for (let i = 0; i < 20; i++) client.on("safety_sweep", () => { io.now += 4; });
    client.start();
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_MS);
    expect(work().map(entry => entry.caller)).toContain("tmux.safetySweep");
    expect(work().find(entry => entry.caller === "tmux.safetySweep")!.durationMs).toBe(80);
    client.stop?.();
  });

  async function evaluatingDaemon(evaluateMs: number, captureMs: number) {
    const dir = mkdtempSync(join(tmpdir(), "agend-1235-eval-")); dirs.push(dir);
    const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
    // A minimal backend: the evaluation only asks for the patterns (a real one would resolve its binary on the PATH).
    const backend = { binaryName: "claude", getReadyPattern: () => /❯/ };
    const daemon: any = new Daemon("worker", {
      working_directory: dir, log_level: "error", backend: "claude-code",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, join(dir, "worker"), false, backend as any, undefined as any, logger);
    daemon.tmux = { capturePane: vi.fn(async () => { io.now += captureMs; return "❯ \n"; }), getWindowId: () => "@1" };
    daemon.instanceStateMonitorActive = true;
    daemon.instanceStateMachine = new PaneStateMachine(/❯/, 600_000, Date.now(), null, null);
    vi.spyOn(daemon, "observeInteractionPane").mockImplementation(() => { io.now += evaluateMs; return true; });
    return daemon;
  }

  it("each daemon's synchronous pane evaluation is `daemon.stateEvaluate:<reason>`; a sweep's worth adds up", async () => {
    const daemons = await Promise.all(Array.from({ length: 3 }, () => evaluatingDaemon(20, 0)));
    for (const d of daemons) await d.captureAndEvaluateInstanceState("safety_sweep");
    expect(work()).toEqual([{ caller: "daemon.stateEvaluate:safety_sweep", durationMs: 60, endedAt: 60, count: 3 }]);
  });

  it("the time spent waiting for the capture is not counted as synchronous work", async () => {
    const daemon = await evaluatingDaemon(20, 500);
    await daemon.captureAndEvaluateInstanceState("safety_sweep");
    expect(work()).toEqual([]);   // 20 ms of evaluation; the 500 ms await is not the loop's
  });
});
