import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { WORKING_STATE_MAX_BYTES, type WorkingStateSnapshot, type WorkingStateReference } from "../src/working-state-journal.js";

const roots: string[] = [], stores: DeliveryOutbox[] = [];
afterEach(() => { for (const s of stores.splice(0)) try { s.close(); } catch {} for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const snapshot = (patch: Partial<Omit<WorkingStateSnapshot, "managerBootId">> = {}): Omit<WorkingStateSnapshot, "managerBootId"> => ({
  version: 1, reason: "execution", observedAt: 10, lastActivityAt: null,
  observation: { owner: { bootId: "daemon-a", spawnGeneration: 1, launchAttempt: 2, launchFenceEpoch: 0 },
    backend: "mock", configuration: "a".repeat(64), executionState: "working", processStatus: "running", backgroundWork: null,
    turn: { generation: 1, deliveryId: "delivery-a", correlationId: "correlation-a", messageId: "message-a", cancelled: false, completionDelivered: false },
    sessionId: null, backendTurnId: null }, references: [], totalReferences: 0, unavailable: [], ...patch,
});
function store(path?: string, boot = "manager-a") {
  if (!path) { const root = mkdtempSync(join(tmpdir(), "working-state-2473-")); roots.push(root); path = join(root, "delivery-outbox.db"); }
  const outbox = new DeliveryOutbox(path, boot); stores.push(outbox); return { outbox, path };
}
let n = 0;
function admit(o: DeliveryOutbox, from: string, to: string, cid: string, requires = false) {
  const seq = ++n;
  return o.admit({ operationId: `op-${seq}`, sourceKey: `key-${seq}`, sourceInstance: from, sourceDaemonBootId: `${from}-boot`, targetInstance: to,
    kind: "fleet_inbound", correlationId: cid, payload: { content: "private text is not journal metadata", meta: { requires_reply: String(requires) } } }).delivery;
}
function deliver(o: DeliveryOutbox, target: string) {
  const claimed = o.claimNext(o.managerBootId, name => `${name}-boot`, new Set())!;
  expect(claimed.targetInstance).toBe(target);
  expect(o.begin(claimed.deliveryId, `${target}-boot`, claimed.attemptNo)).toBe("begun");
  expect(o.complete(claimed.deliveryId, `${target}-boot`, claimed.attemptNo, "delivered")).toBe(true);
}

describe("#2473 stage 1: atomic metadata, no recovery", () => {
  it("survives reopening the same outbox and records a prior run without consuming it", () => {
    const { outbox: a, path } = store(); a.observeWorkingState("worker", snapshot());
    const { outbox: b } = store(path, "manager-b");
    const quiet = snapshot(); quiet.observation = { ...quiet.observation, executionState: "idle", turn: null };
    const entry = b.observeWorkingState("worker", quiet)!;
    expect(entry.current.managerBootId).toBe("manager-b");
    expect(entry.prior?.observation.turn?.deliveryId).toBe("delivery-a");
    const { outbox: c } = store(path, "manager-c"); c.observeWorkingState("worker", quiet);
    expect(c.getWorkingState("worker")?.prior?.managerBootId).toBe("manager-a");
    expect((c as any).db.prepare("SELECT COUNT(*) n FROM deliveries").get().n).toBe(0);
  });
  it.each(["session", "configuration"])("never carries a continuation marker into a different %s", field => {
    const { outbox } = store(); const previous = snapshot();
    previous.observation = { ...previous.observation, sessionId: "old-session", recoveryDeliveryId: "confirmed-before" };
    outbox.observeWorkingState("worker", previous);
    const next = snapshot(); next.observation = { ...next.observation, sessionId: field === "session" ? "fresh-session" : "old-session",
      configuration: field === "configuration" ? "b".repeat(64) : previous.observation.configuration };
    expect(outbox.observeWorkingState("worker", next)?.current.observation.recoveryDeliveryId).toBeUndefined();
  });
  it("a newly confirmed continuation replaces the inherited interval marker", () => {
    const { outbox } = store(); const previous = snapshot();
    previous.observation = { ...previous.observation, sessionId: "same-session", recoveryDeliveryId: "confirmed-before" };
    outbox.observeWorkingState("worker", previous);
    const next = { ...previous, observation: { ...previous.observation, recoveryDeliveryId: "confirmed-after" } };
    expect(outbox.observeWorkingState("worker", next)?.current.observation.recoveryDeliveryId).toBe("confirmed-after");
  });
  it("snapshots a stop before guard retirement even if the observation otherwise matches", () => {
    const { outbox } = store(); outbox.observeWorkingState("worker", snapshot());
    const stopped = outbox.observeWorkingState("worker", snapshot({ reason: "before_stop" }))!;
    expect(stopped).not.toBeNull();
    expect(stopped.prior?.observation.turn?.deliveryId).toBe("delivery-a");
    expect(stopped.current.reason).toBe("before_stop");
  });
  it("ignores polling duplicates but commits a changed execution state", () => {
    const { outbox } = store(); const first = outbox.observeWorkingState("worker", snapshot())!;
    expect(outbox.observeWorkingState("worker", snapshot({ observedAt: 999 }))).toBeNull();
    const next = snapshot(); next.observation = { ...next.observation, executionState: "idle" };
    expect(outbox.observeWorkingState("worker", next)?.revision).toBe(first.revision + 1);
  });
  it("stores bounded whitelisted references, explicit overflow and no arbitrary payload/config", () => {
    const { outbox } = store();
    const references = Array.from({ length: 40 }, (_, i): WorkingStateReference => ({ kind: "owed", correlationId: `cid${i}${"x".repeat(200)}`,
      requester: "q".repeat(200), owner: "o".repeat(200), deliveryId: `d${i}${"d".repeat(200)}` }));
    const input = snapshot({ references, totalReferences: 40 }) as any;
    input.content = "must-not-store-this-message"; input.observation.pane = "must-not-store-this-pane"; input.observation.config = { token: "must-not-store-this-token" };
    const entry = outbox.observeWorkingState("worker", input)!;
    expect(entry.current.references.length).toBeGreaterThan(0);
    expect(entry.current.references.length).toBeLessThanOrEqual(16);
    expect(entry.current.references.length).toBeLessThan(40);
    expect(entry.current.totalReferences).toBe(40);
    expect(Buffer.byteLength(JSON.stringify(entry.current))).toBeLessThanOrEqual(WORKING_STATE_MAX_BYTES);
    expect(JSON.stringify(entry)).not.toContain("must-not-store");
  });
  it("rejects oversized identifiers rather than aliasing them by truncation", () => {
    const { outbox } = store(); const references: WorkingStateReference[] = [{ kind: "task", id: "x".repeat(500), version: 1, status: "claimed" }];
    const entry = outbox.observeWorkingState("worker", snapshot({ references, totalReferences: 1 }))!;
    expect(entry.current.references).toEqual([]); expect(entry.current.totalReferences).toBe(1);
  });
  it("limits even short references to sixteen, independently of the byte budget", () => {
    const { outbox } = store(); const references: WorkingStateReference[] = Array.from({ length: 30 }, (_, i) => ({ kind: "task", id: `task-${i}`, version: 1, status: "claimed" }));
    const entry = outbox.observeWorkingState("worker", snapshot({ references, totalReferences: 30 }))!;
    expect(entry.current.references).toHaveLength(16); expect(entry.current.totalReferences).toBe(30);
  });
  it("preserves cancellation/completion observations without changing delivery state", () => {
    const { outbox } = store(); const row = admit(outbox, "leader", "worker", "cid");
    for (const field of ["cancelled", "completionDelivered"] as const) {
      const s = snapshot(); s.observation.turn = { ...s.observation.turn!, [field]: true };
      const entry = outbox.observeWorkingState("worker", s)!;
      expect(entry.current.observation.turn?.[field]).toBe(true);
      expect(outbox.get(row.deliveryId)?.state).toBe("queued");
    }
  });
  it.each(["cancelled", "completionDelivered"] as const)("does not label a terminal %s turn as interrupted on another boot", (field) => {
    const { outbox, path } = store(); const input = snapshot();
    input.observation.turn = { ...input.observation.turn!, [field]: true };
    outbox.observeWorkingState("worker", input);
    const { outbox: next } = store(path, "next-manager");
    const quiet = snapshot(); quiet.observation = { ...quiet.observation, executionState: "idle", turn: null };
    expect(next.observeWorkingState("worker", quiet)?.prior).toBeNull();
  });
  it("keeps the whole previous snapshot and revision when SQLite aborts an update", () => {
    const { outbox, path } = store(); const original = outbox.observeWorkingState("worker", snapshot())!;
    const db = new Database(path);
    try { db.exec("CREATE TRIGGER refuse_journal BEFORE UPDATE ON working_state_journal BEGIN SELECT RAISE(ABORT,'injected journal failure'); END"); }
    finally { db.close(); }
    const change = snapshot(); change.observation = { ...change.observation, executionState: "idle" };
    expect(() => outbox.observeWorkingState("worker", change)).toThrow("injected journal failure");
    expect(outbox.getWorkingState("worker")).toEqual(original);
    expect(admit(outbox, "leader", "worker", "cid").state).toBe("queued");
  });
  it("does not wait behind another writer and restores the delivery timeout on failure and success", () => {
    const { outbox, path } = store(); const blocker = new Database(path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      const started = performance.now();
      expect(() => outbox.observeWorkingState("worker", snapshot())).toThrow(/locked/);
      expect(performance.now() - started).toBeLessThan(500);
      expect((outbox as any).db.pragma("busy_timeout", { simple: true })).toBe(1000);
      blocker.exec("ROLLBACK");
      expect(outbox.observeWorkingState("worker", snapshot())).not.toBeNull();
      expect((outbox as any).db.pragma("busy_timeout", { simple: true })).toBe(1000);
      expect(admit(outbox, "leader", "worker", "cid").state).toBe("queued");
    } finally { if (blocker.inTransaction) blocker.exec("ROLLBACK"); blocker.close(); }
  });
  it("distinguishes owed work from waiting and observes answers after commit", () => {
    const { outbox } = store(); admit(outbox, "leader", "worker", "cid", true); deliver(outbox, "worker");
    expect(outbox.workingObligations("worker").references).toMatchObject([{ kind: "owed", correlationId: "cid", requester: "leader", owner: "worker" }]);
    expect(outbox.workingObligations("leader").references).toMatchObject([{ kind: "waiting", correlationId: "cid" }]);
    const states: unknown[] = [];
    outbox.on("working_references", () => states.push(outbox.getReplyObligation("cid", "leader", "worker")?.state));
    admit(outbox, "worker", "leader", "cid");
    expect(states).toEqual(["answered"]);
    expect(outbox.workingObligations("worker")).toEqual({ total: 0, references: [] });
  });
  it("bounds obligation queries and never lets a throwing observer change admission", () => {
    const { outbox } = store();
    for (let i = 0; i < 20; i++) { admit(outbox, "leader", "worker", `cid-${i}`, true); deliver(outbox, "worker"); }
    expect(outbox.workingObligations("worker").references).toHaveLength(16);
    expect(outbox.workingObligations("worker").total).toBe(20);
    outbox.on("working_references", () => { throw Error("observer failed"); });
    expect(() => admit(outbox, "worker", "leader", "cid-0")).not.toThrow();
    expect(outbox.getReplyObligation("cid-0", "leader", "worker")?.state).toBe("answered");
  });
});
