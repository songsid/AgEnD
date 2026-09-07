import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import { RESTART_PROGRESS_TERMINAL_TIMEOUT_MS } from "../src/restart-progress.js";

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
  const logger = { error: vi.fn() };
  const fleet = Object.create(FleetManager.prototype) as FleetManager & Record<string, any>;
  fleet.adapters = new Map([["discord", adapter]]);
  fleet.adapterState = new Map([["discord", { status: "connected", retryCount: 0 }]]);
  fleet.logger = logger;
  fleet.getPrimaryAdapterId = () => "discord";
  return { fleet, logger };
}

describe("fleet start completion fallback", () => {
  it("does not let fallback outbound wake a not-ready gateway", async () => {
    const sendText = vi.fn();
    const adapter = {
      sendText,
      getHealthSnapshot: () => health(false),
    } as unknown as ChannelAdapter;
    const { fleet, logger } = makeFleet(adapter);

    await expect((fleet as any).sendFleetStartCompletionFallback("guild", "complete", "topic"))
      .resolves.toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { adapterId: "discord" },
      "Fleet start completion fallback skipped because the primary adapter is not ready",
    );
  });

  it("bounds a fallback send that never settles", async () => {
    vi.useFakeTimers();
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

    await expect(sending).resolves.toBe(false);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { timeout_ms: RESTART_PROGRESS_TERMINAL_TIMEOUT_MS },
      "Timed out sending fleet start completion fallback",
    );
  });
});
