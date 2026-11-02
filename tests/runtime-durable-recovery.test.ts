import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import type { NativeExecutionResult } from "../src/fleet-windows-runtime.js";

const homes: string[] = [], stores: DeliveryOutbox[] = [];
const machineId = "12345678-1234-4321-abcd-123456789012";
function fixture(requiresReply = true) {
  const path = mkdtempSync(join(tmpdir(), "agend-runtime-recovery-")); homes.push(path);
  const outbox = new DeliveryOutbox(join(path, "delivery.db"), "manager-old"); stores.push(outbox);
  const admitted = outbox.admit({ operationId: "fixture-operation", sourceKey: "fixture-request", sourceInstance: "dispatcher", sourceDaemonBootId: "dispatcher-boot", targetInstance: "worker", kind: "fleet_inbound", correlationId: "fixture-correlation",
    payload: { type: "fleet_inbound", content: "Isolated fixture; never execute a real CLI", meta: { requires_reply: requiresReply ? "true" : "false" } } });
  const claimed = outbox.claimNext("manager-old", () => "original-runtime-generation", new Set())!;
  expect(outbox.begin(claimed.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo)).toBe("begun");
  outbox.recoverForBoot("manager-new"); expect(outbox.get(admitted.delivery.deliveryId)?.state).toBe("reconciliation_pending");
  const fm = Object.create(FleetManager.prototype) as any;
  fm.deliveryOutbox = outbox; fm.managerBootId = "manager-new"; fm.activeDurableTargets = new Set(); fm.reconciledRemoteResults = new Set(); fm.shuttingDown = false;
  fm.fleetConfig = { instances: { worker: { runtime: "windows", machine_id: machineId }, dispatcher: { working_directory: "/fixture" }, unrelated: { working_directory: "/other" } } };
  fm.nativeInstanceRuntime = vi.fn(() => { throw Error("Recovery must not launch an agent"); }); fm.runtimeWindowsExecutor = vi.fn(() => { throw Error("Recovery must not dispatch an execution"); }); fm.logger = { warn: vi.fn() };
  const task: NativeExecutionResult = { id: claimed.deliveryId, cli: "codex", cwd: "C:\\fixture", sandbox: "read-only", status: "completed", output: "Recovered exact runtime result", startedAt: 100, finishedAt: 200, outcomeConfirmed: true };
  const resultRows = () => outbox.queryStatusForInstance("worker", { correlationId: "fixture-correlation", limit: 100 }).items.filter(item => item.source_instance === "worker" && item.target_instance === "dispatcher" && item.kind === "fleet_inbound");
  return { fm, outbox, claimed, task, resultRows };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); } });

describe("paired runtime completion reconciles the durable Fleet outbox", () => {
  it("settles a recovered submission using the original attempt fence and admits one stable peer result", () => {
    const f = fixture(), complete = vi.spyOn(f.outbox, "complete"); f.fm.reconcileRemoteDelivery(machineId, f.task);
    expect(complete).toHaveBeenCalledWith(f.task.id, "original-runtime-generation", 1, "delivered", expect.any(String));
    expect(f.outbox.get(f.task.id)?.state).toBe("delivered"); expect(f.resultRows()).toHaveLength(1);
    expect(f.resultRows()[0].operation_id).toBe(`native-result:${f.task.id}`);
    f.fm.reconcileRemoteDelivery(machineId, f.task); f.fm.reconcileRemoteDelivery(machineId, f.task);
    expect(f.resultRows()).toHaveLength(1); expect(f.fm.nativeInstanceRuntime).not.toHaveBeenCalled(); expect(f.fm.runtimeWindowsExecutor).not.toHaveBeenCalled();
  });
  it("upgrades an uncertain exact execution to delivered after runtime completion proof", () => {
    const f = fixture(); f.outbox.complete(f.task.id, f.claimed.targetDaemonBootId, f.claimed.attemptNo, "uncertain", "Connection lost before result"); expect(f.outbox.get(f.task.id)?.state).toBe("uncertain");
    f.fm.reconcileRemoteDelivery(machineId, f.task); expect(f.outbox.get(f.task.id)?.state).toBe("delivered"); expect(f.resultRows()).toHaveLength(1);
  });
  it("refuses a different machine, absent task identity, or unconfirmed/nonterminal snapshot", () => {
    const f = fixture(), complete = vi.spyOn(f.outbox, "complete");
    f.fm.reconcileRemoteDelivery("different-machine", f.task); f.fm.reconcileRemoteDelivery(machineId, { ...f.task, id: "unrelated-delivery" });
    f.fm.reconcileRemoteDelivery(machineId, { ...f.task, outcomeConfirmed: false }); f.fm.reconcileRemoteDelivery(machineId, { ...f.task, finishedAt: undefined });
    f.fm.reconcileRemoteDelivery(machineId, { ...f.task, status: "running" });
    expect(complete).not.toHaveBeenCalled(); expect(f.outbox.get(f.task.id)?.state).toBe("reconciliation_pending"); expect(f.resultRows()).toHaveLength(0);
  });
  it("leaves an actively owned durable lane to its current executor", () => {
    const f = fixture(); f.fm.activeDurableTargets.add("worker"); f.fm.reconcileRemoteDelivery(machineId, f.task);
    expect(f.outbox.get(f.task.id)?.state).toBe("reconciliation_pending"); expect(f.resultRows()).toHaveLength(0);
  });
  it("settles confirmed failure without treating it as a successful delivery", () => {
    const f = fixture(); f.fm.reconcileRemoteDelivery(machineId, { ...f.task, status: "failed", error: "CLI fixture rejected this request" });
    expect(f.outbox.get(f.task.id)?.state).toBe("failed"); expect(f.resultRows()).toHaveLength(1);
  });
  it("does not create fallback results for a request that asked for no reply", () => {
    const f = fixture(false); f.fm.reconcileRemoteDelivery(machineId, f.task); expect(f.outbox.get(f.task.id)?.state).toBe("delivered"); expect(f.resultRows()).toHaveLength(0);
  });
  it("does not duplicate an explicit MCP report already queued for the original requester", () => {
    const f = fixture(); f.outbox.admit({ operationId: "fixture-explicit-report", sourceKey: "fixture-report", sourceInstance: "worker", sourceDaemonBootId: "runtime-boot", targetInstance: "dispatcher", kind: "report", correlationId: "fixture-correlation", payload: { content: "Explicit result" } });
    f.fm.reconcileRemoteDelivery(machineId, f.task); expect(f.outbox.get(f.task.id)?.state).toBe("delivered"); expect(f.resultRows()).toHaveLength(0);
  });
  it("does not let a report to a different peer suppress the original requester's fallback", () => {
    const f = fixture(); f.outbox.admit({ operationId: "fixture-wrong-target-report", sourceKey: "fixture-other-report", sourceInstance: "worker", sourceDaemonBootId: "runtime-boot", targetInstance: "unrelated", kind: "report", correlationId: "fixture-correlation", payload: { content: "A result for someone else" } });
    f.fm.reconcileRemoteDelivery(machineId, f.task); expect(f.resultRows()).toHaveLength(1);
  });
});
