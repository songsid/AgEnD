import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";

/**
 * #920: the in-lock `|| spawning` guard is load-bearing — it is NOT implied
 * by `settledClean` + the generation check.
 *
 * `waitForSpawnToSettle()` resolves `true` without yielding when no spawn is
 * in flight, but the `await` in `deliverMessage` still yields one microtask.
 * A `beginSpawn()` landing in that exact gap runs AFTER the settle verdict
 * and BEFORE the generation capture, so the capture reads the NEW generation
 * (equal — the spawn only just started) with `settledClean` still `true`.
 * Only `|| spawning` backs that write out; without it the paste lands in a
 * pane that is already being respawned.
 *
 * No real tmux here: the spawn is a controlled microtask and the pane write
 * is a recorded stub call, which makes the ordering deterministic.
 */

function makeDaemon() {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-spawning-gap-"));
  writeFileSync(join(instanceDir, "window-id"), "@1");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("gap", {
    working_directory: "/tmp",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, { getReadyPattern: () => /❯/ } as any, undefined,
    { child: () => logger } as any);
  const internals = daemon as unknown as {
    beginSpawn(): void;
    endSpawn(): void;
    spawning: boolean;
    deliverMessage(text: string): Promise<boolean>;
    tmux: unknown;
  };
  return { internals, logger, instanceDir };
}

describe("spawning guard closes the true-settle to generation-capture microtask gap", () => {
  it("backs out instead of pasting when a spawn starts inside the settle await", async () => {
    const { internals, logger, instanceDir } = makeDaemon();
    try {
      const pasteBuffer = vi.fn(async () => true);
      internals.tmux = {
        getWindowId: () => "@1",
        pasteBuffer,
        sendSpecialKey: vi.fn(async () => true),
      };

      // Queued BEFORE the delivery runs: the delivery's settle wait is
      // already-resolved (no spawn in flight → true), so its continuation
      // lands behind this callback. beginSpawn therefore runs after the
      // settle verdict and before the generation capture — the captured
      // generation is the new, equal one with settledClean still true.
      queueMicrotask(() => internals.beginSpawn());
      const delivery = internals.deliverMessage("hello");

      // The backed-out first attempt retries, and the retry's settle wait
      // logs Holding before parking on the in-flight spawn. Wait for that
      // park — or for a paste (the unguarded bug) — whichever comes first.
      const holdingLogged = () => logger.debug.mock.calls.some(args =>
        typeof args[0] === "string" && args[0].includes("Holding delivery"));
      const deadline = Date.now() + 10_000;
      while (!holdingLogged() && pasteBuffer.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      // The spawn really is in flight here: a passing test exercised the
      // guard, it did not merely outrun the delivery.
      expect(internals.spawning).toBe(true);
      if (holdingLogged()) {
        // Parked retry: give any stray write a final window, then assert
        // zero paste into the pane being respawned.
        await new Promise(r => setTimeout(r, 300));
      }
      expect(pasteBuffer).not.toHaveBeenCalled();

      internals.endSpawn();
      await delivery;
      expect(pasteBuffer).toHaveBeenCalledWith("hello");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
