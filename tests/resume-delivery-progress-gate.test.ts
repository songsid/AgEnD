import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { GrokBackend } from "../src/backend/grok.js";

/**
 * #826: a woken paused codex was reported as a failed delivery while it was
 * still coming back.
 *
 * The delivery gate waits up to thirty MINUTES for a busy pane, but a pane
 * showing a passive startup transient had a flat thirty-SECOND cap. codex is
 * the only backend that declares such a transient (`Resuming session…` plus
 * `model: loading`, backend/codex.ts), and its resume routinely runs past that
 * cap — so the one case with a transient was also the one case slow enough to
 * exceed it. The message was discarded and ❌ went to the sender for a pane
 * that was seconds away from its prompt.
 *
 * The cap is now measured in progress: a resume that keeps repainting keeps its
 * budget, a screen that stops changing loses it. Both ends stay bounded, which
 * is what these tests hold — the fix must not turn "wait longer" into "wait
 * forever", and a genuinely wedged pane must still fail.
 */

/**
 * Verbatim codex 0.154.0 resume frame, with one row varied so a test can make
 * the screen repaint. Every part of it is load-bearing: CodexBackend.isActive
 * requires the boxed header, a `model: loading` row inside the box, the
 * `Resuming session…` status row below it, and an apparent `›` input row under
 * that — the input row that accepts a paste and swallows the Enter, which is
 * the whole reason this phase has to hold delivery.
 */
const resumingFrame = (elapsed: string) => [
  "╭─────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.154.0)                  │",
  "│                                             │",
  "│ model:       loading   /model to change     │",
  "│ directory:   ~/Projects/AgEnD-agend-dev-sol │",
  "│ permissions: YOLO mode                      │",
  "╰─────────────────────────────────────────────╯",
  "  Resuming session…",
  "",
  "› Ask Codex to do anything",
  `  ${elapsed}`,
  "",
  "  ? for shortcuts",
].join("\n");

const READY = [
  "╭─────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.154.0)                  │",
  "│ model:       gpt-5.6-sol                    │",
  "╰─────────────────────────────────────────────╯",
  "› Ask Codex to do anything",
  "  Context 46% left",
].join("\n");

// Captured from an isolated real codex-cli 0.156.0 tmux pane. The sign-in
// modal used a fresh test-only CODEX_HOME; neither fixture is a fabricated UI.
const CODEX_0156_READY = readFileSync(join(__dirname, "fixtures/codex-0156-ready.pane.txt"), "utf-8");
const CODEX_0156_SIGNIN = readFileSync(join(__dirname, "fixtures/codex-0156-signin.pane.txt"), "utf-8");

/** codex mid-turn: busy, but its input is available — the steer/native-queue shape. */
const BUSY = [
  "• Working (9s • esc to interrupt)",
  "› Ask Codex to do anything",
  "  Context 63% left",
].join("\n");

const MESSAGE = "[from:agend-leader] ping";

/** Straight after the paste: the text sits in codex's input row, unsubmitted. */
const PASTED = [
  "╭─────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.154.0)                  │",
  "│ model:       gpt-5.6-sol                    │",
  "╰─────────────────────────────────────────────╯",
  `› ${MESSAGE}`,
  "  Context 46% left",
].join("\n");

/** After the Enter: the message is in the transcript and the input row is free. */
const SUBMITTED = [
  "╭─────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.154.0)                  │",
  "│ model:       gpt-5.6-sol                    │",
  "╰─────────────────────────────────────────────╯",
  `  ${MESSAGE}`,
  "• Working (1s • esc to interrupt)",
  "› Ask Codex to do anything",
  "  Context 46% left",
].join("\n");

/**
 * grok mid-turn. grok declares no native input queue, which is exactly why the
 * steer test uses it: on codex `supportsQueuedInput || opts.steer` is already
 * true without the steer, so codex cannot tell whether the steer fast path is
 * still wired up.
 */
const GROK_BUSY = [
  "⠋ Thinking… 4.2s",
  "❯",
].join("\n");

const dirs: string[] = [];

interface Harness {
  daemon: any;
  state: { pane: string; idle: boolean; idleAtPaste: boolean | null };
  paste: ReturnType<typeof vi.fn>;
  events: string[];
}

function makeHarness(backendName: "codex" | "grok" = "codex"): Harness {
  const dir = mkdtempSync(join(tmpdir(), "agend-resume-gate-"));
  dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@19");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = backendName === "grok" ? new GrokBackend(dir) : new CodexBackend(dir);
  const daemon = new Daemon("codex-test", {
    working_directory: "/tmp",
    backend: backendName,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;

  const state = { pane: resumingFrame("0s"), idle: true, idleAtPaste: null as boolean | null };
  const paste = vi.fn(async () => {
    state.idleAtPaste ??= state.idle;
    state.pane = READY;
    return true;
  });
  daemon.tmux = {
    capturePane: async () => state.pane,
    getPaneInputMode: async () => "raw" as const,
    pasteBuffer: paste,
    sendSpecialKey: vi.fn(async () => true),
    sendKeys: vi.fn(async () => true),
    isWindowAlive: async () => true,
    getWindowId: () => "@19",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = {
    isIdle: () => state.idle,
    waitUntilIdle: async () => { state.idle = true; return true; },
    hasOutputSince: () => false,
    getLastOutputAt: () => 0,
    getObservationResetAt: () => 0,
  };
  // What a wake does: beginSpawn() arms the transient guard for this spawn.
  // Without it the resume frame is not recognised as a transient at all.
  daemon.inputTransientGuardGeneration = daemon.spawnGeneration;

  const events: string[] = [];
  for (const e of ["message_queued", "message_delivered", "message_confirmed", "message_failed"]) {
    daemon.on(e, () => events.push(e));
  }
  return { daemon, state, paste, events };
}

async function settle<T>(promise: Promise<T>, maxMs = 30 * 60_000, stepMs = 250): Promise<T> {
  let done = false;
  let result!: T;
  let failure: unknown;
  void promise.then(v => { result = v; done = true; }, e => { failure = e; done = true; });
  for (let elapsed = 0; !done && elapsed <= maxMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (failure) throw failure;
  if (!done) throw new Error(`delivery did not settle within ${maxMs}ms of fake time`);
  return result;
}

const STATUS = { chatId: "c", messageId: "m" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("delivery to a codex that is still resuming", () => {
  it("recognizes the real 0.156 input/footer but not its sign-in modal", () => {
    const backend = new CodexBackend("/tmp/codex-0156-fixture");
    expect(backend.isDeliveryInputReadyPane(CODEX_0156_READY)).toBe(true);
    expect(backend.isDeliveryInputReadyPane(CODEX_0156_SIGNIN)).toBe(false);
    expect(backend.isDeliveryInputReadyPane(CODEX_0156_READY.replace("› Ask Codex to do anything", "> 1. Trust and continue"))).toBe(false);
  });

  it("holds a real 0.156 ready-looking pane until its tty is in raw mode", async () => {
    const h = makeHarness();
    h.state.idle = true;
    h.state.pane = CODEX_0156_READY;
    let mode: "cooked" | "raw" = "cooked";
    h.daemon.tmux.getPaneInputMode = vi.fn(async () => mode);
    h.daemon.tmux.sendSpecialKey = vi.fn(async () => {
      h.state.pane = SUBMITTED.replace("• Working", "  (message_id: m)\n• Working");
      return true;
    });
    setTimeout(() => { mode = "raw"; }, 2_000);

    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "m" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.paste, "a visible prompt with cooked tty is not input readiness").not.toHaveBeenCalled();
    await expect(settle(delivery)).resolves.toBe(true);
    expect(h.paste).toHaveBeenCalledOnce();
  });

  it("does not treat an unknown tty mode as positive startup readiness", async () => {
    const h = makeHarness();
    h.state.idle = true;
    h.state.pane = CODEX_0156_READY;
    h.daemon.tmux.getPaneInputMode = vi.fn(async () => "unknown");
    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "m" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.paste).not.toHaveBeenCalled();
    h.daemon.tmux.getPaneInputMode = vi.fn(async () => "raw");
    h.daemon.tmux.sendSpecialKey = vi.fn(async () => {
      h.state.pane = SUBMITTED.replace("• Working", "  (message_id: m)\n• Working");
      return true;
    });
    await expect(settle(delivery)).resolves.toBe(true);
    expect(h.paste).toHaveBeenCalledOnce();
  });

  it("holds the real 0.156 sign-in modal instead of typing into its selected option", async () => {
    const h = makeHarness();
    h.state.idle = true;
    h.state.pane = CODEX_0156_SIGNIN;
    h.daemon.tmux.getPaneInputMode = vi.fn(async () => "raw");
    h.daemon.tmux.sendSpecialKey = vi.fn(async () => {
      h.state.pane = SUBMITTED.replace("• Working", "  (message_id: m)\n• Working");
      return true;
    });
    setTimeout(() => { h.state.pane = CODEX_0156_READY; }, 2_000);

    const delivery = h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "m" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.paste).not.toHaveBeenCalled();
    await expect(settle(delivery)).resolves.toBe(true);
  });
  it("waits out a resume that runs well past the old thirty-second cap", async () => {
    // Ninety seconds of resume — three times the old flat budget — with the
    // frame repainting the way a live one does. This is the paused-codex wake
    // the user hit: the pane was never stuck, only slow.
    const h = makeHarness();
    const startedAt = Date.now();
    let tick = 0;
    let pastedAtMs: number | null = null;
    let sawOutput = false;
    let eventsAtPaste: string[] | null = null;
    h.daemon.controlClient.hasOutputSince = () => sawOutput;
    h.daemon.tmux.capturePane = async () => {
      if (pastedAtMs !== null) return h.state.pane;
      return Date.now() - startedAt >= 90_000 ? READY : resumingFrame(`${++tick}`);
    };
    h.daemon.tmux.pasteBuffer = h.paste.mockImplementation(async () => {
      pastedAtMs ??= Date.now() - startedAt;
      eventsAtPaste ??= [...h.events];
      h.state.pane = PASTED;
      return true;
    });
    // The Enter lands: codex echoes the message and starts working. The
    // idle→busy edge is what the daemon accepts as proof of submission.
    h.daemon.tmux.sendSpecialKey = vi.fn(async () => {
      h.state.pane = SUBMITTED;
      h.state.idle = false;
      sawOutput = true;
      return true;
    });

    await settle(h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "m" }));

    expect(h.paste, "the gate released instead of giving up").toHaveBeenCalled();
    expect(pastedAtMs, "and it waited well past the old flat thirty-second cap")
      .toBeGreaterThanOrEqual(90_000);
    // Judged at the moment the gate released. What the post-Enter confirmation
    // ladder then makes of this harness's pane is a different file's subject
    // (codex-native-queue-strand.test.ts); the claim here is only that the wait
    // for a resuming pane no longer ends in a failure of its own.
    expect(eventsAtPaste, "no ❌ for a pane that was only slow").not.toContain("message_failed");
  });

  it("still fails a resume screen that has stopped changing", async () => {
    // The other half of the rule. A frozen transient is indistinguishable from
    // a wedged CLI, and pasting into one strands the text — so the budget must
    // still run out. Same frame, byte for byte, forever.
    const h = makeHarness();
    h.daemon.tmux.capturePane = async () => resumingFrame("stuck");

    const startedAt = Date.now();
    const delivered = await settle(
      h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "m" }),
    );
    const tookMs = Date.now() - startedAt;

    expect(delivered).toBe(false);
    expect(h.events, "a stuck pane is a real failure and still reports one").toContain("message_failed");
    expect(h.paste, "nothing may be pasted into a pane that never came back").not.toHaveBeenCalled();
    // And it gives up on the STALL rule, not by grinding out the ceiling: a
    // frozen screen is recognised in seconds. Without the "has the pane
    // changed" test this still fails, just ten minutes later — which for a
    // sender waiting on a reply is a different bug, not the same one.
    expect(tookMs, "a frozen pane is recognised quickly, not at the ceiling").toBeLessThan(60_000);
  });

  it("stops at the ceiling when the transient repaints forever", async () => {
    // A spinner on a wedged resume changes every frame, so the stall rule alone
    // would wait for ever. The ceiling is what keeps "wait for progress"
    // bounded — without it this test never returns.
    const h = makeHarness();
    let frame = 0;
    h.daemon.tmux.capturePane = async () => resumingFrame(`spinner-${frame++}`);

    const delivered = await settle(
      h.daemon.deliverMessage("[from:leader] ping", STATUS, { submissionId: "m" }),
      20 * 60_000,
    );

    expect(delivered).toBe(false);
    expect(h.events).toContain("message_failed");
  });
});

describe("a steer still interrupts the running turn", () => {
  it("pastes into a busy pane instead of queuing behind it", async () => {
    // #826 moved the resume case onto the queue side of the gate. Steer must
    // stay on the other side: its whole point is to reach the turn that is
    // already running, so a steer that waited for idle would be a steer that
    // did nothing.
    //
    // grok, not codex: grok has no native input queue, so `supportsQueuedInput
    // || opts.steer` is carried by the steer alone and deleting that arm has to
    // change the outcome.
    const h = makeHarness("grok");
    h.state.pane = GROK_BUSY;
    h.state.idle = false;
    h.daemon.tmux.capturePane = async () => GROK_BUSY;

    await settle(
      h.daemon.deliverMessage("[from:leader] stop that", STATUS, { steer: true, submissionId: "m" }),
    );

    expect(h.paste, "the steer reached the pane").toHaveBeenCalled();
    expect(h.state.idleAtPaste, "and it got there while the turn was still running").toBe(false);
  });
});

/**
 * The other half of #826: a ❌ is a verdict, and `deliverMessage` returns false
 * for two unrelated things — a delivery that cannot land, and a delivery that
 * was never attempted because AgEnD is standing down. Reporting the second told
 * a sending agent its message was lost during a tmux storm or a shutdown.
 */
describe("who gets told a cross-instance delivery failed", () => {
  const crossInstance = { from_instance: "agend-leader", correlation_id: "cid-1", user: "leader" };

  function withBroadcastSpy(h: Harness) {
    const broadcasts: { type?: string }[] = [];
    h.daemon.ipcServer = { broadcast: (m: { type?: string }) => broadcasts.push(m) };
    return broadcasts;
  }

  it("says nothing when the fleet is standing down", async () => {
    // The pane was never even asked. Nothing failed — AgEnD stopped.
    const h = makeHarness();
    const broadcasts = withBroadcastSpy(h);
    h.daemon.stormWindow = {
      isStopped: () => true,
      isDeliveryHeld: () => false,
      waitForDeliveryAllowed: async () => {},
    };

    h.daemon.pushChannelMessage("ping", crossInstance);
    await settle(h.daemon.pasteLock);

    expect(broadcasts.map(b => b.type), "a shutdown is not a delivery failure")
      .not.toContain("cross_instance_delivery_failed");
    expect(h.paste).not.toHaveBeenCalled();
  });

  it("reports the pane that really never came back", async () => {
    // And the verdict still travels: a frozen resume means the sender's message
    // is not arriving, and the sender is the one who has to know.
    const h = makeHarness();
    const broadcasts = withBroadcastSpy(h);
    h.daemon.tmux.capturePane = async () => resumingFrame("stuck");

    h.daemon.pushChannelMessage("ping", crossInstance);
    await settle(h.daemon.pasteLock);

    expect(broadcasts.map(b => b.type)).toContain("cross_instance_delivery_failed");
    expect(broadcasts.find(b => b.type === "cross_instance_delivery_failed"))
      .toMatchObject({ error: "delivery failed: phase=readiness; proof=timeout-before-write" });
  });
  it("says nothing when a STEER could not be attempted", async () => {
    // Same rule, the other lock. A steer runs on steerLock, and its call site
    // had the same unconditional report — so standing down during a steer told
    // the sender its message was lost.
    const h = makeHarness();
    const broadcasts = withBroadcastSpy(h);
    h.daemon.stormWindow = {
      isStopped: () => true,
      isDeliveryHeld: () => false,
      waitForDeliveryAllowed: async () => {},
    };

    h.daemon.steerMessage("ping", crossInstance);
    await settle(h.daemon.steerLock);

    expect(broadcasts.map(b => b.type), "a shutdown is not a steer failure")
      .not.toContain("cross_instance_delivery_failed");
  });

  it("does not let a steer's verdict answer for a queued delivery", async () => {
    // The verdict belongs to one delivery, not to the daemon. The two do not
    // share a lock — an ordinary message is serialised on pasteLock, a steer on
    // steerLock — so they overlap by design:
    //
    //   S steers and reaches its pane write
    //   D arrives, resets, and parks in the storm hold
    //   S's write fails unrecoverably — S has a verdict
    //   the storm ends as a shutdown, so D returns false having tried nothing
    //
    // With one flag on the daemon, D's sender is told ITS message failed, under
    // D's correlation id, because of what happened to S.
    const h = makeHarness("grok");
    const broadcasts = withBroadcastSpy(h);
    h.state.pane = GROK_BUSY;
    h.state.idle = false;
    h.daemon.tmux.capturePane = async () => GROK_BUSY;

    let held = false;
    let stopped = false;
    let releaseHold!: () => void;
    const allowed = new Promise<void>(r => { releaseHold = r; });
    h.daemon.stormWindow = {
      isStopped: () => stopped,
      isDeliveryHeld: () => held,
      waitForDeliveryAllowed: () => allowed,
    };

    // S's pane write hangs until the test lets it fail, which is the window D
    // slips into.
    let failSteerPaste!: (ok: boolean) => void;
    h.daemon.tmux.pasteBuffer = vi.fn(() => {
      held = true;  // from here on, anything arriving is held by the storm
      return new Promise<boolean>(r => { failSteerPaste = r; });
    });
    h.daemon.tmux.isLastPasteFailureRecoverable = () => false;
    h.daemon.tmux.getLastPasteError = () => "no such window";

    h.daemon.steerMessage("steered", { ...crossInstance, correlation_id: "cid-steer" });
    await vi.advanceTimersByTimeAsync(100);
    expect(failSteerPaste, "the steer should be parked in its pane write").toBeDefined();

    h.daemon.pushChannelMessage("queued", { ...crossInstance, correlation_id: "cid-queued" });
    await vi.advanceTimersByTimeAsync(100);

    failSteerPaste(false);                     // S fails for real
    await settle(h.daemon.steerLock);

    stopped = true;                            // the storm ends as a shutdown
    releaseHold();
    await settle(h.daemon.pasteLock);

    expect(broadcasts.map(b => (b as { correlationId?: string }).correlationId),
      "the queued message never tried, so its sender is told nothing")
      .not.toContain("cid-queued");
  });
});

describe("an unreadable pane under the write lock", () => {
  it("gives up instead of polling for ever", async () => {
    // The pre-write transient check lost its flat deadline when the budget
    // became progress-based. A capture that keeps failing never "changes", so
    // it has to consume the stall budget too — otherwise this delivery polls
    // for ever under the pane write lock and nothing else can write either.
    const h = makeHarness();
    let reads = 0;
    h.daemon.tmux.capturePane = async () => {
      // Readable long enough to clear the outer gate, then the pane goes dark.
      if (++reads <= 3) return READY;
      throw new Error("capture-pane: no such pane");
    };

    const delivered = await settle(
      h.daemon.deliverMessage(MESSAGE, STATUS, { submissionId: "m" }),
      15 * 60_000,
    );

    expect(delivered, "a pane nobody can read is not a delivery").toBe(false);
    expect(h.events).toContain("message_failed");
  });
});
