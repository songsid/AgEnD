import { describe, expect, it } from "vitest";
import { FirstDeliveryDelay } from "../src/daemon.js";

describe("FirstDeliveryDelay", () => {
  it("extends only the first Enter shortly after the CLI becomes ready", () => {
    const gate = new FirstDeliveryDelay();
    gate.recordReady(10_000);

    expect(gate.consume(11_000)).toBe(1_750);
    expect(gate.consume(11_001)).toBe(500);
  });

  it("keeps normal latency when the first delivery arrives after the cooldown window", () => {
    const gate = new FirstDeliveryDelay();
    gate.recordReady(10_000);

    expect(gate.consume(15_000)).toBe(500);
    expect(gate.consume(15_001)).toBe(500);
  });

  it("re-arms after each ready transition, including wake and crash recovery", () => {
    const gate = new FirstDeliveryDelay();
    gate.recordReady(1_000);
    expect(gate.consume(1_100)).toBe(1_750);

    gate.recordReady(20_000);
    expect(gate.consume(20_200)).toBe(1_750);
    expect(gate.consume(20_300)).toBe(500);
  });

  it("re-arm is idempotent: calling recordReady twice before consume only costs the one consume", () => {
    // Matches the mid-session Luna Reserve case: finishStartupScan called
    // recordReady once, then waitForInputTransientToClear calls it again when
    // the transient clears — the pending delivery consumes the 1750ms once.
    const gate = new FirstDeliveryDelay();
    gate.recordReady(1_000);
    gate.recordReady(1_100); // second arm (transient cleared)
    expect(gate.consume(1_200)).toBe(1_750); // one consume
    expect(gate.consume(1_300)).toBe(500);   // subsequent: normal
  });
});
