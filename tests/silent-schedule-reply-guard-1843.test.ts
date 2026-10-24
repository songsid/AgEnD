import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";

vi.mock("../src/backend/types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend/types.js")>(),
  resolveBinary: (name: string) => name,
}));

const logger = pino({ level: "silent" });
const cleanups: Array<() => void> = [];
const READY = readFileSync(join(import.meta.dirname, "fixtures/reply-guard-1510/codex-0.162.0/frames/tool-idle.txt"), "utf8");
const HUMAN = "Please check this project";
const HEARTBEAT = "Check the task board; stay silent when nothing needs attention.";
const RETIRE_LOG = "Reply guard retired before silent schedule write";
const meta = { chat_id: "guild", thread_id: "channel", adapter_id: "discord", message_id: "m-human", correlation_id: "cid-human" };
type Proof = "submitted" | "stranded" | "unproven";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T00:00:00Z")); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
});

/** Real admission -> FleetManager dispatch -> raw IPC -> Daemon paste/proof/guard. All operational IO is inert. */
function harness(proof: Proof = "stranded", silent = true, busy = false) {
  const root = mkdtempSync(join(tmpdir(), "agend-silent-1843-"));
  const instanceDir = join(root, "worker");
  mkdirSync(instanceDir);
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const outbox = new DeliveryOutbox(join(root, "outbox.db"), "manager-test");
  const backend = new CodexBackend(instanceDir);
  const info = vi.spyOn(logger, "info");
  const daemon: any = new Daemon("worker", {
    backend: "codex", working_directory: root, reply_completion_guard: true, log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { max_age_hours: 0, grace_period_ms: 600_000 },
  } as any, instanceDir, false, backend, {
    getObservationResetAt: () => 0, getLastOutputAt: () => undefined,
    isIdle: () => !busy, waitUntilIdle: vi.fn(async () => true), hasOutputSince: () => true,
  } as any, logger);
  daemon.setDeliveryOutboxPort(outbox);
  const tmux = {
    capturePane: vi.fn(async () => READY),
    capturePaneWithHistory: vi.fn(async () => READY),
    pasteBuffer: vi.fn(async (_text: string) => true), sendSpecialKey: vi.fn(async () => true),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: () => true, getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  // Constructor only: no daemon/manager start, listeners, CLI, service, or tmux server.
  const spawning = ["wake", "start", "stop", "pause", "spawnClaudeWindow", "recoverWindow"]
    .map(name => vi.spyOn(daemon, name).mockResolvedValue(undefined));
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue(busy ? "busy" : "ready");
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(true);
  vi.spyOn(daemon, "confirmAfterEnter").mockResolvedValue(false);
  const lateProof = vi.spyOn(daemon, "lateCodexSubmissionProof").mockResolvedValue(proof);
  vi.spyOn(daemon, "confirmSubmitted").mockResolvedValue(proof);
  vi.spyOn(daemon, "mcpServerAlive").mockReturnValue({ alive: true, source: "connection" });
  const broadcast = vi.fn((msg: any) => {
    if (msg.fleetRequestId) daemon.pendingIpcRequests.get(msg.fleetRequestId)?.({ result: {} });
  });
  daemon.ipcServer = { broadcast, send: vi.fn(() => true) };
  const detected = vi.fn(), unrecovered = vi.fn();
  daemon.on("reply_drop_detected", detected);
  daemon.on("reply_drop_unrecovered", unrecovered);
  let humanSeq = 0;
  function humanTurn() {
    daemon.pendingWork.recordInbound();
    daemon.markTurnStarted(meta, HUMAN);
    const id = `human-${++humanSeq}`;
    daemon.transcriptTurns.observe([
      { kind: "start", turnId: id }, { kind: "user", turnId: id, text: HUMAN, at: Date.now() },
      { kind: "end", turnId: id, end: "complete" },
    ]);
    expect(daemon.turnReplyGuard.snapshot()).toMatchObject({ target: { deliveredText: HUMAN } });
  }
  // The field failure inherits an older human turn, not an empty guard.
  humanTurn();
  daemon.turnReplyGuard.noteTurnActivity();
  daemon.armReplyGuardConfirm(daemon.turnReplyGuard.snapshot().generation);
  const row = outbox.admit({
    operationId: "schedule:heartbeat:run", sourceKey: silent ? "schedule:heartbeat:run:worker:raw_paste" : "command:raw:worker",
    sourceInstance: "fleet", sourceDaemonBootId: "manager-test", targetInstance: "worker", kind: "raw_paste",
    payload: { type: "raw_paste", content: HEARTBEAT },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const manager: any = Object.create(FleetManager.prototype);
  manager.deliveryOutbox = outbox;
  manager.logger = logger;
  manager.deliveryWorkerMode = () => "off";
  manager.deliverToInstance = vi.fn(async (_target: string, message: Record<string, unknown>) => {
    daemon.handleRawPasteIpcMessage(message);
    return true;
  });
  cleanups.push(() => {
    daemon.clearReplyGuardConfirm(); daemon.fenceDeliveryWritesForStop();
    outbox.close(); rmSync(root, { recursive: true, force: true });
  });
  const dispatch = () => manager.dispatchDurableDelivery(claimed);
  async function run() {
    const handoff = dispatch();
    await vi.advanceTimersByTimeAsync(5_000);
    await daemon.pasteLock; await handoff;
    // wake itself is an inert stub; no other lifecycle handler may run.
    for (const spawn of spawning.slice(1)) expect(spawn).not.toHaveBeenCalled();
  }
  const delivery = vi.spyOn(daemon, "deliverMessage");
  async function endTurn() {
    // The raw attempt above stays real. Recovery prompts are inert once the guard starts them.
    delivery.mockResolvedValue(true);
    const state = (name: string) => ({ state: name, unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() });
    daemon.applyInstanceStateSnapshot(state("working"), "working");
    daemon.applyInstanceStateSnapshot(state("idle"), READY);
    await vi.advanceTimersByTimeAsync(61_000);
    daemon.applyInstanceStateSnapshot(state("idle"), READY);
    await daemon.pasteLock;
  }
  const replies = () => broadcast.mock.calls.filter(([msg]) => msg.type === "fleet_outbound" && msg.tool === "reply");
  const recovery = () => delivery.mock.calls.filter(args => String(args[0]).startsWith("[system:reply-required]"));
  const interruptedHuman = () => existsSync(join(instanceDir, "in-flight-turn.json"));
  const retirements = () => info.mock.calls.filter(args => args[1] === RETIRE_LOG).map(args => args[0]);
  return { daemon, manager, tmux, outbox, row, dispatch, run, endTurn, humanTurn, detected, unrecovered, replies, recovery, lateProof, interruptedHuman, retirements };
}

describe("#1843 silent-schedule attribution does not depend on submission proof", () => {
  it.each<Proof>(["submitted", "unproven", "stranded"])("%s: silent write closes the preceding human guard with a trace before proof", async proof => {
    const h = harness(proof);
    await h.run();
    expect(h.outbox.get(h.row.deliveryId)?.state, JSON.stringify(h.outbox.get(h.row.deliveryId))).toBe(proof === "submitted" ? "delivered" : "uncertain");
    if (proof !== "submitted") expect(h.outbox.get(h.row.deliveryId)?.lastError).toBe(`post-submit-proof:${proof}`);
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
    expect(h.daemon.replyGuardIdleConfirm).toBeNull();
    expect(h.retirements()).toEqual([expect.objectContaining({
      correlationId: "cid-human", generation: 1, phase: "awaiting", reason: "silent_schedule_delivery", deliveryId: h.row.deliveryId,
    })]);
    await h.endTurn();
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expect(h.interruptedHuman()).toBe(false);
    expect(h.daemon.replyGuardIdleConfirm).toBeNull();
    expect(h.detected).not.toHaveBeenCalled();
    expect(h.unrecovered).not.toHaveBeenCalled();
    expect(h.replies()).toEqual([]);
    expect(h.recovery()).toEqual([]);
  });

  it("also suppresses the guard while the post-submit proof is still pending", async () => {
    const h = harness();
    let release!: (proof: Proof) => void;
    h.lateProof.mockImplementation(() => new Promise<Proof>(resolve => { release = resolve; }));
    const run = h.run();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(release).toBeTypeOf("function");
    const duringProof = h.daemon.turnReplyGuard.snapshot();
    release("stranded"); await run;
    expect(duringProof).toBeNull();
    await h.endTurn();
    expect(h.detected).not.toHaveBeenCalled();
    expect(h.replies()).toEqual([]);
  });

  it("a non-silent raw delivery retains normal human reply recovery", async () => {
    const h = harness("stranded", false);
    await h.run(); await h.endTurn();
    expect(h.detected).toHaveBeenCalledTimes(1);
    expect(h.replies()).toHaveLength(0);
    expect(h.recovery()).toHaveLength(1);
    expect(h.retirements()).toEqual([]);
  });

  it("a silent native-queue handoff cannot lend its later idle edge to the old human turn", async () => {
    const h = harness("stranded", true, true);
    await h.run();
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.outbox.get(h.row.deliveryId)?.state).toBe("uncertain");
    await h.endTurn();
    expect(h.detected).not.toHaveBeenCalled();
    expect(h.replies()).toEqual([]);
    expect(h.recovery()).toEqual([]);
  });

  it("an unknown paste result still retains the admitted silent attribution", async () => {
    const h = harness();
    h.tmux.pasteBuffer.mockRejectedValueOnce(new Error("private simulated paste transport loss"));
    await h.run();
    expect(h.outbox.get(h.row.deliveryId)?.state).toBe("uncertain");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    await h.endTurn();
    expect(h.detected).not.toHaveBeenCalled();
    expect(h.replies()).toEqual([]);
  });

  it("a subsequent human turn arms and recovers normally", async () => {
    const h = harness();
    await h.run(); await h.endTurn();
    expect(h.detected).not.toHaveBeenCalled();
    h.humanTurn(); await h.endTurn();
    expect(h.detected).toHaveBeenCalledTimes(1);
    expect(h.replies()).toHaveLength(0);
    expect(h.recovery()).toHaveLength(1);
  });

  it("a stop before the raw write preserves the existing human obligation", async () => {
    const h = harness();
    h.daemon.fenceDeliveryWritesForStop();
    await h.run();
    expect(h.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(h.daemon.turnReplyGuard.snapshot()).toMatchObject({ target: { deliveredText: HUMAN } });
    expect(h.interruptedHuman()).toBe(true);
    expect(h.retirements()).toEqual([]);
  });

  it("a recovering human guard cannot inject its queued recovery prompt into the silent work", async () => {
    const h = harness();
    let release!: () => void;
    h.daemon.pasteLock = new Promise<void>(resolve => { release = resolve; });
    // Silent work is queued first; before it writes, the old human turn enters recovery.
    const handoff = h.dispatch();
    h.daemon.startReplyRecovery(h.daemon.turnReplyGuard.snapshot(), "no_valid_call");
    expect(h.daemon.turnReplyGuard.snapshot()).toMatchObject({ phase: "recovering" });
    expect(h.replies()).toHaveLength(0); // detection is log-only, even before the silent write
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    await h.daemon.pasteLock; await handoff;
    expect(h.outbox.get(h.row.deliveryId)?.state).toBe("uncertain");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
    expect(h.recovery()).toEqual([]);
    expect(h.replies()).toHaveLength(0); // no warning for a retired recovery
    expect(h.unrecovered).not.toHaveBeenCalled();
    expect(h.retirements()).toEqual([expect.objectContaining({
      correlationId: "cid-human", generation: 1, phase: "recovering", reason: "silent_schedule_delivery", deliveryId: h.row.deliveryId,
    })]);
  });
});
