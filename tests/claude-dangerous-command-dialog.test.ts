import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeBackend, CLAUDE_DANGEROUS_COMMAND_PROMPT, claudeDangerousCommandPromptState } from "../src/backend/claude-code.js";
import { Daemon } from "../src/daemon.js";

const WARNING = "Dangerous rm operation on possibly-empty variable path: rewrite it as \"${TARGET:?}\"/* or use a literal path";
const QUESTION = "Do you want to proceed?";
const DANGER_YES = [
  " command preview: rm -rf -- \"$TARGET\"/*",
  WARNING,
  QUESTION,
  " ❯ 1. Yes",
  "   2. No",
  " Esc to cancel",
].join("\n");
const DANGER_NO = DANGER_YES.replace(" ❯ 1. Yes", "   1. Yes").replace("   2. No", " ❯ 2. No");
const DANGER_UNKNOWN = DANGER_YES.replace(" ❯ 1. Yes", "   1. Yes").replace("   2. No", "   2. No");
const DANGER_THREE_OPTIONS = DANGER_YES.replace("   2. No", "   2. Yes\n   3. No");
const DANGER_REVERSED = DANGER_YES.replace(" ❯ 1. Yes", " ❯ 1. No").replace("   2. No", "   2. Yes");
const READY = "───\n❯\n───\n  ok";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDaemon(initialPane = DANGER_YES) {
  const dir = mkdtempSync(join(tmpdir(), "agend-danger-dialog-")); dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("danger-dialog-test", {
    working_directory: "/tmp",
    backend: "claude-code",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new ClaudeCodeBackend(dir), undefined, { child: () => logger } as any) as any;
  const state = { pane: initialPane };
  const keys: string[] = [];
  const tmux = {
    capturePane: vi.fn(async () => state.pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async (key: string) => {
      keys.push(key);
      if (key === "Enter" && (state.pane === DANGER_YES || state.pane === DANGER_NO)) state.pane = READY;
      return true;
    }),
    pasteText: vi.fn(async () => true),
    pasteBuffer: vi.fn(async () => true),
    getWindowId: () => "@9",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => null,
  };
  daemon.tmux = tmux;
  daemon.submitSystemPaste = vi.fn(async () => true);
  daemon.controlClient = { isIdle: () => true, waitUntilIdle: async () => true };
  return { daemon, state, keys, tmux, logger };
}

describe("Claude dangerous-command prompt recognition", () => {
  it("requires the question, canonical Yes/No menu, selector, and bottom Esc footer", () => {
    expect(CLAUDE_DANGEROUS_COMMAND_PROMPT.test(DANGER_YES)).toBe(true);
    expect(claudeDangerousCommandPromptState(DANGER_YES)).toEqual({ active: true, cursor: "yes" });
    expect(claudeDangerousCommandPromptState(DANGER_NO)).toEqual({ active: true, cursor: "no" });
    expect(claudeDangerousCommandPromptState(DANGER_UNKNOWN)).toEqual({ active: true, cursor: "unknown" });
    expect(claudeDangerousCommandPromptState(DANGER_THREE_OPTIONS).active).toBe(false);
    expect(claudeDangerousCommandPromptState(DANGER_REVERSED)).toEqual({ active: true, cursor: "unknown" });
    expect(claudeDangerousCommandPromptState(`${DANGER_YES}\n❯ ordinary prompt`)).toEqual({ active: false, cursor: "unknown" });
  });

  it("does not match prose or code that quotes the warning", () => {
    const prose = "The program printed: Do you want to proceed? 1. Yes / 2. No";
    expect(claudeDangerousCommandPromptState(prose).active).toBe(false);
    expect(claudeDangerousCommandPromptState("const x = 'Do you want to proceed?';\n1. Yes\n2. No\nEsc to cancel").active).toBe(false);
  });
});

describe("runtime dangerous-command self-heal", () => {
  it("sends Down+Enter for Yes, verifies the menu is gone, and injects one system notice", async () => {
    vi.useFakeTimers();
    const { daemon, keys, tmux } = makeDaemon();
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(keys).toEqual(["Down", "Enter"]);
    expect(tmux.capturePane.mock.calls.length).toBeGreaterThanOrEqual(3); // scan, in-lock re-read, post-key proof
    expect(daemon.submitSystemPaste).toHaveBeenCalledOnce();
    expect(daemon.submitSystemPaste.mock.calls[0][0]).toContain("[system:dangerous-command-blocked]");
    expect(daemon.submitSystemPaste.mock.calls[0][0]).not.toContain("rm -rf");
    daemon.freezeRuntimeMonitors();
  });

  it("confirms an already-selected No with Enter only", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = makeDaemon(DANGER_NO);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(keys).toEqual(["Enter"]);
    expect(daemon.submitSystemPaste).toHaveBeenCalledOnce();
    daemon.freezeRuntimeMonitors();
  });

  it("holds an unknown cursor and never risks selecting Yes", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = makeDaemon(DANGER_UNKNOWN);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(keys).toEqual([]);
    expect(daemon.submitSystemPaste).not.toHaveBeenCalled();
    daemon.freezeRuntimeMonitors();
  });

  it("does not resend a safety choice while the same menu remains visible", async () => {
    vi.useFakeTimers();
    const { daemon, keys, tmux } = makeDaemon();
    // The fake tmux accepts the key but leaves the menu painted, modelling a
    // slow/failed Claude repaint. The generation fence must prevent a second
    // Down+Enter on each five-second poll.
    tmux.sendSpecialKey.mockImplementation(async (key: string) => { keys.push(key); return true; });
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(keys).toEqual(["Down", "Enter"]);
    expect(daemon.submitSystemPaste).not.toHaveBeenCalled();
    daemon.freezeRuntimeMonitors();
  });

  it("waits for every menu variant after Down when the first Enter is swallowed", async () => {
    vi.useFakeTimers();
    const { daemon, keys, state } = makeDaemon();
    let enters = 0;
    daemon.tmux.sendSpecialKey.mockImplementation(async (key: string) => {
      keys.push(key);
      if (key === "Down") state.pane = DANGER_NO;
      if (key === "Enter" && ++enters >= 2) state.pane = READY;
      return true;
    });
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(keys).toEqual(["Down", "Enter"]);
    expect(daemon.submitSystemPaste).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(keys).toEqual(["Down", "Enter", "Enter"]);
    expect(daemon.submitSystemPaste).toHaveBeenCalledOnce();
    daemon.freezeRuntimeMonitors();
  });

  it("does not answer a normal transcript containing the same words", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = makeDaemon("The docs say: Do you want to proceed?\n1. Yes\n2. No\nEsc to cancel\n❯");
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(keys).toEqual([]);
    expect(daemon.submitSystemPaste).not.toHaveBeenCalled();
    daemon.freezeRuntimeMonitors();
  });

  it("keeps the execution state edge and auto-pause suppressed while input is blocked", () => {
    const { daemon } = makeDaemon(DANGER_YES);
    daemon.inputBlockedDialogKey = "claude-dangerous-command";
    daemon.instanceState = "working";
    daemon.autoPauseController.observe = vi.fn(() => true);
    daemon.hangDetector = { emit: vi.fn() };
    daemon.applyInstanceStateSnapshot({
      state: "idle", unchangedForMs: 4_000, stateChangedAt: 1, observedAt: 2,
    });
    expect(daemon.instanceState).toBe("working");
    expect(daemon.autoPauseController.observe).not.toHaveBeenCalled();
    daemon.handleStuckTransition(DANGER_YES, {
      state: "stuck", unchangedForMs: 60_000, stateChangedAt: 1, observedAt: 2,
    }, /❯/);
    expect(daemon.hangDetector.emit).not.toHaveBeenCalled();
  });
});
