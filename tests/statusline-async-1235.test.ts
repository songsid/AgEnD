import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ read: vi.fn(), sync: vi.fn(() => { throw new Error("sync read forbidden"); }) }));
vi.mock("node:fs/promises", () => ({ readFile: io.read }));
vi.mock("node:fs", () => ({ readFileSync: io.sync }));
import { StatuslineWatcher } from "../src/statusline-watcher.js";
let watcher: StatuslineWatcher;
let ctx: any;
const data = (cost: number, five: number, seven: number) => JSON.stringify({ cost: { total_cost_usd: cost }, rate_limits: { five_hour: { used_percentage: five }, seven_day: { used_percentage: seven } } });
beforeEach(() => {
  vi.useFakeTimers(); io.read.mockReset(); io.sync.mockClear();
  ctx = { getInstanceDir: (n: string) => `/private/${n}`, logger: { info: vi.fn() }, costGuard: { updateCost: vi.fn() }, notifyInstanceTopic: vi.fn(), checkModelFailover: vi.fn() };
  watcher = new StatuslineWatcher(ctx);
});
afterEach(() => { watcher.stopAll(); vi.useRealTimers(); expect(io.sync).not.toHaveBeenCalled(); });
describe("async statusline polling with registration ownership", () => {
  it("keeps cost/rates/failover and weekly recovery output", async () => {
    io.read.mockResolvedValueOnce(data(12, 80, 100)).mockResolvedValueOnce(data(14, 50, 0));
    watcher.watch("a"); await vi.advanceTimersByTimeAsync(10_000);
    expect(watcher.getRateLimits("a")).toEqual({ five_hour_pct: 80, seven_day_pct: 100 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.costGuard.updateCost.mock.calls).toEqual([["a", 12], ["a", 14]]);
    expect(ctx.checkModelFailover.mock.calls).toEqual([["a", 80], ["a", 50]]);
    expect(ctx.notifyInstanceTopic).toHaveBeenCalledWith("a", "✅ a weekly usage limit has reset — instance is available again.");
  });
  it.each(["stop", "restart"])("drops old read after %s, including cost/failover/notification", async mode => {
    let release!: (v: string) => void;
    io.read.mockReturnValueOnce(new Promise<string>(r => { release = r; }));
    watcher.watch("a"); await vi.advanceTimersByTimeAsync(10_000);
    watcher.unwatch("a"); if (mode === "restart") watcher.watch("a");
    release(data(999, 100, 0)); await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getRateLimits("a")).toBeUndefined();
    expect(ctx.costGuard.updateCost).not.toHaveBeenCalled(); expect(ctx.checkModelFailover).not.toHaveBeenCalled(); expect(ctx.notifyInstanceTopic).not.toHaveBeenCalled();
    if (mode === "restart") {
      io.read.mockResolvedValueOnce(data(1, 2, 3)); await vi.advanceTimersByTimeAsync(10_000);
      expect(ctx.costGuard.updateCost).toHaveBeenCalledWith("a", 1);
    }
  });
  it("bounds physical reads to four, coalesces ticks and removes stopped queued work", async () => {
    const releases: Array<(v: string) => void> = [];
    io.read.mockImplementation(() => new Promise<string>(r => releases.push(r)));
    for (let i = 0; i < 9; i++) watcher.watch(String(i));
    await vi.advanceTimersByTimeAsync(30_000); expect(io.read).toHaveBeenCalledTimes(4);
    watcher.unwatch("4"); releases[0]!(data(1, 0, 0)); await vi.advanceTimersByTimeAsync(0);
    expect(io.read).toHaveBeenCalledTimes(5); expect(io.read.mock.calls.at(-1)![0]).toBe("/private/5/statusline.json");
    watcher.stopAll(); for (const release of releases) release(data(99, 100, 0)); await vi.advanceTimersByTimeAsync(0);
    expect(ctx.costGuard.updateCost).toHaveBeenCalledTimes(1);
  });
  it("ignores malformed/missing data and polls again", async () => {
    io.read.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce("{").mockResolvedValueOnce(data(4, 3, 2));
    watcher.watch("a"); await vi.advanceTimersByTimeAsync(30_000);
    expect(ctx.costGuard.updateCost).toHaveBeenCalledOnce(); expect(watcher.getRateLimits("a")).toEqual({ five_hour_pct: 3, seven_day_pct: 2 });
  });
});
