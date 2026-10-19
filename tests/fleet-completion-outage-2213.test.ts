/**
 * #2213 (2.2.5 rehearsal, leg N): an update over a dropped link left the chat without "Fleet ready" — the completion
 * had one bounded try. Now: an adapter down at fleet start gets it once it is back (edit in place when there is a
 * message, a new one when there is none), within TERMINAL_BACKGROUND_WINDOW_MS, and a call whose outcome is unknown
 * (it timed out on our side) is never followed by a second write until it settles — no duplicate post.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../src/channel/types.js";
import { RESTART_PROGRESS_TERMINAL_TIMEOUT_MS, RestartProgress, TERMINAL_BACKGROUND_WINDOW_MS } from "../src/restart-progress.js";

afterEach(() => { vi.useRealTimers(); });
const logger = () => ({ warn: vi.fn(), error: vi.fn() });
const SUMMARY = { running: 4, total: 4, version: "2.3.0", pausedNames: [] };
const netDown = () => Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } });
/** A call we control: settle it later, or never. */
function pending<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const p = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }

describe("#2213: the fleet completion survives an outage at fleet start", () => {
  it("no progress message (a small fleet): refused while the network is down, posted once after it is back", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let up = false;
    const sendText = vi.fn(async () => { if (!up) throw netDown(); return { messageId: "m-1", chatId: "g" }; });
    const log = logger();
    const poster = new RestartProgress(0, 0, log);
    await expect(poster.postCompletion({ adapter: { sendText } as unknown as ChannelAdapter, chatId: "g", threadId: "1" }, "Fleet ready. 4/4")).resolves.toBe(true);
    expect(poster.terminalDeferred).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);                       // a five-minute outage
    const triedDuringOutage = sendText.mock.calls.length;
    expect(triedDuringOutage).toBeGreaterThan(1);
    up = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendText).toHaveBeenCalledTimes(triedDuringOutage + 1);
    expect(sendText).toHaveBeenLastCalledWith("g", "Fleet ready. 4/4", { threadId: "1" });
    expect(poster.terminalDeferred).toBe(false);
    expect(poster.terminalLanded("Fleet ready. 4/4")).toBe(true);
    await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_WINDOW_MS);
    expect(sendText, "once landed, never again").toHaveBeenCalledTimes(triedDuringOutage + 1);
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an update's progress message: the completion is an edit of it once the network is back — no new message", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let up = false;
    const editMessage = vi.fn(async () => { if (!up) throw netDown(); });
    const sendText = vi.fn(async () => { if (!up) throw netDown(); return { messageId: "other", chatId: "g" }; });
    const progress = new RestartProgress(4, 0, logger(), { mode: "update" });
    await progress.resume({ adapter: { editMessage, sendText } as unknown as ChannelAdapter, chatId: "g" }, "update-1");
    const finishing = progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    await expect(finishing).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    up = true;
    const sendsBefore = sendText.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(editMessage).toHaveBeenLastCalledWith("g", "update-1", expect.stringContaining("2.3.0"), undefined);
    expect(sendText.mock.calls.length, "the edit landed: no new message").toBe(sendsBefore);
    expect(progress.terminalDeferred).toBe(false);
  });

  it("uncertain: the post timed out on our side but had landed — no duplicate", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const first = pending<{ messageId: string; chatId: string }>();
    const sendText = vi.fn().mockReturnValueOnce(first.p).mockResolvedValue({ messageId: "dup", chatId: "g" });
    const log = logger();
    const poster = new RestartProgress(0, 0, log);
    const posting = poster.postCompletion({ adapter: { sendText } as unknown as ChannelAdapter, chatId: "g" }, "Fleet ready");
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    await expect(posting).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sendText, "nothing while its outcome is unknown").toHaveBeenCalledTimes(1);
    first.resolve({ messageId: "m-1", chatId: "g" });                  // it had landed
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount(), "landed: nothing left waiting").toBe(0);
    await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_WINDOW_MS);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(poster.terminalDeferred).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uncertain, then refused late (the connection never opened): retried, lands once", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const first = pending<{ messageId: string; chatId: string }>();
    const sendText = vi.fn().mockReturnValueOnce(first.p).mockResolvedValue({ messageId: "m-2", chatId: "g" });
    const poster = new RestartProgress(0, 0, logger());
    void poster.postCompletion({ adapter: { sendText } as unknown as ChannelAdapter, chatId: "g" }, "Fleet ready");
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS + 90_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    first.reject(netDown());                                            // the kernel gave up on the SYN
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(poster.terminalLanded("Fleet ready")).toBe(true);
    expect(vi.getTimerCount(), "landed: the wait for the first call's outcome is gone too").toBe(0);
    await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_WINDOW_MS);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("the terminal edit timed out: no fresh post beside it; refused late, the edit is retried (not a new message)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const hung = pending<void>();
    // The first edit is resume()'s "starting" frame; the second, the terminal one, hangs.
    const editMessage = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(hung.p).mockResolvedValue(undefined);
    const sendText = vi.fn();
    const progress = new RestartProgress(4, 0, logger(), { mode: "update" });
    await progress.resume({ adapter: { editMessage, sendText } as unknown as ChannelAdapter, chatId: "g" }, "update-1");
    await vi.advanceTimersByTimeAsync(0);
    const finishing = progress.finish(SUMMARY);
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    await expect(finishing).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendText).not.toHaveBeenCalled();
    hung.reject(netDown());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(editMessage).toHaveBeenLastCalledWith("g", "update-1", expect.stringContaining("2.3.0"), undefined);
    expect(sendText).not.toHaveBeenCalled();
    expect(progress.terminalDeferred).toBe(false);
  });

  it("uncertain post that lands late after a newer text was handed over: the newer text edits THAT message — no second post (Fable P2)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const first = pending<{ messageId: string; chatId: string }>();
    const sendText = vi.fn().mockReturnValueOnce(first.p).mockResolvedValue({ messageId: "dup", chatId: "g" });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const poster = new RestartProgress(0, 0, logger());
    void poster.postCompletion({ adapter: { sendText, editMessage } as unknown as ChannelAdapter, chatId: "g" }, "Fleet ready");
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    expect(poster.replaceTerminalText("Fleet ready\n\n⚠️ cleanup")).toBe(true);   // the cleanup warning, while pending
    await vi.advanceTimersByTimeAsync(60_000);
    first.resolve({ messageId: "m-late", chatId: "g" });                   // it had landed
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledExactlyOnceWith("g", "m-late", "Fleet ready\n\n⚠️ cleanup", undefined);
    expect(poster.terminalLanded("Fleet ready\n\n⚠️ cleanup")).toBe(true);
    expect(poster.terminalDeferred).toBe(false);
  });
});
