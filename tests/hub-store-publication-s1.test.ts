import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function world(audit = (_db: Database.Database) => {}) {
  const db = new Database(":memory:"); databases.push(db); migrateHubTransportStore(db); let floor = 0;
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: next => { floor = next; } }, appendAudit: (_event, tx) => audit(tx) });
  store.initialize();
  const event = { at: 123, requestId: randomUUID(), actor: { kind: "local-host" as const }, action: "owned.refusal", result: "completed" as const };
  const raw = () => JSON.parse((db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state);
  return { db, store, event, raw, floor: () => floor };
}
describe("final narrowing proof after required audit", () => {
  it("keeps the old authority readable by the permit after audit, then publishes the narrowing atomically", () => {
    let audited = false;
    const r = world(() => { audited = true; });
    r.store.mutate(r.event, state => { state.revocationVersion++; }, () => {
      expect(audited).toBe(true); expect(r.db.inTransaction).toBe(true);
      expect(r.store.read()).toMatchObject({ revision: 1, revocationVersion: 0 }); expect(r.floor()).toBe(1);
    });
    expect(r.store.read()).toMatchObject({ revision: 1, revocationVersion: 1 });
  });
  it("a failed final proof rolls the SQL image back but never rewinds the independent floor", () => {
    const r = world();
    expect(() => r.store.mutate(r.event, s => { s.revocationVersion++; }, () => { throw Error("retired authority"); })).toThrow("retired authority");
    expect(r.raw()).toMatchObject({ revision: 0, revocationVersion: 0 }); expect(r.floor()).toBe(1);
    expect(() => r.store.read()).toThrow("uncertain");
  });
  it("refuses asynchronous final proofs and settles their rejection", async () => {
    const r = world();
    expect(() => r.store.mutate(r.event, s => { s.revocationVersion++; }, async () => { throw Error("owned late failure"); })).toThrow("uncertain");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(r.raw()).toMatchObject({ revision: 0, revocationVersion: 0 });
  });
  it("cannot overwrite transport changes made by the audit callback", () => {
    const r = world(db => db.prepare("UPDATE hub_transport_state SET state=json_set(state,'$.revocationVersion',99)").run());
    expect(() => r.store.mutate(r.event, s => { s.revocationVersion++; }, () => {})).toThrow("uncertain");
    expect(r.raw().revocationVersion).toBe(0);
  });
  it("cannot overwrite a nested mutation during the final proof", () => {
    const r = world();
    expect(() => r.store.mutate(r.event, s => { s.revocationVersion++; }, () => {
      r.store.mutate(r.event, s => { s.revocationVersion += 20; });
    })).toThrow("uncertain");
    expect(r.raw()).toMatchObject({ revision: 0, revocationVersion: 0 });
  });
});
