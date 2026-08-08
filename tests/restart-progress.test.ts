import { afterEach, describe, expect, it, vi } from "vitest";
import { RestartProgress } from "../src/restart-progress.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import { setLocale } from "../src/locale.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLocale("en");
});

function setup(total: number) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const sendText = vi.fn().mockResolvedValue({ messageId: "progress-1", chatId: "fleet" });
  const editMessage = vi.fn().mockResolvedValue(undefined);
  const adapter = { sendText, editMessage } as unknown as ChannelAdapter;
  const logger = { warn: vi.fn() };
  const progress = new RestartProgress(total, 0, logger);
  return { progress, adapter, sendText, editMessage };
}

describe("RestartProgress", () => {
  it("does not post for fleets with five or fewer runnable instances", async () => {
    const { progress, adapter, sendText } = setup(5);

    expect(await progress.start({ adapter, chatId: "fleet", threadId: "general" })).toBe(false);
    progress.markReady();
    expect(await progress.finish()).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("edits one message every five ready instances and completes with elapsed time", async () => {
    const { progress, adapter, sendText, editMessage } = setup(6);
    await progress.start({ adapter, chatId: "fleet", threadId: "general" });

    for (let i = 0; i < 5; i++) progress.markReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      "fleet",
      "🔄 Fleet restarting — 6 instances starting...",
      { threadId: "general" },
    );
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet",
      "progress-1",
      "🔄 Fleet restarting — 5/6 ready...",
      "general",
    );

    progress.markReady();
    vi.setSystemTime(75_000);
    expect(await progress.finish({
      running: 6,
      total: 9,
      version: "2.1.2-beta.50",
      pausedNames: ["paused-one", "paused-two"],
      failedNames: ["failed-one"],
    })).toBe(true);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet",
      "progress-1",
      [
        "✅ Fleet ready — 6/9 instances running (1m 15s) · v2.1.2-beta.50",
        "⏸ Paused (2): paused-one, paused-two",
        "⚠️ Failed (1): failed-one",
      ].join("\n"),
      "general",
    );
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("refreshes the same message after 30 seconds even below the five-ready threshold", async () => {
    const { progress, adapter, editMessage } = setup(8);
    progress.markReady();
    progress.markReady();
    await progress.start({ adapter, chatId: "fleet" });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(editMessage).toHaveBeenCalledWith(
      "fleet",
      "progress-1",
      "🔄 Fleet restarting — 2/8 ready...",
      undefined,
    );
    await progress.finish();
  });

  it("adopts the pre-update message, reports every second, and finishes it in place", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { editMessage } as unknown as ChannelAdapter;
    const progress = new RestartProgress(2, 0, { warn: vi.fn() }, { mode: "update" });

    progress.markReady();
    expect(await progress.resume({ adapter, chatId: "fleet", threadId: "general" }, "update-1")).toBe(true);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet",
      "update-1",
      "🚀 Starting fleet... (10s)",
      "general",
    );

    vi.setSystemTime(11_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet",
      "update-1",
      "⏳ Starting... 1/2 instances (12s)",
      "general",
    );

    progress.markReady();
    vi.setSystemTime(25_000);
    expect(await progress.finish({
      running: 2,
      total: 3,
      version: "2.1.4-beta.2",
      pausedNames: ["sleeping"],
    })).toBe(true);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet",
      "update-1",
      [
        "✅ Fleet restarted — v2.1.4-beta.2, 2/3 instances running (25s)",
        "⏸ Paused (1): sleeping",
      ].join("\n"),
      "general",
    );
  });

  it("localizes update progress through the existing fleet locale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    setLocale("zh-TW");
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { editMessage } as unknown as ChannelAdapter;
    const progress = new RestartProgress(1, 0, { warn: vi.fn() }, { mode: "update" });

    await progress.resume({ adapter, chatId: "fleet" }, "update-zh");
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet",
      "update-zh",
      "🚀 啟動 Fleet... (3s)",
      undefined,
    );
    await progress.finish({ running: 1, total: 1, version: "2.1.4", pausedNames: [] });
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet",
      "update-zh",
      "✅ Fleet 已重啟 — v2.1.4, 1/1 instances running (3s)",
      undefined,
    );
  });
});
