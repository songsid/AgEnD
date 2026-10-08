/**
 * #1235: was a stall this process running, or this process waiting? The stall WARN now carries how much CPU the
 * process got during the stall (a probe's late tick measures the gap and the process's CPU time across it) and the
 * host's load average. CPU close to the gap → the process's own synchronous work; far below it → starved by the host
 * or blocked in a system call. Live data (2026-10-08) left that open: the profiled fleet spends most of its JS time
 * spawning tmux, which a busy host makes slower.
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

function watch(stallMs: number) {
  const warn = vi.fn();
  const histogram = { max: stallMs * 1e6, mean: 20e6, percentile: () => 100e6, enable: () => true, disable: () => true, reset: vi.fn() };
  const w = startEventLoopWatch({
    logger: { warn }, histogram, intervalMs: 3_600_000,
    gcObserver: () => ({ observe() {}, disconnect() {}, takeRecords: () => [] }),
    cpuUsage: () => ({ user: cpuUs, system: 0 }),
    loadAverage: () => [5.234, 4.1, 3.3], cores: 6,
  });
  return { w, warn };
}
/** One probe gap: `gapMs` of wall time during which the process used `cpuMs` of CPU, then the probe tick. */
function gap(gapMs: number, cpuMs: number) {
  now += gapMs; cpuUs += cpuMs * 1_000;
  vi.advanceTimersByTime(STALL_PROBE_MS);
}

describe("the stall WARN says whether the process was running or waiting", () => {
  it("CPU close to the gap: running (its own synchronous work)", () => {
    const { w, warn } = watch(1_500);
    gap(STALL_PROBE_MS + 1_500, 2_400);
    w.check(); w.stop();
    const [obj, msg] = warn.mock.calls[0]!;
    expect(obj.cpu).toEqual({ stallWallMs: 2_500, processCpuMs: 2_400, share: 0.96, verdict: "running" });
    expect(msg).toContain("the process got 2400ms of CPU in a 2500ms gap (it was running: its own synchronous work)");
  });

  it("CPU far below the gap: waiting (starved by the host, or blocked in a system call)", () => {
    const { w, warn } = watch(1_500);
    gap(STALL_PROBE_MS + 1_500, 150);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu.verdict).toBe("waiting");
    expect(warn.mock.calls[0]![1]).toContain("it was waiting: starved by other load on the host, or blocked in a system call");
  });

  it("in between: mixed", () => {
    const { w, warn } = watch(1_500);
    gap(STALL_PROBE_MS + 1_500, 1_250);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu.verdict).toBe("mixed");
  });

  it("the host's load and cores are always on the WARN", () => {
    const { w, warn } = watch(1_500);
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].hostLoad).toEqual({ load1: 5.23, load5: 4.1, load15: 3.3, cores: 6 });
    expect(warn.mock.calls[0]![1]).toContain("host load 5.23/4.1/3.3 on 6 cores");
  });

  it("a probe tick that did not catch this stall makes no CPU claim", () => {
    const { w, warn } = watch(1_500);
    gap(STALL_PROBE_MS + 200, 100);   // a small late tick, not the 1.5 s stall
    w.check(); w.stop();
    expect(warn.mock.calls[0]![0].cpu).toBeNull();
    expect(warn.mock.calls[0]![1]).not.toContain("of CPU in a");
  });

  it("the worst late tick of the window is the one reported, and the next window starts fresh", () => {
    const { w, warn } = watch(1_500);
    gap(STALL_PROBE_MS + 300, 300);
    gap(STALL_PROBE_MS + 1_600, 100);
    gap(STALL_PROBE_MS + 200, 200);
    w.check();
    expect(warn.mock.calls[0]![0].cpu).toMatchObject({ stallWallMs: 2_600, processCpuMs: 100, verdict: "waiting" });
    w.check(); w.stop();
    expect(warn.mock.calls[1]![0].cpu).toBeNull();
  });

  it("stop ends the probe", () => {
    const { w } = watch(1_500);
    w.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
