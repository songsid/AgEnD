/**
 * #2482: the delivery idle gate's timeout is the normal case for a busy target (its CLI queues the message): INFO.
 * A WARN only for a likely anomaly. The host data behind it is in src/idle-gate-log.ts.
 */
import { describe, expect, it } from "vitest";
import { STUCK_QUIET_MS, STUCK_WORKING_MS, idleGateTimeoutLog } from "../src/idle-gate-log.js";

const NOW = 1_800_000_000_000;
const snap = (state: "working" | "idle" | "starting", busyMs: number, stillMs: number) =>
  ({ state, stateChangedAt: NOW - busyMs, unchangedForMs: stillMs, observedAt: NOW - 1000 }) as never;

describe("#2482 idle-gate timeout: what it says", () => {
  it("a target mid-turn (working, its pane moving): INFO, with how long it has been busy", () => {
    expect(idleGateTimeoutLog("w", 60_000, snap("working", 8 * 60_000, 3_000), NOW)).toEqual({
      level: "info", message: "Delivering to a busy target; its CLI reads it after the current turn",
      fields: { instanceName: "w", timeoutMs: 60_000, busyForMs: 8 * 60_000, paneStillForMs: 3_000 },
    });
  });
  it("a long task is still the normal case while its pane moves; or a still pane on a shorter one", () => {
    expect(idleGateTimeoutLog("w", 60_000, snap("working", 6 * STUCK_WORKING_MS, 60_000), NOW).level).toBe("info");
    expect(idleGateTimeoutLog("w", 60_000, snap("working", STUCK_WORKING_MS - 1, 2 * STUCK_QUIET_MS), NOW).level).toBe("info");
  });
  it("working for an hour with a pane still for ten minutes: a WARN — the detection may be stuck", () => {
    expect(idleGateTimeoutLog("w", 60_000, snap("working", STUCK_WORKING_MS, STUCK_QUIET_MS), NOW)).toMatchObject({
      level: "warn", message: "Idle gate timed out on a target working for an hour with a still pane; forcing delivery",
    });
  });
  it("a target that is not working at all, or unknown: the WARN as before, naming the state", () => {
    expect(idleGateTimeoutLog("w", 60_000, snap("starting", 1, 1), NOW)).toEqual({
      level: "warn", message: "Idle gate timed out; forcing delivery", fields: { instanceName: "w", timeoutMs: 60_000, state: "starting" },
    });
    expect(idleGateTimeoutLog("w", 60_000, undefined, NOW).fields).toEqual({ instanceName: "w", timeoutMs: 60_000, state: "unknown" });
  });
  it("a state changed in the future (another process's clock) counts as busy for 0", () => {
    expect(idleGateTimeoutLog("w", 60_000, snap("working", -5_000, 0), NOW).fields.busyForMs).toBe(0);
  });
});
