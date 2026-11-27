import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { clearHubReadStatements, readHubSqlRow, readHubSqlRows } from "../src/hub/read-statement.js";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
const databases: Database.Database[] = [];
function database() { const db = new Database(":memory:"); databases.push(db); return db; }
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.open) db.close(); });
it("bounds transport preparation while executing fresh SQL and the floor on every read", () => {
  const db = database(); migrateHubTransportStore(db); let floor = 0;
  const read = vi.fn(() => floor), store = new HubTransportStore(db, { floor: { read, raise: n => { floor = n; } }, appendAudit() {} });
  store.initialize(); read.mockClear(); const prepare = vi.spyOn(db, "prepare");
  for (let i = 0; i < 20; i++) expect(store.read().nextLinkEpoch).toBe(0);
  expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT state FROM hub_transport_state WHERE singleton=1")).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(20);
  db.prepare("UPDATE hub_transport_state SET state=json_set(state,'$.nextLinkEpoch',7)").run();
  expect(store.read().nextLinkEpoch).toBe(7);
  floor = 1; expect(() => store.read()).toThrow("uncertain");
});
it("fresh row results and parameter bindings never alias or remember a previous result", () => {
  const db = database(); db.exec("CREATE TABLE values_test(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO values_test VALUES(1,'a'),(2,'b')");
  const sql = "SELECT value FROM values_test WHERE id=?";
  const first = readHubSqlRow(db, sql, 1) as { value: string }; first.value = "changed locally";
  expect(readHubSqlRow(db, sql, 2)).toEqual({ value: "b" });
  db.prepare("UPDATE values_test SET value='fresh' WHERE id=1").run();
  expect(readHubSqlRow(db, sql, 1)).toEqual({ value: "fresh" });
  const all = readHubSqlRows(db, "SELECT value FROM values_test ORDER BY id"); all.length = 0;
  expect(readHubSqlRows(db, "SELECT value FROM values_test ORDER BY id")).toHaveLength(2);
});
it("the same query on two connections remains owned by each connection", () => {
  const a = database(), b = database();
  a.exec("CREATE TABLE t(value); INSERT INTO t VALUES('a')"); b.exec("CREATE TABLE t(value); INSERT INTO t VALUES('b')");
  expect(readHubSqlRow(a, "SELECT value FROM t")).toEqual({ value: "a" });
  expect(readHubSqlRow(b, "SELECT value FROM t")).toEqual({ value: "b" });
  a.close(); expect(() => readHubSqlRow(a, "SELECT value FROM t")).toThrow();
  expect(readHubSqlRow(b, "SELECT value FROM t")).toEqual({ value: "b" });
});
it("schema retirement fails closed and recreation re-executes against the current table", () => {
  const db = database(); db.exec("CREATE TABLE t(value); INSERT INTO t VALUES('before')");
  expect(readHubSqlRow(db, "SELECT value FROM t")).toEqual({ value: "before" });
  db.exec("DROP TABLE t"); expect(() => readHubSqlRow(db, "SELECT value FROM t")).toThrow();
  db.exec("CREATE TABLE t(value); INSERT INTO t VALUES('after')");
  expect(readHubSqlRow(db, "SELECT value FROM t")).toEqual({ value: "after" });
});
it("never executes a write through the read helper", () => {
  const db = database(); db.exec("CREATE TABLE t(value)");
  expect(() => readHubSqlRow(db, "INSERT INTO t VALUES('forbidden') RETURNING value")).toThrow("read-only");
  expect(db.prepare("SELECT count(*) n FROM t").get()).toEqual({ n: 0 });
});
it("failed prepares do not enter the cache and capacity falls back to fresh execution", () => {
  const db = database(), prepare = vi.spyOn(db, "prepare");
  for (let i = 0; i < 2; i++) expect(() => readHubSqlRow(db, "SELECT value FROM absent")).toThrow();
  expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT value FROM absent")).toHaveLength(2);
  for (let i = 0; i < 70; i++) expect(readHubSqlRow(db, `SELECT ${i} value`)).toEqual({ value: i });
  expect(readHubSqlRow(db, "SELECT 69 value")).toEqual({ value: 69 });
  expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT 69 value")).toHaveLength(2);
});

it("clears with its owner and cannot follow a closed file handle into a reopened database", () => {
  const home = mkdtempSync(join(tmpdir(), "hub-read-sql-")), path = join(home, "state.db");
  const first = new Database(path); databases.push(first);
  try {
    first.exec("CREATE TABLE t(value); INSERT INTO t VALUES('before')");
    const prepare = vi.spyOn(first, "prepare"), sql = "SELECT value FROM t";
    expect(readHubSqlRow(first, sql)).toEqual({ value: "before" });
    clearHubReadStatements(first);
    expect(readHubSqlRow(first, sql)).toEqual({ value: "before" }); expect(prepare).toHaveBeenCalledTimes(2);
    clearHubReadStatements(first); first.close();
    const second = new Database(path); databases.push(second); second.exec("UPDATE t SET value='after'");
    expect(() => readHubSqlRow(first, sql)).toThrow("closed");
    expect(readHubSqlRow(second, sql)).toEqual({ value: "after" });
    second.close();
  } finally { if (first.open) first.close(); rmSync(home, { recursive: true, force: true }); }
});
