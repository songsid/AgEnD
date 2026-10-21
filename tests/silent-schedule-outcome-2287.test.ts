import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";

const owned: Array<{ box: DeliveryOutbox; root: string }> = [];
afterEach(() => { for (const { box, root } of owned.splice(0)) { box.close(); rmSync(root, { recursive: true, force: true }); } });
function fixture(source = "worker", kind: "raw_paste" | "fleet_inbound" = "raw_paste", key = "schedule:heartbeat:run:worker:raw_paste") {
  const root = mkdtempSync(join(tmpdir(), "agend-silent2287-"));
  const box = new DeliveryOutbox(join(root, "outbox.db"), "manager"); owned.push({ box, root });
  const row = box.admit({ operationId: "heartbeat-run", sourceKey: key, sourceInstance: source, sourceDaemonBootId: "source-boot", targetInstance: "worker", kind, payload: { type: kind, content: "quiet heartbeat", meta: {} } }).delivery;
  const notices = () => (box as any).db.prepare("SELECT target_instance,payload_json FROM deliveries WHERE kind='delivery_outcome_notice'").all() as Array<{ target_instance: string; payload_json: string }>;
  const reservations = () => (box as any).db.prepare("SELECT COUNT(*) AS count FROM failure_notices").get().count;
  const begin = () => {
    const claimed = box.claimNext("manager", () => "target-boot", new Set())!;
    expect(claimed.deliveryId).toBe(row.deliveryId);
    expect(box.begin(row.deliveryId, "target-boot", claimed.attemptNo, { backend: "codex", backendVersion: "0.162.1", windowId: "@inert", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: kind === "raw_paste" ? "raw_paste" : "idle_submit", queueResumePolicy: "unknown" })).toBe("begun");
    return claimed.attemptNo;
  };
  return { box, row, notices, reservations, begin };
}
describe("#2287 self silent schedule outcome stays in the log, never a new prompt", () => {
  it.each(["uncertain", "failed"] as const)("self schedule %s retains state/cause without an outcome notice", outcome => {
    const f = fixture(); const attempt = f.begin(); const cause = "post-submit-proof:unproven";
    expect(f.box.complete(f.row.deliveryId, "target-boot", attempt, outcome, cause)).toBe(true);
    expect(f.box.get(f.row.deliveryId)).toMatchObject({ state: outcome, lastError: cause, attemptNo: 1 });
    expect(f.notices()).toEqual([]); expect(f.reservations()).toBe(0);
    expect(f.box.needsAttention("2000-01-01T00:00:00.000Z")).toEqual([]);
  });
  it.each(["uncertain", "failed"] as const)("a different source still receives exactly one %s notice", outcome => {
    const f = fixture("coordinator"); const attempt = f.begin();
    expect(f.box.complete(f.row.deliveryId, "target-boot", attempt, outcome, "proof unavailable")).toBe(true);
    expect(f.notices()).toHaveLength(1); expect(f.notices()[0].target_instance).toBe("coordinator");
    expect(JSON.parse(f.notices()[0].payload_json).content).toContain("[system:delivery-outcome]");
    f.box.complete(f.row.deliveryId, "target-boot", attempt, outcome, "repeat");
    expect(f.notices()).toHaveLength(1); expect(f.reservations()).toBe(1);
  });
  it.each([
    ["raw_paste", "command:clear:worker:raw_paste"],
    ["fleet_inbound", "schedule:heartbeat:run:worker:fleet_inbound"],
  ] as const)("self %s with key %s preserves its normal notice", (kind, key) => {
    const f = fixture("worker", kind, key); const attempt = f.begin();
    expect(f.box.complete(f.row.deliveryId, "target-boot", attempt, "uncertain", "proof unavailable")).toBe(true);
    expect(f.notices()).toHaveLength(1); expect(f.notices()[0].target_instance).toBe("worker");
  });
  it("self silent schedule failure before submission cannot feed back to itself", () => {
    const f = fixture(); expect(f.box.failBeforeBegin(f.row.deliveryId, "target unavailable")).toBe(true);
    expect(f.box.get(f.row.deliveryId)).toMatchObject({ state: "failed", lastError: "target unavailable" });
    expect(f.notices()).toEqual([]); expect(f.reservations()).toBe(0);
  });
  it("reconciled self silent schedule keeps evidence without a feedback notice", () => {
    const f = fixture(); const attempt = f.begin();
    // Represent the old attempt fenced to reconciliation, without restarting any process.
    (f.box as any).db.prepare("UPDATE deliveries SET reconciliation_pending=1 WHERE delivery_id=?").run(f.row.deliveryId);
    expect(f.box.reconcileAttempt(f.row.deliveryId, "target-boot", attempt, "uncertain", "reconciled:unproven")).toBe(true);
    expect(f.box.get(f.row.deliveryId)).toMatchObject({ state: "uncertain", lastError: "reconciled:unproven" });
    expect(f.notices()).toEqual([]); expect(f.reservations()).toBe(0);
  });
  it("expired self silent schedule cannot feed back to itself", () => {
    const f = fixture(); expect(f.box.expireStale(Date.now() + 60_000, 1000)).toBe(1);
    expect(f.box.get(f.row.deliveryId)?.state).toBe("failed");
    expect(f.notices()).toEqual([]); expect(f.reservations()).toBe(0);
  });
});

describe("#2287 fleet state observer keeps self-silent failures log-only", () => {
  it.each([
    [true, "failed", "raw_paste", "schedule:self:run:worker:raw_paste", 0],
    [true, "uncertain", "raw_paste", "schedule:self:run:worker:raw_paste", 0],
    [false, "failed", "raw_paste", "schedule:self:run:worker:raw_paste", 1],
    [false, "uncertain", "raw_paste", "schedule:self:run:worker:raw_paste", 1],
    [true, "uncertain", "raw_paste", "command:clear:worker:raw_paste", 1],
    [true, "uncertain", "fleet_inbound", "schedule:self:run:worker:fleet_inbound", 1],
  ] as const)("self=%s state=%s kind=%s key=%s retains its log and expected alert", (self, outcome, kind, sourceKey, alerts) => {
    const root = mkdtempSync(join(tmpdir(), "agend-silent-observer2287-"));
    const fm = new FleetManager(root); const f = fm as any;
    vi.spyOn(f, "scheduleDeliveryOutboxPump").mockImplementation(() => {});
    f.ensureDeliveryOutbox(); const box = fm.deliveryOutbox!;
    const notice = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
    const logged = vi.spyOn(f.logger, "error");
    try {
      const row = box.admit({ operationId: "self-silent-run", sourceKey, sourceInstance: self ? "worker" : "coordinator", sourceDaemonBootId: "source-boot", targetInstance: "worker", kind, payload: { type: kind, content: "quiet heartbeat" } }).delivery;
      if (outcome === "failed") expect(box.failBeforeBegin(row.deliveryId, "target unavailable")).toBe(true);
      else {
        const claim = box.claimNext(f.managerBootId, () => "target-boot", new Set())!;
        expect(claim.deliveryId).toBe(row.deliveryId);
        expect(box.begin(row.deliveryId, "target-boot", claim.attemptNo, { backend: "codex", backendVersion: "0.162.1", windowId: "@inert", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: kind === "raw_paste" ? "raw_paste" : "idle_submit", queueResumePolicy: "unknown" })).toBe("begun");
        expect(box.complete(row.deliveryId, "target-boot", claim.attemptNo, "uncertain", "target unavailable")).toBe(true);
      }
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: row.deliveryId, cause: "target unavailable" }), expect.any(String));
      const silent = kind === "raw_paste" && sourceKey.startsWith("schedule:");
      expect((logged.mock.calls[0]?.[0] as any)?.silentSchedule).toBe(silent ? true : undefined);
      expect(notice).toHaveBeenCalledTimes(alerts);
    } finally {
      box.close(); fm.memoryPressure.stop(); fm.spawnGate.shutdown(); fm.stormWindow.shutdown(); rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
