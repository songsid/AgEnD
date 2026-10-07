/**
 * #1336: task tool improvements.
 * Tests call the real production code:
 * - item 1/2/3/4/5: via FleetManager.handleTaskCrudHttp (HTTP handler)
 * - item 6/7: via SchedulerDb.getTaskByPrefix + completeTask directly
 * - agent-cli parser: via the exported normalizeStatusFilter + parsed args
 * No fleet start, no tmux. All helpers use temp DB/dir files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import {
  normalizeStatusFilter,
  applyTaskListCap,
  TASK_LIST_CAP,
  LIVE_TASK_STATUSES,
} from "../src/fleet-manager.js";
import type { TaskCompact } from "../src/scheduler/types.js";

// ── Test helpers ────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = join(tmpdir(), `task-1336-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}

/**
 * Create a minimal FleetManager with a working Scheduler (SchedulerDb is its
 * db property). Does NOT start instances, adapters, or timers — just enough
 * for handleTaskCrudHttp to work.
 */
function makeFleet(): { fm: FleetManager; db: SchedulerDb; dir: string } {
  const dir = tempDir();
  writeFileSync(join(dir, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
  const fm = new FleetManager(dir);
  // Inject a Scheduler with a no-op trigger into the private field.
  const scheduler = new Scheduler(
    join(dir, "scheduler.db"),
    () => {},
    { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 },
    () => false,
  );
  (fm as unknown as Record<string, unknown>).scheduler = scheduler;
  return { fm, db: scheduler.db, dir };
}

/** Call handleTaskCrudHttp and return the result. */
async function call(
  fm: FleetManager,
  action: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return fm.handleTaskCrudHttp("test-instance", { action, ...args });
}

// ── Item 1: live-only default ────────────────────────────────────────────────

describe("item 1 — live-only default (real HTTP handler)", () => {
  it("default list excludes done and cancelled tasks", async () => {
    const { fm, db } = makeFleet();
    const t1 = db.createTask({ title: "open one", created_by: "x" });
    const t2 = db.createTask({ title: "done one", created_by: "x" });
    db.updateTask(t2.id, { status: "done" });
    const result = await call(fm, "list");
    const tasks = Array.isArray(result) ? result : (result as { tasks: unknown[] }).tasks;
    const ids = (tasks as Array<{ id: string }>).map(t => t.id);
    expect(ids).toContain(t1.id);
    expect(ids).not.toContain(t2.id);
  });

  it("mutation proof: removing live-only default returns done tasks → test goes red", async () => {
    const { fm, db } = makeFleet();
    const done = db.createTask({ title: "done one", created_by: "x" });
    db.updateTask(done.id, { status: "done" });
    const result = await call(fm, "list");
    const tasks = Array.isArray(result) ? result : (result as { tasks: unknown[] }).tasks;
    // With live-only: done task not in list. Without it: it would be there.
    expect((tasks as Array<{ id: string }>).some(t => t.id === done.id)).toBe(false);
  });

  it("filter_status=done returns done tasks (explicit override)", async () => {
    const { fm, db } = makeFleet();
    const done = db.createTask({ title: "done one", created_by: "x" });
    db.updateTask(done.id, { status: "done" });
    const result = await call(fm, "list", { filter_status: "done" });
    const tasks = Array.isArray(result) ? result : (result as { tasks: unknown[] }).tasks;
    expect((tasks as Array<{ id: string }>).some(t => t.id === done.id)).toBe(true);
  });
});

// ── Item 2: whitespace/empty filter normalization (P2 fix) ────────────────────

describe("item 2 — whitespace/empty filter normalization (real handler)", () => {
  it("filter_status=' \\t ' is treated as unfiltered (live-only, capped)", async () => {
    const { fm, db } = makeFleet();
    // Create 110 open tasks + 2 done tasks
    for (let i = 0; i < 110; i++) db.createTask({ title: `t${i}`, created_by: "x" });
    const doneTask = db.createTask({ title: "done-one", created_by: "x" });
    db.updateTask(doneTask.id, { status: "done" });

    const result = await call(fm, "list", { filter_status: " \t " });
    const tasks = Array.isArray(result) ? result : (result as { tasks: unknown[]; omitted: number }).tasks;
    // 1. done task must NOT be in result (live-only still active)
    expect((tasks as Array<{ id: string }>).some(t => t.id === doneTask.id)).toBe(false);
    // 2. cap must be active (110 open tasks → 100 returned, 10 omitted)
    expect((tasks as unknown[]).length).toBe(100);
    expect((result as { omitted?: number }).omitted).toBe(10);
  });

  it("filter_status=[' ', '\\t'] is treated as unfiltered (live-only, capped)", async () => {
    const { fm, db } = makeFleet();
    for (let i = 0; i < 110; i++) db.createTask({ title: `t${i}`, created_by: "x" });
    const doneTask = db.createTask({ title: "done-one", created_by: "x" });
    db.updateTask(doneTask.id, { status: "done" });

    const result = await call(fm, "list", { filter_status: [" ", "\t"] });
    const tasks = Array.isArray(result) ? result : (result as { tasks: unknown[]; omitted: number }).tasks;
    expect((tasks as Array<{ id: string }>).some(t => t.id === doneTask.id)).toBe(false);
    expect((tasks as unknown[]).length).toBe(100);
    expect((result as { omitted?: number }).omitted).toBe(10);
  });
});

// ── Item 3: compact rows by default; verbose for full; get action ─────────────

describe("item 3 — compact rows + verbose + get (real HTTP handler)", () => {
  it("list returns compact rows without description/result/created_by", async () => {
    const { fm, db } = makeFleet();
    db.createTask({ title: "c", description: "heavy", created_by: "x" });
    const result = await call(fm, "list");
    const tasks = Array.isArray(result) ? result : (result as { tasks: unknown[] }).tasks;
    const row = (tasks as TaskCompact[])[0]!;
    expect(Object.keys(row).sort()).toEqual(
      ["assignee", "id", "priority", "status", "title", "updated_at"].sort(),
    );
    // Mutation proof: adding description to compact row → this test goes red.
    expect("description" in row).toBe(false);
    expect("result" in row).toBe(false);
    expect("created_by" in row).toBe(false);
  });

  it("verbose:true returns full rows with description", async () => {
    const { fm, db } = makeFleet();
    db.createTask({ title: "v", description: "full desc", created_by: "x" });
    const result = await call(fm, "list", { verbose: true });
    const tasks = Array.isArray(result) ? result : (result as { tasks: unknown[] }).tasks;
    const row = tasks[0] as Record<string, unknown>;
    expect(row["description"]).toBe("full desc");
    expect(row["created_by"]).toBe("x");
  });

  it("get action returns a single full record by prefix", async () => {
    const { fm, db } = makeFleet();
    const t = db.createTask({ title: "full record", description: "detail", created_by: "x" });
    const result = await call(fm, "get", { id: t.id.slice(0, 8) });
    expect((result as { id: string }).id).toBe(t.id);
    expect((result as { description: string }).description).toBe("detail");
    expect((result as { created_by: string }).created_by).toBe("x");
  });

  it("get returns error when id is missing", async () => {
    const { fm } = makeFleet();
    const result = await call(fm, "get");
    expect((result as { error: string }).error).toMatch(/id/i);
  });
});

// ── Item 4: cap remains active via applyTaskListCap ──────────────────────────

describe("item 4 — cap via real handler", () => {
  it("unfiltered list of 110 live tasks → 100 returned, 10 omitted", async () => {
    const { fm, db } = makeFleet();
    for (let i = 0; i < 110; i++) db.createTask({ title: `t${i}`, created_by: "x" });
    const result = await call(fm, "list");
    const tasks = Array.isArray(result) ? result : (result as { tasks: unknown[] }).tasks;
    expect((tasks as unknown[]).length).toBe(100);
    expect((result as { omitted: number }).omitted).toBe(10);
    expect((result as { hint: string }).hint).toContain("filter_assignee");
  });

  it("assignee-filtered list is not capped", async () => {
    const { fm, db } = makeFleet();
    for (let i = 0; i < 110; i++) db.createTask({ title: `t${i}`, assignee: "a", created_by: "x" });
    const result = await call(fm, "list", { filter_assignee: "a" });
    const tasks = Array.isArray(result) ? result : result;
    expect(Array.isArray(tasks)).toBe(true);
    expect((tasks as unknown[]).length).toBe(110);
  });
});

// ── Item 5: small write acks (real HTTP handler) ──────────────────────────────

describe("item 5 — small write acks (real HTTP handler)", () => {
  const ACK_KEYS = ["id", "status", "updated_at"].sort();

  it("create returns exactly {id, status, updated_at}", async () => {
    const { fm } = makeFleet();
    const result = await call(fm, "create", { title: "my task" });
    expect(Object.keys(result as object).sort()).toEqual(ACK_KEYS);
  });

  it("claim returns exactly {id, status, updated_at}", async () => {
    const { fm, db } = makeFleet();
    const t = db.createTask({ title: "t", created_by: "x" });
    const result = await call(fm, "claim", { id: t.id });
    expect(Object.keys(result as object).sort()).toEqual(ACK_KEYS);
    expect((result as { status: string }).status).toBe("claimed");
  });

  it("done returns exactly {id, status, updated_at}", async () => {
    const { fm, db } = makeFleet();
    const t = db.createTask({ title: "t", created_by: "x" });
    db.claimTask(t.id, "x");
    const result = await call(fm, "done", { id: t.id, result: "done" });
    expect(Object.keys(result as object).sort()).toEqual(ACK_KEYS);
    expect((result as { status: string }).status).toBe("done");
  });

  it("update returns exactly {id, status, updated_at}", async () => {
    const { fm, db } = makeFleet();
    const t = db.createTask({ title: "t", created_by: "x" });
    const result = await call(fm, "update", { id: t.id, status: "cancelled" });
    expect(Object.keys(result as object).sort()).toEqual(ACK_KEYS);
  });

  it("mutation proof: ack with full Task object has extra keys → test goes red", async () => {
    const { fm, db } = makeFleet();
    const t = db.createTask({ title: "t", created_by: "x" });
    const result = await call(fm, "claim", { id: t.id });
    // If ack returned full Task, it would have 'title', 'description', 'created_by', etc.
    expect(Object.keys(result as object)).not.toContain("title");
    expect(Object.keys(result as object)).not.toContain("description");
    expect(Object.keys(result as object)).not.toContain("created_by");
  });
});

// ── Item 6: short-id prefix lookup (SchedulerDb.getTaskByPrefix) ─────────────

describe("item 6 — short-id lookup (real DB)", () => {
  let db: SchedulerDb;
  beforeEach(() => { const { db: d } = makeFleet(); db = d; });

  it("resolves by 8-hex prefix", () => {
    const t = db.createTask({ title: "x", created_by: "y" });
    const r = db.getTaskByPrefix(t.id.slice(0, 8));
    expect(r.id).toBe(t.id);
  });

  it("exact full-id match wins over prefix", () => {
    const t = db.createTask({ title: "x", created_by: "y" });
    const r = db.getTaskByPrefix(t.id);
    expect(r.id).toBe(t.id);
  });

  it("throws not-found for unknown prefix", () => {
    expect(() => db.getTaskByPrefix("00000000")).toThrow(/not found/i);
  });

  it("throws ambiguous when prefix matches multiple tasks", () => {
    // Force two tasks with the same first 8 chars by patching their ids.
    const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
    const id1 = "abcdef01-0000-0000-0000-000000000001";
    const id2 = "abcdef01-0000-0000-0000-000000000002";
    const now = new Date().toISOString();
    rawDb.prepare("INSERT INTO tasks (id,title,status,priority,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id1, "one", "open", "normal", "x", now, now);
    rawDb.prepare("INSERT INTO tasks (id,title,status,priority,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id2, "two", "open", "normal", "x", now, now);
    expect(() => db.getTaskByPrefix("abcdef01")).toThrow(/ambiguous/i);
  });
});

// ── Item 7: done from open (SchedulerDb.completeTask) ────────────────────────

describe("item 7 — done from open (real DB)", () => {
  let db: SchedulerDb;
  beforeEach(() => { const { db: d } = makeFleet(); db = d; });

  it("completes a task that is open (without claiming first)", () => {
    const t = db.createTask({ title: "x", created_by: "y" });
    const r = db.completeTask(t.id, "done directly");
    expect(r.status).toBe("done");
    expect(r.result).toBe("done directly");
  });

  it("completes a claimed task normally", () => {
    const t = db.createTask({ title: "x", created_by: "y" });
    db.claimTask(t.id, "agent");
    const r = db.completeTask(t.id);
    expect(r.status).toBe("done");
  });

  it("rejects completing an already-done task", () => {
    const t = db.createTask({ title: "x", created_by: "y" });
    db.completeTask(t.id);
    expect(() => db.completeTask(t.id)).toThrow(/done|cancel|block/i);
  });

  it("rejects completing a cancelled task", () => {
    const t = db.createTask({ title: "x", created_by: "y" });
    db.updateTask(t.id, { status: "cancelled" });
    expect(() => db.completeTask(t.id)).toThrow(/done|cancel|block/i);
  });
});

// ── normalizeStatusFilter shared helper (P2 whitespace fix) ──────────────────

describe("normalizeStatusFilter — shared trim/dedup helper", () => {
  it("trims a string of only whitespace to undefined", () => {
    expect(normalizeStatusFilter(" \t ")).toBeUndefined();
  });
  it("trims each array element and drops whitespace-only entries", () => {
    expect(normalizeStatusFilter([" ", "\t", "open"])).toEqual(["open"]);
  });
  it("dedupes array entries after trim", () => {
    expect(normalizeStatusFilter(["open", "open"])).toEqual(["open"]);
  });
  it("returns undefined for an all-whitespace array", () => {
    expect(normalizeStatusFilter([" ", "\t"])).toBeUndefined();
  });
  it("passes a valid single status through", () => {
    expect(normalizeStatusFilter("done")).toBe("done");
  });
  it("passes a valid array through", () => {
    expect(normalizeStatusFilter(["open", "claimed"])).toEqual(["open", "claimed"]);
  });
});
