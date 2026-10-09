import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DarwinMemoryProbe, parseDarwinAvailable, parseDarwinSwap, parseDarwinPressureLevel, type MemoryCommand } from "../src/darwin-memory.js";
import { MemoryPressure } from "../src/memory-pressure.js";
import { SpawnGate } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";

const MiB = 1024 ** 2, total = 16_000 * MiB;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/darwin-memory/${name}.txt`, import.meta.url), "utf8");
const healthy = fixture("vm-stat-dts-16k"), swap = fixture("swap-4k");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness() {
  const commands: Array<MemoryCommand & { output(value: string | null): void; close(): void }> = [];
  const run = vi.fn((_file: string, _args: string[]) => {
    const result = deferred<string | null>(), stopped = deferred<void>();
    const command = { result: result.promise, stopped: stopped.promise, kill: vi.fn(), output: result.resolve, close: () => stopped.resolve() };
    commands.push(command); return command;
  });
  const probe = new DarwinMemoryProbe({ includePressure: true, run, totalmem: () => total, now: Date.now });
  const complete = (index = 0, vm = healthy, swapText: string | null = swap, pressureText: string | null = "kern.memorystatus_vm_pressure_level: 1\n") => {
    commands[index].output(vm); commands[index + 1].output(swapText); commands[index + 2].output(pressureText);
    commands[index].close(); commands[index + 1].close(); commands[index + 2].close();
  };
  return { run, commands, probe, complete };
}
const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T00:00:00Z")); });
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

// All probe commands are injected promises. No real CLI/fleet/tmux/subprocess.
describe("macOS native memory formats", () => {
  it("uses the real 4KiB and 16KiB headers and counts speculative once", () => {
    expect(parseDarwinAvailable(fixture("vm-stat-4k"), total)).toBe((54315 + 14180 + 1090096) * 4096);
    expect(parseDarwinAvailable(fixture("vm-stat-16k"), total)).toBe((20309 + 550 + 153796) * 16384);
    expect(parseDarwinAvailable(healthy, total)).toBe(3121.6875 * MiB);
    expect(13765 * 16384 / MiB).toBe(215.078125); // Low free alone is not pressure.
  });
  it("takes max for overlapping inactive/purgeable and excludes active/wired/compressor", () => {
    const vm = healthy.replace("Pages purgeable: 1509.", "Pages purgeable: 200000.");
    expect(parseDarwinAvailable(vm, total)).toBe((13765 + 5770 + 200000) * 16384);
    expect(parseDarwinAvailable(vm.replace("Pages active: 188532.", "Pages active: 9000000000000."), total)).toBe(parseDarwinAvailable(vm, total));
  });
  it.each([
    "", healthy.replace("Pages free: 13765.\n", ""), healthy + "Pages free: 1.\n",
    healthy + "Pages free: NaN.\n", healthy.replace("Pages inactive: 180253.", "Pages inactive: -1."),
    healthy.replace("16384", "0"), healthy.replace("16384", "1234"),
    healthy.replace("13765", "9007199254740992"), healthy.replace("13765", "9000000000000"),
    healthy + "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n",
  ])("rejects incomplete, duplicate, invalid and unsafe statistics %#", text => {
    expect(parseDarwinAvailable(text, total)).toBeNull();
  });
  it("does not clamp a sample larger than physical RAM into a healthy sample", () => {
    expect(parseDarwinAvailable(healthy, 100 * MiB)).toBeNull();
  });
  it("parses real decimal binary MiB and optional encrypted marker", () => {
    expect(parseDarwinSwap(swap)).toEqual({ swapTotalBytes: 2048 * MiB, swapFreeBytes: 1505.75 * MiB });
    expect(parseDarwinSwap(fixture("swap-16k"))).toEqual({ swapTotalBytes: 11264 * MiB, swapFreeBytes: Math.round(482.88 * MiB) });
    expect(parseDarwinSwap("vm.swapusage: total = 1.00M used = 0.34M free = 0.67M")).toEqual({ swapTotalBytes: MiB, swapFreeBytes: Math.round(0.67 * MiB) });
    expect(parseDarwinSwap("vm.swapusage: total = 0.00M used = 0.00M free = 0.00M")).toEqual({ swapTotalBytes: 0, swapFreeBytes: 0 });
  });
  it.each(["", "vm.swapusage: total = 1.00M used = 0.00M free = 2.00M", "vm.swapusage: total = 1.00M used = 0.00M free = 0.10M", "vm.swapusage: total = -1.00M used = 0.00M free = 0.00M", swap + swap])("keeps malformed/missing swap unknown %#", text => {
    expect(parseDarwinSwap(text)).toEqual({ swapTotalBytes: null, swapFreeBytes: null });
  });
});

describe("bounded macOS reader", () => {
  it("single-flights parallel calls, caches 30 seconds and returns independent values", async () => {
    const h = harness(); cleanups.push(() => h.probe.stop());
    const a = h.probe.read(), b = h.probe.read(); expect(h.run.mock.calls).toEqual([["/usr/bin/vm_stat", []], ["/usr/sbin/sysctl", ["vm.swapusage"]], ["/usr/sbin/sysctl", ["kern.memorystatus_vm_pressure_level"]]]);
    h.complete(); const value = await a;
    expect(await b).toEqual(value); value.availableBytes = 0;
    const cached = h.probe.read(); expect(h.run).toHaveBeenCalledTimes(3);
    expect((await cached).availableBytes).toBe(3121.6875 * MiB);
    await vi.advanceTimersByTimeAsync(29_999); await h.probe.read(); expect(h.run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); const c = h.probe.read(); expect(h.run).toHaveBeenCalledTimes(6);
    h.complete(3); await c;
  });
  it("returns by two seconds while timers run, retains children until close and rejects late output", async () => {
    const h = harness(); cleanups.push(() => h.probe.stop());
    const done = vi.fn(); const a = h.probe.read().then(value => { done(value); return value; });
    const tick = vi.fn(); setTimeout(tick, 1);
    await vi.advanceTimersByTimeAsync(1999); expect(tick).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(done).toHaveBeenCalledOnce(); expect(await a).toMatchObject({ availableKind: "unknown", availableBytes: null });
    expect(h.commands.every(command => (command.kill as any).mock.calls.length === 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000); const retained = h.probe.read(); expect(h.run).toHaveBeenCalledTimes(3); expect((await retained).availableKind).toBe("unknown");
    h.commands[0].output(healthy); h.commands[1].output(swap); await vi.advanceTimersByTimeAsync(0);
    expect((await h.probe.read()).availableKind).toBe("unknown");
    h.commands[0].close(); await vi.advanceTimersByTimeAsync(0); const partialClose = h.probe.read(); expect(h.run).toHaveBeenCalledTimes(3); await partialClose;
    h.commands[1].close(); h.commands[2].close(); await vi.advanceTimersByTimeAsync(0);
    const next = h.probe.read(); expect(h.run).toHaveBeenCalledTimes(6); h.complete(3); await next;
  });
  it("stop fences old output and restart retains physical reservations", async () => {
    const h = harness(); cleanups.push(() => h.probe.stop());
    const old = h.probe.read(); h.probe.stop();
    expect((await old).availableKind).toBe("unknown");
    const retained = h.probe.read(); expect(h.run).toHaveBeenCalledTimes(3); expect((await retained).availableKind).toBe("unknown");
    h.complete(); await vi.advanceTimersByTimeAsync(0);
    const next = h.probe.read(); expect(h.run).toHaveBeenCalledTimes(6);
    h.complete(3, healthy.replace("180253", "10")); expect((await next).availableBytes).toBe((13765 + 5770 + 1509) * 16384);
  });
  it("uses reliable RAM when swap fails, but valid swap cannot rescue invalid RAM", async () => {
    const h = harness(); cleanups.push(() => h.probe.stop()); const value = h.probe.read(); h.complete(0, healthy, null);
    expect(await value).toMatchObject({ availableKind: "available", swapTotalBytes: null, swapFreeBytes: null });
    await vi.advanceTimersByTimeAsync(30_000); const invalid = h.probe.read(); h.complete(3, "broken", swap);
    expect(await invalid).toMatchObject({ availableKind: "unknown", swapTotalBytes: null });
  });
  it("retains physical ownership when cleanup rejects or kill throws", async () => {
    const result = deferred<string | null>(); const stopped = deferred<void>();
    const run = vi.fn(() => ({ result: result.promise, stopped: stopped.promise, kill: () => { throw new Error("kill unavailable"); } }));
    const probe = new DarwinMemoryProbe({ includePressure: true, run, totalmem: () => total, now: Date.now }); cleanups.push(() => probe.stop());
    const pending = probe.read(); stopped.resolve();
    await vi.advanceTimersByTimeAsync(2000); expect((await pending).availableKind).toBe("unknown");
    // Separate rejected cleanup contract, not a real rejected child close.
    const rejectedRun = vi.fn(() => ({ result: result.promise, stopped: Promise.reject(new Error("unconfirmed close")), kill: () => {} }));
    const rejected = new DarwinMemoryProbe({ includePressure: true, run: rejectedRun, totalmem: () => total, now: Date.now });
    cleanups.push(() => rejected.stop()); const other = rejected.read(); await vi.advanceTimersByTimeAsync(2000); await other;
    await vi.advanceTimersByTimeAsync(30_000); const retained = rejected.read(); expect(rejectedRun).toHaveBeenCalledTimes(3); expect((await retained).availableKind).toBe("unknown");
    expect((rejected as any).flight).not.toBeNull();
  });

  it("checks the monotonic deadline even when its timer has not fired", async () => {
    let now = 0; const h = harness();
    const probe = new DarwinMemoryProbe({ includePressure: true, run: h.run, now: () => now, totalmem: () => total }); cleanups.push(() => probe.stop());
    const pending = probe.read(); now = 2000; h.complete();
    expect((await pending).availableKind).toBe("unknown");
  });
});

describe("native sampler and real SpawnGate", () => {
  function make() {
    const h = harness(); const pressure = new MemoryPressure({ platform: "darwin", darwinProbe: h.probe, monotonicNow: Date.now });
    const storm = new StormWindow(); const gate = new SpawnGate({ storm, memoryPressure: pressure, concurrency: () => 3, staggerMs: () => 0 });
    cleanups.push(() => { gate.shutdown(); pressure.stop(); storm.shutdown(); });
    const blocked = deferred<void>(), operation = vi.fn(() => blocked.promise);
    const runs: Promise<void>[] = [];
    const run = (name: string) => { const promise = gate.run({ instanceName: name, workingDirectory: `/${name}`, reason: "wake" }, operation); void promise.catch(() => {}); runs.push(promise); };
    return { ...h, pressure, gate, operation, run, runs, blocked };
  }
  it("admission joins the periodic sampler without starting a native probe itself", async () => {
    const h = make(); h.pressure.start(); h.run("a"); h.run("b"); h.run("c");
    expect(h.operation).not.toHaveBeenCalled(); // waiting on the existing sampler flight
    await vi.advanceTimersByTimeAsync(0);
    expect(h.commands).toHaveLength(3);           // the one background flight from start(), none for admission
    h.complete(); await vi.advanceTimersByTimeAsync(0);
    expect(h.pressure.snapshot().level).toBe("normal");
    expect(h.operation).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 100; i++) h.pressure.snapshot(); expect(h.commands).toHaveLength(3);
    h.blocked.resolve(); await Promise.all(h.runs);
  });
  it("a critical kernel sample holds work, independent of RAM estimates", async () => {
    const h = make(); h.pressure.start(); await vi.advanceTimersByTimeAsync(0);
    const critical = healthy.replace("13765", "0").replace("180253", "0").replace("1509", "0").replace("5770", "0");
    h.complete(0, critical, swap, "kern.memorystatus_vm_pressure_level: 4\n"); await vi.advanceTimersByTimeAsync(0);
    expect(h.pressure.snapshot().level).toBe("critical");
    h.run("a"); h.run("b");
    expect(h.operation).not.toHaveBeenCalled();
    expect((h.gate as any).pressureHeld).toBe(true);
    h.gate.shutdown();
    h.blocked.resolve(); await Promise.allSettled(h.runs);
  });
  it("coalesces first admission/background samples before native completion", async () => {
    const held = deferred<any>(); const native = { read: vi.fn(() => held.promise), stop: vi.fn() };
    const pressure = new MemoryPressure({ platform: "darwin", darwinProbe: native }); cleanups.push(() => pressure.stop());
    pressure.start(); pressure.sampleForAdmission(); pressure.sampleForAdmission();
    await vi.advanceTimersByTimeAsync(0); expect(native.read).toHaveBeenCalledOnce();
    held.resolve(null); await vi.advanceTimersByTimeAsync(0);
  });

  it("old sampler completion/finally cannot overwrite or detach a restarted flight", async () => {
    const old = deferred<any>(), next = deferred<any>();
    const native = { read: vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise), stop: vi.fn() };
    const pressure = new MemoryPressure({ platform: "darwin", darwinProbe: native, monotonicNow: Date.now }); cleanups.push(() => pressure.stop());
    const notice = vi.fn(); pressure.onUpdate(notice);
    pressure.start(); await vi.advanceTimersByTimeAsync(0); pressure.stop(); pressure.start(); await vi.advanceTimersByTimeAsync(0);
    expect(native.read).toHaveBeenCalledTimes(2); const flight = (pressure as any).nativeFlight;
    old.resolve({ totalBytes: total, availableKind: "available", availableBytes: 0, swapTotalBytes: 0, swapFreeBytes: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(pressure.snapshot().sampledAt).toBeNull(); expect(notice).not.toHaveBeenCalled(); expect((pressure as any).nativeFlight).toBe(flight);
    next.resolve({ totalBytes: total, availableKind: "available", availableBytes: 4000 * MiB, swapTotalBytes: 0, swapFreeBytes: 0, darwinPressureLevel: 1 });
    await vi.advanceTimersByTimeAsync(0); expect(pressure.snapshot().level).toBe("normal"); expect(notice).toHaveBeenCalledOnce();
  });

  it("Linux never calls the native reader and preserves synchronous unknown restrictions", () => {
    const native = { read: vi.fn(), stop: vi.fn() };
    const pressure = new MemoryPressure({ platform: "linux", darwinProbe: native });
    vi.spyOn(pressure as any, "read").mockImplementation(() => { throw new Error("missing procfs"); });
    expect(pressure.sampleForAdmission()).toMatchObject({ level: "unknown" });
    expect(pressure.advisoryOnly()).toBe(false); expect(native.read).not.toHaveBeenCalled();
    pressure.stop(); expect(native.stop).not.toHaveBeenCalled();
  });

  it("sampler stop does not publish a late sample or notice", async () => {
    const h = make(); const notice = vi.fn(); h.pressure.onUpdate(notice); h.pressure.start();
    await vi.advanceTimersByTimeAsync(0); const snapshot = h.pressure.snapshot();
    h.pressure.stop(); h.complete(); await vi.advanceTimersByTimeAsync(0);
    expect(h.pressure.snapshot()).toEqual(snapshot); expect(notice).not.toHaveBeenCalled();
  });
});
