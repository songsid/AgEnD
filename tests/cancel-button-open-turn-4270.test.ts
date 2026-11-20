import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * #4270: the processing bubble was retired by a 2 s idle mid-turn (a pause between tool calls) and never re-shown when
 * the same turn went back to working. While the daemon's turn is open, the idle grace re-arms instead of retiring; the
 * turn's close, or the 5-minute idle backstop for a turn that never closes, still retires it.
 */

type Turn = { generation: number; cancelled: boolean; completionDelivered: boolean } | null;
type Internals = {
  getInstanceStatus(name: string): string;
  instanceStateCache: Map<string, { state: string }>;
  lifecycle: { isPaused(name: string): boolean; daemons: Map<string, unknown> };
  cancelButtons: Map<string, Record<string, unknown>>;
  cancelButtonIdleRetireTimers: Map<string, unknown>;
  cacheInstanceExecutionState(name: string, msg: Record<string, unknown>): void;
  retireInstanceButtons(name: string): void;
  sendCancelButton(name: string): Promise<void>;
  startProgressTicker(entry: unknown): void;
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-open-turn-4270-"));
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const internals = fm as unknown as Internals;
  internals.lifecycle.isPaused = () => false;
  internals.getInstanceStatus = () => "running";
  // The daemon's turn, as getWorkingStateObservation reports it (turnReplyGuard.snapshot()).
  const daemon = { turn: null as Turn, getWorkingStateObservation() { return { turn: this.turn }; } };
  internals.lifecycle.daemons.set("alpha", daemon);
  return { fm, internals, daemon };
}

const OPEN: Turn = { generation: 1, cancelled: false, completionDelivered: false };

describe("#4270 processing bubble across a mid-turn idle", () => {
  it("survives the reported journal: execution → turn_started → idle +2 s → working +6 s → completion → turn_closed", () => {
    vi.useFakeTimers();
    try {
      const { internals, daemon } = makeFleet();
      const retire = vi.fn();
      internals.retireInstanceButtons = retire;
      internals.cancelButtons.set("m1", { instanceName: "alpha", messageId: "m1" });

      internals.cacheInstanceExecutionState("alpha", { state: "working" });   // 15:38:56 execution
      daemon.turn = { ...OPEN };                                               // 15:38:56 turn_started
      vi.advanceTimersByTime(2_000);
      internals.cacheInstanceExecutionState("alpha", { state: "idle" });      // 15:38:58 idle (execution)
      vi.advanceTimersByTime(4_000);                                           // idle for 4 s, past the 2 s grace
      expect(retire).not.toHaveBeenCalled();
      internals.cacheInstanceExecutionState("alpha", { state: "working" });   // 15:39:02 back to working
      vi.advanceTimersByTime(25_000);
      daemon.turn = { ...OPEN, completionDelivered: true };                   // 15:39:27 completion_delivered
      vi.advanceTimersByTime(6_000);
      daemon.turn = null;                                                      // 15:39:33 turn_closed
      internals.cacheInstanceExecutionState("alpha", { state: "idle" });
      expect(retire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);

      expect(retire).toHaveBeenCalledOnce();
      expect(retire).toHaveBeenCalledWith("alpha");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires once the turn closes while it is idle, and when the reply was already delivered", () => {
    vi.useFakeTimers();
    try {
      const { internals, daemon } = makeFleet();
      const retire = vi.fn();
      internals.retireInstanceButtons = retire;
      internals.cancelButtons.set("m1", { instanceName: "alpha", messageId: "m1" });
      internals.instanceStateCache.set("alpha", { state: "working" });

      daemon.turn = { ...OPEN };
      internals.cacheInstanceExecutionState("alpha", { state: "idle" });
      vi.advanceTimersByTime(10_000);
      expect(retire).not.toHaveBeenCalled();
      daemon.turn = null;                                                      // turn_closed while still idle
      vi.advanceTimersByTime(2_000);
      expect(retire).toHaveBeenCalledOnce();

      retire.mockClear();
      internals.cacheInstanceExecutionState("alpha", { state: "working" });
      daemon.turn = { ...OPEN, completionDelivered: true };                   // answered, turn not yet closed
      internals.cacheInstanceExecutionState("alpha", { state: "idle" });
      vi.advanceTimersByTime(2_000);
      expect(retire).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cancelled turn retires after the normal grace", () => {
    vi.useFakeTimers();
    try {
      const { internals, daemon } = makeFleet();
      const retire = vi.fn();
      internals.retireInstanceButtons = retire;
      internals.cancelButtons.set("m1", { instanceName: "alpha", messageId: "m1" });
      internals.instanceStateCache.set("alpha", { state: "working" });

      daemon.turn = { ...OPEN, cancelled: true };
      internals.cacheInstanceExecutionState("alpha", { state: "idle" });
      vi.advanceTimersByTime(2_000);
      expect(retire).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a turn that stays open and idle is still retired by the 5-minute backstop, and the grace stops re-arming", async () => {
    vi.useFakeTimers();
    try {
      const { fm, internals, daemon } = makeFleet();
      const deleteMessage = vi.fn().mockResolvedValue(undefined);
      (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
        defaults: {}, channel: { type: "discord", group_id: "g1" },
        instances: { alpha: { working_directory: "/tmp", topic_id: "123" } },
      };
      (fm as unknown as { adapter: unknown }).adapter = {
        notifyAlert: vi.fn().mockResolvedValue({ messageId: "stuck", chatId: "g1", threadId: "123" }), deleteMessage,
      };
      internals.startProgressTicker = vi.fn();
      internals.instanceStateCache.set("alpha", { state: "working" });

      await internals.sendCancelButton("alpha");
      daemon.turn = { ...OPEN };
      internals.cacheInstanceExecutionState("alpha", { state: "idle" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deleteMessage).not.toHaveBeenCalled();                            // the open turn holds it past the grace

      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await Promise.resolve(); await Promise.resolve();
      expect(deleteMessage).toHaveBeenCalledWith("g1", "stuck", "123");        // the backstop retires it
      expect(internals.cancelButtons.size).toBe(0);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(internals.cancelButtonIdleRetireTimers.size).toBe(0);             // no button left, so no re-arm
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
