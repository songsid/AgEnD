import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHostMemory, type HostMemory } from "../src/host-memory.js";
import { MemoryPressure } from "../src/memory-pressure.js";

const MiB = 1024 * 1024;
function memory(available = 4_000, swapFree: number | null = 4_000): HostMemory {
  return { totalBytes: 16_000 * MiB, availableBytes: available * MiB, availableKind: "available",
    swapTotalBytes: swapFree === null ? null : 8_000 * MiB, swapFreeBytes: swapFree === null ? null : swapFree * MiB };
}

describe("host memory pressure", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T00:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("uses Linux MemAvailable and distinguishes absent/missing/exhausted swap", () => {
    const meminfo = (swap: string) => `MemTotal: 16000000 kB\nMemFree: 1000 kB\nMemAvailable: 4000000 kB\n${swap}`;
    const read = (swap: string) => readHostMemory({ platform: "linux", meminfo: () => meminfo(swap) });
    expect(read("SwapTotal: 8000000 kB\nSwapFree: 0 kB\n")).toMatchObject({
      availableKind: "available", availableBytes: 4_000_000 * 1024, swapFreeBytes: 0,
    });
    expect(read("SwapTotal: 0 kB\nSwapFree: 0 kB\n").swapTotalBytes).toBe(0);
    expect(read("SwapFree: 0 kB\n").swapTotalBytes).toBeNull();
  });

  it("falls back without inventing swap, and does not hold on MemFree alone", () => {
    const fallback = readHostMemory({ platform: "linux", meminfo: () => { throw new Error("unavailable"); },
      totalmem: () => 16_000 * MiB, freemem: () => 1 * MiB });
    expect(fallback).toMatchObject({ availableKind: "free", swapFreeBytes: null });
    expect(new MemoryPressure({ read: () => fallback }).sample().level).toBe("elevated");
  });

  it.each([
    [100, 4_000, "critical"], [700, 0, "critical"], [700, 4_000, "elevated"],
    [4_000, 0, "elevated"], [4_000, null, "normal"], [4_000, 4_000, "normal"],
  ] as const)("classifies available=%s MiB swapFree=%s MiB as %s", (available, swapFree, expected) => {
    expect(new MemoryPressure({ read: () => memory(available, swapFree) }).sample().level).toBe(expected);
  });

  it("does not treat no configured swap as exhausted swap", () => {
    expect(new MemoryPressure({ read: () => ({ ...memory(), swapTotalBytes: 0, swapFreeBytes: 0 }) }).sample().level).toBe("normal");
  });

  it("uses hysteresis and a full slow recovery window", async () => {
    let available = 100;
    const pressure = new MemoryPressure({ read: () => memory(available) });
    expect(pressure.sample().level).toBe("critical");
    available = 400;
    expect(pressure.sample().level).toBe("critical"); // Above 320 MiB, below 480 MiB recovery.
    available = 4_000;
    expect(pressure.sample()).toMatchObject({ level: "elevated", recovering: true });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pressure.sample().level).toBe("elevated");
    await vi.advanceTimersByTimeAsync(1);
    expect(pressure.sample()).toMatchObject({ level: "normal", recovering: false });
    available = 780;
    expect(pressure.sample().level).toBe("elevated");
    available = 850;
    expect(pressure.sample().level).toBe("elevated");
    available = 1_000;
    expect(pressure.sample().level).toBe("normal");
  });

  it.each([
    [850, 4_000, 960, 4_000],
    [4_000, 480, 4_000, 801],
  ])("keeps hysteresis after recovery with RAM=%s MiB and swap=%s MiB", async (available, swap, clearRam, clearSwap) => {
    let state = memory(100, 0);
    const pressure = new MemoryPressure({ read: () => state });
    expect(pressure.sample().level).toBe("critical");
    state = memory(available, swap);
    expect(pressure.sample()).toMatchObject({ level: "elevated", recovering: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pressure.sample()).toMatchObject({ level: "elevated", recovering: false });
    state = memory(clearRam, clearSwap);
    expect(pressure.sample()).toMatchObject({ level: "normal", recovering: false });
  });

  it("bounds sampling/trends, and health reads cannot earn recovery time", async () => {
    let sample = memory();
    const pressure = new MemoryPressure({ read: () => sample });
    pressure.start();
    try {
      for (let i = 0; i < 100; i++) pressure.sample();
      expect(pressure.snapshot()).toMatchObject({ samples: 1, trend: null });
      sample = memory(3_000, 3_500);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pressure.snapshot().trend).toEqual({ availableBytesPerMinute: -1_000 * MiB, swapFreeBytesPerMinute: -500 * MiB });
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(pressure.snapshot().samples).toBe(12);
      const original = pressure.snapshot();
      const copy = pressure.snapshot();
      copy.memory!.availableBytes = 0;
      copy.trend!.availableBytesPerMinute = 999;
      expect(pressure.snapshot()).toEqual(original);
    } finally { pressure.stop(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls only after start, starts once, and stops diagnostics synchronously", async () => {
    const onSample = vi.fn();
    const pressure = new MemoryPressure({ read: () => memory(100), onSample });
    pressure.sample();
    expect(onSample).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    pressure.start(); pressure.start();
    expect(vi.getTimerCount()).toBe(1);
    expect(onSample).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSample).toHaveBeenCalledTimes(2);
    pressure.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSample).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sampling and diagnostics failures never throw or fabricate zero memory", () => {
    const pressure = new MemoryPressure({ read: () => { throw new Error("procfs unavailable"); },
      onSample: () => { throw new Error("logger unavailable"); } });
    expect(() => pressure.start()).not.toThrow();
    expect(pressure.snapshot()).toMatchObject({ level: "unknown", memory: null, trend: null });
    pressure.stop();
    const invalid = new MemoryPressure({ read: () => ({ ...memory(), availableBytes: NaN }) });
    expect(invalid.sample().level).toBe("unknown");
    const invalidSwap = new MemoryPressure({ read: () => ({ ...memory(), swapFreeBytes: -1 }) });
    expect(invalidSwap.sample().memory!.swapFreeBytes).toBeNull();
  });
});
