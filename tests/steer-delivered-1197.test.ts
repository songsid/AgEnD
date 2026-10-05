import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { transcriptDeltaHasDeliveryMarker } from "../src/delivery-reconciliation.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

/**
 * #1197: a durable steer into a BUSY pane of a CLI whose input row cannot be read (claude-code, grok, muse) always ended
 * `uncertain` ("best-effort-submission:unverified"): such a backend proves an ordinary submission by the idle→busy edge, and a
 * steer goes into a pane that is already busy. The operator got a ⚠️ and the sender a [system:delivery-outcome] for a steer
 * that had landed. Now the steer is `delivered` — labelled as ACCEPTED into the live turn's input, not as read — when the
 * delivery's own trusted marker is on a fresh capture after the one Enter, beyond the pre-paste baseline, with no dialog and
 * the spawn and window unchanged. Everything else keeps its old outcome. Real Daemon, real DeliveryOutbox, stub tmux serving
 * scripted panes; nothing starts a CLI or a tmux server.
 */
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const BUSY = readFileSync(join(__dirname, "fixtures", "claude-2.1.287-busy.pane.txt"), "utf8");
const MARKER_ROWS = "\n❯ [STEERING — mid-task course correction.]\n(message_id: message-1197)";
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

interface Opts {
  backend?: any;
  /** What the pane shows on each capture; `pasted` is true once the paste has been written. */
  pane?: (state: { pasted: boolean; captures: number; daemon: any }) => string;
  enterOk?: boolean;
  dialogOnVerify?: boolean;
  windowAfterPaste?: string;
}

async function steer(opts: Opts = {}) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-1197-")); roots.push(root);
  const instanceDir = join(root, "instances", "worker");
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, (opts.backend ?? new ClaudeCodeBackend(instanceDir)) as any,
  { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false, waitUntilIdle: vi.fn(async () => true) } as any, logger);
  daemon.setDeliveryOutboxPort(outbox);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const row = outbox.admit({
    operationId: "op", sourceKey: "s:op:w:steer", sourceInstance: "source", sourceDaemonBootId: "sb",
    targetInstance: "worker", kind: "steer", payload: { type: "steer", content: "hello", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const state = { pasted: false, captures: 0, daemon };
  const tmux = {
    capturePane: vi.fn(async () => {
      state.captures++;
      return opts.pane ? opts.pane(state) : (state.pasted ? `${BUSY}${MARKER_ROWS}` : BUSY);
    }),
    pasteBuffer: vi.fn(async () => { state.pasted = true; if (opts.windowAfterPaste) writeFileSync(join(instanceDir, "window-id"), opts.windowAfterPaste); return true; }),
    sendSpecialKey: vi.fn(async () => opts.enterOk !== false),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  const clear = { state: "clear" } as const;
  const dialog = { state: "dialog", dialog: { description: "a dialog" } } as any;
  // the hand-off gate asks first and the pre-write check second (both must be clear); the acceptance check asks after the Enter
  const probe = vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValueOnce(clear).mockResolvedValueOnce(clear)
    .mockResolvedValue(opts.dialogOnVerify ? dialog : clear);
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  const confirmed = vi.fn(); daemon.on("message_confirmed", confirmed);
  const meta = {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: "message-1197", chat_id: "", thread_id: "", ts: new Date().toISOString(),
  };
  daemon.steerMessage("hello", meta);
  await vi.runAllTimersAsync();
  await daemon.steerLock;
  const db = (outbox as any).db;
  const result = {
    daemon, outbox, tmux, confirmed, probe, meta, row,
    delivery: outbox.get(row.deliveryId)!,
    attempt: db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id=?").get(row.deliveryId),
    notices: db.prepare("SELECT COUNT(*) AS n FROM failure_notices").get().n as number,
  };
  return result;
}

describe("a steer into a busy pane of a CLI whose input row is unreadable", () => {
  it("is delivered, labelled as accepted-not-read, with no failure notice", async () => {
    const r = await steer();
    expect(r.delivery.state).toBe("delivered");
    expect(r.attempt.evidence).toBe("steer-accepted-marker-on-pane; input-row-unreadable");
    expect(r.attempt.submission_mode).toBe("steer");
    expect(r.notices).toBe(0);                                  // no [system:delivery-outcome] to the sender, no fleet ⚠️ (that listens for failed/uncertain)
    expect(r.tmux.pasteBuffer).toHaveBeenCalledOnce();           // one paste…
    expect(r.tmux.sendSpecialKey).toHaveBeenCalledOnce();        // …one Enter
    r.outbox.close();
  });

  it("is NOT delivered when its marker never reaches the pane", async () => {
    const r = await steer({ pane: () => BUSY });
    expect(r.delivery.state).not.toBe("delivered");
    expect(String(r.attempt?.evidence ?? "")).not.toContain("steer-accepted");
    r.outbox.close();
  });

  it("is NOT delivered when the marker is no more frequent than it was before the paste", async () => {
    const already = `${BUSY}${MARKER_ROWS}`;
    const r = await steer({ pane: () => already });               // the same single occurrence before and after
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("best-effort-submission:unverified");
    r.outbox.close();
  });

  it("is NOT delivered when a blocking dialog owns the pane after the Enter", async () => {
    const r = await steer({ dialogOnVerify: true });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("best-effort-submission:unverified");
    r.outbox.close();
  });

  it("is NOT delivered when the Enter could not be sent", async () => {
    const r = await steer({ enterOk: false });
    expect(r.delivery.state).not.toBe("delivered");
    r.outbox.close();
  });

  it("is NOT delivered when a new spawn began while the evidence was being read", async () => {
    const r = await steer({
      pane: ({ pasted, captures, daemon }) => {
        if (pasted && captures >= 2) daemon.spawnGeneration += 1;       // the pane changed hands between the paste and the acceptance check
        return pasted ? `${BUSY}${MARKER_ROWS}` : BUSY;
      },
    });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("best-effort-submission:unverified");
    r.outbox.close();
  });

  it("is NOT delivered when the window changed after the paste", async () => {
    const r = await steer({ windowAfterPaste: "@someone-else" });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("best-effort-submission:unverified");
    r.outbox.close();
  });

  it("an id quoted in the body is not evidence: only the trusted metadata id counts", async () => {
    const r = await steer({ pane: ({ pasted }) => (pasted ? `${BUSY}\n❯ [STEERING]\n(message_id: some-other-id)` : BUSY) });
    expect(r.delivery.state).not.toBe("delivered");
    r.outbox.close();
  });
});

describe("what does not change", () => {
  it("a backend that CAN read its input row keeps its own proofs (an unrecognised Codex layout stays uncertain, never steer-accepted)", async () => {
    const backend = Object.assign(new ClaudeCodeBackend("/tmp/x"), {
      isDeliveryInputReadyPane: () => false,        // "a Codex layout whose frame cannot be trusted"
      getBottomReadyPattern: () => /^›/,
      getBusyPattern: () => /never-matches-this/,
    });
    const r = await steer({ backend });
    expect(r.delivery.state).not.toBe("delivered");
    expect(String(r.attempt?.evidence ?? "")).not.toContain("steer-accepted");
    r.outbox.close();
  });
});

describe("the steer's delivery marker leads the persisted message (restart reconciliation can prove a steer)", () => {
  async function formattedFor(meta: Record<string, string>) {
    const daemon: any = new Daemon("w", {
      working_directory: tmpdir(), log_level: "error",
      restart_policy: { max_retries: 1, backoff: "linear", reset_after: 1 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, join(tmpdir(), "agend-1197-fmt"), false, new ClaudeCodeBackend("/tmp/x") as any, undefined, logger);
    const seen: string[] = [];
    daemon.deliverMessage = vi.fn(async (formatted: string) => { seen.push(formatted); return true; });
    daemon.wake = vi.fn(async () => {});
    daemon.tmux = {};
    daemon.steerMessage("hello", meta);
    await daemon.steerLock;
    return seen[0]!;
  }
  const base = { from_instance: "source", user: "instance:source", user_id: "instance:source", message_id: "m-1", chat_id: "", thread_id: "" };

  it("marker first, then the banner, then the normal envelope", async () => {
    const text = await formattedFor({ ...base, delivery_id: "d-1197", delivery_attempt: "1" });
    expect(text.startsWith("[agend-delivery-id:d-1197]\n[STEERING — mid-task")).toBe(true);
    expect(text).toContain("(message_id: m-1)");
  });

  it("a transcript user entry holding it is found by the same matcher restart reconciliation uses", async () => {
    const text = await formattedFor({ ...base, delivery_id: "d-1197", delivery_attempt: "1" });
    const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    expect(transcriptDeltaHasDeliveryMarker(`${line}\n`, "claude-code", "d-1197")).toBe(true);
    expect(transcriptDeltaHasDeliveryMarker(`${line}\n`, "claude-code", "another-delivery")).toBe(false);
  });

  it("with the OLD order (banner in front) the same matcher misses it — the bug this fixes", () => {
    const old = `[STEERING — mid-task course correction.]\n[agend-delivery-id:d-1197]\n[from:source] hello`;
    const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: old }] } });
    expect(transcriptDeltaHasDeliveryMarker(`${line}\n`, "claude-code", "d-1197")).toBe(false);
  });

  it("a steer that is not a durable delivery keeps the banner first (no marker to lead)", async () => {
    const text = await formattedFor({ ...base });
    expect(text.startsWith("[STEERING — mid-task")).toBe(true);
    expect(text).not.toContain("agend-delivery-id");
  });
});
