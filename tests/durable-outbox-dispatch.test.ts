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
    const fleetNotice = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);

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

describe("lane held until verdict, bounded window (Option A #1207)", () => {
  const beginEvidence = {
    backend: "claude-code", backendVersion: null, windowId: "@worker",
    transcriptPath: null, transcriptOffset: null, transcriptSessionId: null,
    submissionMode: "idle_submit", queueResumePolicy: "unknown",
  } as const;

  function admit(outbox: DeliveryOutbox, target: string, n: number) {
    return outbox.admit({
      operationId: `op-proof-${target}-${n}`,
      sourceKey: `mcp:source:op-proof-${target}-${n}:${target}:fleet_inbound`,
      sourceInstance: "source",
      sourceDaemonBootId: "source-boot",
      targetInstance: target,
      kind: "fleet_inbound",
      payload: { type: "fleet_inbound", content: "hello", meta: {} },
    }).delivery;
  }

  /** A daemon that pastes, presses Enter and proof-waits: begun, row stays open until the test settles it. */
  function daemonProofWaiting(fm: FleetManager, outbox: DeliveryOutbox) {
    return vi.spyOn(fm, "deliverToInstance").mockImplementation(async (target, payload) => {
      const meta = (payload as { meta: Record<string, string> }).meta;
      const id = meta.delivery_id;
      const attempt = Number(meta.delivery_attempt);
      expect(outbox.begin(id, `${target}-boot`, attempt, { ...beginEvidence })).toBe("begun");
      return true;
    });
  }

  const flush = async (turns = 50) => { for (let i = 0; i < turns; i++) await new Promise(r => setImmediate(r)); };

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "agend-outbox-proofwait-"));
    roots.push(root);
    const fm = new FleetManager(root);
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-proof");
    fm.deliveryOutbox = outbox;
    return { fm, outbox };
  }

  it("a proof-waiting row holds its dispatch until the verdict: no handoff shortcut", async () => {
    const { fm, outbox } = setup();
    daemonProofWaiting(fm, outbox);
    const row = admit(outbox, "worker", 1);
    const claimed = outbox.claimNext("manager-proof", () => "worker-boot", new Set())!;

    let settled = false;
    const dispatch = (fm as any).dispatchDurableDelivery(claimed) as Promise<void>;
    void dispatch.then(() => { settled = true; });
    await flush();
    // Phase 2c: the lane wait resolves on a terminal row state only — the open proof-wait holds the dispatch.
    expect(settled).toBe(false);
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "submission_started" });

    expect(outbox.complete(row.deliveryId, "worker-boot", claimed.attemptNo, "delivered", "transcript-marker")).toBe(true);
    await dispatch;
    expect(settled).toBe(true);
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "delivered" });
    outbox.close();
  });

  it("the next same-target delivery waits for the first verdict, then proceeds FIFO", async () => {
    const { fm, outbox } = setup();
    const deliver = daemonProofWaiting(fm, outbox);
    const first = admit(outbox, "worker", 1);
    const second = admit(outbox, "worker", 2);
    const claimedFirst = outbox.claimNext("manager-proof", () => "worker-boot", new Set())!;
    expect(claimedFirst.deliveryId).toBe(first.deliveryId);
    // The pump holds the lane across the dispatch and drops it when the dispatch settles.
    const lanes: Set<string> = (fm as any).activeDurableTargets;
    lanes.add("worker");
    let settledFirst = false;
    const dispatchFirst = (fm as any).dispatchDurableDelivery(claimedFirst) as Promise<void>;
    void dispatchFirst.then(() => { settledFirst = true; });
    await flush();
    expect(settledFirst).toBe(false);
    // While the first verdict is pending the lane is held: the second row is not claimable past it.
    expect(outbox.claimNext("manager-proof", () => "worker-boot", lanes)).toBeUndefined();

    expect(outbox.complete(first.deliveryId, "worker-boot", claimedFirst.attemptNo, "delivered", "transcript-marker")).toBe(true);
    await dispatchFirst;
    lanes.delete("worker");
    const claimedSecond = outbox.claimNext("manager-proof", () => "worker-boot", lanes)!;
    expect(claimedSecond.deliveryId).toBe(second.deliveryId);
    lanes.add("worker");
    let settledSecond = false;
    const dispatchSecond = (fm as any).dispatchDurableDelivery(claimedSecond) as Promise<void>;
    void dispatchSecond.then(() => { settledSecond = true; });
    await flush();
    expect(settledSecond).toBe(false);
    expect(outbox.complete(second.deliveryId, "worker-boot", claimedSecond.attemptNo, "uncertain", "unverifiable-no-transcript-marker")).toBe(true);
    await dispatchSecond;
    lanes.delete("worker");
    expect(deliver).toHaveBeenCalledTimes(2);
    // Per-target FIFO: verdicts land in dispatch order; nothing overtook anything.
    expect(outbox.get(first.deliveryId)).toMatchObject({ state: "delivered" });
    expect(outbox.get(second.deliveryId)).toMatchObject({ state: "uncertain" });
    expect(outbox.get(first.deliveryId)!.createdSeq).toBeLessThan(outbox.get(second.deliveryId)!.createdSeq);
    outbox.close();
  });

  it("eight open verdicts fill the shared 8-slot budget until they land, then it drains", async () => {
    const { fm, outbox } = setup();
    // The pump reschedules itself after every settled dispatch; pin it so only explicit pump passes run.
    vi.spyOn(fm as any, "scheduleDeliveryOutboxPump").mockImplementation(() => {});
    daemonProofWaiting(fm, outbox);
    const targets = Array.from({ length: 8 }, (_, i) => `t${i + 1}`);
    for (const t of targets) {
      (fm as any).daemons.set(t, { bootId: `${t}-boot` });
      admit(outbox, t, 1);
    }
    await (fm as any).runDeliveryOutboxPump();
    await flush(200);
    // All eight lanes are held by open proof-waits: the shared budget is full.
    expect((fm as any).activeDurableTargets.size).toBe(8);

    (fm as any).daemons.set("t9", { bootId: "t9-boot" });
    admit(outbox, "t9", 1);
    await (fm as any).runDeliveryOutboxPump();
    await flush(50);
    // No slot free: the ninth target is not claimed while eight verdicts are pending.
    expect(outbox.getByOperation("source", "op-proof-t9-1")[0]!.state).toBe("queued");

    // Verdicts land (successes in ~1 s live, failures at the ~10 s bound): each settled dispatch frees its slot.
    for (const t of targets) {
      const row = outbox.getByOperation("source", `op-proof-${t}-1`)[0]!;
      expect(row.state).toBe("submission_started");
      expect(outbox.complete(row.deliveryId, `${t}-boot`, row.attemptNo, "uncertain", "unverifiable-no-transcript-marker")).toBe(true);
    }
    await flush(200);
    expect((fm as any).activeDurableTargets.size).toBe(0);
    await (fm as any).runDeliveryOutboxPump();
    await flush(200);
    const ninthRow = outbox.getByOperation("source", "op-proof-t9-1")[0]!;
    expect(ninthRow.state).toBe("submission_started");
    // The ninth lane is held until its own verdict, then drains like the rest.
    expect((fm as any).activeDurableTargets.size).toBe(1);
    expect(outbox.complete(ninthRow.deliveryId, "t9-boot", ninthRow.attemptNo, "delivered", "transcript-marker")).toBe(true);
    await flush(200);
    expect((fm as any).activeDurableTargets.size).toBe(0);
    outbox.close();
  });
});
