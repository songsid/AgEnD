import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, PaneStateMachine, PendingWorkTracker, sanitizePaneTail } from "../src/daemon.js";
import { HangDetector } from "../src/hang-detector.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { CodexBackend } from "../src/backend/codex.js";

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

  it("returns to idle on the exact Codex 0.154.0 turn-end frame", () => {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-codex-154-idle-"));
    try {
      const backend = new CodexBackend(instanceDir);
      const machine = new PaneStateMachine(backend.getReadyPattern(), timeoutMs, 0);
      const pane = [
        "• Finished the requested work.",
        "• .",
        "  Worked for 5m 21s",
        "› Ask Codex to do anything",
        "  Context 19% left",
      ].join("\n");

      expect(machine.recordOutput(1_000).state).toBe("working");
      expect(machine.observe(pane, 3_001, { settled: true, changeAt: 1_000 }).state).toBe("idle");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
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
  function makeCodexMonitor(initialPane: string) {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-codex-redraw-"));
    writeFileSync(join(instanceDir, "window-id"), "@codex");
    let lastOutputAt = 0;
    const control = Object.assign(new EventEmitter(), {
      isIdle: vi.fn(() => false),
      waitUntilIdle: vi.fn(async () => true),
      getLastOutputAt: vi.fn(() => lastOutputAt),
      getObservationResetAt: vi.fn(() => 0),
    });
    control.on("output:@codex", (event: { at: number }) => { lastOutputAt = event.at; });
    let pane = initialPane;
    const tmux = { getWindowId: () => "@codex", capturePane: vi.fn(async () => pane) };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("codex-redraw", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: true, timeout_minutes: 10, idle_debounce_ms: 2_000 },
      log_level: "silent",
    } as any, instanceDir, false, new CodexBackend(instanceDir), control as any,
      { child: () => logger } as any);
    (daemon as any).tmux = tmux;
    return {
      daemon,
      control,
      tmux,
      setPane: (next: string) => { pane = next; },
      close: () => {
        (daemon as any).stopInstanceStateMonitor();
        rmSync(instanceDir, { recursive: true, force: true });
      },
    };
  }

  const codexWorkingFrame = (seconds: number) => [
    `• Working (${seconds}s • esc to interrupt)`,
    "",
    "› Ask Codex to do anything",
    "  Context 19% left",
  ].join("\n");

  const codexAnimatedIdleFrame = (spinner: string) => [
    "• Finished the requested work.",
    `⋆       ${spinner}       ⋆`,
    "› ⋆ Ask Codex to do anything",
    "    ⋆",
    "⋆  Context 19% left  ⋆",
    "        ⋆",
  ].join("\n");

  const codexIdleFrame = [
    "• Finished the requested work.",
    "› Ask Codex to do anything",
    "  Context 19% left",
  ].join("\n");

  it("settles a continuously animating Codex 0.154 pane after two structural idle captures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.daemon.getInstanceState()).toBe("working");

      monitor.setPane(codexAnimatedIdleFrame("⋆"));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(500);
      expect(monitor.daemon.getInstanceState()).toBe("working");

      monitor.setPane(codexAnimatedIdleFrame(""));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(500);
      expect(monitor.daemon.getInstanceState()).toBe("idle");
      expect((monitor.daemon as any).isPaneIdleForDelivery("@codex")).toBe(true);
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  /**
   * The safety sweep fires for every daemon on a timer, and recordOutput sets
   * working unconditionally. Without a settled guard, a Codex that had gone
   * quiet was flipped to working by the next sweep — and could never come back,
   * because a quiet pane produces no further output to re-evaluate it.
   *
   * That is worse than the bug this branch fixes: it holds the Cancel button
   * open forever, disables auto-pause, and makes the hang detector report a
   * perfectly idle instance as stuck. Removing the `!settled` guard turns this
   * red.
   */
  it("keeps a quiet idle Codex idle across repeated safety sweeps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);

      // Reach idle the normal way: the starfield settles.
      monitor.setPane(codexAnimatedIdleFrame("⋆"));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(500);
      monitor.setPane(codexAnimatedIdleFrame(""));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(500);
      expect(monitor.daemon.getInstanceState()).toBe("idle");

      // Now nobody types and nothing paints. Each sweep must leave it idle:
      // there is no output event coming that could undo a wrong "working".
      for (let sweep = 1; sweep <= 3; sweep++) {
        await vi.advanceTimersByTimeAsync(2_100);   // past the idle debounce
        monitor.control.emit("safety_sweep", { at: Date.now() });
        await vi.advanceTimersByTimeAsync(50);
        expect(monitor.daemon.getInstanceState(), `after sweep ${sweep}`).toBe("idle");
        expect((monitor.daemon as any).isPaneIdleForDelivery("@codex"), `delivery gate after sweep ${sweep}`).toBe(true);
      }
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  /**
   * The same guard must not blind the sweep while output IS recent: a pane that
   * is genuinely repainting mid-turn still has to read as working.
   */
  it("still reports working when a safety sweep lands on a freshly repainting pane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);

      monitor.setPane(codexWorkingFrame(2));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(100);        // well inside the debounce
      monitor.control.emit("safety_sweep", { at: Date.now() });
      await vi.advanceTimersByTimeAsync(50);

      expect(monitor.daemon.getInstanceState()).toBe("working");
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it("does not turn an idle Astra starfield into working on a safety sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);

      monitor.setPane(codexAnimatedIdleFrame("⋆"));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(500);
      monitor.setPane(codexAnimatedIdleFrame(""));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(500);
      expect(monitor.daemon.getInstanceState()).toBe("idle");

      const edges = vi.fn();
      monitor.daemon.on("instance_state", edges);
      // A starfield frame arrives shortly before the fleet-wide sweep. The
      // capture is unsettled, but the pane is already idle and structurally
      // positive, so the sweep must not emit idle→working.
      monitor.setPane(codexAnimatedIdleFrame("⋆"));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(250);
      monitor.control.emit("safety_sweep");
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.daemon.getInstanceState()).toBe("idle");
      expect(edges).not.toHaveBeenCalled();
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  /**
   * R7 — a behaviour change worth naming, not just a bug fix.
   *
   * The new getBusyPattern makes the state machine call a live "• Working …
   * esc to interrupt" pane working. isPaneIdleForDelivery consults that verdict
   * for backends with a periodic redraw, so a message arriving mid-turn now
   * reads as busy — and a busy pane on a supportsQueuedInput backend is exactly
   * the condition that routes a delivery to Codex's NATIVE QUEUE (one complete
   * paste+Enter handed over, Codex owning the ordering) instead of the plain
   * idle path.
   *
   * Before this pattern existed, a mid-turn frame could be read as idle and
   * delivered down the plain path. The state-machine half is pinned by the
   * animation tests above; this pins the routing decision that follows from it.
   */
  it("reads a mid-turn Codex pane as busy, which is what routes delivery to the native queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.daemon.getInstanceState()).toBe("working");

      // The two conditions canHandOff requires. Both must hold for the message
      // to reach Codex's own queue rather than wait for an idle that a live
      // turn will not produce.
      expect((monitor.daemon as any).isPaneIdleForDelivery("@codex"),
        "a live Working banner is not a delivery-idle pane").toBe(false);
      expect(await (monitor.daemon as any).paneReadinessForDelivery("@codex")).toBe("busy");
      expect(new CodexBackend("/tmp").supportsQueuedInput?.()).toBe(true);

      // And once the turn ends and the starfield settles, the same pane stops
      // being busy — the handoff is for live turns only.
      monitor.setPane(codexAnimatedIdleFrame("⋆"));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(500);
      monitor.setPane(codexAnimatedIdleFrame(""));
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
      await vi.advanceTimersByTimeAsync(500);
      expect((monitor.daemon as any).isPaneIdleForDelivery("@codex")).toBe(true);
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it("does not mistake live Codex working animation for idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);

      for (const seconds of [2, 3, 4]) {
        monitor.setPane(codexWorkingFrame(seconds));
        monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
        await vi.advanceTimersByTimeAsync(500);
        expect(monitor.daemon.getInstanceState()).toBe("working");
      }
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it("keeps an unfamiliar no-footer Codex layout working during continuous redraw", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      const noFooter = (tick: number) => [
        `• redraw ${tick}`,
        "› Ask Codex to do anything",
      ].join("\n");
      for (let i = 0; i < 4; i++) {
        monitor.setPane(noFooter(i));
        monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
        await vi.advanceTimersByTimeAsync(500);
        expect(monitor.daemon.getInstanceState()).toBe("working");
      }
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it("does not let transcript quotes create or suppress Codex idle evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);

      const quoteOnly = [
        "• The pane text quoted by the user was:",
        "    • Working (1s • esc to interrupt)",
        "    › Ask Codex to do anything",
        "      Context 19% left",
      ].join("\n");
      for (let i = 0; i < 2; i++) {
        monitor.setPane(quoteOnly);
        monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(monitor.daemon.getInstanceState()).toBe("working");

      const quotedThenIdle = [
        "• The old status was:",
        "    • Working (1s • esc to interrupt)",
        "    › Ask Codex to do anything",
        "      Context 19% left",
        "› Ask Codex to do anything",
        "  Context 19% left",
      ].join("\n");
      for (let i = 0; i < 2; i++) {
        monitor.setPane(quotedThenIdle);
        monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(monitor.daemon.getInstanceState()).toBe("idle");
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it("keeps the ordinary quiet debounce path when Codex animations are disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      monitor.setPane(codexIdleFrame);
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(monitor.daemon.getInstanceState()).toBe("working");
      await vi.advanceTimersByTimeAsync(1);
      expect(monitor.daemon.getInstanceState()).toBe("idle");
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it.each([
    ["a draft in the composer", "› please also fix the flaky test in ci\n  (no context footer)"],
    ["a layout without a context footer", "• Finished the requested work.\n› Ask Codex to do anything"],
  ])("keeps the ordinary quiet debounce path for %s", async (_label, unknownIdlePane) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      monitor.setPane(unknownIdlePane);
      monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(monitor.daemon.getInstanceState()).toBe("working");
      await vi.advanceTimersByTimeAsync(1);
      expect(monitor.daemon.getInstanceState()).toBe("idle");
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it("rate-limits structural probes while a Codex turn streams output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const monitor = makeCodexMonitor(codexWorkingFrame(1));
    try {
      (monitor.daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      const initialCaptures = monitor.tmux.capturePane.mock.calls.length;

      for (let i = 0; i < 200; i++) {
        monitor.setPane(codexWorkingFrame(i));
        monitor.control.emit("output:@codex", { paneId: "%codex", windowId: "@codex", at: Date.now() });
        await vi.advanceTimersByTimeAsync(10);
      }

      const probes = monitor.tmux.capturePane.mock.calls.length - initialCaptures;
      expect(probes).toBeLessThanOrEqual(6);
      expect(monitor.daemon.getInstanceState()).toBe("working");
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it("keeps an idle Antigravity pane idle across identical status-line redraws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-agy-redraw-"));
    writeFileSync(join(instanceDir, "window-id"), "@agy");
    const control = new EventEmitter();
    let pane = "────────\n>\n────────\nContext 16% used";
    const tmux = { getWindowId: () => "@agy", capturePane: vi.fn(async () => pane) };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("agy-redraw", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: true, timeout_minutes: 10, idle_debounce_ms: 2_000 },
      log_level: "silent",
    } as any, instanceDir, false, new AntigravityBackend(instanceDir), control as any,
      { child: () => logger } as any);
    (daemon as any).tmux = tmux;

    try {
      (daemon as any).startInstanceStateMonitor();
      await vi.advanceTimersByTimeAsync(0);
      expect(daemon.getInstanceState()).toBe("idle");

      // Ten status-line executions repaint the same visible cells. Before #600
      // each raw %output forced working and the debounce capture forced idle:
      // twenty false edges from an otherwise idle pane.
      for (let i = 0; i < 10; i++) {
        control.emit("output:@agy", { paneId: "%agy", windowId: "@agy", at: Date.now() });
        await vi.advanceTimersByTimeAsync(25);
        expect(daemon.getInstanceState()).toBe("idle");
        await vi.advanceTimersByTimeAsync(2_975);
      }
      expect(logger.info.mock.calls.filter(call => call[1] === "Instance execution state changed")).toHaveLength(0);

      // A real screen change is still promoted to working by the short probe;
      // cosmetic filtering must not create a false-idle delivery window.
      pane = "✢ Thinking… 12s\n────────\n>\n────────\nContext 16% used";
      control.emit("output:@agy", { paneId: "%agy", windowId: "@agy", at: Date.now() });
      await vi.advanceTimersByTimeAsync(25);
      expect(daemon.getInstanceState()).toBe("working");
    } finally {
      (daemon as any).stopInstanceStateMonitor();
      rmSync(instanceDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

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
        reply_completion_guard: false,
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
        reply_completion_guard: false,
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
