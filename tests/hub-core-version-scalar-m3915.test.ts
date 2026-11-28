import { afterEach, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubTransportStore } from "../src/hub/store.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig(); let floor = 0;
  const readFloor = vi.fn(() => floor), store = new HubTransportStore(r.db, { floor: { read: readFloor, raise: n => { floor = n; } }, appendAudit() {} });
  const core = new HubCore({ ...r.httpDeps, store }, r.sql);
  const raw = () => (r!.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state;
  const write = (state: unknown) => r!.db.prepare("UPDATE hub_transport_state SET state=?").run(JSON.stringify(state));
  return { core, store, readFloor, raw, write, setFloor(n: number) { floor = n; } };
}
it("uses the checked production scalar reader on every revocation check without cloning a graph", async () => {
  const w = await world(), full = vi.spyOn(w.store, "read"), scalar = vi.spyOn(w.store, "readVersion"), clone = vi.spyOn(globalThis, "structuredClone");
  expect(w.core.revocationVersion()).toBe(0); expect(w.core.revocationVersion()).toBe(0);
  expect(scalar).toHaveBeenCalledTimes(2); expect(full).not.toHaveBeenCalled(); expect(clone).not.toHaveBeenCalled(); expect(w.readFloor).toHaveBeenCalledTimes(2);
});
it("observes fresh SQL version changes, including changed bytes at the same revision", async () => {
  const w = await world(); expect(w.core.revocationVersion()).toBe(0); const state = JSON.parse(w.raw());
  state.revision = 1; state.revocationVersion = 1; w.write(state); w.setFloor(1); expect(w.core.revocationVersion()).toBe(1);
  state.revocationVersion = 2; w.write(state); expect(w.core.revocationVersion()).toBe(2);
});
it("keeps fresh private-floor refusal and sticky failure after the floor is repaired", async () => {
  const w = await world(); w.core.revocationVersion(); w.setFloor(1); expect(() => w.core.revocationVersion()).toThrow("uncertain");
  w.setFloor(0); expect(() => w.core.revocationVersion()).toThrow("uncertain"); expect(() => w.store.read()).toThrow("uncertain");
});
it("maps corrupt transport bytes to uncertain and never silently falls back to an owning reader", async () => {
  const w = await world(), good = w.raw(); w.core.revocationVersion(); r!.db.prepare("UPDATE hub_transport_state SET state='{bad'").run();
  expect(() => w.core.revocationVersion()).toThrow("uncertain"); r!.db.prepare("UPDATE hub_transport_state SET state=?").run(good); expect(() => w.core.revocationVersion()).toThrow("uncertain");
});
it("M3923 audit selects the fresh checked scalar reader instead of copying transport state", async () => {
  const w = await world(), full = vi.spyOn(w.store, "read"), scalar = vi.spyOn(w.store, "readVersion");
  w.core.atomic((_db, tx) => w.core.audit(tx, { requestId: "audit-scalar", actor: { kind: "local-host" }, action: "fixture", result: "completed" }));
  expect(scalar).toHaveBeenCalledTimes(1); expect(full).not.toHaveBeenCalled();
  expect(r!.audits.at(-1)?.policyVersion).toBe(0); expect(w.readFloor).toHaveBeenCalledTimes(1);
});
it("M3923 audit keeps fresh SQL versions at the audit effect", async () => {
  const w = await world();
  const append = () => w.core.atomic((_db, tx) => w.core.audit(tx, { requestId: "audit-version", actor: { kind: "local-host" }, action: "fixture", result: "completed" }));
  append(); expect(r!.audits.at(-1)?.policyVersion).toBe(0);
  const state = JSON.parse(w.raw()); state.revision = 1; state.revocationVersion = 1; w.write(state); w.setFloor(1);
  append(); expect(r!.audits.at(-1)?.policyVersion).toBe(1);
  state.revocationVersion = 2; w.write(state); append(); expect(r!.audits.at(-1)?.policyVersion).toBe(2);
});
it("M3923 audit keeps floor refusal sticky after repair and appends nothing", async () => {
  const w = await world();
  const append = () => w.core.atomic((_db, tx) => w.core.audit(tx, { requestId: "audit-floor", actor: { kind: "local-host" }, action: "fixture", result: "completed" }));
  append(); const count = r!.audits.length;
  w.setFloor(1); expect(append).toThrow("uncertain");
  w.setFloor(0); expect(append).toThrow("uncertain"); expect(r!.audits).toHaveLength(count);
});
it("M3923 audit keeps corrupt-image refusal sticky after repair", async () => {
  const w = await world(), good = w.raw();
  const append = () => w.core.atomic((_db, tx) => w.core.audit(tx, { requestId: "audit-corrupt", actor: { kind: "local-host" }, action: "fixture", result: "completed" }));
  append(); const count = r!.audits.length;
  r!.db.prepare("UPDATE hub_transport_state SET state='{bad'").run(); expect(append).toThrow("uncertain");
  r!.db.prepare("UPDATE hub_transport_state SET state=?").run(good); expect(append).toThrow("uncertain"); expect(r!.audits).toHaveLength(count);
});
