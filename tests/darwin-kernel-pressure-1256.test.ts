import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DarwinMemoryProbe, parseDarwinPressureLevel } from "../src/darwin-memory.js";
import { MemoryPressure } from "../src/memory-pressure.js";
import { SpawnGate } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";
import type { HostMemory } from "../src/host-memory.js";

const MiB = 1024 ** 2;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/darwin-memory/${name}.txt`, import.meta.url), "utf8");
const reported = (level: HostMemory["darwinPressureLevel"] = 1): HostMemory => ({
  totalBytes: 16_000 * MiB, availableBytes: 2_845 * MiB, availableKind: "available",
  swapTotalBytes: 6_000 * MiB, swapFreeBytes: 274 * MiB, darwinPressureLevel: level,
  darwinPressureRaw: level == null ? "kern.memorystatus_vm_pressure_level: 3\n" : `kern.memorystatus_vm_pressure_level: ${level}\n`,
});
const stops: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T00:00:00Z")); });
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

describe("Darwin kernel pressure is the only admission signal", () => {
  it.each([[1, "normal"], [2, "elevated"], [4, "critical"]] as const)("maps kernel %s to %s without RAM/swap ratios", (raw, expected) => {
    expect(parseDarwinPressureLevel(fixture(`kernel-pressure-${raw}`))).toBe(raw);
    const p = new MemoryPressure({ platform: "darwin", read: () => reported(raw) });
    expect(p.sample().level).toBe(expected);
    expect(p.advisoryOnly()).toBe(false);
  });
  it.each(["", "1\n", "kern.memorystatus_vm_pressure_level: 0\n", "kern.memorystatus_vm_pressure_level: 3\n",
    "kern.memorystatus_vm_pressure_level: 8\n", "kern.memorystatus_vm_pressure_level: 01\n",
    "kern.memorystatus_vm_pressure_level: 1.0\n", "kern.memorystatus_vm_pressure_level: 2junk\n",
    "kern.memorystatus_vm_pressure_level: 1\nkern.memorystatus_vm_pressure_level: 4\n",
    "kern.memorystatus_vm_pressure_level: 1\n\n",
    "vm.swapusage: 1\n", "kern.memorystatus_level: 1\n"])("rejects noncanonical alarm output %#", text => {
    expect(parseDarwinPressureLevel(text)).toBeNull();
  });
  it("kernel normal wins even with zero available RAM and no swap free", () => {
    const p = new MemoryPressure({ platform: "darwin", read: () => ({ ...reported(), availableBytes: 0, swapFreeBytes: 0 }) });
    expect(p.sample().level).toBe("normal");
  });
  it.each([2, 4] as const)("kernel %s remains authoritative when vm_stat is unavailable", kernel => {
    const p = new MemoryPressure({ platform: "darwin", read: () => ({ ...reported(kernel), availableBytes: null, availableKind: "unknown" }) });
    expect(p.sample().level).toBe(kernel === 2 ? "elevated" : "critical");
  });
  it("missing kernel data cannot fall back to RAM or swap, and clears a recovery window", () => {
    let value = reported(4);
    const p = new MemoryPressure({ platform: "darwin", read: () => value, monotonicNow: Date.now });
    expect(p.sample().level).toBe("critical");
    value = reported(1); expect(p.sample().recovering).toBe(true);
    value = { ...reported(null), availableBytes: 0, swapFreeBytes: 0 };
    expect(p.sample()).toMatchObject({ level: "unknown", recovering: false });
    expect(p.startRecoveryWindow().recovering).toBe(false);
  });
  it("keeps only the temporal recovery ramp, measured on the monotonic clock", () => {
    let value = reported(4), now = 1;
    const p = new MemoryPressure({ platform: "darwin", read: () => value, monotonicNow: () => now });
    p.sample(); value = reported(1); p.sample();
    vi.setSystemTime(new Date("2040-01-01")); now += 29_999;
    expect(p.sample()).toMatchObject({ level: "elevated", recovering: true });
    now++; expect(p.sample()).toMatchObject({ level: "normal", recovering: false });
  });
  it("Linux keeps its existing swap, critical and unknown policies even with Darwin metadata", () => {
    const p = new MemoryPressure({ platform: "linux", read: () => ({ ...reported(1) }) });
    expect(p.sample().level).toBe("elevated"); // Linux's 5% swap condition is unchanged.
    const healthy = new MemoryPressure({ platform: "linux", read: () => ({ ...reported(4), swapFreeBytes: 4_000 * MiB }) });
    expect(healthy.sample().level).toBe("normal"); // Ignores Darwin's critical alarm.
    const unknown = new MemoryPressure({ platform: "linux", read: () => { throw new Error("missing procfs"); } });
    expect(unknown.sample().level).toBe("unknown"); expect(unknown.advisoryOnly()).toBe(false);
  });
});

describe("sampler scheduling, unknown diagnostics and real gate", () => {
  it("logs the original unknown once per start/stop lifecycle, without repeating after a known sample", () => {
    let value = reported(null); const unknown = vi.fn();
    const p = new MemoryPressure({ platform: "darwin", read: () => value, onDarwinUnknown: unknown }); stops.push(() => p.stop());
    p.start(); p.sample(); expect(unknown).toHaveBeenCalledOnce();
    expect(unknown.mock.calls[0][0]?.darwinPressureRaw).toBe("kern.memorystatus_vm_pressure_level: 3\n");
    value = reported(1); p.sample(); value = reported(null); p.sample(); expect(unknown).toHaveBeenCalledOnce();
    p.stop(); p.start(); expect(unknown).toHaveBeenCalledTimes(2);
  });
  it("admission and health do not start commands; only the existing periodic sampler does", async () => {
    const native = { read: vi.fn(async () => reported()), stop: vi.fn() };
    const p = new MemoryPressure({ platform: "darwin", darwinProbe: native, monotonicNow: Date.now }); stops.push(() => p.stop());
    expect(p.sampleForAdmission()).not.toBeInstanceOf(Promise); p.snapshot(); expect(native.read).not.toHaveBeenCalled();
    p.start(); await vi.advanceTimersByTimeAsync(0); expect(native.read).toHaveBeenCalledOnce();
    for (let i = 0; i < 30; i++) { p.sampleForAdmission(); p.snapshot(); }
    expect(native.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); expect(native.read).toHaveBeenCalledTimes(2);
  });
  it("a stale admission cache cannot consume the once-per-lifecycle raw-read diagnostic", async () => {
    let now = 0, value = reported(); const unknown = vi.fn();
    const native = { read: vi.fn(async () => value), stop: vi.fn() };
    const p = new MemoryPressure({ platform: "darwin", darwinProbe: native, monotonicNow: () => now, onDarwinUnknown: unknown });
    stops.push(() => p.stop()); p.start(); await vi.advanceTimersByTimeAsync(0);
    now = 30_000; expect(p.sampleForAdmission()).toMatchObject({ level: "unknown" });
    expect(unknown).not.toHaveBeenCalled(); expect(native.read).toHaveBeenCalledOnce();
    value = reported(null); p.sample(); await vi.advanceTimersByTimeAsync(0);
    expect(unknown).toHaveBeenCalledOnce(); expect(unknown.mock.calls[0][0]?.darwinPressureRaw).toBe(value.darwinPressureRaw);
  });
  it("diagnostic readers never request the kernel pressure command", async () => {
    const run = vi.fn(asyncRunner);
    const probe = new DarwinMemoryProbe({ run, totalmem: () => reported().totalBytes }); stops.push(() => probe.stop());
    await probe.read(); expect(run.mock.calls).toEqual([["/usr/bin/vm_stat", []], ["/usr/sbin/sysctl", ["vm.swapusage"]]]);
  });
  it("pressure is independently parsed when the diagnostic RAM read fails", async () => {
    const run = vi.fn((file: string, args: string[]) => asyncRunner(file, args, false));
    const probe = new DarwinMemoryProbe({ run, totalmem: () => reported().totalBytes, includePressure: true }); stops.push(() => probe.stop());
    expect(await probe.read()).toMatchObject({ availableBytes: null, darwinPressureLevel: 1, darwinPressureRaw: fixture("kernel-pressure-1") });
    expect(run.mock.calls[2]).toEqual(["/usr/sbin/sysctl", ["kern.memorystatus_vm_pressure_level"]]);
  });
  it("bounds raw unknown output and retains an unclosed pressure child across stop/start", async () => {
    let close!: () => void;
    const stopped = new Promise<void>(resolve => { close = resolve; });
    const raw = "kern.memorystatus_vm_pressure_level: 3\n" + "x".repeat(2000);
    const run = vi.fn((file: string, args: string[]) => args[0] === "kern.memorystatus_vm_pressure_level"
      ? { result: Promise.resolve(raw), stopped, kill: vi.fn() } : asyncRunner(file, args));
    const probe = new DarwinMemoryProbe({ run, totalmem: () => reported().totalBytes, includePressure: true, now: Date.now }); stops.push(() => probe.stop());
    expect(await probe.read()).toMatchObject({ darwinPressureLevel: null, darwinPressureRaw: raw.slice(0, 1024) });
    probe.stop(); await vi.advanceTimersByTimeAsync(30_000);
    expect((await probe.read()).darwinPressureLevel).toBeNull(); expect(run).toHaveBeenCalledTimes(3);
    close(); await vi.advanceTimersByTimeAsync(0); await probe.read(); expect(run).toHaveBeenCalledTimes(6);
  });
  function asyncRunner(file: string, args: string[], goodRam = true) {
    const output = file.endsWith("vm_stat") ? goodRam ? fixture("vm-stat-dts-16k") : null
      : args[0] === "vm.swapusage" ? fixture("swap-4k") : fixture("kernel-pressure-1");
    return { result: Promise.resolve(output), stopped: Promise.resolve(), kill: vi.fn() };
  }
  it("unknown releases a real critical hold and its old recovery ramp without changing configured limits", async () => {
    let value = reported(4);
    const p = new MemoryPressure({ platform: "darwin", read: () => value });
    const storm = new StormWindow();
    const gate = new SpawnGate({ storm, memoryPressure: p, concurrency: () => 3, staggerMs: () => 0 });
    stops.push(() => { gate.shutdown(); p.stop(); storm.shutdown(); });
    const work = vi.fn(async () => 1), runs: Promise<number>[] = [];
    for (const name of ["a", "b", "c"]) { const r = gate.run({ instanceName: name, workingDirectory: `/${name}`, reason: "wake" }, work); void r.catch(() => {}); runs.push(r); }
    expect(work).not.toHaveBeenCalled();
    value = reported(null); p.sample(); await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledTimes(3); expect((gate as any).pressureHeld).toBe(false);
    expect(p.snapshot().recovering).toBe(false); await Promise.all(runs);
  });
  it("a real gate slows kernel warning to the existing 5-second stagger", async () => {
    const p = new MemoryPressure({ platform: "darwin", read: () => reported(2) });
    const storm = new StormWindow(); const gate = new SpawnGate({ storm, memoryPressure: p, concurrency: () => 3, staggerMs: () => 0 });
    stops.push(() => { gate.shutdown(); p.stop(); storm.shutdown(); });
    const work = vi.fn(async () => 1);
    const a = gate.run({ instanceName: "a", workingDirectory: "/a", reason: "startup" }, work);
    const b = gate.run({ instanceName: "b", workingDirectory: "/b", reason: "startup" }, work); void b.catch(() => {});
    await vi.advanceTimersByTimeAsync(0); expect(work).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999); expect(work).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(work).toHaveBeenCalledTimes(2); await Promise.all([a, b]);
  });
});
