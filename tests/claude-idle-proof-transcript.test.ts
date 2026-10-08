/**
 * A delivery Claude took at once was settled `uncertain` and a ⚠️ went to the user (beta.8, 2026-10-08 13:53, dev1 →
 * leader). Replayed live on Claude Code 2.1.293 (mock API, private tmux; tests/fixtures/claude-2.1.293-idle-submit-*):
 * after the Enter the box keeps painting the collapsed paste for ~20 captures in a row (`painting`), then the echo with
 * our message_id is on screen for a moment (`echo`), then a reply that starts at once pushes it away (`flooded`). The
 * transcript has the user entry, led by our marker, ~100 ms after the Enter.
 *
 * The post-Enter proof took the first painting frame for a strand, stopped polling, and waited up to 30 s for a prompt
 * the busy CLI never showed; by then the echo was gone and nothing asked the transcript. Now:
 *  - a strand on a structural box reader only counts once it outlasts the proof window;
 *  - a transcript checkpoint makes the CLI's own record of this delivery's exact marker a submission proof.
 *
 * Real Daemon and DeliveryOutbox, stub tmux serving the captures; nothing starts a CLI, a fleet or a tmux server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

const FIX = join(__dirname, "fixtures");
const pane = (name: string) => readFileSync(join(FIX, `claude-2.1.293-${name}.pane.txt`), "utf8");
const IDLE = pane("idle-empty");
const PASTED = pane("idle-paste-long");
const PAINTING = pane("idle-submit-painting");
const ECHO = pane("idle-submit-echo");
const FLOODED = pane("idle-submit-flooded");
const CAPTURED_ID = "7e57bbbb-0000-4000-8000-000000001400";
/** The message_id the replayed delivery carried (the echo fixture shows it). */
const CAPTURED_MESSAGE_ID = "xmsg-rig-1400";
/** The transcript Claude wrote for the replayed delivery, re-keyed to the test's delivery id. */
const transcriptFor = (deliveryId: string) =>
  readFileSync(join(FIX, "claude-2.1.293-idle-submit-flooded.transcript.jsonl"), "utf8").split(CAPTURED_ID).join(deliveryId) + "\n";

const realSetImmediate = setImmediate;
/** The transcript reads are real file I/O: let them finish between fake-time steps. */
const ioTurns = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise<void>(r => realSetImmediate(r)); };
const roots: string[] = [];
const daemons: any[] = [];
afterEach(() => {
  for (const d of daemons.splice(0)) d.fenceDeliveryWritesForStop();
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Run {
  /** What the pane shows for the n-th capture after the Enter (1-based). */
  afterEnter: (n: number) => string;
  /** Whether Claude writes its transcript entry at the Enter: this delivery's own, another's, or none. */
  transcript?: "own" | "other" | "none";
  /** No transcript checkpoint at all (the transcript cannot be located). */
  noCheckpoint?: boolean;
}

async function deliverToIdleClaude(run: Run) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-idle-proof-")); roots.push(root);
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, "");
  const warn = vi.fn();
  const logger = { info() {}, warn, error() {}, debug() {}, child() { return this; } } as any;
  const control = {
    getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true, hasOutputSince: () => true,
    waitUntilIdle: vi.fn(async () => true),
  };
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, new ClaudeCodeBackend(instanceDir) as any, control as any, logger);
  daemons.push(daemon);
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  daemon.setDeliveryOutboxPort(outbox);
  if (!run.noCheckpoint) {
    daemon.transcriptMonitor = {
      reconciliationCheckpoint: async () => ({ path: transcript, offset: statSync(transcript).size, sessionId: "session" }),
    };
  }
  const row = outbox.admit({
    operationId: "op", sourceKey: "s:op:w:fleet_inbound", sourceInstance: "source", sourceDaemonBootId: "sb",
    targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hello", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const s = { pasted: false, enters: 0, after: 0 };
  const screen = () => (!s.pasted ? IDLE : s.enters === 0 ? PASTED : run.afterEnter(++s.after));
  daemon.tmux = {
    capturePane: vi.fn(async () => screen()),
    capturePaneWithHistory: vi.fn(async () => screen()),
    pasteBuffer: vi.fn(async () => { s.pasted = true; return true; }),
    sendSpecialKey: vi.fn(async (key: string) => {
      if (key !== "Enter") return true;
      s.enters++;
      // Claude records the submit in its transcript right away (~100 ms after the Enter, live).
      if (s.enters === 1 && run.transcript !== "none") {
        appendFileSync(transcript, transcriptFor(run.transcript === "other" ? "5b0c1d2e-0000-4000-8000-0000000000ff" : row.deliveryId));
      }
      return true;
    }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getPaneInputMode: vi.fn(async () => "raw"),
    getWindowId: () => "@worker",
  };
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("ready");
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  // The CLI is working on the message: the prompt does not come back within the wait (the 13:53 leader worked 52 s).
  const readyWait = vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockImplementation(async (...args: unknown[]) => {
    await new Promise(r => setTimeout(r, Number(args[1] ?? 30_000)));
    return false;
  });
  daemon.pushChannelMessage("hello", {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: CAPTURED_MESSAGE_ID, chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
  });
  for (let i = 0; i < 400 && !["delivered", "uncertain", "failed"].includes(outbox.get(row.deliveryId)?.state ?? ""); i++) {
    await vi.advanceTimersByTimeAsync(250);
    await ioTurns();
  }
  const attempt = (outbox as any).db.prepare("SELECT evidence FROM delivery_attempts WHERE delivery_id=?").get(row.deliveryId) as { evidence: string | null };
  const notices = ((outbox as any).db.prepare("SELECT COUNT(*) AS n FROM failure_notices").get() as { n: number }).n;
  return { state: outbox.get(row.deliveryId)?.state, evidence: attempt?.evidence ?? null, notices, s, readyWait, warn, tmux: daemon.tmux };
}

const painting = (frames: number, then: string) => (n: number) => (n <= frames ? PAINTING : then);

describe("the 13:53 sequence: submit → the box paints the paste a moment longer → the reply pushes the echo away", () => {
  it("the transcript has this delivery's user entry: delivered, no ⚠️, one paste, one Enter, no wait for the prompt", async () => {
    // The pane never shows the echo at all here — painting, then flooded — so only the transcript can prove it.
    const r = await deliverToIdleClaude({ afterEnter: painting(20, FLOODED), transcript: "own" });
    expect(r.state).toBe("delivered");
    expect(r.evidence).toBe("positive submission proof; transcript-marker");
    expect(r.notices).toBe(0);
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(1);
    expect(r.readyWait).not.toHaveBeenCalled();
  });

  it("another delivery's entry in the transcript proves nothing: still uncertain (ownership is the exact marker)", async () => {
    const r = await deliverToIdleClaude({ afterEnter: painting(20, FLOODED), transcript: "other" });
    expect(r.state).toBe("uncertain");
    expect(r.notices).toBe(1);
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  });

  it("no transcript to ask, but the echo shows once the box has painted: the strand is polled through, delivered on the pane", async () => {
    const r = await deliverToIdleClaude({ afterEnter: painting(8, ECHO), transcript: "none", noCheckpoint: true });
    expect(r.state).toBe("delivered");
    expect(r.evidence).toBe("positive submission proof");
    expect(r.readyWait).not.toHaveBeenCalled();
    expect(r.s.enters).toBe(1);
  });

  it("nothing to prove it with (no transcript, the echo flooded away): uncertain, and the log names the CLI it was", async () => {
    const r = await deliverToIdleClaude({ afterEnter: painting(8, FLOODED), transcript: "none", noCheckpoint: true });
    expect(r.state).toBe("uncertain");
    const lines = r.warn.mock.calls.map(call => String(call[1]));
    expect(lines).toContain("claude-code delivery outcome uncertain — no hard failure or duplicate paste");
    expect(lines.some(line => line.startsWith("Codex"))).toBe(false);
  });

  it("a strand that outlasts the window is still a swallowed Enter: the recovery wait runs (only then)", async () => {
    const r = await deliverToIdleClaude({ afterEnter: () => PAINTING, transcript: "none", noCheckpoint: true });
    expect(r.readyWait).toHaveBeenCalled();
    expect(r.state).not.toBe("delivered");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  });
});
