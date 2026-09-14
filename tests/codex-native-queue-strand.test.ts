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
  "• Working (1s • esc to interrupt)",
  "› Ask Codex to do anything",
  "  Context 100% left",
].join("\n");

interface Harness {
  daemon: any;
  state: { pane: string; idle: boolean; outputSince: boolean };
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

  const state = { pane: STRANDED_MULTILINE, idle: false, outputSince: true };
  const paste = vi.fn(async () => true);
  const enter = vi.fn(async () => true);
  daemon.tmux = {
    capturePane: async () => state.pane,
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
  // THE GATE. Reverting the success criterion to "the pasted text is visible in
  // the pane" turns this red: the stranded pane below contains the text.
  it("refuses the handoff and redelivers when the text is still in the input row", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;              // busy → native-queue handoff
    h.state.pane = STRANDED_MULTILINE; // Enter dropped: the text never left the input row

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, {}));

    // The handoff must not accept this pane. It falls through to the idle-gated
    // path — the only one with a full confirmation ladder — which pastes again.
    expect(h.paste, "the stranded pane must not end the delivery").toHaveBeenCalledTimes(2);
    // That second attempt is verified for real (idle→busy), so the message is
    // recovered rather than silently dropped.
    expect(ok).toBe(true);
    expect(h.events).toContain("message_confirmed");
  });

  it("also refuses the single-line shape of the same failure", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.pane = STRANDED_SINGLELINE;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_SINGLELINE, STATUS, {}));

    expect(h.paste).toHaveBeenCalledTimes(2);
    expect(ok).toBe(true);
  });

  // The end of the line: the pane stays stranded and the redelivery's Enter is
  // dropped too. The delivery must say ❌, not ✅ — silent loss is the bug.
  it("fails loudly when even the idle-gated redelivery cannot be confirmed", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.pane = STRANDED_MULTILINE;
    h.state.outputSince = false; // no idle→busy after either Enter

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, {}));

    expect(ok).toBe(false);
    expect(h.events, "a message nobody could submit is not delivered").not.toContain("message_confirmed");
    expect(h.events).toContain("message_failed");
  });

  // The Forge shape: an EARLIER delivery is already stranded, so the input row
  // holds "previous message + ours" and ours is no longer a prefix of it.
  it("detects stranding when an earlier message is stacked in front of ours", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.pane = [
      "• You have 1 usage limit reset available. Run /usage to use one.",
      "› [system] an earlier notice whose Enter was dropped",
      `  [from:agend-dev-claude-t1519896892392083558] ${BODY}`,
      "  (message_id: m-1 | correlation_id: cid-1789356482291-pjykib)",
      "  Context 63% left",
    ].join("\n");

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_MULTILINE, STATUS, {}));

    expect(h.paste, "a stacked strand is still a strand").toHaveBeenCalledTimes(2);
    expect(ok).toBe(true);
  });

  // The other half of the gate: the fix must not turn codex's native queue —
  // which is working as designed — into a failure or a double delivery.
  it("confirms a message codex took into its own queue (↳), pasting exactly once", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.pane = NATIVE_QUEUE_ACCEPTED;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_SINGLELINE, STATUS, {}));

    expect(ok).toBe(true);
    expect(h.events).toContain("message_confirmed");
    expect(h.events).not.toContain("message_failed");
    expect(h.paste, "a confirmed message must not be delivered twice").toHaveBeenCalledTimes(1);
  });

  // The race that a bare "↳ must be present" rule would get wrong: codex can
  // finish its turn between the readiness probe and our Enter, submitting the
  // message immediately. There is no ↳ then — only the transcript echo.
  it("confirms a message codex submitted immediately, without a queue marker", async () => {
    const h = makeHarness(); dirs.push(h.dir);
    h.state.idle = false;
    h.state.pane = SUBMITTED;

    const ok = await settle(h.daemon.deliverMessage(MESSAGE_SINGLELINE, STATUS, {}));

    expect(ok).toBe(true);
    expect(h.events).toContain("message_confirmed");
    expect(h.paste, "no redelivery — it was already submitted").toHaveBeenCalledTimes(1);
  });
});
