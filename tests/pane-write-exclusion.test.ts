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
      // Promoted from debug to info: whether the runtime dismisser ever gets the
      // lock is exactly what a "dialog was never auto-dismissed" report needs.
      expect(logger.info).toHaveBeenCalledWith(
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

  it("backs out and retries a delivery when a spawn starts after its settle wait", async () => {
    // Exit 1: a delivery that passed waitForSpawnToSettle queues behind the
    // pane lock; a spawn (e.g. a concurrent wake) completes while it waits.
    // Pasting on would write into the replacement process's first screen, so
    // the delivery must detect the generation change inside the lock, exit
    // without waiting (startup dismissal needs the lock), and redo itself
    // from the top — exactly once, with no duplicate paste.
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-pane-excl-race-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const { root } = makeLogger();
    const daemon = new Daemon("spawn-race", CONFIG, instanceDir, false, { getReadyPattern: () => /❯/ } as any, undefined, root);
    const internals = daemon as any;
    const pastes: string[] = [];
    internals.tmux = {
      getWindowId: () => "@1",
      capturePane: async () => "❯",
      pasteBuffer: vi.fn(async (text: string) => { pastes.push(text); return true; }),
      sendSpecialKey: vi.fn(async () => true),
    };
    const lock = internals.paneWriteLock;
    const origRun = lock.run.bind(lock);
    let lockRuns = 0;
    lock.run = async (fn: any) => { lockRuns++; return origRun(fn); };
    const origSettle = internals.waitForSpawnToSettle.bind(internals);
    let settles = 0;
    // Preserve the real boolean: a post-increment counter alone would return 0
    // (falsy) on the first call and fake an unsettled wait.
    internals.waitForSpawnToSettle = async () => { const r = await origSettle(); settles++; return r; };
    try {
      // Hold the lock so the delivery queues behind it.
      let release!: () => void;
      const holder = lock.run(async () => { await new Promise<void>(r => { release = r; }); });
      await Promise.resolve();
      const delivered = internals.deliverMessage("hello race");
      await vi.waitFor(() => expect(settles).toBe(1), { timeout: 5_000 });
      // A concurrent spawn completes while the delivery is queued.
      internals.beginSpawn();
      internals.endSpawn();
      release();
      await expect(delivered).resolves.toBe(true);
      await holder;
      // Re-settled and redone from the top: fresh window id, fresh probes.
      expect(settles).toBe(2);
      expect(lockRuns).toBeGreaterThanOrEqual(2);
      // And still exactly one paste — the retry redoes, never duplicates.
      expect(pastes).toEqual(["hello race"]);
    } finally {
      internals.freezeRuntimeMonitors();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  }, 20_000);

  function makeSpawnCapDaemon(name: string) {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-pane-excl-spawncap-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const { root } = makeLogger();
    const daemon = new Daemon(name, CONFIG, instanceDir, false, { getReadyPattern: () => /❯/ } as any, undefined, root);
    const internals = daemon as any;
    const pastes: string[] = [];
    internals.tmux = {
      getWindowId: () => "@1",
      capturePane: async () => "❯",
      pasteBuffer: vi.fn(async (text: string) => { pastes.push(text); return true; }),
      sendSpecialKey: vi.fn(async () => true),
    };
    return { internals, instanceDir, pastes };
  }

  it("never pastes while a spawn runs past the settle cap in one generation", async () => {
    // Round-4 exit: the spawn neither finishes nor bumps the generation again,
    // so every settle wait times out with spawning still true. Each round must
    // back out and the delivery must end in honest failure — zero pastes, even
    // though the generation never changes (the churn test above cannot see this).
    const { internals, instanceDir, pastes } = makeSpawnCapDaemon("spawn-stuck");
    try {
      internals.beginSpawn();
      const realSettle = internals.waitForSpawnToSettle.bind(internals);
      internals.waitForSpawnToSettle = () => realSettle(150);
      await expect(internals.deliverMessage("hello stuck")).resolves.toBe(false);
      expect(pastes).toEqual([]);
    } finally {
      internals.endSpawn();
      internals.freezeRuntimeMonitors();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("still backs out when the spawn completes right after the settle cap", async () => {
    // The settle wait timed out, but the spawn finished before the pane write:
    // spawning is false and the generation matches, yet nothing ever observed
    // the completed spawn — so the current generation is still not settled
    // evidence and the delivery must redo itself, not paste on stale verdicts.
    const { internals, instanceDir, pastes } = makeSpawnCapDaemon("spawn-late-finish");
    let calls = 0;
    try {
      internals.waitForSpawnToSettle = async () => { calls++; return false; };
      await expect(internals.deliverMessage("hello late")).resolves.toBe(false);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(pastes).toEqual([]);
    } finally {
      internals.freezeRuntimeMonitors();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails loudly instead of retrying forever when spawns keep churning", async () => {
    // The spawn-race retry must terminate: every lock acquisition sees a new
    // generation, so after the bounded rounds the delivery reports failure
    // with nothing ever pasted — not a hang, not a write into churn.
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-pane-excl-churn-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const { root } = makeLogger();
    const daemon = new Daemon("spawn-churn", CONFIG, instanceDir, false, { getReadyPattern: () => /❯/ } as any, undefined, root);
    const internals = daemon as any;
    const pastes: string[] = [];
    internals.tmux = {
      getWindowId: () => "@1",
      capturePane: async () => "❯",
      pasteBuffer: vi.fn(async (text: string) => { pastes.push(text); return true; }),
      sendSpecialKey: vi.fn(async () => true),
    };
    const lock = internals.paneWriteLock;
    const origRun = lock.run.bind(lock);
    lock.run = async (fn: any) => {
      internals.beginSpawn();
      internals.endSpawn();
      return origRun(fn);
    };
    try {
      await expect(internals.deliverMessage("hello churn")).resolves.toBe(false);
      expect(pastes).toEqual([]);
    } finally {
      internals.freezeRuntimeMonitors();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  }, 20_000);
});
