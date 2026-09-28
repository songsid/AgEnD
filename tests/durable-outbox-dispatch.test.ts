import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DURABLE_DELIVERY_LANE_ALERT_MS, FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable outbox dispatcher", () => {
  it("dispatches raw_paste with its exact bytes and no message envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-outbox-raw-dispatch-"));
    roots.push(root);
    const fm = new FleetManager(root);
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-raw");
    fm.deliveryOutbox = outbox;
    const content = "  /compact\n--keep-space  \n";
    const row = outbox.admit({
      operationId: "schedule:raw-run-1",
      sourceKey: "schedule:silent-1:run-1:worker:raw_paste",
      sourceInstance: "scheduler-source",
      sourceDaemonBootId: "manager-source-boot",
      targetInstance: "worker",
      kind: "raw_paste",
      payload: { type: "raw_paste", content, schedule_id: "silent-1", schedule_run_id: "run-1" },
    }).delivery;
    const claimed = outbox.claimNext("manager-raw", () => "worker-boot", new Set())!;
    const deliver = vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_target, payload, options) => {
      expect(options).toMatchObject({ waitForIdle: false });
      expect(payload).toEqual({
        type: "raw_paste",
        content,
        delivery_id: row.deliveryId,
        delivery_attempt: "1",
      });
      expect(payload).not.toHaveProperty("meta");
      expect(outbox.begin(row.deliveryId, "worker-boot", 1, {
        backend: "codex", backendVersion: null, windowId: "@worker",
        transcriptPath: null, transcriptOffset: null, transcriptSessionId: null,
        submissionMode: "raw_paste", queueResumePolicy: "unknown",
      })).toBe("begun");
      expect(outbox.markEnterStarted(row.deliveryId, "worker-boot", 1)).toBe(true);
      expect(outbox.complete(row.deliveryId, "worker-boot", 1, "delivered", "raw command accepted by test daemon")).toBe(true);
      return true;
    });

    await (fm as any).dispatchDurableDelivery(claimed);
    expect(deliver).toHaveBeenCalledOnce();
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "delivered", attemptNo: 1 });
    outbox.close();
  });

  it("returns a pre-handoff cancellation to retry_wait instead of stranding delivering", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-outbox-dispatch-"));
    roots.push(root);
    const fm = new FleetManager(root);
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-1");
    fm.deliveryOutbox = outbox;
    const admitted = outbox.admit({
      operationId: "op-cancelled",
      sourceKey: "mcp:source:op-cancelled:worker:fleet_inbound",
      sourceInstance: "source",
      sourceDaemonBootId: "source-boot",
      targetInstance: "worker",
      kind: "fleet_inbound",
      payload: { type: "fleet_inbound", content: "hello", meta: {} },
    }).delivery;
    const claim = outbox.claimNext("manager-1", () => "target-boot", new Set());
    expect(claim).toBeDefined();
    vi.spyOn(fm, "deliverToInstance").mockResolvedValue(false);

    await (fm as any).dispatchDurableDelivery(claim);

    expect(outbox.get(admitted.deliveryId)).toMatchObject({
      state: "retry_wait",
      targetDaemonBootId: "target-boot",
      attemptNo: 1,
    });
    expect(outbox.get(admitted.deliveryId)?.nextAttemptAt).not.toBeNull();
    outbox.close();
  });

  it("keeps a busy target's lane after 45 minutes, alerts once, and does not fail or spend attempts", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "agend-outbox-stall-"));
    roots.push(root);
    const fm = new FleetManager(root);
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-1");
    fm.deliveryOutbox = outbox;
    const row = outbox.admit({
      operationId: "op-stalled",
      sourceKey: "mcp:source:op-stalled:worker:fleet_inbound",
      sourceInstance: "source",
      sourceDaemonBootId: "source-boot",
      targetInstance: "worker",
      kind: "fleet_inbound",
      payload: { type: "fleet_inbound", content: "hello", meta: {} },
    }).delivery;
    const claimed = outbox.claimNext("manager-1", () => "target-boot", new Set())!;
    let resolveHandoff!: (result: boolean) => void;
    vi.spyOn(fm, "deliverToInstance").mockImplementation(() => new Promise(resolve => { resolveHandoff = resolve; }));
    const fleetNotice = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});

    const dispatch = (fm as any).dispatchDurableDelivery(claimed) as Promise<void>;
    await vi.advanceTimersByTimeAsync(DURABLE_DELIVERY_LANE_ALERT_MS + 10 * 60_000);

    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "delivering", attemptNo: 1 });
    expect(fleetNotice).toHaveBeenCalledOnce();
    expect(fleetNotice.mock.calls[0]![0]).toContain("still waiting");

    // The idle gate may itself take a long time. When it safely releases work
    // before handoff, that explicit result releases the generation-owned lane.
    resolveHandoff(false);
    await dispatch;

    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "retry_wait", attemptNo: 1 });
    expect(outbox.get(row.deliveryId)?.nextAttemptAt).not.toBeNull();
    expect(fleetNotice).toHaveBeenCalledOnce();
    outbox.close();
  });
});
