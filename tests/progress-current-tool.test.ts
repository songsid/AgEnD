import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";

/**
 * The cancel button doubles as the live progress line (#409/#412). Elapsed time
 * alone answers "is it alive?" but not "is it doing anything useful?" — so when a
 * backend can say what tool is running, the line says so too.
 *
 * Best-effort on purpose: only backends with a transcript feed report anything,
 * and nothing decides anything from it. A backend that reports nothing keeps the
 * exact line it had before.
 */

describe("progressText with an activity detail", () => {
  it("is unchanged when the backend reports no activity", () => {
    expect(FleetManager.progressText(332_000)).toBe("⏳ 處理中… (已進行 5m 32s)");
    expect(FleetManager.progressText(332_000, null)).toBe("⏳ 處理中… (已進行 5m 32s)");
    expect(FleetManager.progressText(332_000, "   ")).toBe("⏳ 處理中… (已進行 5m 32s)");
  });

  it("appends the running tool when there is one", () => {
    expect(FleetManager.progressText(332_000, "$ npm test"))
      .toBe("⏳ 處理中… (已進行 5m 32s · $ npm test)");
  });

  it("stays quiet below the elapsed threshold", () => {
    // The short form exists so a normal quick answer looks exactly as it did
    // before. A tool detail must not turn it into a noisy line.
    expect(FleetManager.progressText(10_000, "$ npm test")).toBe("👀 處理中…");
  });

  it("flattens and caps agent-controlled text", () => {
    const long = FleetManager.progressText(332_000, `$ ${"x".repeat(200)}`);
    expect(long.length).toBeLessThan(90);
    expect(long).toContain("…)");

    // Tool inputs are file paths and shell commands: they can contain newlines,
    // which would break a one-line status into several.
    expect(FleetManager.progressText(332_000, "Read a\nb")).toBe("⏳ 處理中… (已進行 5m 32s · Read a b)");
  });

  it("defuses Discord mass mentions", () => {
    // Discord renders message content; a path or command containing @everyone
    // would otherwise ping the server from a status line.
    const text = FleetManager.progressText(332_000, "Read /tmp/@everyone.md");
    expect(text).not.toMatch(/@everyone/);
    expect(text).toContain("everyone");
  });
});

describe("daemon publishes what it is running", () => {
  function makeDaemon() {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-activity-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("act", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /❯/ } as any, undefined,
      { child: () => logger } as any);
    const broadcast = vi.fn();
    (daemon as any).ipcServer = { broadcast };
    return { daemon, broadcast, instanceDir };
  }

  it("broadcasts a tool summary and clears it again", () => {
    const { daemon, broadcast, instanceDir } = makeDaemon();
    try {
      (daemon as any).publishActivity("$ npm test");
      (daemon as any).publishActivity(null);

      expect(broadcast.mock.calls.map(c => c[0])).toEqual([
        { type: "instance_activity", instanceName: "act", activity: "$ npm test" },
        { type: "instance_activity", instanceName: "act", activity: null },
      ]);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("drops repeats so the ticker's skip-if-unchanged check still works", () => {
    const { daemon, broadcast, instanceDir } = makeDaemon();
    try {
      (daemon as any).publishActivity("Read a.ts");
      (daemon as any).publishActivity("Read a.ts");
      (daemon as any).publishActivity("Read a.ts");
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("clears activity when the turn ends, not only on a matching tool_result", () => {
    // A transcript can end on a tool_use with no tool_result — interrupted,
    // cancelled, crashed. Without the idle edge the last tool would stay pinned
    // to the progress line for the rest of the session.
    const { daemon, broadcast, instanceDir } = makeDaemon();
    try {
      (daemon as any).publishActivity("$ sleep 999");
      broadcast.mockClear();

      (daemon as any).instanceState = "working";
      (daemon as any).applyInstanceStateSnapshot({
        state: "idle", unchangedForMs: 0, observedAt: 1, stateChangedAt: 1,
      });

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "instance_activity", activity: null }),
      );
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("fleet manager caches activity per instance", () => {
  it("stores a reported activity and forgets a cleared one", () => {
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-act-fm-")));
    const internals = fm as unknown as {
      cacheInstanceActivity(name: string, activity: string | null): void;
      instanceActivity: Map<string, string>;
    };

    internals.cacheInstanceActivity("alpha", "$ npm test");
    expect(internals.instanceActivity.get("alpha")).toBe("$ npm test");

    internals.cacheInstanceActivity("alpha", null);
    expect(internals.instanceActivity.has("alpha")).toBe(false);
  });
});
