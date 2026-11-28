import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HubTransportStore, migrateHubTransportStore, type HubTransportState } from "../src/hub/store.js";
const dbs: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db); migrateHubTransportStore(db);
  let floor = 0;
  const readFloor = vi.fn(() => floor);
  const store = new HubTransportStore(db, { floor: { read: readFloor, raise: n => { floor = n; } }, appendAudit() {} });
  store.initialize(); readFloor.mockClear();
  // The old owning read is an intentionally equivalent fallback for the negative control.
  const version = () => {
    const port = store as HubTransportStore & { readVersion?(): Pick<HubTransportState, "revision" | "revocationVersion"> };
    if (port.readVersion) return port.readVersion();
    const state = store.read(); return { revision: state.revision, revocationVersion: state.revocationVersion };
  };
  const raw = () => (db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state;
  const write = (value: unknown) => db.prepare("UPDATE hub_transport_state SET state=?").run(JSON.stringify(value));
  return { db, store, version, raw, write, readFloor, setFloor: (n: number) => { floor = n; } };
}
it("checks fresh versions without cloning a transport image that no caller owns", () => {
  const r = fixture(); r.store.read(); r.readFloor.mockClear();
  const clone = vi.spyOn(globalThis, "structuredClone");
  expect(r.version()).toEqual({ revision: 0, revocationVersion: 0 });
  expect(r.version()).toEqual({ revision: 0, revocationVersion: 0 });
  expect(r.readFloor).toHaveBeenCalledTimes(2);
  expect(clone).toHaveBeenCalledTimes(0);
});
it("returns only owned scalars and retains full-reader nested isolation", () => {
  const r = fixture(), state = JSON.parse(r.raw());
  state.fleets.push({ id: randomUUID(), owner: { realm: "corp", objectId: randomUUID() }, credentialHash: null, generation: 1, status: "active" });
  r.write(state);
  const first = r.version(); expect(Object.keys(first).sort()).toEqual(["revision", "revocationVersion"]);
  first.revision = 99;
  const full = r.store.read(); full.fleets[0]!.owner.realm = "other"; full.fleets.splice(0);
  expect(r.version()).toEqual({ revision: 0, revocationVersion: 0 });
  expect(r.store.read().fleets[0]!.owner.realm).toBe("corp");
});
it("selects changed SQL bytes and the floor separately on every call", () => {
  const r = fixture(); r.version();
  const state = JSON.parse(r.raw()); state.revision = 1; state.revocationVersion = 1;
  r.write(state); r.setFloor(1);
  expect(r.version()).toEqual({ revision: 1, revocationVersion: 1 });
  state.revocationVersion = 2; r.write(state);
  expect(r.version()).toEqual({ revision: 1, revocationVersion: 2 });
});
it("refuses a changed floor immediately and preserves permanent failure", () => {
  const r = fixture(); r.version(); r.setFloor(1);
  expect(r.version).toThrow("uncertain"); r.setFloor(0);
  expect(r.version).toThrow("uncertain"); expect(() => r.store.read()).toThrow("uncertain");
});
it.each(["malformed", "duplicate"])("does not let scalar projection hide %s raw state", mode => {
  const r = fixture(); const good = r.raw(); r.version();
  if (mode === "malformed") r.db.prepare("UPDATE hub_transport_state SET state='{bad'").run();
  else {
    const state = JSON.parse(good), fleet = { id: randomUUID(), owner: { realm: "corp", objectId: randomUUID() }, credentialHash: null, generation: 1, status: "active" };
    state.fleets = [fleet, fleet]; r.write(state);
  }
  expect(r.version).toThrow("uncertain"); r.db.prepare("UPDATE hub_transport_state SET state=?").run(good);
  expect(() => r.store.read()).toThrow("uncertain");
});
