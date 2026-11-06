/**
 * After grok's weekly-limit picker is recorded and the reset time has passed, AgEnD selects Try Again
 * (Down×2 then Enter). The list does not wrap, so that is start-independent. Before the reset it
 * Shift+x-pauses and never auto-answers. Fixtures: tests/fixtures/grok-1.0.77-weekly-reset/
 * (1.0.77, isolated mock 402→ok).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { GrokBackend } from "../src/backend/grok.js";
import {
  clearGrokWeeklyReset, grokWeeklyResetDue, inferGrokWeeklyResetAt, markGrokWeeklyTryAgainConsumed,
  noteGrokWeeklyLimitSeen, readGrokWeeklyReset, writeGrokWeeklyReset,
} from "../src/backend/grok-weekly-reset.js";
import { unrecognisedPromptShape } from "../src/unrecognised-prompt.js";
import { getAgendHome } from "../src/paths.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/grok-1.0.77-weekly-reset/${n}`, import.meta.url), "utf8");
const MODAL = fx("modal.pane.txt");
const STILL = fx("enter-still-402.pane.txt");
const AFTER_OK = fx("enter-after-ok.pane.txt");
const OLD_MODAL = readFileSync(new URL("./fixtures/grok-weekly-limit-modal.pane.txt", import.meta.url), "utf8");
const AFTER_X = readFileSync(new URL("./fixtures/grok-1.0.70-weekly-limit/after-shift-x.pane.txt", import.meta.url), "utf8");
const SCROLLBACK = readFileSync(new URL("./fixtures/grok-1.0.70-weekly-limit/modal-scrollback-focus.pane.txt", import.meta.url), "utf8");

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-grok-reset-picker-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const active = (b: GrokBackend, pane: string, which: "runtime" | "startup") =>
  (which === "runtime" ? b.getRuntimeDialogs() : b.getStartupDialogs())
    .filter(d => (d.isActive ? d.isActive(pane) : (d.pattern.lastIndex = 0, d.pattern.test(pane))));
const weekly = (b: GrokBackend, pane: string, which: "runtime" | "startup" = "runtime") =>
  active(b, pane, which).filter(d => /Grok 週限/.test(d.description));

function dueDir(past = true) {
  const dir = tmp();
  // Wall-clock stamps, not Date.now(): fake timers may pin now at 0, and resetAt<=0 is rejected.
  const pausedAt = 1_700_000_000_000;
  writeGrokWeeklyReset(dir, { pausedAt, resetAt: past ? pausedAt + 1_000 : 4_000_000_000_000 });
  return dir;
}

describe("1.0.77 offline capture: the three-option picker", () => {
  it("matches the live wording AgEnD must recognise", () => {
    expect(MODAL).toMatch(/You hit your weekly limit\./);
    expect(MODAL).toMatch(/1 \(○\) Upgrade tier/);
    expect(MODAL).toMatch(/2 \(○\) Buy more credits/);
    expect(MODAL).toMatch(/3 \(○\) Try Again\s+Resubmit the last prompt once you have usage again/);
    expect(MODAL).toMatch(/Tab:next answer\s+│\s+Esc:scrollback\s+│\s+Shift\+x:dismiss/);
    expect(unrecognisedPromptShape(MODAL)).toBeNull();
    expect(unrecognisedPromptShape(STILL)).toBeNull();
  });

  it("highlight is reverse-video on option 1 by default; two Downs reach Try Again; digit 3 does not move it", () => {
    const sgr = (s: string) => /\x1b\[7m(\d) \(○\)/.exec(s)?.[1];
    expect(sgr(fx("modal.esc.txt"))).toBe("1");
    expect(sgr(fx("down1.esc.txt"))).toBe("2");
    expect(sgr(fx("down2.esc.txt"))).toBe("3");
    expect(sgr(fx("digit3.esc.txt"))).toBe("1");
    expect(sgr(fx("modal-run2.esc.txt"))).toBe("1");
    expect(sgr(fx("enter-still-402.esc.txt"))).toBe("1");
  });

  it("list does not wrap: Down on option 3 stays on 3; Down×2 from option 2 still lands on Try Again", () => {
    const sgr = (s: string) => /\x1b\[7m(\d) \(○\)/.exec(s)?.[1];
    expect(sgr(fx("down3.esc.txt"))).toBe("3");
    expect(sgr(fx("from2.esc.txt"))).toBe("2");
    expect(sgr(fx("from2-downx2.esc.txt"))).toBe("3");
  });

  it("retry while still limited re-shows the picker; success leaves the composer", () => {
    expect(STILL).toMatch(/Trying again…/);
    expect(STILL).toMatch(/You hit your weekly limit\./);
    expect(AFTER_OK).toMatch(/Trying again…/);
    expect(AFTER_OK).not.toMatch(/You hit your weekly limit\./);
    expect(AFTER_OK).toMatch(/grok-mock · always-approve/);
  });
});

describe("reset clock", () => {
  it("is not due with no file, a junk file, or a future resetAt", () => {
    const dir = tmp();
    expect(grokWeeklyResetDue(dir)).toBe(false);
    writeFileSync(join(dir, "grok-weekly-reset"), "nope");
    expect(readGrokWeeklyReset(dir)).toBeNull();
    expect(grokWeeklyResetDue(dir)).toBe(false);
    writeGrokWeeklyReset(dir, { pausedAt: 1, resetAt: Date.now() + 60_000 });
    expect(grokWeeklyResetDue(dir)).toBe(false);
  });

  it("is due once resetAt has passed; first sight records a future clock; a second sight keeps it", () => {
    const dir = dueDir(true);
    expect(grokWeeklyResetDue(dir)).toBe(true);
    const first = readGrokWeeklyReset(dir)!;
    noteGrokWeeklyLimitSeen(dir);
    expect(readGrokWeeklyReset(dir)).toEqual(first);
    clearGrokWeeklyReset(dir);
    expect(grokWeeklyResetDue(dir)).toBe(false);
    const now = 1_700_000_000_000;
    noteGrokWeeklyLimitSeen(dir, now);
    expect(readGrokWeeklyReset(dir)).toEqual({ pausedAt: now, resetAt: now + 7 * 86_400_000 });
  });

  it("a consumed Try Again is kept until Shift+x starts a new pause episode", () => {
    const dir = dueDir(true);
    const first = readGrokWeeklyReset(dir)!;
    markGrokWeeklyTryAgainConsumed(dir);
    expect(readGrokWeeklyReset(dir)).toEqual({ ...first, tryAgainConsumed: true });
    noteGrokWeeklyLimitSeen(dir, first.pausedAt);
    expect(readGrokWeeklyReset(dir)).toEqual({ ...first, tryAgainConsumed: true });
    const now = 1_800_000_000_000;
    noteGrokWeeklyLimitSeen(dir, now);
    expect(readGrokWeeklyReset(dir)).toEqual({ pausedAt: now, resetAt: now + 7 * 86_400_000 });
  });

  it("uses quota-history's grok weekly resetsAt when that time is still ahead", () => {
    const now = Date.now();
    const ahead = new Date(now + 3_600_000).toISOString();
    writeFileSync(join(getAgendHome(), "usage-quota-history.jsonl"),
      `${JSON.stringify({ t: now, provider: "grok", metric: "Weekly limit", used: 100, resetsAt: ahead, windowMs: 7 * 86_400_000 })}\n`);
    expect(inferGrokWeeklyResetAt(now)).toBe(Date.parse(ahead));
    writeFileSync(join(getAgendHome(), "usage-quota-history.jsonl"),
      `${JSON.stringify({ t: now, provider: "grok", metric: "Weekly limit", used: 100, resetsAt: new Date(now - 1_000).toISOString(), windowMs: 7 * 86_400_000 })}\n`);
    expect(inferGrokWeeklyResetAt(now)).toBe(now + 7 * 86_400_000);
  });
});

describe("dialogs: before the reset Shift+x; after it Try Again", () => {
  it("no marker / future reset → Shift+x, never Down or Enter", () => {
    for (const dir of [tmp(), dueDir(false)]) {
      const b = new GrokBackend(dir);
      expect(weekly(b, MODAL).map(d => d.keys)).toEqual([["X"]]);
      expect(weekly(b, MODAL)[0]).toMatchObject({ literalKeys: true, autoResolutionKey: "grok-weekly-limit", dismissIncident: { type: "quota", action: "pause" } });
      expect(weekly(b, MODAL, "startup").map(d => [d.holdOnly, d.keys])).toEqual([[true, []]]);
    }
  });

  it("reset due + Try Again present → Down, Down, Enter; two-option modal never gets it", () => {
    const b = new GrokBackend(dueDir(true));
    const hit = weekly(b, MODAL);
    expect(hit.map(d => d.keys)).toEqual([["Down", "Down", "Enter"], ["X"]]);
    expect(hit[0]).toMatchObject({ autoResolutionKey: "grok-weekly-limit-try-again", verifyAfterKeys: true });
    expect(hit[0]!.dismissIncident).toBeUndefined();
    expect(weekly(b, OLD_MODAL).map(d => d.keys)).toEqual([["X"]]);
    expect(weekly(b, AFTER_OK)).toEqual([]);
    expect(weekly(b, STILL)[0]?.keys).toEqual(["Down", "Down", "Enter"]);
    expect(weekly(b, MODAL, "startup")[0]?.keys).toEqual(["Down", "Down", "Enter"]);
    expect(weekly(b, MODAL, "startup")[0]?.holdOnly).toBeFalsy();
  });

  it("after Try Again is consumed, the same picker is Shift+x only", () => {
    const dir = dueDir(true);
    const b = new GrokBackend(dir);
    const tryAgain = weekly(b, MODAL)[0]!;
    expect(tryAgain.keys).toEqual(["Down", "Down", "Enter"]);
    tryAgain.answerDetail?.(MODAL);
    expect(weekly(b, MODAL).map(d => d.keys)).toEqual([["Down", "Down", "Enter"], ["X"]]);
    weekly(b, MODAL).find(d => d.keys[0] === "X")?.answerDetail?.(MODAL);
    expect(weekly(b, MODAL).map(d => d.keys)).toEqual([["X"]]);
  });

  it("scrollback after reset: Space first, not Try Again", () => {
    const b = new GrokBackend(dueDir(true));
    expect(weekly(b, SCROLLBACK).map(d => d.keys)).toEqual([[" "]]);
    expect(weekly(b, SCROLLBACK, "startup").map(d => d.keys)).toEqual([[" "], []]);
  });
});

function makeDaemon(dir: string, initial: string) {
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("grok-reset-picker", {
    working_directory: "/tmp", backend: "grok",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new GrokBackend(dir), undefined, { child: () => logger } as any) as any;
  const state = { pane: initial };
  const tmux = {
    capturePane: vi.fn(async () => state.pane), isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async (k: string) => {
      if (k === "Enter" && /Try Again/.test(state.pane)) { state.pane = AFTER_OK; return true; }
      return true;
    }),
    sendKeys: vi.fn(async (k: string) => {
      if (k === "X") { state.pane = AFTER_X; return true; }
      return true;
    }),
    pasteText: vi.fn(async () => true), pasteBuffer: vi.fn(async () => true),
    getWindowId: () => "@9", getLastPasteError: () => null, isLastPasteFailureRecoverable: () => true, getLastSendSpecialKeyError: () => null,
  };
  daemon.tmux = tmux;
  daemon.isPaneIdleForDelivery = vi.fn(() => true);
  const errors: any[] = [], parked: any[] = [];
  daemon.on("pty_error", (e: any) => errors.push(e));
  daemon.on("dialog_parked", (e: any) => parked.push(e));
  return { daemon, tmux, state, errors, parked };
}

describe("in the real Daemon", () => {
  it("before the reset: X typed once, one quota pause, never Down/Enter", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { daemon, tmux, errors, parked } = makeDaemon(tmp(), MODAL);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tmux.sendKeys.mock.calls.map((c: any[]) => c[0])).toEqual(["X"]);
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(tmux.pasteText).not.toHaveBeenCalled();
    expect(parked).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ type: "quota", action: "pause" })]);
    daemon.freezeRuntimeMonitors();
  });

  it("after the reset: Down, Down, Enter; no pause; composer is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const dir = dueDir(true);
    const { daemon, tmux, errors, parked } = makeDaemon(dir, MODAL);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tmux.sendSpecialKey.mock.calls.map((c: any[]) => c[0])).toEqual(["Down", "Down", "Enter"]);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.pasteText).not.toHaveBeenCalled();
    expect(parked).toEqual([]);
    expect(errors).toEqual([]);
    expect(readGrokWeeklyReset(dir)).toBeNull();
    daemon.freezeRuntimeMonitors();
  });

  it("Try Again while still limited: one Down×2+Enter, then Shift+x pauses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const dir = dueDir(true);
    const { daemon, tmux, state, errors } = makeDaemon(dir, MODAL);
    tmux.sendSpecialKey.mockImplementation(async () => true); // picker stays
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tmux.sendSpecialKey.mock.calls.map((c: any[]) => c[0])).toEqual(["Down", "Down", "Enter"]);
    expect(tmux.sendKeys.mock.calls.map((c: any[]) => c[0])).toEqual(["X"]);
    expect(errors).toEqual([expect.objectContaining({ type: "quota", action: "pause" })]);
    expect(state.pane).toBe(AFTER_X);
    daemon.freezeRuntimeMonitors();
  });

  it("ignored X after a still-limited Enter does not send Try Again again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const dir = dueDir(true);
    const { daemon, tmux } = makeDaemon(dir, MODAL);
    tmux.sendSpecialKey.mockImplementation(async () => true);
    tmux.sendKeys.mockImplementation(async () => true);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(tmux.sendSpecialKey.mock.calls.map((c: any[]) => c[0])).toEqual(["Down", "Down", "Enter"]);
    expect(tmux.sendKeys.mock.calls.map((c: any[]) => c[0])).toEqual(["X"]);
    daemon.freezeRuntimeMonitors();
  });
});
