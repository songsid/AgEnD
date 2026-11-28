import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubSendTiming } from "../src/hub/send-timing.js";
afterEach(() => vi.unstubAllEnvs());
describe("M-3915 opt-in phase timing", () => {
  it("is off by default without clock or logging work", () => {
    vi.stubEnv("AGEND_HUB_SEND_TIMING", "");
    const clock = vi.fn(), log = vi.fn();
    expect(createHubSendTiming(log, undefined, clock)).toBeUndefined();
    expect(clock).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it("requires the exact debug flag and an existing logger", () => {
    vi.stubEnv("AGEND_HUB_SEND_TIMING", "true"); expect(createHubSendTiming(vi.fn())).toBeUndefined();
    vi.stubEnv("AGEND_HUB_SEND_TIMING", "1"); expect(createHubSendTiming(undefined)).toBeUndefined();
    expect(createHubSendTiming(vi.fn())).toBeDefined();
  });
  it("emits only an allowlisted phase and duration, once", () => {
    const log = vi.fn(), clock = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(12.12345);
    const timing = createHubSendTiming(log, true, clock, () => NaN)!;
    const stop = timing.start("submit"); stop(); stop();
    expect(log.mock.calls).toEqual([["info", "Hub send phase timing", { phase: "submit", durationMs: 2.123 }]]);
    expect(clock).toHaveBeenCalledTimes(2);
    timing.start("private request content" as never)(); expect(log).toHaveBeenCalledTimes(1);
  });
  it("does not let a logging failure escape", () => {
    let at = 0;
    const stop = createHubSendTiming(() => { throw new Error("logger failed"); }, true, () => ++at)!.start("answer");
    expect(stop).not.toThrow(); expect(stop).not.toThrow();
  });
  it("labels CPU as an interval duration rather than exclusive async phase CPU", () => {
    const log = vi.fn(), clock = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(6);
    const cpu = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(12.5);
    createHubSendTiming(log, true, clock, cpu)!.start("audit")();
    expect(log.mock.calls).toEqual([["info", "Hub send phase timing", { phase: "audit", durationMs: 5, threadCpuIntervalMs: 2.5 }]]);
  });
  it("also isolates a diagnostic clock failure at start or finish", () => {
    const log = vi.fn();
    expect(() => createHubSendTiming(log, true, () => { throw Error("clock"); })!.start("submit")()).not.toThrow();
    const clock = vi.fn().mockReturnValueOnce(1).mockImplementationOnce(() => { throw Error("clock"); });
    expect(() => createHubSendTiming(log, true, clock, () => 0)!.start("submit")()).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1])("refuses invalid clock duration %s", duration => {
    const log = vi.fn(), clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(duration);
    createHubSendTiming(log, true, clock)!.start("relay")(); expect(log).not.toHaveBeenCalled();
  });
});
