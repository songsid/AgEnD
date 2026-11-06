import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";

/**
 * #2844: a codex business-workspace member out of credits (or past the owner's spend cap) gets a Yes/No
 * "Request increase? / Notify owner?" prompt under the error row. AgEnD held it as an unknown selection and, while a
 * held dialog is up, skips its error checks, so the quota pause never ran: a Needs-you item and a "stuck on a dialog"
 * warning instead. Now the prompt is matched by its exact rows and closed with Escape (never Yes), and the error row
 * pauses the instance, without the usage-window check that cannot see a workspace limit, and not again on wake.
 *
 * Fixtures: the real codex 0.165.0 against scripts/manual/codex-version-audit/mock.mjs (wscredits / wsspend).
 */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pane = (n: string) => readFileSync(join(fixtures, `codex-0165-workspace-${n}.pane.txt`), "utf8");
const CREDITS_PROMPT = pane("credits-prompt");
const SPEND_PROMPT = pane("spend-cap-prompt");
const CREDITS_AFTER_ESCAPE = pane("credits-after-escape");
// The real 0.165.0 rendering of an agent answer that quotes the rows (plain, `>` quote, fenced code): all indented.
const QUOTED = pane("quoted");

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "agend-2844-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); });
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const backend = () => new CodexBackend(tempDir());
const dialogsOn = (p: string) => backend().getRuntimeDialogs().filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)));
const WORKSPACE_DIALOG = "Codex workspace limit prompt — pressing Escape (never asking the owner)";

describe("the workspace limit prompt is recognised by its exact rows", () => {
  it.each([["credits (Request increase?)", CREDITS_PROMPT], ["spend cap", SPEND_PROMPT]])(
    "the live 0.165.0 %s prompt: the Escape spec is the first runtime dialog that matches", (_, p) => {
      const [first] = dialogsOn(p);
      expect(first.description).toBe(WORKSPACE_DIALOG);
      expect(first.keys).toEqual(["Escape"]);
      expect(first.holdOnly).toBeFalsy();
      expect(first.verifyAfterKeys).toBe(true);
    });

  const rows = (title: string, question: string[], cursorOnYes = false) => [
    "■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    `  ${title}`, ...question.map(q => `  ${q}`), "", "",
    `${cursorOnYes ? "› " : "  "}1. Yes (y)`, `${cursorOnYes ? "  " : "› "}2. No (default) (n)`, "", "  enter select · esc back",
  ].join("\n");

  it("the other title (Notify owner?), a question wrapped on a narrow pane, and the cursor on Yes all match", () => {
    for (const p of [
      rows("You've reached your workspace credit limit", ["Your workspace is out of credits. Ask your workspace owner to add more. Notify owner?"]),
      rows("You’ve reached your workspace credit limit", ["Your workspace is out of credits. Ask your workspace owner to add", "more. Notify owner?"]),
      rows("Usage limit reached", ["Request a limit increase from your owner to continue using", "codex. Request increase?"]),
      rows("Usage limit reached", ["Request a limit increase from your owner to continue using codex. Request increase?"], true),
    ]) expect(dialogsOn(p)[0]?.description, p).toBe(WORKSPACE_DIALOG);
  });

  it("anything else is not it: a mismatched title, another question, a third option, a reworded footer, or history", () => {
    const ok = rows("Usage limit reached", ["Request a limit increase from your owner to continue using codex. Request increase?"]);
    for (const p of [
      rows("You've reached your workspace credit limit", ["Request a limit increase from your owner to continue using codex. Request increase?"]),
      rows("Usage limit reached", ["Request a limit increase from your owner to continue using codex. Upgrade now?"]),
      ok.replace("  enter select · esc back", "  3. Something else\n  enter select · esc back"),
      ok.replace("enter select · esc back", "enter confirm · esc back"),
      ok.replace("2. No (default) (n)", "2. No (n)"),
      `${ok}\n› Ask Codex to do anything\n  Context 100% left`,
    ]) expect(dialogsOn(p).map(d => d.description), p).not.toContain(WORKSPACE_DIALOG);
  });
});

describe("the workspace limit rows pause, without the usage-window check", () => {
  const patterns = () => backend().getErrorPatterns();
  const hits = (line: string) => patterns().filter(p => { p.pattern.lastIndex = 0; return p.pattern.test(line); });

  it.each([
    ["■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.", "credits exhausted"],
    ["■ You're out of credits. Your workspace is out of credits. Add credits to continue using Codex.", "credits exhausted"],
    ["■ Your workspace is out of credits. Add credits to continue.", "credits exhausted"],
    ["■ You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.", "spend cap reached"],
    ["■ You hit your spend cap set in your workspace. Increase your spend cap to continue.", "spend cap reached"],
    ["■ Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.", "usage limit reached"],
    ["■ You hit your spend cap set by the owner of your\nworkspace. Ask an owner to increase your spend cap to continue.", "spend cap reached"],
  ])("%j → one quota pause (%s)", (line, what) => {
    const [hit, ...rest] = hits(line);
    expect(rest).toEqual([]);
    expect(hit).toMatchObject({ type: "quota", action: "pause", skipUsageVerify: true, historyUntilLiveComposer: true });
    expect(hit.message).toContain(`Codex workspace ${what}`);
    // Never the personal usage-limit pause, whose message the Luna Reserve logic keys on.
    expect(hit.message.startsWith("Codex usage limit reached")).toBe(false);
  });

  it("an agent's answer quoting them (the live 0.165.0 rendering) matches none: the glyph must be in column 0", () => {
    expect(QUOTED).toContain("  ■ Your workspace is out of credits.");
    expect(patterns().filter(p => p.skipUsageVerify && (p.pattern.lastIndex = 0, p.pattern.test(QUOTED)))).toEqual([]);
  });

  it("prose that only mentions them never matches: the rows must open with codex's status glyph", () => {
    for (const line of [
      "  ■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
      "\t■ You hit your spend cap set in your workspace. Increase your spend cap to continue.",
      "check whether the workspace is out of credits later",
      "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
      "• Your workspace is out of credits.",
      "> ■ is how codex shows it: You hit your spend cap set in your workspace.",
      "  Usage limit reached",
    ]) expect(hits(line).filter(h => h.skipUsageVerify), line).toEqual([]);
  });
});

function makeDaemon(initial: string) {
  const dir = tempDir();
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("codex-2844", {
    working_directory: "/tmp", backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new CodexBackend(dir), undefined, { child: () => logger } as any) as any;
  const state = { pane: initial, onKey: null as null | ((k: string) => void) };
  const keys: string[] = [];
  const pasted: string[] = [];
  daemon.tmux = {
    capturePane: vi.fn(async () => state.pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); state.onKey?.(k); return true; }),
    sendKeys: vi.fn(async (k: string) => { pasted.push(k); return true; }),
    pasteText: vi.fn(async (t: string) => { pasted.push(t); return true; }),
    pasteBuffer: vi.fn(async () => true),
    getWindowId: () => "@9", getLastPasteError: () => null, isLastPasteFailureRecoverable: () => true, getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = { isIdle: () => true, waitUntilIdle: async () => true, waitForIdle: async () => true };
  daemon.submitSystemPaste = vi.fn(async () => true);
  const errors: Array<{ type: string; action: string; message: string }> = [];
  const parked: unknown[] = [];
  daemon.on("pty_error", (e: { type: string; action: string; message: string }) => errors.push(e));
  daemon.on("dialog_parked", (e: unknown) => parked.push(e));
  return { daemon, state, keys, pasted, errors, parked };
}

const COMPOSER_ONLY = CREDITS_AFTER_ESCAPE.split("\n").filter(r => !r.startsWith("■")).join("\n");

describe("in the real Daemon: Escape, then one pause; a wake does not pause again", () => {
  it("prompt → Escape (no paste, no y) → the error row pauses once, nothing is parked", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys, pasted, errors, parked } = makeDaemon(COMPOSER_ONLY);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(6_000);                      // the launch composer: nothing on screen yet
    state.pane = CREDITS_PROMPT;
    state.onKey = k => { if (k === "Escape") state.pane = CREDITS_AFTER_ESCAPE; };
    await vi.advanceTimersByTimeAsync(130_000);                    // past the 1-minute parked threshold
    expect(keys).toEqual(["Escape"]);
    expect(pasted).toEqual([]);
    expect(parked).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({
      type: "quota", action: "pause", message: "Codex workspace credits exhausted — workspace owner must refill",
      notice: "⚠️ Codex workspace credits used up — paused" })]);   // #2873: the short line, from the real pane scan
    daemon.freezeRuntimeMonitors();
  });

  it("the prompt on the very first poll (no live composer before it): its row is the live incident and pauses once", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys, errors, parked } = makeDaemon(CREDITS_PROMPT);
    state.onKey = k => { if (k === "Escape") state.pane = CREDITS_AFTER_ESCAPE; };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(keys).toEqual(["Escape"]);
    expect(parked).toEqual([]);
    expect(errors.map(e => e.message)).toEqual(["Codex workspace credits exhausted — workspace owner must refill"]);
    daemon.freezeRuntimeMonitors();
  });

  it("first poll on the real spend-cap prompt, an older credits row above it: the pause is the spend cap's", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys, errors } = makeDaemon(SPEND_PROMPT);
    // Escape removes the prompt rows; the transcript (both error rows) stays above the composer.
    const after = SPEND_PROMPT.split("\n").filter(r => !/^\s*(?:Usage limit reached|Request a limit increase|[›\s]*\d\. (?:Yes|No)|enter select)/.test(r)).join("\n")
      + "\n› Ask Codex to do anything\n  Context 100% left";
    state.onKey = k => { if (k === "Escape") state.pane = after; };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(keys).toEqual(["Escape"]);
    expect(errors.map(e => e.message)).toEqual(["Codex workspace spend cap reached — workspace owner must raise it"]);
    daemon.freezeRuntimeMonitors();
  });

  it("an example of the row in the agent's answer (indented) never pauses", async () => {
    vi.useFakeTimers();
    const { daemon, state, errors } = makeDaemon(COMPOSER_ONLY);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(6_000);
    state.pane = COMPOSER_ONLY.replace("› Ask Codex",
      "• Example error in the runbook:\n\n  ■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.\n\n› Ask Codex");
    await vi.advanceTimersByTimeAsync(12_000);
    state.pane = QUOTED;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(errors).toEqual([]);
    daemon.freezeRuntimeMonitors();
  });

  it("an Escape that does not take: after the grace the prompt is a person's (interaction evidence, parked report)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const { daemon, keys, parked } = makeDaemon(CREDITS_PROMPT);    // Escape changes nothing
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(keys).toEqual(["Escape"]);
    expect(daemon.interactionEvidence(CREDITS_PROMPT, daemon.runtimeDialogs())).toBeNull();   // within the grace
    await vi.advanceTimersByTimeAsync(85_000);
    expect(daemon.interactionEvidence(CREDITS_PROMPT, daemon.runtimeDialogs())).toMatchObject({ kind: "dialog" });
    expect(parked).toHaveLength(1);
    daemon.freezeRuntimeMonitors();
  });

  it("while AgEnD answers it, the prompt is nobody's interaction (no awaiting_input, so no Needs-you ping)", () => {
    const { daemon } = makeDaemon(CREDITS_PROMPT);
    expect(daemon.interactionEvidence(CREDITS_PROMPT, daemon.runtimeDialogs())).toBeNull();
    // …until its answers are reported as ignored: then a person has to look.
    const dialog = daemon.runtimeDialogs().find((d: { description: string }) => d.description === WORKSPACE_DIALOG);
    daemon.dialogAnswers = { key: (Daemon as any).answerKey(dialog), ignored: 3, reported: true, screen: CREDITS_PROMPT, lastAnswerAt: 0 };
    expect(daemon.interactionEvidence(CREDITS_PROMPT, daemon.runtimeDialogs())).toMatchObject({ kind: "dialog" });
  });

  it("a resumed pane that reprints the old row is history; a new row after it pauses", async () => {
    vi.useFakeTimers();
    const { daemon, state, errors } = makeDaemon(CREDITS_AFTER_ESCAPE);  // the wake's resumed transcript
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toEqual([]);
    const row = "■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";
    state.pane = CREDITS_AFTER_ESCAPE.replace("› Ask Codex", `› retry\n${row}\n› Ask Codex`);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(errors.map(e => e.message)).toEqual(["Codex workspace credits exhausted — workspace owner must refill"]);
    daemon.freezeRuntimeMonitors();
  });
});

describe("the lifecycle pauses a workspace limit without asking the usage windows", () => {
  function lifecycle() {
    const verifyCodexQuota = vi.fn(async () => "available" as const);
    const notifyInstanceTopic = vi.fn();
    const ctx = {
      fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} }, eventLog: null, isPlannedRestart: () => false, notifyInstanceTopic,
      webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
      getInstanceDir: (n: string) => `/nonexistent/${n}`, verifyCodexQuota,
    } as unknown as LifecycleContext;
    const lc = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn(), isCodexLivePane: vi.fn(async () => true) });
    lc.attachIncidentHandlers("worker", daemon as any);
    return { daemon, verifyCodexQuota, notifyInstanceTopic };
  }

  it("a windows reply of 'available' cannot cancel it: the workspace row pauses, with one notice", async () => {
    const { daemon, verifyCodexQuota, notifyInstanceTopic } = lifecycle();
    const [ep] = backend().getErrorPatterns().filter(p => p.message.startsWith("Codex workspace spend cap"));
    daemon.emit("pty_error", { name: "worker", ...ep });
    await new Promise(r => setTimeout(r, 25));
    expect(verifyCodexQuota).not.toHaveBeenCalled();
    expect(daemon.requestPauseWhenIdle).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
  });

  it("the personal usage-limit pause still asks them (unchanged)", async () => {
    const { daemon, verifyCodexQuota, notifyInstanceTopic } = lifecycle();
    daemon.emit("pty_error", { name: "worker", type: "quota", action: "pause", message: "Codex usage limit reached — upgrade plan required" });
    await new Promise(r => setTimeout(r, 25));
    expect(verifyCodexQuota).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
  });
});
