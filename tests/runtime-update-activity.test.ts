import { describe, expect, it } from "vitest";
import { RuntimeUpdateActivity } from "../src/runtime-update-activity.js";

describe("Runtime update admission and physical-work accounting", () => {
  it("counts work before calling it and retains it through physical promise completion", async () => {
    const activity = new RuntimeUpdateActivity(); let finish!: () => void;
    const held = activity.run(() => {
      expect(activity.pending).toBe(1);
      expect(activity.tryFence("attempt", () => true, () => true)).toBeUndefined();
      return new Promise<void>(resolve => { finish = resolve; });
    });
    expect(activity.pending).toBe(1);
    expect(activity.tryFence("attempt", () => true, () => true)).toBeUndefined();
    finish(); await held;
    expect(activity.pending).toBe(0);
    expect(activity.tryFence("attempt", () => true, () => true)?.current()).toBe(true);
  });
  it("releases counts after rejection and never treats an untracked physical reservation as idle", async () => {
    const activity = new RuntimeUpdateActivity();
    await expect(activity.run(() => { throw Error("owned failure"); })).rejects.toThrow("owned failure");
    expect(activity.pending).toBe(0);
    expect(activity.tryFence("attempt", () => true, () => false)).toBeUndefined();
    expect(activity.accepting).toBe(true);
  });
  it("closes admission before the idle callback, including synchronous reentrancy", () => {
    const activity = new RuntimeUpdateActivity();
    const fence = activity.tryFence("attempt", () => true, () => {
      expect(activity.accepting).toBe(false);
      expect(() => activity.enter()).toThrow(/holding new work/);
      return true;
    });
    expect(fence?.current()).toBe(true);
    expect(() => activity.enter()).toThrow(/holding new work/);
    fence!.release(); expect(activity.accepting).toBe(true);
  });
  it("an old cancellation cannot release a newer attempt", () => {
    const activity = new RuntimeUpdateActivity(), old = activity.tryFence("old", () => true, () => true)!;
    old.release();
    const next = activity.tryFence("next", () => true, () => true)!;
    old.release(); expect(old.current()).toBe(false); expect(next.current()).toBe(true); expect(activity.accepting).toBe(false);
    expect(() => old.commit()).toThrow(/no longer current/);
    next.release(); expect(activity.accepting).toBe(true);
  });
  it("rechecks generation and physical state at commit, then permanently closes new admission", () => {
    const activity = new RuntimeUpdateActivity(); let generation = 1, idle = true;
    const stale = activity.tryFence("stale", () => generation === 1, () => idle)!;
    generation = 2; expect(stale.current()).toBe(false); expect(() => stale.commit()).toThrow(/no longer current/);
    stale.release();
    const next = activity.tryFence("next", () => generation === 2, () => idle)!;
    idle = false; expect(() => next.commit()).toThrow(/no longer current/);
    idle = true; next.commit(); next.release();
    expect(next.current()).toBe(false); expect(activity.accepting).toBe(false);
    expect(() => activity.enter()).toThrow(/holding new work/);
  });
  it("holds admission after reentrant close and restores it after an idle-check error", () => {
    const closed = new RuntimeUpdateActivity();
    expect(closed.tryFence("attempt", () => true, () => { closed.close(); return true; })).toBeUndefined();
    expect(closed.accepting).toBe(false);
    const other = new RuntimeUpdateActivity();
    expect(() => other.tryFence("attempt", () => true, () => { throw Error("unknown inventory"); })).toThrow("unknown inventory");
    expect(other.accepting).toBe(true);
  });
  it("requires synchronous positive proofs instead of accepting a truthy thenable", () => {
    const activity = new RuntimeUpdateActivity(), asyncProof = (() => Promise.resolve(true)) as unknown as () => boolean;
    expect(activity.tryFence("async-idle", () => true, asyncProof)).toBeUndefined();
    expect(activity.tryFence("async-binding", asyncProof, () => true)).toBeUndefined();
    expect(activity.accepting).toBe(true);
  });
});
