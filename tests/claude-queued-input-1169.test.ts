/**
 * #1169: claude-code takes a delivery into its own queue while it works (supportsQueuedInput), like Codex.
 *
 * Verified live on Claude Code 2.1.293 under the production launch (mock Anthropic API, private tmux; the captures are
 * tests/fixtures/claude-2.1.293-*): a paste+Enter while Claude streams moves above the spinner with
 * `ctrl+x ctrl+s to send now` under it and is sent once the turn ends — not dropped, not interrupting the turn, sent
 * exactly once even with a second Enter; while a tool runs it is taken at the tool boundary (the transcript's
 * `queued_command`). The hand-off is proven on the input box (#1200): our message_id in the queue block, or — for a
 * delivery without a unique id whose text has scrolled out of that block — one more queue marker than before.
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
const pane = (name: string) => readFileSync(join(FIX, `claude-2.1.293-${name}.pane.txt`), "utf8");
const BUSY_EMPTY = pane("busy-empty");
const BUSY_PASTED = pane("long-busy-pasted");
const BUSY_QUEUED = pane("long-busy-queued");
const QUEUED = ["busy-queued", "busy-queued-long", "long-busy-queued", "tool-queued"].map(n => `claude-2.1.293-${n}.pane.txt`)
  // #1239's 2.1.291 capture: a message queued while Claude retried a 500 — the same row, two versions back.
  .concat("claude-2.1.291-error-500-retrying-statusline.pane.txt");
const fixture = (file: string) => readFileSync(join(FIX, file), "utf8");

describe("the backend", () => {
  const backend = new ClaudeCodeBackend("/nonexistent-1169");

  it("hands deliveries to Claude's queue", () => {
    expect(backend.supportsQueuedInput()).toBe(true);
  });

  it("the queue marker is the `ctrl+x ctrl+s to send now` row: once per queued message on screen, nowhere else", () => {
    const marker = backend.getQueuedInputMarker()!;
    const count = (text: string) => text.split("\n").filter(row => marker.test(row)).length;
    for (const file of QUEUED) expect(count(fixture(file)), file).toBe(1);
    for (const f of readdirSync(FIX).filter(f => f.startsWith("claude-") && !QUEUED.includes(f))) expect(count(fixture(f)), f).toBe(0);
    // the words in a reply line, or quoted mid-row, are not the marker row
    expect(count("● Press ctrl+x ctrl+s to send now, it says\n  you can press ctrl+x ctrl+s to send now")).toBe(0);
  });
});

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

function makeDaemon(root: string, backend: ClaudeCodeBackend, screen: (s: { pasted: boolean; enters: number; idled: boolean }) => string) {
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const s = { pasted: false, enters: 0, idled: false };
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
    capturePane: vi.fn(async () => screen(s)),
    capturePaneWithHistory: vi.fn(async () => screen(s)),
    pasteBuffer: vi.fn(async () => { s.pasted = true; return true; }),
    sendSpecialKey: vi.fn(async (key: string) => { if (key === "Enter") s.enters++; return true; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(true);
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  return { daemon, tmux, control, s };
}

async function deliverToBusyClaude(screen: (s: { pasted: boolean; enters: number; idled: boolean }) => string) {
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
    user: "instance:source", user_id: "instance:source", message_id: "xmsg-long-11", chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
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

describe("the queue marker proves a hand-off its text cannot", () => {
  // A delivery with no unique id, so only its body can identify it — and the 80-line block in long-busy-queued has
  // scrolled its first line off screen. One more `ctrl+x ctrl+s` row than before the paste is the only evidence left.
  const signature = { value: "[agend-delivery-id:5b0c1d", unique: false };

  async function verdict(backend: ClaudeCodeBackend) {
    const root = mkdtempSync(join(tmpdir(), "agend-1169-sig-")); roots.push(root);
    let after = false;
    const { daemon } = makeDaemon(root, backend, () => (after ? BUSY_QUEUED : BUSY_EMPTY));
    const baseline = daemon.paneEvidence(BUSY_EMPTY, signature);
    after = true;
    return daemon.confirmSubmitted(signature, baseline);
  }

  it("with the marker: submitted", async () => {
    expect(BUSY_QUEUED).not.toContain("[agend-delivery-id:5b0c1d");
    expect(await verdict(new ClaudeCodeBackend("/nonexistent-1169"))).toBe("submitted");
  });

  it("without it, the same quiet queued pane proves nothing (the pane would be read as never having taken it)", async () => {
    const noMarker = Object.assign(new ClaudeCodeBackend("/nonexistent-1169"), { getQueuedInputMarker: () => null });
    expect(await verdict(noMarker)).toBe("unproven");
  });
});
