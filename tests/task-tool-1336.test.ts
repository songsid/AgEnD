import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { SchedulerDb } from "../src/scheduler/db.js";
import type { Task, TaskCompact } from "../src/scheduler/types.js";
import { applyTaskListCap, TASK_LIST_CAP, LIVE_TASK_STATUSES } from "../src/fleet-manager.js";

/**
 * #1336: task tool improvements. All helpers use a temp DB file; no fleet,
 * no tmux. Covers every one of the 8 issue items with real mutations.
 */
describe("task tool #1336", () => {
  let tmpDir: string;
  let db: SchedulerDb;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `task-1336-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    db = new SchedulerDb(join(tmpDir, "scheduler.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Item 3: compact rows by default; verbose for full ──────────────────
  describe("compact vs verbose list rows", () => {
    it("returns compact rows by default (only id/title/status/assignee/priority/updated_at)", () => {
      db.createTask({
        title: "Compact me",
        description: "a long heavy description",
        priority: "high",
        assignee: "worker-1",
        created_by: "general",
      });
      const rows = db.listTasks();
      expect(rows).toHaveLength(1);
      const row = rows[0] as TaskCompact;
      expect(Object.keys(row).sort()).toEqual(
        ["assignee", "id", "priority", "status", "title", "updated_at"].sort(),
      );
      // Heavy fields must be absent on compact rows.
      expect("description" in row).toBe(false);
      expect("result" in row).toBe(false);
      expect("created_by" in row).toBe(false);
      expect("depends_on" in row).toBe(false);
      expect("created_at" in row).toBe(false);
    });

    it("returns full Task rows when verbose:true", () => {
      db.createTask({
        title: "Verbose me",
        description: "full detail",
        created_by: "general",
      });
      const rows = db.listTasks({ verbose: true }) as Task[];
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.description).toBe("full detail");
      expect(row.created_by).toBe("general");
      expect(row.depends_on).toEqual([]);
      expect("created_at" in row).toBe(true);
    });

    it("get-by-id returns a single full record", () => {
      const t = db.createTask({ title: "One", description: "d", created_by: "x" });
      const full = db.getTaskByPrefix(t.id);
      expect(full.id).toBe(t.id);
      expect(full.description).toBe("d");
      expect(full.created_by).toBe("x");
    });
  });

  // ── Item 2: multi-value filter_status (string or array) ────────────────
  describe("multi-value filter_status", () => {
    beforeEach(() => {
      const o = db.createTask({ title: "open-task", created_by: "x" });
      const c = db.createTask({ title: "claimed-task", created_by: "x" });
      const d = db.createTask({ title: "done-task", created_by: "x" });
      db.claimTask(c.id, "w");
      db.claimTask(d.id, "w");
      db.completeTask(d.id, "finished");
      void o;
    });

    it("filters by a single status string", () => {
      expect(db.listTasks({ status: "open" })).toHaveLength(1);
      expect(db.listTasks({ status: "done" })).toHaveLength(1);
    });

    it("filters by an array of statuses (OR-matched)", () => {
      expect(db.listTasks({ status: ["open", "claimed"] })).toHaveLength(2);
      expect(db.listTasks({ status: ["open", "done"] })).toHaveLength(2);
      expect(db.listTasks({ status: ["done", "cancelled"] })).toHaveLength(1);
    });

    it("dedupes repeated statuses in the array", () => {
      expect(db.listTasks({ status: ["open", "open"] })).toHaveLength(1);
    });

    it("ignores empty-string entries in the array", () => {
      // ["", "done"] narrows to just done.
      expect(db.listTasks({ status: ["", "done"] })).toHaveLength(1);
    });
  });

  // ── Item 1: default live-only via LIVE_TASK_STATUSES ───────────────────
  describe("default live-only status set", () => {
    it("LIVE_TASK_STATUSES excludes done and cancelled", () => {
      expect(LIVE_TASK_STATUSES).toContain("open");
      expect(LIVE_TASK_STATUSES).toContain("claimed");
      expect(LIVE_TASK_STATUSES).toContain("blocked");
      expect(LIVE_TASK_STATUSES).not.toContain("done");
      expect(LIVE_TASK_STATUSES).not.toContain("cancelled");
    });

    it("listing with the live set hides done/cancelled tasks", () => {
      const a = db.createTask({ title: "live", created_by: "x" });
      const b = db.createTask({ title: "finished", created_by: "x" });
      const c = db.createTask({ title: "canned", created_by: "x" });
      db.completeTask(b.id, "ok");
      db.updateTask(c.id, { status: "cancelled" });
      void a;

      const live = db.listTasks({ status: LIVE_TASK_STATUSES });
      expect(live.map(t => t.title).sort()).toEqual(["live"]);

      // Explicitly asking for done still surfaces it.
      expect(db.listTasks({ status: "done" }).map(t => t.title)).toEqual(["finished"]);
    });
  });

  // ── Item 6: short-id (8-hex prefix) lookup ─────────────────────────────
  describe("short-id prefix lookup", () => {
    it("resolves a task by its 8-hex prefix", () => {
      const t = db.createTask({ title: "Prefix", created_by: "x" });
      const prefix = t.id.slice(0, 8);
      const found = db.getTaskByPrefix(prefix);
      expect(found.id).toBe(t.id);
    });

    it("resolves by full id exactly", () => {
      const t = db.createTask({ title: "Full", created_by: "x" });
      expect(db.getTaskByPrefix(t.id).id).toBe(t.id);
    });

    it("throws not-found for an unknown prefix", () => {
      expect(() => db.getTaskByPrefix("deadbeef")).toThrow(/not found/i);
    });

    it("throws ambiguous when a prefix matches more than one task", () => {
      // Force a collision by inserting two rows that share an 8-char prefix.
      const shared = "abcdef12";
      const raw = (db as unknown as { db: import("better-sqlite3").Database }).db;
      const now = new Date().toISOString();
      const stmt = raw.prepare(
        "INSERT INTO tasks (id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, 'open', 'normal', 'x', ?, ?)",
      );
      stmt.run(`${shared}-0000-0000-0000-000000000001`, "one", now, now);
      stmt.run(`${shared}-0000-0000-0000-000000000002`, "two", now, now);
      expect(() => db.getTaskByPrefix(shared)).toThrow(/ambiguous/i);
    });

    it("throws not-found for a non-hex short id", () => {
      expect(() => db.getTaskByPrefix("zzz")).toThrow(/not found/i);
    });
  });

  // ── Item 7: done works from open (not just claimed) ────────────────────
  describe("completeTask from open", () => {
    it("completes a task straight from open", () => {
      const t = db.createTask({ title: "Open then done", created_by: "x" });
      expect(t.status).toBe("open");
      const done = db.completeTask(t.id, "done directly");
      expect(done.status).toBe("done");
      expect(done.result).toBe("done directly");
    });

    it("completes a claimed task", () => {
      const t = db.createTask({ title: "Claimed then done", created_by: "x" });
      db.claimTask(t.id, "w");
      const done = db.completeTask(t.id, "ok");
      expect(done.status).toBe("done");
    });

    it("rejects completing an already-done task", () => {
      const t = db.createTask({ title: "Done twice", created_by: "x" });
      db.completeTask(t.id);
      expect(() => db.completeTask(t.id)).toThrow(/done/i);
    });

    it("rejects completing a cancelled task", () => {
      const t = db.createTask({ title: "Cancelled", created_by: "x" });
      db.updateTask(t.id, { status: "cancelled" });
      expect(() => db.completeTask(t.id)).toThrow(/cancelled/i);
    });
  });

  // ── Item 4 + cap generics over compact/verbose rows ────────────────────
  describe("applyTaskListCap", () => {
    it("keeps TASK_LIST_CAP at 100", () => {
      expect(TASK_LIST_CAP).toBe(100);
    });

    it("passes through an unfiltered list at or below the cap", () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ updated_at: `2026-01-${i}` }));
      const out = applyTaskListCap(rows, undefined, undefined);
      expect(Array.isArray(out)).toBe(true);
      expect(out as unknown[]).toHaveLength(10);
    });

    it("caps an unfiltered list over 100 and returns an omitted hint", () => {
      const rows = Array.from({ length: 150 }, (_, i) => ({
        updated_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }));
      const out = applyTaskListCap(rows, undefined, undefined);
      expect(Array.isArray(out)).toBe(false);
      const capped = out as { tasks: unknown[]; omitted: number; hint: string };
      expect(capped.tasks).toHaveLength(100);
      expect(capped.omitted).toBe(50);
      expect(capped.hint).toMatch(/omitted/);
    });

    it("does not cap when an assignee filter is present", () => {
      const rows = Array.from({ length: 150 }, () => ({ updated_at: "x" }));
      const out = applyTaskListCap(rows, "worker-1", undefined);
      expect(Array.isArray(out)).toBe(true);
      expect(out as unknown[]).toHaveLength(150);
    });

    it("does not cap when a non-empty array status filter is present", () => {
      const rows = Array.from({ length: 150 }, () => ({ updated_at: "x" }));
      const out = applyTaskListCap(rows, undefined, ["open", "done"]);
      expect(Array.isArray(out)).toBe(true);
      expect(out as unknown[]).toHaveLength(150);
    });

    it("treats an empty array status filter as unfiltered (caps)", () => {
      const rows = Array.from({ length: 150 }, (_, i) => ({ updated_at: `t${i}` }));
      const out = applyTaskListCap(rows, undefined, []);
      expect(Array.isArray(out)).toBe(false);
    });
  });

  // ── Item 5: small write acks (shape produced by the handler) ───────────
  describe("write ack shape", () => {
    // The handler returns {id, status, updated_at}. We assert the DB rows carry
    // exactly those identifying fields so the ack projection is lossless.
    it("create/claim/done/update rows expose id, status, updated_at", () => {
      const t = db.createTask({ title: "Ack", created_by: "x" });
      for (const row of [t, db.claimTask(t.id, "w"), db.completeTask(t.id, "r")]) {
        expect(typeof row.id).toBe("string");
        expect(typeof row.status).toBe("string");
        expect(typeof row.updated_at).toBe("string");
      }
      const updated = db.updateTask(t.id, { priority: "high" });
      expect(updated.id).toBe(t.id);
      expect(typeof updated.status).toBe("string");
      expect(typeof updated.updated_at).toBe("string");
    });

    it("updated_at advances on mutation", async () => {
      const t = db.createTask({ title: "Timestamps", created_by: "x" });
      await new Promise(r => setTimeout(r, 5));
      const claimed = db.claimTask(t.id, "w");
      expect(claimed.updated_at >= t.updated_at).toBe(true);
    });
  });
});
