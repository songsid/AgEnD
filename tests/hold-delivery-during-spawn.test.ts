import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";

/**
 * Startup is not a quiet period. `dismissDialogsUntilReady` is clicking through
 * trust prompts and session pickers, and a pane showing a modal dialog produces
 * no output — so `waitUntilIdle` calls it idle and a queued message is pasted
 * *into the dialog*, where the text is discarded and the Enter picks a menu item.
 *
 * Both tmux calls "succeed", so the message vanishes without even a ❌. The pane
 * write lock does not cover this: it serialises each key sequence, but it is
 * released between one dialog and the next.
 */

function makeDaemon() {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-spawn-hold-"));
  writeFileSync(join(instanceDir, "window-id"), "@1");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("hold", {
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
    waitForSpawnToSettle(): Promise<void>;
    deliverMessage(text: string): Promise<boolean>;
    tmux: unknown;
  };
  return { daemon, internals, logger, instanceDir };
}

describe("delivery waits for an in-flight spawn", () => {
  it("returns immediately when nothing is spawning", async () => {
    const { internals, instanceDir } = makeDaemon();
    try {
      let done = false;
      await internals.waitForSpawnToSettle().then(() => { done = true; });
      expect(done).toBe(true);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("holds while a spawn is running and releases when it ends", async () => {
    const { internals, instanceDir } = makeDaemon();
    try {
      internals.beginSpawn();
      let released = false;
      const wait = internals.waitForSpawnToSettle().then(() => { released = true; });

      await new Promise(r => setTimeout(r, 20));
      expect(released).toBe(false);

      internals.endSpawn();
      await wait;
      expect(released).toBe(true);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("does not paste while the CLI is still starting up", async () => {
    const { internals, instanceDir } = makeDaemon();
    try {
      const pasteBuffer = vi.fn(async () => true);
      internals.tmux = {
        getWindowId: () => "@1",
        pasteBuffer,
        sendSpecialKey: vi.fn(async () => true),
      };

      internals.beginSpawn();
      const delivery = internals.deliverMessage("hello");
      await new Promise(r => setTimeout(r, 50));
      // This is the exact moment the message used to land in a trust dialog.
      expect(pasteBuffer).not.toHaveBeenCalled();

      internals.endSpawn();
      await delivery;
      expect(pasteBuffer).toHaveBeenCalledWith("hello");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("gives up after the cap rather than holding a message forever", async () => {
    vi.useFakeTimers();
    const { internals, logger, instanceDir } = makeDaemon();
    try {
      internals.beginSpawn(); // and never ends — a spawn that wedged
      let released = false;
      const wait = internals.waitForSpawnToSettle().then(() => { released = true; });

      await vi.advanceTimersByTimeAsync(59_000);
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await wait;

      expect(released).toBe(true);
      // Falling back to the old behaviour is a decision worth seeing in the log.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("delivering anyway"));
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("survives overlapping spawns without stranding a waiter", async () => {
    // beginSpawn is called from both the wake path and spawnClaudeWindow, and the
    // wake path calls trySpawn — so the two nest.
    const { internals, instanceDir } = makeDaemon();
    try {
      internals.beginSpawn(); // wake path
      internals.beginSpawn(); // trySpawn → spawnClaudeWindow, nested inside it
      let released = false;
      const wait = internals.waitForSpawnToSettle().then(() => { released = true; });

      internals.endSpawn(); // inner finishes; the outer is STILL dismissing dialogs
      await new Promise(r => setTimeout(r, 20));
      expect(released).toBe(false);
      expect(internals.spawning).toBe(true);

      internals.endSpawn(); // outer finishes
      await wait;
      expect(released).toBe(true);
      expect(internals.spawning).toBe(false);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
