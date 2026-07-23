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
