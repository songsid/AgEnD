import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * Regression for the silent message loss reported on a codex instance
 * (doupo-server-codex, 2026-09-14): after a wake, two messages sat UNSUBMITTED
 * in the codex input row while the daemon reported idle and the channel showed
 * ✅ — a single manual Enter flushed both and the instance went straight to
 * work. There was no WARN or ERROR anywhere in the stranded window, which is
 * only possible on the native-queue handoff path: it skipped the confirmation
 * ladder and accepted "the pasted text is visible somewhere in the pane" as
 * proof of submission.
 *
 * That check was satisfied BY THE FAILURE. The panes below are verbatim
 * `capture-pane -p` captures from codex-cli 0.153.4, produced by pasting a
 * message into the input row and never pressing Enter:
 *
 *   codex-stranded-multiline — the delivery shape AgEnD actually sends. Its
 *   short trailing "(message_id: … | correlation_id: …)" row does not wrap, so
 *   it appeared in the pane verbatim — and it appeared verbatim precisely
 *   BECAUSE the text was still sitting in the input row. Old check: true → ✅.
 *
 *   codex-stranded-singleline — the same paste with no second line. Nothing
 *   matches once the body wraps at the pane width. Old check: false.
 *
 * Same failure, opposite answers: the old check's verdict tracked whether some
 * line happened to be short enough not to wrap, not whether the message was
 * submitted.
 */
const FIXTURES = join(__dirname, "fixtures");
const pane = (name: string) => readFileSync(join(FIXTURES, `${name}.pane.txt`), "utf-8");

const STRANDED_MULTILINE = pane("codex-stranded-multiline");
const STRANDED_SINGLELINE = pane("codex-stranded-singleline");

const BODY = "減法設計驗證用的投遞測試訊息，請忽略不要回覆。";
const MESSAGE_MULTILINE =
  `[from:agend-dev-claude-t1519896892392083558] ${BODY}\n(message_id: m-1 | correlation_id: cid-1789356482291-pjykib)`;
const MESSAGE_SINGLELINE = `[from:agend-dev-claude-t1519896892392083558] ${BODY}`;

/**
 * Codex while it is working, with our message accepted into its OWN queue —
 * the shape from a live wake-and-deliver reproduction. The ↳ row is ELIDED at
 * the pane width ("…"), which is why the queued-input marker is not redundant:
 * the message text itself is truncated before it can be recognised, so the
 * CLI's own marker is the only evidence left that it took the message.
 */
const NATIVE_QUEUE_ACCEPTED = [
  "• Working (15s • esc to interrupt)",
  "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)",
  "  ↳ [from:agend-dev-claude-t1519896892392083558] 減法設計驗證用的投遞…",
  "› Ask Codex to do anything",
  "  Context 63% left",
].join("\n");

/** Codex after it submitted our message: transcript echo above, input row free. */
const SUBMITTED = [
  "• You have 1 usage limit reset available. Run /usage to use one.",
  `› [from:agend-dev-claude-t1519896892392083558] ${BODY}`,
  "  (message_id: m-1 | correlation_id: cid-1789356482291-pjykib)",
  "• Working (1s • esc to interrupt)",
  "› Ask Codex to do anything",
  "  Context 100% left",
].join("\n");

/** Verbatim Codex 0.154.0 auto-wake frame: the input row is visible but Enter is a no-op. */
const RESUMING_WITH_MESSAGE = [
  "╭─────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.154.0)                  │",
  "│                                             │",
  "│ model:       loading   /model to change     │",
  "│ directory:   ~/Projects/AgEnD-agend-dev-sol │",
  "│ permissions: YOLO mode                      │",
  "╰─────────────────────────────────────────────╯",
  "  Resuming session…",
  "",
  `› [from:agend-dev-claude-t1519896892392083558] ${BODY}`,
  "  (message_id: m-1 | correlation_id: cid-1789438369044-j7krk0)",
  "",
  "  ? for shortcuts",
].join("\n");

const READY_EMPTY = [
  "╭─────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.154.0)                  │",
  "│ model:       gpt-5.6-sol                    │",
  "╰─────────────────────────────────────────────╯",
  "› Ask Codex to do anything",
  "  Context 46% left",
].join("\n");

/** Codex 0.156.0 with user status-line chrome retained after context. */
const READY_WITH_CHROME = [
  "╭───────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.156.0)                │",
  "│ model:     GPT-6-Astra   /model to change │",
  "╰───────────────────────────────────────────╯",
  "› Ask Codex to do anything",
  "  Context 100% left · GPT-6-Astra",
].join("\n");

/**
 * The pane BEFORE we paste: codex is working on something else. Submission is
 * judged by what the pane gains, so every test starts from a frame that holds
 * none of our evidence — a queue marker or transcript echo that was already
 * there must never vouch for this delivery.
 */
const BUSY_BEFORE_PASTE = [
  "• Working (9s • esc to interrupt)",
  "› Ask Codex to do anything",
  "  Context 63% left",
].join("\n");

interface Harness {
  daemon: any;
  /** `afterPaste`/`afterEnter` repaint the pane the way the CLI would. */
  state: { pane: string; idle: boolean; outputSince: boolean; afterPaste?: string; afterEnter?: string; afterSecondPaste?: string };
  paste: ReturnType<typeof vi.fn>;
  enter: ReturnType<typeof vi.fn>;
  events: string[];
  dir: string;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-strand-"));
  writeFileSync(join(dir, "window-id"), "@19");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("codex-test", {
    working_directory: "/tmp",
    backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new CodexBackend(dir) as any, undefined, { child: () => logger } as any) as any;

  const state: Harness["state"] = { pane: BUSY_BEFORE_PASTE, idle: false, outputSince: true };
  // A redelivery that actually lands paints the message; the first paste in
  // these tests is the one that vanished, the second is the recovery.
  let pastes = 0;
  const paste = vi.fn(async () => {
    pastes++;
    const recovered = pastes >= 2 && state.afterSecondPaste !== undefined;
    const next = recovered ? state.afterSecondPaste : state.afterPaste;
    if (next !== undefined) state.pane = next;
    // Once the recovery paste has landed the pane does not revert to the old
    // frame on the next Enter — that Enter is what submits the new text.
    if (recovered) state.afterEnter = state.afterSecondPaste;
    return true;
  });
  // An Enter arriving while the CLI is busy is DROPPED — that is the failure
  // being modelled. Once the pane is idle the Enter lands and repaints.
  const enter = vi.fn(async () => {
    if (state.idle && state.afterEnter !== undefined) state.pane = state.afterEnter;
    return true;
  });
  daemon.tmux = {
    capturePane: async () => state.pane,
    getPaneInputMode: async () => "raw" as const,
    pasteBuffer: paste,
    sendSpecialKey: enter,
    sendKeys: vi.fn(async () => true),
    isWindowAlive: async () => true,
    getWindowId: () => "@19",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => "send-keys failed",
  };
  daemon.controlClient = {
    isIdle: () => state.idle,
    // Codex finishes its turn; the idle-gated redelivery may then proceed.
    waitUntilIdle: async () => { state.idle = true; return true; },
    hasOutputSince: () => state.outputSince,
    getLastOutputAt: () => 0,
    getObservationResetAt: () => 0,
  };
  const events: string[] = [];
  for (const e of ["message_queued", "message_delivered", "message_confirmed", "message_failed"]) {
    daemon.on(e, () => events.push(e));
  }
  return { daemon, state, paste, enter, events, dir };
}

async function settle<T>(promise: Promise<T>, maxMs = 120_000, stepMs = 100): Promise<T> {
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
const dirs: string[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("codex native-queue handoff: text left in the input row is NOT a delivery", () => {
  it("accepts the real 0.156 context footer with additional status-line chrome", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = true;
    h.state.pane = READY_WITH_CHROME;
    h.state.afterPaste = [
      "› [from:agend-dev-claude-t1519896892392083558] " + BODY,
      "  (message_id: m-1 | correlation_id: cid-1789356482291-pjykib)",
      "• Working (1s • esc to interrupt)",
      READY_WITH_CHROME,
    ].join("\n");

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(true);
    expect(h.paste).toHaveBeenCalledOnce();
    expect(h.events).toContain("message_confirmed");
  });

  it("keeps native-queue recovery unconfirmed while its accepted Enter has not painted the echo", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.afterPaste = STRANDED_MULTILINE;
    h.state.afterEnter = READY_EMPTY;
    // The recovery Enter was accepted, but Codex paints the transcript later.
    setTimeout(() => { h.state.pane = SUBMITTED; }, 5_000);

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(true);
    expect(h.paste).toHaveBeenCalledOnce();
    expect(h.enter).toHaveBeenCalledTimes(2);
    expect(h.events).toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
  });

  it("does not report a hard failure when native-queue recovery remains unknowable", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.afterPaste = STRANDED_MULTILINE;
    h.state.afterEnter = READY_EMPTY;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(false);
    expect(h.paste).toHaveBeenCalledOnce();
    expect(h.enter).toHaveBeenCalledTimes(2);
    expect(h.events).not.toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
  });

  it("does not confirm a native queue submission from an unknown Codex pane layout", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.afterPaste = RESUMING_WITH_MESSAGE;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(false);
    expect(h.paste).toHaveBeenCalledOnce();
    expect(h.events).not.toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
  });

  it("does not report a false failure while a submitted 0.156 message appears after the first proof window", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = true;
    h.state.pane = READY_EMPTY;
    h.state.afterPaste = READY_EMPTY; // redraw hides the echo for several seconds
    setTimeout(() => { h.state.pane = SUBMITTED; }, 5_000);

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(true);
    expect(h.paste).toHaveBeenCalledOnce();
    expect(h.enter).toHaveBeenCalledOnce();
    expect(h.events).toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
  });

  it("keeps an unproven post-Enter outcome uncertain, without ❌ or duplicate paste", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = true;
    h.state.pane = READY_EMPTY;
    h.state.afterPaste = READY_EMPTY;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(false);
    expect(h.paste).toHaveBeenCalledOnce();
    expect(h.enter).toHaveBeenCalledOnce();
    expect(h.events).not.toContain("message_failed");
  });

  it("keeps the startup scan open while the current Codex screen is resuming", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.daemon.beginSpawn();
    let captures = 0;
    h.daemon.tmux.capturePane = async () => {
      captures++;
      return captures <= 2 ? RESUMING_WITH_MESSAGE : READY_EMPTY;
    };

    const scan = h.daemon.dismissDialogsUntilReady(5_000, 100);
    await expect(settle(scan, 5_000, 50)).resolves.toBe(true);
    h.daemon.endSpawn();

    // Without the production transient gate, Codex's broad ready pattern sees
    // its header and returns after the first two resuming frames.
    expect(captures).toBeGreaterThanOrEqual(4);
  });

  it("classifies a quiet resume screen as transient rather than native-queue busy", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.daemon.beginSpawn();
    h.daemon.endSpawn();
    h.state.idle = true;
    h.state.pane = RESUMING_WITH_MESSAGE;

    await expect(h.daemon.paneReadinessForDelivery("@19")).resolves.toBe("transient");
  });

  it("bounds a resume transient found before paste and fails without writing", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.daemon.beginSpawn();
    h.daemon.endSpawn();
    h.state.idle = true;
    h.state.pane = RESUMING_WITH_MESSAGE;

    const ok = await settle(
      h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }),
      35_000,
    );

    expect(ok).toBe(false);
    expect(h.paste).not.toHaveBeenCalled();
    expect(h.enter).not.toHaveBeenCalled();
    expect(h.events).toContain("message_failed");
  });

  it("rechecks the transient under the write lock before pasting", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.daemon.beginSpawn();
    h.daemon.endSpawn();
    h.state.idle = true;
    h.state.pane = READY_EMPTY;
    h.state.afterPaste = SUBMITTED;
    h.state.afterEnter = SUBMITTED;
    const capture = h.daemon.tmux.capturePane;
    let captures = 0;
    h.daemon.tmux.capturePane = async () => {
      captures++;
      // Initial readiness and stranded-input probes saw a clear screen. The
      // resume phase arrives at the final under-lock TOCTOU check.
      if (captures === 4) h.state.pane = RESUMING_WITH_MESSAGE;
      return capture();
    };
    setTimeout(() => { h.state.pane = READY_EMPTY; }, 5_000);

    const delivery = h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(h.paste, "a transient discovered under the lock must hold the paste").not.toHaveBeenCalled();
    await expect(settle(delivery)).resolves.toBe(true);
    expect(h.paste).toHaveBeenCalledTimes(1);
  });

  it("waits through a post-paste resume redraw, then sends the first Enter once", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.daemon.beginSpawn();
    h.daemon.endSpawn(); // keep this generation's first-delivery guard armed
    h.state.idle = true;
    h.state.pane = READY_EMPTY;
    h.state.afterPaste = READY_EMPTY;
    h.state.afterEnter = SUBMITTED;
    // The live 0.154.0 sequence: AgEnD observes a prompt and pastes first;
    // Codex paints the resume phase a fraction of a second later.
    setTimeout(() => { h.state.pane = RESUMING_WITH_MESSAGE; }, 300);
    setTimeout(() => { h.state.pane = STRANDED_MULTILINE; }, 5_000);

    const delivery = h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(h.enter, "the 3s submission-proof budget must not run during resume").not.toHaveBeenCalled();
    const ok = await settle(delivery);

    expect(ok).toBe(true);
    expect(h.enter).toHaveBeenCalledTimes(1);
    expect(h.events).toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
  });

  it("fails loudly without an Enter when the resume transient never clears", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.daemon.beginSpawn();
    h.daemon.endSpawn();
    h.state.idle = true;
    h.state.pane = READY_EMPTY;
    h.state.afterPaste = RESUMING_WITH_MESSAGE;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(false);
    expect(h.enter, "timeout is not permission to press Enter blind").not.toHaveBeenCalled();
    expect(h.events).not.toContain("message_confirmed");
    expect(h.events).toContain("message_failed");
  });

  it("does not let an old generation's wait send Enter into a replacement pane", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.daemon.beginSpawn();
    h.daemon.endSpawn();
    h.state.pane = RESUMING_WITH_MESSAGE;
    setTimeout(() => {
      h.daemon.beginSpawn();
      h.state.pane = READY_EMPTY;
      h.daemon.endSpawn();
    }, 1_000);

    await expect(settle(h.daemon.sendDeliveryEnter("generation-fence"))).resolves.toBe(false);
    expect(h.enter, "the clear pane belongs to a new spawn generation").not.toHaveBeenCalled();
  });

  it("does not hold delivery when the user merely quotes the resume screen", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.daemon.beginSpawn();
    h.daemon.endSpawn();
    h.state.idle = true;
    h.state.pane = [
      "› [user:maintainer] Here is the screen I saw:",
      ...RESUMING_WITH_MESSAGE.split("\n").map(row => `  ${row}`),
      "• I can inspect that startup race.",
      "› Ask Codex to do anything",
      "  Context 46% left",
    ].join("\n");
    h.state.afterPaste = SUBMITTED;
    h.state.afterEnter = SUBMITTED;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(true);
    expect(h.enter).toHaveBeenCalledTimes(1);
    expect(h.events).toContain("message_confirmed");
  });

  it("submits a positively identified old Codex strand before pasting the next message", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = true;
    h.state.pane = STRANDED_MULTILINE.replaceAll("m-1", "old-1");
    h.state.afterPaste = STRANDED_MULTILINE;
    let enters = 0;
    h.enter.mockImplementation(async () => {
      enters++;
      h.state.pane = enters === 1 ? READY_EMPTY : SUBMITTED;
      return true;
    });

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(true);
    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.enter).toHaveBeenCalledTimes(2);
    expect(h.enter.mock.invocationCallOrder[0]).toBeLessThan(h.paste.mock.invocationCallOrder[0]);
  });

  // THE GATE. Reverting the success criterion to "the pasted text is visible in
  // the pane" turns this red: the stranded pane below contains the text.
  it("submits the stranded text instead of pasting it a second time", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;                      // busy → native-queue handoff
    h.state.afterPaste = STRANDED_MULTILINE;   // Enter dropped: text never left the input row
    h.state.afterEnter = SUBMITTED; // the recovery Enter, once the pane is idle
    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    // paste-buffer writes at the cursor, so re-pasting text that is STILL in
    // the input row appends it to itself and the next Enter submits it twice.
    expect(h.paste, "the stranded payload must never be pasted on top of itself").toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
    expect(h.events).toContain("message_confirmed");
  });

  it("also refuses the single-line shape of the same failure", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.afterPaste = STRANDED_SINGLELINE;
    h.state.afterEnter = SUBMITTED;
    const ok = await settle(h.daemon.deliverMessage(MESSAGE_SINGLELINE, STATUS, {}));

    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
  });

  // The end of the line: the text stays in the input row however many Enters
  // go out. The delivery must say ❌, not ✅ — silent loss is the bug.
  it("fails loudly when the stranded text cannot be submitted at all", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.afterPaste = STRANDED_MULTILINE;
    h.state.outputSince = false; // no idle→busy after any Enter

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(ok).toBe(false);
    expect(h.events, "a message nobody could submit is not delivered").not.toContain("message_confirmed");
    expect(h.events).toContain("message_failed");
  });

  // The reported shape: an EARLIER delivery is already stranded, so the input
  // row holds "previous message + ours" and ours is no longer a prefix of it.
  it("detects stranding when an earlier message is stacked in front of ours", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.afterPaste = [
      "• You have 1 usage limit reset available. Run /usage to use one.",
      "› [system] an earlier notice whose Enter was dropped",
      `  [from:agend-dev-claude-t1519896892392083558] ${BODY}`,
      "  (message_id: m-1 | correlation_id: cid-1789356482291-pjykib)",
      "  Context 63% left",
    ].join("\n");
    h.state.afterEnter = SUBMITTED;
    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(h.paste, "a stacked strand is still a strand").toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
  });

  // The other half of the gate: the fix must not turn codex's native queue —
  // which is working as designed — into a failure or a double delivery.
  it("confirms a message codex took into its own queue (↳), pasting exactly once", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.afterPaste = NATIVE_QUEUE_ACCEPTED;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_SINGLELINE, STATUS, {}));

    expect(ok).toBe(true);
    expect(h.events).toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
    expect(h.paste, "a confirmed message must not be delivered twice").toHaveBeenCalledTimes(1);
  });

  // A ↳ that was ALREADY on screen belongs to an earlier message. If our paste
  // is swallowed, that marker must not vouch for this delivery.
  it("does not let an earlier queued message's ↳ confirm a paste that vanished", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.pane = [
      "• Working (9s • esc to interrupt)",
      "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)",
      "  ↳ [from:someone-else] an unrelated message queued earlier…",
      "› Ask Codex to do anything",
      "  Context 63% left",
    ].join("\n");
    h.state.afterPaste = h.state.pane; // a redraw swallowed our paste entirely

    h.state.afterSecondPaste = SUBMITTED; // the recovery paste lands
    const ok = await settle(h.daemon.deliverMessage(MESSAGE_SINGLELINE, STATUS, {}));

    // An absent viewport echo is not proof of loss: the native queue may have
    // accepted it without painting the full body. Never risk a duplicate.
    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain("message_failed");
    expect(ok).toBe(false);
  });

  // Counting alone is not enough when the viewport scrolls. A repeated
  // instruction pushes the older copy off the top as ours arrives, so the count
  // is unchanged — identical before and after. Tying the evidence to THIS
  // message's envelope id is what separates them; without it the delivery is
  // judged unproven and pasted a second time.
  it("confirms this delivery even when an identical older message scrolls off", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.pane = [
      "• Working (9s • esc to interrupt)",
      `› [from:agend-dev-claude-t1519896892392083558] ${BODY}`,
      "  (message_id: m-0 | correlation_id: cid-older-delivery)",
      "› Ask Codex to do anything",
      "  Context 63% left",
    ].join("\n");
    // Ours arrives; the older copy has scrolled out of the viewport.
    h.state.afterPaste = SUBMITTED;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(h.paste, "an already-submitted message must not be sent again").toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
    expect(h.events).toContain("message_confirmed");
  });

  // An older message from the SAME sender, opening with the same body, is
  // already stranded in the input row when ours is swallowed. Reading that as
  // "our message is stranded" and pressing Enter submits the OLD one — and the
  // turn it starts then vouches for a message that never reached the pane.
  it("does not attribute an older stranded message to this delivery", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    const olderStranded = [
      "• Working (9s • esc to interrupt)",
      `› [from:agend-dev-claude-t1519896892392083558] ${BODY}`,
      "  (message_id: m-0 | correlation_id: cid-older-delivery)",
      "  Context 63% left",
    ].join("\n");
    h.state.pane = olderStranded;
    h.state.afterPaste = olderStranded;  // ours was swallowed by a redraw
    h.state.afterEnter = olderStranded;  // and the old one is what any Enter submits

    h.state.afterSecondPaste = SUBMITTED; // the recovery paste lands
    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    // The older strand cannot confirm ours, but it also cannot prove our
    // unique message was not accepted off-screen. No blind second paste.
    expect(h.paste).toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain("message_failed");
    expect(ok).toBe(false);
  });

  // A momentary failure to read the pane BEFORE pasting must not turn a
  // delivered message into a second copy: this message's envelope id is proof
  // on its own, because no earlier message can carry it.
  it("does not re-paste when the baseline capture failed but the message is clearly there", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    // Readiness now makes its own captures before the baseline. Make only the
    // baseline unavailable so this test does not depend on probe call counts.
    vi.spyOn(h.daemon, "capturePaneEvidence").mockResolvedValue(null);
    h.state.afterPaste = SUBMITTED; // m-1 echoed into the transcript, input row clear

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(h.paste, "a message the pane clearly shows must not be pasted twice").toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
    expect(h.events).toContain("message_confirmed");
  });

  // Without an envelope id (a raw paste, a system notice) the body is all there
  // is, and an older identical message stranded in the input row looks exactly
  // like ours. The pane as it was BEFORE the paste is what separates them.
  it("does not claim an identical older strand when this message has no envelope id", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    const identicalOlderStrand = [
      "• Working (9s • esc to interrupt)",
      `› [from:agend-dev-claude-t1519896892392083558] ${BODY}`,
      "  Context 63% left",
    ].join("\n");
    h.state.pane = identicalOlderStrand;
    h.state.afterPaste = identicalOlderStrand; // ours was swallowed
    h.state.afterEnter = identicalOlderStrand;
    // The recovery lands. The older strand is still on screen above it — it
    // does not disappear because we pasted — so the body now appears twice,
    // which is what makes this provable without an envelope id.
    h.state.afterSecondPaste = [identicalOlderStrand, SUBMITTED].join("\n");
    const ok = await settle(h.daemon.deliverMessage(MESSAGE_SINGLELINE, STATUS, {}));

    expect(h.paste, "the older strand is not ours to claim as delivered").toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain("message_failed");
    expect(ok).toBe(false);
  });

  // Agents and users discuss message ids in the message BODY all the time
  // ("check message_id: abc"). Scanning the rendered text for the first
  // `message_id:` picks that up instead of the id AgEnD appended, treats it as
  // uniquely identifying, and then an older transcript entry quoting the same
  // thing confirms a paste that never landed. The id has to come from the
  // message's own metadata, not from reading the text back out.
  it("does not treat a message id written in the body as this delivery's identity", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    const bodyMentioningAnId = "inspect message_id: mentioned-by-user and report back";
    const older = [
      "• Working (9s • esc to interrupt)",
      `› [from:agend-dev-claude-t1519896892392083558] ${bodyMentioningAnId}`,
      "  (message_id: m-0 | correlation_id: cid-older-delivery)",
      "› Ask Codex to do anything",
      "  Context 63% left",
    ].join("\n");
    h.state.pane = older;
    h.state.afterPaste = older; // this delivery's paste was swallowed by a redraw

    h.state.afterSecondPaste = SUBMITTED; // the recovery paste lands
    const ok = await settle(h.daemon.deliverMessage(
      `[from:agend-dev-claude-t1519896892392083558] ${bodyMentioningAnId}\n(message_id: m-1 | correlation_id: cid-now)`,
      STATUS,
      { submissionId: "m-1" },
    ));

    expect(h.paste, "the id in the body belongs to an older message, not this one").toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain("message_failed");
    expect(ok).toBe(false);
  });

  // The wiring, not just the check: deliverMessage only knows the trusted id
  // because pushChannelMessage hands it over. This is the shape where that
  // matters — a repeated instruction whose older copy scrolls off as ours
  // arrives. Counting body matches gives the same number before and after, so
  // without the envelope id the delivery is judged unproven and pasted again.
  it("carries the envelope id from the real entry point into the submission proof", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    const repeated = "carry on with the migration and report back when it is done";
    h.state.pane = [
      "• Working (9s • esc to interrupt)",
      `› [user:hanhanv via discord] ${repeated}`,
      "  (message_id: old-1 | correlation_id: cid-older)",
      "› Ask Codex to do anything",
      "  Context 63% left",
    ].join("\n");
    // Ours is submitted and echoed; the older copy has scrolled out of view.
    h.state.afterPaste = [
      "• You have 1 usage limit reset available. Run /usage to use one.",
      `› [user:hanhanv via discord] ${repeated}`,
      "  (message_id: new-1 | correlation_id: cid-now)",
      "• Working (1s • esc to interrupt)",
      "› Ask Codex to do anything",
      "  Context 63% left",
    ].join("\n");

    h.daemon.pushChannelMessage(repeated, {
      user: "hanhanv", source: "discord", chat_id: "c",
      message_id: "new-1", correlation_id: "cid-now",
    });
    await settle(Promise.resolve().then(async () => {
      const done = () => h.events.includes("message_confirmed") || h.events.includes("message_failed");
      for (let i = 0; i < 300 && !done(); i++) await new Promise(r => setTimeout(r, 100));
      return true;
    }));

    expect(h.paste, "an already-submitted message must not be pasted again").toHaveBeenCalledTimes(1);
    expect(h.events).toContain("message_confirmed");
  });

  /**
   * The wake case, from the field (beta.16): an instance auto-paused at 22:04,
   * a message arrived at 00:43 and auto-woke it, and the turn ended with
   * historyPreserved:false and nothing in the transcript — the text was pasted
   * and never submitted, while the delivery reported success.
   *
   * What makes it different from the strands above is the CLI's final redraw.
   * It lands right as the Enter goes out, so the pane IS producing output while
   * the Enter is being swallowed. Anything that treats "the pane printed
   * something" as proof confirms a message that never entered a turn — output
   * is corroboration, text still in the input row is disqualifying, and the
   * disqualifying evidence has to win.
   */
  it("does not confirm a woken instance's first delivery when both Enters are swallowed but the pane is redrawing", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = true;                         // idle path, not the native queue
    h.state.outputSince = true;                  // the wake redraw keeps printing
    h.state.afterPaste = STRANDED_MULTILINE;     // every Enter is swallowed
    h.state.afterEnter = STRANDED_MULTILINE;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(h.events, "a redraw is not a turn").not.toContain("message_confirmed");
    expect(h.events).toContain("message_failed");
    expect(ok).toBe(false);
  });

  /**
   * The same rule one layer down, in the native-queue recovery. That branch only
   * runs because the text was found in the input row; if its recovery Enter is
   * swallowed as well, the pane is busy with something else and must not be
   * read as proof that this message went out.
   */
  it("does not let unrelated output confirm a native-queue strand whose recovery Enter was also swallowed", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;                        // busy → native-queue handoff
    h.state.outputSince = true;                  // unrelated output throughout
    h.state.afterPaste = STRANDED_MULTILINE;
    h.state.afterEnter = STRANDED_MULTILINE;     // the recovery Enter is swallowed too

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(h.events).not.toContain("message_confirmed");
    expect(h.events).toContain("message_failed");
    expect(ok).toBe(false);
  });

  /**
   * The native-queue recovery's OTHER exit. When the first paste leaves no
   * trace the branch re-pastes — and then judged that attempt by output alone
   * whenever a control client existed, consulting the real proof only when
   * there was none. So the strong check ran exactly where we could observe
   * least. If the second paste is swallowed too and the pane is still
   * redrawing, that redraw confirmed a message that was never submitted.
   */
  it("does not let unrelated output confirm a native redelivery whose second paste also vanished", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;                 // busy → native-queue handoff
    h.state.outputSince = true;           // the wake redraw keeps printing
    const noTrace = [
      "• Working (9s • esc to interrupt)",
      "› Ask Codex to do anything",
      "  Context 63% left",
    ].join("\n");
    h.state.pane = noTrace;
    h.state.afterPaste = noTrace;         // neither paste ever renders
    h.state.afterSecondPaste = noTrace;
    h.state.afterEnter = noTrace;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(h.paste, "absence is not proof that a retry is safe").toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
    expect(ok).toBe(false);
  });

  // The same trap in the transcript: an older message that opens the same way
  // must not vouch for this one. The routing envelope's message_id is what
  // separates them.
  it("does not let an older transcript entry with the same body confirm this paste", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.pane = [
      "• Working (9s • esc to interrupt)",
      `› [from:agend-dev-claude-t1519896892392083558] ${BODY}`,
      "  (message_id: m-0 | correlation_id: cid-older-delivery)",
      "› Ask Codex to do anything",
      "  Context 63% left",
    ].join("\n");
    h.state.afterPaste = h.state.pane; // our paste never rendered
    // The recovery lands and carries THIS delivery's envelope id, which is what
    // separates it from the older copy still sitting above.
    h.state.afterSecondPaste = [h.state.pane, SUBMITTED].join("\n");

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, { submissionId: "m-1" }));

    expect(h.paste, "the older copy is not evidence for this delivery").toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain("message_failed");
    expect(ok).toBe(false);
  });
});
