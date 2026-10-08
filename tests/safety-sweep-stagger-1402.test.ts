/**
 * #1402: the shared control client's 60 s safety sweep ran every daemon's listener in one tick — each starts a
 * `tmux capture-pane` child process — so the fleet's event loop was blocked for the sum of them: 150–860 ms measured
 * live, 1–2.5 s on a busy host (#1235). The sweep now gives each listener a tick of its own, spread evenly over
 * CONTROL_SAFETY_SWEEP_SPREAD_MS, so the longest stretch is one listener's work.
 *
 * Nothing here starts a process or a tmux server: connect() is stubbed and child_process is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
  const forbidden = () => { throw new Error("real process forbidden"); };
  return { spawn: forbidden, execFile: forbidden, execFileSync: forbidden, spawnSync: forbidden, exec: forbidden, execSync: forbidden };
});

import { CONTROL_SAFETY_SWEEP_MS, CONTROL_SAFETY_SWEEP_SPREAD_MS, TmuxControlClient } from "../src/tmux-control.js";

let client: TmuxControlClient;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  client = new TmuxControlClient("agend");
  vi.spyOn(client as any, "connect").mockImplementation(() => {});
});
afterEach(() => { client.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** `n` listeners, each recording the (fake) time it ran at. */
function listeners(n: number) {
  const ranAt: number[][] = Array.from({ length: n }, () => []);
  const fns = ranAt.map(times => vi.fn(() => { times.push(Date.now()); }));
  for (const fn of fns) client.on("safety_sweep", fn);
  return { ranAt, fns };
}

describe("the safety sweep spreads its listeners (#1402)", () => {
  it("50 listeners: one each per sweep, each in its own tick, evenly spread over the spread window", () => {
    const { ranAt } = listeners(50);
    client.start();
    const sweepAt = Date.now() + CONTROL_SAFETY_SWEEP_MS;
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_MS + CONTROL_SAFETY_SWEEP_SPREAD_MS);

    expect(ranAt.map(times => times.length)).toEqual(Array(50).fill(1));
    const times = ranAt.map(([at]) => at! - sweepAt);
    // No two listeners share a tick: each ran at its own slot, i steps after the sweep.
    const step = CONTROL_SAFETY_SWEEP_SPREAD_MS / 50;
    times.forEach((t, i) => expect(t).toBeGreaterThanOrEqual(Math.floor(i * step)));
    times.forEach((t, i) => expect(t).toBeLessThan(Math.floor(i * step) + step));
    expect(Math.max(...times)).toBeLessThan(CONTROL_SAFETY_SWEEP_SPREAD_MS);
  });

  it("each listener's tick is its own: a slow listener's work is the longest stretch, not the sum", () => {
    // Synchronous work measured per macrotask: the listeners move a shared counter; a tick reads how much moved in it.
    let work = 0; const perTick: number[] = [];
    for (let i = 0; i < 50; i++) client.on("safety_sweep", () => { work += 20; });
    const probe = setInterval(() => { perTick.push(work); work = 0; }, 1);
    client.start();
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_MS + CONTROL_SAFETY_SWEEP_SPREAD_MS);
    clearInterval(probe);
    expect(perTick.reduce((a, b) => a + b, 0)).toBe(50 * 20);
    expect(Math.max(...perTick)).toBe(20);
  });

  it("every sweep runs each listener once, sweep after sweep", () => {
    const { ranAt } = listeners(7);
    client.start();
    vi.advanceTimersByTime(3 * CONTROL_SAFETY_SWEEP_MS + CONTROL_SAFETY_SWEEP_SPREAD_MS);
    expect(ranAt.map(times => times.length)).toEqual(Array(7).fill(3));
  });

  it("a listener removed before its slot (its daemon stopped) is skipped; the others still run", () => {
    const { fns } = listeners(4);
    client.start();
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_MS + 1);   // the sweep fired; the first slot ran
    client.removeListener("safety_sweep", fns[2]!);
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_SPREAD_MS);
    expect(fns.map(fn => fn.mock.calls.length)).toEqual([1, 1, 0, 1]);
  });

  it("a listener added mid-sweep waits for the next sweep", () => {
    listeners(4);
    client.start();
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_MS + 1);
    const late = vi.fn();
    client.on("safety_sweep", late);
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_SPREAD_MS);
    expect(late).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_MS);
    expect(late).toHaveBeenCalledOnce();
  });

  it("stop() mid-sweep drops the slots still pending, and leaves no timer behind", () => {
    const { fns } = listeners(4);
    client.start();
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_MS + 1);
    client.stop();
    vi.advanceTimersByTime(2 * CONTROL_SAFETY_SWEEP_MS);
    expect(fns.map(fn => fn.mock.calls.length)).toEqual([1, 0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stop and start mid-sweep: the old sweep's pending slots do not run on the restarted client", () => {
    const { fns } = listeners(4);
    client.start();
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_MS + 1);
    client.stop(); client.start();
    vi.advanceTimersByTime(CONTROL_SAFETY_SWEEP_SPREAD_MS);
    expect(fns.map(fn => fn.mock.calls.length)).toEqual([1, 0, 0, 0]);
  });
});
