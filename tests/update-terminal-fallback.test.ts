import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import { RESTART_PROGRESS_TERMINAL_TIMEOUT_MS, TERMINAL_BACKGROUND_WINDOW_MS } from "../src/restart-progress.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

function makeFleet(adapter: ChannelAdapter) {
  const logger = { error: vi.fn(), warn: vi.fn() };
  const fleet = Object.create(FleetManager.prototype) as FleetManager & Record<string, any>;
  // `adapters` is readonly on FleetManager; the view says what is being
  // written instead of switching off checking for the whole object.
  (fleet as unknown as { adapters: Map<string, ChannelAdapter> }).adapters = new Map([["discord", adapter]]);
  fleet["adapterState"] = new Map([["discord", { status: "connected", retryCount: 0 }]]);
  fleet.logger = logger as unknown as FleetManager["logger"];
  fleet["getPrimaryAdapterId"] = () => "discord";
  return { fleet, logger };
}

describe("fleet start completion fallback", () => {
  it("does not let fallback outbound wake a not-ready gateway — it waits (#2213), then posts once when it is ready", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let ready = false;
    const sendText = vi.fn().mockResolvedValue({ messageId: "done-1", chatId: "guild" });
    const adapter = {
      sendText,
      getHealthSnapshot: () => health(ready),
    } as unknown as ChannelAdapter;
    const { fleet, logger } = makeFleet(adapter);

    const sending = (fleet as any).sendFleetStartCompletionFallback("guild", "complete", "topic");
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS);
    await expect(sending).resolves.toBe(true);                  // owed by the background retry, startup goes on
    expect(sendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sendText, "never while the gateway is not ready").not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendText).toHaveBeenCalledExactlyOnceWith("guild", "complete", { threadId: "topic" });
    await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_WINDOW_MS);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a fallback send that never settles, and never posts a second one beside it (#2213)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sendText = vi.fn().mockReturnValue(new Promise(() => {}));
    const adapter = {
      sendText,
      getHealthSnapshot: () => health(true),
    } as unknown as ChannelAdapter;
    const { fleet, logger } = makeFleet(adapter);

    const sending = (fleet as any).sendFleetStartCompletionFallback("guild", "complete", "topic");
    await vi.advanceTimersByTimeAsync(RESTART_PROGRESS_TERMINAL_TIMEOUT_MS - 1);
    let settled = false;
    void sending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(sending).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(TERMINAL_BACKGROUND_WINDOW_MS + 60_000);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      { window_ms: TERMINAL_BACKGROUND_WINDOW_MS },
      "Fleet completion call never settled in the background window — its outcome is unknown",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an adapter with no health snapshot (Telegram) follows the fleet's connection state: nothing while it reconnects (#2213)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sendText = vi.fn().mockResolvedValue({ messageId: "done-1", chatId: "group" });
    const { fleet } = makeFleet({ sendText } as unknown as ChannelAdapter);
    fleet["adapterState"] = new Map([["discord", { status: "retrying", retryCount: 3 }]]);

    const sending = (fleet as any).sendFleetStartCompletionFallback("group", "complete", "1");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await expect(sending).resolves.toBe(true);
    expect(sendText).not.toHaveBeenCalled();
    fleet["adapterState"] = new Map([["discord", { status: "connected", retryCount: 0 }]]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendText).toHaveBeenCalledExactlyOnceWith("group", "complete", { threadId: "1" });
  });
});
