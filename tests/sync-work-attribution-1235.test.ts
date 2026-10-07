import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { measureSyncWork, slowSyncWorkSince, resetSyncWorkAttributionForTests } from "../src/sync-work-attribution.js";
import { startEventLoopWatch } from "../src/event-loop-watch.js";
let now = 0;
beforeEach(() => { resetSyncWorkAttributionForTests(); now = 0; vi.spyOn(performance, "now").mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); resetSyncWorkAttributionForTests(); });
describe("bounded synchronous-work attribution", () => {
  it("puts injected slow work in the same stall WARN, without per-call logging", () => {
    const warn = vi.fn();
    const histogram = { max: 1_200e6, mean: 10e6, percentile: () => 20e6, enable: () => true, disable: () => true, reset: vi.fn() };
    const watch = startEventLoopWatch({ logger: { warn }, histogram });
    try {
      expect(measureSyncWork("fixture.read", () => { now += 1200; return "result"; })).toBe("result");
      expect(warn).not.toHaveBeenCalled(); watch.check();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ syncWork: [{ caller: "fixture.read", durationMs: 1200, endedAt: 1200 }] }), expect.stringContaining("fixture.read=1200ms"));
      now++; watch.check(); expect(warn.mock.calls.at(-1)![0].syncWork).toEqual([]);
    } finally { watch.stop(); }
  });
  it("records throws, drops fast stretches and bounds the ring to 64 copies", () => {
    measureSyncWork("fast", () => { now += 49; });
    for (let i = 0; i < 65; i++) measureSyncWork(`slow.${i}`, () => { now += 50; });
    expect(slowSyncWorkSince(0, now)).toHaveLength(64);
    const copy = slowSyncWorkSince(0, now); expect(copy[0]!.caller).toBe("slow.1"); copy[0]!.caller = "changed";
    expect(slowSyncWorkSince(0, now)[0]!.caller).toBe("slow.1");
    expect(() => measureSyncWork("throws", () => { now += 50; throw new Error("original"); })).toThrow("original");
    expect(slowSyncWorkSince(now - 49, now)).toEqual([{ caller: "throws", durationMs: 50, endedAt: now }]);
  });
});
