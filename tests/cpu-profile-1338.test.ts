import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, lstat, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

const native = vi.hoisted(() => ({ sessions: 0, connect: vi.fn(), disconnect: vi.fn(), post: vi.fn(), open: vi.fn(() => { throw new Error("No network inspector"); }) }));
vi.mock("node:inspector", () => ({
  Session: class { constructor() { native.sessions++; } connect = native.connect; disconnect = native.disconnect; post = native.post; },
  open: native.open,
}));
vi.mock("node:child_process", () => ({
  spawn: () => { throw new Error("No process spawn"); }, execFile: () => { throw new Error("No CLI"); },
  execFileSync: () => { throw new Error("No sync CLI"); }, execSync: () => { throw new Error("No sync CLI"); },
}));
import { CPU_PROFILE_ENV, CPU_PROFILE_KEEP, CPU_PROFILE_MAX_BYTES, CPU_PROFILE_MAX_SECONDS,
  cpuProfileSeconds, saveCpuProfile, startCpuProfileFromEnvironment, type ProfileSession } from "../src/cpu-profile.js";

const profile = { nodes: [{ id: 1, callFrame: { functionName: "busy", scriptId: "1", url: "file:///app.js", lineNumber: 0, columnNumber: 0 }, hitCount: 1 }],
  startTime: 100, endTime: 200, samples: [1], timeDeltas: [100] };
let directories: string[] = [];
let clock = 0;
const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const methods = () => native.post.mock.calls.map(call => call[0]);
const session: ProfileSession = native;
function opts(seconds = "1") { return { dataDir: "/not-accessed", logger: logger(), env: { [CPU_PROFILE_ENV]: seconds }, save: vi.fn(async () => "/private/result.cpuprofile") }; }
async function temporary() { const path = await mkdtemp(join(tmpdir(), "agend-profile-1338-")); directories.push(path); return path; }

beforeEach(() => {
  vi.useFakeTimers(); clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  native.sessions = 0; native.connect.mockReset(); native.disconnect.mockReset(); native.post.mockReset(); native.open.mockClear();
  native.post.mockImplementation((method: string, _params: object, callback: (err: Error | null, result: object) => void) => callback(null, method === "Profiler.stop" ? { profile } : {}));
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const path of directories) await rm(path, { recursive: true, force: true }); directories = []; });

describe("local opt-in CPU recording, inspector fully stubbed", () => {
  it("does nothing by default: no session, timer, artifact or listening inspector", async () => {
    const o = { ...opts(), env: {} };
    expect(cpuProfileSeconds({})).toBeNull();
    expect(await startCpuProfileFromEnvironment(o)).toBeNull();
    expect(native.sessions).toBe(0); expect(native.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); expect(o.save).not.toHaveBeenCalled(); expect(native.open).not.toHaveBeenCalled();
  });

  it("rejects malformed/out-of-range durations and an agent's inherited opt-in before any effect", async () => {
    for (const seconds of ["0", "-1", "1.5", "1801", "Infinity", "10s", " 2 "]) {
      const o = opts(seconds); expect(await startCpuProfileFromEnvironment(o)).toBeNull(); expect(o.logger.warn).toHaveBeenCalled();
    }
    const o = { ...opts(), env: { [CPU_PROFILE_ENV]: "60", AGEND_INSTANCE_NAME: "agent" } };
    expect(await startCpuProfileFromEnvironment(o)).toBeNull(); expect(o.logger.warn.mock.calls.flat().join(" ")).toContain("operator");
    expect(native.sessions).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(cpuProfileSeconds({ [CPU_PROFILE_ENV]: "1800" })).toBe(CPU_PROFILE_MAX_SECONDS);
  });

  it("stops exactly at its monotonic duration cap and saves once; stop is idempotent", async () => {
    const o = opts(); const recorder = await startCpuProfileFromEnvironment(o); expect(recorder).not.toBeNull();
    expect(methods()).toEqual(["Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start"]);
    expect(native.post.mock.calls[1]?.[1]).toEqual({ interval: 10_000 }); expect(native.open).not.toHaveBeenCalled();
    clock = 999; await vi.advanceTimersByTimeAsync(999); expect(methods()).not.toContain("Profiler.stop");
    clock = 1000; await vi.advanceTimersByTimeAsync(1); expect(methods().filter(m => m === "Profiler.stop")).toHaveLength(1);
    expect(o.save).toHaveBeenCalledExactlyOnceWith(o.dataDir, profile, expect.any(AbortSignal));
    expect(await recorder!.stop()).toBe("/private/result.cpuprofile"); expect(await recorder!.stop()).toBe("/private/result.cpuprofile");
    expect(native.disconnect).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks a delayed/early timer using monotonic time, ignoring wall-clock changes", async () => {
    const o = opts("2"); const recorder = await startCpuProfileFromEnvironment(o);
    vi.setSystemTime(new Date("2099-01-01")); clock = 1500;
    await vi.advanceTimersByTimeAsync(2000); expect(methods()).not.toContain("Profiler.stop");
    clock = 6500; await vi.advanceTimersByTimeAsync(500);
    expect(methods()).toContain("Profiler.stop"); expect(o.save).toHaveBeenCalledTimes(1); await recorder!.stop();
  });

  it("a never-settling stop callback times out, disconnects and ignores a late ACK", async () => {
    const o = opts(); const recorder = await startCpuProfileFromEnvironment(o);
    let late: ((err: Error | null, result: object) => void) | undefined;
    native.post.mockImplementation((_method, _params, callback) => { late = callback; });
    clock = 1000; await vi.advanceTimersByTimeAsync(1000);
    clock = 3000; await vi.advanceTimersByTimeAsync(2000);
    expect(await recorder!.stop()).toBeNull(); expect(native.disconnect).toHaveBeenCalledTimes(1); expect(o.save).not.toHaveBeenCalled();
    late!(null, { profile }); await Promise.resolve(); expect(o.save).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("startup pending at the cap never starts after a stale enable ACK", async () => {
    const o = opts(); let ack: ((err: Error | null, result: object) => void) | undefined;
    native.post.mockImplementation((_method, _params, callback) => { ack = callback; });
    const pending = startCpuProfileFromEnvironment(o); clock = 1000; await vi.advanceTimersByTimeAsync(1000);
    expect(native.disconnect).toHaveBeenCalledTimes(1); ack!(null, {});
    expect(await pending).toBeNull(); expect(methods()).toEqual(["Profiler.enable"]); expect(o.save).not.toHaveBeenCalled();
  });

  it("a pending start ACK is stopped at the cap and cannot resurrect the capture", async () => {
    const o = opts(); let ack: ((err: Error | null, result: object) => void) | undefined;
    native.post.mockImplementation((method, _params, callback) => {
      if (method === "Profiler.start") ack = callback;
      else callback(null, method === "Profiler.stop" ? { profile } : {});
    });
    const pending = startCpuProfileFromEnvironment(o); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(methods()).toContain("Profiler.start"); clock = 1000; await vi.advanceTimersByTimeAsync(1000);
    ack!(null, {}); expect(await pending).toBeNull();
    expect(methods().filter(m => m === "Profiler.start")).toHaveLength(1); expect(methods().filter(m => m === "Profiler.stop")).toHaveLength(1);
    expect(native.disconnect).toHaveBeenCalledTimes(1); expect(o.save).toHaveBeenCalledTimes(1);
  });

  it("constructor/connect/post/save failures are isolated and cleanup has no unhandled rejection", async () => {
    const a = opts(); expect(await startCpuProfileFromEnvironment({ ...a, session: () => { throw new Error("constructor"); } })).toBeNull();
    native.connect.mockImplementationOnce(() => { throw new Error("connect"); });
    expect(await startCpuProfileFromEnvironment(opts())).toBeNull(); expect(native.disconnect).toHaveBeenCalledTimes(1);
    native.post.mockImplementationOnce(() => { throw new Error("post"); });
    expect(await startCpuProfileFromEnvironment(opts())).toBeNull(); expect(native.disconnect).toHaveBeenCalledTimes(2);
    const o = { ...opts(), save: vi.fn(async () => { throw new Error("disk"); }) };
    const recorder = await startCpuProfileFromEnvironment(o); expect(await recorder!.stop()).toBeNull();
    expect(o.logger.warn.mock.calls.flat().join(" ")).toContain("discarded"); expect(vi.getTimerCount()).toBe(0);
  });

  it("a native post reply delayed past its own 2s budget is not accepted even before its timer runs", async () => {
    const o = opts("10"); native.post.mockImplementationOnce((_method, _params, callback) => { clock = 2000; callback(null, {}); });
    expect(await startCpuProfileFromEnvironment(o)).toBeNull(); expect(methods()).not.toContain("Profiler.start");
    expect(native.disconnect).toHaveBeenCalledTimes(1); expect(o.logger.warn.mock.calls.flat().join(" ")).toContain("deadline");
  });

  it("a never-settling artifact save cannot block cleanup/shutdown beyond its budget", async () => {
    let signal: AbortSignal | undefined;
    const o = { ...opts(), save: vi.fn((_dir: string, _profile: unknown, received?: AbortSignal) => {
      signal = received; return new Promise<string>(() => {});
    }) };
    const recorder = await startCpuProfileFromEnvironment(o); const pending = recorder!.stop();
    await Promise.resolve(); await Promise.resolve(); expect(signal?.aborted).toBe(false);
    clock = 5000; await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull(); expect(signal?.aborted).toBe(true); expect(native.disconnect).toHaveBeenCalledTimes(1);
    expect(o.logger.info.mock.calls.flat().join(" ")).not.toContain("saved"); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bounded private artifact storage", () => {
  it("writes valid JSON privately, keeps five owned files, and never rotates unrelated files", async () => {
    const home = await temporary(); const directory = join(home, "profiles"); await mkdir(directory);
    for (let i = 0; i < CPU_PROFILE_KEEP + 2; i++) {
      const path = join(directory, `fleet-cpu-old-${i}.cpuprofile`); await writeFile(path, "{}"); await utimes(path, i + 1, i + 1);
    }
    await writeFile(join(directory, "keep.txt"), "mine");
    const path = await saveCpuProfile(home, profile);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(profile);
    expect((await readdir(directory)).filter(n => n.endsWith(".cpuprofile"))).toHaveLength(CPU_PROFILE_KEEP);
    expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("mine");
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  });

  it("discards oversized output before touching storage and handles UTF-8 byte size", async () => {
    const home = await temporary();
    await expect(saveCpuProfile(home, "界".repeat(Math.ceil(CPU_PROFILE_MAX_BYTES / 3)))).rejects.toThrow("cap");
    expect(await readdir(home)).toEqual([]);
  });

  it("rejects a directory symlink and artifact symlinks without writing outside or deleting them", async () => {
    const home = await temporary(); const outside = await temporary();
    await symlink(outside, join(home, "profiles")); await expect(saveCpuProfile(home, profile)).rejects.toThrow("real directory"); expect(await readdir(outside)).toEqual([]);
    await rm(join(home, "profiles")); await mkdir(join(home, "profiles")); const victim = join(outside, "victim"); await writeFile(victim, "secret");
    await symlink(victim, join(home, "profiles", "fleet-cpu-bad.cpuprofile"));
    await expect(saveCpuProfile(home, profile)).rejects.toThrow("non-regular"); expect(await readFile(victim, "utf8")).toBe("secret");
  });

  it("an aborted save leaves no artifact or directory", async () => {
    const home = await temporary(); const controller = new AbortController(); controller.abort();
    await expect(saveCpuProfile(home, profile, controller.signal)).rejects.toThrow(); expect(await readdir(home)).toEqual([]);
  });
});
