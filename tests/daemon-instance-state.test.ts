import { describe, expect, it, vi } from "vitest";
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
