import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

/**
 * claude-code as it was before #1200: no input-box reader. These cases pin the daemon's readerless path (grok and muse
 * still take it) on Claude's own panes and transcript format; claude-code itself now reads its box
 * (claude-input-box-1200.test.ts).
 */
const readerlessClaude = (instanceDir: string) => Object.assign(new ClaudeCodeBackend(instanceDir), { readInputRow: undefined });
import { CodexBackend } from "../src/backend/codex.js";
import { GrokBackend } from "../src/backend/grok.js";

/**
 * #758: a backend whose input row cannot be read (claude-code, grok, muse, …) was confirmed by "the pane printed something
 * after Enter" — which a redraw that wiped the paste satisfies as well — and the outbox recorded `delivered` / "positive
 * submission proof". Now such a delivery is finished by the CLI's own transcript: the delivery's marker (found → delivered,
 * `transcript-marker`), or — only once the delta was READ and stayed without it for the whole window — `uncertain`.
 * A backend with no transcript keeps today's outcome, labelled. Nothing re-pastes. Real Daemon, real DeliveryOutbox, stub
 * tmux with a scripted pane, a real transcript file; nothing starts a CLI or a tmux server.
 */
/** Every transcript look goes through the scan; the hook sees each one and may act while it is in flight. */
// `byDelivery` counts looks per delivery id: a wait an earlier test left running (its look still in flight when the test
// ended) can outlive it, so what a test asserts about its own delivery's looks is never the global count.
const lookHooks = vi.hoisted(() => ({ onLook: null as null | ((count: number) => void), looks: 0, done: 0, byDelivery: new Map<string, number>(), slowRead: false }));
vi.mock("../src/delivery-reconciliation.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/delivery-reconciliation.js")>();
  return {
    ...real,
    scanTranscriptForDeliveryMarker: async (...args: Parameters<typeof real.scanTranscriptForDeliveryMarker>) => {
      lookHooks.looks++;
      lookHooks.byDelivery.set(args[3], (lookHooks.byDelivery.get(args[3]) ?? 0) + 1);
      lookHooks.onLook?.(lookHooks.looks);
      // slowRead: yield ONE real event-loop turn after the hook fires so the scan
      // is still in-flight when the fence takes effect. Without this, the scan
      // completes synchronously and the proof continuation can run before the
      // stop-during-look scenario has a chance to be exercised.
      if (lookHooks.slowRead) await new Promise<void>(r => realSetImmediate(r));
      try { return await real.scanTranscriptForDeliveryMarker(...args); } finally { lookHooks.done++; }
    },
  };
});

const realSetImmediate = setImmediate;
const roots: string[] = [];
const daemons: any[] = [];
afterEach(() => {
  // End every wait this test left open, so none keeps reading a transcript into the next test.
  for (const daemon of daemons.splice(0)) daemon.fenceDeliveryWritesForStop();
  lookHooks.onLook = null; lookHooks.looks = 0; lookHooks.done = 0; lookHooks.byDelivery.clear(); lookHooks.slowRead = false;
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const CLAUDE_READY = readFileSync(join(__dirname, "fixtures", "claude-2.1.286-ready.pane.txt"), "utf8");
const CODEX_READY = readFileSync(join(__dirname, "fixtures", "codex-0156-ready.pane.txt"), "utf8");
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
const ioTurn = () => new Promise<void>(resolve => realSetImmediate(resolve));

const userEntry = (id: string, body = `[agend-delivery-id:${id}]\n[from:source] hello`, wrapped = true) =>
  JSON.stringify({ type: "user", message: { role: "user", content: wrapped ? `\n\n<pasted_content id="45bc">\n${body}` : body } }) + "\n";
const queuedEntry = (id: string) =>
  JSON.stringify({ type: "queue-operation", operation: "enqueue", content: `<pasted_content id="45bc">\n[agend-delivery-id:${id}]\n[from:source] hello` }) + "\n";

interface Opts {
  backend?: (instanceDir: string) => any;
  /** The name the daemon's config carries (the fleet always resolves one; production attempts store "claude-code", "codex", …). */
  backendName?: string;
  pane?: string;
  /** What the pane shows once the paste has been written (default: the same as before — the paste left no trace). */
  paneAfterPaste?: string;
  /** A raw paste (a slash command): no envelope, so no delivery marker in the text. */
  raw?: boolean;
  /** Rows already in the transcript before the paste (the checkpoint sits after them). */
  transcriptBefore?: (id: string) => string;
  noTranscript?: boolean;
  /** Deliver via steerMessage (a steer into the ready pane) instead of the queued path. */
  steer?: boolean;
}

async function deliver(opts: Opts = {}) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-758-")); roots.push(root);
  const instanceDir = join(root, "instances", "worker");
  const transcript = join(root, "session.jsonl");
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: opts.backendName ?? "claude-code",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, (opts.backend ? opts.backend(instanceDir) : readerlessClaude(instanceDir)) as any,
  // The pane printed something after Enter (the redraw) — the legacy proof — and nothing in it is ours.
  { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true, waitUntilIdle: vi.fn(async () => true), hasOutputSince: () => true } as any, logger);
  daemons.push(daemon);
  daemon.setDeliveryOutboxPort(outbox);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const row = outbox.admit({
    operationId: "op", sourceKey: "s:op:w:fleet_inbound", sourceInstance: "source", sourceDaemonBootId: "sb",
    targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hello", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  writeFileSync(transcript, opts.transcriptBefore ? opts.transcriptBefore(row.deliveryId) : "");
  if (!opts.noTranscript) {
    daemon.transcriptMonitor = {
      reconciliationCheckpoint: async () => ({ path: transcript, offset: statSync(transcript).size, sessionId: "session" }),
    };
  }
  const pane = opts.pane ?? CLAUDE_READY;
  let pasted = false;
  const shown = () => (pasted && opts.paneAfterPaste) || pane;
  const tmux = {
    capturePane: vi.fn(async () => shown()),
    capturePaneWithHistory: vi.fn(async () => shown()),
    pasteBuffer: vi.fn(async () => { pasted = true; return true; }),
    sendSpecialKey: vi.fn(async () => true),
    getLastPasteError: vi.fn(),
    isLastPasteFailureRecoverable: vi.fn(() => true),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("ready");
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  const confirmed = vi.fn();
  daemon.on("message_confirmed", confirmed);
  const inboundMeta = {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: "message-758", chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
  };
  if (opts.raw) {
    daemon.queueRawPaste("/compact", daemon.deliveryEpoch, false, { deliveryId: row.deliveryId, attemptNo: claimed.attemptNo, submissionMode: "raw_paste" });
  } else if (opts.steer) {
    daemon.steerMessage("hello", inboundMeta);
  } else {
    daemon.pushChannelMessage("hello", inboundMeta);
  }
  const state = () => outbox.get(row.deliveryId)?.state;
  const evidence = (): string | null => ((outbox as any).db.prepare("SELECT evidence FROM delivery_attempts WHERE delivery_id=?").get(row.deliveryId) as any)?.evidence ?? null;
  /** One second of fake time per step; a transcript look that step started is allowed to finish (it reads a real file). */
  const pump = async (steps: number, until: () => boolean = () => false) => {
    for (let step = 0; step < steps && !until(); step++) {
      await vi.advanceTimersByTimeAsync(1_000);
      for (let turn = 0; turn < 2_000 && lookHooks.done < lookHooks.looks; turn++) await ioTurn();
      for (let turn = 0; turn < 3; turn++) await ioTurn();
    }
  };
  /** The durable begin has committed — the transcript checkpoint was taken a moment before it. */
  const begun = async () => { await pump(40, () => state() === "submission_started"); };
  const finished = () => !["delivering", "submission_started"].includes(state() ?? "");
  const notices = () => ((outbox as any).db.prepare("SELECT COUNT(*) AS n FROM failure_notices").get() as any).n as number;
  /** A steer runs behind steerLock; pumping advances it the same way. */
  const settleSteer = () => (daemon as any).steerLock as Promise<unknown>;
  /** Transcript looks for this delivery only. */
  const looks = () => lookHooks.byDelivery.get(row.deliveryId) ?? 0;

  // proofSettled: a promise that resolves when proveDeliveryFromTranscript
  // has returned (successfully or not) for this delivery. Awaiting it gives
  // the test a true completion signal rather than relying on spin counts.
  let resolveProof!: () => void;
  const proofSettled = new Promise<void>(r => { resolveProof = r; });
  const realProve = daemon.proveDeliveryFromTranscript?.bind(daemon) as ((...a: unknown[]) => Promise<void>) | undefined;
  if (realProve) {
    daemon.proveDeliveryFromTranscript = async (...args: unknown[]) => {
      try { await realProve(...args); } finally { resolveProof(); }
    };
  } else {
    // If the method doesn't exist (backend variant), resolve immediately.
    resolveProof();
  }

  return { looks, daemon, outbox, tmux, confirmed, transcript, deliveryId: row.deliveryId, state, evidence, pump, finished, begun, notices, settleSteer, proofSettled };
}

describe("a readerless backend's idle delivery is proven by its transcript, not by the pane printing something (#758)", () => {
  it("the paste was wiped and the pane only redrew: the ✅ stays, but the row is uncertain once the whole window passed without the marker", async () => {
    const h = await deliver();
    await h.begun();
    await h.pump(5);
    expect(h.confirmed).toHaveBeenCalledTimes(1);
    // Mid-window a late flush may still arrive: nothing is held against the delivery yet.
    expect(h.state()).toBe("submission_started");
    await h.pump(400, h.finished);
    expect(h.state()).toBe("uncertain");
    expect(h.evidence()).toBe("unverifiable-no-transcript-marker");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("the marker arrives in the transcript wrapped the way Claude Code writes it: delivered, transcript-marker", async () => {
    const h = await deliver();
    await h.begun();
    appendFileSync(h.transcript, userEntry(h.deliveryId));
    await h.pump(400, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("transcript-marker");
  });

  it("a flush that lags the pane by seconds still lands as delivered, with no ⚠️", async () => {
    const h = await deliver();
    await h.begun();
    await h.pump(3);
    expect(h.state()).toBe("submission_started");
    appendFileSync(h.transcript, userEntry(h.deliveryId));
    await h.pump(400, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("transcript-marker");
  });

  it("a CLI that has the message queued but has not read it yet is delivered as `transcript-marker-queued`", async () => {
    const h = await deliver();
    await h.begun();
    appendFileSync(h.transcript, queuedEntry(h.deliveryId));
    await h.pump(400, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("transcript-marker-queued");
  });

  it("the marker must lead the user message: a body that merely quotes it proves nothing", async () => {
    const h = await deliver();
    await h.begun();
    // The delivery's own id inside a longer body, not at its start.
    appendFileSync(h.transcript, userEntry(h.deliveryId, `[from:someone] quoting [agend-delivery-id:${h.deliveryId}] in prose`));
    await h.pump(400, h.finished);
    expect(h.state()).toBe("uncertain");
    expect(h.evidence()).toBe("unverifiable-no-transcript-marker");
  });

  it("an earlier copy of the marker, from before the checkpoint, does not vouch for this paste", async () => {
    const h = await deliver({ transcriptBefore: id => userEntry(id) });
    await h.pump(400, h.finished);
    expect(h.state()).toBe("uncertain");
  });

  it("a marker only before the checkpoint still does not vouch once later turns arrived after it", async () => {
    const h = await deliver({ transcriptBefore: id => userEntry(id) });
    await h.begun();
    // A non-empty delta with no own marker: the scan must still start past the checkpoint, not at zero.
    appendFileSync(h.transcript, userEntry("00000000-0000-4000-8000-000000000042", "an unrelated later turn"));
    await h.pump(400, h.finished);
    expect(h.state()).toBe("uncertain");
    expect(h.evidence()).toBe("unverifiable-no-transcript-marker");
  });

  it("a transcript that cannot be read (gone, or shorter than the checkpoint) is not held against the delivery", async () => {
    const h = await deliver();
    await h.begun();
    rmSync(h.transcript);
    await h.pump(400, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
  });

  it("a transcript that stops being readable after a first clean look is judged by its last look", async () => {
    const h = await deliver();
    await h.begun();
    for (let step = 0; step < 60 && lookHooks.done < 2; step++) await h.pump(1);
    expect(lookHooks.done).toBeGreaterThanOrEqual(2);
    rmSync(h.transcript);
    await h.pump(400, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
  });

  it("no transcript checkpoint at all: today's outcome at once, labelled, with nothing to wait for", async () => {
    const h = await deliver({ noTranscript: true });
    await h.pump(5, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
  });

  it("a backend without a transcript the reconciler understands (grok) keeps today's outcome, labelled — no false ⚠️", async () => {
    const h = await deliver({ backend: dir => new GrokBackend(dir), backendName: "grok" });
    await h.pump(5, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
  });

  it("a stop while it waits leaves the row to restart reconciliation instead of finishing it", async () => {
    const h = await deliver();
    await h.begun();
    // Trip on the 2nd no-match, early in the window — under the ~10 s window a late fence proves nothing.
    for (let step = 0; step < 60 && lookHooks.done < 2; step++) await h.pump(1);
    expect(h.state()).toBe("submission_started");
    h.daemon.fenceDeliveryWritesForStop();
    appendFileSync(h.transcript, userEntry(h.deliveryId));
    await h.pump(80);
    expect(h.state()).toBe("submission_started");
  });

  it("…and it stops looking at the transcript", async () => {
    const h = await deliver();
    await h.begun();
    for (let step = 0; step < 60 && lookHooks.done < 2; step++) await h.pump(1);
    h.daemon.fenceDeliveryWritesForStop();
    await h.pump(2);
    const settled = h.looks();
    await h.pump(80);
    expect(h.looks()).toBe(settled);
  });

  it("a stop that lands while the look that finds the marker is in flight still leaves the row to reconciliation", async () => {
    const h = await deliver();
    await h.begun();
    // Install hook and slowRead BEFORE writing the marker so that the look
    // that finds the marker always goes through onLook. Writing the marker
    // first leaves a window where a look can find it hook-free (the race the
    // test exists to close). looksBeforeHook is captured before the hook so
    // any pre-hook look does not satisfy the post-hook predicate.
    lookHooks.slowRead = true;
    const looksBeforeHook = h.looks();
    let stopHookFired = false;
    lookHooks.onLook = () => { stopHookFired = true; h.daemon.fenceDeliveryWritesForStop(); };
    // Write the marker after the hook is in place.
    appendFileSync(h.transcript, userEntry(h.deliveryId));
    // Pump until a look fires AFTER the hook was installed.
    await h.pump(400, () => h.looks() > looksBeforeHook);
    // The stop hook must have run on the new look.
    expect(stopHookFired, "the stop hook must fire during a post-hook look").toBe(true);
    expect(h.looks()).toBeGreaterThan(looksBeforeHook);
    // Wait for proveDeliveryFromTranscript to actually return (scan + settlement path).
    // This is the true completion signal; spin counts cannot guarantee this.
    await h.proofSettled;
    // Drain any microtasks the proof continuation may have scheduled.
    for (let turn = 0; turn < 20; turn++) await ioTurn();
    expect(h.state()).toBe("submission_started");
  });

  it("a respawn while it waits ends the wait with today's outcome, labelled, rather than leaving the row open", async () => {
    const h = await deliver();
    await h.begun();
    // Trip on the 2nd no-match: the wait must exit at the next look, not poll to the end of the window.
    for (let step = 0; step < 60 && lookHooks.done < 2; step++) await h.pump(1);
    expect(h.state()).toBe("submission_started");
    h.daemon.spawnGeneration++;
    await h.pump(5, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
    expect(h.notices()).toBe(0);
    // …and it stops looking: no further transcript reads after the early exit.
    const settled = h.looks();
    await h.pump(40);
    expect(h.looks()).toBe(settled);
  });

  it("a marker that arrives only after the respawn exit is not claimed as this delivery's proof", async () => {
    const h = await deliver();
    await h.begun();
    for (let step = 0; step < 60 && lookHooks.done < 2; step++) await h.pump(1);
    expect(h.state()).toBe("submission_started");
    h.daemon.spawnGeneration++;
    await h.pump(3, h.finished);
    // The wait exited on the tripped epoch before any marker existed…
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
    // …so a marker filed afterwards belongs to the next generation, not this verdict.
    appendFileSync(h.transcript, userEntry(h.deliveryId));
    await h.pump(40, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
    expect(h.notices()).toBe(0);
  });

  it("a respawn during the final sleep still ends the wait with today's outcome, not uncertain", async () => {
    const h = await deliver();
    await h.begun();
    // 11 looks (polls 0..10), then the final sleep. Land the epoch trip after the last look's fence check,
    // while that sleep is still in flight: the row must not settle `uncertain` for a generation that is gone.
    for (let step = 0; step < 60 && lookHooks.done < 11; step++) await h.pump(1);
    expect(lookHooks.done).toBe(11);
    expect(h.state()).toBe("submission_started");
    h.daemon.spawnGeneration++;
    await h.pump(400, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
    expect(h.notices()).toBe(0);
  });

  it("a pause/freeze during the final sleep does the same", async () => {
    const h = await deliver();
    await h.begun();
    for (let step = 0; step < 60 && lookHooks.done < 11; step++) await h.pump(1);
    expect(lookHooks.done).toBe(11);
    expect(h.state()).toBe("submission_started");
    h.daemon.launchFenceEpoch++;
    await h.pump(400, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
    expect(h.notices()).toBe(0);
  });

  it("a persistence failure at settlement is logged and leaves the row for reconciliation — no rejection, no false completion, no re-paste", async () => {
    const h = await deliver();
    await h.begun();
    const offset = statSync(h.transcript).size;
    appendFileSync(h.transcript, userEntry(h.deliveryId));
    const attemptNo = h.outbox.get(h.deliveryId)!.attemptNo;
    const errors: unknown[] = [];
    h.daemon.logger = { info() {}, warn() {}, error(e: unknown) { errors.push(e); }, debug() {}, child() { return this; } } as any;
    const pastesBefore = h.tmux.pasteBuffer.mock.calls.length;
    vi.spyOn(h.outbox, "complete").mockImplementation(() => { throw new Error("SQLITE_FULL: database or disk is full"); });
    vi.useRealTimers();
    // The detached `void` promise must resolve, never reject: a rejection escapes into an unhandledRejection fault.
    await expect(h.daemon.proveDeliveryFromTranscript(
      { deliveryId: h.deliveryId, attemptNo },
      { backend: "claude-code", path: h.transcript, offset },
    )).resolves.toBeUndefined();
    expect(h.state()).toBe("submission_started");
    expect(h.evidence()).toBeNull();
    expect(errors).toHaveLength(1);
    expect(h.notices()).toBe(0);
    expect(h.tmux.pasteBuffer.mock.calls.length).toBe(pastesBefore);
  });

  it("the failure path is bounded: with no marker the wait settles uncertain after ~10 s, not a minute", async () => {
    const h = await deliver();
    await h.begun();
    // 11 looks (polls 0..10 at 1 s), then the verdict — a lost paste holds the lane for ~10 s, not 60 s.
    await h.pump(9);
    expect(h.state()).toBe("submission_started");
    await h.pump(20, h.finished);
    expect(h.state()).toBe("uncertain");
    expect(h.evidence()).toBe("unverifiable-no-transcript-marker");
    expect(h.looks()).toBeLessThanOrEqual(12);
    expect(h.notices()).toBe(1);
  });

  it("the pane lock is free while the row waits for its transcript", async () => {
    const h = await deliver();
    await h.pump(5);
    expect(h.state()).toBe("submission_started");
    let released = false;
    void h.daemon.pasteLock.then(() => { released = true; });
    await h.pump(1);
    expect(released).toBe(true);
    expect(h.state()).toBe("submission_started");
  });
});

describe("what it does not touch", () => {
  it("Codex (input row readable) whose message is on the pane keeps its pane proof: `positive submission proof`, no transcript wait", async () => {
    const echoed = CODEX_READY.replace("› Ask Codex to do anything", "  [from:source] hello\n  (message_id: message-758 | correlation_id: c)\n\n› Ask Codex to do anything");
    const h = await deliver({ backend: dir => new CodexBackend(dir), backendName: "codex", pane: CODEX_READY, paneAfterPaste: echoed });
    await h.pump(10, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("positive submission proof");
  });

  it("a raw paste (a slash command, no delivery marker in its text) is not held to a transcript marker it can never carry", async () => {
    const h = await deliver({ raw: true });
    await h.pump(10, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("positive submission proof");
  });

  it("a steer into the ready readerless pane keeps its pre-#758 settlement: delivered, positive submission proof, no transcript wait", async () => {
    const h = await deliver({ steer: true });
    await h.begun();
    await h.pump(10, h.finished);
    await h.settleSteer();
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("positive submission proof");
    expect(h.notices()).toBe(0);
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
    expect(h.looks()).toBe(0);
  });

  it("a steer with no transcript marker at all settles the same (the control the old rule would hold to uncertain)", async () => {
    const h = await deliver({ steer: true });
    await h.begun();
    // No marker is ever filed: without the steer exclusion this would wait the whole window and settle `uncertain`.
    await h.pump(400, h.finished);
    await h.settleSteer();
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("positive submission proof");
    expect(h.notices()).toBe(0);
  });

  it("Codex (input row readable) keeps its own verdict: a vanished paste is uncertain at the post-submit proof, no transcript involved", async () => {
    const h = await deliver({ backend: dir => new CodexBackend(dir), backendName: "codex", pane: CODEX_READY, transcriptBefore: () => "" });
    await h.pump(60, h.finished);
    expect(h.state()).toBe("uncertain");
    expect(h.evidence()).toBe("post-submit-proof:unproven");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  });
});
