import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { measureSyncWork, slowSyncWorkSince, resetSyncWorkAttributionForTests } from "../src/sync-work-attribution.js";
import { startEventLoopWatch } from "../src/event-loop-watch.js";
let now = 0;
beforeEach(() => { resetSyncWorkAttributionForTests(); now = 0; vi.spyOn(performance, "now").mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); resetSyncWorkAttributionForTests(); });
describe("bounded synchronous-work attribution", () => {
  it("observes slow GC, drains pending entries into the stall WARN and disconnects on stop", () => {
    const warn = vi.fn(); let receive!: (entries: any[]) => void;
    const records: any[] = [];
    const observer = { observe: vi.fn(), disconnect: vi.fn(), takeRecords: () => records.splice(0) };
    const histogram = { max: 1_200e6, mean: 10e6, percentile: () => 20e6, enable: () => true, disable: () => true, reset: vi.fn() };
    const watch = startEventLoopWatch({ logger: { warn }, histogram, gcObserver: callback => { receive = callback; return observer; } });
    expect(observer.observe).toHaveBeenCalledWith({ entryTypes: ["gc"] });
    receive([{ startTime: 5, duration: 199, detail: { kind: 1 } }]); expect(warn).not.toHaveBeenCalled();
    records.push({ startTime: 10, duration: 200, detail: { kind: 4 } }); now = 1200;
    watch.check();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ gcPause: { kind: 4, durationMs: 200, startedAt: 10, endedAt: 210 } }), "GC paused for 200ms (kind 4)");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ gcPauses: [{ kind: 4, durationMs: 200, startedAt: 10, endedAt: 210 }] }), expect.stringContaining("GC pauses: kind 4=200ms"));
    now++; watch.check(); expect(warn.mock.calls.at(-1)![0].gcPauses).toEqual([]);
    watch.stop(); expect(observer.disconnect).toHaveBeenCalledOnce();
    const count = warn.mock.calls.length; receive([{ startTime: now, duration: 300 }]); expect(warn).toHaveBeenCalledTimes(count);
  });
  it("bounds GC history, preserves unknown kind and ignores invalid duration", () => {
    const warn = vi.fn(); let receive!: (entries: any[]) => void;
    const histogram = { max: 1_200e6, mean: 0, percentile: () => 0, enable: () => true, disable: () => true, reset: vi.fn() };
    const watch = startEventLoopWatch({ logger: { warn }, histogram, gcObserver: callback => {
      receive = callback; return { observe() {}, disconnect() {}, takeRecords: () => [] };
    } });
    try {
      receive([{ startTime: 0, duration: NaN }, { startTime: NaN, duration: 200 }]); expect(warn).not.toHaveBeenCalled();
      for (let i = 0; i < 65; i++) receive([{ startTime: i, duration: 200 }]); now = 1000; watch.check();
      const pauses = warn.mock.calls.at(-1)![0].gcPauses;
      expect(pauses).toHaveLength(64); expect(pauses[0]).toEqual({ kind: "unknown", durationMs: 200, startedAt: 1, endedAt: 201 });
    } finally { watch.stop(); }
  });
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
