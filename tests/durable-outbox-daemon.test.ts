import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { reconcileTargetBeforeStart } from "../src/delivery-reconciliation.js";
import { FleetManager } from "../src/fleet-manager.js";
import { TmuxManager } from "../src/tmux-manager.js";

const roots: string[] = [];
const rootLogger = pino({ level: "silent" });

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHarness(controlClient?: object) {
  const root = mkdtempSync(join(tmpdir(), "agend-outbox-daemon-"));
  roots.push(root);
  const instanceDir = join(root, "instances", "worker");
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const daemon = new Daemon(
    "worker",
    {
      working_directory: root,
      log_level: "error",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    },
    instanceDir,
    false,
    undefined,
    controlClient as any,
    rootLogger as any,
  );
  daemon.setDeliveryOutboxPort(outbox);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const row = outbox.admit({
    operationId: "op-daemon",
    sourceKey: "source:op-daemon:worker:fleet_inbound",
    sourceInstance: "source",
    sourceDaemonBootId: "source-boot",
    targetInstance: "worker",
    kind: "fleet_inbound",
    payload: { type: "fleet_inbound", content: "hello", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const pasteBuffer = vi.fn().mockResolvedValue(true);
  const tmux = {
    capturePane: vi.fn().mockResolvedValue("❯"),
    pasteBuffer,
    sendSpecialKey: vi.fn().mockResolvedValue(true),
    getLastPasteError: vi.fn((): string | undefined => undefined),
    isLastPasteFailureRecoverable: vi.fn(() => true),
  };
  (daemon as any).tmux = tmux;
  vi.spyOn(daemon as any, "sendDeliveryEnter").mockResolvedValue(true);
  return { root, outbox, daemon, row, claimed, tmux };
}

function deliveryMeta(deliveryId: string, attemptNo: number): Record<string, string> {
  return {
    delivery_id: deliveryId,
    delivery_attempt: String(attemptNo),
    from_instance: "source",
    correlation_id: "corr-daemon",
    user: "instance:source",
    user_id: "instance:source",
    message_id: "message-daemon",
    chat_id: "",
    thread_id: "",
    ts: new Date().toISOString(),
  };
}

describe("durable delivery through a real Daemon", () => {
  it("commits enter_started before tmux can accept the Enter key", async () => {
    const h = makeHarness();
    const evidence = {
      backend: "codex",
      windowId: "@worker",
      transcriptPath: null,
      transcriptOffset: null,
      transcriptSessionId: null,
      submissionMode: "idle_submit" as const,
    };
    expect(h.outbox.begin(h.row.deliveryId, h.daemon.bootId, h.claimed.attemptNo, evidence)).toBe("begun");
    (h.daemon as any).sendDeliveryEnter.mockRestore();
    const sendSpecialKey = vi.fn(async () => {
      const started = (h.outbox as any).db.prepare(
        "SELECT enter_started_at FROM delivery_attempts WHERE delivery_id=?",
      ).get(h.row.deliveryId).enter_started_at;
      expect(started).toBeTruthy();
      return true;
    });
    h.tmux.sendSpecialKey = sendSpecialKey;

    expect(await (h.daemon as any).sendDeliveryEnter("initial-submit", undefined, {
      deliveryId: h.row.deliveryId,
      attemptNo: h.claimed.attemptNo,
    })).toBe(true);
    expect(sendSpecialKey).toHaveBeenCalledOnce();
    h.outbox.close();
  });

  it("requires a committed begin permit before the actual paste and records the delivered ACK", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const meta = deliveryMeta(h.row.deliveryId, h.claimed.attemptNo);

    h.daemon.pushChannelMessage("hello", meta);
    await vi.runAllTimersAsync();
    await (h.daemon as any).pasteLock;

    expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "delivered", attemptNo: 1 });
    h.outbox.close();
  });

  it("persists an unknown queue-resume contract on a real Codex native-queue handoff", async () => {
    vi.useFakeTimers();
    const h = makeHarness({});
    const daemon = h.daemon as any;
    daemon.backend = { binaryName: "codex", supportsQueuedInput: () => true };
    daemon.controlClient = {};
    vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
    vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
    vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
    vi.spyOn(daemon, "capturePaneEvidence").mockResolvedValue({ captured: true });
    vi.spyOn(daemon, "confirmSubmitted").mockResolvedValue("submitted");

    h.daemon.pushChannelMessage("hello", deliveryMeta(h.row.deliveryId, h.claimed.attemptNo));
    await vi.runAllTimersAsync();
    await daemon.pasteLock;

    expect(h.outbox.get(h.row.deliveryId)?.state).toBe("delivered");
    expect((h.outbox as any).db.prepare(`
      SELECT backend,backend_version,submission_mode,queue_resume_policy
      FROM delivery_attempts WHERE delivery_id=? AND attempt_no=?
    `).get(h.row.deliveryId, h.claimed.attemptNo)).toEqual({
      backend: "codex",
      backend_version: null,
      submission_mode: "native_queue_handoff",
      queue_resume_policy: "unknown",
    });
    h.outbox.close();
  });

  it("keeps a readiness timeout before the pane write retryable without emitting terminal failure", async () => {
    const h = makeHarness({});
    let resolveIdle!: (ready: boolean) => void;
    const idle = new Promise<boolean>(resolve => { resolveIdle = resolve; });
    vi.spyOn(h.daemon as any, "paneReadinessForDelivery").mockResolvedValue("busy");
    vi.spyOn(h.daemon as any, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
    vi.spyOn(h.daemon as any, "hasPositiveDeliveryInput").mockResolvedValue(true);
    const waitForReady = vi.spyOn(h.daemon as any, "waitForPaneReadyForDelivery").mockReturnValue(idle);
    const failed = vi.fn();
    h.daemon.on("message_failed", failed);

    h.daemon.pushChannelMessage("hello", deliveryMeta(h.row.deliveryId, h.claimed.attemptNo));
    for (let i = 0; i < 20 && waitForReady.mock.calls.length === 0; i++) await Promise.resolve();
    expect(waitForReady).toHaveBeenCalledOnce();
    expect(h.outbox.get(h.row.deliveryId)?.state).toBe("delivering");
    expect(h.tmux.pasteBuffer).not.toHaveBeenCalled();

    resolveIdle(false);
    await (h.daemon as any).pasteLock;
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait", attemptNo: 1 });
    expect(h.outbox.get(h.row.deliveryId)?.nextAttemptAt).not.toBeNull();
    expect(failed).not.toHaveBeenCalled();
    h.outbox.close();
  });

  it("does not paste when the outbox refuses the begin permit", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.daemon.setDeliveryOutboxPort({
      begin: vi.fn(() => "stale" as const),
      markEnterStarted: (id, boot, attempt) => h.outbox.markEnterStarted(id, boot, attempt),
      abort: (id, boot, attempt, reason) => h.outbox.abort(id, boot, attempt, reason),
      complete: (id, boot, attempt, outcome, evidence) => h.outbox.complete(id, boot, attempt, outcome, evidence),
      retryBeforeBegin: (id, boot, attempt, reason, delay) => h.outbox.retryBeforeBegin(id, boot, attempt, reason, delay),
    });

    h.daemon.pushChannelMessage("hello", deliveryMeta(h.row.deliveryId, h.claimed.attemptNo));
    await vi.runAllTimersAsync();
    await (h.daemon as any).pasteLock;

    expect(h.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait", attemptNo: 1 });
    h.outbox.close();
  });

  it("aborts a committed begin when paste throws before a pane write", async () => {
    const h = makeHarness();
    h.tmux.pasteBuffer.mockRejectedValueOnce(new Error("tmux buffer write failed before paste"));
    const failed = vi.fn();
    h.daemon.on("message_failed", failed);

    h.daemon.pushChannelMessage("hello", deliveryMeta(h.row.deliveryId, h.claimed.attemptNo));
    await (h.daemon as any).pasteLock;

    expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait", attemptNo: 1 });
    expect(h.outbox.get(h.row.deliveryId)?.nextAttemptAt).not.toBeNull();
    expect((h.outbox as any).db.prepare(
      "SELECT state FROM delivery_attempts WHERE delivery_id=? AND attempt_no=?",
    ).get(h.row.deliveryId, h.claimed.attemptNo)).toMatchObject({ state: "aborted" });
    expect(failed).not.toHaveBeenCalled();
    h.outbox.close();
  });

  it("aborts a committed begin when queued pane writing returns false before paste", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.tmux.pasteBuffer.mockResolvedValueOnce(false);
    h.tmux.getLastPasteError.mockReturnValue("window disappeared before paste");
    h.tmux.isLastPasteFailureRecoverable.mockReturnValue(false);

    h.daemon.pushChannelMessage("hello", deliveryMeta(h.row.deliveryId, h.claimed.attemptNo));
    await vi.runAllTimersAsync();
    await (h.daemon as any).pasteLock;

    expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait", attemptNo: 1 });
    expect((h.outbox as any).db.prepare(
      "SELECT state FROM delivery_attempts WHERE delivery_id=? AND attempt_no=?",
    ).get(h.row.deliveryId, h.claimed.attemptNo)).toMatchObject({ state: "aborted" });
    h.outbox.close();
  });

  it("aborts a committed begin when steered pane writing returns false before paste", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.tmux.pasteBuffer.mockResolvedValueOnce(false);
    h.tmux.getLastPasteError.mockReturnValue("window disappeared before paste");
    h.tmux.isLastPasteFailureRecoverable.mockReturnValue(false);
    vi.spyOn(h.daemon as any, "wake").mockResolvedValue(undefined);

    h.daemon.steerMessage("hello", deliveryMeta(h.row.deliveryId, h.claimed.attemptNo));
    await vi.runAllTimersAsync();
    await (h.daemon as any).steerLock;

    expect(h.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait", attemptNo: 1 });
    expect((h.outbox as any).db.prepare(
      "SELECT state FROM delivery_attempts WHERE delivery_id=? AND attempt_no=?",
    ).get(h.row.deliveryId, h.claimed.attemptNo)).toMatchObject({ state: "aborted" });
    h.outbox.close();
  });
});

describe("MCP durable response delivery tracking", () => {
  it("does not fence an ordinary start when best-effort old-window cleanup is unconfirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-outbox-no-pending-start-"));
    roots.push(root);
    const instanceDir = join(root, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "window-id"), "@stale-worker");
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
    const kill = vi.spyOn(TmuxManager.prototype, "killWindowConfirmed").mockResolvedValue(false);
    try {
      const result = await reconcileTargetBeforeStart(outbox, "worker", instanceDir);
      expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 0, safeToStart: true });
      // No durable attempt needs evidence. Let Daemon.start retain the old
      // Strategy-A best-effort kill behavior instead of imposing a new fence.
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      outbox.close();
    }
  });

  it("reconciles old pane evidence before replacement Daemon.start can run Strategy A cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-outbox-start-barrier-"));
    roots.push(root);
    const dbPath = join(root, "delivery-outbox.db");
    const oldStore = new DeliveryOutbox(dbPath, "manager-before-crash");
    const row = oldStore.admit({
      operationId: "op-start-barrier",
      sourceKey: "source:op-start-barrier:worker",
      sourceInstance: "source",
      sourceDaemonBootId: "source-boot",
      targetInstance: "worker",
      kind: "fleet_inbound",
      payload: { type: "fleet_inbound", content: "hello", meta: {} },
    }).delivery;
    const oldClaim = oldStore.claimNext("manager-before-crash", () => "old-target-boot", new Set())!;
    expect(oldStore.begin(row.deliveryId, "old-target-boot", oldClaim.attemptNo, {
      backend: "mock",
      windowId: "@old-worker",
      transcriptPath: null,
      transcriptOffset: null,
      transcriptSessionId: null,
      submissionMode: "idle_submit",
    })).toBe("begun");
    oldStore.close();

    const manager = new FleetManager(root);
    const replacementStore = new DeliveryOutbox(dbPath, manager.managerBootId);
    manager.deliveryOutbox = replacementStore;
    (manager as any).shuttingDown = true;
    const config = {
      backend: "mock",
      working_directory: root,
      log_level: "error",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    } as any;
    manager.fleetConfig = { defaults: { backend: "mock" }, instances: { worker: config } } as any;
    const order: string[] = [];
    vi.spyOn(TmuxManager, "getPanePid").mockResolvedValue(null);
    vi.spyOn(TmuxManager.prototype, "capturePane").mockImplementation(async () => {
      order.push("capture");
      return "[agend-delivery-id:old]\n❯";
    });
    vi.spyOn(TmuxManager.prototype, "killWindowConfirmed").mockImplementation(async () => {
      order.push("retire");
      return true;
    });
    const start = vi.spyOn(Daemon.prototype, "start").mockImplementation(async function() {
      order.push("start");
      expect(order).toEqual(["capture", "retire", "start"]);
      expect(replacementStore.get(row.deliveryId)).toMatchObject({ state: "retry_wait", reconciliationPending: false });
    });
    try {
      await manager.lifecycle.start("worker", config, false);
      expect(start).toHaveBeenCalledOnce();
      expect(replacementStore.get(row.deliveryId)?.state).toBe("retry_wait");
    } finally {
      vi.restoreAllMocks();
      replacementStore.close();
    }
  });

  it("keeps a target fenced when reconciliation cannot confirm the old window is retired", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-outbox-start-fence-"));
    roots.push(root);
    const dbPath = join(root, "delivery-outbox.db");
    const oldStore = new DeliveryOutbox(dbPath, "manager-before-crash");
    const row = oldStore.admit({
      operationId: "op-start-fence",
      sourceKey: "source:op-start-fence:worker",
      sourceInstance: "source",
      sourceDaemonBootId: "source-boot",
      targetInstance: "worker",
      kind: "fleet_inbound",
      payload: { type: "fleet_inbound", content: "hello", meta: {} },
    }).delivery;
    const oldClaim = oldStore.claimNext("manager-before-crash", () => "old-target-boot", new Set())!;
    oldStore.begin(row.deliveryId, "old-target-boot", oldClaim.attemptNo, {
      backend: "mock",
      windowId: "@old-worker",
      transcriptPath: null,
      transcriptOffset: null,
      transcriptSessionId: null,
      submissionMode: "idle_submit",
    });
    oldStore.close();

    const manager = new FleetManager(root);
    const replacementStore = new DeliveryOutbox(dbPath, manager.managerBootId);
    manager.deliveryOutbox = replacementStore;
    (manager as any).shuttingDown = true;
    const config = {
      backend: "mock",
      working_directory: root,
      log_level: "error",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    } as any;
    manager.fleetConfig = { defaults: { backend: "mock" }, instances: { worker: config } } as any;
    vi.spyOn(TmuxManager, "getPanePid").mockResolvedValue(null);
    vi.spyOn(TmuxManager.prototype, "capturePane").mockResolvedValue("❯");
    vi.spyOn(TmuxManager.prototype, "killWindowConfirmed").mockResolvedValue(false);
    const start = vi.spyOn(Daemon.prototype, "start").mockResolvedValue();
    const notify = vi.spyOn(manager as any, "notifyFleetError");
    try {
      await expect(manager.lifecycle.start("worker", config, false)).rejects.toThrow("could not be confirmed retired");
      expect(start).not.toHaveBeenCalled();
      expect(replacementStore.get(row.deliveryId)).toMatchObject({ state: "uncertain", reconciliationPending: false });
      expect(notify).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      replacementStore.close();
    }
  });

  it("records the response written by the real Daemon path and avoids a post-restart notice", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-outbox-mcp-response-"));
    roots.push(root);
    const dbPath = join(root, "delivery-outbox.db");
    const outbox = new DeliveryOutbox(dbPath, "manager-source");
    const manager = new FleetManager(root);
    manager.deliveryOutbox = outbox;
    const config = {
      defaults: { backend: "mock" },
      instances: {
        source: {
          backend: "mock",
          working_directory: root,
          restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
          context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
          log_level: "error",
        },
      },
    } as any;
    manager.fleetConfig = config;
    (manager as any).shuttingDown = true;
    const start = vi.spyOn(Daemon.prototype, "start").mockResolvedValue();
    try {
      await manager.lifecycle.start("source", config.instances.source, false);
      expect(start).toHaveBeenCalledOnce();
      const daemon = manager.lifecycle.daemons.get("source")!;
      const daemonAny = daemon as any;
      const operationId = "operation-response-written";
      const row = outbox.admit({
        operationId,
        sourceKey: `mcp:source:${operationId}:worker:fleet_inbound`,
        sourceInstance: "source",
        sourceDaemonBootId: daemon.bootId,
        targetInstance: "worker",
        kind: "fleet_inbound",
        payload: { type: "fleet_inbound", content: "hello", meta: {} },
      }).delivery;
      const socket = new EventEmitter() as any;
      daemonAny.socketSessionNames.set(socket, "source");
      daemonAny.ipcServer = { send: vi.fn(() => true) };

      daemonAny.handleToolCall({ tool: "checkout_repo", args: {}, requestId: 17, operationId }, socket);
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(daemonAny.ipcServer.send).toHaveBeenCalledWith(socket, expect.objectContaining({ requestId: 17, operationId }));
      expect(outbox.get(row.deliveryId)?.responseDeliveredAt).not.toBeNull();
      outbox.close();

      const replacement = new FleetManager(root);
      const restarted = new DeliveryOutbox(dbPath, replacement.managerBootId);
      replacement.deliveryOutbox = restarted;
      (replacement as any).shuttingDown = true;
      const recovered = restarted.recoverForBoot(replacement.managerBootId);
      replacement.onDaemonReady("source", "source-replacement-boot");

      expect(recovered).toEqual({ queued: 0, reconciliationPending: 0 });
      expect(restarted.getUnansweredAccepted("source", "source-replacement-boot")).toEqual([]);
      expect(restarted.listPending().some(item => item.kind === "post_restart_outcome_notice")).toBe(false);
      restarted.close();
    } finally {
      start.mockRestore();
      if ((outbox as any).db?.open) outbox.close();
    }
  });
});
