import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * notifyFleetError claimed its throttle key BEFORE attempting delivery, and the
 * delivery path returned silently when no adapter existed. So a fleet error
 * raised early in startAll() — which is exactly when startup faults happen —
 * reached nobody AND suppressed the next ten minutes of identical messages.
 *
 * Found while fixing one caller (#692); this fixes the channel itself, so every
 * caller benefits rather than each having to guard.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeFleet(opts: { withGeneral?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-nfe-"));
  dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  fm.logger = logger;
  fm.fleetConfig = {
    defaults: {}, channel: { group_id: "g1" },
    instances: opts.withGeneral === false ? {} : { general: { general_topic: true, topic_id: "t1" } },
  };
  const sendText = vi.fn().mockResolvedValue(undefined);
  const attach = () => {
    const adapter = { id: "telegram", type: "telegram", sendText } as any;
    fm.adapter = adapter;
    fm.adapters.set("telegram", adapter);
    return adapter;
  };
  return { fm, sendText, attach, logger };
}

describe("a fleet error raised before adapters exist", () => {
  it("does not consume the throttle window", () => {
    const { fm } = makeFleet();
    fm.adapter = null;                       // startAll() before startSharedAdapter

    fm.notifyFleetError("disk is full");

    expect(fm.fleetErrorNotices.size).toBe(0);
  });

  it("warns instead of vanishing", () => {
    const { fm, logger } = makeFleet();
    fm.adapter = null;

    fm.notifyFleetError("disk is full");

    // Two distinct warns, and both matter: the delivery layer says it had no
    // adapter, and notifyFleetError says it therefore kept the throttle window
    // open. A loose regex matching either would let the second be deleted
    // without any test noticing.
    const warned = JSON.stringify(logger.warn.mock.calls);
    expect(warned).toMatch(/instance topic notification not sent/i);
    expect(warned).toMatch(/not consuming the throttle window/i);
  });

  it("still reaches the operator once an adapter arrives", () => {
    // The whole point: the early attempt must not have burned the window.
    const { fm, sendText, attach } = makeFleet();
    fm.adapter = null;
    fm.notifyFleetError("disk is full");
    expect(sendText).not.toHaveBeenCalled();

    attach();
    fm.notifyFleetError("disk is full");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0][1])).toContain("disk is full");
  });

  it("does not silently count the undelivered one as suppressed", () => {
    // A suppressed counter incremented for a message nobody saw would later
    // report "N earlier occurrences" that never actually occurred to anyone.
    const { fm, sendText, attach } = makeFleet();
    fm.adapter = null;
    fm.notifyFleetError("disk is full");
    fm.notifyFleetError("disk is full");

    attach();
    fm.notifyFleetError("disk is full");

    expect(String(sendText.mock.calls[0][1])).not.toMatch(/suppressed|已抑制/i);
  });
});

describe("normal delivery is unchanged", () => {
  it("sends once and then throttles the repeat", () => {
    const { fm, sendText, attach } = makeFleet();
    attach();

    fm.notifyFleetError("same text");
    fm.notifyFleetError("same text");

    expect(sendText).toHaveBeenCalledTimes(1);   // second is throttled
    expect(fm.fleetErrorNotices.size).toBe(1);
  });

  it("falls back to the primary group when there is no General instance", () => {
    const { fm, sendText, attach } = makeFleet({ withGeneral: false });
    attach();

    fm.notifyFleetError("no general here");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0]).toBe("g1");
    expect(fm.fleetErrorNotices.size).toBe(1);
  });

  it("does not burn the window when there is neither General nor group", () => {
    const { fm, attach } = makeFleet({ withGeneral: false });
    attach();
    fm.fleetConfig.channel = {};               // no group_id anywhere

    fm.notifyFleetError("nowhere to go");

    expect(fm.fleetErrorNotices.size).toBe(0);
  });
});

describe("notifyInstanceTopic reports whether it dispatched", () => {
  it("returns false with no adapter, true once one exists", () => {
    const { fm, attach } = makeFleet();
    fm.adapter = null;
    expect(fm.notifyInstanceTopic("general", "hi")).toBe(false);

    attach();
    expect(fm.notifyInstanceTopic("general", "hi")).toBe(true);
  });

  it("returns false when no group id can be resolved", () => {
    const { fm, attach } = makeFleet();
    attach();
    fm.fleetConfig.channel = {};
    fm.fleetConfig.instances.general.topic_id = undefined;

    expect(fm.notifyInstanceTopic("general", "hi")).toBe(false);
  });
});
