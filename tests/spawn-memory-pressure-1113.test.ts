import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpawnGate, type SpawnTask } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";
import { MemoryPressure } from "../src/memory-pressure.js";
import type { HostMemory } from "../src/host-memory.js";

const MiB = 1024 * 1024;
const memory = (available = 4_000, swapFree = 4_000): HostMemory => ({ totalBytes: 16_000 * MiB,
  availableBytes: available * MiB, availableKind: "available", swapTotalBytes: 8_000 * MiB, swapFreeBytes: swapFree * MiB });
const task = (name: string, directory = `/${name}`) => ({ instanceName: name, workingDirectory: directory, reason: "startup" as const });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
// Mutation assertions may stop a test before it awaits queued work. Attach
// cleanup handlers without changing the original promise's observable outcome.
function track<T>(promise: Promise<T>): Promise<T> { void promise.catch(() => {}); return promise; }

describe("SpawnGate memory resilience", () => {
  const gates: SpawnGate[] = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T00:00:00Z")); });
  afterEach(() => { gates.splice(0).forEach(gate => gate.shutdown()); vi.useRealTimers(); });
  function make(read: () => HostMemory, concurrency = 10, stagger = 0, storm = new StormWindow()) {
    const gate = new SpawnGate({ storm, memoryPressure: new MemoryPressure({ read }),
      concurrency: () => concurrency, staggerMs: () => stagger, random: () => 0 });
    return own(gate);
  }
  function own(gate: SpawnGate): SpawnGate {
    gates.push(gate);
    const run = gate.run.bind(gate);
    gate.run = <T>(task: SpawnTask, operation: () => Promise<T>) => track(run(task, operation));
    return gate;
  }

  it("admits concurrent macOS unknown physical and lifecycle work immediately", async () => {
    const pressure = new MemoryPressure({ platform: "darwin", read: () => ({ ...memory(), availableBytes: null, availableKind: "unknown" }) });
    const gate = own(new SpawnGate({ storm: new StormWindow(), memoryPressure: pressure, concurrency: () => 3, staggerMs: () => 0 }));
    const held = deferred(); const operation = vi.fn(() => held.promise);
    const runs = [gate.run(task("a"), operation), gate.run({ ...task("b"), stage: "lifecycle" }, operation), gate.run(task("c"), operation)];
    expect(operation).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    held.resolve(); await Promise.all(runs);
  });

  it("clears macOS critical hold and old ramp as soon as a sample becomes unknown", async () => {
    let value = memory(100);
    const pressure = new MemoryPressure({ platform: "darwin", read: () => value });
    const gate = own(new SpawnGate({ storm: new StormWindow(), memoryPressure: pressure, concurrency: () => 2, staggerMs: () => 0 }));
    const held = deferred(); const operation = vi.fn(() => held.promise);
    const a = gate.run(task("a"), operation); const b = gate.run(task("b"), operation);
    expect(operation).not.toHaveBeenCalled();
    value = { ...memory(), availableBytes: null, availableKind: "unknown" };
    pressure.sample();
    expect(operation).toHaveBeenCalledTimes(2);
    expect(pressure.snapshot().recovering).toBe(false);
    expect((gate as any).pressureHeld).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    held.resolve(); await Promise.all([a, b]);
  });

  it("holds the very first spawn and backs off 5/10/20/40/60 seconds without retrying operations", async () => {
    const read = vi.fn(() => memory(100, 0));
    const gate = make(read);
    const operation = vi.fn(async () => 42);
    const run = gate.run(task("a"), operation);
    const rejected = track(expect(run).rejects.toThrow("shut down"));
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000 + 40_000 + 60_000);
    expect(read).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(7);
    expect(operation).not.toHaveBeenCalled();
    gate.shutdown();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["wake", "recovery", "restart"] as const)("also holds %s work at an empty gate", async reason => {
    const gate = make(() => memory(100, 0));
    const operation = vi.fn(async () => 42);
    const run = gate.run({ ...task("a"), reason }, operation);
    const rejected = track(expect(run).rejects.toThrow("shut down"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(operation).not.toHaveBeenCalled();
    gate.shutdown(); await rejected;
  });

  it("starts the slow ramp at actual admission even if background recovery was observed earlier", async () => {
    let state = memory(100, 0);
    const pressure = new MemoryPressure({ read: () => state });
    pressure.start();
    const gate = own(new SpawnGate({ storm: new StormWindow(), memoryPressure: pressure, concurrency: () => 10, staggerMs: () => 0 }));
    const blockers = Array.from({ length: 3 }, () => deferred());
    const started: string[] = [];
    const runs = blockers.map((b, i) => gate.run(task(`i${i}`), async () => { started.push(`i${i}`); await b.promise; }));
    try {
      await vi.advanceTimersByTimeAsync(75_000);
      state = memory();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(pressure.snapshot().level).toBe("normal");
      expect(started).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual(["i0"]);
      expect(pressure.snapshot()).toMatchObject({ level: "elevated", recovering: true });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(started).toEqual(["i0"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual(["i0", "i1", "i2"]);
      blockers.forEach(b => b.resolve());
      await Promise.all(runs);
    } finally { pressure.stop(); }
  });

  it.each([undefined, "lifecycle"] as const)("does not spend recovery time while an old %s slot is occupied", async stage => {
    let state = memory();
    const pressure = new MemoryPressure({ read: () => state });
    const gate = own(new SpawnGate({ storm: new StormWindow(), memoryPressure: pressure,
      concurrency: () => 10, staggerMs: () => 0 }));
    const blockers = [deferred(), deferred(), deferred()];
    const started: Array<{ name: string; at: number }> = [];
    const base = Date.now();
    const a = gate.run({ ...task("old"), stage }, async () => {
      started.push({ name: "old", at: Date.now() - base }); await blockers[0].promise;
    });
    state = memory(100, 0);
    const b = gate.run(task("b"), async () => {
      started.push({ name: "b", at: Date.now() - base }); await blockers[1].promise;
    });
    const c = gate.run(task("c"), async () => {
      started.push({ name: "c", at: Date.now() - base }); await blockers[2].promise;
    });
    try {
      state = memory();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(started).toEqual([{ name: "old", at: 0 }]);
      blockers[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual([{ name: "old", at: 0 }, { name: "b", at: 20_000 }]);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(started.map(s => s.name)).toEqual(["old", "b"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual([{ name: "old", at: 0 }, { name: "b", at: 20_000 }, { name: "c", at: 50_000 }]);
      blockers.forEach(blocker => blocker.resolve());
      await Promise.all([a, b, c]);
    } finally { blockers.forEach(blocker => blocker.resolve()); gate.shutdown(); }
  });

  it("starts a held task's recovery ramp after the configured stagger has elapsed", async () => {
    let state = memory();
    const gate = make(() => state, 10, 10_000);
    await gate.run(task("old"), async () => {});
    state = memory(100, 0);
    const blocker = deferred();
    const started: string[] = [];
    const b = gate.run(task("b"), async () => { started.push("b"); await blocker.promise; });
    const c = gate.run(task("c"), async () => { started.push("c"); });
    try {
      state = memory();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(started).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual(["b"]);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(started).toEqual(["b"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual(["b", "c"]);
      blocker.resolve();
      await Promise.all([b, c]);
    } finally { blocker.resolve(); gate.shutdown(); }
  });

  it("slowly resumes queued work with no recovery herd, then restores configured concurrency", async () => {
    let state = memory(100, 0);
    const gate = make(() => state, 10);
    const starts: number[] = [];
    const blockers = Array.from({ length: 4 }, () => deferred());
    const runs = blockers.map((b, i) => gate.run(task(`i${i}`), async () => { starts.push(Date.now()); await b.promise; }));
    state = memory();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toHaveLength(1); // Slow phase holds concurrency at one.
    blockers[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(2);
    blockers[1].resolve();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    // The slow window elapsed: configured concurrency resumes even while i2 runs.
    expect(starts).toHaveLength(4);
    blockers[2].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(4);
    blockers[3].resolve();
    await Promise.all(runs);
  });

  it("throttles healthy-RAM/exhausted-swap to one start per five seconds", async () => {
    const gate = make(() => memory(4_000, 0));
    const started: string[] = [];
    const first = deferred();
    const a = gate.run(task("a"), async () => { started.push("a"); await first.promise; });
    const b = gate.run(task("b"), async () => { started.push("b"); });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(started).toEqual(["a"]);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a", "b"]);
    await Promise.all([a, b]);
    const c = gate.run(task("c"), async () => { started.push("c"); });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(started).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1);
    await c;
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("rechecks nested physical spawns without reacquiring the outer slot/workdir", async () => {
    let state = memory();
    const gate = make(() => state, 1);
    const entered = deferred();
    const nestedStarted = vi.fn(async () => 42);
    const outer = gate.run({ ...task("a"), stage: "lifecycle" }, async () => {
      await entered.promise;
      return gate.run(task("a"), nestedStarted);
    });
    state = memory(100, 0);
    entered.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(nestedStarted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(nestedStarted).not.toHaveBeenCalled();
    state = memory();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outer).toBe(42);
    expect(nestedStarted).toHaveBeenCalledOnce();
  });

  it("rejects nested pressure waiters on shutdown, with no delayed spawn", async () => {
    let state = memory();
    const gate = make(() => state, 1);
    const entered = deferred();
    const operation = vi.fn(async () => 42);
    const outer = gate.run({ ...task("a"), stage: "lifecycle" }, async () => { await entered.promise; return gate.run(task("a"), operation); });
    const settled = vi.fn();
    void outer.then(value => settled(null, value), error => settled(error));
    state = memory(100);
    entered.resolve();
    await vi.advanceTimersByTimeAsync(0);
    gate.shutdown();
    state = memory();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: "Spawn gate shut down before task started" }));
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unavailable memory slows but does not block forever", async () => {
    const gate = make(() => { throw new Error("unreadable"); });
    const started: string[] = [];
    const a = gate.run(task("a"), async () => { started.push("a"); });
    const b = gate.run(task("b"), async () => { started.push("b"); });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(started).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([a, b]);
    expect(started).toEqual(["a", "b"]);
  });

  it("serializes physical spawns if pressure changes after several lifecycle reservations", async () => {
    let state = memory();
    const gate = make(() => state, 3);
    const enter = deferred();
    const blockers = [deferred(), deferred()];
    const started: string[] = [];
    const a = gate.run({ ...task("a"), stage: "lifecycle" }, async () => {
      await enter.promise;
      await gate.run(task("a"), async () => { started.push("a"); await blockers[0].promise; });
    });
    const b = gate.run({ ...task("b"), stage: "lifecycle" }, async () => {
      await enter.promise;
      await gate.run(task("b"), async () => { started.push("b"); await blockers[1].promise; });
    });
    state = memory(4_000, 0);
    enter.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(started).toEqual(["a"]);
    blockers[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a", "b"]);
    blockers[1].resolve();
    await Promise.all([a, b]);
  });

  it("limits outer lifecycle admissions under pressure as well as physical spawns", async () => {
    const gate = make(() => memory(4_000, 0), 10);
    const blockers = [deferred(), deferred()];
    const started: string[] = [];
    const runs = blockers.map((b, i) => gate.run({ ...task(`i${i}`), stage: "lifecycle" }, async () => { started.push(`i${i}`); await b.promise; }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(started).toEqual(["i0"]);
    blockers[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["i0", "i1"]);
    blockers[1].resolve();
    await Promise.all(runs);
  });

  it("keeps configured stagger/workdir and storm caps as additional limits", async () => {
    const storm = new StormWindow({ backoffsMs: [10] });
    const gate = make(() => memory(), 10, 100, storm);
    storm.recordServerDead("a", ["a"]);
    const blockers = Array.from({ length: 6 }, () => deferred());
    const started: string[] = [];
    const runs = blockers.map((b, i) => gate.run(task(`i${i}`, i === 1 ? "/i0" : `/i${i}`), async () => { started.push(`i${i}`); await b.promise; }));
    await vi.advanceTimersByTimeAsync(9);
    expect(started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(["i0"]);
    await vi.advanceTimersByTimeAsync(299);
    expect(started).toEqual(["i0", "i2", "i3"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(["i0", "i2", "i3", "i4"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toHaveLength(4);
    blockers[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started.at(-1)).toBe("i1");
    blockers.forEach(b => b.resolve());
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(runs);
    gate.shutdown();
    storm.shutdown();
  });
});
