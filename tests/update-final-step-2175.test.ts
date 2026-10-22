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
    expect(tg.editMessage).toHaveBeenLastCalledWith("fleet", "update-1", expect.stringContaining("✅ Update complete — v2.3.0-beta.10"), "1");
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
    expect(sendText).toHaveBeenCalledWith("fleet", expect.stringContaining("✅ Update complete — v2.3.0-beta.10"), { threadId: "1" });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/new message/));
    expect(progress.terminalDeferred).toBe(false);
  });

  it("a newer text arriving while the fresh message is being posted is written onto that new message", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let post!: (v: { messageId: string; chatId: string }) => void;
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(grammy429(40))
      .mockRejectedValueOnce(new Error("message to edit not found")).mockResolvedValue(undefined);
    const sendText = vi.fn().mockImplementationOnce(() => new Promise(r => { post = r; }));
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    progress.replaceTerminalText("✅ newer");
    post({ messageId: "fresh-7", chatId: "fleet" });
    await vi.advanceTimersByTimeAsync(0);
    expect(editMessage).toHaveBeenLastCalledWith("fleet", "fresh-7", "✅ newer", undefined);
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
    expect(editMessage.mock.calls.length, "each retry waits the window out").toBeLessThan(TERMINAL_BACKGROUND_WINDOW_MS / 60_000 + 5);
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

  // ── Prism r1 on #2177 ──────────────────────────────────────────────────────────────────────────────────────

  /** A provider that applies edits in the order they SETTLE, so a late success is visible as the final text. */
  function heldTelegram() {
    let applied = "";
    const held: Array<{ text: string; resolve: () => void; reject: (e: unknown) => void }> = [];
    let mode: "pass" | "hold" = "pass";
    const queue: Array<(text: string) => Promise<void> | void> = [];
    const editMessage = vi.fn((_c: string, _m: string, text: string) => {
      const next = queue.shift();
      if (next) return Promise.resolve(next(text)).then(() => { applied = text; });
      if (mode === "hold") return new Promise<void>((resolve, reject) => held.push({ text, resolve: () => { applied = text; resolve(); }, reject }));
      applied = text;
      return Promise.resolve();
    });
    const sendText = vi.fn();
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
    return {
      adapter, editMessage, sendText, held, queue,
      hold() { mode = "hold"; }, pass() { mode = "pass"; },
      get applied() { return applied; },
    };
  }

  it("P2-1: a 429 answered after finish() began goes to the terminal path — deferred, nothing written in its window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const tg = heldTelegram();
    const log = logger();
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    tg.hold();
    await progress.resume({ adapter: tg.adapter, chatId: "fleet" }, "update-1");   // the first frame is held
    await vi.advanceTimersByTimeAsync(0);
    expect(tg.held).toHaveLength(1);
    let settled = false;
    const finishing = progress.finish(SUMMARY).then(v => { settled = true; return v; });
    await vi.advanceTimersByTimeAsync(1_000);
    tg.held[0].reject(grammy429(45));                       // answered after finish() began
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(finishing).resolves.toBe(true);
    expect(progress.terminalDeferred).toBe(true);
    tg.pass();
    await vi.advanceTimersByTimeAsync(44_000);
    expect(tg.editMessage).toHaveBeenCalledTimes(1);         // nothing into the window
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tg.applied).toContain("✅ Update complete — v2.3.0-beta.10");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("P2-1: a window exactly as long as the budget is deferred too (no edit at the deadline, no false failure)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(grammy429(30)).mockResolvedValue(undefined);
    const adapter = { id: "discord", type: "discord", editMessage, sendText: vi.fn() } as unknown as ChannelAdapter;
    const log = logger();
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(0);
    const finishing = progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(0);
    await expect(finishing).resolves.toBe(true);
    expect(progress.terminalDeferred).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(editMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(editMessage).toHaveBeenCalledTimes(3);
    expect(editMessage).toHaveBeenLastCalledWith("fleet", "update-1", expect.stringContaining("✅"), undefined);
    expect(log.error).not.toHaveBeenCalled();
  });

  /** Gets a background attempt going: resume, a frame refused by 429(40), finish() deferring, the window passing. */
  async function deferredWithAttemptHeld(tg: ReturnType<typeof heldTelegram>, log = logger()) {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    await progress.resume({ adapter: tg.adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(0);
    tg.queue.push(() => { throw grammy429(40); });
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);   // this frame draws the window
    await progress.finish(SUMMARY);
    expect(progress.terminalDeferred).toBe(true);
    tg.hold();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(tg.held).toHaveLength(1);                          // background edit A in flight
    return { progress, log };
  }

  it("P2-2: a newer text while background edit A is in flight is written after A — even when A lands late", async () => {
    const tg = heldTelegram();
    const { progress } = await deferredWithAttemptHeld(tg);
    const withWarning = "✅ Update complete — v2.3.0-beta.10; 14/14 agents running.\n\n⚠️ old copy left";
    expect(progress.replaceTerminalText(withWarning)).toBe(true);
    tg.pass();
    tg.held[0].resolve();                                    // A lands (applied) after the newer text arrived
    await vi.advanceTimersByTimeAsync(0);
    expect(tg.applied).toBe(withWarning);
    expect(progress.terminalDeferred).toBe(false);
  });

  it("P2-2: the same when A settles only after its deadline (outcome unknown, then landed)", async () => {
    const tg = heldTelegram();
    const { progress, log } = await deferredWithAttemptHeld(tg);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/did not settle/));
    const withWarning = "✅ … ⚠️ old copy left";
    expect(progress.replaceTerminalText(withWarning)).toBe(true);
    tg.pass();
    tg.held[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(tg.applied).toBe(withWarning);
  });

  it("P2-3: a background edit unsettled at its deadline: no further write while it is outstanding; landing late ends it", async () => {
    const tg = heldTelegram();
    const { progress, log } = await deferredWithAttemptHeld(tg);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    expect(log.error).toHaveBeenCalledWith({ timeout_ms: 30_000 }, "Background fleet completion edit did not settle — not retried, its outcome is unknown");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tg.editMessage).toHaveBeenCalledTimes(3);          // resume, the refused frame, A — nothing more
    expect(tg.sendText).not.toHaveBeenCalled();
    tg.pass();
    tg.held[0].resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tg.editMessage).toHaveBeenCalledTimes(3);
    expect(tg.applied).toContain("✅");
    expect(progress.terminalDeferred).toBe(false);
  });

  it("P2-3: a late-refused edit is a known outcome — the retry resumes", async () => {
    const tg = heldTelegram();
    const { progress } = await deferredWithAttemptHeld(tg);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    tg.pass();
    tg.held[0].reject(new Error("Bad Gateway"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tg.editMessage).toHaveBeenCalledTimes(4);
    expect(tg.applied).toContain("✅");
    expect(progress.terminalDeferred).toBe(false);
  });

  it("P2-3: a fresh message unsettled at its deadline is never sent twice; landing late adopts it", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let post!: (v: { messageId: string; chatId: string }) => void;
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(grammy429(40))
      .mockRejectedValueOnce(new Error("message to edit not found")).mockResolvedValue(undefined);
    const sendText = vi.fn().mockImplementationOnce(() => new Promise(r => { post = r; }));
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
    const log = logger();
    const progress = new RestartProgress(14, 0, log, { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS + 5 * 60_000);
    expect(log.error).toHaveBeenCalledWith(expect.anything(), "Background fleet completion message did not settle — not retried, its outcome is unknown");
    expect(sendText).toHaveBeenCalledTimes(1);
    progress.replaceTerminalText("✅ newer");
    post({ messageId: "fresh-9", chatId: "fleet" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenLastCalledWith("fleet", "fresh-9", "✅ newer", undefined);  // the newer text, on the posted message
  });

  // ── Prism r2 on #2177 ──────────────────────────────────────────────────────────────────────────────────────

  it("r2 P2-1/3: a held background EDIT refused late with 429(60): the next write waits that window, not 15 s", async () => {
    const tg = heldTelegram();
    const { progress } = await deferredWithAttemptHeld(tg);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS + 1_000);
    tg.pass();
    tg.held[0].reject(grammy429(60));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(tg.editMessage).toHaveBeenCalledTimes(3);           // nothing inside the window it named
    await vi.advanceTimersByTimeAsync(1);
    expect(tg.editMessage).toHaveBeenCalledTimes(4);
    expect(tg.applied).toContain("✅");
    expect(progress.terminalDeferred).toBe(false);
  });

  it("r2 P2-1/3: a held background SEND refused late with 429(60): the same", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let refuse!: (e: unknown) => void;
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(grammy429(40))
      .mockRejectedValue(new Error("message to edit not found"));
    const sendText = vi.fn().mockImplementationOnce(() => new Promise((_, rej) => { refuse = rej; }))
      .mockResolvedValue({ messageId: "fresh-2", chatId: "fleet" });
    const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(40_000 + RESTART_PROGRESS_TERMINAL_TIMEOUT_MS + 1_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    refuse(grammy429(60, "sendMessage"));
    const edits = editMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(editMessage).toHaveBeenCalledTimes(edits);
    expect(sendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendText).toHaveBeenCalledTimes(2);                 // edit refused for good again → a new message
    expect(progress.terminalDeferred).toBe(false);
  });

  it("r2 P2-2: handing the cleanup warning over is not delivery — marker and watch stay until the warning lands", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const marker = await import("../src/update-marker.js");
    const home = mkdtempSync(join(tmpdir(), "agend-2175-"));
    const saved = process.env.AGEND_HOME;
    process.env.AGEND_HOME = home;
    try {
      const tg = heldTelegram();
      const { progress } = await deferredWithAttemptHeld(tg);           // fake clock; background edit A held
      const target = { adapterId: "telegram", chatId: "fleet", messageId: "update-1" };
      marker.beginUpdateProgress(home, target);
      const receipt = marker.markCleanupPending(home)!;
      expect(marker.writeCleanupOutcome(home, receipt, { warning: "old copy left" })).toBe(true);
      const { FleetManager } = await import("../src/fleet-manager.js");
      const fm = new FleetManager(home) as any;
      fm.adapters.set("telegram", tg.adapter);
      fm.startupProgress = progress;
      const watch = { receipt, summary: SUMMARY };
      fm.updateCleanupWatch = watch;
      await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS + 1_000);   // A: outcome unknown
      const edits = tg.editMessage.mock.calls.length;

      await fm.appendCleanupWarning(target, watch, "old copy left");
      expect(tg.editMessage).toHaveBeenCalledTimes(edits);              // handed over, not written alongside A
      expect(marker.readUpdateProgress(home)).not.toBeNull();           // receipt kept
      expect(fm.updateCleanupWatch).toBe(watch);                        // watch kept

      tg.pass();
      tg.held[0].resolve();                                             // A lands; the retry writes the warning text
      await vi.advanceTimersByTimeAsync(0);
      expect(tg.applied).toContain("old copy left");
      expect(marker.readUpdateProgress(home)).not.toBeNull();           // still kept until the watch sees it landed

      await fm.appendCleanupWarning(target, watch, "old copy left");    // next tick
      expect(tg.editMessage).toHaveBeenCalledTimes(edits + 1);          // no second write by the watch
      expect(marker.readUpdateProgress(home)).toBeNull();
      expect(fm.updateCleanupWatch).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("r2 P2-2: a text handed over BEFORE the attempt that carried it, which then lands late, counts as landed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const tg = heldTelegram();
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    await progress.resume({ adapter: tg.adapter, chatId: "fleet" }, "update-1");
    await vi.advanceTimersByTimeAsync(0);
    tg.queue.push(() => { throw grammy429(40); });
    await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
    await progress.finish(SUMMARY);
    progress.replaceTerminalText("✅ with warning");                 // before the background attempt starts
    tg.hold();
    await vi.advanceTimersByTimeAsync(40_000 + RESTART_PROGRESS_TERMINAL_TIMEOUT_MS + 1_000);
    expect(progress.terminalLanded("✅ with warning")).toBe(false);   // unknown, not landed
    tg.held[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(progress.terminalLanded("✅ with warning")).toBe(true);
    expect(progress.terminalDeferred).toBe(false);
  });

  it("r2 P2-2: the completion landing is not the warning landing — the watch still writes the warning", () => {
    const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
    (progress as any).landedText = "✅ completion";
    expect(progress.terminalLanded("✅ completion")).toBe(true);
    expect(progress.terminalLanded("✅ completion\n\n⚠️ old copy left")).toBe(false);
  });

  it("r3 P2-2: the warning lands on the fresh message seconds later; the next tick clears — no edit back to the old id", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const marker = await import("../src/update-marker.js");
    const home = mkdtempSync(join(tmpdir(), "agend-2175-"));
    const saved = process.env.AGEND_HOME;
    process.env.AGEND_HOME = home;
    try {
      vi.useFakeTimers(); vi.setSystemTime(0);
      let frames = 0;
      const editMessage = vi.fn(async (_c: string, id: string) => {
        if (id !== "update-1") return;                              // the fresh message accepts edits
        if (++frames === 1) return;                                 // resume's first frame
        if (frames === 2) throw grammy429(40);                      // the next frame draws a window
        throw new Error("Bad Request: message can't be edited");    // from then on, refused for good
      });
      let post!: (v: { messageId: string; chatId: string }) => void;
      const sendText = vi.fn().mockImplementationOnce(() => new Promise(r => { post = r; }));
      const adapter = { id: "telegram", type: "telegram", editMessage, sendText } as unknown as ChannelAdapter;
      const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
      await progress.resume({ adapter, chatId: "fleet" }, "update-1");
      await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
      await progress.finish(SUMMARY);
      await vi.advanceTimersByTimeAsync(40_000);                    // background: edit refused, fresh send held
      expect(sendText).toHaveBeenCalledTimes(1);

      const target = { adapterId: "telegram", chatId: "fleet", messageId: "update-1" };
      marker.beginUpdateProgress(home, target, 0);
      const receipt = marker.markCleanupPending(home)!;
      marker.writeCleanupOutcome(home, receipt, { warning: "old copy left" });
      const { FleetManager } = await import("../src/fleet-manager.js");
      const fm = new FleetManager(home) as any;
      fm.adapters.set("telegram", adapter);
      fm.startupProgress = progress;
      const watch = { receipt, summary: SUMMARY };
      fm.updateCleanupWatch = watch;

      await fm.appendCleanupWarning(target, watch, "old copy left");  // handed over (elapsed ~46 s)
      expect(marker.readUpdateProgress(home)).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      post({ messageId: "fresh-1", chatId: "fleet" });              // the completion lands as a new message…
      await vi.advanceTimersByTimeAsync(0);                         // …and the warning text is edited onto it
      expect(editMessage).toHaveBeenLastCalledWith("fleet", "fresh-1", expect.stringContaining("old copy left"), undefined);
      const toOriginal = editMessage.mock.calls.filter(c => c[1] === "update-1").length;
      await vi.advanceTimersByTimeAsync(2_000);                     // the clock moved on before the next tick

      await fm.appendCleanupWarning(target, watch, "old copy left");
      expect(editMessage.mock.calls.filter(c => c[1] === "update-1").length).toBe(toOriginal);   // no edit back to the old id
      expect(marker.readUpdateProgress(home)).toBeNull();
      expect(fm.updateCleanupWatch).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("r3 P2-2: a different outcome (another warning) is a new text, not the frozen one", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "agend-2175-"));
    try {
      const fm = new FleetManager(home) as any;
      const handed: string[] = [];
      fm.startupProgress = { terminalLanded: () => false, replaceTerminalText: (t: string) => { handed.push(t); return true; } };
      const target = { adapterId: "telegram", chatId: "fleet", messageId: "update-1" };
      const watch = { receipt: { startedAt: 0, messageId: "update-1", operation: "update" }, summary: SUMMARY };
      await fm.appendCleanupWarning(target, watch, "first");
      await fm.appendCleanupWarning(target, watch, "first");
      await fm.appendCleanupWarning(target, watch, "second", "sudo rm x");
      expect(handed[0]).toBe(handed[1]);
      expect(handed[2]).toContain("second");
      expect(handed[2]).toContain("sudo rm x");
      await fm.appendCleanupWarning(target, watch, "second", "sudo rm y");     // same warning, another command
      expect(handed[3]).toContain("sudo rm y");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("r2 P2-2: a retry that gave up leaves the warning to the watch's own edit (it is not lost)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const marker = await import("../src/update-marker.js");
    const home = mkdtempSync(join(tmpdir(), "agend-2175-"));
    const saved = process.env.AGEND_HOME;
    process.env.AGEND_HOME = home;
    try {
      vi.useFakeTimers(); vi.setSystemTime(0);
      const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(grammy429(60));
      const adapter = { id: "telegram", type: "telegram", editMessage, sendText: vi.fn() } as unknown as ChannelAdapter;
      const progress = new RestartProgress(14, 0, logger(), { mode: "update" });
      await progress.resume({ adapter, chatId: "fleet" }, "update-1");
      await vi.advanceTimersByTimeAsync(TELEGRAM_PROGRESS_EDIT_SPACING_MS);
      await progress.finish(SUMMARY);
      const target = { adapterId: "telegram", chatId: "fleet", messageId: "update-1" };
      marker.beginUpdateProgress(home, target);
      const receipt = marker.markCleanupPending(home)!;
      marker.writeCleanupOutcome(home, receipt, { warning: "old copy left" });
      const { FleetManager } = await import("../src/fleet-manager.js");
      const fm = new FleetManager(home) as any;
      fm.adapters.set("telegram", adapter);
      fm.startupProgress = progress;
      const watch = { receipt, summary: SUMMARY };
      fm.updateCleanupWatch = watch;
      await fm.appendCleanupWarning(target, watch, "old copy left");
      expect(marker.readUpdateProgress(home)).not.toBeNull();
      await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_WINDOW_MS + 120_000);   // the retry gives up
      expect(progress.terminalDeferred).toBe(false);
      editMessage.mockResolvedValue(undefined);
      await fm.appendCleanupWarning(target, watch, "old copy left");
      expect(editMessage).toHaveBeenLastCalledWith("fleet", "update-1", expect.stringContaining("old copy left"), undefined);
      expect(marker.readUpdateProgress(home)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the cleanup-warning append hands its text to an owed completion instead of racing it; edits itself otherwise", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "agend-2175-"));
    const saved = process.env.AGEND_HOME;
    process.env.AGEND_HOME = home;
    try {
      const { FleetManager } = await import("../src/fleet-manager.js");
      const fm = new FleetManager(home) as any;
      const editMessage = vi.fn().mockResolvedValue(undefined);
      fm.adapters.set("telegram", { id: "telegram", type: "telegram", editMessage });
      const target = { adapterId: "telegram", chatId: "fleet", messageId: "update-1" };
      const watch = { receipt: { startedAt: 0, messageId: "update-1", operation: "update" }, summary: SUMMARY };
      const owed = { replaceTerminalText: vi.fn().mockReturnValue(true), terminalLanded: () => false };
      fm.startupProgress = owed;
      await fm.appendCleanupWarning(target, watch, "old copy left");
      expect(owed.replaceTerminalText).toHaveBeenCalledWith(expect.stringContaining("old copy left"));
      expect(editMessage).not.toHaveBeenCalled();
      fm.startupProgress = { replaceTerminalText: vi.fn().mockReturnValue(false), terminalLanded: () => false };
      fm.lastUpdateProgressText = null;
      await fm.appendCleanupWarning(target, watch, "old copy left");
      expect(editMessage).toHaveBeenCalledWith("fleet", "update-1", expect.stringContaining("old copy left"), undefined);
    } finally {
      if (saved === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
