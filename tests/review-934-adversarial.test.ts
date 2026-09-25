import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";

/**
 * Regression for the Kiro "pasted but never submitted" bug, reproduced live on
 * kiro-cli 2.21.0 --legacy-ui (2026-09-03):
 *
 *   Kiro DROPS an Enter that arrives while it is busy but keeps the typed text as
 *   typeahead. The daemon's delivery idle gate for Kiro used to be output
 *   silence alone (2s), and a shell/MCP tool call is silent for its whole
 *   duration — so a message queued while the instance was working got pasted
 *   into that window, both Enters were dropped, "some output after Enter"
 *   (the turn's own output) confirmed it ✅, and the text sat in the prompt row
 *   until the next delivery submitted two messages as one.
 *
 * The frames below are the verbatim pane tails from that reproduction.
 */
const TOOL_RUNNING = [
  "1% !> Use your shell tool to run exactly this command and nothing else: sleep 9; echo DONE-MARKER .",
  "I will run the following command: sleep 9; echo DONE-MARKER (using tool: shell)",
  "Purpose: Sleep 9 seconds then echo marker",
].join("\n");
const IDLE_BARE = " ▸ Time: 15s\n2% !>";
const MESSAGE = "[user:hanhanv via discord, id:368442276000694273] MSG-1 pasted while kiro was busy\n(message_id: 1)";
const STRANDED = ` ▸ Time: 15s\n2% !> ${MESSAGE.split("\n")[0]}`;
const GENERATING = `2% !> ${MESSAGE.split("\n")[0]}\n⠇ Thinking...`;
const OLD_STRANDED = " ▸ Time: 9s\n7% !> [from:agend-leader-t1503382358143799511] an earlier message whose Enter was dropped";
const SUBMITTED_WITHOUT_SPINNER = [
  " ▸ Time: 9s",
  "32% λ !>",
  MESSAGE,
  "I will inspect the fleet now.",
  "Running tool: list_instances",
  "The instance list is ready; I am preparing the reply.",
].join("\n");

const KIRO_COMPAT = {
  version: "kiro-cli 2.21.0", supportsRequireMcpStartup: true, supportsLegacyUi: true, supportsEffortFlag: true, source: "version" as const,
};

interface Harness {
  daemon: any;
  state: { pane: string; silent: boolean; outputSince: boolean };
  paste: ReturnType<typeof vi.fn>;
  enter: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  events: string[];
  dir: string;
}

function makeHarness(backend: unknown): Harness {
  const dir = mkdtempSync(join(tmpdir(), "agend-kiro-enter-drop-"));
  writeFileSync(join(dir, "window-id"), "@7");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("kiro-test", {
    working_directory: "/tmp",
    backend: "kiro-cli",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;

  const state = { pane: IDLE_BARE, silent: true, outputSince: true };
  const paste = vi.fn(async () => true);
  const enter = vi.fn(async () => true);
  const capture = vi.fn(async () => state.pane);
  daemon.tmux = {
    capturePane: capture,
    capturePaneWithHistory: vi.fn(async () => state.pane),
    pasteBuffer: paste,
    sendSpecialKey: enter,
    sendKeys: vi.fn(async () => true),
    isWindowAlive: async () => true,
    getWindowId: () => "@7",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => "send-keys failed",
  };
  daemon.controlClient = {
    isIdle: () => state.silent,
    waitUntilIdle: async () => { while (!state.silent) await new Promise(r => setTimeout(r, 50)); return true; },
    hasOutputSince: () => state.outputSince,
    getLastOutputAt: () => 0,
    getObservationResetAt: () => 0,
  };
  const events: string[] = [];
  for (const e of ["message_queued", "message_delivered", "message_confirmed", "message_failed"]) {
    daemon.on(e, () => events.push(e));
  }
  return { daemon, state, paste, enter, capture, events, dir };
}

/** Drive a delivery under fake timers until it settles (or the budget runs out). */
async function settle<T>(promise: Promise<T>, maxMs = 120_000, stepMs = 100): Promise<T> {
  let done = false;
  let result!: T;
  void promise.then(v => { result = v; done = true; });
  for (let elapsed = 0; !done && elapsed <= maxMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) throw new Error(`delivery did not settle within ${maxMs}ms of fake time`);
  return result;
}

const kiro = () => new KiroBackend(mkdtempSync(join(tmpdir(), "agend-kiro-be-")), KIRO_COMPAT);
const STATUS = { chatId: "c", messageId: "m" };
const dirs: string[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});


describe("PR934 adversarial review", () => {
  it("does not confirm typeahead that becomes visible between residue and ready captures", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.outputSince = false;
    h.paste.mockImplementation(async () => { h.state.pane = TOOL_RUNNING; return true; });
    let afterDelivered = false;
    let capturesAfterDelivered = 0;
    h.daemon.on("message_delivered", () => { afterDelivered = true; });
    h.capture.mockImplementation(async () => {
      if (afterDelivered && ++capturesAfterDelivered === 2) {
        // The residue capture inside kiroSubmissionEvidence precedes the old
        // turn's completion; readiness/history then see its unsent typeahead.
        h.state.pane = `2% !> ${MESSAGE.replace(/\n/g, " ")}`;
        return TOOL_RUNNING;
      }
      return h.state.pane;
    });
    await settle(h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "1" }), 10_000);
    expect(h.events, "unsent current input must disqualify the history hit").not.toContain("message_confirmed");
  });

  it("does not confirm after cancel during the awaited history capture", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.outputSince = false;
    h.paste.mockImplementation(async () => { h.state.pane = TOOL_RUNNING; return true; });
    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "1", deliveryEpoch: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.events).toContain("message_queued");
    h.state.pane = `${SUBMITTED_WITHOUT_SPINNER}\n3% !>`;
    h.daemon.tmux.capturePaneWithHistory.mockImplementation(async () => {
      h.daemon.clearPendingDeliveries();
      return h.state.pane;
    });
    expect(await settle(delivery, 5_000), "cancelled delivery must not become confirmed").toBe(false);
    expect(h.events).not.toContain("message_confirmed");
  });

  it("does not send a strand retry after a spawn starts while awaiting the pane lock", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.outputSince = false;
    h.paste.mockImplementation(async () => { h.state.pane = TOOL_RUNNING; return true; });
    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "1", deliveryEpoch: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.events).toContain("message_queued");
    expect(h.enter).toHaveBeenCalledTimes(2);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = h.daemon.paneWriteLock.run(() => gate);
    h.state.pane = STRANDED;
    await vi.advanceTimersByTimeAsync(1_000);
    // The observer saw a strand and queued its writer behind holder.
    h.daemon.beginSpawn();
    release();
    await holder;
    await vi.advanceTimersByTimeAsync(100);
    const sent = h.enter.mock.calls.length;
    h.daemon.clearPendingDeliveries();
    h.daemon.endSpawn();
    await settle(delivery, 5_000);
    expect(sent, "old-generation Enter must not reach a spawning replacement").toBe(2);
  });

  it("keeps a static busy-history hit uncertain and stops after cancellation", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.outputSince = false;
    h.paste.mockImplementation(async () => { h.state.pane = TOOL_RUNNING; return true; });
    h.daemon.tmux.capturePaneWithHistory.mockResolvedValue(`${MESSAGE}\n${TOOL_RUNNING}`);
    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "1", deliveryEpoch: 0 });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.events).not.toContain("message_failed");
    expect(h.events).not.toContain("message_confirmed");
    h.daemon.clearPendingDeliveries();
    expect(await settle(delivery, 2_000)).toBe(false);
  });
});

describe("PR934 remaining lifecycle and failure paths", () => {
  it("does not send recovery Enter after cancel during its under-lock residue read", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.outputSince = false;
    h.paste.mockImplementation(async () => { h.state.pane = TOOL_RUNNING; return true; });
    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "1", deliveryEpoch: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.events).toContain("message_queued");
    h.state.pane = STRANDED;
    let cancelledUnderLock = false;
    h.capture.mockImplementation(async () => {
      if (h.daemon.paneWriteLock.isBusy && !cancelledUnderLock) {
        cancelledUnderLock = true;
        h.daemon.clearPendingDeliveries();
      }
      return h.state.pane;
    });
    expect(await settle(delivery, 5_000)).toBe(false);
    expect(cancelledUnderLock).toBe(true);
    expect(h.enter, "cancel must invalidate the next recovery write").toHaveBeenCalledTimes(2);
  });

  it("fails a vanished window after an ambiguous paste", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.outputSince = false;
    h.paste.mockImplementation(async () => { h.state.pane = TOOL_RUNNING; return true; });
    const verdict = { reached: false };
    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "1", verdict });
    await vi.advanceTimersByTimeAsync(10_000);
    h.daemon.tmux.isWindowAlive = async () => false;
    expect(await settle(delivery, 2_000)).toBe(false);
    expect(h.events.at(-1)).toBe("message_failed");
    expect(verdict).toMatchObject({ reached: true, phase: "post-submit-proof", proof: "window-gone" });
  });

  it("releases uncertainty at the ten-minute cap without a false failure verdict", async () => {
    const h = makeHarness(kiro()); dirs.push(h.dir);
    h.state.outputSince = false;
    h.paste.mockImplementation(async () => { h.state.pane = TOOL_RUNNING; return true; });
    const verdict = { reached: false };
    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "1", verdict });
    expect(await settle(delivery, 620_000, 1_000)).toBe(false);
    expect(h.events.at(-1)).toBe("message_queued");
    expect(verdict).toMatchObject({ reached: false, phase: "post-submit-proof", proof: "unproven" });
    expect(h.daemon.paneWriteLock.isBusy).toBe(false);
    expect(h.enter).toHaveBeenCalledTimes(2);
  });
});
