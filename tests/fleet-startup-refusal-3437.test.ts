import { afterEach, describe, expect, it, vi } from "vitest";
import { BundledTmuxStartupError, guardMessage } from "../src/bundled-tmux-guard.js";
import { startFleetOrExit } from "../src/fleet-process-handlers.js";

afterEach(() => vi.useRealTimers());
describe("shared CLI startup refusal boundary (#3437)", () => {
  function rig(stopAll = vi.fn(async () => {})) {
    const error = new BundledTmuxStartupError({ socket: "owned-3437", confirmed: true });
    const manager = { startAll: vi.fn(async () => { throw error; }), stopAll };
    const runtime = { exit: vi.fn() as any }, output = { error: vi.fn() };
    return { error, manager, runtime, output, run: () => startFleetOrExit(manager, "unused", runtime, output) };
  }
  it("prints the remedy once, then cleans up before exiting non-zero", async () => {
    const r = rig(); await r.run();
    expect(r.output.error.mock.calls).toEqual([[guardMessage("owned-3437")]]);
    expect(r.manager.stopAll).toHaveBeenCalledOnce();
    expect(r.runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(r.manager.stopAll.mock.invocationCallOrder[0]).toBeLessThan(r.runtime.exit.mock.invocationCallOrder[0]!);
  });
  it("still exits when cleanup rejects", async () => {
    const r = rig(vi.fn(async () => { throw Error("synthetic cleanup failure"); }));
    await r.run(); expect(r.runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(r.output.error.mock.calls).toEqual([[r.error.message]]);
  });
  it("bounds a stuck cleanup without extending the existing ten-second deadline", async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const cleanupStarted = new Promise<void>(resolve => { entered = resolve; });
    const r = rig(vi.fn(() => { entered(); return new Promise<void>(() => {}); }));
    const pending = r.run();
    await cleanupStarted;
    expect(r.manager.stopAll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(r.runtime.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(r.runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not classify by text: unrelated errors still reject", async () => {
    const r = rig(), error = new Error(r.error.message);
    r.manager.startAll.mockImplementation(async () => { throw error; });
    await expect(r.run()).rejects.toBe(error);
    expect(r.output.error).not.toHaveBeenCalled(); expect(r.runtime.exit).not.toHaveBeenCalled();
    expect(r.manager.stopAll).not.toHaveBeenCalled();
  });
});
