import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * Four user-reported cancel-button failures, three of which shared one root:
 * `getInstanceIdle` read the control client's 2-second output-silence heuristic,
 * and long silent tools (a build, a test run) produce >2s lulls constantly
 * mid-turn. A lull at the wrong moment retired the button (5-min backstop),
 * froze its progress text (ticker skipped "idle" ticks), or made a reply retire
 * a button that was mid-workflow.
 */

type Internals = {
  getInstanceIdle(name: string): boolean;
  getInstanceStatus(name: string): string;
  getInstanceExecutionState(name: string): string | null;
  instanceStateCache: Map<string, { state: string }>;
  lifecycle: { isPaused(name: string): boolean };
  cancelButtons: Map<string, Record<string, unknown>>;
  armReplyGrace(name: string): void;
  retireButton(entry: unknown): void;
  sendCancelButton(name: string): Promise<void>;
  getGroupIdForInstance(name: string): string;
  logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-cancel-fix-"));
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const internals = fm as unknown as Internals;
  internals.lifecycle.isPaused = () => false;
  // These tests model a LIVE daemon (there is no daemon.pid in a tmp dir, and
  // the safety net treats a non-running daemon as idle — correctly, but that is
  // cancel-button-safety-net.test.ts's subject, not this file's).
  internals.getInstanceStatus = () => "running";
  return { fm, internals };
}

describe("issue 4 — idleness comes from the pane state machine, not output lulls", () => {
  it("a working instance is not idle, whatever the raw silence heuristic says", () => {
    const { internals } = makeFleet();
    // The daemon has reported "working"; there is no control client in this test,
    // so the old implementation would have fallen through to "assume idle" — the
    // exact misreading that let the 5-minute backstop retire mid-work buttons.
    internals.instanceStateCache.set("alpha", { state: "working" });
    expect(internals.getInstanceIdle("alpha")).toBe(false);

    internals.instanceStateCache.set("alpha", { state: "stuck" });
    expect(internals.getInstanceIdle("alpha")).toBe(false);
  });

  it("a reported-idle instance is idle", () => {
    const { internals } = makeFleet();
    internals.instanceStateCache.set("alpha", { state: "idle" });
    expect(internals.getInstanceIdle("alpha")).toBe(true);
  });

  it("falls back to the old heuristic only when no state was ever reported", () => {
    const { internals } = makeFleet();
    // No cache entry, no window-id file → the pre-existing optimistic answer.
    expect(internals.getInstanceIdle("alpha")).toBe(true);
  });
});

describe("issue 2 — reply grace", () => {
  it("keeps the button when work resumed within the grace, retires when it did not", () => {
    vi.useFakeTimers();
    try {
      const { internals } = makeFleet();
      const retire = vi.fn();
      internals.retireButton = retire;

      const entry = { instanceName: "alpha", messageId: "m1" } as Record<string, unknown>;
      internals.cancelButtons.set("m1", entry);

      // Reply lands while busy → grace armed. Work resumes → check is a no-op.
      internals.instanceStateCache.set("alpha", { state: "working" });
      internals.armReplyGrace("alpha");
      vi.advanceTimersByTime(2 * 60_000 + 1);
      expect(retire).not.toHaveBeenCalled();

      // Second reply; this time the turn actually ended.
      internals.armReplyGrace("alpha");
      internals.instanceStateCache.set("alpha", { state: "idle" });
      vi.advanceTimersByTime(2 * 60_000 + 1);
      expect(retire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arming replaces the timer — a burst of replies ends with one check", () => {
    vi.useFakeTimers();
    try {
      const { internals } = makeFleet();
      const retire = vi.fn();
      internals.retireButton = retire;
      const entry = { instanceName: "alpha", messageId: "m1" } as Record<string, unknown>;
      internals.cancelButtons.set("m1", entry);
      internals.instanceStateCache.set("alpha", { state: "idle" });

      internals.armReplyGrace("alpha");
      vi.advanceTimersByTime(60_000);
      internals.armReplyGrace("alpha"); // second reply resets the clock
      vi.advanceTimersByTime(90_000);   // 2.5min after first, 1.5min after second
      expect(retire).not.toHaveBeenCalled();

      vi.advanceTimersByTime(31_000);
      expect(retire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for a button that was already retired", () => {
    vi.useFakeTimers();
    try {
      const { internals } = makeFleet();
      const retire = vi.fn();
      internals.retireButton = retire;
      const entry = { instanceName: "alpha", messageId: "m1" } as Record<string, unknown>;
      internals.cancelButtons.set("m1", entry);
      internals.instanceStateCache.set("alpha", { state: "idle" });

      internals.armReplyGrace("alpha");
      internals.cancelButtons.delete("m1"); // idle edge got there first
      vi.advanceTimersByTime(2 * 60_000 + 1);
      expect(retire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("issue 3 — a button that cannot be addressed says so", () => {
  it("warns instead of returning silently when no chat id resolves", async () => {
    const { fm, internals } = makeFleet();
    // A fleet-topic instance with no group anywhere: worlds empty, primary
    // channel empty — the configuration shape that ate buttons silently.
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: {}, channel: undefined,
      instances: { alpha: { working_directory: "/tmp", topic_id: "123" } },
    };
    (fm as unknown as { adapter: unknown }).adapter = { notifyAlert: vi.fn() };
    const warn = vi.spyOn((fm as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, "warn");

    await internals.sendCancelButton("alpha");

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: "alpha" }),
      expect.stringContaining("Cannot address cancel button"),
    );
  });

  it("resolves the group through the world fallback when the binding is missing", async () => {
    const { fm, internals } = makeFleet();
    const notifyAlert = vi.fn().mockResolvedValue({ messageId: "m9", chatId: "g1", threadId: "123" });
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: {}, channel: undefined, // empty primary — the real fleet's shape
      instances: { alpha: { working_directory: "/tmp", topic_id: "123" } },
    };
    // One configured world; the instance has NO binding to it.
    (fm as unknown as { worlds: Map<string, unknown> }).worlds.set("discord", {
      id: "discord", adapter: { notifyAlert }, groupId: "g1", channelConfig: { group_id: "g1" },
    });
    (fm as unknown as { adapter: unknown }).adapter = { notifyAlert };

    await internals.sendCancelButton("alpha");

    // Before the fix: group resolved via the empty primary channel → undefined →
    // silent return, and this assertion fails.
    expect(notifyAlert).toHaveBeenCalledWith("g1", expect.objectContaining({ type: "cancel" }), { threadId: "123" });
  });
});
