import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { activateRequestContextBarrier, registerRequestContextDispatcher } from "../src/request-context-compatibility.js";
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function file() { const root = mkdtempSync(join(tmpdir(), "request-context-")); roots.push(root); return join(root, "outbox.db"); }
function marker(path: string, version = 1) {
  const old = new DeliveryOutbox(path); old.close();
  const db = new Database(path);
  db.exec("CREATE TABLE request_context_compatibility(singleton INTEGER PRIMARY KEY, required_dispatch_version INTEGER NOT NULL)");
  db.prepare("INSERT INTO request_context_compatibility VALUES (1,?)").run(version); db.close();
}
it("bridge code with enforcement off refuses an active request-context database before legacy initialization", () => {
  const path = file(); marker(path); let opened: DeliveryOutbox | undefined;
  try { expect(() => { opened = new DeliveryOutbox(path); }).toThrow(/request-context dispatch v1/i); }
  finally { opened?.close(); }
});
it("the default-off bridge still opens and recovers an ordinary legacy outbox", () => {
  const path = file(), outbox = new DeliveryOutbox(path);
  expect(outbox.recoverForBoot("new-boot")).toEqual({ queued: 0, reconciliationPending: 0 }); outbox.close();
  const db = new Database(path, { readonly: true });
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'request_context_%'").get()).toEqual({ n: 0 }); db.close();
});

function ready(path: string) { return new DeliveryOutbox(path, "version-1", { requestContextDispatchVersion: 1 }); }
function protectedFile() {
  const path = file(), outbox = ready(path);
  outbox.admit({ operationId: "sample-op", sourceKey: "sample-key", sourceInstance: "source", sourceDaemonBootId: "source-boot",
    targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "Synthetic pending work" } });
  outbox.activateRequestContextBarrier(); outbox.close(); return path;
}
it("enforcement-off cannot activate a persistent downgrade barrier", () => {
  const path = file(), outbox = new DeliveryOutbox(path);
  expect(() => outbox.activateRequestContextBarrier()).toThrow(/dispatch v1 required/); outbox.close();
  const db = new Database(path, { readonly: true });
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='request_context_compatibility' OR name GLOB 'agend_rc_v1_*'").get()).toEqual({ n: 0 }); db.close();
});
it("supported dispatch installs once and reopens, while an old connection cannot write even with zero matches", () => {
  const path = protectedFile(), outbox = ready(path);
  expect(() => outbox.activateRequestContextBarrier()).not.toThrow();
  expect(outbox.recoverForBoot("another-boot")).toEqual({ queued: 0, reconciliationPending: 0 });
  expect(outbox.listPending()).toHaveLength(1); outbox.close();
  const old = new Database(path);
  expect(old.prepare("SELECT count(*) AS n FROM deliveries").get()).toEqual({ n: 1 });
  for (const sql of ["UPDATE deliveries SET state=state WHERE 0", "DELETE FROM deliveries WHERE 0",
    "INSERT INTO deliveries SELECT * FROM deliveries WHERE 0", "DELETE FROM delivery_attempts WHERE 0"]) {
    expect(() => old.prepare(sql).run()).toThrow(/no such function: agend_request_context_dispatch_version/);
  }
  expect(old.prepare("SELECT count(*) AS n FROM deliveries").get()).toEqual({ n: 1 });
  expect(old.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name GLOB 'agend_rc_v1_*'").get()).toEqual({ n: 6 }); old.close();
});
it("the capability-0 bridge refuses before initialization can rewrite the database version", () => {
  const path = protectedFile(), db = new Database(path); db.pragma("user_version = 77"); db.close();
  expect(() => new DeliveryOutbox(path)).toThrow(/dispatch v1 required/);
  const read = new Database(path, { readonly: true }); expect(read.pragma("user_version", { simple: true })).toBe(77);
  expect(read.prepare("SELECT count(*) AS n FROM deliveries").get()).toEqual({ n: 1 }); read.close();
});
it("an unknown required dispatch version is refused, never silently downgraded", () => {
  const path = file(); marker(path, 2);
  expect(() => ready(path)).toThrow(/dispatch v2 required/);
});
it.each(["missing", "changed"])("an active barrier with a %s guard is refused without repairing it", kind => {
  const path = protectedFile(), db = new Database(path);
  db.exec("DROP TRIGGER agend_rc_v1_deliveries_update");
  if (kind === "changed") db.exec("CREATE TRIGGER agend_rc_v1_deliveries_update BEFORE UPDATE ON deliveries BEGIN SELECT 1; END");
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(); db.close();
  expect(() => ready(path)).toThrow(/barrier guard/);
  const read = new Database(path, { readonly: true }); expect(read.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).toEqual(before); read.close();
});
it("orphan guards cannot be mistaken for an inactive legacy database", () => {
  const path = file(), outbox = new DeliveryOutbox(path); outbox.close();
  const db = new Database(path); db.exec("CREATE TRIGGER agend_rc_v1_orphan BEFORE UPDATE ON deliveries BEGIN SELECT 1; END"); db.close();
  expect(() => new DeliveryOutbox(path)).toThrow(/Invalid request-context compatibility barrier/);
});
it("activation failure rolls back both the marker and every created guard", () => {
  const path = file(), db = new Database(path); db.exec("CREATE TABLE deliveries(id TEXT)"); registerRequestContextDispatcher(db, 1);
  expect(() => activateRequestContextBarrier(db, 1)).toThrow(/no such table/);
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='request_context_compatibility' OR name GLOB 'agend_rc_v1_*'").get()).toEqual({ n: 0 }); db.close();
});
it("a declared capability without the matching installed function cannot activate", () => {
  const path = file(), outbox = new DeliveryOutbox(path); outbox.close(); const db = new Database(path);
  registerRequestContextDispatcher(db, 0); expect(() => activateRequestContextBarrier(db, 1)).toThrow(/not installed/);
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='request_context_compatibility'").get()).toEqual({ n: 0 }); db.close();
});
it("a legacy statement prepared before activation cannot execute after the schema barrier commits", () => {
  const path = file(), outbox = ready(path);
  const row = outbox.admit({ operationId: "pre-activation", sourceKey: "pre-activation", sourceInstance: "source", sourceDaemonBootId: "source-boot",
    targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "Synthetic work" } }).delivery;
  const legacy = new Database(path), prepared = legacy.prepare("UPDATE deliveries SET state='delivered' WHERE delivery_id=?");
  outbox.activateRequestContextBarrier();
  expect(() => prepared.run(row.deliveryId)).toThrow(/no such function: agend_request_context_dispatch_version/);
  expect(outbox.get(row.deliveryId)?.state).toBe("queued"); legacy.close(); outbox.close();
});
it("a missing dispatcher result is never accepted as a supported version", () => {
  const path = protectedFile(), raw = new Database(path);
  raw.function("agend_request_context_dispatch_version", () => null);
  expect(() => raw.prepare("UPDATE deliveries SET state='delivered' WHERE operation_id='sample-op'").run()).toThrow(/request-context dispatch v1 required/);
  expect(raw.prepare("SELECT state FROM deliveries WHERE operation_id='sample-op'").get()).toEqual({ state: "queued" }); raw.close();
});
