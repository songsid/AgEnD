import { describe, expect, it, vi } from "vitest";
import { HangDetector } from "../src/hang-detector.js";

// HangDetector is only the bridge that carries "this instance looks hung" from the
// daemon's pane-state machine to the fleet manager. The daemon emits `hang` itself
// when a pane stops changing; instance-lifecycle subscribes and notifies.
//
// It used to also hold a silence-timer state machine that never ran (start() was
// never called anywhere, so isHung() was unreachable and its timestamps were written
// and never read). That half is gone, along with the tests that exercised it — two of
// which had identical setup and contradictory expectations, which can only pass
// unnoticed when neither runs against anything real.

describe("HangDetector", () => {
  it("delivers an emitted hang event with its payload to subscribers", () => {
    const detector = new HangDetector();
    const seen: unknown[] = [];
    detector.on("hang", d => seen.push(d));

    // Exactly what daemon.ts does on a stuck pane transition.
    detector.emit("hang", { unchangedForMs: 900_000 });

    expect(seen).toEqual([{ unchangedForMs: 900_000 }]);
  });

  it("delivers every emit — the daemon owns dedupe, not the bridge", () => {
    const detector = new HangDetector();
    const handler = vi.fn();
    detector.on("hang", handler);

    detector.emit("hang", { unchangedForMs: 1 });
    detector.emit("hang", { unchangedForMs: 2 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("emitting with no subscriber is harmless", () => {
    // The daemon emits unconditionally; lifecycle may not have subscribed yet.
    const detector = new HangDetector();
    expect(() => detector.emit("hang", { unchangedForMs: 1 })).not.toThrow();
  });

  it("takes no constructor arguments", () => {
    // The old `timeoutMinutes` parameter was ignored: the stuck timeout the pane
    // monitor uses is resolved separately.
    expect(HangDetector.length).toBe(0);
  });
});
