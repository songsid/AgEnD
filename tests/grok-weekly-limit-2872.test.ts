/**
 * #2872: grok's weekly-limit modal ("You hit your weekly limit." · Upgrade tier · Buy more credits · [Try Again]) was a
 * hold-only dialog: a Needs-you item and a parked warning that ended with Claude's session-resume advice, and the
 * instance was never paused. Now (the policy the user approved for codex, #2844) AgEnD presses Shift+x, typed, never a
 * paste, an Enter or a digit; on its verified dismissal it pauses the instance as a quota limit, with one notice. The
 * modal leaves no error row, so a new daemon on the resumed pane has nothing to pause on again.
 * And the parked-hold notice carries the Claude session-resume advice only for that Claude prompt.
 *
 * Fixtures: grok 1.0.70 captured offline (tests/fixtures/grok-1.0.70-weekly-limit/README.md).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { GrokBackend } from "../src/backend/grok.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { InstanceLifecycle, plainNoticeLine, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale } from "../src/locale.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/grok-1.0.70-weekly-limit/${n}.pane.txt`, import.meta.url), "utf8");
const MODAL = fx("modal"), SCROLLBACK = fx("modal-scrollback-focus"), AFTER = fx("after-shift-x"), AFTER_ESC = fx("after-esc-then-shift-x");
const OLD_MODAL = readFileSync(new URL("./fixtures/grok-weekly-limit-modal.pane.txt", import.meta.url), "utf8");

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2867-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const runtimeHit = (pane: string) => new GrokBackend(tmp()).getRuntimeDialogs().filter(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)))
  .find(d => /Grok 週限/.test(d.description));

describe("the modal is matched by its rows, both builds, both focus states", () => {
  it.each([["1.0.70 (three options)", () => MODAL], ["the earlier build (two options)", () => OLD_MODAL], ["focus moved to the scrollback (Esc)", () => SCROLLBACK]])(
    "%s → the Shift+x spec", (_, pane) => { expect(runtimeHit(pane())).toMatchObject({ keys: ["X"], literalKeys: true, verifyAfterKeys: true }); });

  it("anything else is not it: after the dismissal, another option, a reworded footer, the modal quoted above the composer", () => {
    for (const pane of [AFTER, AFTER_ESC,
      MODAL.replace("3 (○) Try Again", "3 (○) Pay as you go"),
      MODAL.replace("↑/↓ navigate · y copy", "↑/↓ navigate"),
      MODAL.replace("  3 (○) Try Again", "  3 (○) Try Again\n  ┃  4 (○) Something else  Something"),
      // Prism r1: an unknown or duplicate numbered row ANYWHERE in the list, not only after Credits.
      MODAL.replace("  ┃  1 (○) Upgrade tier", "  ┃  0 (○) Subscribe now     A new paid choice\n  ┃  1 (○) Upgrade tier"),
      MODAL.replace("  ┃  2 (○) Buy more credits", "  ┃  0 (○) Subscribe now     A new paid choice\n  ┃  2 (○) Buy more credits"),
      MODAL.replace("  ┃  2 (○) Buy more credits", "  ┃  1 (○) Upgrade tier      Upgrade to a higher tier for more usage\n  ┃  2 (○) Buy more credits"),
      OLD_MODAL.replace("  ┃  1 (○) Upgrade tier", "  ┃  0 (○) Subscribe now     A new paid choice\n  ┃  1 (○) Upgrade tier"),
      MODAL.replace("2 (○) Buy more credits", "2 (○) Pay as you go"),
      `${MODAL}\n╭──╮\n│ ❯ │\n╰──╯\n  Shift+Tab:mode  │  Ctrl+x:shortcuts`]) expect(runtimeHit(pane), pane.slice(-120)).toBeUndefined();
  });
});

function makeDaemon(initial: string) {
  const dir = tmp();
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("grok-2867", {
    working_directory: "/tmp", backend: "grok",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new GrokBackend(dir), undefined, { child: () => logger } as any) as any;
  const state = { pane: initial };
  const tmux = {
    capturePane: vi.fn(async () => state.pane), isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async () => true), sendKeys: vi.fn(async (k: string) => { if (k === "X") state.pane = AFTER; return true; }),
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
  it("the live 1.0.70 modal: X typed once, no paste/Enter/digit, nothing parked, no interaction for a person, one quota pause", async () => {
    vi.useFakeTimers();
    const { daemon, tmux, errors, parked } = makeDaemon(MODAL);
    expect(daemon.interactionEvidence(MODAL, daemon.runtimeDialogs())).toBeNull();   // AgEnD answers it: no Needs-you
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tmux.sendKeys.mock.calls.map((c: any[]) => c[0])).toEqual(["X"]);
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(tmux.pasteText).not.toHaveBeenCalled();
    expect(parked).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ type: "quota", action: "pause", skipUsageVerify: true })]);
    daemon.freezeRuntimeMonitors();
  });

  it("a wake: a new daemon on the resumed pane (no modal, no error row) raises nothing", async () => {
    vi.useFakeTimers();
    const { daemon, tmux, errors } = makeDaemon(AFTER);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(errors).toEqual([]);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    daemon.freezeRuntimeMonitors();
  });

  it("a Shift+x that does not take: no pause raised; after the grace a person is told (parked)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const { daemon, tmux, errors, parked } = makeDaemon(MODAL);
    tmux.sendKeys.mockImplementation(async () => true);           // the modal stays
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(errors).toEqual([]);
    expect(parked.length).toBe(1);
    expect(parked[0].advice).toBeUndefined();
    daemon.freezeRuntimeMonitors();
  });
});

describe("the parked-hold notice: Claude's resume advice only on Claude's resume prompt", () => {
  function lifecycle() {
    const notifyInstanceTopic = vi.fn();
    const ctx = {
      fleetConfig: { instances: { worker: { backend: "grok" } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} }, eventLog: null, isPlannedRestart: () => false, notifyInstanceTopic,
      webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
      getInstanceDir: (n: string) => `/nonexistent/${n}`,
    } as unknown as LifecycleContext;
    const lc = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
    lc.attachIncidentHandlers("worker", daemon as any);
    return { daemon, notifyInstanceTopic };
  }
  const textOf = (m: any) => String(m.mock.calls.at(-1)?.[1] ?? "");

  it.each(["en", "zh-TW"] as const)("%s: a grok (any non-Claude) hold has no Claude sentence; Claude's resume hold keeps it", (lang) => {
    setLocale(lang);
    const { daemon, notifyInstanceTopic } = lifecycle();
    daemon.emit("dialog_parked", { name: "worker", description: "Grok Build weekly limit (Grok 週限)", holdOnly: true });
    expect(textOf(notifyInstanceTopic)).not.toMatch(/Resume full session as-is|Resume from summary/);
    const claudeHold = new ClaudeCodeBackend(tmp()).getRuntimeDialogs().find(d => /Claude session resume prompt \(unrecognised/.test(d.description))!;
    expect(claudeHold.parkedAdvice).toBe("claude-resume");
    daemon.emit("dialog_parked", { name: "worker", description: claudeHold.description, holdOnly: true, advice: claudeHold.parkedAdvice });
    expect(textOf(notifyInstanceTopic)).toMatch(/Resume full session as-is/);
  });

  it.each(["en", "zh-TW"] as const)("%s: an automatic answer that did not take (stuck): the advice only when the dialog opts in (Prism r1)", (lang) => {
    setLocale(lang);
    const { daemon, notifyInstanceTopic } = lifecycle();
    daemon.emit("dialog_parked", { name: "worker", description: "Grok Build weekly limit (Grok 週限)", holdOnly: false });
    expect(textOf(notifyInstanceTopic)).not.toMatch(/Resume full session as-is/);
    daemon.emit("dialog_parked", { name: "worker", description: "Claude session resume prompt — select 'Resume full session as-is'", holdOnly: false, advice: "claude-resume" });
    expect(textOf(notifyInstanceTopic)).toMatch(/Resume full session as-is/);
  });

  it("only Claude's session-resume prompts opt in: no other Claude or grok dialog carries the advice", () => {
    const backends = [new ClaudeCodeBackend(tmp()), new GrokBackend(tmp())];
    const withAdvice = backends.flatMap(b => [...b.getRuntimeDialogs(), ...b.getStartupDialogs()]).filter((d: any) => d.parkedAdvice).map(d => d.description);
    expect(new Set(withAdvice)).toEqual(new Set(["Claude session resume prompt (unrecognised variant) — holding for a human, never auto-selecting",
      "Claude session resume prompt — select 'Resume full session as-is'"]));
  });
});

describe("the one line outside the instance's own topic says whose (a ClassicBot's notices go to General)", () => {
  it("own topic: as it is; elsewhere: the name after the emoji", () => {
    setLocale("en");
    expect(plainNoticeLine("⚠️ Grok weekly limit used up — paused", null)).toBe("⚠️ Grok weekly limit used up — paused");
    expect(plainNoticeLine("⚠️ Grok weekly limit used up — paused", "classic-x-grok-bot")).toBe("⚠️ classic-x-grok-bot: Grok weekly limit used up — paused");
    setLocale("zh-TW");
    expect(plainNoticeLine("⚠️ Grok 週用量用完，已暫停", "classic-x-grok-bot")).toBe("⚠️ classic-x-grok-bot：Grok 週用量用完，已暫停");
    expect(plainNoticeLine("no emoji here", "w")).toBe("w：no emoji here");
  });
  it("through the lifecycle: a ClassicBot grok's pause notice in General names it", async () => {
    setLocale("en");
    const inc = runtimeHit(MODAL)!.dismissIncident!;
    const notifyInstanceTopic = vi.fn();
    const ctx = { fleetConfig: { instances: { "classic-x": { backend: "grok" }, general: { backend: "claude-code", general: true } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} }, eventLog: null, isPlannedRestart: () => false, notifyInstanceTopic,
      webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
      getInstanceDir: (n: string) => `/nonexistent/${n}`, isClassicInstance: (n: string) => n === "classic-x" } as unknown as LifecycleContext;
    const lc = new InstanceLifecycle(ctx);
    (lc as any).findGeneralInstance = () => "general";
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
    lc.attachIncidentHandlers("classic-x", daemon as any);
    daemon.emit("pty_error", { name: "classic-x", ...inc, skipUsageVerify: true });
    await new Promise(r => setTimeout(r, 25));
    expect(notifyInstanceTopic.mock.calls.map((c: any[]) => [c[0], c[1]])).toEqual([["general", "⚠️ classic-x: Grok weekly limit used up — paused"]]);
  });
});

describe("the notice: the user's one line (hmsg-0687db4d), no name, no action suffix", () => {
  it.each([["en", "⚠️ Grok weekly limit used up — paused"], ["zh-TW", "⚠️ Grok 週用量用完，已暫停"]] as const)(
    "%s: exactly one notice, exactly that text; the instance is paused", async (lang, text) => {
      setLocale(lang);
      const inc = runtimeHit(MODAL)!.dismissIncident!;
      expect(inc).toMatchObject({ message: "Grok weekly limit used up — paused", notice: text });   // message: logs and webhooks, unlocalised
      const notifyInstanceTopic = vi.fn();
      const ctx = { fleetConfig: { instances: { worker: { backend: "grok" } }, defaults: {} }, logger: { info() {}, warn() {}, error() {}, debug() {} },
        eventLog: null, isPlannedRestart: () => false, notifyInstanceTopic, webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {},
        restartSingleInstance: async () => {}, getInstanceDir: (n: string) => `/nonexistent/${n}` } as unknown as LifecycleContext;
      const lc = new InstanceLifecycle(ctx);
      const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
      lc.attachIncidentHandlers("worker", daemon as any);
      daemon.emit("pty_error", { name: "worker", ...inc, skipUsageVerify: true });
      await new Promise(r => setTimeout(r, 25));
      expect(notifyInstanceTopic.mock.calls.map((c: any[]) => c[1])).toEqual([text]);
      expect((ctx as any).webhookEmit).toHaveBeenCalledWith("pty_error", "worker", { type: "quota", action: "pause", message: "Grok weekly limit used up — paused" });
      expect(daemon.requestPauseWhenIdle).toHaveBeenCalledTimes(1);
      // Every other incident keeps the shared "<emoji> <name>: <message> (action: …)" shape.
      daemon.emit("pty_error", { name: "worker", type: "quota", action: "notify", message: "Some other notice" });
      await new Promise(r => setTimeout(r, 25));
      expect(String(notifyInstanceTopic.mock.calls.at(-1)?.[1])).toMatch(/worker.*Some other notice/);
    });
});
