import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable outbox dispatcher", () => {
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

  it("bounds a stalled pre-submit target lane and fences its late begin", async () => {
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
    vi.spyOn(fm, "deliverToInstance").mockImplementation(() => new Promise(() => {}));

    const dispatch = (fm as any).dispatchDurableDelivery(claimed) as Promise<void>;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await dispatch;

    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "retry_wait", attemptNo: 1 });
    expect(outbox.get(row.deliveryId)?.nextAttemptAt).not.toBeNull();
    expect(outbox.begin(row.deliveryId, "target-boot", claimed.attemptNo)).toBe("stale");
    outbox.close();
  });
});
