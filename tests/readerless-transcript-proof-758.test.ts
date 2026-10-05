import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
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
const lookHooks = vi.hoisted(() => ({ onLook: null as null | ((count: number) => void), looks: 0, done: 0 }));
vi.mock("../src/delivery-reconciliation.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/delivery-reconciliation.js")>();
  return {
    ...real,
    scanTranscriptForDeliveryMarker: async (...args: Parameters<typeof real.scanTranscriptForDeliveryMarker>) => {
      lookHooks.looks++;
      lookHooks.onLook?.(lookHooks.looks);
      try { return await real.scanTranscriptForDeliveryMarker(...args); } finally { lookHooks.done++; }
    },
  };
});

const realSetImmediate = setImmediate;
const roots: string[] = [];
afterEach(() => { lookHooks.onLook = null; lookHooks.looks = 0; lookHooks.done = 0; vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
  }, instanceDir, false, (opts.backend ? opts.backend(instanceDir) : new ClaudeCodeBackend(instanceDir)) as any,
  // The pane printed something after Enter (the redraw) — the legacy proof — and nothing in it is ours.
  { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true, waitUntilIdle: vi.fn(async () => true), hasOutputSince: () => true } as any, logger);
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
  if (opts.raw) {
    daemon.queueRawPaste("/compact", daemon.deliveryEpoch, false, { deliveryId: row.deliveryId, attemptNo: claimed.attemptNo, submissionMode: "raw_paste" });
  } else {
    daemon.pushChannelMessage("hello", {
      delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
      user: "instance:source", user_id: "instance:source", message_id: "message-758", chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
    });
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
  return { daemon, outbox, tmux, confirmed, transcript, deliveryId: row.deliveryId, state, evidence, pump, finished, begun };
}

describe("a readerless backend's idle delivery is proven by its transcript, not by the pane printing something (#758)", () => {
  it("the paste was wiped and the pane only redrew: the ✅ stays, but the row is uncertain once the whole window passed without the marker", async () => {
    const h = await deliver();
    await h.begun();
    await h.pump(30);
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
    await h.pump(20);
    expect(h.state()).toBe("submission_started");
    await h.begun();
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
    await h.pump(10);
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
    await h.pump(10);
    h.daemon.fenceDeliveryWritesForStop();
    appendFileSync(h.transcript, userEntry(h.deliveryId));
    await h.pump(80);
    expect(h.state()).toBe("submission_started");
  });

  it("…and it stops looking at the transcript", async () => {
    const h = await deliver();
    await h.begun();
    await h.pump(10);
    h.daemon.fenceDeliveryWritesForStop();
    await h.pump(2);
    const settled = lookHooks.looks;
    await h.pump(80);
    expect(lookHooks.looks).toBe(settled);
  });

  it("a stop that lands while the look that finds the marker is in flight still leaves the row to reconciliation", async () => {
    const h = await deliver();
    await h.begun();
    appendFileSync(h.transcript, userEntry(h.deliveryId));
    lookHooks.onLook = () => { h.daemon.fenceDeliveryWritesForStop(); };
    await h.pump(80);
    expect(lookHooks.looks).toBeGreaterThan(0);
    expect(h.state()).toBe("submission_started");
  });

  it("a respawn while it waits ends the wait with today's outcome, labelled, rather than leaving the row open", async () => {
    const h = await deliver();
    await h.begun();
    await h.pump(10);
    h.daemon.spawnGeneration++;
    await h.pump(400, h.finished);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("output-edge-only; submission-unverifiable");
  });

  it("the pane lock is free while the row waits for its transcript, so the next delivery is not held up", async () => {
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

  it("Codex (input row readable) keeps its own verdict: a vanished paste is uncertain at the post-submit proof, no transcript involved", async () => {
    const h = await deliver({ backend: dir => new CodexBackend(dir), backendName: "codex", pane: CODEX_READY, transcriptBefore: () => "" });
    await h.pump(60, h.finished);
    expect(h.state()).toBe("uncertain");
    expect(h.evidence()).toBe("post-submit-proof:unproven");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  });
});
