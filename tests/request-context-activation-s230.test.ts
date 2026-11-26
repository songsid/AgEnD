import { mkdtempSync, writeFileSync, rmSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { commitRequestContextActivation, readRequestContextActivations, requestContextGoBackAllowed, type RequestContextActivationRecord } from "../src/request-context-activation.js";
import { registerRequestContextDispatcher } from "../src/request-context-compatibility.js";
const close: Database.Database[] = [];
const homes: string[] = [];
afterEach(() => { for (const db of close.splice(0)) if (db.open) db.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function snapshot(db: Database.Database, readonly = true) {
  const dir = mkdtempSync(join(tmpdir(), "activation-snapshot-")); homes.push(dir);
  const path = join(dir, "outbox.db"); writeFileSync(path, db.serialize());
  const result = new Database(path, { readonly, fileMustExist: true }); close.push(result); return result;
}
function rig() {
  const db = new Database(":memory:"); close.push(db); db.exec("CREATE TABLE deliveries(id TEXT); CREATE TABLE delivery_attempts(id TEXT)");
  registerRequestContextDispatcher(db, 1);
  const id = "20261126T010203Z-0a1b2c3d";
  const value: RequestContextActivationRecord = { epoch: "epoch-1", owner: "fleet-fixture", activatedAt: 2000, invalidates: [id], offeredLatestDeadline: 9000 };
  return { db, id, value, lease: { current: () => true, release() {} } };
}
it("floor, activation and Go back invalidation commit together without a retained.json cache write", () => {
  const r = rig(); expect(readRequestContextActivations(r.db)).toEqual([]);
  commitRequestContextActivation(r.db, r.value, r.lease, () => true);
  expect(readRequestContextActivations(r.db)).toEqual([r.value]);
  expect(requestContextGoBackAllowed(r.db, r.id, 1000)).toBe(false);
  expect(requestContextGoBackAllowed(r.db, "20261126T010204Z-deadbeef", 1000)).toBe(false);
  expect(requestContextGoBackAllowed(r.db, "20261126T010205Z-deadbeef", 3000, snapshot(r.db))).toBe(true);
  expect(() => r.db.exec("DELETE FROM request_context_activations_v1")).toThrow(/immutable/);
});
it("a changed readiness or offered set at COMMIT rolls back the marker and the compatibility floor", () => {
  const r = rig(); let calls = 0;
  expect(() => commitRequestContextActivation(r.db, r.value, r.lease, () => ++calls === 1)).toThrow(/changed/);
  expect(readRequestContextActivations(r.db)).toEqual([]);
  expect(r.db.prepare("SELECT 1 FROM sqlite_master WHERE name='request_context_compatibility'").get()).toBeUndefined();
});
it("a lost update exclusion cannot activate, including at final COMMIT", () => {
  const r = rig(); let calls = 0;
  expect(() => commitRequestContextActivation(r.db, r.value, { current: () => ++calls === 1, release() {} }, () => true)).toThrow(/changed/);
  expect(readRequestContextActivations(r.db)).toEqual([]);
});
it("malformed activation history or an active floor with no history refuses Go back", () => {
  const r = rig(); r.db.exec("CREATE TABLE request_context_compatibility(singleton INTEGER PRIMARY KEY, required_dispatch_version INTEGER)");
  expect(() => requestContextGoBackAllowed(r.db, r.id, 1000)).toThrow(/unavailable/);
  r.db.exec("DROP TABLE request_context_compatibility");
  commitRequestContextActivation(r.db, r.value, r.lease, () => true);
  r.db.exec("DROP TRIGGER request_context_activation_no_update; UPDATE request_context_activations_v1 SET invalidates_json='{}'");
  expect(() => requestContextGoBackAllowed(r.db, r.id, 1000)).toThrow();
});
it("confirmation data cannot silently omit a window deadline or contain duplicate attempt ids", () => {
  const r = rig();
  expect(() => commitRequestContextActivation(r.db, { ...r.value, offeredLatestDeadline: null }, r.lease, () => true)).toThrow();
  expect(() => commitRequestContextActivation(r.db, { ...r.value, invalidates: [r.id, r.id] }, r.lease, () => true)).toThrow();
  expect(readRequestContextActivations(r.db)).toEqual([]);
});
it("a backwards clock cannot permit an unlisted pre-activation snapshot", () => {
  const r = rig(), before = snapshot(r.db); commitRequestContextActivation(r.db, r.value, r.lease, () => true);
  // Actual order: update committed at wall time 3000, then activation after clock rollback at 2000.
  // The invalidation list is defense in depth; an omitted entry must never make this snapshot safe.
  expect(requestContextGoBackAllowed(r.db, "20261126T010206Z-deadbeef", 3000, before)).toBe(false);
  expect(requestContextGoBackAllowed(r.db, "20261126T010206Z-deadbeef", 3000)).toBe(false);
});

it("post-activation snapshots remain safe across clock shifts; missing or altered history is refused", () => {
  const r = rig(); commitRequestContextActivation(r.db, r.value, r.lease, () => true);
  const good = snapshot(r.db), writable = snapshot(r.db, false), id = "20261126T010207Z-deadbeef";
  for (const stamp of [0, 1000, 2000, 3000]) expect(requestContextGoBackAllowed(r.db, id, stamp, good)).toBe(true);
  expect(requestContextGoBackAllowed(r.db, r.id, 0, good)).toBe(false);
  expect(requestContextGoBackAllowed(r.db, id, 3000, r.db)).toBe(false);
  expect(requestContextGoBackAllowed(r.db, id, 3000, writable)).toBe(false);
  writable.exec("DROP TRIGGER request_context_activation_no_update; UPDATE request_context_activations_v1 SET owner='changed'");
  expect(requestContextGoBackAllowed(r.db, id, 3000, snapshot(writable))).toBe(false);
  writable.exec("UPDATE request_context_activations_v1 SET invalidates_json='{}'");
  expect(() => requestContextGoBackAllowed(r.db, id, 3000, snapshot(writable))).toThrow();
});
it("an older activated snapshot cannot erase a later activation epoch, even with a future timestamp", () => {
  const r = rig(); commitRequestContextActivation(r.db, r.value, r.lease, () => true);
  const old = snapshot(r.db), id = "20261126T010208Z-deadbeef";
  commitRequestContextActivation(r.db, { ...r.value, epoch: "epoch-2", activatedAt: 1000, invalidates: [], offeredLatestDeadline: null }, r.lease, () => true);
  expect(requestContextGoBackAllowed(r.db, id, 99999, old)).toBe(false);
  expect(requestContextGoBackAllowed(r.db, id, 0, snapshot(r.db))).toBe(true);
});

it("a verified private copy can inspect a WAL snapshot without changing the immutable snapshot tree", () => {
  const r = rig(); commitRequestContextActivation(r.db, r.value, r.lease, () => true);
  const source = snapshot(r.db, false), path = source.name; source.pragma("journal_mode = WAL");
  source.pragma("wal_checkpoint(TRUNCATE)"); source.close();
  const directory = dirname(path), files = readdirSync(directory);
  const before = readFileSync(path), digest = createHash("sha256").update(before).digest("hex");
  expect(before[18]).toBe(2); // WAL header survives the checkpointed standalone .db.
  const scratch = mkdtempSync(join(tmpdir(), "verified-snapshot-copy-")); homes.push(scratch);
  const copy = join(scratch, "outbox.db"); copyFileSync(path, copy);
  expect(createHash("sha256").update(readFileSync(copy)).digest("hex")).toBe(digest);
  const candidate = new Database(copy, { readonly: true, fileMustExist: true }); close.push(candidate);
  expect(requestContextGoBackAllowed(r.db, "20261126T010209Z-deadbeef", 0, candidate)).toBe(true);
  expect(readdirSync(directory)).toEqual(files);
  expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(digest);
});
