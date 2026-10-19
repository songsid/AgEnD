/**
 * #2175: after an update, Telegram often kept "Starting... 13/14" — the final step never landed. The adopted progress
 * message was edited every second; Telegram (about 20 messages a minute per group, edits included) answered 429 with a
 * retry_after, finish() sent the terminal edit straight into that window, and a window longer than the 30 s budget
 * ended it with the fresh-message fallback refused too. Stubbed adapters only — no update, restart or network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import {
  RESTART_PROGRESS_TERMINAL_TIMEOUT_MS, RestartProgress, TELEGRAM_PROGRESS_EDIT_SPACING_MS, TERMINAL_BACKGROUND_WINDOW_MS,
} from "../src/restart-progress.js";
import type { ChannelAdapter } from "../src/channel/types.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function grammy429(retryAfterSeconds: number, method = "editMessageText"): GrammyError {
  return new GrammyError("Too Many Requests: retry after",
    { ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfterSeconds}`, parameters: { retry_after: retryAfterSeconds } },
    method, {});
}

/** A Telegram group as the Bot API treats it: 20 messages a minute (edits included), then 429 with retry_after. */
function telegramGroup(opts: { limit?: number; retryAfter?: number } = {}) {
  const limit = opts.limit ?? 20, retryAfter = opts.retryAfter ?? 40;
  const sentAt: number[] = [];
  let blockedUntil = 0;
  const admit = (method: string) => {
    const now = Date.now();
    if (now < blockedUntil) throw grammy429(Math.ceil((blockedUntil - now) / 1000), method);
    if (sentAt.filter(at => at > now - 60_000).length >= limit) {
      blockedUntil = now + retryAfter * 1000;
      throw grammy429(retryAfter, method);
    }
    sentAt.push(now);
  };
  const editMessage = vi.fn(async (_chat: string, _id: string, _text: string) => { admit("editMessageText"); });
  const sendText = vi.fn(async () => { admit("sendMessage"); return { messageId: "fresh-1", chatId: "fleet" }; });
  const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
  return { adapter, editMessage, sendText, sentAt };
}

const SUMMARY = { running: 14, total: 14, version: "2.3.0-beta.10", pausedNames: [] };
const logger = () => ({ warn: vi.fn(), error: vi.fn() });

async function startupOver(progress: RestartProgress, seconds: number, total: number) {
  for (let s = 0; s < seconds; s++) {
    if (s % Math.max(1, Math.floor(seconds / total)) === 0) progress.markReady();
    await vi.advanceTimersByTimeAsync(1_000);
  }
}

describe("#2175: the final update step lands on Telegram", () => {
  it("a 2-minute startup on Telegram stays under the group limit: no 429, and the completion is the last edit", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const tg = telegramGroup();
    const log = logger();
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    await progress.resume({ adapter: tg.adapter, chatId: "fleet", threadId: "1" }, "update-1");
    await startupOver(progress, 120, 14);
    const finishing = progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS + 1_000);
    expect(await finishing).toBe(true);
    expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/429/));
    for (const at of tg.sentAt) expect(tg.sentAt.filter(t => t > at - 60_000 && t <= at).length).toBeLessThanOrEqual(11);
    expect(tg.editMessage).toHaveBeenLastCalledWith("fleet", "update-1", expect.stringContaining("✅ AgEnD updated to v2.3.0-beta.10"), "1");
    expect(tg.sendText).not.toHaveBeenCalled();
  });

  it("the same startup on Discord still reports every second (only Telegram is paced)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", type: "discord", editMessage } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(editMessage.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it("Telegram spacing: the newest frame is sent when the window opens, never a stale one", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const tg = telegramGroup();
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter: tg.adapter, chatId: "fleet" }, "update-1");
    for (let i = 0; i < 9; i++) progress.markReady();
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    expect(tg.editMessage).toHaveBeenCalledTimes(2);
    expect(tg.editMessage).toHaveBeenLastCalledWith("fleet", "update-1", expect.stringContaining("9/14"), undefined);
  });

  it("Telegram spacing keeps a held frame when no newer one follows (a plain restart has no 1 Hz ticker)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const tg = telegramGroup();
    const progress = new RestartProgress(20, 0, logger());
    await progress.start({ adapter: tg.adapter, chatId: "fleet" });
    for (let i = 0; i < 5; i++) progress.markReady();
    await vi.advanceTimersByTimeAsync(3_000);
    for (let i = 0; i < 5; i++) progress.markReady();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(tg.editMessage).toHaveBeenCalledTimes(2);
    expect(tg.editMessage).toHaveBeenLastCalledWith("fleet", "fresh-1", expect.stringContaining("10/20"), undefined);
  });

  it("a 429 window longer than the budget: finish() returns at once, the edit lands after the window — never into it", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn()
      .mockResolvedValueOnce(undefined)       // resume
      .mockRejectedValueOnce(grammy429(45))   // the next frame draws a 45 s window (> 30 s budget)
      .mockResolvedValue(undefined);
    const sendText = vi.fn();
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
    const log = logger();
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    const calls = editMessage.mock.calls.length;
    await expect(progress.finish(SUMMARY)).resolves.toBe(true);
    expect(progress.terminalDeferred).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "rate limited (429)" }), expect.stringMatching(/background/));
    await vi.advanceTimersByTimeAsync(44_999);
    expect(calls).toBe(2);                                // resume + the refused frame
    expect(editMessage).toHaveBeenCalledTimes(calls);      // nothing sent inside the window
    await vi.advanceTimersByTimeAsync(1);
    expect(editMessage).toHaveBeenCalledTimes(calls + 1);
    expect(editMessage).toHaveBeenLastCalledWith("fleet", "update-1", expect.stringContaining("✅"), undefined);
    expect(progress.terminalDeferred).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("finish() during a progress-edit 429 window waits it out (within budget) instead of editing into it", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockRejectedValueOnce(grammy429(10)).mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", editMessage } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");   // the first frame draws a 10 s window
    await vi.advanceTimersByTimeAsync(0);
    const finishing = progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(editMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(finishing).resolves.toBe(true);
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(progress.terminalDeferred).toBe(false);
  });

  it("adapter not ready past the budget: startup goes on, the edit lands once it is ready — no error", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText: vi.fn() } as unknown as ChannelAdapter;
    let ready = false;
    const log = logger();
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    await progress.resume({ resolveAdapter: () => (ready ? adapter : undefined), chatId: "fleet" }, "update-1");
    const finishing = progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    await expect(finishing).resolves.toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "adapter not ready" }), expect.stringMatching(/background/));
    ready = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenLastCalledWith("fleet", "update-1", expect.stringContaining("✅"), undefined);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("an edit refused for good in the background (message gone): a new message carries the completion", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(grammy429(40))
      .mockRejectedValue(new Error("Bad Request: message to edit not found"));
    const sendText = vi.fn().mockResolvedValue({ messageId: "fresh-1", chatId: "fleet" });
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
    const log = logger();
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet", threadId: "1" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await expect(progress.finish(SUMMARY)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("fleet", expect.stringContaining("✅ AgEnD updated to v2.3.0-beta.10"), { threadId: "1" });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/new message/));
    expect(progress.terminalDeferred).toBe(false);
  });

  it("a fresh message refused by the same 429 window is retried after it, not dropped", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("message can't be edited"));
    const sendText = vi.fn().mockRejectedValueOnce(grammy429(50, "sendMessage")).mockResolvedValue({ messageId: "fresh-1", chatId: "fleet" });
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await expect(progress.finish(SUMMARY)).resolves.toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(progress.terminalDeferred).toBe(false);
  });

  it("still refused at the end of the background window: one error, and no timer left behind", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(grammy429(60));
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText: vi.fn() } as unknown as ChannelAdapter;
    const log = logger();
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await expect(progress.finish(SUMMARY)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_WINDOW_MS + 120_000);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.anything(), "Fleet completion could not be delivered in the background window");
    expect(progress.terminalDeferred).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(editMessage.mock.calls.length, "each retry waits the window out").toBeLessThan(15);
  });

  it("the terminal edit itself drawing a long 429: finish() does not spend its budget waiting", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(grammy429(45)).mockResolvedValue(undefined);
    const adapter = { id: "discord", type: "discord", editMessage, sendText: vi.fn() } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ resolveAdapter: () => adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(editMessage).toHaveBeenCalledTimes(1);             // the progress frame landed; the terminal edit draws the 429
    let settled = false;
    const finishing = progress.finish(SUMMARY).then(v => { settled = true; return v; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(finishing).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(editMessage).toHaveBeenLastCalledWith("fleet", "update-1", expect.stringContaining("✅"), undefined);
  });

  it("background: an edit refused for good, then a new message refused by 429 — retried after that window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(grammy429(40))
      .mockRejectedValue(new Error("message to edit not found"));
    const sendText = vi.fn().mockRejectedValueOnce(grammy429(70, "sendMessage")).mockResolvedValue({ messageId: "f", chatId: "fleet" });
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await expect(progress.finish(SUMMARY)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendText).toHaveBeenCalledTimes(1);                // refused: 70 s window
    await vi.advanceTimersByTimeAsync(69_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(progress.terminalDeferred).toBe(false);
  });

  it("cancelled while a background edit is in flight: its 429 does not start another round", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let refuse!: (e: unknown) => void;
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(grammy429(40))
      .mockImplementationOnce(() => new Promise<void>((_, rej) => { refuse = rej; }))
      .mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", editMessage } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(40_000);               // the background edit is now in flight
    expect(editMessage).toHaveBeenCalledTimes(3);
    progress.cancelDeferredTerminal();
    refuse(grammy429(30));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(editMessage).toHaveBeenCalledTimes(3);
  });

  it("a newer text taking the message over (the cleanup warning) stops the owed completion", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(grammy429(40)).mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", editMessage } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await progress.finish(SUMMARY);
    const calls = editMessage.mock.calls.length;
    progress.cancelDeferredTerminal();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(editMessage).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the cleanup-warning append cancels the owed completion only after its own edit landed", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "fleet-manager.ts"), "utf8") as string;
    const body = src.slice(src.indexOf("private async appendCleanupWarning("), src.indexOf("private startUpdateProgressMonitor("));
    const edit = body.indexOf("await adapter.editMessage(target.chatId, target.messageId, text, target.threadId);");
    const cancel = body.indexOf("this.startupProgress?.cancelDeferredTerminal();");
    expect(edit).toBeGreaterThan(0);
    expect(cancel).toBeGreaterThan(edit);
  });
});
