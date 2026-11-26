import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { commitRequestContextActivation, readRequestContextActivations, requestContextGoBackAllowed, type RequestContextActivationRecord } from "../src/request-context-activation.js";
import { registerRequestContextDispatcher } from "../src/request-context-compatibility.js";
const close: Database.Database[] = [];
afterEach(() => { for (const db of close.splice(0)) db.close(); });
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
  expect(requestContextGoBackAllowed(r.db, "20261126T010205Z-deadbeef", 3000)).toBe(true);
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
