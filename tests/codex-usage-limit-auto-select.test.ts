/**
 * Tests for #945: Codex usage-limit menu dismissed with Escape.
 *
 * Safety invariant: no path through the dialog handler may send a digit or Enter.
 * R2 (daemon-level test) verifies that Escape goes through sendSpecialKey (not
 * pasteText which adds an implicit Enter that could confirm Reset usage).
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";

function fixture(name: string) {
  return readFileSync(join(__dirname, "fixtures", name), "utf-8");
}

const REAL_MENU = fixture("codex-usage-limit-menu.pane.txt");
const IDLE = fixture("codex-0156-ready.pane.txt");

const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-945-")));
const dialogs = backend.getRuntimeDialogs();

const usageLimitDialog = dialogs.find(d =>
  d.description.toLowerCase().includes("usage limit") &&
  d.description.toLowerCase().includes("luna reserve"),
);

describe("usage-limit auto-dismiss with Escape (#945)", () => {
  it("dialog is registered before unknownSelectionHoldDialog", () => {
    const usageIdx = dialogs.findIndex(d =>
      d.description.toLowerCase().includes("usage limit"),
    );
    const unknownIdx = dialogs.findIndex(d =>
      d.description.toLowerCase().includes("selection needs human"),
    );
    expect(usageIdx, "usage-limit dialog not found").toBeGreaterThanOrEqual(0);
    expect(usageIdx, "must appear before unknownSelection").toBeLessThan(unknownIdx);
  });

  it("dialog sends Escape only — never a digit or Enter (C1 safety guard)", () => {
    // CRITICAL MUTATION GUARD: if this dialog ever includes "3", "Enter", or
    // any numeric key, pasteText would fire a bracketed-paste Enter that selects
    // and confirms the current option (which starts at option 1 = Reset usage).
    expect(usageLimitDialog).toBeDefined();
    expect(usageLimitDialog!.keys).toEqual(["Escape"]);
    expect(usageLimitDialog!.keys).not.toContain("Enter");
    expect(usageLimitDialog!.keys.some(k => /^\d+$/.test(k))).toBe(false);
  });

  it("all dialog keys are in the daemon SPECIAL_KEYS set (sendSpecialKey path, no implicit Enter)", () => {
    // The daemon routes SPECIAL_KEYS through sendSpecialKey; all other keys go
    // through pasteText which adds an implicit Enter (the C1 bug).
    // This test verifies every key in the dialog is one that sendSpecialKey can handle.
    // Mutation guard: if keys: ["3"] is used, "3" is not a special key → fails.
    const daemonSpecialKeys = new Set(["Up", "Down", "Enter", "Escape", "Right", "Left"]);
    for (const key of usageLimitDialog!.keys) {
      expect(daemonSpecialKeys.has(key), `Key "${key}" would go through pasteText (+ implicit Enter)`).toBe(true);
    }
  });

  it("dialog has no confirmBeforeEnter or keysAfterConfirm (R1: dead code removed)", () => {
    // R1: these fields were removed from RuntimeDialog in types.ts.
    // If they're re-added and used here, the C1 race reappears.
    expect("confirmBeforeEnter" in (usageLimitDialog ?? {})).toBe(false);
    expect("keysAfterConfirm" in (usageLimitDialog ?? {})).toBe(false);
  });

  it("dialog has verifyAfterKeys: true (Escape must make the menu disappear)", () => {
    expect(usageLimitDialog!.verifyAfterKeys).toBe(true);
    expect(usageLimitDialog!.blocksDelivery).toBe(true);
    expect(usageLimitDialog!.inputBlocked).toBe(true);
    expect(usageLimitDialog!.holdOnly).toBeFalsy();
  });

  it("isActive recognises the real codex 0.156.1 usage-limit pane", () => {
    expect(usageLimitDialog!.isActive!(REAL_MENU)).toBe(true);
  });

  it("isActive rejects the idle pane", () => {
    expect(usageLimitDialog!.isActive!(IDLE)).toBe(false);
  });

  it("isActive rejects a pane missing option 1 (Reset usage)", () => {
    const noOpt1 = REAL_MENU.replace(/.*Reset usage.*/i, "");
    expect(usageLimitDialog!.isActive!(noOpt1)).toBe(false);
  });

  it("isActive rejects a pane missing option 3 (Continue with Luna Reserve)", () => {
    const noOpt3 = REAL_MENU.replace(/.*Continue with Luna Reserve.*/i, "");
    expect(usageLimitDialog!.isActive!(noOpt3)).toBe(false);
  });

  it("isActive rejects a pane with wrong hint row", () => {
    const wrongHint = REAL_MENU.replace(
      /Press enter to confirm or esc to continue working/i,
      "enter select · esc back",
    );
    expect(usageLimitDialog!.isActive!(wrongHint)).toBe(false);
  });

  it("isActive rejects a scrollback copy followed by idle compositor", () => {
    const scrollback = REAL_MENU + "\n› Ask Codex to do anything\n  Context 80% left";
    expect(usageLimitDialog!.isActive!(scrollback)).toBe(false);
  });

  it("trust modal is still holdOnly (no auto-select regression)", () => {
    const trust = dialogs.find(d => d.description.toLowerCase().includes("trust"));
    expect(trust?.holdOnly ?? trust?.keys?.length === 0).toBeTruthy();
  });

  it("rate-switch dialog is still holdOnly (no auto-select regression)", () => {
    const rateSwitch = dialogs.find(d => d.description.toLowerCase().includes("rate limit"));
    expect(rateSwitch?.holdOnly).toBe(true);
  });

  it("unknownSelectionHoldDialog is still holdOnly (catches unrecognised menus)", () => {
    const unknownSel = dialogs.find(d => d.description.toLowerCase().includes("selection needs human"));
    expect(unknownSel?.holdOnly).toBe(true);
    expect(unknownSel?.keys?.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R2: Daemon-level test — verify the EXACT tmux call sequence.
// pasteText("3") sends bracketed-paste + implicit Enter; sendSpecialKey("Escape")

const dirs2: string[] = [];

describe("usage-limit dialog daemon key sequence (#945 R2 safety)", () => {
  afterEach(() => {
    for (const d of dirs2.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("Escape routes to sendSpecialKey, not pasteText — no implicit Enter (R2 mutation guard)", async () => {
    // Guard 1: keys:["3"] → "3" not in SPECIAL_KEYS → pasteText called → fails.
    // Guard 2: Escape removed from SPECIAL_KEYS → pasteText("Escape") → fails.
    const dir = mkdtempSync(join(tmpdir(), "agend-945-R2-"));
    dirs2.push(dir);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const b = new CodexBackend(dir);
    const daemon = new Daemon(
      "codex-R2",
      { working_directory: "/tmp", backend: "codex",
        restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
        context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
        hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
        log_level: "silent" } as any,
      dir, false, b as any, undefined, { child: () => logger } as any,
    ) as any;

    const sendSpecialKeyCalls: string[] = [];
    const pasteTextCalls: string[] = [];
    daemon.tmux = {
      capturePane: vi.fn(async () => REAL_MENU),
      sendSpecialKey: vi.fn(async (key: string) => { sendSpecialKeyCalls.push(key); return true; }),
      pasteText: vi.fn(async (text: string) => { pasteTextCalls.push(text); return true; }),
      pasteBuffer: vi.fn(async () => true),
      getWindowId: () => "@1",
      getPaneStatus: vi.fn(async () => ({ alive: true })),
      isWindowAlive: vi.fn(async () => true),
      getPaneInputMode: vi.fn(async () => "raw"),
    };
    daemon.controlClient = {
      isIdle: () => true,
      getLastOutputAt: () => undefined,
      getObservationResetAt: () => 0,
      hasOutputSince: () => false,
      on: vi.fn(), off: vi.fn(), removeListener: vi.fn(),
    };
    daemon.processStatus = "running";

    vi.useFakeTimers();
    try {
      (daemon as any).startErrorMonitor();
      // Fire the 5s interval + flush async chain + 200ms key settle
      await vi.advanceTimersByTimeAsync(5_001);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(50);
      clearInterval((daemon as any).errorMonitorTimer);
    } finally {
      vi.useRealTimers();
    }

    expect(sendSpecialKeyCalls).toContain("Escape");
    expect(pasteTextCalls).toHaveLength(0);
    expect(sendSpecialKeyCalls).not.toContain("Enter");
  });
});
