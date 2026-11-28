/**
 * M-3916: opt-in attribution of synchronous SQLite writes in the stall log. Real better-sqlite3 on temp files; the
 * writes are made slow on purpose (a registered SQL function that spins) so they cross the 50 ms record threshold.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSqliteSyncTrace, restoreSqliteSyncTraceForTests, sqliteTraceLabel, SQLITE_SYNC_TRACE_ENV } from "../src/sqlite-sync-trace.js";
import { resetSyncWorkAttributionForTests, slowSyncWorkSince } from "../src/sync-work-attribution.js";

const dirs: string[] = [];
afterEach(() => { restoreSqliteSyncTraceForTests(); resetSyncWorkAttributionForTests(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function slowDb(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-3916-trace-")); dirs.push(dir);
  const db = new Database(join(dir, name));
  db.function("spin", (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } return ms; });
  db.exec("CREATE TABLE t (v INTEGER)");
  resetSyncWorkAttributionForTests();   // the setup write is not part of what a test measures
  return db;
}
const work = () => slowSyncWorkSince(0, Number.MAX_SAFE_INTEGER);

describe("SQLite write attribution in the stall log (M-3916)", () => {
  it("off by default: nothing is patched and nothing is recorded", () => {
    expect(installSqliteSyncTrace({})).toBe(false);
    const db = slowDb("scheduler.db");
    db.prepare("INSERT INTO t VALUES (spin(80))").run();
    expect(work()).toEqual([]);
    db.close();
  });

  it(`on (${SQLITE_SYNC_TRACE_ENV}=1): a statement's run() is labelled with its database file`, () => {
    expect(installSqliteSyncTrace({ [SQLITE_SYNC_TRACE_ENV]: "1" })).toBe(true);
    const db = slowDb("reply-buttons.db");
    db.prepare("INSERT INTO t VALUES (spin(80))").run();
    expect(work()).toEqual([expect.objectContaining({ caller: "sqlite:reply-buttons.db" })]);
    expect(work()[0]!.durationMs).toBeGreaterThanOrEqual(70);
    db.close();
  });

  it("exec() and a transaction are labelled; a run() inside a transaction is not counted twice", () => {
    installSqliteSyncTrace({ [SQLITE_SYNC_TRACE_ENV]: "1" });
    const a = slowDb("profiles.db");
    a.exec("INSERT INTO t VALUES (spin(60))");
    expect(work().map(w => w.caller)).toEqual(["sqlite:profiles.db"]);
    resetSyncWorkAttributionForTests();
    const b = slowDb("events.db");
    const ins = b.prepare("INSERT INTO t VALUES (spin(40))");
    b.transaction(() => { ins.run(); ins.run(); })();
    const entries = work();
    expect(entries.map(w => w.caller)).toEqual(["sqlite:events.db"]);
    expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(70);
    expect(entries[0]!.durationMs).toBeLessThan(150);   // ~80 ms of spinning, not ~160 (inner runs are not added again)
    expect(entries[0]!.count ?? 1).toBe(1);
    a.close(); b.close();
  });

  it("reads are never timed", () => {
    installSqliteSyncTrace({ [SQLITE_SYNC_TRACE_ENV]: "1" });
    const db = slowDb("search.db");
    db.prepare("SELECT spin(80)").get();
    db.prepare("SELECT spin(80)").all();
    expect(work()).toEqual([]);
    db.close();
  });

  it("installing twice patches once (one entry per write)", () => {
    installSqliteSyncTrace({ [SQLITE_SYNC_TRACE_ENV]: "1" });
    installSqliteSyncTrace({ [SQLITE_SYNC_TRACE_ENV]: "1" });
    const db = slowDb("scheduler.db");
    db.prepare("INSERT INTO t VALUES (spin(60))").run();
    expect(work()).toHaveLength(1);
    expect(work()[0]!.count ?? 1).toBe(1);
    db.close();
  });

  it("labels: file name only; in-memory databases say so", () => {
    expect(sqliteTraceLabel("/home/x/.agend/scheduler.db")).toBe("sqlite:scheduler.db");
    expect(sqliteTraceLabel(":memory:")).toBe("sqlite:memory");
    expect(sqliteTraceLabel(undefined)).toBe("sqlite:memory");
  });
});
