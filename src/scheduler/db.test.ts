import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SchedulerDb } from "./db.js";

describe("SchedulerDb", () => {
  let dir: string;
  let db: SchedulerDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    db = new SchedulerDb(join(dir, "scheduler.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates tables on init", () => {
    const schedules = db.list();
    expect(schedules).toEqual([]);
  });

  it("creates and retrieves a schedule", () => {
    const s = db.create({
      cron: "0 7 * * *",
      message: "test message",
      source: "proj-a",
      target: "proj-a",
      reply_chat_id: "-100123",
      reply_thread_id: "42",
      label: "daily test",
      timezone: "Asia/Taipei",
    });

    expect(s.id).toBeTruthy();
    expect(s.cron).toBe("0 7 * * *");
    expect(s.enabled).toBe(true);

    const fetched = db.get(s.id);
    expect(fetched).toEqual(s);
  });

  it("creates and lists a one-shot schedule with nullable cron", () => {
    const at = "2026-07-26T14:00:00+08:00";
    const schedule = db.create({
      at,
      message: "one time",
      source: "proj-a",
      target: "proj-a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });

    expect(schedule.cron).toBeNull();
    expect(schedule.at).toBe(at);
    expect(db.list()).toEqual([schedule]);
  });

  it("migrates legacy NOT NULL cron tables without losing schedules or runs", () => {
    const dbPath = join(dir, "scheduler.db");
    db.close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE schedule_runs;
      DROP TABLE schedules;
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY, cron TEXT NOT NULL, message TEXT NOT NULL,
        source TEXT NOT NULL, target TEXT NOT NULL, reply_chat_id TEXT NOT NULL,
        reply_thread_id TEXT, label TEXT, enabled INTEGER DEFAULT 1,
        timezone TEXT DEFAULT 'Asia/Taipei', created_at TEXT NOT NULL,
        last_triggered_at TEXT, last_status TEXT
      );
      CREATE TABLE schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL, detail TEXT
      );
      INSERT INTO schedules
        (id, cron, message, source, target, reply_chat_id, created_at)
      VALUES ('legacy', '0 7 * * *', 'hello', 'a', 'a', '1', '2026-01-01T00:00:00.000Z');
      INSERT INTO schedule_runs (schedule_id, status) VALUES ('legacy', 'delivered');
    `);
    legacy.close();

    db = new SchedulerDb(dbPath);
    const columns = db["db"].prepare("PRAGMA table_info(schedules)").all() as Array<{ name: string; notnull: number }>;
    expect(columns.find(column => column.name === "cron")?.notnull).toBe(0);
    expect(columns.some(column => column.name === "at")).toBe(true);
    expect(db.get("legacy")).toMatchObject({ cron: "0 7 * * *", at: null });
    expect(db.getRuns("legacy")).toHaveLength(1);

    db.delete("legacy");
    expect(db.getRuns("legacy")).toHaveLength(0);
  });

  it("lists schedules with optional target filter", () => {
    db.create({ cron: "0 7 * * *", message: "a", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    db.create({ cron: "0 8 * * *", message: "b", source: "a", target: "b", reply_chat_id: "1", reply_thread_id: null });

    expect(db.list()).toHaveLength(2);
    expect(db.list("a")).toHaveLength(1);
    expect(db.list("b")).toHaveLength(1);
  });

  it("updates a schedule", () => {
    const s = db.create({ cron: "0 7 * * *", message: "old", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    const updated = db.update(s.id, { message: "new", enabled: false });

    expect(updated.message).toBe("new");
    expect(updated.enabled).toBe(false);
    expect(updated.cron).toBe("0 7 * * *");
  });

  it("deletes a schedule and cascades runs", () => {
    const s = db.create({ cron: "0 7 * * *", message: "x", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    db.recordRun(s.id, "delivered");
    expect(db.getRuns(s.id)).toHaveLength(1);

    db.delete(s.id);
    expect(db.get(s.id)).toBeNull();
    expect(db.getRuns(s.id)).toHaveLength(0);
  });

  it("deleteByInstanceOrThread removes matching schedules", () => {
    db.create({ cron: "0 7 * * *", message: "a", source: "a", target: "proj-a", reply_chat_id: "1", reply_thread_id: "42" });
    db.create({ cron: "0 8 * * *", message: "b", source: "b", target: "proj-b", reply_chat_id: "1", reply_thread_id: "42" });
    db.create({ cron: "0 9 * * *", message: "c", source: "c", target: "proj-c", reply_chat_id: "1", reply_thread_id: "99" });

    const count = db.deleteByInstanceOrThread("proj-a", "42");
    expect(count).toBe(2);
    expect(db.list()).toHaveLength(1);
  });

  it("records and retrieves runs", () => {
    const s = db.create({ cron: "0 7 * * *", message: "x", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    db.recordRun(s.id, "delivered");
    db.recordRun(s.id, "instance_offline", "retry 3x failed");

    const runs = db.getRuns(s.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("instance_offline");
    expect(runs[0].detail).toBe("retry 3x failed");
  });

  it("enforces max schedule count", () => {
    for (let i = 0; i < 5; i++) {
      db.create({ cron: "0 7 * * *", message: `m${i}`, source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    }
    expect(() =>
      db.create({ cron: "0 7 * * *", message: "over", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null }, 5)
    ).toThrow(/limit/i);
  });

  it("prunes old runs on init", () => {
    const s = db.create({ cron: "0 7 * * *", message: "x", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    db["db"].prepare(
      "INSERT INTO schedule_runs (schedule_id, triggered_at, status) VALUES (?, datetime('now', '-60 days'), 'delivered')"
    ).run(s.id);
    db.recordRun(s.id, "delivered");

    db.pruneOldRuns();
    const runs = db.getRuns(s.id);
    expect(runs).toHaveLength(1);
  });
});
