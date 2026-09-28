import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";

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
});
