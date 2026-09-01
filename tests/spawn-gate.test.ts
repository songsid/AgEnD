import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpawnGate } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe("SpawnGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("limits concurrency and serializes a shared working directory", async () => {
    const storm = new StormWindow();
    const gate = new SpawnGate({ storm, concurrency: () => 2, staggerMs: () => 0, lowMemoryBytes: 0 });
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const started: string[] = [];
    const pa = gate.run({ instanceName: "a", workingDirectory: "/same", reason: "startup" }, async () => { started.push("a"); await a.promise; });
    const pb = gate.run({ instanceName: "b", workingDirectory: "/same", reason: "startup" }, async () => { started.push("b"); await b.promise; });
    const pc = gate.run({ instanceName: "c", workingDirectory: "/other", reason: "startup" }, async () => { started.push("c"); await c.promise; });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a", "c"]);
    a.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a", "c", "b"]);
    b.resolve(); c.resolve();
    await Promise.all([pa, pb, pc]);
  });

  it("starts no queued work during backoff and caps rolling recovery at four", async () => {
    const storm = new StormWindow({ backoffsMs: [10] });
    const gate = new SpawnGate({ storm, concurrency: () => 10, staggerMs: () => 0, random: () => 0, lowMemoryBytes: 0 });
    storm.recordServerDead("a", ["a"]);
    const blockers = Array.from({ length: 6 }, () => deferred());
    let active = 0;
    let peak = 0;
    const runs = blockers.map((blocker, i) => gate.run({
      instanceName: `i${i}`,
      workingDirectory: `/w${i}`,
      reason: "recovery",
    }, async () => {
      active++;
      peak = Math.max(peak, active);
      await blocker.promise;
      active--;
    }));
    await vi.advanceTimersByTimeAsync(9);
    expect(active).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(active).toBe(4);
    expect(peak).toBe(4);
    blockers.slice(0, 4).forEach(item => item.resolve());
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(2);
    blockers.slice(4).forEach(item => item.resolve());
    await Promise.all(runs);
  });

  it("allows nested acquisition for the same instance without deadlock", async () => {
    const storm = new StormWindow();
    const gate = new SpawnGate({ storm, concurrency: () => 1, staggerMs: () => 0, lowMemoryBytes: 0 });
    const result = await gate.run({ instanceName: "a", workingDirectory: "/a", reason: "startup" }, () =>
      gate.run({ instanceName: "a", workingDirectory: "/a", reason: "startup" }, async () => 42));
    expect(result).toBe(42);
  });
});
