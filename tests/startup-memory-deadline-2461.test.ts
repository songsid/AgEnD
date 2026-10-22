import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupMemoryDeadline, STARTUP_MEMORY_EXTENSION_US, fleetStopConcurrency } from "../src/startup-memory-deadline.js";
import { SpawnGate } from "../src/spawn-gate.js";
import { MemoryPressure } from "../src/memory-pressure.js";
import { StormWindow } from "../src/storm-window.js";

describe("startup memory deadline (#2461)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T00:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  function rig() {
    let current = true, waiting = false;
    const notify = vi.fn(), log = vi.fn();
    const lease = new StartupMemoryDeadline({ current: () => current, waiting: () => waiting,
      notify, log, now: Date.now });
    return { lease, notify, log, hold: () => { waiting = true; lease.check(); },
      recover: () => { waiting = false; lease.check(); }, replace: () => { current = false; } };
  }

  it("renews a deliberate hold beyond the original 15 minutes without declaring READY", async () => {
    const r = rig(); r.hold();
    expect(r.notify).toHaveBeenCalledWith(expect.stringContaining(`EXTEND_TIMEOUT_USEC=${STARTUP_MEMORY_EXTENSION_US}`));
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(r.notify).toHaveBeenCalledTimes(33);
    expect(r.notify.mock.calls.every(([state]) => !state.includes("READY=1"))).toBe(true);
    expect(r.log).toHaveBeenCalledTimes(2);
    r.lease.stop();
  });

  it("does not extend an ordinary stuck startup or keep renewing after memory recovery", async () => {
    const r = rig(); await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(r.notify).not.toHaveBeenCalled();
    r.hold(); r.recover(); r.notify.mockClear();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(r.notify).not.toHaveBeenCalled(); r.lease.stop();
  });

  it("stops on failure/shutdown and cannot notify for a replacement startup", async () => {
    const old = rig(); old.hold(); old.replace(); old.notify.mockClear();
    const next = rig(); next.hold();
    await vi.advanceTimersByTimeAsync(60_000); old.lease.check();
    expect(old.notify).not.toHaveBeenCalled(); expect(next.notify).toHaveBeenCalledTimes(3);
    next.lease.stop(); next.notify.mockClear();
    await vi.advanceTimersByTimeAsync(60_000); next.lease.check();
    expect(next.notify).not.toHaveBeenCalled();
  });

  it("emits the first extension immediately but coalesces admission retry callbacks", () => {
    const r = rig(); for (let i = 0; i < 20; i++) r.hold();
    expect(r.notify).toHaveBeenCalledTimes(1); r.lease.stop();
  });

  it.each(["critical", "elevated"])("bounds bulk stops under %s pressure without blocking them", pressure => {
    expect(fleetStopConcurrency(47, pressure)).toBe(5);
    expect(fleetStopConcurrency(12, pressure)).toBe(5);
  });
  it("keeps normal stop batches and has no pressure-recovery wait", () => {
    expect([5, 12, 47].map(n => fleetStopConcurrency(n, "normal"))).toEqual([5, 10, 15]);
    expect(fleetStopConcurrency(47, "unknown")).toBe(15);
  });

  it("only exposes actual queued startup memory waits, including nested physical spawns", async () => {
    let critical = true;
    const memory = new MemoryPressure({ platform: "linux", read: () => ({ totalBytes: 16e9,
      availableBytes: critical ? 10e6 : 8e9, availableKind: "available", swapTotalBytes: 0, swapFreeBytes: 0 }) });
    const onWait = vi.fn(); const storm = new StormWindow();
    const gate = new SpawnGate({ storm, memoryPressure: memory, concurrency: () => 2, staggerMs: () => 0,
      onStartupMemoryWait: onWait });
    const operation = vi.fn(async () => 1);
    const pending = gate.run({ instanceName: "a", workingDirectory: "/a", reason: "startup" }, operation);
    expect(gate.isStartupMemoryDeferred()).toBe(true); expect(onWait).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    critical = false; await vi.advanceTimersByTimeAsync(5_000); await pending;
    expect(gate.isStartupMemoryDeferred()).toBe(false);
    // An outer lifecycle can reach critical pressure after reserving its slot.
    await vi.advanceTimersByTimeAsync(30_000);
    const nested = gate.run({ instanceName: "b", workingDirectory: "/b", reason: "startup", stage: "lifecycle" }, () => {
      critical = true;
      return gate.run({ instanceName: "b", workingDirectory: "/b", reason: "startup" }, operation);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.isStartupMemoryDeferred()).toBe(true);
    critical = false; await vi.advanceTimersByTimeAsync(5_000); await nested;
    gate.shutdown(); expect(gate.isStartupMemoryDeferred()).toBe(false); memory.stop(); storm.shutdown();
  });

  it("does not expose a runtime recovery hold as a startup wait, or infer a wait from an active hung callback", async () => {
    const memory = new MemoryPressure({ platform: "linux", read: () => ({ totalBytes: 16e9,
      availableBytes: 10e6, availableKind: "available", swapTotalBytes: 0, swapFreeBytes: 0 }) });
    const storm = new StormWindow(), onWait = vi.fn();
    const gate = new SpawnGate({ storm, memoryPressure: memory, concurrency: () => 1, staggerMs: () => 0, onStartupMemoryWait: onWait });
    const pending = gate.run({ instanceName: "r", workingDirectory: "/r", reason: "recovery" }, async () => {}).catch(() => {});
    expect(gate.isStartupMemoryDeferred()).toBe(false); expect(onWait).not.toHaveBeenCalled();
    gate.shutdown(); await pending; memory.stop(); storm.shutdown();
    let done!: () => void;
    const clean = new SpawnGate({ storm: new StormWindow(), concurrency: () => 1, staggerMs: () => 0, lowMemoryBytes: 0 });
    const hung = clean.run({ instanceName: "h", workingDirectory: "/h", reason: "startup" }, () => new Promise<void>(r => { done = r; }));
    expect(clean.isStartupMemoryDeferred()).toBe(false); done(); await hung; clean.shutdown();
  });
});
