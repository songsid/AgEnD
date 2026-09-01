import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

describe("fleet delivery during a tmux storm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  function manager() {
    const fm = new FleetManager("/tmp/agend-storm-delivery-test");
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);
    (fm as any).instanceStateCache.set("worker", {
      state: "idle", observedAt: Date.now(), receivedAt: Date.now(),
    });
    (fm as any).sendWhenConnected = vi.fn(async () => {});
    return fm;
  }

  it("does not force or send until recovery is complete", async () => {
    const fm = manager();
    fm.stormWindow.recordServerDead("worker", ["worker"]);
    const delivery = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0);
    await vi.advanceTimersByTimeAsync(5);
    expect((fm as any).sendWhenConnected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fm.stormWindow.snapshot().phase).toBe("recovering");
    expect((fm as any).sendWhenConnected).not.toHaveBeenCalled();
    fm.stormWindow.markRecovered("worker");
    await delivery;
    expect((fm as any).sendWhenConnected).toHaveBeenCalledTimes(1);
    fm.stormWindow.shutdown();
  });

  it("preserves cancel epochs while a delivery is held", async () => {
    const fm = manager();
    fm.stormWindow.recordServerDead("worker", ["worker"]);
    const delivery = (fm as any).deliverWithIdleGate("worker", { type: "fleet_inbound" }, 5, 0);
    await vi.advanceTimersByTimeAsync(5);
    (fm as any).deliveryEpochs.set("worker", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    fm.stormWindow.markRecovered("worker");
    await delivery;
    expect((fm as any).sendWhenConnected).not.toHaveBeenCalled();
    fm.stormWindow.shutdown();
  });

  it("routes the fleet summary through the no-General fallback", async () => {
    const fm = manager();
    const notify = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
    fm.stormWindow.recordServerDead("worker", ["worker"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("tmux"));
    fm.stormWindow.shutdown();
  });
});
