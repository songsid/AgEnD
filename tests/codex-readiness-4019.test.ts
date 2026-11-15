import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexBackend, CodexPaneDetectors } from "../src/backend/codex.js";
import { createNativePaneBackend } from "../src/backend/native-pane.js";
import { CODEX_EMPTY_PASSIVE_COMPOSER, CODEX_STATUS_PASSIVE_COMPOSER } from "../src/backend/codex-footer-hints.js";
import { Daemon } from "../src/daemon.js";

const capture = (name: string) => readFileSync(new URL("./fixtures/codex-readiness-4019/" + name, import.meta.url), "utf8");
const draft = capture("restored-draft.txt"), resumed = capture("footerless-resume.txt");
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const context = { statusLineItems: () => ["context-remaining"], launchMayResume: () => true };

describe("#4019: the same real restored draft under Unix and ConPTY", () => {
  it.each([false, true])("recognizes the owned multiline composer as idle without changing its text (ConPTY=%s)", windowsConpty => {
    const backend = new CodexPaneDetectors({ ...context, windowsConpty });
    expect(backend.ownsComposerRows(draft)).toBe(true);
    expect(backend.getBusyPattern().test(draft)).toBe(false);
    expect(backend.getReadyPattern().test(draft)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(draft)).toBe(true);
  });

  it.each(["linux", "native"] as const)("the real %s state monitor starts idle time for the draft and never types", async mode => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const root = mkdtempSync(join(tmpdir(), "agend-4019-")); roots.push(root);
    const backend = mode === "linux" ? new CodexBackend(root) : createNativePaneBackend("codex", () => ({ sessionId: null, contextPercentage: null, statusLineItems: ["context-remaining"], resumes: false }));
    const control = Object.assign(new EventEmitter(), { isIdle: () => true, waitUntilIdle: async () => true, getLastOutputAt: () => 0, getObservationResetAt: () => 0 });
    let screen = "• Working (1s • esc to interrupt)\n\n› Ask Codex to do anything\n  Context 100% left";
    const input = vi.fn(() => { throw Error("An idle observation must not edit or submit the draft"); });
    const pane = { getWindowId: () => "@4019", capturePane: vi.fn(async () => screen), sendKeys: input, sendSpecialKey: input, sendKeySequence: input };
    const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
    const daemon: any = new Daemon("codex-4019", { working_directory: root, backend: "codex", hang_detector: { enabled: true, timeout_minutes: 10, idle_debounce_ms: 2_000 }, log_level: "silent" } as never, root, true, backend, control as never, logger as never);
    daemon.tmux = pane;
    try {
      daemon.startInstanceStateMonitor(); await vi.advanceTimersByTimeAsync(0);
      expect(daemon.getInstanceState()).toBe("working");
      screen = draft; control.emit("output:@4019", { paneId: "%4019", windowId: "@4019", at: Date.now() });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(daemon.getInstanceState()).toBe("idle");
      expect(daemon.instanceIdleSinceMono).not.toBeNull();
      expect(screen).toBe(draft); expect(input).not.toHaveBeenCalled();
    } finally { daemon.stopInstanceStateMonitor(); }
  });

  it("keeps the same draft proof when a configured Context item follows the model", () => {
    const b = new CodexPaneDetectors({ statusLineItems: () => ["model-with-reasoning", "context-remaining", "current-dir"], launchMayResume: () => false });
    const screen = draft.replace("Context 100% left", "gpt-6-luna medium · Context 100% left · ~/scratch");
    expect(b.getReadyPattern().test(screen)).toBe(true); expect(b.isPeriodicRedrawIdlePane(screen)).toBe(true);
  });

  it("keeps working, numbered selections, historical output and unknown footers out of idle", () => {
    const b = new CodexPaneDetectors(context);
    expect(b.isPeriodicRedrawIdlePane("• Working (4s • esc to interrupt)\n" + draft)).toBe(false);
    for (const bad of [
      "› 1. Pick this\n  2. Or this\n\n  Context 100% left",
      "› old question\n  wrapped history\n• Called a tool\n  result\n\n  Context 100% left",
      draft.replace("Context 100% left", "unrecognized footer"),
      draft.replace("Context 100% left", ""),
    ]) expect(b.getReadyPattern().test(bad)).toBe(false);
  });
});

describe("#4019: only an owned native resume may recognize the exact empty footerless composer", () => {
  const backend = (resume = true, items = ["context-remaining"]) => createNativePaneBackend("codex", () => ({ sessionId: null, contextPercentage: null, statusLineItems: items, resumes: true }), { contextlessResume: resume });
  it("recognizes the captured empty layout only with resume admission and its configured status", () => {
    const b = backend();
    expect(CODEX_EMPTY_PASSIVE_COMPOSER.test(resumed)).toBe(false);
    expect(CODEX_STATUS_PASSIVE_COMPOSER.test(resumed.replace("Ask Codex to do anything", "/status"))).toBe(false);
    expect(b.isDeliveryInputReadyPane!(resumed)).toBe(true);
    expect(b.getReadyPattern().test(resumed)).toBe(true);
    expect(b.isPeriodicRedrawIdlePane!(resumed)).toBe(true);
    for (const other of [backend(false), backend(true, ["model"]), new CodexPaneDetectors(context)]) {
      expect(other.isDeliveryInputReadyPane!(resumed)).toBe(false);
      expect(other.getReadyPattern().test(resumed)).toBe(false);
    }
  });
  it("does not grant this exception to a draft, output, unknown footer, live work or a dialog", () => {
    const b = backend();
    for (const bad of [resumed.replace("› Ask Codex to do anything", "› unsent text"), resumed.trimEnd() + "\n  unknown footer", resumed.trimEnd() + "\n• output"]) expect(b.isDeliveryInputReadyPane!(bad)).toBe(false);
    expect(b.isDeliveryInputReadyPane!("• Working (2s • esc to interrupt)\n" + resumed)).toBe(false);
    vi.spyOn(b, "getRuntimeDialogs").mockReturnValue([{ pattern: /ACTIVE DIALOG/, keys: [], holdOnly: true, description: "fixture", isActive: () => true }]);
    expect(b.isDeliveryInputReadyPane!("ACTIVE DIALOG\n" + resumed)).toBe(false);
  });
});
