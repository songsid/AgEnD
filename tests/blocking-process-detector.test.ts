import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockingProcessDetector, Daemon, PaneStateMachine } from "../src/daemon.js";
import { HangDetector } from "../src/hang-detector.js";

describe("BlockingProcessDetector (#531)", () => {
  it("notifies once when kubectl port-forward keeps a shell tool open", () => {
    const detector = new BlockingProcessDetector(60_000);
    const activity = "shell: kubectl port-forward svc/api 8080:80 &";

    expect(detector.observe("Forwarding from 127.0.0.1:8080 -> 80", activity, 1_000)).toBeNull();
    expect(detector.observe("Handling connection for 8080", activity, 60_999)).toBeNull();
    expect(detector.observe("Handling connection for 8080", activity, 61_000)).toMatchObject({
      activity,
      blockedForMs: 60_000,
    });
    expect(detector.observe("Handling connection for 8080", activity, 120_000)).toBeNull();
  });

  it("does not reset its deadline when server/access output keeps moving", () => {
    const detector = new BlockingProcessDetector(30_000);
    const activity = "Bash: npm run dev";

    detector.observe("Server is running at http://localhost:3000", activity, 10_000);
    // The original marker has scrolled out; the same foreground tool plus new
    // output must not evade detection forever.
    expect(detector.observe("GET /health 200", activity, 25_000)).toBeNull();
    expect(detector.observe("GET /api/items 200", activity, 40_000)).toMatchObject({
      evidence: "Server is running at http://localhost:3000",
      blockedForMs: 30_000,
    });
  });

  it("resets when the tool completes and rejects prose without an active shell", () => {
    const detector = new BlockingProcessDetector(1_000);
    const pane = "The documentation says: Server is running at http://localhost:3000";

    detector.observe(pane, "shell: npm run dev", 1_000);
    expect(detector.observe(pane, null, 5_000)).toBeNull();
    expect(detector.observe(pane, "Read: docs.md", 10_000)).toBeNull();
  });

  it("lets a backend-active foreground tool veto a persistent ready footer", () => {
    const machine = new PaneStateMachine(/64% λ !>/, 60_000, 0);
    const pane = "(using tool: shell)\nForwarding from 127.0.0.1:8080 -> 80\n64% λ !>";

    expect(machine.observe(pane, 1, { settled: true, forceBusy: true }).state).toBe("working");
    expect(machine.observe(pane, 60_001, { settled: true, forceBusy: true }).state).toBe("stuck");
    expect(machine.observe("- Completed in 60s\n64% λ !>", 60_002, { settled: false }).state).toBe("working");
    expect(machine.observe("- Completed in 60s\n64% λ !>", 60_003, { settled: true }).state).toBe("idle");
  });

  it("wires the production error-monitor scan to one hang notification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-blocked-process-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const backend = {
      binaryName: "kiro-cli",
      getReadyPattern: () => /64% λ !>/,
      getErrorPatterns: () => [],
      getRuntimeDialogs: () => [],
      getPaneActivity: () => "shell: kubectl port-forward svc/api 8080:80 &",
    };
    const daemon = new Daemon("blocked", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: true, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, backend as any, undefined, { child: () => logger } as any);
    const hangDetector = new HangDetector();
    const hang = vi.fn();
    hangDetector.on("hang", hang);
    (daemon as any).hangDetector = hangDetector;
    (daemon as any).tmux = {
      isWindowAlive: vi.fn(async () => true),
      capturePane: vi.fn(async () => "Forwarding from 127.0.0.1:8080 -> 80\n64% λ !>"),
    };
    (daemon as any).pendingWork.recordInbound(1);

    try {
      (daemon as any).startErrorMonitor();
      // First 5s scan arms the 2-minute clock; the 125s scan fires it.
      await vi.advanceTimersByTimeAsync(125_000);
      expect(hang).toHaveBeenCalledTimes(1);
      expect(hang).toHaveBeenCalledWith({ unchangedForMs: 120_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hang).toHaveBeenCalledTimes(1);
    } finally {
      (daemon as any).freezeRuntimeMonitors();
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
