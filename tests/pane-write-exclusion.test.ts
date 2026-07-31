import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";

/**
 * Regression cover for pane-write interleaving.
 *
 * A delivery is `paste-buffer → settle → Enter`. Three other subsystems used to
 * write into the same pane without coordination, so an auto-dismissed runtime
 * dialog could fire its `Escape` between the paste and the Enter — discarding a
 * message the user had already been told (👀) was delivered.
 */

const CONFIG = {
  working_directory: "/tmp",
  restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
  context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
  log_level: "silent",
} as any;

function makeLogger() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, root: { child: () => logger } as any };
}

/** Records the order of every write that reaches the pane. */
function makeRecordingTmux(writes: string[]) {
  return {
    getWindowId: () => "@1",
    isWindowAlive: vi.fn(async () => true),
    capturePane: vi.fn(async () => "Rate limit reached — switch model?"),
    sendSpecialKey: vi.fn(async (key: string) => { writes.push(`key:${key}`); return true; }),
    sendKeys: vi.fn(async (text: string) => { writes.push(`keys:${text}`); return true; }),
    pasteText: vi.fn(async (text: string) => { writes.push(`paste:${text}`); return true; }),
    pasteBuffer: vi.fn(async (text: string) => { writes.push(`buffer:${text}`); return true; }),
  };
}

const DIALOG_BACKEND = {
  getReadyPattern: () => /READY/,
  getErrorPatterns: () => [],
  getRuntimeDialogs: () => [
    { pattern: /switch model\?/, keys: ["Escape"], description: "rate limit model switch" },
  ],
} as any;

describe("pane write exclusion", () => {
  it("defers runtime-dialog dismissal while a pane write is in flight", async () => {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-pane-excl-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const { logger, root } = makeLogger();
    const writes: string[] = [];
    const tmux = makeRecordingTmux(writes);
    const daemon = new Daemon("dialog-defer", CONFIG, instanceDir, false, DIALOG_BACKEND, undefined, root);
    (daemon as any).tmux = tmux;

    try {
      // A delivery is mid-transaction: text pasted, Enter not yet sent.
      let finishDelivery!: () => void;
      const delivery = (daemon as any).paneWriteLock.run(async () => {
        writes.push("buffer:user message");
        await new Promise<void>(r => { finishDelivery = r; });
        writes.push("key:Enter");
      });
      await Promise.resolve();

      (daemon as any).startErrorMonitor();
      // Two full poll cycles, both landing inside the delivery.
      await vi.waitFor(() => expect(tmux.capturePane).toHaveBeenCalled(), { timeout: 8_000 });

      // The dialog was on screen the whole time and was NOT dismissed: an Escape
      // here would have thrown away the pasted message.
      expect(writes).toEqual(["buffer:user message"]);
      expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ dialog: "rate limit model switch" }),
        expect.stringContaining("deferred"),
      );

      finishDelivery();
      await delivery;

      // Once the pane is free the very next tick dismisses it — deferral costs a
      // poll interval, it does not drop the dismissal.
      await vi.waitFor(() => expect(writes).toContain("key:Escape"), { timeout: 8_000 });
      expect(writes).toEqual(["buffer:user message", "key:Enter", "key:Escape"]);
    } finally {
      (daemon as any).freezeRuntimeMonitors();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("holds the pane lock across the paste→Enter transaction of a delivery", async () => {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-pane-excl-tx-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const { root } = makeLogger();
    const writes: string[] = [];
    const tmux = makeRecordingTmux(writes);
    const daemon = new Daemon("delivery-tx", CONFIG, instanceDir, false, DIALOG_BACKEND, undefined, root);
    (daemon as any).tmux = tmux;

    try {
      // Something else owns the pane (e.g. the startup trust dialog being cleared).
      let release!: () => void;
      const holder = (daemon as any).paneWriteLock.run(async () => {
        writes.push("key:Up");
        await new Promise<void>(r => { release = r; });
        writes.push("key:Enter");
      });
      await Promise.resolve();

      const delivered = (daemon as any).deliverMessage("hello");
      // Give the delivery every chance to jump in front of the holder.
      await new Promise(r => setTimeout(r, 50));
      expect(tmux.pasteBuffer).not.toHaveBeenCalled();

      release();
      await holder;
      await delivered;

      // The dialog sequence completed before the paste started — no interleave.
      expect(writes.slice(0, 3)).toEqual(["key:Up", "key:Enter", "buffer:hello"]);
    } finally {
      (daemon as any).freezeRuntimeMonitors();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  }, 20_000);
});
