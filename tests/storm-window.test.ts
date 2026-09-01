import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StormWindow } from "../src/storm-window.js";

describe("StormWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("counts server liveness transitions, not per-daemon reports", async () => {
    const storm = new StormWindow();
    const opened = vi.fn();
    const extended = vi.fn();
    storm.on("opened", opened);
    storm.on("extended", extended);

    expect(storm.recordServerDead("a", ["a", "b", "c"])).toBe(true);
    expect(storm.recordServerDead("b", ["a", "b", "c"])).toBe(false);
    expect(storm.recordServerDead("c", ["a", "b", "c"])).toBe(false);
    expect(storm.snapshot()).toMatchObject({
      phase: "backing_off", generation: 1, crashCount: 1, backoffMs: 30_000,
      affected: ["a", "b", "c"],
    });
    expect(opened).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(storm.snapshot().phase).toBe("recovering");
    storm.observeServerAlive(101);
    expect(storm.recordServerDead("a", ["a", "b", "c"])).toBe(true);
    expect(storm.snapshot()).toMatchObject({ generation: 2, crashCount: 2, backoffMs: 120_000 });
    expect(extended).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    storm.observeServerAlive(101);
    storm.recordServerDead("b", ["a", "b", "c"]);
    expect(storm.snapshot()).toMatchObject({ generation: 3, crashCount: 3, backoffMs: 600_000 });
  });

  it("holds delivery through recovery, then closes after every affected instance is ready", async () => {
    const storm = new StormWindow({ backoffsMs: [10] });
    storm.recordServerDead("a", ["a", "b"]);
    let delivered = false;
    const waiting = storm.waitForDeliveryAllowed().then(() => { delivered = true; });

    await vi.advanceTimersByTimeAsync(10);
    expect(storm.snapshot().phase).toBe("recovering");
    expect(delivered).toBe(false);
    storm.markRecovered("a");
    expect(delivered).toBe(false);
    storm.markRecovered("b");
    await waiting;
    expect(delivered).toBe(true);
    expect(storm.snapshot().phase).toBe("closed");
  });

  it("treats a tmux server PID replacement as a new generation", async () => {
    const storm = new StormWindow({ backoffsMs: [10, 20, 30] });
    storm.recordServerDead("a", ["a"]);
    await vi.advanceTimersByTimeAsync(10);
    storm.observeServerAlive(101);
    storm.observeServerAlive(202);
    expect(storm.snapshot()).toMatchObject({ generation: 2, crashLevel: 2, backoffMs: 20 });
  });

  it("opens a storm when a PID replacement is the first observed evidence", () => {
    const storm = new StormWindow();
    expect(storm.observeServerAlive(101)).toBe(false);
    expect(storm.observeServerAlive(202)).toBe(true);
    expect(storm.snapshot()).toMatchObject({
      phase: "backing_off",
      generation: 1,
      crashLevel: 1,
      serverPid: 202,
    });
  });

  it("resets escalation only after ten stable minutes", async () => {
    const storm = new StormWindow();
    storm.recordServerDead("a", ["a"]);
    await vi.advanceTimersByTimeAsync(30_000);
    storm.observeServerAlive(101);
    storm.recordServerDead("a", ["a"]);
    expect(storm.snapshot().crashLevel).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(storm.snapshot().crashLevel).toBe(0);
    storm.observeServerAlive(101);
    storm.recordServerDead("a", ["a"]);
    expect(storm.snapshot().backoffMs).toBe(30_000);
  });

  it("releases waiters on shutdown without reopening delivery", async () => {
    const storm = new StormWindow();
    storm.recordServerDead("a", ["a"]);
    const spawn = storm.waitForSpawnAllowed();
    const delivery = storm.waitForDeliveryAllowed();
    storm.shutdown();
    await expect(Promise.all([spawn, delivery])).resolves.toEqual([undefined, undefined]);
    expect(storm.isStopped()).toBe(true);
  });

  it("suppresses only storm-family incident kinds", () => {
    const storm = new StormWindow();
    storm.recordServerDead("a", ["a"]);
    expect(storm.shouldSuppress("mcp_died")).toBe(true);
    expect(storm.shouldSuppress("health_check_error")).toBe(true);
    expect(storm.shouldSuppress("auth_error")).toBe(false);
    expect(storm.shouldSuppress("quota")).toBe(false);
    expect(storm.shouldSuppress("model_error")).toBe(false);
  });
});
