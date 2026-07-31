import { describe, it, expect, vi } from "vitest";
import { HangDetector } from "../src/hang-detector.js";

// What production actually uses HangDetector for is an event bridge between the
// daemon's pane-state machine and the fleet manager's notification path.
// Daemon.start() constructs it but deliberately does NOT call start() — the comment
// there ("its legacy silence timer is intentionally not started; pane state
// transitions are now the sole source of hang events") is the contract, and the
// daemon emits "hang" itself when a pane stops changing. instance-lifecycle
// subscribes with `hangDetector.on("hang", ...)`.
//
// This file used to test the unused silence timer instead, and tested it wrongly:
// every case recorded an inbound and THEN activity, which makes the two stamps
// equal, so `lastActivityTs < lastInboundTs` never held and isHung() could not
// return true. Two cases (20 and 99 in the old file) had identical setup with
// opposite expectations, so they could never both pass.

describe("HangDetector as the daemon → fleet-manager hang bridge", () => {
  it("delivers an emitted hang event with its payload to subscribers", () => {
    const detector = new HangDetector(10);
    const seen: unknown[] = [];
    detector.on("hang", (data) => seen.push(data));

    // Exactly what daemon.ts does on a stuck pane transition.
    detector.emit("hang", { unchangedForMs: 900_000 });

    expect(seen).toEqual([{ unchangedForMs: 900_000 }]);
  });

  it("delivers every emit — the daemon owns dedupe, not the bridge", () => {
    const detector = new HangDetector(10);
    const handler = vi.fn();
    detector.on("hang", handler);

    detector.emit("hang", { unchangedForMs: 1 });
    detector.emit("hang", { unchangedForMs: 2 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("records activity, inbound and statusline updates without throwing", () => {
    // The daemon calls these from the transcript, inbound-delivery and statusline
    // paths. Nothing reads them while the timer is unused, so the contract is just
    // that they stay safe no-ops for the bridge.
    const detector = new HangDetector(10);
    expect(() => {
      detector.recordInbound();
      detector.recordActivity();
      detector.recordStatuslineUpdate();
    }).not.toThrow();
  });

  it("stop() is safe when the legacy timer was never started", () => {
    // stop() runs on every daemon shutdown, and start() is never called.
    const detector = new HangDetector(10);
    expect(() => detector.stop()).not.toThrow();
    expect(() => detector.stop()).not.toThrow();
  });

  it("the legacy silence timer still behaves if something revives it", () => {
    // Kept rather than deleted so the dormant path has a truthful spec: it must
    // fire only when an inbound went unanswered past the timeout. Note the
    // ordering — activity BEFORE the inbound is what "unanswered" means.
    vi.useFakeTimers();
    try {
      const detector = new HangDetector(1); // 1 minute
      const handler = vi.fn();
      detector.on("hang", handler);

      detector.recordActivity();
      vi.advanceTimersByTime(1000);
      detector.recordInbound();

      detector.start(1000);
      vi.advanceTimersByTime(30_000);
      expect(handler).not.toHaveBeenCalled(); // timeout not reached yet

      vi.advanceTimersByTime(61_000);
      expect(handler).toHaveBeenCalledTimes(1);

      // Answering the inbound clears the hung flag, and it does not re-fire.
      detector.recordActivity();
      vi.advanceTimersByTime(61_000);
      expect(handler).toHaveBeenCalledTimes(1);

      detector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports hung with no inbound at all", () => {
    vi.useFakeTimers();
    try {
      const detector = new HangDetector(1);
      detector.recordActivity();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(detector.isHung()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
