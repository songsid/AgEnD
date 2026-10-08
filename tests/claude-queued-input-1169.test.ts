/**
 * #1169: claude-code takes a delivery into its own queue while it works (supportsQueuedInput), like Codex.
 *
 * Verified live on Claude Code 2.1.293 under the production launch (mock Anthropic API, private tmux; the captures are
 * tests/fixtures/claude-2.1.293-*): a paste+Enter while Claude streams moves above the spinner with
 * `ctrl+x ctrl+s to send now` under it and is sent once the turn ends — not dropped, not interrupting the turn, sent
 * exactly once even with a second Enter; while a tool runs it is taken at the tool boundary (the transcript's
 * `queued_command`). The hand-off is proven on the input box (#1200): our message_id in the queue block, or a queue the
 * box did not have before the paste — the queued placeholder in the box with the queue marker right above it
 * (InputBox.queued). The marker's words anywhere else (a reply quoting it) are not a queue (#1169 review).
 *
 * Real Daemon and DeliveryOutbox, stub tmux serving the captures; nothing starts a CLI, a fleet or a tmux server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

const FIX = join(__dirname, "fixtures");
const fixture = (file: string) => readFileSync(join(FIX, file), "utf8");
const pane = (name: string) => readFileSync(join(FIX, `claude-2.1.293-${name}.pane.txt`), "utf8");
const BUSY_EMPTY = pane("busy-empty");
const BUSY_PASTED = pane("long-busy-pasted");
const BUSY_QUEUED = pane("long-busy-queued");
/** Live: a reply prints the marker's words as its own row, right above an empty box — no queue. */
const REPLY_QUOTES_MARKER = pane("busy-reply-quotes-marker");
/** Live: the same turn, then a message queued under the quoting reply; then a second one (one marker for both). */
const QUEUED_UNDER_QUOTE = pane("busy-queued-under-quote");
const QUEUED_TWO = pane("busy-queued-two");
/** A modal the reader has no box for (the harness's dialog probe answers "clear": one the dialog table missed). */
const NO_BOX = fixture("claude-2.1.291-bypass-dangerous-rm-prompt.pane.txt");
const QUEUED = ["busy-queued", "busy-queued-long", "long-busy-queued", "tool-queued", "busy-queued-two", "busy-queued-under-quote"]
  .map(n => `claude-2.1.293-${n}.pane.txt`)
  // #1239's 2.1.291 capture: a message queued while Claude retried a 500 — the same row, two versions back.
  .concat("claude-2.1.291-error-500-retrying-statusline.pane.txt");

describe("the backend", () => {
  const backend = new ClaudeCodeBackend("/nonexistent-1169");

  it("hands deliveries to Claude's queue", () => {
    expect(backend.supportsQueuedInput()).toBe(true);
  });

  it("has no pane-wide queue marker: its queue is read from the box", () => {
    expect((backend as any).getQueuedInputMarker).toBeUndefined();
  });

  it("the box reports Claude's queue on every queued capture, and on no other Claude fixture", () => {
    const panes = readdirSync(FIX).filter(f => /^claude-.*\.pane\.txt$/.test(f));
    for (const f of panes) expect(backend.readInputRow(fixture(f))?.queued === true, f).toBe(QUEUED.includes(f));
  });

  it("a reply that prints the marker's words is not a queue — as its own row right above the box, or above a spinner", () => {
    expect(REPLY_QUOTES_MARKER).toMatch(/^ {2}ctrl\+x ctrl\+s to send now$/m);
    expect(backend.readInputRow(REPLY_QUOTES_MARKER)).toEqual({ text: "", collapsedPastes: 0 });
    // the spinner between the quoted row and the box changes nothing: no placeholder, no queue
    const withSpinner = REPLY_QUOTES_MARKER.replace(/(^ {2}ctrl\+x ctrl\+s to send now\n)/m, "$1✢ Spelunking… (7s)\n");
    expect(backend.readInputRow(withSpinner)?.queued).toBeUndefined();
  });

  it("the placeholder alone is not enough: the marker must close the block right above the box", () => {
    // The queue's marker, then a transcript row between it and the box: not the layout Claude paints for its queue.
    const at = QUEUED_TWO.lastIndexOf("  ctrl+x ctrl+s to send now\n") + "  ctrl+x ctrl+s to send now\n".length;
    const detached = `${QUEUED_TWO.slice(0, at)}● a reply row\n${QUEUED_TWO.slice(at)}`;
    expect(backend.readInputRow(detached)).toEqual({ text: "", collapsedPastes: 0 });
  });
});

interface Screen {
  pasted: boolean; enters: number; idled: boolean; captures: number; waited: number;
  /** How many readiness waits had happened when the first paste / the durable begin happened (null: never). */
  pastedAfterWaits: number | null; begunAfterWaits: number | null;
}

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

function makeDaemon(root: string, backend: ClaudeCodeBackend, screen: (s: Screen) => string) {
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const s: Screen = { pasted: false, enters: 0, idled: false, captures: 0, waited: 0, pastedAfterWaits: null, begunAfterWaits: null };
  const control = {
    getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false, hasOutputSince: () => true,
    waitUntilIdle: vi.fn(async () => { s.idled = true; return true; }),
  };
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, backend as any, control as any, logger);
  const tmux = {
    capturePane: vi.fn(async () => { s.captures++; return screen(s); }),
    capturePaneWithHistory: vi.fn(async () => screen(s)),
    pasteBuffer: vi.fn(async () => { s.pasted = true; s.pastedAfterWaits ??= s.waited; return true; }),
    sendSpecialKey: vi.fn(async (key: string) => { if (key === "Enter") s.enters++; return true; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockImplementation(async () => { s.waited++; return true; });
  const begin = daemon.beginDurableDelivery.bind(daemon);
  vi.spyOn(daemon, "beginDurableDelivery").mockImplementation((...args: unknown[]) => { s.begunAfterWaits ??= s.waited; return begin(...args); });
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  return { daemon, tmux, control, s };
}

async function deliverToBusyClaude(screen: (s: Screen) => string, messageId = "xmsg-long-11") {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-1169-")); roots.push(root);
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const { daemon, tmux, control, s } = makeDaemon(root, new ClaudeCodeBackend(join(root, "instances", "worker")), screen);
  daemon.setDeliveryOutboxPort(outbox);
  const row = outbox.admit({
    operationId: "op", sourceKey: "s:op:w:fleet_inbound", sourceInstance: "source", sourceDaemonBootId: "sb",
    targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hello", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const failed = vi.fn(); daemon.on("message_failed", failed);
  daemon.pushChannelMessage("hello", {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: messageId, chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
  });
  for (let i = 0; i < 120 && !(tmux.pasteBuffer.mock.calls.length > 0 && outbox.get(row.deliveryId)?.state !== "delivering"); i++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await vi.advanceTimersByTimeAsync(5_000);
  const attempt = (outbox as any).db.prepare("SELECT evidence FROM delivery_attempts WHERE delivery_id=?").get(row.deliveryId) as { evidence: string | null };
  return { state: outbox.get(row.deliveryId)?.state, evidence: attempt?.evidence ?? null, tmux, control, failed, s };
}

describe("an ordinary delivery to a BUSY Claude pane", () => {
  it("is handed to Claude's queue at once — no wait for the turn, one paste, one Enter (no second Enter that could touch the queue), proven by the queue block", async () => {
    const r = await deliverToBusyClaude(s => (!s.pasted ? BUSY_EMPTY : s.enters === 0 ? BUSY_PASTED : BUSY_QUEUED));
    expect(r.state).toBe("delivered");
    expect(r.evidence).toBe("positive submission proof");
    expect(r.control.waitUntilIdle).not.toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(1);
    expect(r.failed).not.toHaveBeenCalled();
  });

  it("an Enter the TUI swallowed (our collapsed paste still in the box): submitted once the turn is over, never pasted twice", async () => {
    const r = await deliverToBusyClaude(s => (!s.pasted ? BUSY_EMPTY : s.enters < 2 ? BUSY_PASTED : BUSY_QUEUED));
    expect(r.state).toBe("delivered");
    expect(r.control.waitUntilIdle).toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(2);
  });
});

describe("a queue the box did not have proves a hand-off its text cannot", () => {
  // A delivery with no unique id, so only its body can identify it — and the 80-line block in long-busy-queued has
  // scrolled its first line off screen. A queue that was not there before the paste is the only evidence left.
  const bodySignature = { value: "[agend-delivery-id:5b0c1d", unique: false };
  // A trusted-id delivery whose id is nowhere on screen falls back to the same comparison.
  const idSignature = { value: "(message_id:xmsg-not-on-screen", unique: true };

  async function verdict(before: string, after: string, signature: { value: string; unique: boolean } = bodySignature) {
    const root = mkdtempSync(join(tmpdir(), "agend-1169-sig-")); roots.push(root);
    const { daemon } = makeDaemon(root, new ClaudeCodeBackend(join(root, "instances", "worker")), () => after);
    return daemon.confirmSubmitted(signature, daemon.paneEvidence(before, signature));
  }

  it("a queue that formed after the paste: submitted", async () => {
    expect(BUSY_QUEUED).not.toContain("[agend-delivery-id:5b0c1d");
    expect(await verdict(BUSY_EMPTY, BUSY_QUEUED)).toBe("submitted");
    // under a reply that quotes the marker, too: the quote is not the queue, the new queue is
    expect(await verdict(REPLY_QUOTES_MARKER, QUEUED_UNDER_QUOTE)).toBe("submitted");
  });

  it("this turn's reply quoting the marker on its own row, our input swallowed: not submitted — with or without a trusted id", async () => {
    expect(await verdict(BUSY_EMPTY, REPLY_QUOTES_MARKER)).toBe("unproven");
    expect(await verdict(BUSY_EMPTY, REPLY_QUOTES_MARKER, idSignature)).toBe("unproven");
  });

  it("a queue that was already there (an older message's) vouches for nothing new — with or without a trusted id", async () => {
    expect(await verdict(QUEUED_UNDER_QUOTE, QUEUED_UNDER_QUOTE)).toBe("unproven");
    expect(await verdict(QUEUED_UNDER_QUOTE, QUEUED_UNDER_QUOTE, idSignature)).toBe("unproven");
    // a second message joins the block under the same single marker: still no new queue to count
    expect(await verdict(QUEUED_UNDER_QUOTE, QUEUED_TWO, { value: "(message_id:xmsg-q-c", unique: true })).toBe("unproven");
  });

  it("a queue after a box that could not be read before the paste is not new evidence", async () => {
    expect(await verdict(NO_BOX, BUSY_QUEUED)).not.toBe("submitted");
  });
});

describe("the delivery handler, end to end (real Daemon and outbox)", () => {
  it("a swallowed paste under a reply quoting the marker is uncertain, never `delivered / positive submission proof`", async () => {
    // Our message_id is nowhere on screen (the capture's transcript shows an older xmsg-long-11): only the quote is.
    expect(REPLY_QUOTES_MARKER).not.toContain("xmsg-1169-swallowed");
    const r = await deliverToBusyClaude(s => (!s.pasted ? BUSY_EMPTY : REPLY_QUOTES_MARKER), "xmsg-1169-swallowed");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.state).toBe("uncertain");
    expect(r.evidence).toBe("native-queue-proof:unproven");
    expect(r.s.enters).toBe(1);
  });
});

describe("a hand-off needs a readable box on a fresh capture", () => {
  /** Logged when the under-lock re-check refuses a write the hand-off decision had allowed. */
  const LATE = "Dialog or input transition appeared before the pane write — waiting for readiness";
  const lateRefusals = (info: { mock: { calls: unknown[][] } }) => info.mock.calls.filter(call => call[0] === LATE).length;

  it("the box cannot be read (a modal the dialog table missed): nothing is written until readiness is waited for", async () => {
    const info = vi.spyOn(logger, "info");
    const r = await deliverToBusyClaude(() => NO_BOX);
    // refused where the hand-off is chosen, not first chosen and then caught under the lock
    expect(lateRefusals(info)).toBe(0);
    // No hand-off: the delivery takes the wait-for-readiness path, and anything it writes comes after that wait.
    expect(r.s.waited).toBeGreaterThan(0);
    expect(r.s.pastedAfterWaits ?? Infinity).toBeGreaterThanOrEqual(1);
  });

  it("the capture fails: nothing is written until readiness is waited for", async () => {
    const info = vi.spyOn(logger, "info");
    const r = await deliverToBusyClaude(() => { throw new Error("capture-pane failed"); });
    expect(lateRefusals(info)).toBe(0);
    // No hand-off: the delivery takes the wait-for-readiness path, and anything it writes comes after that wait.
    expect(r.s.waited).toBeGreaterThan(0);
    expect(r.s.pastedAfterWaits ?? Infinity).toBeGreaterThanOrEqual(1);
  });

  it("readable when the hand-off is chosen, gone under the pane lock: the write waits, and only then lands", async () => {
    // capture 1 is the outer check (box readable); capture 2 is the under-lock re-check (a modal now); after the wait
    // the box is back and the write goes ahead.
    const info = vi.spyOn(logger, "info");
    const r = await deliverToBusyClaude(s => (s.waited > 0 ? (!s.pasted ? BUSY_EMPTY : s.enters === 0 ? BUSY_PASTED : BUSY_QUEUED)
      : s.captures <= 1 ? BUSY_EMPTY : NO_BOX));
    expect(lateRefusals(info)).toBe(1);
    expect(r.s.waited).toBe(1);
    expect(r.s.pastedAfterWaits).toBe(1);
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  });

  // Captures 1 and 2 are the two gate checks (box readable); capture 3 is writeMessageToPane's baseline, the last read
  // before the durable begin and the paste.
  const afterWait = (s: Screen) => (!s.pasted ? BUSY_EMPTY : s.enters === 0 ? BUSY_PASTED : BUSY_QUEUED);

  it("both gates pass, then the last capture before the write has no box: no begin, no paste until readiness is waited for", async () => {
    const info = vi.spyOn(logger, "info");
    const r = await deliverToBusyClaude(s => (s.waited > 0 ? afterWait(s) : s.captures <= 2 ? BUSY_EMPTY : NO_BOX));
    expect(lateRefusals(info)).toBe(1);
    expect(r.s.waited).toBe(1);
    expect(r.s.begunAfterWaits).toBe(1);
    expect(r.s.pastedAfterWaits).toBe(1);
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.state).toBe("delivered");
  });

  it("both gates pass, then every capture for the last read fails (EIO): no begin, no paste until readiness is waited for", async () => {
    const info = vi.spyOn(logger, "info");
    const r = await deliverToBusyClaude(s => {
      if (s.waited > 0) return afterWait(s);
      if (s.captures <= 2) return BUSY_EMPTY;
      throw Object.assign(new Error("capture-pane: EIO"), { code: "EIO" });
    });
    expect(lateRefusals(info)).toBe(1);
    expect(r.s.waited).toBe(1);
    expect(r.s.begunAfterWaits).toBe(1);
    expect(r.s.pastedAfterWaits).toBe(1);
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.state).toBe("delivered");
  });
});
