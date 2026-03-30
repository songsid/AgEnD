import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HangDetector } from "../src/hang-detector.js";

describe("HangDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flag as hung when activity is recent", () => {
    const detector = new HangDetector(15);
    detector.recordInbound();
    detector.recordActivity();
    expect(detector.isHung()).toBe(false);
  });

  it("flags as hung after timeout with no activity", () => {
    const detector = new HangDetector(15);
    detector.recordInbound();
    detector.recordActivity();
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(detector.isHung()).toBe(true);
  });

  it("resets hung state on new activity", () => {
    const detector = new HangDetector(15);
    detector.recordInbound();
    detector.recordActivity();
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(detector.isHung()).toBe(true);
    detector.recordActivity();
    expect(detector.isHung()).toBe(false);
  });

  it("emits hang event once when timeout is reached", () => {
    const detector = new HangDetector(15);
    const handler = vi.fn();
    detector.on("hang", handler);
    detector.recordInbound();
    detector.recordActivity();
    detector.start(60_000);

    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // Additional check intervals should not re-emit
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);

    detector.stop();
  });

  it("does not emit hang again until activity resumes and times out again", () => {
    const detector = new HangDetector(15);
    const handler = vi.fn();
    detector.on("hang", handler);
    detector.recordInbound();
    detector.recordActivity();
    detector.start(60_000);

    // First hang
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // Resume activity
    detector.recordInbound();
    detector.recordActivity();

    // Wait for another timeout
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(handler).toHaveBeenCalledTimes(2);

    detector.stop();
  });

  it("not hung if statusline is fresh even if transcript is stale", () => {
    const detector = new HangDetector(15);
    detector.recordInbound();
    detector.recordActivity();

    // Advance past timeout
    vi.advanceTimersByTime(16 * 60 * 1000);

    // But statusline was updated recently
    detector.recordStatuslineUpdate();
    expect(detector.isHung()).toBe(false);
  });

  it("not hung if no inbound message was ever received", () => {
    const detector = new HangDetector(15);
    detector.recordActivity();
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(detector.isHung()).toBe(false);
  });

  it("not hung if last inbound was long ago (idle instance)", () => {
    const detector = new HangDetector(15);
    detector.recordInbound();
    detector.recordActivity();
    // Advance well past 2x timeout — instance is idle, not hung
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(detector.isHung()).toBe(false);
  });
});
