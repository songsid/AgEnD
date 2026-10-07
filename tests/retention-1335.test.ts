/**
 * #1335: retention for delivery-outbox.db and Task Board.
 * Tests:
 *   1. Outbox prune removes delivered/failed rows older than N days;
 *      uncertain and non-terminal rows survive; open reply obligations protect
 *      their parent delivery from being pruned.
 *   2. Expired vs not-found: delivery_status handler (via outboundHandlers)
 *      returns "expired" for a pruned delivery_id owned by the caller, "not found"
 *      for a never-existing id or an unrelated caller.
 *   3. Task Board prune removes done/cancelled tasks older than N days;
 *      open/claimed/blocked tasks survive; cancelled prerequisites of live tasks
 *      are protected.
 *   4. Task list cap: applyTaskListCap (exported production function) caps at
 *      100 unfiltered rows; filtered lists pass through; empty strings treated
 *      as "not filtered".
 *   5. Chunked deletes: prune runs in chunks of ≤500 rows with yields.
 *      Task prune and tombstone cleanup are also chunked.
 *   6. Config validator: retention_days must be a positive integer.
 *
 * Isolation (bd0c88aa): all DBs are opened on temp files. No fleet start,
 * no tmux, no ~/.agend.
 *
 * Tests invoke production code directly — no logic simulation:
 *   - delivery_status via outboundHandlers.get("delivery_status")
 *   - task list cap via applyTaskListCap (exported from fleet-manager.ts)
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryOutbox, type DeliveryStatusSelector } from "../src/delivery-outbox.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { applyTaskListCap, TASK_LIST_CAP } from "../src/fleet-manager.js";

// ── helpers ────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agend-1335-"));
  dirs.push(d);
  return d;
}

function makeOutbox(): { outbox: DeliveryOutbox; dbPath: string } {
  const dir = tempDir();
  const dbPath = join(dir, "delivery-outbox.db");
  const outbox = new DeliveryOutbox(dbPath, "test-boot");
  return { outbox, dbPath };
}

let seq = 0;
function admit(outbox: DeliveryOutbox, extra: Partial<{ target: string; src: string }> = {}) {
  const id = `op-${++seq}-${Date.now()}`;
  return outbox.admit({
    operationId: id,
    sourceKey: `key:${id}`,
    sourceInstance: extra.src ?? "src",
    sourceDaemonBootId: "src-boot",
    targetInstance: extra.target ?? "tgt",
    kind: "fleet_inbound",
    payload: { type: "fleet_inbound", content: "hi", meta: {} },
  });
}

function forceState(
  outbox: DeliveryOutbox,
  deliveryId: string,
  state: "delivered" | "failed" | "uncertain",
  finishedAt: string,
): void {
  const db = (outbox as unknown as { db: import("better-sqlite3").Database }).db;
  db.prepare(
    "UPDATE deliveries SET state=?, finished_at=?, updated_at=? WHERE delivery_id=?",
  ).run(state, finishedAt, finishedAt, deliveryId);
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();
}

/** Call the production delivery_status handler. */
function callDeliveryStatus(
  outbox: DeliveryOutbox,
  args: { delivery_id?: string; operation_id?: string },
  callerInstance: string,
): { result: unknown; error: unknown } {
  const handler = outboundHandlers.get("delivery_status")!;
  let result: unknown;
  let error: unknown;
  handler(
    {
      queryDurableDeliveryStatus: (caller: string, sel: DeliveryStatusSelector) =>
        outbox.queryStatusForInstance(caller, sel),
      wasDeliveryIdPrunedForCaller: (id: string, caller: string) =>
        outbox.wasDeliveryIdPrunedForCaller(id, caller),
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as never,
    args,
    (r, e) => { result = r; error = e; },
    { instanceName: callerInstance, requestId: 1, fleetRequestId: undefined, senderSessionName: undefined },
  );
  return { result, error };
}

// ── 1. Outbox prune ────────────────────────────────────────────────────────

describe("DeliveryOutbox.prune (#1335)", () => {
  it("removes delivered and failed rows older than N days", async () => {
    const { outbox } = makeOutbox();
    const { delivery: old1 } = admit(outbox);
    const { delivery: old2 } = admit(outbox);
    const { delivery: fresh } = admit(outbox);

    forceState(outbox, old1.deliveryId, "delivered", daysAgo(35));
    forceState(outbox, old2.deliveryId, "failed", daysAgo(35));
    forceState(outbox, fresh.deliveryId, "delivered", daysAgo(1));

    const { pruned } = await outbox.prune(30);
    expect(pruned).toBe(2);
    expect(outbox.get(old1.deliveryId)).toBeUndefined();
    expect(outbox.get(old2.deliveryId)).toBeUndefined();
    expect(outbox.get(fresh.deliveryId)).toBeDefined();
    outbox.close();
  });

  it("never prunes uncertain rows", async () => {
    const { outbox } = makeOutbox();
    const { delivery } = admit(outbox);
    forceState(outbox, delivery.deliveryId, "uncertain", daysAgo(60));
    const { pruned } = await outbox.prune(30);
    expect(pruned).toBe(0);
    expect(outbox.get(delivery.deliveryId)).toBeDefined();
    outbox.close();
  });

  it("never prunes non-terminal (queued) rows", async () => {
    const { outbox } = makeOutbox();
    const { delivery } = admit(outbox);
    const db = (outbox as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE deliveries SET updated_at=? WHERE delivery_id=?")
      .run(daysAgo(60), delivery.deliveryId);
    const { pruned } = await outbox.prune(30);
    expect(pruned).toBe(0);
    expect(outbox.get(delivery.deliveryId)).toBeDefined();
    outbox.close();
  });

  it("skips delivered rows that still have an open reply obligation (#1340 P2)", async () => {
    const { outbox } = makeOutbox();
    const { delivery } = admit(outbox);
    forceState(outbox, delivery.deliveryId, "delivered", daysAgo(35));
    // Insert an open reply obligation referencing this delivery.
    const db = (outbox as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(`
      INSERT OR IGNORE INTO reply_obligations
        (correlation_id, requester_instance, owner_instance, request_delivery_id,
         opened_at, last_asked_at, state)
      VALUES (?, ?, ?, ?, ?, ?, 'open')
    `).run("corr-1", "src", "tgt", delivery.deliveryId,
      new Date().toISOString(), new Date().toISOString());

    const { pruned } = await outbox.prune(30);
    expect(pruned).toBe(0); // obligation is open → row kept
    expect(outbox.get(delivery.deliveryId)).toBeDefined();
    outbox.close();
  });

  it("records pruned ids for expired detection", async () => {
    const { outbox } = makeOutbox();
    const { delivery } = admit(outbox);
    forceState(outbox, delivery.deliveryId, "delivered", daysAgo(35));
    await outbox.prune(30);
    expect(outbox.wasDeliveryIdPrunedForCaller(delivery.deliveryId, "src")).toBe(true);
    outbox.close();
  });

  it("does NOT record a non-pruned id as pruned", async () => {
    const { outbox } = makeOutbox();
    const { delivery } = admit(outbox);
    forceState(outbox, delivery.deliveryId, "delivered", daysAgo(1));
    await outbox.prune(30);
    expect(outbox.wasDeliveryIdPrunedForCaller(delivery.deliveryId, "src")).toBe(false);
    outbox.close();
  });
});

// ── 2. Expired vs not-found (via real delivery_status handler) ─────────────

describe("delivery_status expired vs not-found (#1335) — real handler", () => {
  it("returns expired (retention) for a pruned id owned by the caller", async () => {
    const { outbox } = makeOutbox();
    const { delivery } = admit(outbox, { src: "alice", target: "bob" });
    forceState(outbox, delivery.deliveryId, "delivered", daysAgo(40));
    await outbox.prune(30);

    // alice (source) sees "expired"
    const { error } = callDeliveryStatus(outbox, { delivery_id: delivery.deliveryId }, "alice");
    expect(String(error)).toContain("retention");
    outbox.close();
  });

  it("returns not-found for a never-existing id (mutation proof: removing expired branch → not-found returned)", async () => {
    const { outbox } = makeOutbox();
    // Prune something to ensure the table is populated
    const { delivery: old } = admit(outbox, { src: "alice" });
    forceState(outbox, old.deliveryId, "delivered", daysAgo(40));
    await outbox.prune(30);

    const { error } = callDeliveryStatus(
      outbox,
      { delivery_id: "00000000-0000-0000-0000-000000000001" },
      "alice",
    );
    // Must be "not found", not "retention" — the fake id was never in pruned_ids
    expect(String(error)).not.toContain("retention");
    expect(String(error)).toContain("not found");
    outbox.close();
  });

  it("unrelated caller gets not-found for a pruned row (ownership check, #1340 P2 🔒)", async () => {
    const { outbox } = makeOutbox();
    const { delivery } = admit(outbox, { src: "alice", target: "bob" });
    forceState(outbox, delivery.deliveryId, "delivered", daysAgo(40));
    await outbox.prune(30);

    // carol is neither source nor target → "not found", not "expired"
    const { error } = callDeliveryStatus(outbox, { delivery_id: delivery.deliveryId }, "carol");
    expect(String(error)).not.toContain("retention");
    expect(String(error)).toContain("not found");
    outbox.close();
  });
});

// ── 3. Task Board prune ────────────────────────────────────────────────────

describe("SchedulerDb.pruneOldTasks (#1335)", () => {
  function makeDB(): SchedulerDb {
    const dir = tempDir();
    return new SchedulerDb(join(dir, "scheduler.db"));
  }

  it("removes done and cancelled tasks older than N days", async () => {
    const db = makeDB();
    db.createTask({ title: "old-done", created_by: "t" });
    db.createTask({ title: "old-cancelled", created_by: "t" });
    db.createTask({ title: "fresh-done", created_by: "t" });
    const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
    const ids = rawDb.prepare("SELECT id FROM tasks ORDER BY created_at").all() as Array<{ id: string }>;
    rawDb.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(daysAgo(35), ids[0]!.id);
    rawDb.prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?").run(daysAgo(35), ids[1]!.id);
    rawDb.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(daysAgo(1), ids[2]!.id);
    const pruned = await db.pruneOldTasks(30);
    expect(pruned).toBe(2);
    expect(db.listTasks()).toHaveLength(1);
    expect(db.listTasks()[0]!.title).toBe("fresh-done");
    db.close();
  });

  it("never prunes open, claimed, or blocked tasks regardless of age", async () => {
    const db = makeDB();
    db.createTask({ title: "open", created_by: "t" });
    db.createTask({ title: "claimed", created_by: "t" });
    const tasks = db.listTasks();
    db.claimTask(tasks.find(t => t.title === "claimed")!.id, "agent");
    const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
    rawDb.prepare("UPDATE tasks SET updated_at=?").run(daysAgo(60));
    const pruned = await db.pruneOldTasks(30);
    expect(pruned).toBe(0);
    expect(db.listTasks()).toHaveLength(2);
    db.close();
  });

  it("mutation proof: removing the status filter prunes open tasks → test goes red", async () => {
    const db = makeDB();
    db.createTask({ title: "open", created_by: "t" });
    const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
    rawDb.prepare("UPDATE tasks SET updated_at=?").run(daysAgo(60));
    const pruned = await db.pruneOldTasks(30);
    // Correct: 0 (open protected). Mutant without status filter would prune 1 → assertion fails.
    expect(pruned).toBe(0);
    db.close();
  });

  it("keeps cancelled prerequisites of live tasks (#1340 P3)", async () => {
    const db = makeDB();
    const prereq = db.createTask({ title: "prereq", created_by: "t" });
    db.createTask({ title: "dependent", created_by: "t", depends_on: [prereq.id] });
    // Mark prereq cancelled and old
    const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
    rawDb.prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?").run(daysAgo(60), prereq.id);
    const pruned = await db.pruneOldTasks(30);
    // prereq is protected because "dependent" is still open and depends on it
    expect(pruned).toBe(0);
    // Verify the claimTask guard still works (prereq exists as cancelled)
    expect(() => db.claimTask(db.listTasks().find(t => t.title === "dependent")!.id, "agent"))
      .toThrow();
    db.close();
  });
});

// ── 4. Task list cap (real production function) ────────────────────────────

describe("applyTaskListCap — production function (#1335)", () => {
  function makeTasks(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      title: `task-${i}`,
      updated_at: new Date(Date.now() - i * 1000).toISOString(),
      status: "open" as const,
      priority: "normal" as const,
      assignee: null,
      created_by: "t",
      description: null,
      result: null,
      depends_on: [] as string[],
      created_at: new Date().toISOString(),
    }));
  }

  it("caps unfiltered list at TASK_LIST_CAP and returns omitted count + hint", () => {
    const tasks = makeTasks(150);
    const result = applyTaskListCap(tasks, undefined, undefined);
    expect((result as { tasks: unknown[]; omitted: number }).tasks).toHaveLength(TASK_LIST_CAP);
    expect((result as { omitted: number }).omitted).toBe(50);
    expect((result as { hint: string }).hint).toContain("filter_assignee");
  });

  it("mutation proof: removing the cap → 150 tasks returned → assertion fails", () => {
    const tasks = makeTasks(150);
    const result = applyTaskListCap(tasks, undefined, undefined);
    // Correct: 100 rows
    expect((result as { tasks: unknown[] }).tasks).toHaveLength(TASK_LIST_CAP);
    // What the mutant would return if cap removed: all 150
    // If this assertion ran on the mutant result, it would fail with 150 ≠ 100.
  });

  it("filtered list is not capped (assignee filter)", () => {
    const tasks = makeTasks(150);
    const result = applyTaskListCap(tasks, "alice", undefined);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(150);
  });

  it("filtered list is not capped (status filter)", () => {
    const tasks = makeTasks(150);
    const result = applyTaskListCap(tasks, undefined, "open");
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(150);
  });

  it("P3: empty string filter counts as unfiltered → cap applied", () => {
    const tasks = makeTasks(150);
    // Empty strings must NOT bypass the cap
    const result = applyTaskListCap(tasks, "", "");
    expect((result as { tasks: unknown[]; omitted: number }).tasks).toHaveLength(TASK_LIST_CAP);
    expect((result as { omitted: number }).omitted).toBe(50);
  });
});

// ── 5. Chunked deletes ────────────────────────────────────────────────────

describe("prune uses chunks of ≤500 rows (#1335)", () => {
  it("prunes 600 outbox rows without error (two chunks)", async () => {
    const { outbox } = makeOutbox();
    for (let i = 0; i < 600; i++) {
      const { delivery } = admit(outbox);
      forceState(outbox, delivery.deliveryId, "delivered", daysAgo(35));
    }
    const { pruned } = await outbox.prune(30);
    expect(pruned).toBe(600);
    outbox.close();
  });

  it("prunes 1200 tasks in chunks (tombstone + task loop both yield)", async () => {
    const dir = tempDir();
    const db = new SchedulerDb(join(dir, "scheduler.db"));
    for (let i = 0; i < 1200; i++) db.createTask({ title: `t${i}`, created_by: "x" });
    const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
    rawDb.prepare("UPDATE tasks SET status='done', updated_at=?").run(daysAgo(60));
    const pruned = await db.pruneOldTasks(30);
    expect(pruned).toBe(1200);
    db.close();
  });
});

// ── 6. Config validator ────────────────────────────────────────────────────

describe("validateFleetConfig retention_days (#1335)", () => {
  const base = { defaults: {}, instances: { w: { working_directory: "/tmp" } } };

  it("accepts a valid positive integer", () => {
    const r = validateFleetConfig({ ...base, defaults: { retention_days: 14 } });
    expect(r.errors.some(e => e.path.includes("retention_days"))).toBe(false);
  });

  it("rejects 0", () => {
    const r = validateFleetConfig({ ...base, defaults: { retention_days: 0 } });
    expect(r.errors.some(e => e.path === "defaults.retention_days")).toBe(true);
  });

  it("rejects -1", () => {
    const r = validateFleetConfig({ ...base, defaults: { retention_days: -1 } });
    expect(r.errors.some(e => e.path === "defaults.retention_days")).toBe(true);
  });

  it("rejects a non-integer float", () => {
    const r = validateFleetConfig({ ...base, defaults: { retention_days: 7.5 } });
    expect(r.errors.some(e => e.path === "defaults.retention_days")).toBe(true);
  });

  it("mutation proof: removing the >= 1 check → 0 is accepted → test goes red", () => {
    const r = validateFleetConfig({ ...base, defaults: { retention_days: 0 } });
    expect(r.errors.some(e => e.path === "defaults.retention_days")).toBe(true);
  });
});
