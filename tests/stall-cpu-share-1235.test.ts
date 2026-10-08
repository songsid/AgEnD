/**
 * #1235: was a stall the event loop's thread running, or waiting? The stall WARN carries the CPU time of the probe gap
 * that held the stall and the host's load average, and says only what bounds on that CPU prove (#1400 review):
 *  - the CPU is the main thread's (`process.threadCpuUsage`) where Node has it, else the whole process's — workers
 *    included, so it can only ever prove "waiting";
 *  - the gap's on-time interval may have been busy too, so "running" needs CPU beyond it;
 *  - the gap is described as the stall only when it is within one probe interval of the histogram's maximum;
 *  - a window's gaps end at the window: a stall before a check is never reported in the next window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { startEventLoopWatch, STALL_PROBE_MS } from "../src/event-loop-watch.js";

let now = 0;
let cpuUs = 0;
beforeEach(() => {
  now = 0; cpuUs = 0;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const EPOCH = Date.UTC(2026, 9, 8, 12, 0, 0);
function watch(stallMs: number, opts: { cpuSource?: "main-thread" | "process"; probeMs?: number } = {}) {
  const warn = vi.fn();
  const histogram = { max: stallMs * 1e6, mean: 20e6, percentile: () => 100e6, enable: () => true, disable: () => true, reset: vi.fn() };
  const w = startEventLoopWatch({
    logger: { warn }, histogram, intervalMs: 3_600_000,
    gcObserver: () => ({ observe() {}, disconnect() {}, takeRecords: () => [] }),
    cpuUsage: () => ({ user: cpuUs, system: 0 }), cpuSource: opts.cpuSource ?? "main-thread",
    wallClock: () => EPOCH + now, probeMs: opts.probeMs,
    loadAverage: () => [5.234, 4.1, 3.3], cores: 6,
  });
  return { w, warn, histogram };
}
/** One probe gap: `gapMs` of wall time in which the measured CPU clock moved `cpuMs`, then the probe tick. */
function gap(gapMs: number, cpuMs: number, probeMs = STALL_PROBE_MS) {
  now += gapMs; cpuUs += cpuMs * 1_000;
  vi.advanceTimersByTime(probeMs);
}

describe("the stall WARN says what the CPU bounds prove", () => {
  it("main-thread CPU through the late part: running", () => {
    const { w, warn } = watch(1_500);
    gap(STALL_PROBE_MS + 1_500, 1_550);
    w.check(); w.stop();
    const [obj, msg] = warn.mock.calls[0]!;
    expect(obj.cpu).toEqual({ gapStartedAt: new Date(EPOCH).toISOString(), gapEndedAt: new Date(EPOCH + 1_600).toISOString(),
      gapMs: 1_600, lateMs: 1_500, cpuMs: 1_550, cpuOf: "main-thread", verdict: "running" });
    expect(msg).toContain(`in the 1600ms probe gap that held it (1500ms late, ending ${new Date(EPOCH + 1_600).toISOString()}) the main thread got 1550ms of CPU: the thread was running`);
  });

  it("little CPU in the gap: waiting", () => {
    const { w, warn } = watch(1_500);
    gap(STALL_PROBE_MS + 1_500, 150);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu.verdict).toBe("waiting");
    expect(warn.mock.calls[0]![1]).toContain("the thread was not running for most of it (blocked in a system call, or starved by other load on the host)");
  });

  it("idle dilution: the on-time interval may have been busy, so CPU equal to it proves nothing about the late part", () => {
    // A 1 s probe, 1 s idle then a 1 s pure-CPU stall: the old share over the whole gap said 0.5, "mixed".
    const { w, warn } = watch(1_000, { probeMs: 1_000 });
    gap(2_000, 1_000, 1_000);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu).toMatchObject({ gapMs: 2_000, lateMs: 1_000, cpuMs: 1_000, verdict: "unclear" });
    expect(warn.mock.calls[0]![1]).toContain("not enough to tell running from waiting");
  });

  it("the default short probe keeps the dilution small: the same 1 s CPU stall after an idle interval is running", () => {
    const { w, warn } = watch(1_000);
    gap(STALL_PROBE_MS + 1_000, 1_000);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu).toMatchObject({ lateMs: 1_000, cpuMs: 1_000, verdict: "running" });
  });

  it("whole-process CPU (no per-thread clock): a worker's CPU never reads as the main thread running", () => {
    // Main thread waiting 2.5 s while a worker burns 2.4 s of CPU: the process clock sees 2.4 s.
    const { w, warn } = watch(2_500, { cpuSource: "process" });
    gap(STALL_PROBE_MS + 2_500, 2_400);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu).toMatchObject({ cpuMs: 2_400, cpuOf: "process", verdict: "unclear" });
    expect(warn.mock.calls[0]![1]).toContain("the whole process (all threads) got 2400ms of CPU: not enough to tell");
  });

  it("whole-process CPU can still prove waiting (it bounds the main thread from above)", () => {
    const { w, warn } = watch(2_500, { cpuSource: "process" });
    gap(STALL_PROBE_MS + 2_500, 300);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu).toMatchObject({ cpuOf: "process", verdict: "waiting" });
  });

  it("a gap from a smaller stall is not described as the window's longest stall", () => {
    const { w, warn } = watch(1_500);
    gap(STALL_PROBE_MS + 800, 850);   // a 0.8 s CPU stall; the 1.5 s stall left no probe gap (e.g. it was in a check)
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu).toBeNull();
    expect(warn.mock.calls[0]![1]).not.toContain("probe gap");
  });

  it("the longest gap of the window is the one reported, and the next window starts fresh", () => {
    const { w, warn } = watch(1_600);
    gap(STALL_PROBE_MS + 300, 300);
    gap(STALL_PROBE_MS + 1_600, 100);
    gap(STALL_PROBE_MS + 200, 200);
    w.check();
    expect(warn.mock.calls[0]![0].cpu).toMatchObject({ gapMs: 1_700, cpuMs: 100, verdict: "waiting" });
    w.check(); w.stop();
    expect(warn.mock.calls[1]![0].cpu).toBeNull();
  });

  it("a stall the check runs straight after belongs to that window, never to the next one (check before the overdue probe)", () => {
    const { w, warn, histogram } = watch(2_000);
    // A 2 s CPU stall; when it ends the check's timer runs first, then the overdue probe tick.
    now += STALL_PROBE_MS + 2_000; cpuUs += 2_050 * 1_000;
    w.check();
    vi.advanceTimersByTime(STALL_PROBE_MS);
    expect(warn.mock.calls[0]![0].cpu).toMatchObject({ lateMs: 2_000, cpuMs: 2_050, verdict: "running" });
    // The next window: a 1 s stall with no CPU.
    histogram.max = 1_000 * 1e6;
    gap(STALL_PROBE_MS + 1_000, 0);
    w.check(); w.stop();
    expect(warn.mock.calls[1]![0].cpu).toMatchObject({ lateMs: 1_000, cpuMs: 0, verdict: "waiting" });
  });

  it("the host's load and cores are always on the WARN", () => {
    const { w, warn } = watch(1_500);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].hostLoad).toEqual({ load1: 5.23, load5: 4.1, load15: 3.3, cores: 6 });
    expect(warn.mock.calls[0]![1]).toContain("host load 5.23/4.1/3.3 on 6 cores");
  });

  it("stop ends the probe", () => {
    const { w } = watch(1_500);
    w.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("which CPU clock: the main thread's where Node has one, else the process's (older Node)", () => {
  function realClockWatch() {
    const warn = vi.fn();
    const histogram = { max: 1_500 * 1e6, mean: 20e6, percentile: () => 100e6, enable: () => true, disable: () => true, reset: vi.fn() };
    const w = startEventLoopWatch({ logger: { warn }, histogram, intervalMs: 3_600_000,
      gcObserver: () => ({ observe() {}, disconnect() {}, takeRecords: () => [] }), loadAverage: () => [0, 0, 0], cores: 1 });
    return { w, warn };
  }
  it("process.threadCpuUsage present: the main thread's", () => {
    const thread = vi.fn(() => ({ user: cpuUs, system: 0 }));
    const proc = vi.spyOn(process, "cpuUsage");
    const had = Object.getOwnPropertyDescriptor(process, "threadCpuUsage");
    Object.defineProperty(process, "threadCpuUsage", { value: thread, configurable: true, writable: true });
    try {
      const { w, warn } = realClockWatch();
      gap(STALL_PROBE_MS + 1_500, 1_550);
      w.check(); w.stop();
      expect(warn.mock.calls[0]![0].cpu).toMatchObject({ cpuOf: "main-thread", cpuMs: 1_550, verdict: "running" });
      expect(proc).not.toHaveBeenCalled();
    } finally {
      if (had) Object.defineProperty(process, "threadCpuUsage", had); else delete (process as { threadCpuUsage?: unknown }).threadCpuUsage;
    }
  });
  it("absent (an older Node): the process's, which can only prove waiting", () => {
    const proc = vi.spyOn(process, "cpuUsage").mockImplementation(() => ({ user: cpuUs, system: 0 }));
    const had = Object.getOwnPropertyDescriptor(process, "threadCpuUsage");
    delete (process as { threadCpuUsage?: unknown }).threadCpuUsage;
    try {
      const { w, warn } = realClockWatch();
      gap(STALL_PROBE_MS + 1_500, 1_550);
      w.check(); w.stop();
      expect(warn.mock.calls[0]![0].cpu).toMatchObject({ cpuOf: "process", cpuMs: 1_550, verdict: "unclear" });
      expect(proc).toHaveBeenCalled();
    } finally {
      if (had) Object.defineProperty(process, "threadCpuUsage", had);
    }
  });
});
