/**
 * #1416 review: a staged paste (load-buffer, then paste-buffer) asks its guard before every tmux step, so a caller
 * that stopped waiting — its owner stopped, paused, respawned, or its deadline passed while the load was held — is
 * never followed by a late write into the pane. tmux itself is a recording stub: nothing is run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ calls: [] as string[][], loadDelay: 0, timeouts: [] as Array<number | undefined> }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: vi.fn((_file: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    io.calls.push(args);
    io.timeouts.push(typeof optsOrCb === "object" && optsOrCb ? (optsOrCb as { timeout?: number }).timeout : undefined);
    setTimeout(() => cb(null, "", ""), args.includes("load-buffer") ? io.loadDelay : 0);
    return { stdin: { on() {}, end() {} } };
  }),
}));

import { TmuxManager } from "../src/tmux-manager.js";

beforeEach(() => { io.calls.length = 0; io.timeouts.length = 0; io.loadDelay = 0; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const step = (name: string) => io.calls.some(a => a.includes(name));

describe("the guarded staged paste", () => {
  it("control: a live guard loads and pastes, each tmux call bounded", async () => {
    const t = new TmuxManager("s", "@1");
    const done = t.pasteBuffer("/agent swap x", { guard: () => true, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await done).toBe(true);
    expect(step("load-buffer") && step("paste-buffer")).toBe(true);
    expect(io.timeouts.every(t => t === 1_000)).toBe(true);
  });

  it("the guard turns false while the load is held: no paste-buffer, the loaded buffer is dropped", async () => {
    io.loadDelay = 600;
    let live = true;
    const t = new TmuxManager("s", "@1");
    const done = t.pasteBuffer("/agent swap x", { guard: () => live });
    await vi.advanceTimersByTimeAsync(200);
    live = false; // stop, pause, respawn, or the deadline — while load-buffer is still running
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(false);
    expect(step("paste-buffer")).toBe(false);
    expect(step("delete-buffer")).toBe(true);
  });

  it("a guard already false: nothing is sent to tmux at all", async () => {
    const t = new TmuxManager("s", "@1");
    expect(await t.pasteBuffer("x", { guard: () => false })).toBe(false);
    expect(io.calls).toEqual([]);
  });
});
