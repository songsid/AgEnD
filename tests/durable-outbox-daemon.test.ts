import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";

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
    getLastPasteError: vi.fn(() => undefined),
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
});

describe("MCP durable response delivery tracking", () => {
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

      expect(recovered).toEqual({ queued: 0, uncertain: 0 });
      expect(restarted.getUnansweredAccepted("source", "source-replacement-boot")).toEqual([]);
      expect(restarted.listPending().some(item => item.kind === "post_restart_outcome_notice")).toBe(false);
      restarted.close();
    } finally {
      start.mockRestore();
      if ((outbox as any).db?.open) outbox.close();
    }
  });
});
