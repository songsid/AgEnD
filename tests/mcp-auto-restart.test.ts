import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

afterEach(() => setAuthCheckRunnerForTests(null));
import { Daemon } from "../src/daemon.js";
import { InstanceLifecycle, type LifecycleContext, type IncidentEventSource } from "../src/instance-lifecycle.js";
import type { Logger } from "../src/logger.js";
import { mcpServerState } from "../src/mcp-liveness.js";

/**
 * mcp_died + idle → automatic instance restart (PR feat/mcp-auto-restart-on-idle).
 *
 * The MCP server is the CLI's child — only respawning the CLI brings the tools
 * back. The failure this automates away: an instance whose MCP server died kept
 * running toolless (cannot reply, cannot report) until an operator noticed the
 * ⚠️ and restarted it by hand. The dangerous part is timing — the death is
 * usually detected mid-turn, where an immediate restart destroys in-flight
 * work — hence the idle gate, mirroring pausePending.
 */

vi.mock("../src/mcp-liveness.js", () => ({
  mcpServerState: vi.fn(() => ({ state: "unknown" })),
}));
const liveness = vi.mocked(mcpServerState);

const rootLogger = pino({ level: "silent" }) as Logger;

// ── Daemon side: detection → idle gate → mcp_restart_requested ────────────

type AnyDaemon = Daemon & Record<string, any>;

function makeDaemon(overrides: Record<string, unknown> = {}): { daemon: AnyDaemon; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agend-mcp-restart-"));
  const daemon = new Daemon("mcp-test", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
    ...overrides,
  } as any, dir, true, undefined, undefined, rootLogger) as AnyDaemon;
  return { daemon, dir };
}

function idleSnapshot(state = "idle") {
  const now = Date.now();
  return { state, unchangedForMs: 0, observedAt: now, stateChangedAt: now } as any;
}

describe("daemon: MCP death arms an idle-gated restart request", () => {
  let dir: string;
  afterEach(() => {
    vi.useRealTimers();
    liveness.mockReset();
    liveness.mockReturnValue({ state: "unknown" } as any);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires immediately when the pane is already idle — a parked collab instance never gets an idle edge", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "idle";
    const died = vi.fn(); const requested = vi.fn();
    daemon.on("mcp_died", died);
    daemon.on("mcp_restart_requested", requested);
    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);

    daemon.checkMcpServerAlive();

    expect(died).toHaveBeenCalledWith({ name: "mcp-test", pid: 12345, autoRestart: true, authSuspected: false });
    expect(requested).toHaveBeenCalledWith({ name: "mcp-test", trigger: "already_idle" });
    expect(daemon.mcpRestartPending).toBe(false); // one death, one request
  });

  it("defers while the pane is busy, then fires on the idle edge instead of interrupting the turn", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "working";
    const requested = vi.fn();
    daemon.on("mcp_restart_requested", requested);
    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);

    daemon.checkMcpServerAlive();
    expect(requested).not.toHaveBeenCalled();

    daemon.applyInstanceStateSnapshot(idleSnapshot());
    expect(requested).toHaveBeenCalledWith({ name: "mcp-test", trigger: "idle_edge" });
  });

  it("waits for the paste queue too — a queued inbound is about to make the pane busy again", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "idle";
    daemon.pasteQueueDepth = 1;
    const requested = vi.fn();
    daemon.on("mcp_restart_requested", requested);
    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);

    daemon.checkMcpServerAlive();
    expect(requested).not.toHaveBeenCalled();

    daemon.pasteQueueDepth = 0;
    daemon.applyInstanceStateSnapshot(idleSnapshot());
    expect(requested).toHaveBeenCalledOnce();
  });

  it("mcp_auto_restart: false keeps the old notify-only behaviour", () => {
    const made = makeDaemon({ mcp_auto_restart: false }); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "idle";
    const died = vi.fn(); const requested = vi.fn();
    daemon.on("mcp_died", died);
    daemon.on("mcp_restart_requested", requested);
    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);

    daemon.checkMcpServerAlive();
    daemon.applyInstanceStateSnapshot(idleSnapshot());

    expect(died).toHaveBeenCalledWith({ name: "mcp-test", pid: 12345, autoRestart: false, authSuspected: false });
    expect(requested).not.toHaveBeenCalled();
  });

  it("stands down when the server turns up alive again before the pane idles", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "working";
    const requested = vi.fn();
    daemon.on("mcp_restart_requested", requested);

    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);
    daemon.checkMcpServerAlive();
    expect(daemon.mcpRestartPending).toBe(true);

    // Operator restarted by hand / CLI brought a new server up.
    liveness.mockReturnValue({ state: "alive", pid: 54321 } as any);
    daemon.checkMcpServerAlive();

    daemon.applyInstanceStateSnapshot(idleSnapshot());
    expect(requested).not.toHaveBeenCalled();
  });

  it("force-fires after 30 minutes when the instance never idles — mute work is stranded work", () => {
    vi.useFakeTimers();
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "working";
    const requested = vi.fn();
    daemon.on("mcp_restart_requested", requested);
    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);

    daemon.checkMcpServerAlive();
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(requested).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requested).toHaveBeenCalledWith({ name: "mcp-test", trigger: "stale_timeout" });
  });

  it("a frozen daemon (paused/stopped) never fires the stale timer into a dead pane", () => {
    vi.useFakeTimers();
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "working";
    const requested = vi.fn();
    daemon.on("mcp_restart_requested", requested);
    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);

    daemon.checkMcpServerAlive();
    daemon.freezeRuntimeMonitors();
    vi.advanceTimersByTime(31 * 60_000);
    expect(requested).not.toHaveBeenCalled();
  });
});

// ── Fleet side: restart with a loop-proof cooldown ─────────────────────────

function makeLifecycle() {
  const calls: string[] = [];
  const restartSingleInstance = vi.fn(async () => { calls.push("restart"); });
  const clearCancelButton = vi.fn(() => { calls.push("clearCancelButton"); });
  const notifyInstanceTopic = vi.fn();
  const ctx = {
    fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: null,
    isPlannedRestart: () => false,
    notifyInstanceTopic,
    webhookEmit() {},
    clearCancelButton,
    checkModelFailover() {},
    setTopicIcon() {},
    restartSingleInstance,
  } as unknown as LifecycleContext;
  const lifecycle = new InstanceLifecycle(ctx);
  const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} }) as unknown as IncidentEventSource & EventEmitter;
  lifecycle.attachIncidentHandlers("worker", daemon);
  return { daemon, restartSingleInstance, notifyInstanceTopic, clearCancelButton, calls };
}

describe("lifecycle: mcp_restart_requested → restartSingleInstance, once per cooldown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("restarts the instance (plain restart — the session must survive) and tells the channel", () => {
    const { daemon, restartSingleInstance, notifyInstanceTopic } = makeLifecycle();

    daemon.emit("mcp_restart_requested", { name: "worker", trigger: "idle_edge" });

    // No freshStart argument: resume, don't reset.
    expect(restartSingleInstance).toHaveBeenCalledWith("worker");
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", expect.stringContaining("自動重啟"));
  });

  it("suppresses a second restart inside the cooldown — a server that dies right back is not fixed by cycling", () => {
    const { daemon, restartSingleInstance } = makeLifecycle();

    daemon.emit("mcp_restart_requested", { name: "worker", trigger: "already_idle" });
    vi.advanceTimersByTime(14 * 60_000);
    daemon.emit("mcp_restart_requested", { name: "worker", trigger: "already_idle" });

    expect(restartSingleInstance).toHaveBeenCalledTimes(1);
  });

  it("allows the next restart once the cooldown has passed", () => {
    const { daemon, restartSingleInstance } = makeLifecycle();

    daemon.emit("mcp_restart_requested", { name: "worker", trigger: "already_idle" });
    vi.advanceTimersByTime(15 * 60_000 + 1);
    daemon.emit("mcp_restart_requested", { name: "worker", trigger: "already_idle" });

    expect(restartSingleInstance).toHaveBeenCalledTimes(2);
  });

  it("mcp_died message announces the auto-restart when armed, manual steps when not", async () => {
    // The handler now double-checks auth before reporting; a passing probe
    // keeps the original MCP message this test asserts on.
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: '{"loggedIn": true}' }));
    const { daemon, notifyInstanceTopic } = makeLifecycle();

    daemon.emit("mcp_died", { name: "worker", pid: 1, autoRestart: true });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenLastCalledWith("worker", expect.stringContaining("自動重啟")));

    daemon.emit("mcp_died", { name: "worker", pid: 2, autoRestart: false });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenLastCalledWith("worker", expect.stringContaining("restart_instance")));
  });

  it("retires the cancel button before restarting — a click on the leftover would target the new CLI", () => {
    const { daemon, clearCancelButton, calls } = makeLifecycle();

    daemon.emit("mcp_restart_requested", { name: "worker", trigger: "idle_edge" });

    expect(clearCancelButton).toHaveBeenCalledWith("worker");
    expect(calls).toEqual(["clearCancelButton", "restart"]);
  });
});

// ── #485 review fixes: crash-loop bypass and restart race ──────────────────

describe("daemon: a recovery in progress cancels the revival restart (sol's review, #485)", () => {
  let dir: string;
  afterEach(() => {
    vi.useRealTimers();
    liveness.mockReset();
    liveness.mockReturnValue({ state: "unknown" } as any);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stale timer during crash-loop handling (healthCheckPaused) cancels instead of restarting", () => {
    vi.useFakeTimers();
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "working";
    const requested = vi.fn();
    daemon.on("mcp_restart_requested", requested);
    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);

    daemon.checkMcpServerAlive();
    daemon.healthCheckPaused = true; // crash recovery took over
    vi.advanceTimersByTime(31 * 60_000);

    expect(requested).not.toHaveBeenCalled();
    // Cancelled, not deferred: the recovery's own respawn brings a fresh MCP
    // server, so a later idle edge must not restart on top of it either.
    expect(daemon.mcpRestartPending).toBe(false);
  });

  it("an idle edge while a respawn is in flight (spawning) does not restart on top of it", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon.instanceState = "working";
    const requested = vi.fn();
    daemon.on("mcp_restart_requested", requested);
    liveness.mockReturnValue({ state: "dead", pid: 12345 } as any);

    daemon.checkMcpServerAlive();
    daemon.spawning = true;
    daemon.applyInstanceStateSnapshot(idleSnapshot());

    expect(requested).not.toHaveBeenCalled();
    expect(daemon.mcpRestartPending).toBe(false);
  });
});

describe("fleet-manager: concurrent restart sources share one restart (sol's review, #485)", () => {
  it("the second caller joins the in-flight restart instead of stopping the instance twice", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dataDir = mkdtempSync(join(tmpdir(), "agend-restart-race-"));
    const fm = new FleetManager(dataDir) as any;
    fm.fleetConfig = {
      defaults: {},
      instances: { worker: { working_directory: dataDir } },
    };
    let releaseStop!: () => void;
    const stopGate = new Promise<void>(r => { releaseStop = r; });
    const stopInstance = vi.fn(() => stopGate);
    const startInstance = vi.fn().mockResolvedValue(undefined);
    fm.stopInstance = stopInstance;
    fm.startInstance = startInstance;

    try {
      const first = fm.restartSingleInstance("worker");          // MCP revival
      const second = fm.restartSingleInstance("worker");         // manual /restart racing it
      releaseStop();
      await Promise.all([first, second]);

      expect(stopInstance).toHaveBeenCalledTimes(1);
      expect(startInstance).toHaveBeenCalledTimes(1);

      // The guard releases once done — a later restart runs for real again.
      await fm.restartSingleInstance("worker");
      expect(stopInstance).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("a failed restart releases the guard for the next attempt", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dataDir = mkdtempSync(join(tmpdir(), "agend-restart-fail-"));
    const fm = new FleetManager(dataDir) as any;
    fm.fleetConfig = { defaults: {}, instances: { worker: { working_directory: dataDir } } };
    fm.stopInstance = vi.fn().mockRejectedValueOnce(new Error("tmux gone")).mockResolvedValue(undefined);
    fm.startInstance = vi.fn().mockResolvedValue(undefined);

    try {
      await expect(fm.restartSingleInstance("worker")).rejects.toThrow("tmux gone");
      await expect(fm.restartSingleInstance("worker")).resolves.toBeUndefined();
      expect(fm.startInstance).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
