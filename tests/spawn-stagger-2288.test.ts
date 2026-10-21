import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpawnGate, type SpawnTask } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";
import { MemoryPressure } from "../src/memory-pressure.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const task = (name: string, reason: SpawnTask["reason"] = "startup"): SpawnTask => ({ instanceName: name, workingDirectory: `/inert/${name}`, reason });
const owned: Array<{ gate: SpawnGate; storm: StormWindow }> = [];
function rig(stagger = 2000, concurrency = 6, random = () => 0) {
  const storm = new StormWindow({ backoffsMs: [10] });
  let availableBytes = 8e9;
  const pressure = new MemoryPressure({ platform: "linux", read: () => ({ totalBytes: 16e9, availableBytes, availableKind: "available", swapTotalBytes: 4e9, swapFreeBytes: 4e9 }) });
  const gate = new SpawnGate({ storm, concurrency: () => concurrency, staggerMs: () => stagger, memoryPressure: pressure, random });
  // A failed mutation assertion must not leak shutdown rejections.
  const run = gate.run.bind(gate);
  gate.run = <T>(task: SpawnTask, operation: () => Promise<T>) => {
    const pending = run(task, operation); void pending.catch(() => {}); return pending;
  };
  owned.push({ gate, storm });
  return { gate, storm, pressure, setPressure: (level: "normal" | "elevated" | "critical") => { availableBytes = level === "normal" ? 8e9 : level === "elevated" ? 700e6 : 100e6; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T00:00:00Z")); });
afterEach(() => { for (const { gate, storm } of owned.splice(0)) { gate.shutdown(); storm.shutdown(); } vi.restoreAllMocks(); vi.useRealTimers(); });

describe("#2288 stagger belongs to outer admissions", () => {
  it.each([500, 1700, 2000])("nested spawn after %i ms preparation does not postpone the next outer admission", async preparation => {
    const { gate } = rig(); const epoch = Date.now(); const starts: number[] = [];
    const a = gate.run({ ...task("a"), stage: "lifecycle" }, async () => {
      starts.push(Date.now() - epoch); await sleep(preparation);
      await gate.run(task("a"), () => sleep(8000));
    });
    const b = gate.run({ ...task("b"), stage: "lifecycle" }, async () => { starts.push(Date.now() - epoch); });
    await vi.advanceTimersByTimeAsync(2000);
    expect(starts).toEqual([0, 2000]);
    await vi.advanceTimersByTimeAsync(10_000); await Promise.all([a, b]);
  });

  it.each(["restart", "wake", "recovery"] as const)("standalone %s still pays stagger and respects concurrency", async reason => {
    const { gate } = rig(500, 2); const epoch = Date.now(); const starts: number[] = []; let active = 0, peak = 0;
    const work = Array.from({ length: 4 }, (_, i) => gate.run(task(String(i), reason), async () => {
      starts.push(Date.now() - epoch); peak = Math.max(peak, ++active); await sleep(2000); active--;
    }));
    await vi.advanceTimersByTimeAsync(5000); await Promise.all(work);
    expect(starts).toEqual([0, 500, 2000, 2500]); expect(peak).toBe(2);
  });

  it.each([[500, 57_500], [2000, 86_000]])("simulates 40 instances, concurrency 6, stagger %i ms, preparation 2 s and physical startup 6 s", async (stagger, expectedMs) => {
    const { gate } = rig(stagger, 6); const epoch = Date.now(); const starts: number[] = []; let active = 0, peak = 0, completedAt = 0;
    const runs = Array.from({ length: 40 }, (_, i) => gate.run({ ...task(String(i)), stage: "lifecycle" }, async () => {
      starts.push(Date.now() - epoch); peak = Math.max(peak, ++active);
      await sleep(2000); await gate.run(task(String(i)), () => sleep(6000));
      active--; completedAt = Date.now() - epoch;
    }));
    await vi.advanceTimersByTimeAsync(300_000); await Promise.all(runs);
    expect({ count: starts.length, peak, completedAt }).toEqual({ count: 40, peak: stagger === 500 ? 6 : 4, completedAt: expectedMs });
  });
});

describe("#2288 pressure and storm boundaries", () => {
  it.each([[1000, 7000], [10000, 12000]])("normal physical spawn history survives rising pressure (duration %i ms)", async (duration, secondAt) => {
    const { gate, setPressure } = rig(0); const epoch = Date.now(); const starts: number[] = [];
    let physicalActive = 0, peak = 0;
    const physical = async (ms: number) => { starts.push(Date.now() - epoch); peak = Math.max(peak, ++physicalActive); await sleep(ms); physicalActive--; };
    const a = gate.run({ ...task("a"), stage: "lifecycle" }, async () => { await sleep(2000); await gate.run(task("a"), () => physical(duration)); });
    const b = gate.run({ ...task("b"), stage: "lifecycle" }, async () => { await sleep(4000); setPressure("elevated"); await gate.run(task("b"), () => physical(100)); });
    await vi.advanceTimersByTimeAsync(secondAt - 1); expect(starts).toEqual([2000]);
    await vi.advanceTimersByTimeAsync(1); expect(starts).toEqual([2000, secondAt]); expect(peak).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000); await Promise.all([a, b]);
  });
  it("elevated nested admission still paces the next outer after pressure recovers", async () => {
    const { gate, setPressure } = rig(2000); const epoch = Date.now();
    const outerStarts: number[] = [], physicalStarts: number[] = [];
    const a = gate.run({ ...task("a"), stage: "lifecycle" }, async () => {
      outerStarts.push(Date.now() - epoch); await sleep(1000); setPressure("elevated");
      await gate.run(task("a"), async () => { physicalStarts.push(Date.now() - epoch); await sleep(100); });
      setPressure("normal");
    });
    const b = gate.run({ ...task("b"), stage: "lifecycle" }, async () => { outerStarts.push(Date.now() - epoch); });
    await vi.advanceTimersByTimeAsync(6999);
    expect(physicalStarts).toEqual([5000]); expect(outerStarts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); expect(outerStarts).toEqual([0, 7000]);
    await Promise.all([a, b]);
  });
  it("critical holds a nested spawn and recovery retains slow physical admission", async () => {
    const { gate, setPressure } = rig(0); const epoch = Date.now(); const starts: number[] = [];
    const a = gate.run({ ...task("a"), stage: "lifecycle" }, async () => { await sleep(2000); await gate.run(task("a"), async () => { starts.push(Date.now() - epoch); }); });
    const b = gate.run({ ...task("b"), stage: "lifecycle" }, async () => { await sleep(4000); setPressure("critical"); await gate.run(task("b"), async () => { starts.push(Date.now() - epoch); }); });
    await vi.advanceTimersByTimeAsync(9000); expect(starts).toEqual([2000]);
    setPressure("normal"); await vi.advanceTimersByTimeAsync(9999); expect(starts).toEqual([2000]);
    await vi.advanceTimersByTimeAsync(1); expect(starts).toEqual([2000, 19000]); await Promise.all([a, b]);
  });
  it("storm backoff, jitter and four outer reservations remain in force with nested spawns", async () => {
    const { gate, storm } = rig(500, 10, () => 0.5); const epoch = Date.now(); const starts: number[] = [];
    let active = 0, peak = 0;
    storm.recordServerDead("a", ["a"]);
    const runs = Array.from({ length: 8 }, (_, i) => gate.run({ ...task(String(i), "recovery"), stage: "lifecycle" }, async () => {
      starts.push(Date.now() - epoch); peak = Math.max(peak, ++active);
      await sleep(100); await gate.run(task(String(i), "recovery"), () => sleep(4000)); active--;
    }));
    await vi.advanceTimersByTimeAsync(9); expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000); await Promise.all(runs);
    expect(starts).toHaveLength(8); expect(peak).toBe(4); expect(starts.slice(0, 4)).toEqual([10, 760, 1510, 2260]);
    expect(starts.slice(1).every((at, i) => at - starts[i] >= 750)).toBe(true);
  });
});
