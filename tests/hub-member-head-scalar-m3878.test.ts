import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
import { createHubMemberAddressDecision, HUB_MEMBER_ADDRESS_MIGRATION } from "../src/hub/settings-member-address-decision.js";
const dbs: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db); migrateHubTransportStore(db); HUB_MEMBER_ADDRESS_MIGRATION.up(db);
  let floor = 0;
  const readFloor = vi.fn(() => floor);
  const store = new HubTransportStore(db, { floor: { read: readFloor, raise: n => { floor = n; } }, appendAudit() {} });
  store.initialize(); readFloor.mockClear();
  // head() does not use home or TLS. All state below is an in-memory synthetic store.
  const decision = createHubMemberAddressDecision({ db, home: "/unused-head-only", hubId: randomUUID(), transport: store });
  return { db, store, decision, readFloor, setFloor: (n: number) => { floor = n; } };
}
it("uses the production fresh scalar reader when the member head owns no transport graph", () => {
  const r = fixture(), full = vi.spyOn(r.store, "read"), scalar = vi.spyOn(r.store, "readVersion"), clone = vi.spyOn(globalThis, "structuredClone");
  expect(r.decision.head()).toEqual({ revision: 0, operationId: null });
  expect(r.decision.head()).toEqual({ revision: 0, operationId: null });
  expect(scalar).toHaveBeenCalledTimes(2); expect(full).not.toHaveBeenCalled(); expect(clone).not.toHaveBeenCalled();
  expect(r.readFloor).toHaveBeenCalledTimes(2);
});
it("refuses a changed independent floor and retains permanent transport failure after repair", () => {
  const r = fixture(); r.decision.head(); r.setFloor(1);
  expect(() => r.decision.head()).toThrow("uncertain"); r.setFloor(0);
  expect(() => r.decision.head()).toThrow("uncertain"); expect(() => r.store.read()).toThrow("uncertain");
});
it("does not hide changed malformed SQL behind a scalar head check", () => {
  const r = fixture(); r.decision.head(); r.db.prepare("UPDATE hub_transport_state SET state='{bad'").run();
  expect(() => r.decision.head()).toThrow("uncertain");
});
it("still validates the freshly read member-address head after every transport check", () => {
  const r = fixture(); r.decision.head();
  r.db.prepare("UPDATE hub_member_address_head SET revision=1,operation_id=NULL").run();
  expect(() => r.decision.head()).toThrow(); expect(r.readFloor).toHaveBeenCalledTimes(2);
});
