import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginUpdateProgress,
  clearUpdateMarker,
  isUpdateInProgress,
  markUpdateInProgress,
  readUpdateProgress,
  setUpdateProgressStage,
  UPDATE_MARKER_MAX_AGE_MS,
} from "../src/update-marker.js";
import { InstanceLifecycle, type LifecycleContext, type IncidentEventSource } from "../src/instance-lifecycle.js";

/**
 * `agend update` is not an incident. It replaces the package on disk under the
 * running daemon (killing MCP servers), then restarts the service (stopping
 * every instance) — and each of those used to arrive as a ⚠️ crash alert. The
 * cost is not just noise: an operator who learns to dismiss "MCP server 已終止"
 * during upgrades dismisses it when it means something too.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-update-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("update marker", () => {
  it("is absent until an update starts, and gone once cleared", () => {
    expect(isUpdateInProgress(dir)).toBe(false);
    markUpdateInProgress(dir);
    expect(isUpdateInProgress(dir)).toBe(true);
    clearUpdateMarker(dir);
    expect(isUpdateInProgress(dir)).toBe(false);
  });

  it("clearing a marker that was never written is not an error", () => {
    expect(() => clearUpdateMarker(dir)).not.toThrow();
  });

  it("expires, so an update that dies halfway cannot silence real crashes", () => {
    const started = 1_800_000_000_000;
    markUpdateInProgress(dir, started);
    expect(isUpdateInProgress(dir, started + UPDATE_MARKER_MAX_AGE_MS - 1)).toBe(true);
    expect(isUpdateInProgress(dir, started + UPDATE_MARKER_MAX_AGE_MS)).toBe(false);
    expect(isUpdateInProgress(dir, started + 24 * 3_600_000)).toBe(false);
  });

  it("ignores a marker from the future instead of trusting it forever", () => {
    // A clock correction backwards would otherwise leave a marker that never ages.
    markUpdateInProgress(dir, 2_000_000_000_000);
    expect(isUpdateInProgress(dir, 1_800_000_000_000)).toBe(false);
  });

  it("ignores a truncated or hand-edited marker", () => {
    writeFileSync(join(dir, "update-in-progress.json"), "{not json");
    expect(isUpdateInProgress(dir)).toBe(false);
    writeFileSync(join(dir, "update-in-progress.json"), JSON.stringify({ startedAt: "soon" }));
    expect(isUpdateInProgress(dir)).toBe(false);
  });

  it("does not throw when the data dir is unwritable", () => {
    // Losing the marker costs a few spurious alerts; it must not abort an upgrade.
    expect(() => markUpdateInProgress(join(dir, "does", "not", "exist"))).not.toThrow();
    expect(isUpdateInProgress(join(dir, "does", "not", "exist"))).toBe(false);
  });

  it("preserves the channel progress target when the CLI marks and advances the update", () => {
    beginUpdateProgress(dir, {
      adapterId: "discord-main",
      chatId: "guild-1",
      threadId: "general-topic",
      messageId: "progress-1",
    }, 1_800_000_000_000);

    markUpdateInProgress(dir, 1_800_000_000_999);
    expect(setUpdateProgressStage(dir, "downloading")).toBe(true);
    expect(setUpdateProgressStage(dir, "installed", { version: "2.1.4-beta.2" })).toBe(true);

    expect(readUpdateProgress(dir)).toMatchObject({
      startedAt: 1_800_000_000_000,
      progress: {
        stage: "installed",
        version: "2.1.4-beta.2",
        target: {
          adapterId: "discord-main",
          chatId: "guild-1",
          threadId: "general-topic",
          messageId: "progress-1",
        },
      },
    });
  });

  it("does not suppress real incidents after an update reaches a terminal failure", () => {
    beginUpdateProgress(dir, { adapterId: "telegram", chatId: "1", messageId: "2" });
    setUpdateProgressStage(dir, "downloading");
    setUpdateProgressStage(dir, "failed", { error: "npm registry unavailable" });

    expect(readUpdateProgress(dir)?.progress).toMatchObject({
      stage: "failed",
      failedStage: "downloading",
      error: "npm registry unavailable",
    });
    expect(isUpdateInProgress(dir)).toBe(false);
  });
});

// ── the gate itself ──────────────────────────────────────────────────────────

function makeLifecycle(planned: boolean) {
  const notified: Array<{ name: string; text: string }> = [];
  const logged: string[] = [];
  const ctx = {
    fleetConfig: { instances: {}, defaults: {} },
    logger: {
      info: (_o: unknown, msg?: string) => { if (msg) logged.push(msg); },
      warn: () => {}, error: () => {}, debug: () => {},
    },
    dataDir: "/tmp/unused",
    eventLog: { insert: vi.fn() },
    isPlannedRestart: () => planned,
    notifyInstanceTopic: (name: string, text: string) => { notified.push({ name, text }); },
    setTopicIcon: () => {},
    webhookEmit: () => {},
    clearCancelButton: () => {},
    checkModelFailover: () => {},
    restartSingleInstance: async () => {},
  } as unknown as LifecycleContext;

  const lifecycle = new InstanceLifecycle(ctx);
  const daemon = Object.assign(new EventEmitter(), {
    requestPauseWhenIdle: () => {},
  }) as unknown as IncidentEventSource & EventEmitter;
  lifecycle.attachIncidentHandlers("general", daemon);
  return { daemon, notified, logged, eventLog: (ctx as unknown as { eventLog: { insert: ReturnType<typeof vi.fn> } }).eventLog };
}

describe("incident alerts during a planned restart", () => {
  it("stay silent for the events an update actually produces", () => {
    const { daemon, notified } = makeLifecycle(true);
    daemon.emit("mcp_died", { name: "general", pid: 4242 });
    daemon.emit("crash_respawn", "general");
    expect(notified).toEqual([]);
  });

  it("are still recorded — the record is not the noise", () => {
    // daemon.log and the event log keep everything; only the chat message goes.
    const { daemon, logged, eventLog } = makeLifecycle(true);
    daemon.emit("mcp_died", { name: "general", pid: 4242 });
    expect(eventLog.insert).toHaveBeenCalledWith("general", "mcp_died", { pid: 4242 });
    expect(logged.some(m => m.includes("suppressed"))).toBe(true);
  });

  it("covers the whole incident family, not just the two that were reported", () => {
    const { daemon, notified } = makeLifecycle(true);
    daemon.emit("crash_loop", "general");
    daemon.emit("snapshot_failed", "general");
    daemon.emit("supervision_ended", { name: "general", reason: "pane gone", remedy: "restart it" });
    daemon.emit("health_check_error", { name: "general", message: "tmux timeout" });
    daemon.emit("pty_error", { name: "general", type: "crash", action: "none", message: "boom" });
    expect(notified).toEqual([]);
  });
});

describe("a real crash", () => {
  it("still notifies when no restart is planned", () => {
    const { daemon, notified } = makeLifecycle(false);
    daemon.emit("crash_respawn", "general");
    expect(notified).toHaveLength(1);
    expect(notified[0].name).toBe("general");
    expect(notified[0].text).toMatch(/崩潰|crashed/);
  });

  it("still reports a dead MCP server with the recovery instruction", () => {
    const { daemon, notified } = makeLifecycle(false);
    daemon.emit("mcp_died", { name: "general", pid: 4242 });
    expect(notified).toHaveLength(1);
    expect(notified[0].text).toContain("MCP server");
    expect(notified[0].text).toContain("restart_instance");
  });

  it("still reports the rest of the family", () => {
    const { daemon, notified } = makeLifecycle(false);
    daemon.emit("crash_loop", "general");
    daemon.emit("supervision_ended", { name: "general", reason: "pane gone", remedy: "restart it" });
    daemon.emit("health_check_error", { name: "general", message: "tmux timeout" });
    daemon.emit("pty_error", { name: "general", type: "crash", action: "none", message: "boom" });
    expect(notified).toHaveLength(4);
  });
});

describe("FleetManager.isPlannedRestart", () => {
  it("is false on a healthy fleet and true while an update marker is fresh", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir);
    expect(fm.isPlannedRestart()).toBe(false);
    markUpdateInProgress(dir);
    expect(fm.isPlannedRestart()).toBe(true);
    clearUpdateMarker(dir);
    expect(fm.isPlannedRestart()).toBe(false);
  });

  it("drops the marker once the new fleet has finished starting", async () => {
    // The update command exits long before the new fleet is up, so the fleet
    // itself has to end the quiet window — otherwise the first post-upgrade
    // crash goes unreported for the rest of the marker's lifetime.
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir);
    markUpdateInProgress(dir);
    (fm as unknown as { finishStartup(): void }).finishStartup();
    expect(isUpdateInProgress(dir)).toBe(false);
    expect(fm.isPlannedRestart()).toBe(false);
  });

  it("is true for the whole of a graceful stop, marker or not", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir);
    // `agend restart` / SIGTERM reaches this process directly: no marker exists,
    // but everything that dies from here on dies because we asked it to.
    const stopping = fm.stopAll();
    expect(fm.isPlannedRestart()).toBe(true);
    await stopping.catch(() => { /* nothing was started; the flag is the subject */ });
    expect(fm.isPlannedRestart()).toBe(true);
    expect(existsSync(join(dir, "update-in-progress.json"))).toBe(false);
  });
});
