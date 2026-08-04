import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutoPauseController, Daemon, readLastInboundAt, writeLastInboundAt } from "../src/daemon.js";
import { TopicCommands } from "../src/topic-commands.js";
import { TmuxManager } from "../src/tmux-manager.js";
import pino from "pino";
import type { Logger } from "../src/logger.js";

const rootLogger = pino({ level: "silent" }) as Logger;

describe("AutoPauseController", () => {
  it("requests pause after the user-inactivity threshold while idle", () => {
    const controller = new AutoPauseController(15_000, 1_000);

    expect(controller.observe("idle", 1_000)).toBe(false);
    expect(controller.observe("idle", 15_999)).toBe(false);
    expect(controller.observe("idle", 16_000)).toBe(true);

    controller.markPaused(16_000);
    expect(controller.isPaused).toBe(true);
    expect(controller.lastPausedAt).toBe(16_000);
    expect(controller.observe("idle", 60_000)).toBe(false);
  });

  it("does not reset inactivity while working, but only pauses once idle", () => {
    const controller = new AutoPauseController(10_000, 0);

    expect(controller.observe("working", 9_000)).toBe(false);
    expect(controller.observe("working", 20_000)).toBe(false);
    expect(controller.observe("idle", 20_000)).toBe(true);
  });

  it("resets inactivity when a new channel message arrives", () => {
    const controller = new AutoPauseController(10_000, 0);
    controller.recordActivity(15_000);

    expect(controller.observe("idle", 20_000)).toBe(false);
    expect(controller.observe("idle", 25_000)).toBe(true);
  });

  it("persists the last inbound time across controller recreation", () => {
    const instanceDir = join(tmpdir(), `agend-last-inbound-${process.pid}-${Date.now()}`);
    mkdirSync(instanceDir, { recursive: true });
    try {
      writeLastInboundAt(instanceDir, 1_000);
      const restored = readLastInboundAt(instanceDir, 20_000);
      expect(restored).toBe(1_000);

      const restartedController = new AutoPauseController(10_000, restored!);
      expect(restartedController.observe("idle", 20_000)).toBe(true);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("disables auto-pause when threshold is zero", () => {
    const controller = new AutoPauseController(0);
    expect(controller.observe("idle", 0)).toBe(false);
    expect(controller.observe("idle", 60 * 60_000)).toBe(false);
  });

  it("wakes before delivery and returns to active", async () => {
    const controller = new AutoPauseController(1);
    controller.markPaused(100);
    const wake = vi.fn(async () => {});

    await controller.wakeOnDeliver(wake);

    expect(wake).toHaveBeenCalledOnce();
    expect(controller.isPaused).toBe(false);
  });

  it("stays paused when wake fails", async () => {
    const controller = new AutoPauseController(1);
    controller.markPaused(100);

    await expect(controller.wakeOnDeliver(async () => {
      throw new Error("ready timeout");
    })).rejects.toThrow("ready timeout");
    expect(controller.isPaused).toBe(true);
  });
});

describe("Daemon auto-pause lifecycle", () => {
  const sessions: string[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map(name => TmuxManager.killSession(name)));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps General exempt even when auto_pause_after is configured", () => {
    const instanceDir = join(tmpdir(), `agend-general-no-auto-pause-${process.pid}-${Date.now()}`);
    dirs.push(instanceDir);
    mkdirSync(instanceDir, { recursive: true });
    const daemon = new Daemon("general-discord", {
      working_directory: "/tmp",
      general_topic: true,
      auto_pause_after: 1,
      restart_policy: { max_retries: 1, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "error",
    }, instanceDir, true, undefined, undefined, rootLogger);

    expect((daemon as any).autoPauseController.observe("idle", Date.now() + 24 * 60 * 60_000))
      .toBe(false);
  });

  it("stops the pane process, preserves the window, and wakes before reuse", async () => {
    const session = `agend-auto-pause-${process.pid}-${Date.now()}`;
    const instanceDir = join(tmpdir(), session);
    sessions.push(session);
    dirs.push(instanceDir);
    mkdirSync(instanceDir, { recursive: true });

    await TmuxManager.ensureSession(session);
    const tmux = new TmuxManager(session, "");
    const windowId = await tmux.createWindow("bash --noprofile --norc", "/tmp", "auto-pause");
    await tmux.setRemainOnExit();

    const daemon = new Daemon("auto-pause", {
      working_directory: "/tmp",
      auto_pause_after: 30,
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "error",
    }, instanceDir, false, {
      getQuitCommand: () => "exit",
      getSessionId: () => null,
      getReadyPattern: () => /^>$/m,
      getErrorPatterns: () => [{ pattern: /NEVER_MATCH/, type: "crash", action: "notify", message: "test" }],
      getRuntimeDialogs: () => [],
    } as any, undefined, rootLogger);
    (daemon as any).tmux = tmux;

    await daemon.pause();

    expect(daemon.isPaused).toBe(true);
    expect(tmux.getWindowId()).toBe(windowId);
    expect(await tmux.isWindowAlive()).toBe(true);
    expect(await tmux.getPaneStatus()).toMatchObject({ alive: false });
    expect(existsSync(join(instanceDir, "paused"))).toBe(true);

    const trySpawn = vi.spyOn(daemon as any, "trySpawn").mockResolvedValue(true);
    (daemon as any).errorWaitingForRecovery = true;
    (daemon as any).errorDetectedAt = 100;
    (daemon as any).errorRecoveryDeadlineAt = 200;
    (daemon as any).activeErrorPatternKey = "auth_error:AUTH";
    await daemon.wake(1_000);
    expect(trySpawn).toHaveBeenCalledWith(true, 1_000);
    expect(daemon.isPaused).toBe(false);
    expect((daemon as any).errorWaitingForRecovery).toBe(false);
    expect((daemon as any).errorRecoveryDeadlineAt).toBe(0);
    expect((daemon as any).activeErrorPatternKey).toBeNull();
    expect(existsSync(join(instanceDir, "paused"))).toBe(false);
    (daemon as any).freezeRuntimeMonitors();
  });

  it("restores monitor timers without listener leaks across 10 pause/wake cycles", async () => {
    const session = `agend-pause-soak-${process.pid}-${Date.now()}`;
    const instanceDir = join(tmpdir(), session);
    sessions.push(session);
    dirs.push(instanceDir);
    mkdirSync(instanceDir, { recursive: true });

    await TmuxManager.ensureSession(session);
    const tmux = new TmuxManager(session, "");
    await tmux.createWindow("bash --noprofile --norc", "/tmp", "pause-soak");
    await tmux.setRemainOnExit();

    const backend = {
      getQuitCommand: () => "exit",
      getSessionId: () => null,
      getReadyPattern: () => /^>$/m,
      getErrorPatterns: () => [{ pattern: /NEVER_MATCH/, type: "crash", action: "notify", message: "test" }],
      getRuntimeDialogs: () => [],
    } as any;
    const daemon = new Daemon("pause-soak", {
      working_directory: "/tmp",
      auto_pause_after: 30,
      restart_policy: { max_retries: 1, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "error",
    }, instanceDir, false, backend, undefined, rootLogger);
    (daemon as any).tmux = tmux;

    const transcript = {
      stop: vi.fn(), startPolling: vi.fn(), resetOffset: vi.fn(),
    };
    const guardian = { stop: vi.fn(), startWatching: vi.fn() };
    (daemon as any).transcriptMonitor = transcript;
    (daemon as any).guardian = guardian;
    vi.spyOn(daemon as any, "trySpawn").mockResolvedValue(true);
    const listenerBaseline = daemon.eventNames().reduce((total, event) => total + daemon.listenerCount(event), 0);

    for (let i = 0; i < 10; i++) {
      await daemon.pause();
      expect((daemon as any).instanceStateMonitorTimer).toBeNull();
      expect((daemon as any).errorMonitorTimer).toBeNull();
      expect((daemon as any).healthCheckTimer).toBeNull();
      await daemon.wake(1_000);
      expect((daemon as any).instanceStateMonitorTimer).not.toBeNull();
      expect((daemon as any).errorMonitorTimer).not.toBeNull();
      expect((daemon as any).healthCheckTimer).not.toBeNull();
    }

    expect(transcript.stop).toHaveBeenCalledTimes(10);
    expect(transcript.startPolling).toHaveBeenCalledTimes(10);
    expect(guardian.stop).toHaveBeenCalledTimes(10);
    expect(guardian.startWatching).toHaveBeenCalledTimes(10);
    expect(daemon.eventNames().reduce((total, event) => total + daemon.listenerCount(event), 0)).toBe(listenerBaseline);
    (daemon as any).freezeRuntimeMonitors();
  }, 20_000);
});

describe("paused status visibility", () => {
  it("includes the paused instance count in /status", async () => {
    const commands = new TopicCommands({
      fleetConfig: {
        defaults: {},
        instances: {
          sleeping: { backend: "codex" },
          active: { backend: "kiro-cli" },
          ready: { backend: "claude-code" },
          frozen: { backend: "gemini-cli" },
        },
      },
      dataDir: "/tmp/agend-auto-pause-status-test",
      getInstanceStatus: (name: string) => name === "sleeping" ? "paused" : "running",
      getInstanceExecutionState: (name: string) => name === "active" ? "working"
        : name === "ready" ? "idle"
          : name === "frozen" ? "stuck"
            : name === "classic-room-1234" ? "idle" : null,
      costGuard: null,
      getAdapterStates: () => new Map(),
      instanceIpcClients: new Map([["active", {}], ["ready", {}], ["frozen", {}], ["classic-room-1234", {}]]),
      classicChannels: {
        getAll: () => [{ instanceName: "classic-room-1234", name: "room", channelId: "1234" }],
        getBackendByInstance: () => "codex",
      },
    } as any);

    const status = await commands.getStatusText();
    expect(status).toContain("Paused instances: 1");
    // Effort column added between Ctx and Cost; "-" where no effort is configured.
    // IPC column folded in from the old /sysinfo instance table.
    expect(status).toContain("| sleeping | codex | - | - | $0.00 | ⏸ | ⏸ paused | ✗ |");
    expect(status).toContain("| active | kiro-cli | - | - | $0.00 | 🟢 | 🔵 working | ✓ |");
    expect(status).toContain("| ready | claude-code | - | - | $0.00 | 🟢 | 🟢 idle | ✓ |");
    expect(status).toContain("| frozen | gemini-cli | - | - | $0.00 | 🟢 | 🔴 stuck | ✓ |");
    expect(status).toContain("| classic-room-1234 | codex | - | - | $0.00 | 🟢 | 🟢 idle | ✓ |");
  });

  it("/sysinfo is system-level only — the instance table moved to /status", () => {
    const commands = new TopicCommands({
      fleetConfig: { defaults: {}, instances: {} },
      getSysInfo: () => ({
        uptime_seconds: 3660,
        memory_mb: { rss: 1, heapUsed: 1, heapTotal: 2 },
        instances: [
          { name: "busy", status: "running", state: "working", ipc: true, costCents: 0, rateLimits: null },
        ],
        fleet_cost_cents: 0,
        fleet_cost_limit_cents: 0,
      }),
      getInstanceStatus: () => "running",
      getInstanceExecutionState: () => "stuck",
      instanceIpcClients: new Map(),
      classicChannels: {
        getAll: () => [{ instanceName: "classic-lab-5678", name: "lab", channelId: "5678" }],
      },
      costGuard: null,
    } as any);

    const sysinfo = commands.getSysInfoText();
    // System facts stay (and OS/Node/tmux are new).
    expect(sysinfo).toContain("| Uptime | 1h 1m |");
    expect(sysinfo).toContain(`| Node | ${process.version} |`);
    expect(sysinfo).toContain("| OS |");
    expect(sysinfo).toContain("| tmux |");
    // Instance information is /status's job now — even instances the sys-info
    // payload still carries must not be rendered here.
    expect(sysinfo).not.toContain("Instances");
    expect(sysinfo).not.toContain("busy");
    expect(sysinfo).not.toContain("classic-lab-5678");
  });
});
