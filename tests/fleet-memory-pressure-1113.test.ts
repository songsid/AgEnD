import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { getLocale, setLocale } from "../src/locale.js";
import type { HostMemory } from "../src/host-memory.js";
import { TmuxManager } from "../src/tmux-manager.js";

vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn() }));
// Keep the constructor on the injected reader path on every test host; Darwin policy is selected below.
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), platform: () => "linux" }));
const MiB = 1024 * 1024;
const memory = (available = 4_000, swap = 4_000): HostMemory => ({ totalBytes: 16_000 * MiB,
  availableBytes: available * MiB, availableKind: "available", swapTotalBytes: 8_000 * MiB, swapFreeBytes: swap * MiB });

describe("fleet host memory wiring", () => {
  const fleets: Array<{ fm: FleetManager; dir: string }> = [];
  let originalLocale = getLocale();
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    originalLocale = getLocale(); setLocale("en");
  });
  afterEach(() => {
    for (const { fm, dir } of fleets.splice(0)) {
      fm.memoryPressure.stop(); fm.spawnGate.shutdown(); fm.stormWindow.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks(); vi.useRealTimers(); setLocale(originalLocale);
  });
  function make(initial = memory()) {
    const dir = mkdtempSync(join(tmpdir(), "agend-memory-1113-"));
    const fm = new FleetManager(dir);
    fleets.push({ fm, dir });
    const internal = fm as any;
    let current = initial;
    const read = vi.spyOn(fm.memoryPressure as unknown as { read(): HostMemory }, "read").mockImplementation(() => current);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    internal.logger = logger;
    internal.startupComplete = true;
    internal.fleetConfig = { defaults: {}, channel: { group_id: "g1" }, instances: {
      general: { general_topic: true, topic_id: "t1" },
    } };
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const sendText = vi.fn().mockResolvedValue(undefined);
    const attach = () => {
      const adapter = { id: "telegram", type: "telegram", sendText };
      internal.adapter = adapter; internal.adapters.set("telegram", adapter);
    };
    return { fm, internal, read, logger, sendText, attach, set: (value: HostMemory) => { current = value; } };
  }

  it("macOS (#1256): missing kernel values are logged once, never a warning, notice or health problem", () => {
    const { fm, internal, attach, sendText, logger, set } = make({ ...memory(), availableBytes: null, availableKind: "unknown" });
    Object.defineProperty(fm.memoryPressure, "platform", { value: "darwin" });
    attach(); fm.memoryPressure.start();
    expect(logger.debug).toHaveBeenCalledOnce();
    // The old ratio policy called this elevated; without a kernel alarm it is now unknown.
    set({ totalBytes: 16_000 * MiB, availableBytes: 2_845 * MiB, availableKind: "available", swapTotalBytes: 6_000 * MiB, swapFreeBytes: 274 * MiB });
    fm.memoryPressure.sample();
    expect(fm.memoryPressure.snapshot().level).toBe("unknown");
    set(memory(100, 0)); fm.memoryPressure.sample();
    expect(fm.memoryPressure.snapshot().level).toBe("unknown");
    expect(sendText).not.toHaveBeenCalled(); expect(logger.warn).not.toHaveBeenCalled();
    expect(internal.memoryLogAt).toBeNull();
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith({ pressureRaw: null }, expect.stringContaining("kernel memory pressure unknown"));
    expect(fm.getFleetHealth().problems ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining("host memory")]));
  });

  it("macOS kernel 4 logs and degrades health without posting to chat", () => {
    const { fm, attach, sendText, logger } = make({ ...memory(), darwinPressureLevel: 4 });
    Object.defineProperty(fm.memoryPressure, "platform", { value: "darwin" });
    attach(); fm.memoryPressure.start();
    expect(logger.warn).toHaveBeenCalledOnce(); expect(sendText).not.toHaveBeenCalled();
    expect(fm.getFleetHealth().problems).toEqual(expect.arrayContaining([expect.stringContaining("host memory")]));
  });

  it("#1685: macOS kernel 2 warns and degrades health, but posts nothing in chat", () => {
    const { fm, attach, sendText, logger } = make({ ...memory(), darwinPressureLevel: 2 });
    Object.defineProperty(fm.memoryPressure, "platform", { value: "darwin" });
    attach(); fm.memoryPressure.start();
    expect(logger.warn).toHaveBeenCalledOnce(); expect(sendText).not.toHaveBeenCalled();
    expect(fm.getFleetHealth().problems).toEqual(expect.arrayContaining([expect.stringContaining("host memory")]));
  });

  // #1712: the dashboard and logging remain; all platform/level chat notices are removed.
  const notices = (sendText: ReturnType<typeof vi.fn>) => sendText.mock.calls.map(c => String(c[1]));
  const darwin = (fm: FleetManager) => Object.defineProperty(fm.memoryPressure, "platform", { value: "darwin" });
  const kernel = (level: 1 | 2 | 4, available = 2_900): HostMemory => ({ ...memory(available, 355), darwinPressureLevel: level });
  /** One hour of 30-second samples while the measurements keep moving (the level stays the same). */
  async function holdFor(ms: number, next: (i: number) => HostMemory, set: (m: HostMemory) => void) {
    for (let t = 0, i = 0; t < ms; t += 30_000, i++) { set(next(i)); await vi.advanceTimersByTimeAsync(30_000); }
  }

  it("#1685: macOS kernel 2 held for an hour: no notice — still logged, slowing, degraded and on the dashboard", async () => {
    const { fm, internal, attach, sendText, logger, set } = make(kernel(2));
    darwin(fm); attach(); fm.memoryPressure.start();
    await holdFor(60 * 60_000, i => kernel(2, 2_900 - (i % 5) * 20), set);
    expect(fm.memoryPressure.snapshot().level).toBe("elevated");
    expect(notices(sendText)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), "Host memory pressure — slowing new CLI spawns");
    expect(fm.getFleetHealth().problems).toContain("host memory pressure is elevated");
    expect(internal.getUiStatusSync().host_memory).toBe("elevated");
  });

  it("#1685: the dashboard's status frame is re-sent when host_memory changes — not on every sample", async () => {
    const { fm, attach, set } = make(kernel(1));
    darwin(fm); attach();
    const frames: unknown[] = [];
    vi.spyOn(fm, "emitSseEvent").mockImplementation((event: string, data: unknown) => { if (event === "status") frames.push((data as any).host_memory); });
    fm.memoryPressure.start();
    await holdFor(2 * 60_000, () => kernel(1), set);
    expect(frames).toEqual([]);
    await holdFor(5 * 60_000, i => kernel(2, 2_900 - i), set);
    set(kernel(4)); await vi.advanceTimersByTimeAsync(30_000);
    await holdFor(2 * 60_000, () => kernel(1), set);
    // After critical, the 30-second recovery ramp is elevated (#1438), then normal.
    expect(frames).toEqual(["elevated", "critical", "elevated", null]);
  });

  it("#1685: macOS kernel 2 still slows the fleet's admission to one start at a time, 5 seconds apart", async () => {
    const { fm, attach } = make(kernel(2));
    darwin(fm); attach(); fm.memoryPressure.start();
    const work = vi.fn(async () => 1);
    const a = fm.spawnGate.run({ instanceName: "a", workingDirectory: "/a", reason: "startup" }, work);
    const b = fm.spawnGate.run({ instanceName: "b", workingDirectory: "/b", reason: "startup" }, work); void b.catch(() => {});
    await vi.advanceTimersByTimeAsync(0); expect(work).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999); expect(work).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(work).toHaveBeenCalledTimes(2); await Promise.all([a, b]);
  });

  it("the reported Mac's kernel normal does not warn despite nearly full swap", () => {
    const { fm, attach, sendText, logger } = make({ totalBytes: 16_000 * MiB, availableBytes: 2_845 * MiB, availableKind: "available", swapTotalBytes: 6_000 * MiB, swapFreeBytes: 274 * MiB, darwinPressureLevel: 1 });
    Object.defineProperty(fm.memoryPressure, "platform", { value: "darwin" });
    attach(); fm.memoryPressure.start();
    expect(fm.memoryPressure.snapshot().level).toBe("normal");
    expect(logger.warn).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled();
    expect(fm.getFleetHealth().problems ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining("host memory")]));
  });

  it("Linux critical still logs without posting to chat", () => {
    const { fm, attach, sendText, logger, set } = make();
    attach(); fm.memoryPressure.start();
    set(memory(100, 0)); fm.memoryPressure.sample();
    expect(logger.warn).toHaveBeenCalledOnce(); expect(sendText).not.toHaveBeenCalled();
  });

  it("never starts polling in the constructor and health is a cache-only host/process split", () => {
    const { fm, read, set } = make();
    expect(vi.getTimerCount()).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(fm.getFleetHealth().hostMemory).toMatchObject({ level: "unknown", sampledAt: null });
    fm.memoryPressure.start();
    const health = fm.getFleetHealth();
    expect(health.status).toBe("ok");
    expect(health.memory.fleetRssBytes).toBeGreaterThan(0);
    expect(health.hostMemory.memory).toEqual(memory());
    const sampleCount = read.mock.calls.length;
    set(memory(100, 0));
    for (let i = 0; i < 100; i++) expect(fm.getFleetHealth().hostMemory).toEqual(health.hostMemory);
    expect(read).toHaveBeenCalledTimes(sampleCount);
    fm.memoryPressure.sample();
    const critical = fm.getFleetHealth();
    expect(critical.status).toBe("degraded");
    expect(critical.problems).toContain("host memory pressure is critical");
    expect(critical.memory.fleetRssBytes).toBeGreaterThan(0);
    expect(critical.hostMemory.memory!.availableBytes).toBe(100 * MiB);
  });

  it("changing measurements and critical escalation keep logs but never post to chat", async () => {
    const { fm, attach, sendText, logger, set } = make(memory(1_200, 0));
    attach(); fm.memoryPressure.start();
    expect(sendText).not.toHaveBeenCalled();
    set(memory(100, 0)); fm.memoryPressure.sample();
    expect(sendText).not.toHaveBeenCalled();
    for (let i = 0; i < 19; i++) {
      set(memory(110 + i, i));
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(sendText).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.debug.mock.calls.at(-1)![0].hostMemory.trend).not.toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    // The log keeps its 10-minute reminder; chat does not.
    expect(sendText).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("logs pressure before and after adapters exist without posting to chat", async () => {
    const { fm, attach, sendText, logger, internal } = make(memory(100, 0));
    fm.memoryPressure.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    attach();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("starts monitoring before any CLI startup even if startup is subsequently held", async () => {
    const { fm, logger, read, internal } = make(memory(100, 0));
    // Exercise only the pre-spawn prefix; every IO/lifecycle entry is stubbed.
    for (const name of ["loadEnvFile", "ensureDeliveryOutbox", "rotateFleetLogs", "slimFleetConfigAtStartup", "initializeWebAuthTokens"]) {
      vi.spyOn(internal, name).mockImplementation(() => undefined);
    }
    vi.spyOn(fm, "loadConfig").mockReturnValue(internal.fleetConfig);
    vi.spyOn(fm, "startInstance").mockImplementation(async () => { throw new Error("forbidden lifecycle call"); });
    const originalStart = fm.memoryPressure.start.bind(fm.memoryPressure);
    vi.spyOn(fm.memoryPressure, "start").mockImplementation(() => { originalStart(); throw new Error("end of stubbed prefix"); });
    // Independent safety fence: removing the monitored start in a mutation
    // still cannot continue into tmux/global startup initialization.
    vi.spyOn(TmuxManager, "setSocketName").mockImplementation(() => { throw new Error("end of stubbed prefix"); });
    await expect(fm.startAll(join(fleets.at(-1)!.dir, "fleet.yaml"))).rejects.toThrow("end of stubbed prefix");
    expect(read).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(fm.startInstance).not.toHaveBeenCalled();
  });

  it("stops monitoring before the first asynchronous shutdown phase", async () => {
    const { fm, internal, read } = make();
    fm.memoryPressure.start();
    // A pending login-window shutdown fences this test before any daemon,
    // tmux, adapter, process, service or filesystem shutdown operation.
    vi.spyOn(internal, "shutdownLoginWindows").mockImplementation(() => new Promise<void>(() => {}));
    void fm.stopAll();
    const reads = read.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(reads);
  });

  it("monitors a single-instance cold start before its real gate holds any CLI", async () => {
    const { fm, internal, logger, read } = make(memory(100, 0));
    internal.startupComplete = false;
    internal.fleetConfig = null;
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);
    const operation = vi.fn(async () => { throw new Error("forbidden CLI callback"); });
    // Only public startInstance and the real gate run. Every lifecycle, IPC,
    // instruction and process entry is stubbed, including a callback fence if
    // a mutant admits the operation during critical pressure.
    vi.spyOn(internal, "cancelStartupRetry").mockImplementation(() => undefined);
    vi.spyOn(fm, "resolveInstanceModel").mockReturnValue({ model: "default", source: "unresolved", display: "default" });
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
    vi.spyOn(internal, "requestDiscordUsagePresenceRefresh").mockImplementation(() => undefined);
    vi.spyOn(fm.lifecycle, "start").mockImplementation(async () => {
      await fm.spawnGate.run({ instanceName: "cold", workingDirectory: "/fixture/cold", reason: "startup" }, operation);
    });
    const start = fm.startInstance("cold", { working_directory: "/fixture/cold" } as any, false, "classic");
    const settled = vi.fn();
    void start.then(() => settled(null), error => settled(error));
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fm.lifecycle.start).toHaveBeenCalledOnce();
      expect(operation).not.toHaveBeenCalled();
      expect((fm.memoryPressure as any).timer).not.toBeNull();
      expect(read.mock.calls.length).toBeGreaterThan(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ hostMemory: expect.objectContaining({ level: "critical" }) }), "Host memory critical — deferring new CLI spawns");
      expect(internal.adapter).toBeNull();
      expect(settled).not.toHaveBeenCalled();
    } finally {
      fm.spawnGate.shutdown();
      await vi.advanceTimersByTimeAsync(0);
      await start.catch(() => {});
    }
  });

  it("does not restart a stopped sampler when a start observes fleet shutdown", async () => {
    const { fm, internal, read } = make();
    fm.memoryPressure.start(); fm.memoryPressure.stop();
    const reads = read.mock.calls.length;
    internal.shuttingDown = true;
    fm.lifecycle.daemons.set("existing", {} as any);
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);
    vi.spyOn(internal, "cancelStartupRetry").mockImplementation(() => undefined);
    await fm.startInstance("existing", { working_directory: "/fixture/existing" } as any, false, "classic");
    expect((fm.memoryPressure as any).timer).toBeNull();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("labels fleet startup reservations so nested physical callbacks can wait safely", async () => {
    const { fm, internal } = make();
    internal.fleetConfig.defaults.startup = { concurrency: 1, stagger_delay_ms: 0 };
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);
    const acquire = vi.spyOn(fm.spawnGate, "run");
    // Only the real scheduling wrapper runs; daemon construction/spawn is stubbed.
    vi.spyOn(fm, "startInstance").mockImplementation(async name => { internal.daemons.set(name, {}); });
    await internal.startInstancesWithConcurrency([["a", { working_directory: "/fixture/a" }]], false);
    expect(acquire.mock.calls[0][0]).toEqual({ instanceName: "a", workingDirectory: "/fixture/a", reason: "startup", stage: "lifecycle" });
    expect(fm.startInstance).toHaveBeenCalledOnce();
  });
});
