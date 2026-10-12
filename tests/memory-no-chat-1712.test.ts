import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import type { HostMemory } from "../src/host-memory.js";
import { getLocale, setLocale, t } from "../src/locale.js";
import { withSpawnHoldReply } from "../src/spawn-hold-reply.js";
import { handleWebRequest } from "../src/web-api.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn() }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), platform: () => "linux" }));
const MiB = 1024 * 1024;
const reading = (level: "normal" | "elevated" | "critical" | "unknown", platform: string): HostMemory => ({
  totalBytes: 16_000 * MiB, availableKind: level === "unknown" ? "unknown" : "available",
  availableBytes: level === "unknown" ? null : (level === "critical" ? 100 : level === "elevated" ? 700 : 8_000) * MiB,
  swapTotalBytes: 8_000 * MiB, swapFreeBytes: 4_000 * MiB,
  ...(platform === "darwin" ? { darwinPressureLevel: level === "critical" ? 4 : level === "elevated" ? 2 : level === "normal" ? 1 : null } : {}),
});

describe("#1712 memory protection without chat broadcasts", () => {
  const owned: Array<{ fm: FleetManager; dir: string }> = [];
  let locale = getLocale();
  beforeEach(() => { locale = getLocale(); setLocale("en"); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T00:00:00Z")); });
  afterEach(() => {
    for (const { fm, dir } of owned.splice(0)) {
      fm.memoryPressure.stop(); fm.spawnGate.shutdown(); fm.stormWindow.shutdown(); rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks(); vi.useRealTimers(); setLocale(locale);
  });
  function make(platform: string, level: Parameters<typeof reading>[0] = "normal") {
    const dir = mkdtempSync(join(tmpdir(), "agend-no-memory-chat-"));
    const fm = new FleetManager(dir); owned.push({ fm, dir }); const f = fm as any;
    Object.defineProperty(fm.memoryPressure, "platform", { value: platform });
    let value = reading(level, platform);
    vi.spyOn(fm.memoryPressure as unknown as { read(): HostMemory }, "read").mockImplementation(() => value);
    f.logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    f.startupComplete = true; f.fleetConfig = { defaults: {}, channel: { group_id: "general" }, instances: {} };
    const sendText = vi.fn().mockResolvedValue({ chatId: "request", messageId: "reply" });
    f.adapter = { id: "tg", type: "telegram", sendText }; f.adapters.set("tg", f.adapter);
    const notify = vi.spyOn(fm, "notifyFleetError");
    return { fm, f, sendText, notify, set: (next: Parameters<typeof reading>[0]) => { value = reading(next, platform); } };
  }

  it.each(["linux", "darwin", "freebsd"])("%s: all levels, escalation, recovery and later rises stay out of chat", async platform => {
    const { fm, f, sendText, notify, set } = make(platform);
    fm.memoryPressure.start();
    for (const level of ["elevated", "critical", "normal", "unknown", "normal", "critical", "normal"] as const) {
      set(level); fm.memoryPressure.sample(); await vi.advanceTimersByTimeAsync(65_000);
    }
    expect(notify).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalled(); expect(f.logger.info).toHaveBeenCalledWith(expect.anything(), "Host memory recovered");
  });

  it.each(["linux", "darwin"])("%s: dashboard and health retain pressure and its recovery", async platform => {
    const { fm, f, set } = make(platform); const status = vi.spyOn(fm, "emitSseEvent");
    fm.memoryPressure.start(); set("elevated"); fm.memoryPressure.sample();
    expect(f.getUiStatusSync().host_memory).toBe("elevated");
    expect(fm.getFleetHealth().problems).toContain("host memory pressure is elevated");
    set("critical"); fm.memoryPressure.sample();
    expect(f.getUiStatusSync().host_memory).toBe("critical");
    expect(fm.getFleetHealth().problems).toContain("host memory pressure is critical");
    expect(status).toHaveBeenCalledWith("status", expect.objectContaining({ host_memory: "critical" }));
    set("normal"); await vi.advanceTimersByTimeAsync(65_000);
    expect(f.getUiStatusSync().host_memory).toBeNull();
  });

  it.each(["linux", "darwin"])("%s: elevated still slows admission and critical still holds", async platform => {
    const { fm, set } = make(platform, "elevated"); fm.memoryPressure.start();
    const operation = vi.fn(async () => 42);
    const a = fm.spawnGate.run({ instanceName: "a", workingDirectory: "/fixture/a", reason: "startup" }, operation);
    const b = fm.spawnGate.run({ instanceName: "b", workingDirectory: "/fixture/b", reason: "startup" }, operation);
    await vi.advanceTimersByTimeAsync(0); expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999); expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await Promise.all([a, b]); expect(operation).toHaveBeenCalledTimes(2);
    set("critical"); const c = fm.spawnGate.run({ instanceName: "c", workingDirectory: "/fixture/c", reason: "restart" }, operation);
    const stopped = c.catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000); expect(operation).toHaveBeenCalledTimes(2);
    fm.spawnGate.shutdown(); await stopped;
  });

  it("elevated still limits outer lifecycle admissions while one remains active", async () => {
    const { fm, f, set } = make("linux", "elevated");
    f.fleetConfig.defaults.startup = { concurrency: 3, stagger_delay_ms: 0 };
    let release!: () => void;
    const active = new Promise<void>(resolve => { release = resolve; });
    const first = vi.fn(() => active), second = vi.fn(async () => 42);
    const a = fm.spawnGate.run({ instanceName: "a", workingDirectory: "/fixture/a", reason: "startup", stage: "lifecycle" }, first);
    const b = fm.spawnGate.run({ instanceName: "b", workingDirectory: "/fixture/b", reason: "startup", stage: "lifecycle" }, second);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    set("normal"); release(); await vi.advanceTimersByTimeAsync(60_000); await Promise.all([a, b]);
    expect(second).toHaveBeenCalledOnce();
  });

  it.each(["en", "zh-TW"] as const)("%s: real Classic start action replies once while the real gate holds, then continues", async language => {
    setLocale(language); const { fm, f, set, notify } = make("linux", "critical");
    vi.spyOn(f, "validateClassicStart").mockReturnValue(undefined);
    vi.spyOn(f, "getMissingBackendWarning").mockReturnValue(undefined);
    const operation = vi.fn(async () => "started");
    // The spawning handler is inert; the real command handler, gate and sampler run.
    vi.spyOn(fm, "handleClassicStart").mockImplementation(() => fm.spawnGate.run({ instanceName: "requested", workingDirectory: "/fixture/requested", reason: "startup" }, operation));
    const respond = vi.fn().mockResolvedValue(undefined);
    const result = f.handleClassicStartSlash({ channelId: "requested-room", channelName: "fixture", userId: "admin", options: { backend: "codex" }, respond }, "dc");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(operation).not.toHaveBeenCalled(); expect(respond).toHaveBeenCalledExactlyOnceWith(t("memory.action_held"));
    expect(notify).not.toHaveBeenCalled();
    set("normal"); await vi.advanceTimersByTimeAsync(120_000); await result;
    expect(operation).toHaveBeenCalledOnce(); expect(respond).toHaveBeenCalledTimes(2); expect(respond.mock.calls[1]).toEqual(["started"]);
  });

  it("concurrent action owners retain their own reply through retries; background work broadcasts nothing", async () => {
    const { fm, set, notify } = make("linux", "critical");
    const first = vi.fn().mockResolvedValue(undefined), second = vi.fn().mockRejectedValue(new Error("inert transport error"));
    const task = (name: string) => ({ instanceName: name, workingDirectory: `/fixture/${name}`, reason: "wake" as const });
    const operation = vi.fn(async () => 42);
    const runs = [withSpawnHoldReply(first, () => fm.spawnGate.run(task("a"), operation)),
      withSpawnHoldReply(second, () => fm.spawnGate.run(task("b"), operation)), fm.spawnGate.run(task("background"), operation)];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first).toHaveBeenCalledExactlyOnceWith(t("memory.action_held")); expect(second).toHaveBeenCalledExactlyOnceWith(t("memory.action_held"));
    expect(operation).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    set("normal"); await vi.advanceTimersByTimeAsync(120_000); expect(await Promise.all(runs)).toEqual([42, 42, 42]);
  });

  it("a synchronously cancelled hold sends no stale waiting reply", async () => {
    const { fm } = make("linux", "critical"); const reply = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn(async () => 42);
    const result = withSpawnHoldReply(reply, () => fm.spawnGate.run({ instanceName: "cancelled", workingDirectory: "/fixture/cancelled", reason: "startup" }, operation));
    const stopped = result.catch(() => {}); fm.spawnGate.shutdown();
    await vi.advanceTimersByTimeAsync(0); await stopped;
    expect(reply).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
  });

  it("Darwin unknown releases admission without a stale critical reply", async () => {
    const { fm, set } = make("darwin", "critical"); const reply = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn(async () => 42);
    const result = withSpawnHoldReply(reply, () => fm.spawnGate.run({ instanceName: "released", workingDirectory: "/fixture/released", reason: "wake" }, operation));
    set("unknown"); fm.memoryPressure.sample();
    await vi.advanceTimersByTimeAsync(0); await result;
    expect(reply).not.toHaveBeenCalled(); expect(operation).toHaveBeenCalledOnce();
  });

  it.each([false, true])("queued operation keeps its own nested reply scope (background=%s)", async background => {
    const { fm, f, set, notify } = make("linux");
    f.fleetConfig.defaults.startup = { concurrency: 1, stagger_delay_ms: 0 };
    const first = vi.fn().mockResolvedValue(undefined), second = vi.fn().mockResolvedValue(undefined);
    let release!: () => void, finish!: () => void;
    const blocking = new Promise<void>(resolve => { release = resolve; });
    const stillActive = new Promise<void>(resolve => { finish = resolve; });
    const a = withSpawnHoldReply(first, async () => {
      await fm.spawnGate.run({ instanceName: "a", workingDirectory: "/fixture/a", reason: "startup", stage: "lifecycle" }, () => blocking);
      await stillActive;
    });
    const physical = vi.fn(async () => 42);
    const enqueue = () => fm.spawnGate.run({ instanceName: "b", workingDirectory: "/fixture/b", reason: "startup", stage: "lifecycle" }, async () => {
      set("critical");
      return fm.spawnGate.run({ instanceName: "b", workingDirectory: "/fixture/b", reason: "startup" }, physical);
    });
    const b = background ? enqueue() : withSpawnHoldReply(second, enqueue);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(first).not.toHaveBeenCalled();
    if (background) expect(second).not.toHaveBeenCalled();
    else expect(second).toHaveBeenCalledExactlyOnceWith(t("memory.action_held"));
    expect(notify).not.toHaveBeenCalled(); expect(physical).not.toHaveBeenCalled();
    set("normal"); await vi.advanceTimersByTimeAsync(120_000); finish(); await Promise.all([a, b]);
    expect(physical).toHaveBeenCalledOnce();
  });

  it("an unsent transient hold remains eligible when the same action later holds again", async () => {
    const { fm, set } = make("darwin", "critical"); const reply = vi.fn().mockResolvedValue(undefined);
    let release!: () => void;
    const later = new Promise<void>(resolve => { release = resolve; });
    const operation = vi.fn(async () => 42);
    const result = withSpawnHoldReply(reply, () => fm.spawnGate.run({ instanceName: "a", workingDirectory: "/fixture/a", reason: "startup", stage: "lifecycle" }, async () => {
      await later;
      return fm.spawnGate.run({ instanceName: "a", workingDirectory: "/fixture/a", reason: "startup" }, operation);
    }));
    set("unknown"); fm.memoryPressure.sample(); await vi.advanceTimersByTimeAsync(0);
    expect(reply).not.toHaveBeenCalled();
    set("critical"); fm.memoryPressure.sample(); release(); await vi.advanceTimersByTimeAsync(0);
    expect(reply).toHaveBeenCalledExactlyOnceWith(t("memory.action_held")); expect(operation).not.toHaveBeenCalled();
    set("normal"); await vi.advanceTimersByTimeAsync(120_000); await result;
    expect(operation).toHaveBeenCalledOnce(); expect(reply).toHaveBeenCalledOnce();
  });

  it("bot ingress clears an inherited human reply scope", async () => {
    const { fm, f, set, sendText, notify } = make("linux", "critical");
    const reply = vi.fn().mockResolvedValue(undefined), operation = vi.fn(async () => undefined);
    // Only the existing ingress core/spawning handler is inert; the wrapper and real gate run.
    vi.spyOn(f, "handleInboundMessageCore").mockImplementation(() => fm.spawnGate.run({ instanceName: "bot-work", workingDirectory: "/fixture/bot-work", reason: "wake" }, operation));
    const result = withSpawnHoldReply(reply, () => f.handleInboundMessage({ isBotMessage: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(reply).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    set("normal"); await vi.advanceTimersByTimeAsync(120_000); await result; expect(operation).toHaveBeenCalledOnce();
  });

  it.each(["start", "restart", "wake"] as const)("web %s returns the hold reason once and completes the queued operation after recovery", async action => {
    const { fm, f, set, notify } = make("linux", "critical");
    vi.spyOn(f, "webToken", "get").mockReturnValue("fixture".repeat(8));
    f.fleetConfig.instances.worker = { working_directory: "/fixture/worker" };
    const operation = vi.fn(async () => undefined);
    const enqueue = () => fm.spawnGate.run({ instanceName: "worker", workingDirectory: "/fixture/worker", reason: action === "start" ? "startup" : action }, operation);
    if (action === "start") vi.spyOn(fm, "startInstance").mockImplementation(enqueue);
    else if (action === "restart") vi.spyOn(fm, "restartSingleInstance").mockImplementation(enqueue);
    else vi.spyOn(fm, "explicitWake").mockImplementation(enqueue);
    const url = new URL(action === "wake" ? "/api/settings/instances/worker/wake" : `/ui/${action}/worker`, "http://fixture");
    const req = { method: "POST", url: url.pathname, headers: { "x-agend-token": f.webToken } } as unknown as IncomingMessage;
    const bodies: unknown[] = [], statuses: number[] = [];
    const res = { setHeader: vi.fn(), writeHead: (status: number) => { statuses.push(status); },
      end: (body: string) => { bodies.push(JSON.parse(body)); } } as unknown as ServerResponse;
    expect(action === "wake" ? handleSettingsRequest(req, res, url, f) : handleWebRequest(req, res, url, f)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statuses).toEqual([202]); expect(bodies).toEqual([expect.objectContaining({ held: true, message: t("memory.action_held") })]);
    expect(operation).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    set("normal"); await vi.advanceTimersByTimeAsync(120_000);
    expect(operation).toHaveBeenCalledOnce(); expect(statuses).toEqual([202]); expect(bodies).toHaveLength(1);
  });
});
