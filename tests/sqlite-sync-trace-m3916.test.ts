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

  it("a traced transaction keeps better-sqlite3's whole API graph: every version, database, enumerability (Prism #4615)", () => {
    const base = slowDb("baseline.db");
    const plain = base.transaction(() => 1);
    const plainKeys = Reflect.ownKeys(plain).map(String).sort();
    const plainEnum = Object.keys(plain).sort();
    installSqliteSyncTrace({ [SQLITE_SYNC_TRACE_ENV]: "1" });
    const db = slowDb("scheduler.db");
    const tx = db.transaction(() => 1) as any;
    expect(Reflect.ownKeys(tx).map(String).sort()).toEqual(plainKeys);
    expect(Object.keys(tx).sort()).toEqual(plainEnum);
    expect(tx.database).toBe(db);
    expect(tx.default).toBe(tx);
    for (const a of ["default", "deferred", "immediate", "exclusive"]) for (const b of ["default", "deferred", "immediate", "exclusive", "database"]) {
      expect(tx[a][b]).toBe(tx[b]);
    }
    expect(tx.immediate.exclusive).toBe(tx.exclusive);
    expect(tx.exclusive.database).toBe(db);
    base.close(); db.close();
  });

  it("this, arguments and the result pass through every version; each version is labelled", () => {
    installSqliteSyncTrace({ [SQLITE_SYNC_TRACE_ENV]: "1" });
    const db = slowDb("profiles.db");
    const ins = db.prepare("INSERT INTO t VALUES (spin(?))");
    const self = { tag: "me" };
    const tx = db.transaction(function (this: unknown, a: number, b: number) { ins.run(60); return { self: this, sum: a + b }; }) as any;
    for (const mode of ["default", "deferred", "immediate", "exclusive"]) {
      resetSyncWorkAttributionForTests();
      const out = tx[mode].call(self, 2, 3);
      expect(out.self).toBe(self);
      expect(out.sum).toBe(5);
      expect(work().map(w => w.caller)).toEqual(["sqlite:profiles.db"]);
    }
    expect((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(4);
    db.close();
  });

  it("an error propagates unchanged and the transaction rolls back; a nested transaction still works", () => {
    installSqliteSyncTrace({ [SQLITE_SYNC_TRACE_ENV]: "1" });
    const db = slowDb("events.db");
    const ins = db.prepare("INSERT INTO t VALUES (?)");
    const boom = new Error("boom");
    const failing = db.transaction(() => { ins.run(1); throw boom; });
    let caught: unknown;
    try { failing(); } catch (e) { caught = e; }
    expect(caught).toBe(boom);
    expect((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(0);
    const inner = db.transaction(() => { ins.run(2); });
    const outer = db.transaction(() => { ins.run(1); inner(); });
    outer.immediate();
    expect((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(2);
    db.close();
  });

  it("labels: file name only; in-memory databases say so", () => {
    expect(sqliteTraceLabel("/home/x/.agend/scheduler.db")).toBe("sqlite:scheduler.db");
    expect(sqliteTraceLabel(":memory:")).toBe("sqlite:memory");
    expect(sqliteTraceLabel(undefined)).toBe("sqlite:memory");
  });
});
