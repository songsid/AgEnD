import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../src/channel/types.js";
import { ReplyButtonsController, type ReplyButtonsView } from "../src/reply-buttons-controller.js";
import { ReplyButtonStore, replyButtonCallback } from "../src/reply-buttons.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function rig(hold: "open" | "closed" | "buttons") {
  vi.useFakeTimers({ now: 1_000_000 });
  const dir = mkdtempSync(join(tmpdir(), "agend-poll-3197-"));
  const store = new ReplyButtonStore(join(dir, "buttons.db"));
  let release!: () => void;
  let heldMessage = "A";
  const held = new Promise<void>(resolve => { release = resolve; });
  const renders: Array<{ message: string; closed: boolean }> = [];
  const admitted: Array<{ key: string; text: string }> = [];
  const admitResults = vi.fn((_set: unknown, key: string, text: string) => { admitted.push({ key, text }); return true; });
  const views: Array<{ id: string; state: ReplyButtonsView["state"] }> = [];
  const adapter = {
    renderPoll: vi.fn(async (_chat, message, _thread, poll) => {
      renders.push({ message, closed: poll.closed });
      if (message === heldMessage && poll.closed === (hold === "closed")) await held;
    }),
    settleReplyButtons: vi.fn(async () => { if (hold === "buttons") await held; }),
  } as unknown as ChannelAdapter;
  const ctl = new ReplyButtonsController({
    store, now: () => Date.now(), monotonic: () => Date.now(), adapterFor: () => adapter,
    mayClick: () => true, deliver: async () => true,
    publish: (_instance, view) => { views.push({ id: view.id, state: view.state }); },
    admitResults,
    logger: { info() {}, warn() {} },
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: timer => clearTimeout(timer as NodeJS.Timeout),
  });
  const where = { instance: "quiz", adapterId: "dc", chatId: "guild", threadId: "room" };
  const prepare = (message: string, seconds = 10) => {
    const p = ctl.prepare(where, [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      { seconds, multi: false, reveal: "close", showVoters: false, question: message });
    ctl.bind(p.id, message);
    return p.id;
  };
  cleanups.push(async () => {
    ctl.stop(); release(); await vi.advanceTimersByTimeAsync(0);
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, ctl, adapter, admitted, admitResults, renders, views, prepare, release, where, holdMessage: (message: string) => { heldMessage = message; } };
}

describe("#3197: platform edits cannot hold the poll deadline scheduler", () => {
  it.each(["open", "closed"] as const)("a held %s edit cannot delay a later poll, its results or its web view", async hold => {
    const h = rig(hold);
    const a = h.prepare("A");
    if (hold === "open") {
      await h.ctl.handleCallback({ callbackData: replyButtonCallback(a, 0), chatId: "guild", threadId: "room", messageId: "A", userId: "owner" }, "dc");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.renders).toEqual([{ message: "A", closed: false }]);
    }
    await vi.advanceTimersByTimeAsync(4_000);
    const b = h.prepare("B"); // both binds are on time, before A's sweep starts
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.store.get(a)!.closedAt).toBe(1_010_000);
    expect(h.views).toContainEqual({ id: a, state: "closed" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.store.get(b)!.closedAt).toBe(1_014_000);
    expect(h.admitted.map(a => a.key)).toEqual([`poll:${a}`, `poll:${b}`]);
    expect(h.admitted.every(a => a.text.includes("closed on time"))).toBe(true);
    expect(h.views).toContainEqual({ id: b, state: "closed" });
    expect(h.renders).toContainEqual({ message: "B", closed: true });
    h.release();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.renders.filter(r => r.message === "A").map(r => r.closed)).toEqual(hold === "open" ? [false, true] : [true]);
    expect(h.admitted).toHaveLength(2); // releasing the old edit neither reopens nor re-delivers
  });

  it("all polls due together publish and render independently of a held closed edit", async () => {
    const h = rig("closed");
    const a = h.prepare("A"), b = h.prepare("B");
    // Store order at a shared deadline is by id: hold the first edit, regardless of the generated ids.
    const first = a < b ? "A" : "B", second = a < b ? "B" : "A";
    h.holdMessage(first);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.store.get(a)!.closedAt).toBe(1_010_000);
    expect(h.store.get(b)!.closedAt).toBe(1_010_000);
    expect(h.views).toContainEqual({ id: second === "A" ? a : b, state: "closed" });
    expect(h.renders).toContainEqual({ message: second, closed: true });
  });

  it.each(["expiry", "orphaned claim"] as const)("a plain-button %s edit cannot delay a poll due in the same sweep", async outcome => {
    const h = rig("buttons");
    const plain = h.ctl.prepare(h.where, [{ label: "Yes", value: "yes" }]);
    h.ctl.bind(plain.id, "plain");
    if (outcome === "expiry") vi.setSystemTime(h.store.get(plain.id)!.expiresAt - 10_000);
    else expect(h.store.consume(plain.id, 0, "owner", Date.now()).ok).toBe(true);
    const expiry = Date.now() + 10_000;
    const poll = h.prepare("B");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.adapter.settleReplyButtons).toHaveBeenCalledTimes(1);
    expect(h.store.get(poll)!.closedAt).toBe(expiry);
    expect(h.admitted.map(a => a.key)).toEqual([`poll:${poll}`]);
  });

  it("results admission is retried while the final tally edit is still held", async () => {
    const h = rig("closed");
    h.admitResults.mockReturnValueOnce(false);
    const a = h.prepare("A");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.store.get(a)!.resultsAt).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.store.get(a)!.resultsAt).toBe(1_040_000);
    expect(h.admitResults.mock.calls.map(([, key]) => key)).toEqual([`poll:${a}`, `poll:${a}`]);
    expect(h.renders).toEqual([{ message: "A", closed: true }]);
  });
});
