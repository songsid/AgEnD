import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend, CLAUDE_RESUME_PROMPT_DEFAULT, CLAUDE_RESUME_PROMPT_MENU, claudeResumeMenuState } from "../src/backend/claude-code.js";

/**
 * Claude Code's session-resume prompt (2.1.261 wording, captured from the binary):
 *
 *   ❯ 1. Resume from summary (recommended)
 *     2. Resume full session as-is
 *
 * The default is the destructive one. One instance in 13 sat on this prompt
 * after a fleet restart: the startup scan took three back-to-back captures,
 * the prompt was painted after them, the scan "assumed ok", and the `❯` in the
 * dialog satisfied the ready pattern — so the pane counted as deliverable and
 * a paste + Enter would have selected "Resume from summary".
 */
const RESUME_DIALOG = [
  " Resume this session?",
  " This session is large. Resuming from a summary is faster.",
  "",
  " ❯ 1. Resume from summary (recommended)",
  "   2. Resume full session as-is",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");
/** A shape we do NOT know how to navigate: the cursor is already on option 1 = full session. */
const RESUME_VARIANT = [
  " Resume this session?",
  " ❯ 1. Resume full session as-is",
  "   2. Resume from summary",
  " Enter to confirm",
].join("\n");
const READY = "───\n❯ \n───\n  ok\n  ⏵⏵ bypass permissions on";
const LOADING = "Loading session…";
/** Transcript prose that quotes the dialog's sentences — must never be treated as a dialog. */
const PROSE = [
  "❯ The docs compare Resume full session as-is with Resume from summary (recommended).",
  "I trust this analysis is correct. Yes, continue with the implementation.",
  "1. Resume from summary is what the picker offers by default.",
].join("\n");

/** sol's reproduction: the menu quoted verbatim in the transcript, with the real input row below it. */
const QUOTED_MENU = [
  "The captured menu was:",
  " ❯ 1. Resume from summary (recommended)",
  "   2. Resume full session as-is",
  " Enter to confirm · Esc to cancel",
  "",
  "❯",
].join("\n");

const startupDialogs = ClaudeCodeBackend.prototype.getStartupDialogs.call(null);
const runtimeDialogs = ClaudeCodeBackend.prototype.getRuntimeDialogs.call(null);

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDaemon(backendOverrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-resume-dialog-")); dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("claude-resume-test", {
    working_directory: "/tmp",
    backend: "claude-code",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, {
    binaryName: "claude",
    getReadyPattern: () => /❯/,
    getBusyPattern: () => null,
    getStartupDialogs: () => startupDialogs,
    getRuntimeDialogs: () => runtimeDialogs,
    getErrorPatterns: () => [],
    ...backendOverrides,
  } as any, undefined, { child: () => logger } as any) as any;
  const state = { pane: READY, silent: true, outputSince: true };
  const keys: string[] = [];
  const paste = vi.fn(async () => true);
  daemon.tmux = {
    capturePane: vi.fn(async () => state.pane),
    isWindowAlive: async () => true,
    sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); return true; }),
    sendKeys: vi.fn(async (k: string) => { keys.push(`text:${k}`); return true; }),
    pasteBuffer: paste,
    getWindowId: () => "@9",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = {
    isIdle: () => state.silent,
    waitUntilIdle: async () => { while (!state.silent) await new Promise(r => setTimeout(r, 50)); return true; },
    waitForIdle: async () => true,
    hasOutputSince: () => state.outputSince,
    getLastOutputAt: () => 0,
    getObservationResetAt: () => 0,
  };
  const events: string[] = [];
  for (const e of ["message_queued", "message_delivered", "message_confirmed", "message_failed", "dialog_parked"]) daemon.on(e, () => events.push(e));
  return { daemon, state, keys, paste, events, logger, dir };
}

/** Drive a promise under fake timers until it settles. */
async function settle<T>(promise: Promise<T>, maxMs = 120_000, stepMs = 100): Promise<T> {
  let done = false; let result!: T;
  void promise.then(v => { result = v; done = true; });
  for (let t = 0; !done && t <= maxMs; t += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error("did not settle");
  return result;
}

describe("claude-code resume-prompt patterns are structural, never prose", () => {
  it("the exact entry needs the selector on option 1; the menu guard needs two numbered Resume rows", () => {
    expect(CLAUDE_RESUME_PROMPT_DEFAULT.test(RESUME_DIALOG)).toBe(true);
    expect(CLAUDE_RESUME_PROMPT_MENU.test(RESUME_DIALOG)).toBe(true);
    expect(CLAUDE_RESUME_PROMPT_DEFAULT.test(RESUME_VARIANT)).toBe(false);   // cursor is not on the summary option
    expect(CLAUDE_RESUME_PROMPT_MENU.test(RESUME_VARIANT)).toBe(true);
  });

  it("none of the delivery-blocking dialogs match transcript prose quoting the same sentences", () => {
    for (const d of runtimeDialogs) expect(d.pattern.test(PROSE), d.description).toBe(false);
    expect(CLAUDE_RESUME_PROMPT_MENU.test("The docs compare Resume full session as-is with Resume from summary.")).toBe(false);
  });

  it("a verbatim quote of the menu followed by the real input row is NOT an active dialog", () => {
    // The regexes alone match the quote — that is why they are only the
    // identity/pre-filter. The active-region predicate is what decides.
    expect(CLAUDE_RESUME_PROMPT_DEFAULT.test(QUOTED_MENU)).toBe(true);
    expect(claudeResumeMenuState(QUOTED_MENU)).toEqual({ active: false, defaultCursor: true });
    expect(claudeResumeMenuState(RESUME_DIALOG)).toEqual({ active: true, defaultCursor: true });
    expect(claudeResumeMenuState(RESUME_VARIANT)).toEqual({ active: true, defaultCursor: false });
    for (const d of runtimeDialogs) expect(d.isActive!(QUOTED_MENU), d.description).toBe(false);
  });

  it("orders the exact entry before the guard; the guard has no keys and blocks delivery", () => {
    for (const table of [startupDialogs, runtimeDialogs]) {
      const exact = table.findIndex(d => d.pattern === CLAUDE_RESUME_PROMPT_DEFAULT);
      const guard = table.findIndex(d => d.holdOnly);
      expect(exact).toBeGreaterThanOrEqual(0);
      expect(guard).toBeGreaterThan(exact);
      expect(table[guard].keys).toEqual([]);
      expect(table[guard].blocksDelivery).toBe(true);
      expect(table[exact].blocksDelivery).toBe(true);
    }
  });
});

describe("startup scan: the resume prompt painted AFTER the first quiet moment", () => {
  it("keeps polling, dismisses the late dialog with Down+Enter, and reports ready only after two clean polls", async () => {
    const { daemon, keys } = makeDaemon();
    const frames = [LOADING, LOADING, LOADING, RESUME_DIALOG, READY, READY];
    let i = 0;
    daemon.tmux.capturePane = vi.fn(async () => { const f = frames[Math.min(i, frames.length - 1)]; i++; return f; });

    expect(await daemon.dismissDialogsUntilReady(5_000, 0)).toBe(true);

    expect(keys).toEqual(["Down", "Enter"]);          // the 4th capture saw it — the old 3-capture scan never did
    expect(i).toBeGreaterThanOrEqual(6);               // ready needed two consecutive clean polls
  });

  it("paces its polls and stops at the wall-clock budget instead of bursting", async () => {
    vi.useFakeTimers();
    const { daemon, state } = makeDaemon();
    state.pane = LOADING;
    const scan = daemon.dismissDialogsUntilReady(5_000);        // default 500ms cadence
    await vi.advanceTimersByTimeAsync(1_100);
    expect(daemon.tmux.capturePane.mock.calls.length).toBeLessThanOrEqual(3); // ~1 capture per 500ms, not a burst
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await scan).toBe(true);
    expect(daemon.tmux.capturePane.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("never answers an unrecognised variant, logs the hold, and still reports the CLI alive", async () => {
    const { daemon, state, keys, logger } = makeDaemon();
    state.pane = RESUME_VARIANT;
    expect(await daemon.dismissDialogsUntilReady(1_000, 0)).toBe(true);   // false would clear the session
    expect(keys).toEqual([]);
    expect(JSON.stringify(logger.warn.mock.calls)).toMatch(/not auto-answering|dialog still on screen/);
  });

  it("logs, rather than silently assumes, when the budget runs out on an unknown screen", async () => {
    const { daemon, state, logger } = makeDaemon();
    state.pane = LOADING;
    expect(await daemon.dismissDialogsUntilReady(300, 0)).toBe(true);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain("assuming ready");
  });

  it("a transient capture failure is retried, not turned into a startup failure that clears the session", async () => {
    const { daemon, keys } = makeDaemon();
    const frames: Array<string | Error> = [new Error("tmux hiccup"), new Error("tmux hiccup"), RESUME_DIALOG, READY, READY];
    let i = 0;
    daemon.tmux.capturePane = vi.fn(async () => { const f = frames[Math.min(i, frames.length - 1)]; i++; if (f instanceof Error) throw f; return f; });
    expect(await daemon.dismissDialogsUntilReady(5_000, 0)).toBe(true);
    expect(keys).toEqual(["Down", "Enter"]);
  });

  it("an unanswerable liveness query is not death: capture and liveness both fail → retry, session kept", async () => {
    // Production isWindowAlive() folds every tmux error into false; the scan
    // must not read that as "the CLI died" and let the caller clear the session.
    const { daemon, logger } = makeDaemon();
    daemon.tmux.capturePane = vi.fn(async () => { throw new Error("EAGAIN"); });
    daemon.tmux.isWindowAlive = vi.fn(async () => { throw new Error("EAGAIN"); });
    daemon.tmux.getPaneStatus = vi.fn(async () => null);   // ambiguous, like a failed list-panes
    expect(await daemon.dismissDialogsUntilReady(800, 0)).toBe(true);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain("assuming ready");
  });

  it("the pre-scan liveness gate is tri-state too: a failed tmux query does not fail the spawn", async () => {
    // Production isWindowAlive() returns false on ANY list-windows error; the
    // spawn used to return false right there and the caller cleared the session.
    const { daemon, state } = makeDaemon();
    state.pane = READY;
    daemon.tmux.isWindowAlive = vi.fn(async () => false);              // query failed, folded to false
    daemon.tmux.getPaneStatus = vi.fn(async () => null);               // ambiguous
    expect(await daemon.finishStartupScan(1_000)).toBe(true);
    daemon.tmux.getPaneStatus = vi.fn(async () => { throw new Error("EAGAIN"); });
    expect(await daemon.finishStartupScan(1_000)).toBe(true);
    daemon.tmux.getPaneStatus = vi.fn(async () => ({ alive: false, exitCode: 1 }));   // POSITIVE dead
    expect(await daemon.finishStartupScan(1_000)).toBe(false);
  });

  it("a dead window is still a real failure", async () => {
    const { daemon } = makeDaemon();
    daemon.tmux.capturePane = vi.fn(async () => { throw new Error("no such pane"); });
    daemon.tmux.getPaneStatus = vi.fn(async () => ({ alive: false, exitCode: 0 }));   // POSITIVE dead pane
    expect(await daemon.dismissDialogsUntilReady(2_000, 0)).toBe(false);
  });

  it("counts key sends and render waits against the budget (wall clock, not attempts)", async () => {
    vi.useFakeTimers();
    const { daemon, state } = makeDaemon();
    state.pane = RESUME_DIALOG;                          // dismissal keys never take effect
    daemon.controlClient.waitForIdle = async () => { await new Promise(r => setTimeout(r, 10_000)); return true; };
    let done: boolean | null = null;
    daemon.dismissDialogsUntilReady(30_000).then((v: boolean) => { done = v; });
    for (let t = 0; t < 36_000 && done === null; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);                             // three 10s render waits could not stretch it past the budget
    expect(daemon.tmux.sendSpecialKey.mock.calls.length).toBeLessThanOrEqual(8);
  });
});

describe("delivery gate: a blocking dialog on screen is never a deliverable pane", () => {
  beforeEach(() => vi.useFakeTimers());

  it("does not paste while the resume prompt is up, then delivers once it is gone", async () => {
    const { daemon, state, paste, events } = makeDaemon();
    state.pane = RESUME_DIALOG;                         // quiet pane, ready pattern `❯` visible — the old gate said "ready"
    const delivery = daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(paste).not.toHaveBeenCalled();
    expect(events).toContain("message_queued");

    state.pane = READY;                                 // a human (or the runtime scan) answered it
    expect(await settle(delivery)).toBe(true);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it("does not hand a quiet dialog pane to steering", async () => {
    const { daemon, state, paste } = makeDaemon();
    state.pane = RESUME_DIALOG;
    void daemon.deliverMessage("[from:leader] correction", { chatId: "c", messageId: "m" }, { steer: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(paste).not.toHaveBeenCalled();
    expect(daemon.tmux.sendSpecialKey).not.toHaveBeenCalled();
  });

  it("does not hand a FRESHLY painted dialog (control client still 'busy') to steering or a native queue", async () => {
    // sol's window: the dialog was just drawn, output is not yet quiet, so the
    // silence gate says "busy" — which used to be handed straight to steer.
    for (const opts of [{ steer: true }, {}]) {
      const { daemon, state, paste } = makeDaemon(opts.steer ? {} : { supportsQueuedInput: () => true });
      state.pane = RESUME_DIALOG;
      state.silent = false;
      void daemon.deliverMessage("[from:leader] correction", { chatId: "c", messageId: "m" }, opts);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(paste).not.toHaveBeenCalled();
      expect(daemon.tmux.sendSpecialKey).not.toHaveBeenCalled();
    }
  });

  it("a genuinely busy pane without a dialog still hands off to the native queue", async () => {
    const { daemon, state, paste } = makeDaemon({ supportsQueuedInput: () => true });
    state.pane = "working…\n↳ queued work";
    state.silent = false;
    void daemon.deliverMessage("queued work", { chatId: "c", messageId: "m" }, {});
    await vi.advanceTimersByTimeAsync(3_000);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it("the hold-only variant blocks delivery too", async () => {
    const { daemon, state, paste } = makeDaemon();
    state.pane = RESUME_VARIANT;
    void daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(paste).not.toHaveBeenCalled();
  });

  it("prose that quotes the dialog does not hold delivery", async () => {
    const { daemon, state, paste } = makeDaemon();
    state.pane = PROSE;
    expect(await settle(daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {}), 10_000)).toBe(true);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it("a quoted menu with the real prompt below it does not hold delivery", async () => {
    const { daemon, state, paste } = makeDaemon();
    state.pane = QUOTED_MENU;
    expect(await settle(daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {}), 10_000)).toBe(true);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it("re-probes under the write lock: a dialog painted between the probe and the paste is not written into", async () => {
    // sol's reproduction: the pane is READY at every probe outside the lock and
    // becomes the dialog exactly when the critical section is entered.
    const { daemon, state, paste, events } = makeDaemon();
    const realRun = daemon.paneWriteLock.run.bind(daemon.paneWriteLock);
    let flipped = false;
    daemon.paneWriteLock.run = (fn: () => Promise<unknown>) => realRun(async () => {
      if (!flipped) { flipped = true; state.pane = RESUME_DIALOG; }
      return fn();
    });
    const delivery = daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {});
    await vi.advanceTimersByTimeAsync(3_000);
    expect(paste).not.toHaveBeenCalled();                  // the in-lock probe saw the dialog
    state.pane = READY;                                     // dialog answered by a human / runtime scan
    expect(await settle(delivery)).toBe(true);
    expect(paste).toHaveBeenCalledTimes(1);
    expect(events).not.toContain("message_failed");
  });

  it("a dialog that keeps appearing before every write ends in an honest failure, never a blind paste", async () => {
    const { daemon, state, paste, events } = makeDaemon();
    const realRun = daemon.paneWriteLock.run.bind(daemon.paneWriteLock);
    daemon.paneWriteLock.run = (fn: () => Promise<unknown>) => realRun(async () => { state.pane = RESUME_DIALOG; return fn(); });
    const delivery = daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {});
    // Outside the lock the pane always looks clear again.
    const clearer = setInterval(() => { state.pane = READY; }, 200);
    const ok = await settle(delivery, 60_000);
    clearInterval(clearer);
    expect(ok).toBe(false);
    expect(paste).not.toHaveBeenCalled();
    expect(events).toContain("message_failed");
  });

  it("an unreadable pane is not 'clear': retries, then fails the delivery instead of pasting blind", async () => {
    const { daemon, paste, events } = makeDaemon();
    daemon.tmux.capturePane = vi.fn(async () => { throw new Error("tmux gone"); });
    const ok = await settle(daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {}), 60_000);
    expect(ok).toBe(false);
    expect(paste).not.toHaveBeenCalled();
    expect(events).toContain("message_failed");
    expect(daemon.tmux.capturePane.mock.calls.length).toBeGreaterThan(10); // it kept trying before giving up
  });

  it("a transient capture failure recovers: unreadable twice, then clear → delivered", async () => {
    const { daemon, paste } = makeDaemon();
    let n = 0;
    daemon.tmux.capturePane = vi.fn(async () => { if (n++ < 2) throw new Error("hiccup"); return READY; });
    expect(await settle(daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {}), 10_000)).toBe(true);
    expect(paste).toHaveBeenCalledTimes(1);
  });
});

describe("runtime scan: catches a dialog the startup scan moved past", () => {
  beforeEach(() => vi.useFakeTimers());

  it("dismisses the known resume prompt on the next 5s tick", async () => {
    const { daemon, state, keys, logger } = makeDaemon();
    state.pane = RESUME_DIALOG;
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_600);            // tick at 5s, 200ms between keys
    expect(keys).toEqual(["Down", "Enter"]);
    expect(JSON.stringify(logger.info.mock.calls)).toContain("Auto-dismissing runtime dialog");
    clearInterval(daemon.errorMonitorTimer);
  });

  it("holds the variant, and reports it once after a minute without pressing anything", async () => {
    const { daemon, state, keys, events } = makeDaemon();
    state.pane = RESUME_VARIANT;
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(keys).toEqual([]);
    expect(events.filter(e => e === "dialog_parked")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.filter(e => e === "dialog_parked")).toHaveLength(1);   // once per dialog
    state.pane = READY;
    await vi.advanceTimersByTimeAsync(5_100);
    state.pane = RESUME_VARIANT;                        // a new occurrence reports again after its own minute
    await vi.advanceTimersByTimeAsync(70_000);
    expect(events.filter(e => e === "dialog_parked")).toHaveLength(2);
    clearInterval(daemon.errorMonitorTimer);
  });

  it("the delivery gate polling and the runtime tick share one clock for the same dialog", async () => {
    const { daemon, state, events } = makeDaemon();
    state.pane = RESUME_VARIANT;
    daemon.startErrorMonitor();
    void daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {}); // polls every 250ms
    await vi.advanceTimersByTimeAsync(70_000);
    expect(events.filter(e => e === "dialog_parked")).toHaveLength(1);   // interleaved observers did not keep resetting it
    clearInterval(daemon.errorMonitorTimer);
  });

  it("never sends keys for a menu quoted in the transcript (the real prompt is below it)", async () => {
    const { daemon, state, keys } = makeDaemon();
    state.pane = QUOTED_MENU;
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(keys).toEqual([]);
    clearInterval(daemon.errorMonitorTimer);
  });

  it("never sends keys for startup-only patterns (they are loose on purpose)", async () => {
    const { daemon, state, keys } = makeDaemon();
    state.pane = "❯ I trust this analysis is correct. Yes, continue with the implementation.";
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(keys).toEqual([]);
    clearInterval(daemon.errorMonitorTimer);
  });
});

describe("wake never abandons an uncancellable spawn", () => {
  function wakeable() {
    vi.useFakeTimers();
    const h = makeDaemon();
    h.daemon.pauseWakeState = "paused";
    h.daemon.autoPauseController = { wakeOnDeliver: (fn: () => Promise<void>) => fn() };
    h.daemon.clearErrorRecoveryGate = vi.fn();
    h.daemon.resumeRuntimeMonitors = vi.fn();
    return h;
  }

  it("a spawn delayed far past any budget (gate queue + setup + full scan) still completes the wake", async () => {
    const { daemon, logger } = wakeable();
    // 90s of SpawnGate/storm queueing, then the budget, then the whole scan.
    daemon.trySpawn = vi.fn(async (_reuse: boolean, budget: number) => { await new Promise(r => setTimeout(r, 90_000 + budget + 30_000)); return true; });
    let settled: "ok" | "err" | null = null;
    daemon.wake(30_000).then(() => { settled = "ok"; }, () => { settled = "err"; });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBeNull();                              // no timer gave up on it
    expect(daemon.pauseWakeState).toBe("waking");           // and no state flip behind the spawn's back
    expect(JSON.stringify(logger.warn.mock.calls)).toContain("exceeding its budget");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe("ok");
    expect(daemon.pauseWakeState).toBe("active");
  });

  it("a spawn that reports failure still fails the wake", async () => {
    const { daemon } = wakeable();
    daemon.trySpawn = vi.fn(async () => false);
    await expect(daemon.wake(30_000)).rejects.toThrow(/did not become ready/);
    expect(daemon.pauseWakeState).toBe("paused");
  });
});
