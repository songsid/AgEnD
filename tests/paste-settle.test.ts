import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, waitForPasteSettle } from "../src/daemon.js";

/**
 * A fixed post-paste delay is a bet that the TUI has consumed the paste by the
 * time it expires — and the first delivery after CLI startup is where that bet
 * loses (#309): an Enter landing while the TUI is still chewing on the
 * bracketed paste is absorbed instead of submitting. The adaptive settle
 * replaces the bet with observation: send Enter only once the paste's own
 * render has been quiet for 500ms, bounded below by the legacy fixed delay
 * (pane never echoed) and above by a 3s hard cap (pane never goes quiet).
 */

afterEach(() => { vi.useRealTimers(); });

/** Minimal stand-in for the slice of TmuxControlClient the settle reads. */
function fakeControl() {
  return {
    lastOutputAt: undefined as number | undefined,
    observationResetAt: 0,
    getLastOutputAt(_w: string) { return this.lastOutputAt; },
    getObservationResetAt() { return this.observationResetAt; },
    hasOutputSince(_w: string, ts: number) { return this.lastOutputAt != null && this.lastOutputAt > ts; },
  };
}

describe("waitForPasteSettle", () => {
  it("outwaits a slow TUI: Enter is held until the paste render goes quiet", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    let result: Awaited<ReturnType<typeof waitForPasteSettle>> | undefined;
    void waitForPasteSettle(control, "@1", Date.now(), 500).then(r => { result = r; });

    // The pane keeps reacting to the paste at 200 / 600 / 900ms.
    await vi.advanceTimersByTimeAsync(200); control.lastOutputAt = Date.now();
    await vi.advanceTimersByTimeAsync(400); control.lastOutputAt = Date.now();
    await vi.advanceTimersByTimeAsync(300); control.lastOutputAt = Date.now();

    // 1300ms in — well past the fixed 500ms — it must still be waiting,
    // because the last render was only 400ms ago.
    await vi.advanceTimersByTimeAsync(400);
    expect(result).toBeUndefined();

    // Quiet since 900ms; the 500ms quiet threshold lands at 1400ms.
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBeDefined();
    expect(result).toMatchObject({ observedPostPasteOutput: true, capHit: false, usedFallback: false });
    expect(result!.settleMs).toBeGreaterThanOrEqual(1400);
    expect(result!.settleMs).toBeLessThanOrEqual(1500);
  });

  it("keeps timing close to the legacy 500ms when the paste settles immediately", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    let result: Awaited<ReturnType<typeof waitForPasteSettle>> | undefined;
    void waitForPasteSettle(control, "@1", Date.now(), 500).then(r => { result = r; });

    await vi.advanceTimersByTimeAsync(50); control.lastOutputAt = Date.now();
    await vi.advanceTimersByTimeAsync(600);

    expect(result).toBeDefined();
    expect(result).toMatchObject({ observedPostPasteOutput: true, usedFallback: false });
    expect(result!.settleMs).toBeLessThanOrEqual(650);
  });

  it("falls back to the fixed delay when the paste never visibly renders", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    // Stale output from before the paste must not count as a reaction to it.
    control.lastOutputAt = Date.now() - 5_000;
    let result: Awaited<ReturnType<typeof waitForPasteSettle>> | undefined;
    void waitForPasteSettle(control, "@1", Date.now(), 1_750).then(r => { result = r; });

    await vi.advanceTimersByTimeAsync(1_700);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toBeDefined();
    expect(result).toMatchObject({ observedPostPasteOutput: false, capHit: false, usedFallback: true });
    expect(result!.settleMs).toBe(1_750);
  });

  it("gives up at the hard cap when the pane never goes quiet", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    let result: Awaited<ReturnType<typeof waitForPasteSettle>> | undefined;
    void waitForPasteSettle(control, "@1", Date.now(), 500).then(r => { result = r; });

    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(100);
      control.lastOutputAt = Date.now();
      if (result) break;
    }

    expect(result).toBeDefined();
    expect(result).toMatchObject({ observedPostPasteOutput: true, capHit: true, usedFallback: false });
    expect(result!.settleMs).toBeGreaterThanOrEqual(3_000);
    expect(result!.settleMs).toBeLessThanOrEqual(3_100);
  });

  it("degrades to the fixed delay when a reconnect wipes the output timeline mid-wait", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    let result: Awaited<ReturnType<typeof waitForPasteSettle>> | undefined;
    void waitForPasteSettle(control, "@1", Date.now(), 500).then(r => { result = r; });

    // Reconnect at 200ms: everything observed before this is gone, so "quiet"
    // would be indistinguishable from "blind". The wait must not trust it.
    await vi.advanceTimersByTimeAsync(200);
    control.observationResetAt = Date.now();
    control.lastOutputAt = undefined;

    await vi.advanceTimersByTimeAsync(400);
    expect(result).toBeDefined();
    expect(result).toMatchObject({ capHit: false, usedFallback: true });
    expect(result!.settleMs).toBe(500);
  });

  it("returns immediately on a reconnect discovered after the fallback delay already elapsed", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    let result: Awaited<ReturnType<typeof waitForPasteSettle>> | undefined;
    void waitForPasteSettle(control, "@1", Date.now(), 500).then(r => { result = r; });

    // Output keeps the quiet-wait alive past the fallback deadline…
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(100);
      control.lastOutputAt = Date.now();
    }
    // …then the reconnect erases it all. No further waiting is owed.
    control.observationResetAt = Date.now();
    await vi.advanceTimersByTimeAsync(100);

    expect(result).toBeDefined();
    expect(result).toMatchObject({ observedPostPasteOutput: true, usedFallback: true });
    expect(result!.settleMs).toBeLessThanOrEqual(1_000);
  });
});

/**
 * Integration: writeMessageToPane must route queue-less deliveries through the
 * adaptive settle, and leave the codex native-queue handoff on fixed timing
 * (its paste lands while the CLI is busy generating — output never goes quiet,
 * so an adaptive wait would only ever hit the cap).
 */
describe("writeMessageToPane settle routing", () => {
  function makeDaemon(control: unknown) {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-paste-settle-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("ps", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /❯/ } as any, control as any,
      { child: () => logger } as any);
    return { daemon, instanceDir };
  }

  it("holds Enter until quiet for a queue-less delivery on a slow-rendering TUI", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    const { daemon, instanceDir } = makeDaemon(control);
    const enters: number[] = [];
    (daemon as any).tmux = {
      pasteBuffer: async () => true,
      sendSpecialKey: async (key: string) => { if (key === "Enter") enters.push(Date.now()); return true; },
    };
    try {
      const start = Date.now();
      const pending = (daemon as any).writeMessageToPane("hello world", "@1", false) as Promise<boolean>;

      // TUI chews on the paste for 1.2s — the fixed 500ms delay would have
      // fired Enter straight into this window.
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(100);
        control.lastOutputAt = Date.now();
      }
      expect(enters).toHaveLength(0);

      // Quiet for 500ms → Enter.
      await vi.advanceTimersByTimeAsync(600);
      expect(enters).toHaveLength(1);
      expect(enters[0] - start).toBeGreaterThanOrEqual(1_700);

      // The pane reacts to the Enter → delivery confirms.
      control.lastOutputAt = Date.now() + 1;
      await vi.advanceTimersByTimeAsync(400);
      expect(await pending).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("keeps the native-queue handoff on the fixed delay even while output flows", async () => {
    vi.useFakeTimers();
    const control = fakeControl();
    const { daemon, instanceDir } = makeDaemon(control);
    const enters: number[] = [];
    (daemon as any).tmux = {
      pasteBuffer: async () => true,
      sendSpecialKey: async (key: string) => { if (key === "Enter") enters.push(Date.now()); return true; },
      capturePane: async () => "❯ hello world from the queue",
    };
    try {
      const start = Date.now();
      const pending = (daemon as any).writeMessageToPane("hello world from the queue", "@1", true) as Promise<boolean>;

      // The busy CLI keeps generating output the whole time. Adaptive waiting
      // here would stall to the 3s cap; the handoff must not do that.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(100);
        control.lastOutputAt = Date.now();
      }
      expect(enters).toHaveLength(1);
      expect(enters[0] - start).toBe(500);

      // Paste-visible verification then confirms via capturePane.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
