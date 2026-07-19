import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutoPauseController, Daemon } from "../src/daemon.js";
import { TopicCommands } from "../src/topic-commands.js";
import { TmuxManager } from "../src/tmux-manager.js";

describe("AutoPauseController", () => {
  it("requests pause only after a continuous idle threshold", () => {
    const controller = new AutoPauseController(15_000);

    expect(controller.observe("idle", 1_000)).toBe(false);
    expect(controller.observe("idle", 15_999)).toBe(false);
    expect(controller.observe("idle", 16_000)).toBe(true);

    controller.markPaused(16_000);
    expect(controller.isPaused).toBe(true);
    expect(controller.lastPausedAt).toBe(16_000);
    expect(controller.observe("idle", 60_000)).toBe(false);
  });

  it("resets the idle timer when the instance works", () => {
    const controller = new AutoPauseController(10_000);

    controller.observe("idle", 0);
    expect(controller.observe("working", 9_000)).toBe(false);
    expect(controller.observe("idle", 10_000)).toBe(false);
    expect(controller.observe("idle", 20_000)).toBe(true);
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
    }, instanceDir, false, { getQuitCommand: () => "exit", getSessionId: () => null } as any);
    (daemon as any).tmux = tmux;

    await daemon.pause();

    expect(daemon.isPaused).toBe(true);
    expect(tmux.getWindowId()).toBe(windowId);
    expect(await tmux.isWindowAlive()).toBe(true);
    expect(await tmux.getPaneStatus()).toMatchObject({ alive: false });
    expect(existsSync(join(instanceDir, "paused-state.json"))).toBe(true);

    const trySpawn = vi.spyOn(daemon as any, "trySpawn").mockResolvedValue(true);
    await daemon.wake(1_000);
    expect(trySpawn).toHaveBeenCalledWith(true, 1_000);
    expect(daemon.isPaused).toBe(false);
    expect(existsSync(join(instanceDir, "paused-state.json"))).toBe(false);
  });
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
      classicChannels: {
        getAll: () => [{ instanceName: "classic-room-1234", name: "room", channelId: "1234" }],
        getBackendByInstance: () => "codex",
      },
    } as any);

    const status = await commands.getStatusText();
    expect(status).toContain("Paused instances: 1");
    expect(status).toContain("| sleeping | codex | - | $0.00 | ⏸ | ⏸ paused |");
    expect(status).toContain("| active | kiro-cli | - | $0.00 | 🟢 | 🔵 working |");
    expect(status).toContain("| ready | claude-code | - | $0.00 | 🟢 | 🟢 idle |");
    expect(status).toContain("| frozen | gemini-cli | - | $0.00 | 🟢 | 🔴 stuck |");
    expect(status).toContain("| [C] classic-room-1234 | codex | - | $0.00 | 🟢 | 🟢 idle |");
  });

  it("renders execution state and distinguishes paused from stopped in /sysinfo", () => {
    const commands = new TopicCommands({
      fleetConfig: { defaults: {}, instances: {} },
      getSysInfo: () => ({
        uptime_seconds: 60,
        memory_mb: { rss: 1, heapUsed: 1, heapTotal: 2 },
        instances: [
          { name: "busy", status: "running", state: "working", ipc: true, costCents: 0, rateLimits: null },
          { name: "sleeping", status: "paused", state: null, ipc: true, costCents: 0, rateLimits: null },
          { name: "off", status: "stopped", state: null, ipc: false, costCents: 0, rateLimits: null },
        ],
        fleet_cost_cents: 0,
        fleet_cost_limit_cents: 0,
      }),
      getInstanceStatus: () => "running",
      getInstanceExecutionState: () => "stuck",
      instanceIpcClients: new Map([["classic-lab-5678", {}]]),
      classicChannels: {
        getAll: () => [{ instanceName: "classic-lab-5678", name: "lab", channelId: "5678" }],
      },
      costGuard: null,
    } as any);

    const sysinfo = commands.getSysInfoText();
    expect(sysinfo).toContain("| 🔵 busy | working | ✓ |");
    expect(sysinfo).toContain("| ⏸ sleeping | paused | ✓ |");
    expect(sysinfo).toContain("| ⚪ off | stopped | ✗ |");
    expect(sysinfo).toContain("| 🔴 [C] classic-lab-5678 | stuck | ✓ |");
  });
});
