import { afterEach, describe, expect, it, vi } from "vitest";
import { SpawnGate } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";
import { MemoryPressure } from "../src/memory-pressure.js";
afterEach(() => vi.useRealTimers());
describe("collateral OOM uses the shared pressure policy", () => {
  it("only the explicit zero-threshold opt-out bypasses sampling and a pressure-held recovery", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const sampleForAdmission = vi.fn(() => ({ level: "critical", sampledAt: Date.now(), recovering: false }));
    const memory = { sampleForAdmission, snapshot: sampleForAdmission, advisoryOnly: () => false, onUpdate: () => () => {} } as unknown as MemoryPressure;
    const gate = new SpawnGate({ memoryPressure: memory, storm: new StormWindow(), concurrency: () => 6, staggerMs: () => 0, lowMemoryBytes: 0 });
    const spawn = vi.fn(async () => 42);
    await expect(gate.run({ instanceName: "opted-out", workingDirectory: "/scratch", reason: "recovery", requireNormalMemory: true }, spawn)).resolves.toBe(42);
    expect(sampleForAdmission).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledTimes(1); gate.shutdown();
  });
  it("waits through elevated/critical/unknown then starts once normal; ordinary pacing remains", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    let level = "elevated";
    const snapshot = () => ({ level, sampledAt: Date.now(), recovering: false });
    const memory = { sampleForAdmission: snapshot, snapshot, advisoryOnly: () => false, onUpdate: () => () => {}, startRecoveryWindow: snapshot } as unknown as MemoryPressure;
    const gate = new SpawnGate({ memoryPressure: memory, storm: new StormWindow(), concurrency: () => 6, staggerMs: () => 500 });
    const spawn = vi.fn(async () => 42);
    const p = gate.run({ instanceName: "worker", workingDirectory: "/scratch", reason: "recovery", requireNormalMemory: true }, spawn);
    for (const next of ["elevated", "critical", "unknown"]) { level = next; await vi.advanceTimersByTimeAsync(60_000); expect(spawn).not.toHaveBeenCalled(); }
    level = "normal"; await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe(42); expect(spawn).toHaveBeenCalledTimes(1); gate.shutdown();
  });
  it("shutdown rejects a pressure-held recovery without spawning", async () => {
    vi.useFakeTimers();
    const snapshot = () => ({ level: "elevated", sampledAt: Date.now() });
    const memory = { sampleForAdmission: snapshot, snapshot, advisoryOnly: () => false, onUpdate: () => () => {} } as unknown as MemoryPressure;
    const gate = new SpawnGate({ memoryPressure: memory, storm: new StormWindow(), concurrency: () => 6, staggerMs: () => 0 });
    const spawn = vi.fn();
    const p = gate.run({ instanceName: "worker", workingDirectory: "/scratch", reason: "recovery", requireNormalMemory: true }, spawn);
    const rejected = expect(p).rejects.toThrow("shut down"); gate.shutdown(); await rejected;
    expect(spawn).not.toHaveBeenCalled();
  });
});

it("a held collateral recovery does not block other elevated-pressure work or extend a startup deadline", async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  let level = "elevated";
  const snapshot = () => ({ level, sampledAt: Date.now(), recovering: false });
  const memory = { sampleForAdmission: snapshot, snapshot, advisoryOnly: () => false, onUpdate: () => () => {}, startRecoveryWindow: snapshot } as unknown as MemoryPressure;
  const extension = vi.fn();
  const gate = new SpawnGate({ memoryPressure: memory, storm: new StormWindow(), concurrency: () => 6, staggerMs: () => 500, onStartupMemoryWait: extension });
  const held = vi.fn(async () => {}), ordinary = vi.fn(async () => {});
  const p = gate.run({ instanceName: "collateral", workingDirectory: "/a", reason: "recovery", requireNormalMemory: true }, held);
  const q = gate.run({ instanceName: "ordinary", workingDirectory: "/b", reason: "startup" }, ordinary);
  await vi.advanceTimersByTimeAsync(5000); await q;
  expect(ordinary).toHaveBeenCalledTimes(1); expect(held).not.toHaveBeenCalled();
  expect(extension).not.toHaveBeenCalled();
  level = "normal"; await vi.advanceTimersByTimeAsync(5000); await p; gate.shutdown();
});
