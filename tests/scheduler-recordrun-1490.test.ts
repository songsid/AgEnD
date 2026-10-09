/**
 * #1490 P3: recordRun must be atomic — both the schedule_runs INSERT and
 * the schedules UPDATE must commit together or not at all.
 *
 * The transaction is verified by:
 *   (a) confirming both writes succeed together on the happy path, and
 *   (b) a stub that throws after the INSERT, confirming the INSERT is
 *       rolled back (no orphaned row) when the transaction is interrupted.
 *
 * Each test has a reverse-mutation note for removing the transaction wrapper.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SchedulerDb } from "../src/scheduler/db.js";

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTmpDb(): { db: SchedulerDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agend-recordrun-"));
  dirs.push(dir);
  const path = join(dir, "scheduler.db");
  return { db: new SchedulerDb(path), path };
}

function createSchedule(db: SchedulerDb): string {
  return db.create({
    cron: "0 9 * * *",
    message: "hello",
    source: "test",
    target: "dev",
    reply_chat_id: "chat",
    reply_thread_id: null,
    label: "daily",
    timezone: "UTC",
    silent: false,
  }).id;
}

// ── 1. Happy path: both writes commit together ───────────────────────────────
//
// Reverse mutation: splitting into two bare statements still passes this test
// when neither statement throws. This test verifies the observable contract.

describe("SchedulerDb.recordRun (#1490 P3)", () => {
  it("inserts a run record AND updates last_status / last_triggered_at in one call", () => {
    const { db } = makeTmpDb();
    const id = createSchedule(db);

    db.recordRun(id, "queued", "delivery-placeholder");

    // Run row must exist
    const runs = db.getRuns(id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ schedule_id: id, status: "queued", detail: "delivery-placeholder" });

    // Schedule's last_status must be updated in the same call
    const schedule = db.get(id);
    expect(schedule?.last_status).toBe("queued");
    expect(schedule?.last_triggered_at).not.toBeNull();
  });

  // ── 2. Positive control: multiple calls accumulate ───────────────────────

  it("accumulates run records across calls and keeps last_status from the final call", () => {
    const { db } = makeTmpDb();
    const id = createSchedule(db);

    db.recordRun(id, "queued", "d-placeholder-1");
    db.recordRun(id, "delivered", "d-placeholder-2");

    expect(db.getRuns(id, 10)).toHaveLength(2);
    expect(db.get(id)?.last_status).toBe("delivered");
  });

  // ── 3. Atomicity: INSERT rolled back when UPDATE is interrupted ──────────
  //
  // We open the same SQLite file with a raw better-sqlite3 connection and
  // stub the UPDATE statement by replacing the db's prepare() for that
  // specific SQL with a version that throws. Because prepare() is called
  // inside the transaction lambda, the throw happens INSIDE the transaction,
  // so better-sqlite3 rolls back the INSERT.
  //
  // Reverse mutation: removing the this.db.transaction(() => { … })() wrapper
  // (reverting to two bare statements) makes the INSERT commit BEFORE the
  // UPDATE throws, leaving an orphaned row — this assertion then fails because
  // getRuns returns 1 row instead of 0.

  it("rolls back the INSERT when the UPDATE throws inside the transaction", () => {
    const { db, path } = makeTmpDb();
    const id = createSchedule(db);

    // Access the private db via any-cast and intercept prepare() for the UPDATE.
    const rawDb: Database.Database = (db as any).db;
    const origPrepare = rawDb.prepare.bind(rawDb);
    const prepSpy = vi.spyOn(rawDb, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("UPDATE schedules SET last_triggered_at")) {
        // Return a statement whose .run() throws, simulating a mid-transaction error
        return {
          run: () => { throw new Error("simulated UPDATE failure"); },
        } as any;
      }
      return origPrepare(sql);
    });

    expect(() => db.recordRun(id, "queued", "d-placeholder")).toThrow("simulated UPDATE failure");

    prepSpy.mockRestore();

    // No orphaned run row must have been committed
    const runs = db.getRuns(id, 10);
    expect(runs).toHaveLength(0);
  });
});
