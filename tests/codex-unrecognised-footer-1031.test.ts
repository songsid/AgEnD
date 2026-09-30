/**
 * #1031: after four fleet restarts, sol's codex resumed its session fine but
 * painted the idle composer without its Context status item — the footer was
 * only `⚠ 2 warnings · f2 to view` — although tui.status_line asked for it.
 * The first delivery after a spawn needs a positive input-row proof, which
 * needs a recognised footer, so the queued task waited 30 minutes, failed as
 * retryable, and waited again: seven hours, until a manual restart.
 *
 * When the footer is the only missing signal, the #978 structural evidence
 * now stands in, all of it required: the backend's stable-unknown idle check
 * (empty live composer; no busy row, queued ↳ input or known picker), no
 * input transient, the same screen for UNKNOWN_LAYOUT_STABLE_MS, and a raw
 * tty. The fixture is the bottom of sol's real pane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, UNKNOWN_LAYOUT_STABLE_MS } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const NO_CONTEXT = readFileSync(join(fixtures, "codex-0157-resumed-no-context-footer.pane.txt"), "utf8");
const LOADING_0159 = readFileSync(join(fixtures, "codex-0159-resume-loading.pane.txt"), "utf8");
const MESSAGE = "[from:agend-leader] start #1027";
/** After the Enter: the message is in the transcript and codex is working on it. */
const SUBMITTED = NO_CONTEXT.replace("› Ask Codex to do anything",
  `› ${MESSAGE}\n  (message_id: m)\n\n• Working (1s • esc to interrupt)\n\n› Ask Codex to do anything`);

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1031-"));
  dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@19");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = new CodexBackend(dir);
  const daemon = new Daemon("codex-1031", {
    working_directory: "/tmp", backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;
  const state = { pane: NO_CONTEXT, mode: "raw" as "raw" | "cooked" | "unknown" };
  const paste = vi.fn(async () => true);
  const enter = vi.fn(async () => { state.pane = SUBMITTED; return true; });
  daemon.tmux = {
    capturePane: async () => state.pane,
    capturePaneWithHistory: async () => state.pane,
    getPaneInputMode: async () => state.mode,
    pasteBuffer: paste,
    sendSpecialKey: enter,
    sendKeys: vi.fn(async () => true),
    isWindowAlive: async () => true,
    getWindowId: () => "@19",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = {
    isIdle: () => true,
    waitUntilIdle: async () => true,
    hasOutputSince: () => false,
    getLastOutputAt: () => 0,
    getObservationResetAt: () => 0,
  };
  // The first delivery after a spawn: the startup input proof is required.
  daemon.spawnGeneration++;
  daemon.inputTransientGuardGeneration = daemon.spawnGeneration;
  return { daemon, backend, state, paste, enter, logger };
}

async function settle<T>(promise: Promise<T>, maxMs = 40 * 60_000, stepMs = 250): Promise<T> {
  let done = false; let result!: T; let failure: unknown;
  void promise.then(v => { result = v; done = true; }, e => { failure = e; done = true; });
  for (let elapsed = 0; !done && elapsed <= maxMs; elapsed += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  if (failure) throw failure;
  if (!done) throw new Error(`did not settle within ${maxMs}ms`);
  return result;
}

describe("the real Context-less idle pane (#1031)", () => {
  it("is not delivery-ready by the footer proof, but is the #978 stable-unknown idle shape", () => {
    const backend = new CodexBackend("/tmp/agend-1031-fixture");
    expect(NO_CONTEXT).toContain("⚠ 2 warnings · f2 to view");
    expect(NO_CONTEXT).not.toContain("Context");
    expect(backend.isDeliveryInputReadyPane(NO_CONTEXT)).toBe(false);
    expect(backend.isStableUnknownLayoutIdlePane(NO_CONTEXT)).toBe(true);
  });

  it("the first delivery after a spawn lands after the pane is stable for 10 s, instead of waiting out 30 minutes", async () => {
    const h = makeHarness();
    const delivery = h.daemon.deliverMessage(MESSAGE, { chatId: "c", messageId: "m" }, { submissionId: "m" });
    await vi.advanceTimersByTimeAsync(UNKNOWN_LAYOUT_STABLE_MS - 1_000);
    expect(h.paste, "not before the screen has been stable for the full window").not.toHaveBeenCalled();
    await expect(settle(delivery, 60_000)).resolves.toBe(true);
    expect(h.paste).toHaveBeenCalledOnce();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Idle footer not recognised"));
    // Positive submission retires the startup guard as before: the fallback is not a permanent mode.
    expect(h.daemon.inputTransientGuardGeneration).toBeNull();
  });
});

describe("every #978 condition is required (#1031)", () => {
  /** Ask the fallback twice, a full stable window apart. */
  function readyAfterStableWindow(h: ReturnType<typeof makeHarness>, pane: string): boolean {
    h.daemon.deliveryInputReadyPane(pane);
    vi.advanceTimersByTime(UNKNOWN_LAYOUT_STABLE_MS + 1);
    return h.daemon.deliveryInputReadyPane(pane);
  }

  it("the same Context-less pane, stable for the window → ready", () => {
    const h = makeHarness();
    expect(h.daemon.deliveryInputReadyPane(NO_CONTEXT)).toBe(false); // first sight starts the clock
    vi.advanceTimersByTime(UNKNOWN_LAYOUT_STABLE_MS - 1);
    expect(h.daemon.deliveryInputReadyPane(NO_CONTEXT)).toBe(false);
    vi.advanceTimersByTime(2);
    expect(h.daemon.deliveryInputReadyPane(NO_CONTEXT)).toBe(true);
  });

  it("a screen that keeps changing never qualifies", () => {
    const h = makeHarness();
    for (let i = 0; i < 6; i++) {
      expect(h.daemon.deliveryInputReadyPane(NO_CONTEXT.replace("00:04", `00:0${i}`))).toBe(false);
      vi.advanceTimersByTime(UNKNOWN_LAYOUT_STABLE_MS / 2);
    }
  });

  it("a busy row, a queued message or the resume load is never delivery-ready, however long it is stable", () => {
    const h = makeHarness();
    // A working frame with the same Context-less footer (the fallback's case).
    const busyNoContext = NO_CONTEXT.replace("› Ask Codex to do anything", "• Working (12s • esc to interrupt)\n\n› Ask Codex to do anything");
    expect(readyAfterStableWindow(h, busyNoContext)).toBe(false);
    expect(readyAfterStableWindow(h, NO_CONTEXT.replace("› Ask Codex to do anything", "  ↳ queued text\n› Ask Codex to do anything"))).toBe(false);
    expect(readyAfterStableWindow(h, LOADING_0159)).toBe(false); // input transient on screen
  });

  it("a cooked or unknown tty is not ready even on a stable Context-less pane", async () => {
    for (const mode of ["cooked", "unknown"] as const) {
      const h = makeHarness();
      h.state.mode = mode;
      await h.daemon.hasPositiveDeliveryInput();
      await vi.advanceTimersByTimeAsync(UNKNOWN_LAYOUT_STABLE_MS + 1);
      await expect(h.daemon.hasPositiveDeliveryInput()).resolves.toBe(false);
      // Only a raw tty starts the stable clock.
      h.state.mode = "raw";
      await expect(h.daemon.hasPositiveDeliveryInput()).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(UNKNOWN_LAYOUT_STABLE_MS + 1);
      await expect(h.daemon.hasPositiveDeliveryInput()).resolves.toBe(true);
    }
  });

  it("the stranded-input check before a paste uses the same fallback, not a permanent 'busy'", () => {
    const h = makeHarness();
    const prompt = h.backend.getBottomReadyPattern()!;
    return (async () => {
      expect(await h.daemon.strandedInputState(prompt, false)).toBe("busy");
      await vi.advanceTimersByTimeAsync(UNKNOWN_LAYOUT_STABLE_MS + 1);
      expect(await h.daemon.strandedInputState(prompt, false)).toBe("clear");
    })();
  });
});
