import * as codec from "../src/hub/roles/read.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
import { groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { initialGroupPolicy } from "../src/hub/group-policy/model.js";
import { convertGroupPolicy } from "../src/hub/roles/convert.js";
import { createHubCanonicalPolicyReader, parseCanonicalPolicy, resetCanonicalPolicyDecodeMemoForTest } from "../src/hub/roles/read.js";
import * as validation from "../src/hub/validation.js";
const dbs: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); resetCanonicalPolicyDecodeMemoForTest(); for (const db of dbs.splice(0)) db.close(); });
function transport() {
  const db = new Database(":memory:"); dbs.push(db); migrateHubTransportStore(db);
  let floor = 0;
  const readFloor = vi.fn(() => floor);
  const store = new HubTransportStore(db, { floor: { read: readFloor, raise: n => { floor = n; } }, appendAudit() {} });
  store.initialize(); readFloor.mockClear();
  const raw = () => (db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state;
  return { db, store, readFloor, raw, setFloor: (n: number) => { floor = n; } };
}
function policies() {
  const root = { realm: "corp", objectId: randomUUID() }, group = initialGroupPolicy("corp", "g1");
  return [JSON.stringify(group), JSON.stringify(convertGroupPolicy(group, { root, now: 100, rolesActive: true }))];
}
it("decodes unchanged transport bytes once but reads the floor on every call", () => {
  const r = transport(), decode = vi.spyOn(validation, "parseStrictJson");
  for (let i = 0; i < 32; i++) r.store.read();
  expect(decode).toHaveBeenCalledTimes(1); expect(r.readFloor).toHaveBeenCalledTimes(32);
  r.setFloor(1); expect(() => r.store.read()).toThrow("uncertain");
  r.setFloor(0); expect(() => r.store.read()).toThrow("uncertain");
});
it("never lends a transport template to a caller, including the first read", () => {
  const r = transport();
  for (let i = 0; i < 2; i++) {
    const state = r.store.read(); state.revision = 99;
    state.fleets.push({ id: randomUUID(), owner: { realm: "corp", objectId: randomUUID() }, credentialHash: null, generation: 1, status: "revoked" });
    expect(r.store.read()).toMatchObject({ revision: 0, fleets: [] });
  }
});
it.each(["{bad", '{"v":1,"v":1}'])("a warm transport reader still refuses changed malformed bytes: %s", raw => {
  const r = transport(); r.store.read();
  r.db.prepare("UPDATE hub_transport_state SET state=?").run(raw);
  expect(() => r.store.read()).toThrow("uncertain");
});
it.each([0, 1])("isolates miss and hit policy objects for codec %i", kind => {
  const raw = policies()[kind]!;
  const decode = vi.spyOn(validation, "parseStrictJson");
  for (let i = 0; i < 2; i++) {
    const first = parseCanonicalPolicy(raw); expect(Object.isFrozen(first)).toBe(true);
    first.policy.denies.push({ person: { realm: "corp", objectId: randomUUID() }, deny: ["ask_agents"] });
    const next = parseCanonicalPolicy(raw); expect(next.policy.denies).toEqual([]); expect(next).not.toBe(first);
  }
  expect(decode).toHaveBeenCalledTimes(1);
});
it("uses full exact strings, and does not replace a good memo after failures", () => {
  const raw = policies()[0]!, decode = vi.spyOn(validation, "parseStrictJson");
  parseCanonicalPolicy(raw);
  for (const bad of ["{bad", '{"realm":"corp","realm":"corp"}']) {
    for (let i = 0; i < 2; i++) expect(() => parseCanonicalPolicy(bad)).toThrow();
    expect(parseCanonicalPolicy(raw).raw).toBe(raw);
  }
  expect(decode).toHaveBeenCalledTimes(5);
  const whitespace = ` ${raw}`, ordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw)).reverse()));
  parseCanonicalPolicy(whitespace); parseCanonicalPolicy(ordered);
  const changed = ordered.replace('"revision":1', '"revision":2');
  expect(changed.length).toBe(ordered.length);
  expect(parseCanonicalPolicy(changed).policy.revision).toBe(2);
  expect(decode).toHaveBeenCalledTimes(8);
});
it("a warm policy reader still checks SQL ownership, binding and both currency checks", () => {
  const db = new Database(":memory:"); dbs.push(db); groupPolicyMigration("hub", "corp", "g1").up(db);
  const raw = (db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body;
  const current = vi.fn(() => true), read = createHubCanonicalPolicyReader({ db, hubId: "hub", realm: "corp", generation: "g1", current });
  const first = read(); first.policy.denies.push({ person: { realm: "corp", objectId: randomUUID() }, deny: ["ask_agents"] });
  current.mockClear(); expect(read().policy.denies).toEqual([]); expect(current).toHaveBeenCalledTimes(2);
  current.mockReturnValueOnce(true).mockReturnValueOnce(false); expect(read).toThrow("unavailable");
  current.mockReturnValue(true); db.prepare("UPDATE hub_group_policy SET hub_id='foreign'").run(); expect(read).toThrow("unavailable");
  db.prepare("UPDATE hub_group_policy SET hub_id='hub',body=?").run(raw.replace('"g1"', '"g2"')); expect(read).toThrow("unavailable");
});

function validateBytes(raw: string): void {
  const port = codec as typeof codec & { validateCanonicalPolicyBytes?(raw: string): void };
  if (port.validateCanonicalPolicyBytes) return port.validateCanonicalPolicyBytes(raw);
  // Equivalent old owning codec is the negative control, not a production fallback.
  parseCanonicalPolicy(raw);
}
it.each([0, 1])("M3878 validates exact policy bytes without owning codec %i", kind => {
  const raw = policies()[kind]!, decode = vi.spyOn(validation, "parseStrictJson"), clone = vi.spyOn(globalThis, "structuredClone");
  expect(validateBytes(raw)).toBeUndefined(); expect(validateBytes(raw)).toBeUndefined();
  expect(clone).not.toHaveBeenCalled(); expect(decode).toHaveBeenCalledTimes(1);
  const first = parseCanonicalPolicy(raw); first.policy.denies.push({ person: { realm: "corp", objectId: randomUUID() }, deny: ["ask_agents"] });
  validateBytes(raw); expect(parseCanonicalPolicy(raw).policy.denies).toEqual([]);
});
it("M3878 byte-only validation rejects changed malformed/duplicate images and preserves the good memo", () => {
  const raw = policies()[0]!, decode = vi.spyOn(validation, "parseStrictJson");
  validateBytes(raw);
  for (const bad of ["{bad", '{"realm":"corp","realm":"corp"}']) {
    expect(() => validateBytes(bad)).toThrow(); expect(validateBytes(raw)).toBeUndefined();
  }
  expect(decode).toHaveBeenCalledTimes(3);
  const changed = raw.replace('"revision":1', '"revision":2');
  validateBytes(changed); expect(parseCanonicalPolicy(changed).policy.revision).toBe(2);
});
