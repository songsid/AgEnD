import { describe, expect, it } from "vitest";
import { reconnectDelayMs, RECONNECT_MAX_MS } from "../src/channel/reconnect-backoff.js";

/**
 * Guards the property that caused the incident: the MCP server must keep
 * retrying. The old schedule was 20 fixed 3s attempts then process.exit — a
 * 60s budget against restarts that take minutes, after which the agent lost
 * every agend tool for the rest of its session.
 */
describe("reconnectDelayMs", () => {
  it("backs off exponentially from 1s", () => {
    expect([1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it("caps at 30s and never grows unbounded", () => {
    for (const attempt of [6, 7, 20, 100, 10_000]) {
      expect(reconnectDelayMs(attempt)).toBe(RECONNECT_MAX_MS);
    }
  });

  it("never signals give-up — always a finite, positive delay", () => {
    for (const attempt of [1, 50, 1_000, Number.MAX_SAFE_INTEGER]) {
      const d = reconnectDelayMs(attempt);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });

  it("tolerates a non-positive attempt number", () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(-5)).toBe(1_000);
  });

  it("outlasts a realistic slow restart (142s measured) well before capping out", () => {
    // Cumulative wait must exceed the outage, so the socket's return is noticed.
    let total = 0;
    for (let a = 1; a <= 10; a++) total += reconnectDelayMs(a);
    expect(total).toBeGreaterThan(142_000 / 1.5); // ~181s of retries in 10 attempts
    // And retrying continues indefinitely past that.
    expect(reconnectDelayMs(1_000)).toBe(RECONNECT_MAX_MS);
  });
});
