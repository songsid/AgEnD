import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";

/**
 * `confirmBusyAfterEnter` returning false does not mean "no output". The caller
 * reads it as **"pasted but never submitted"**, which re-sends Enter and then
 * reports ❌ for the message. So a false negative costs a possible double submit
 * plus a failure notice for a message that actually arrived.
 *
 * A control-mode reconnect produced exactly that: `connect()` drops every output
 * timestamp, so `hasOutputSince` answers false for a pane that did react — the
 * evidence was discarded, not absent.
 */

function makeDaemon(control: unknown) {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-confirm-busy-"));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("cb", {
    working_directory: "/tmp",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, { getReadyPattern: () => /❯/ } as any, control as any,
    { child: () => logger } as any);
  return { daemon, instanceDir, confirm: (since: number) =>
    (daemon as any).confirmBusyAfterEnter("@1", since) as Promise<boolean> };
}

/** Minimal stand-in for the parts of TmuxControlClient this path uses. */
function fakeControl() {
  return {
    lastOutputAt: 0,
    observationResetAt: 0,
    hasOutputSince(_w: string, ts: number) { return this.lastOutputAt > ts; },
    getObservationResetAt() { return this.observationResetAt; },
    /** What connect() does: forget every timestamp and note when. */
    reset(at: number) { this.lastOutputAt = 0; this.observationResetAt = at; },
  };
}

describe("confirmBusyAfterEnter", () => {
  it("confirms as soon as the pane reacts", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    const { confirm, instanceDir } = makeDaemon(control);
    try {
      const enterAt = Date.now();
      const pending = confirm(enterAt);
      control.lastOutputAt = enterAt + 10;
      await vi.advanceTimersByTimeAsync(400);
      expect(await pending).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("still reports a genuinely silent pane as unsubmitted", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    const { confirm, instanceDir } = makeDaemon(control);
    try {
      const pending = confirm(Date.now());
      await vi.advanceTimersByTimeAsync(3_000);
      // No reconnect, no output: the original conclusion is sound and must stand.
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("does not count blind time after a reconnect as silence", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    const { confirm, instanceDir } = makeDaemon(control);
    try {
      const enterAt = Date.now();
      const pending = confirm(enterAt);

      // Control mode reconnects almost immediately and wipes the output history.
      // The CLI *did* react to the Enter; the record of it is simply gone.
      await vi.advanceTimersByTimeAsync(200);
      control.reset(Date.now());

      // Output is recorded again ~1.9s later, once the client has re-resolved the
      // pane. That is past the original 10 × 200ms budget, so the old code had
      // already concluded "pasted but never submitted" — re-sending Enter and
      // reporting ❌ for a message that had in fact been delivered.
      await vi.advanceTimersByTimeAsync(1_900);
      control.lastOutputAt = Date.now();
      await vi.advanceTimersByTimeAsync(400);

      expect(await pending).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("gives up at the hard cap even while reconnects keep restarting the poll", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    const { confirm, instanceDir } = makeDaemon(control);
    try {
      // Record the answer as it lands. A Promise.race against an already-resolved
      // sentinel cannot be used here: the sentinel wins the microtask queue even
      // when `pending` is settled, so the check would always read "still waiting".
      let result: boolean | undefined;
      const pending = confirm(Date.now()).then(v => { result = v; return v; });

      // A reconnect loop. Without the wall-clock ceiling every one of these buys
      // another full budget, so the confirmation never ends — and it holds the
      // pane write lock for as long as it runs.
      for (let i = 0; i < 100; i++) {
        control.reset(Date.now());
        await vi.advanceTimersByTimeAsync(200);
      }

      // 20s of reconnects, well past the 10s cap: it must have given up already,
      // rather than still waiting for a quiet moment that never comes.
      expect(result).toBe(false);
      await pending;
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
