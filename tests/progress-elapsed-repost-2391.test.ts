/**
 * M-2391: the cancel bubble's elapsed time across a mid-turn reply. Every reply re-posts the in-flight bubble below it
 * (sendCancelButton(name, undefined, preserveProgress = true)); the re-post used to restart the elapsed clock, so an
 * agent replying more often than progress_min_elapsed (30 s by default) never showed elapsed time — only tool-list
 * pushes edited the bubble. Now:
 * - a re-post continues the live bubble's start (the turn's), and ticks at the threshold measured from it;
 * - a re-post already past the threshold is posted showing the elapsed time;
 * - a fresh turn (no preserve) starts at 0;
 * - the threshold tick fires a margin after it, so an early timer never renders the unchanged text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

type Entry = { instanceName: string; messageId: string; startedAt?: number; retiring?: boolean; lastProgressText?: string };
type Internals = {
  getInstanceStatus(name: string): string;
  lifecycle: { isPaused(name: string): boolean };
  cancelButtons: Map<string, Entry>;
  sendCancelButton(name: string, correlationId?: string, preserveProgress?: boolean): Promise<void>;
  deleteButtonMessage(entry: unknown): Promise<void>;
  getInstanceExecutionState(name: string): string;
};
const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers({ now: 1_800_000_000_000 }); });
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-2391-")); dirs.push(dir);
  const fm = new FleetManager(dir);
  const i = fm as unknown as Internals;
  i.lifecycle.isPaused = () => false;
  i.getInstanceStatus = () => "running";
  i.getInstanceExecutionState = () => "working";
  i.deleteButtonMessage = vi.fn(async () => {});
  (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
    defaults: {}, channel: { type: "telegram", group_id: "g1", access: { mode: "locked", allowed_users: ["u1"] } },
    instances: { alpha: { working_directory: "/tmp", topic_id: "123" } },
  };
  let n = 0;
  const posted: string[] = [], edited: string[] = [];
  const adapter = {
    notifyAlert: vi.fn(async (_chat: string, alert: { message: string }) => { posted.push(alert.message); return { messageId: `m${++n}`, chatId: "g1", threadId: "123" }; }),
    editAlert: vi.fn(async (_c: string, _m: string, alert: { message: string }) => { edited.push(alert.message); }),
    editMessage: vi.fn(async () => {}),
  };
  (fm as unknown as { adapter: unknown }).adapter = adapter;
  const live = () => [...i.cancelButtons.values()].filter((e) => e.instanceName === "alpha" && !e.retiring);
  return { fm, i, posted, edited, live };
}

describe("M-2391: elapsed time across a re-post", () => {
  it("a re-post after a reply keeps the turn's start; the threshold tick (30 s from it) shows the elapsed time", async () => {
    const f = fleet();
    await f.i.sendCancelButton("alpha");
    const start = f.live()[0]!.startedAt!;
    await vi.advanceTimersByTimeAsync(20_000);
    await f.i.sendCancelButton("alpha", undefined, true);                  // a reply at 20 s: re-posted below it
    expect(f.live()).toHaveLength(1);
    expect(f.live()[0]!.startedAt).toBe(start);
    expect(f.posted.at(-1)).toBe("👀 處理中…");                              // not yet past the threshold
    await vi.advanceTimersByTimeAsync(10_100);                             // 30.1 s into the turn
    expect(f.edited.at(-1)).toBe("⏳ 處理中… (已進行 0m 30s)");
  });
  it("a re-post already past the threshold is posted with the elapsed time; a fresh turn starts at 0", async () => {
    const f = fleet();
    await f.i.sendCancelButton("alpha");
    await vi.advanceTimersByTimeAsync(45_000);
    await f.i.sendCancelButton("alpha", undefined, true);
    expect(f.posted.at(-1)).toBe("⏳ 處理中… (已進行 0m 45s)");
    await f.i.sendCancelButton("alpha");                                   // a new turn
    expect(f.posted.at(-1)).toBe("👀 處理中…");
    const fresh = f.live().at(-1)!;
    expect(Date.now() - fresh.startedAt!).toBe(0);
  });
  it("a retiring bubble from an earlier turn never pulls the start earlier: the re-post keeps the live bubble's (Fable #3126)", async () => {
    const f = fleet();
    await f.i.sendCancelButton("alpha");
    const live = f.live()[0]!.startedAt!;
    // An older turn's bubble still being retired (its delete not answered yet), with a much earlier start.
    f.i.cancelButtons.set("old", { instanceName: "alpha", messageId: "old", startedAt: live - 600_000, retiring: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await f.i.sendCancelButton("alpha", undefined, true);
    expect(f.live().map((e) => e.startedAt)).toEqual([live]);
    expect(f.posted.at(-1)).toBe("👀 處理中…");                              // 5 s into the turn, not 10 min
  });
  it("an early timer (it fired a millisecond before Date.now() reached the threshold) still edits: the tick has a margin", async () => {
    const f = fleet();
    // Model a real timer that fires 1 ms early against Date.now() (seen ~1% of the time on Node).
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => real(fn, Math.max(0, (ms ?? 0) - 1))) as typeof setTimeout;
    try { await f.i.sendCancelButton("alpha"); } finally { globalThis.setTimeout = real; }
    await vi.advanceTimersByTimeAsync(30_100);                             // past the threshold, before the 60 s interval
    expect(f.edited).toEqual(["⏳ 處理中… (已進行 0m 30s)"]);
  });
});
