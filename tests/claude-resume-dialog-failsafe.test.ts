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

describe("key-sending paths respect the active-region predicate (standalone safety of this commit)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("the runtime scanner never sends keys for a menu quoted in the transcript", async () => {
    const { daemon, state, keys } = makeDaemon();
    state.pane = QUOTED_MENU;
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(keys).toEqual([]);
    clearInterval(daemon.errorMonitorTimer);
  });

  it("the runtime scanner still dismisses the live prompt", async () => {
    const { daemon, state, keys } = makeDaemon();
    state.pane = RESUME_DIALOG;
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_600);
    expect(keys).toEqual(["Down", "Enter"]);
    clearInterval(daemon.errorMonitorTimer);
  });

  it("the startup scan never sends keys for a quoted menu and treats the pane as ready", async () => {
    vi.useRealTimers();
    const { daemon, state, keys } = makeDaemon();
    state.pane = QUOTED_MENU;                            // real `❯` input row is at the bottom
    expect(await daemon.dismissDialogsUntilReady(3)).toBe(true);
    expect(keys).toEqual([]);
  });
});
