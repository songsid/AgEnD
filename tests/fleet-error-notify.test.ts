import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

// A fleet that survives an unhandled rejection must not do so quietly — the
// operator should not have to read daemon.log to learn a fault was swallowed. But
// these arrive from loops (pollers, repeating timers), so the notification is
// throttled per distinct message: spamming the General topic is worse than silence.

function fm(overrides: Record<string, unknown> = {}) {
  const instance = new FleetManager(mkdtempSync(join(tmpdir(), "agend-notify-")));
  Object.assign(instance, overrides);
  return instance;
}

describe("notifyFleetError", () => {
  it("sends to the General instance's topic", () => {
    const notify = vi.fn();
    const manager = fm({ notifyInstanceTopic: notify });
    (manager as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: {},
      instances: { dispatcher: { general_topic: true } },
    };

    manager.notifyFleetError("boom");

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("dispatcher");
    expect(notify.mock.calls[0][1]).toContain("boom");
  });

  it("throttles repeats of the same message, then reports how many were suppressed", () => {
    const notify = vi.fn();
    const manager = fm({ notifyInstanceTopic: notify });
    (manager as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: {},
      instances: { dispatcher: { general_topic: true } },
    };

    manager.notifyFleetError("same fault");
    manager.notifyFleetError("same fault");
    manager.notifyFleetError("same fault");
    expect(notify).toHaveBeenCalledTimes(1);

    // Past the window, the next one goes out and mentions the suppressed count.
    const notices = (manager as unknown as { fleetErrorNotices: Map<string, { at: number; suppressed: number }> }).fleetErrorNotices;
    const entry = notices.get("same fault")!;
    entry.at = Date.now() - 11 * 60_000;

    manager.notifyFleetError("same fault");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][1]).toContain("plus 2 more");
  });

  it("does not throttle a different message", () => {
    const notify = vi.fn();
    const manager = fm({ notifyInstanceTopic: notify });
    (manager as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: {},
      instances: { dispatcher: { general_topic: true } },
    };

    manager.notifyFleetError("fault A");
    manager.notifyFleetError("fault B");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("bounds the throttle map so varying messages cannot grow it forever", () => {
    const notify = vi.fn();
    const manager = fm({ notifyInstanceTopic: notify });
    (manager as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: {},
      instances: { dispatcher: { general_topic: true } },
    };

    for (let i = 0; i < 150; i++) manager.notifyFleetError(`fault ${i}`);
    const notices = (manager as unknown as { fleetErrorNotices: Map<string, unknown> }).fleetErrorNotices;
    expect(notices.size).toBeLessThanOrEqual(100);
  });

  it("does not throw when there is no General instance and no adapter", () => {
    const manager = fm();
    (manager as unknown as { fleetConfig: unknown }).fleetConfig = { defaults: {}, instances: {} };
    expect(() => manager.notifyFleetError("nowhere to send this")).not.toThrow();
  });
});
