import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
const io = vi.hoisted(() => ({ stat: vi.fn() }));
const native = vi.hoisted(() => ({ sessions: 0, connect: vi.fn(), disconnect: vi.fn(), post: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: io.stat }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { native.sessions++; } connect = native.connect; disconnect = native.disconnect; post = native.post; } }));
vi.mock("node:child_process", () => ({ spawn: () => { throw Error("No processes"); }, execFile: () => { throw Error("No CLI"); } }));
import { RuntimeCpuProfiler, ProfileBusyError, profileDuration } from "../src/runtime-cpu-profile.js";
import { type CpuProfile, startCpuProfileFromEnvironment } from "../src/cpu-profile.js";
let clock = 0;
const log = () => ({ info: vi.fn(), warn: vi.fn() });
function rig() {
  const save = vi.fn(async () => "/private/capture.cpuprofile");
  const start = vi.fn((options: Parameters<typeof startCpuProfileFromEnvironment>[0]) => startCpuProfileFromEnvironment({ ...options, save }));
  const profiler = new RuntimeCpuProfiler({ dataDir: "/never-accessed", logger: log(), start });
  return { profiler, start, save };
}
beforeEach(() => {
  vi.useFakeTimers(); clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
  native.sessions = 0; native.connect.mockReset(); native.disconnect.mockReset(); native.post.mockReset();
  native.post.mockImplementation((method, _params, cb) => cb(null, method === "Profiler.stop" ? { profile: { nodes: [], startTime: 0, endTime: 1 } } : {}));
  io.stat.mockReset().mockResolvedValue({ isFile: () => true, size: 1234 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("one runtime recording owner, real CPU helper with fake inspector", () => {
  it("is inert by default, defaults to 60, validates the shared ceiling", async () => {
    const h = rig(); expect(native.sessions).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(profileDuration()).toBe(60); expect(profileDuration(1800)).toBe(1800);
    for (const seconds of [0, -1, 1.5, 1801, "2s", " 2 "]) expect(() => profileDuration(seconds)).toThrow();
    const ticket = await h.profiler.start(); expect(ticket.seconds).toBe(60);
    expect(h.start.mock.calls[0][0].env).toEqual({ AGEND_CPU_PROFILE_SECONDS: "60" });
    await h.profiler.shutdown(); expect(await ticket.done).toEqual({ path: "/private/capture.cpuprofile", bytes: 1234 });
  });
  it("reserves before native startup and refuses a second recording with monotonic seconds left", async () => {
    const h = rig(); let ack!: (err: null, result: object) => void;
    native.post.mockImplementationOnce((_m, _p, cb) => { ack = cb; });
    const first = h.profiler.start(60); await Promise.resolve();
    clock = 1300; await expect(h.profiler.start(20)).rejects.toMatchObject({ remainingSeconds: 59 });
    expect(native.sessions).toBe(1); ack(null, {}); const ticket = await first;
    await h.profiler.shutdown(); await ticket.done; expect(h.save).toHaveBeenCalledTimes(1);
  });
  it("completes at the cap and allows a later recording without restarting the fleet", async () => {
    const h = rig(); const ticket = await h.profiler.start(1);
    clock = 1000; await vi.advanceTimersByTimeAsync(1000); await ticket.done;
    const next = await h.profiler.start(2); expect(native.sessions).toBe(2);
    clock = 3000; await vi.advanceTimersByTimeAsync(2000); expect((await next.done).bytes).toBe(1234);
    expect(h.save).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the slot during save, including zero seconds left", async () => {
    const h = rig(); let saved!: (path: string) => void; h.save.mockImplementationOnce(() => new Promise(r => { saved = r; }));
    const ticket = await h.profiler.start(1); clock = 1000; await vi.advanceTimersByTimeAsync(1000);
    await expect(h.profiler.start(1)).rejects.toBeInstanceOf(ProfileBusyError);
    await expect(h.profiler.start(1)).rejects.toMatchObject({ remainingSeconds: 0 });
    saved("/private/capture.cpuprofile"); await ticket.done; expect(h.start).toHaveBeenCalledTimes(1);
  });
  it("shutdown stops once, rejects new requests and fences a pending start", async () => {
    const h = rig(); let resolve!: (value: CpuProfile | null) => void;
    const stop = vi.fn(async () => "/private/capture.cpuprofile");
    h.start.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = h.profiler.start(60); const assertion = expect(pending).rejects.toThrow("Fleet stopped"); await Promise.resolve();
    const shutdown = h.profiler.shutdown(); expect(h.profiler.closed).toBe(true);
    await expect(h.profiler.start()).rejects.toThrow("stopping"); resolve({ stop });
    await assertion; expect(await shutdown).toBe("/private/capture.cpuprofile");
    await h.profiler.shutdown(); expect(stop).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the env path, shares its owner, and refuses agent opt-in", async () => {
    const h = rig(); expect(await h.profiler.startFromEnvironment({})).toBeNull();
    expect(await h.profiler.startFromEnvironment({ AGEND_CPU_PROFILE_SECONDS: "1", AGEND_INSTANCE_NAME: "worker" })).toBeNull();
    expect(h.start).not.toHaveBeenCalled();
    const env = await h.profiler.startFromEnvironment({ AGEND_CPU_PROFILE_SECONDS: "60" });
    await expect(h.profiler.start()).rejects.toBeInstanceOf(ProfileBusyError);
    expect(await env!.stop()).toBe("/private/capture.cpuprofile"); expect(h.start).toHaveBeenCalledTimes(1);
  });
  it("size lookup is bounded; a saved path survives an unknown size", async () => {
    const h = rig(); io.stat.mockImplementation(() => new Promise(() => {}));
    const ticket = await h.profiler.start(60); const shutdown = h.profiler.shutdown();
    await vi.advanceTimersByTimeAsync(0); clock = 2000; await vi.advanceTimersByTimeAsync(2000);
    expect(await ticket.done).toEqual({ path: "/private/capture.cpuprofile", bytes: null }); await shutdown;
  });
  it("a failed native start releases the reservation without an unhandled rejection", async () => {
    const h = rig(); h.start.mockResolvedValueOnce(null);
    await expect(h.profiler.start()).rejects.toThrow("could not start");
    const ticket = await h.profiler.start(1); await h.profiler.shutdown(); await ticket.done;
    expect(h.start).toHaveBeenCalledTimes(2);
  });
});
