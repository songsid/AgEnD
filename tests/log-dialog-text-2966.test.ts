/**
 * #2966 (M-2269, user-approved 11-03): the web Log shows the TEXT of a dialog or prompt AgEnD detected, not only "A dialog
 * waits" / "Waiting at a prompt". Claude Code never writes its permission dialogs, "Resume this conversation?" or
 * limit banners to its transcript, and alt-screen CLIs leave no tmux scrollback: the capture the scan already took is
 * the only record. Read-only bookkeeping: ANSI stripped, secrets masked, at most 30 lines / 2 KB, the same text not
 * logged twice, and nothing about delivery, answering or Needs you changes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { SCREEN_MAX_BYTES, SCREEN_MAX_LINES, dialogScreenText } from "../src/dialog-screen-text.js";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";
import { LogService } from "../src/log-service.js";

/** A shape the claude backend holds (not answered) and reports after its minute — with colour, and a secret on screen. */
const RESUME_VARIANT = [
  " \u001b[1mResume this session?\u001b[22m",
  " export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  " ❯ 1. Resume full session as-is",
  "   2. Resume from summary",
  " Enter to confirm",
].join("\n");
const READY = "───\n❯ \n───\n  ok\n  ⏵⏵ bypass permissions on";

const startupDialogs = ClaudeCodeBackend.prototype.getStartupDialogs.call(null);
const runtimeDialogs = ClaudeCodeBackend.prototype.getRuntimeDialogs.call(null);

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDaemon(backendOverrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2269-")); dirs.push(dir);
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
  const events: Array<{ e: string; d: any }> = [];
  for (const e of ["dialog_parked", "interactive_prompt"]) daemon.on(e, (d: unknown) => events.push({ e, d }));
  return { daemon, state, keys, paste, events, logger, dir };
}


describe("M-2269 dialogScreenText", () => {
  it("strips ANSI and control characters, keeps the bottom, masks secrets", () => {
    const t = dialogScreenText(RESUME_VARIANT);
    expect(t).toContain("Resume this session?");
    expect(t).toContain("❯ 1. Resume full session as-is");
    expect(t).not.toMatch(/\u001b/);
    expect(t, "the whole sequence goes, not only its ESC byte").not.toContain("[1m");
    expect(t.split("\n")[0]).toBe(" Resume this session?");
    expect(t).not.toContain("sk-ant-api03-AbCd");
    expect(t).toMatch(/\[REDACTED\]/);
  });

  it("at most 30 lines (the bottom ones) and 2 KB, cut at whole lines, never inside a character", () => {
    const tall = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n\n\n";
    const t = dialogScreenText(tall).split("\n");
    expect(t.length).toBe(SCREEN_MAX_LINES);
    expect([t[0], t.at(-1)]).toEqual(["line 50", "line 79"]);
    const wide = Array.from({ length: 30 }, (_, i) => `${i}:` + "對話框".repeat(40)).join("\n");
    const w = dialogScreenText(wide);
    expect(Buffer.byteLength(w, "utf8")).toBeLessThanOrEqual(SCREEN_MAX_BYTES);
    expect(w.split("\n").at(-1)).toBe("29:" + "對話框".repeat(40));        // the bottom kept whole
    for (const line of w.split("\n")) expect(line, "cut at whole lines").toMatch(/^\d+:(對話框){40}$/);
    const oneHuge = dialogScreenText("é".repeat(5000));
    expect(Buffer.byteLength(oneHuge, "utf8")).toBeLessThanOrEqual(SCREEN_MAX_BYTES);
    expect(oneHuge).not.toContain("\ufffd");
    expect(dialogScreenText("")).toBe("");
    expect(dialogScreenText("\n\n  \n")).toBe("");
  });
});

describe("M-2269 the daemon's events carry the screen, from the capture it already took", () => {
  it("dialog_parked: the held dialog's text, masked; one capture per scan (nothing new captured for it)", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys, events } = makeDaemon();
    state.pane = RESUME_VARIANT;
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(70_000);
    const parked = events.filter(x => x.e === "dialog_parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]!.d.screen).toContain("Resume full session as-is");
    expect(parked[0]!.d.screen).not.toContain("sk-ant-api03");
    expect(keys, "still never answered").toEqual([]);
    clearInterval(daemon.errorMonitorTimer);
  });

  it("interactive_prompt: the prompt as it was on screen", async () => {
    vi.useFakeTimers();
    const { daemon, state, events } = makeDaemon();
    state.pane = "Installing packages…\n[sudo] password for han: ";
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(40_000);
    const p = events.filter(x => x.e === "interactive_prompt");
    expect(p.length).toBeGreaterThanOrEqual(1);
    expect(p[0]!.d.screen).toContain("[sudo] password for han:");
    expect(p[0]!.d.kind).toBe("sudo_password");
    clearInterval(daemon.errorMonitorTimer);
  });
});

describe("M-2269 the event log and the Log", () => {
  function lifecycle() {
    const inserted: Array<{ name: string; type: string; data: any }> = [];
    const lc = new InstanceLifecycle({ eventLog: { insert: (name: string, type: string, data: unknown) => inserted.push({ name, type, data }) } } as any) as any;
    return { lc, inserted };
  }
  it("dedupe: the same screen re-seen is not stored again; a new one is; per instance", () => {
    const { lc } = lifecycle();
    expect(lc.screenForLog("w", "A dialog")).toEqual({ screen: "A dialog" });
    expect(lc.screenForLog("w", "A dialog")).toEqual({});
    expect(lc.screenForLog("x", "A dialog"), "another instance").toEqual({ screen: "A dialog" });
    expect(lc.screenForLog("w", "Another dialog")).toEqual({ screen: "Another dialog" });
    expect(lc.screenForLog("w", "")).toEqual({});
    expect(lc.screenForLog("w", undefined)).toEqual({});
  });

  it("the Log's events: the screen as its own field (masked again), never folded into the detail JSON", async () => {
    const rows = [
      { id: 1, created_at: "2026-11-03 03:00:00", event_type: "dialog_parked", payload: { description: "Claude resume", holdOnly: true, screen: "Resume this session?\npassword=hunter2abc99" } },
      { id: 2, created_at: "2026-11-03 03:00:01", event_type: "interactive_prompt", payload: { kind: "sudo_password" } },
    ];
    const svc = new LogService({ events: () => rows } as any) as any;
    const { events } = svc.eventsFor("w", undefined);
    const parked = events.find((e: any) => e.type === "dialog_parked");
    expect(parked.screen).toContain("Resume this session?");
    expect(parked.screen).not.toContain("hunter2abc99");
    expect(parked.detail).not.toContain("screen");
    expect(parked.detail).toContain("Claude resume");
    expect(events.find((e: any) => e.type === "interactive_prompt").screen).toBeUndefined();
  });
});
