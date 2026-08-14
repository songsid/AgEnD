import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, PaneStateMachine, PendingWorkTracker, sanitizePaneTail } from "../src/daemon.js";
import { HangDetector } from "../src/hang-detector.js";

describe("PaneStateMachine", () => {
  const timeoutMs = 10 * 60_000;

  it("reports idle when the backend ready prompt is visible", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    expect(machine.observe("completed output\nREADY", 1).state).toBe("idle");
  });

  it("reports working while non-ready pane content is changing", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    expect(machine.observe("thinking frame 1", 1).state).toBe("working");
    expect(machine.observe("thinking frame 2", timeoutMs + 1).state).toBe("working");
    expect(machine.snapshot(timeoutMs * 2).unchangedForMs).toBe(timeoutMs - 1);
  });

  it("reports working when output changes behind a persistent ready marker", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    expect(machine.observe("READY\noutput 1", 1).state).toBe("idle");
    expect(machine.observe("READY\noutput 2", 2).state).toBe("working");
    expect(machine.observe("READY\noutput 2", 3).state).toBe("idle");
  });

  it("reports stuck after a non-ready pane stops changing for the timeout", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    expect(machine.observe("thinking", 1).state).toBe("working");
    expect(machine.observe("thinking", timeoutMs).state).toBe("working");
    expect(machine.observe("thinking", timeoutMs + 1).state).toBe("stuck");
  });

  it("recovers from stuck when output progresses or the prompt returns", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);

    machine.observe("thinking", 1);
    expect(machine.observe("thinking", timeoutMs + 1).state).toBe("stuck");
    expect(machine.observe("new output", timeoutMs + 2).state).toBe("working");
    expect(machine.observe("new output\nREADY", timeoutMs + 3).state).toBe("working");
    expect(machine.observe("new output\nREADY", timeoutMs + 4).state).toBe("idle");
  });

  it("handles global ready regexes deterministically", () => {
    const machine = new PaneStateMachine(/READY/g, timeoutMs, 0);

    expect(machine.observe("READY", 1).state).toBe("idle");
    expect(machine.observe("READY", 2).state).toBe("idle");
  });

  it("marks working immediately from a control-mode output event", () => {
    const machine = new PaneStateMachine(/READY/, timeoutMs, 0);
    machine.observe("READY", 1);

    const moving = machine.recordOutput(50);

    expect(moving.state).toBe("working");
    expect(moving.unchangedForMs).toBe(0);
    expect(moving.observedAt).toBe(50);
  });
});

describe("PendingWorkTracker", () => {
  it("gates stuck notifications until an inbound arrives after idle", () => {
    const pending = new PendingWorkTracker(100);
    expect(pending.hasPendingWork()).toBe(false);

    pending.recordInbound(200);
    expect(pending.hasPendingWork()).toBe(true);

    pending.recordIdle(300);
    expect(pending.hasPendingWork()).toBe(false);
  });

  it("preserves ordering when inbound and idle timestamps share a millisecond", () => {
    const pending = new PendingWorkTracker(100);
    pending.recordInbound(100);
    expect(pending.hasPendingWork()).toBe(true);
  });

  it("does not let a stale async idle observation clear a newer inbound", () => {
    const pending = new PendingWorkTracker(100);
    pending.recordInbound(300);
    pending.recordIdle(200);
    expect(pending.hasPendingWork()).toBe(true);
  });
});

describe("Daemon event-driven pane monitor", () => {
  it("uses output events for working, debounce capture for idle, and a stuck deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-pane-events-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const control = new EventEmitter();
    let pane = "READY";
    const tmux = { getWindowId: () => "@1", capturePane: vi.fn(async () => pane) };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("event-test", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: true, timeout_minutes: 0.001, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /READY/ } as any, control as any,
      { child: () => logger } as any);
    (daemon as any).tmux = tmux;

    try {
      (daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      expect(daemon.getInstanceState()).toBe("idle");
      expect(control.listenerCount("output:@1")).toBe(1);
      expect(tmux.capturePane).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tmux.capturePane).toHaveBeenCalledOnce();

      pane = "thinking";
      control.emit("output:@1", { paneId: "%1", windowId: "@1", at: Date.now() });
      expect(daemon.getInstanceState()).toBe("working");
      await vi.advanceTimersByTimeAsync(10);
      expect(daemon.getInstanceState()).toBe("working");
      await vi.advanceTimersByTimeAsync(50);
      expect(daemon.getInstanceState()).toBe("stuck");

      pane = "READY";
      control.emit("output:@1", { paneId: "%1", windowId: "@1", at: Date.now() });
      expect(daemon.getInstanceState()).toBe("working");
      await vi.advanceTimersByTimeAsync(10);
      expect(daemon.getInstanceState()).toBe("idle");

      for (let i = 0; i < 3; i++) {
        (daemon as any).stopInstanceStateMonitor();
        expect(control.listenerCount("output:@1")).toBe(0);
        (daemon as any).startInstanceStateMonitor();
        await vi.advanceTimersByTimeAsync(0);
        expect(control.listenerCount("output:@1")).toBe(1);
        expect(control.listenerCount("safety_sweep")).toBe(1);
      }

      (daemon as any).freezeRuntimeMonitors();
      expect(control.listenerCount("output:@1")).toBe(0);
      expect(control.listenerCount("safety_sweep")).toBe(0);
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("refreshes the pane before answering an authoritative state query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-pane-query-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const control = new EventEmitter();
    let pane = "thinking";
    const tmux = { getWindowId: () => "@1", capturePane: vi.fn(async () => pane) };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("query-test", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: true, timeout_minutes: 15, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /READY/ } as any, control as any,
      { child: () => logger } as any);
    (daemon as any).tmux = tmux;
    const send = vi.fn();
    (daemon as any).ipcServer = { send };

    try {
      (daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      expect(daemon.getInstanceState()).toBe("working");

      // No control-mode output arrives for this redraw, which is the startup
      // race behind #520. A cache-only query would still answer "working".
      pane = "READY";
      await (daemon as any).respondToInstanceStateQuery(
        { requestId: "reply-grace-1", refresh: true },
        {} as any,
      );

      expect(tmux.capturePane).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        type: "instance_state_response",
        requestId: "reply-grace-1",
        state: "idle",
      }));
    } finally {
      (daemon as any).stopInstanceStateMonitor();
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("Daemon process liveness", () => {
  it("detects a dead pane even when automatic restart is disabled", async () => {
    vi.useFakeTimers();
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-dead-pane-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("dead-test", {
      working_directory: "/tmp",
      restart_policy: {
        max_retries: 0,
        backoff: "linear",
        reset_after: 0,
        health_check_interval_ms: 25,
      },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    } as any, instanceDir, false, { binaryName: "test" } as any, undefined,
      { child: () => logger } as any);
    const tmux = {
      getPaneStatus: vi.fn(async () => ({ alive: false, exitCode: 137 })),
      capturePaneWithHistory: vi.fn(async () => "old output\nREADY"),
      killWindow: vi.fn(async () => {}),
    };
    (daemon as any).tmux = tmux;
    (daemon as any).stopInstanceStateMonitor = vi.fn();
    const processState = vi.fn();
    daemon.on("instance_process_state", processState);

    try {
      (daemon as any).startHealthCheck();
      await vi.advanceTimersByTimeAsync(25);

      expect(processState).toHaveBeenCalledWith({ name: "dead-test", status: "crashed" });
      expect((daemon as any).stopInstanceStateMonitor).toHaveBeenCalledOnce();
      expect((daemon as any).healthCheckPaused).toBe(true);
      expect(tmux.killWindow).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("Daemon stuck notification gate", () => {
  it("suppresses idle false positives and emits only with pending inbound", () => {
    const testLogger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };
    const daemon = new Daemon("gate-test", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    }, "/tmp/gate-test", false, { binaryName: "test" } as any, undefined,
      { child: () => testLogger } as any);
    const detector = new HangDetector(15);
    const hang = vi.fn();
    detector.on("hang", hang);
    (daemon as any).hangDetector = detector;
    const snapshot = {
      state: "stuck", unchangedForMs: 15 * 60_000, observedAt: 1_000, stateChangedAt: 1_000,
    };

    (daemon as any).handleStuckTransition("stable but unknown prompt", snapshot, /READY/);
    expect(hang).not.toHaveBeenCalled();
    expect(testLogger.debug).toHaveBeenCalledWith(expect.objectContaining({
      backend: "test",
      paneTail: ["stable but unknown prompt"],
      readyPattern: "/READY/",
      readyMatched: false,
      unchangedForMs: 15 * 60_000,
      pendingWork: false,
    }), "Suppressing stuck notification without pending work");

    (daemon as any).pendingWork.recordInbound(2_000);
    (daemon as any).handleStuckTransition("stable generation", snapshot, /READY/);
    expect(hang).toHaveBeenCalledOnce();
    expect(hang).toHaveBeenCalledWith({ unchangedForMs: 15 * 60_000 });
    expect(testLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      paneTail: ["stable generation"], pendingWork: true,
    }), "Instance pane stuck with pending work");
  });
});

describe("sanitizePaneTail", () => {
  it("keeps five diagnostic lines while redacting credentials", () => {
    const pane = [
      "discarded",
      "token=super-secret-value",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "normal prompt >",
      "Context 16% used",
      "",
      "",
    ].join("\n");

    const tail = sanitizePaneTail(pane);
    expect(tail).toHaveLength(5);
    expect(tail.join("\n")).not.toContain("super-secret-value");
    expect(tail.join("\n")).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(tail).toContain("normal prompt >");
  });
});

describe("background-session recovery keeps the health loop alive", () => {
  // The recovery path's `return` used to skip both scheduleNext() and
  // healthCheckPaused — the one exit that did neither. A recovered instance
  // then ran unmonitored (while isHealthCheckEffectivelyPaused still reported
  // monitoring as active) until the next pause→wake cycle or fleet restart.
  function makeRecoveryDaemon(maxRetries: number) {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-bg-recovery-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("bg-recovery-test", {
      working_directory: "/tmp",
      restart_policy: {
        max_retries: maxRetries,
        backoff: "linear",
        reset_after: 0,
        health_check_interval_ms: 25,
      },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    } as any, instanceDir, false, { binaryName: "claude" } as any, undefined,
      { child: () => logger } as any);
    const tmux = {
      getPaneStatus: vi.fn(async () => ({ alive: false, exitCode: 1 })),
      capturePaneWithHistory: vi.fn(async () =>
        "Error: Session is currently running as a background agent"),
      killWindow: vi.fn(async () => {}),
    };
    (daemon as any).tmux = tmux;
    (daemon as any).stopInstanceStateMonitor = vi.fn();
    // setProcessStatus("running") starts the real pane-state monitor, which
    // needs a full backend + control client; not what these tests exercise.
    (daemon as any).startInstanceStateMonitor = vi.fn();
    return { daemon, instanceDir };
  }

  it("re-arms the next tick after a successful recovery", async () => {
    vi.useFakeTimers();
    const { daemon, instanceDir } = makeRecoveryDaemon(3);
    const spawn = vi.fn(async () => {});
    (daemon as any).spawnClaudeWindow = spawn;
    const respawned = vi.fn();
    daemon.on("crash_respawn", respawned);

    try {
      (daemon as any).startHealthCheck();
      await vi.advanceTimersByTimeAsync(25);     // tick 1 fires
      await vi.advanceTimersByTimeAsync(2_000);  // recovery's internal settle sleep

      expect(spawn).toHaveBeenCalledOnce();
      expect(respawned).toHaveBeenCalledOnce();
      // The loop must stay alive to watch the NEW window...
      expect((daemon as any).healthCheckTimer).not.toBeNull();
      // ...and this is monitoring-continues, not the deliberate-stop pattern.
      expect((daemon as any).healthCheckPaused).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("falls through to normal crash handling on the tick after a failed recovery", async () => {
    vi.useFakeTimers();
    const { daemon, instanceDir } = makeRecoveryDaemon(0);
    (daemon as any).spawnClaudeWindow = vi.fn(async () => { throw new Error("spawn failed"); });
    const supervisionEnded = vi.fn();
    daemon.on("supervision_ended", supervisionEnded);

    try {
      (daemon as any).startHealthCheck();
      await vi.advanceTimersByTimeAsync(25);     // tick 1: recovery attempt fails
      await vi.advanceTimersByTimeAsync(2_000);  // settle sleep inside the attempt
      expect((daemon as any).healthCheckTimer).not.toBeNull(); // loop survived the failure

      await vi.advanceTimersByTimeAsync(25);     // tick 2: attempted-flag set → normal crash path
      // max_retries 0 → the normal path deliberately stops AND says so — the
      // failed recovery ends in a supervised stop, not a silent zombie.
      expect((daemon as any).healthCheckPaused).toBe(true);
      expect(supervisionEnded).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("tool_progress opt-in gate", () => {
  function makeGateDaemon(toolProgress?: string) {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-tp-gate-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("tp-gate", {
      working_directory: "/tmp",
      ...(toolProgress ? { tool_progress: toolProgress } : {}),
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    } as any, instanceDir, false, { binaryName: "claude" } as any, undefined,
      { child: () => logger } as any);
    return { daemon, instanceDir, logger };
  }

  it.each([
    [undefined, "off"],
    ["standard", "standard"],
    ["verbose", "verbose"],
    ["garbage", "off"], // junk config values fail closed too
  ])("config %s → effective level %s", (configured, effective) => {
    const { daemon, instanceDir } = makeGateDaemon(configured as string | undefined);
    try {
      expect((daemon as any).toolProgressLevel()).toBe(effective);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("off means recordToolProgress accumulates nothing", () => {
    const { daemon, instanceDir } = makeGateDaemon(undefined);
    try {
      (daemon as any).recordToolProgress("Bash", { command: "npm test" });
      expect((daemon as any).turnProgress.isEmpty()).toBe(true);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("standard (explicit) accumulates", () => {
    const { daemon, instanceDir } = makeGateDaemon("standard");
    try {
      (daemon as any).recordToolProgress("Bash", { command: "npm test" });
      expect((daemon as any).turnProgress.isEmpty()).toBe(false);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("hot-updates the production daemon gate and clears progress across levels", () => {
    const { daemon, instanceDir } = makeGateDaemon("verbose");
    try {
      (daemon as any).recordToolProgress("Bash", { command: "printf secret-preview" });
      expect((daemon as any).turnProgress.isEmpty()).toBe(false);

      daemon.updateToolProgress("standard");
      expect((daemon as any).toolProgressLevel()).toBe("standard");
      expect((daemon as any).turnProgress.isEmpty()).toBe(true);

      daemon.updateToolProgress("off");
      (daemon as any).recordToolProgress("Bash", { command: "npm test" });
      expect((daemon as any).turnProgress.isEmpty()).toBe(true);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("applies only whitelisted config_update fields and reconfigures live controllers", () => {
    const { daemon, instanceDir, logger } = makeGateDaemon("off");
    try {
      daemon.applyConfigUpdate({
        tool_progress: "verbose",
        mcp_proxy_reply: true,
        auto_pause_after: 4,
        warm_cap: 7,
        display_name: "Sentinel",
        description: "runtime hot",
        tags: ["one", "two"],
        log_level: "debug",
        backend: "kiro-cli", // cold/unlisted: must not be accepted over IPC
      });

      const snapshot = daemon.getConfigSnapshot();
      expect(snapshot).toMatchObject({
        tool_progress: "verbose",
        mcp_proxy_reply: true,
        auto_pause_after: 4,
        warm_cap: 7,
        display_name: "Sentinel",
        description: "runtime hot",
        tags: ["one", "two"],
        log_level: "debug",
      });
      expect(snapshot.backend).toBeUndefined();
      expect((daemon as any).autoPauseController.thresholdMs).toBe(4 * 60_000);
      expect(logger.level).toBe("debug");

      (daemon as any).autoPauseController.lastActivityAt = 123;
      daemon.applyConfigUpdate({ auto_pause_after: 4 });
      expect((daemon as any).autoPauseController.lastActivityAt).toBe(123);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
