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

function health(isReady: boolean) {
  return {
    id: "discord",
    type: "discord",
    status: isReady ? "connected" : "starting",
    generation: 1,
    isReady,
    wsStatus: null,
    lastHeartbeatAckAt: null,
    heartbeatAgeMs: null,
    shards: [],
    lastDispatchAt: null,
    lastReconnectAt: null,
    lastReconnectReason: null,
    reconnectCount: 0,
  } as const;
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
      tipText: "💡 Tip: Try /status in General.",
    })).toBe(true);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet",
      "update-1",
      [
        "✅ Fleet restarted — v2.1.4-beta.2, 2/3 instances running (25s)",
        "⏸ Paused (1): sleeping",
        "",
        "💡 Tip: Try /status in General.",
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
      "✅ Fleet 已重啟 — v2.1.4，1/1 個 Agent 運行中（3s）",
      undefined,
    );
  });

  it("posts a fresh terminal update when the adopted message edit fails after 7/8", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const editMessage = vi.fn()
      .mockResolvedValueOnce(undefined) // resume: starting
      .mockResolvedValueOnce(undefined) // threshold: 5/8
      .mockResolvedValueOnce(undefined) // periodic: 7/8
      .mockRejectedValueOnce(new Error("provider rejected terminal edit"));
    const sendText = vi.fn().mockResolvedValue({ messageId: "completion-2", chatId: "fleet" });
    const adapter = { editMessage, sendText } as unknown as ChannelAdapter;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const progress = new RestartProgress(8, 0, logger, { mode: "update" });

    await progress.resume({ adapter, chatId: "fleet", threadId: "general" }, "update-1");
    for (let i = 0; i < 7; i++) progress.markReady();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet", "update-1", "⏳ Starting... 7/8 instances (1s)", "general",
    );

    progress.markReady();
    expect(await progress.finish({ running: 8, total: 8, version: "2.1.5-beta.3", pausedNames: [] })).toBe(true);
    expect(sendText).toHaveBeenCalledWith(
      "fleet",
      "✅ Fleet restarted — v2.1.5-beta.3, 8/8 instances running (1s)",
      { threadId: "general" },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to edit fleet restart progress terminal state",
    );
  });

  it("waits for and follows a replacement adapter generation before completing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const oldAdapter = {
      editMessage: vi.fn(),
      sendText: vi.fn(),
      getHealthSnapshot: () => health(false),
    } as unknown as ChannelAdapter;
    const replacementEdit = vi.fn().mockResolvedValue(undefined);
    const replacement = {
      editMessage: replacementEdit,
      sendText: vi.fn(),
      getHealthSnapshot: () => health(true),
    } as unknown as ChannelAdapter;
    let current: ChannelAdapter = oldAdapter;
    const progress = new RestartProgress(1, 0, { warn: vi.fn(), error: vi.fn() }, { mode: "update" });

    await progress.resume({
      adapter: oldAdapter,
      resolveAdapter: () => current,
      chatId: "fleet",
    }, "update-1");
    const finishing = progress.finish({ running: 1, total: 1, version: "2.1.5", pausedNames: [] });
    let settled = false;
    void finishing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(oldAdapter.editMessage).not.toHaveBeenCalled();

    current = replacement;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(finishing).resolves.toBe(true);
    expect(replacementEdit).toHaveBeenCalledWith(
      "fleet", "update-1", "✅ Fleet restarted — v2.1.5, 1/1 instances running (0s)", undefined,
    );
    expect(replacement.sendText).not.toHaveBeenCalled();
  });

  it("bounds a terminal edit that never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const adapter = {
      sendText: vi.fn().mockResolvedValue({ messageId: "progress-1", chatId: "fleet" }),
      editMessage: vi.fn().mockReturnValue(new Promise<void>(() => {})),
    } as unknown as ChannelAdapter;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const progress = new RestartProgress(6, 0, logger);

    await progress.start({ adapter, chatId: "fleet" });
    const finishing = progress.finish({ running: 6, total: 6, version: "2.1.5", pausedNames: [] });
    let settled = false;
    void finishing.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(finishing).resolves.toBe(false);
    expect(adapter.sendText).toHaveBeenCalledTimes(1); // initial progress only
    expect(logger.error).toHaveBeenCalled();
  });

  it("coalesces slow periodic edits to the latest frame before terminal delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseFirst!: () => void;
    const editMessage = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { releaseFirst = resolve; }))
      .mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue({ messageId: "completion-2", chatId: "fleet" });
    const adapter = { editMessage, sendText } as unknown as ChannelAdapter;
    const progress = new RestartProgress(8, 0, { warn: vi.fn(), error: vi.fn() }, { mode: "update" });

    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    progress.markReady();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(editMessage).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet", "update-1", "⏳ Starting... 1/8 instances (20s)", undefined,
    );

    await expect(progress.finish({ running: 1, total: 8, version: "2.1.5", pausedNames: [] }))
      .resolves.toBe(true);
    expect(editMessage).toHaveBeenCalledTimes(3);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("waits for a healthy in-flight progress edit before editing the terminal state in place", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const editMessage = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => setTimeout(resolve, 400)))
      .mockResolvedValue(undefined);
    const sendText = vi.fn();
    const adapter = { editMessage, sendText } as unknown as ChannelAdapter;
    const progress = new RestartProgress(8, 0, { warn: vi.fn(), error: vi.fn() }, { mode: "update" });

    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    progress.markReady();
    await vi.advanceTimersByTimeAsync(1_000);
    const finishing = progress.finish({ running: 8, total: 8, version: "2.1.5", pausedNames: [] });
    await vi.advanceTimersByTimeAsync(399);
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(sendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(finishing).resolves.toBe(true);
    expect(editMessage).toHaveBeenCalledTimes(3);
    expect(editMessage).toHaveBeenLastCalledWith(
      "fleet", "update-1", "✅ Fleet restarted — v2.1.5, 8/8 instances running (1s)", undefined,
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it("rechecks gateway readiness after edit failure before the single fresh send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let oldReady = true;
    let current: ChannelAdapter;
    const oldAdapter = {
      editMessage: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => {
          oldReady = false;
          setTimeout(() => { current = replacement; }, 1_000);
          return Promise.reject(new Error("gateway dropped"));
        }),
      sendText: vi.fn(),
      getHealthSnapshot: () => health(oldReady),
    } as unknown as ChannelAdapter;
    const replacement = {
      editMessage: vi.fn(),
      sendText: vi.fn().mockResolvedValue({ messageId: "completion-2", chatId: "fleet" }),
      getHealthSnapshot: () => health(true),
    } as unknown as ChannelAdapter;
    current = oldAdapter;
    const progress = new RestartProgress(1, 0, { warn: vi.fn(), error: vi.fn() }, { mode: "update" });

    await progress.resume({ adapter: oldAdapter, resolveAdapter: () => current, chatId: "fleet" }, "update-1");
    const finishing = progress.finish({ running: 1, total: 1, version: "2.1.5", pausedNames: [] });
    await vi.advanceTimersByTimeAsync(999);
    expect(oldAdapter.sendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(finishing).resolves.toBe(true);
    expect(oldAdapter.sendText).not.toHaveBeenCalled();
    expect(replacement.sendText).toHaveBeenCalledTimes(1);
  });

  it("waits for the first adapter generation to be registered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let current: ChannelAdapter | undefined;
    const adapter = {
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn(),
      getHealthSnapshot: () => health(true),
    } as unknown as ChannelAdapter;
    const progress = new RestartProgress(1, 0, { warn: vi.fn(), error: vi.fn() }, { mode: "update" });

    await progress.resume({ resolveAdapter: () => current, chatId: "fleet" }, "update-1");
    const finishing = progress.finish({ running: 1, total: 1, version: "2.1.5", pausedNames: [] });
    setTimeout(() => { current = adapter; }, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(finishing).resolves.toBe(true);
    expect(adapter.editMessage).toHaveBeenCalledTimes(1);
  });

  it("attempts a fresh completion only once and logs loudly when delivery stays unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const adapter = {
      editMessage: vi.fn().mockRejectedValue(new Error("edit down")),
      sendText: vi.fn().mockRejectedValue(new Error("send down")),
    } as unknown as ChannelAdapter;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const progress = new RestartProgress(1, 0, logger, { mode: "update" });

    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    const finishing = progress.finish({ running: 1, total: 1, version: "2.1.5", pausedNames: [] });

    await expect(finishing).resolves.toBe(false);
    expect(adapter.editMessage).toHaveBeenCalled();
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { timeout_ms: 30_000 },
      "Fleet completion could not be delivered after adapter recovery wait",
    );
  });
});
