/** Exact SQL management reader; repair is confined to legacy never-enabled, never role self-use. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { createHubCanonicalPolicyReader, createHubManagementPolicyReader as managementReader } from "../src/hub/roles/read.js";
import { convertGroupPolicy } from "../src/hub/roles/convert.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { createHubDirectoryAdmission } from "../src/hub/directory/admission.js";
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db);
  groupPolicyMigration("hub-reader", "corp", "old-generation").up(db);
  const root = { realm: "corp", objectId: randomUUID() };
  const old = JSON.parse((db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body);
  const options = { db, hubId: "hub-reader", realm: "corp", generation: "current-generation", current: () => true };
  const save = (value: unknown) => db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(value, null, 2));
  return { db, root, old, options, save };
}
describe("S129 independent management policy reader", () => {
  it("preserves exact never-enabled legacy bytes while the operational reader keeps refusing a generation mismatch", () => {
    const r = fixture(); r.save({ ...r.old, denies: [{ person: r.root, deny: ["pair_fleet"] }] });
    const before = (r.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body;
    const selected = managementReader(r.options)();
    expect(selected).toMatchObject({ kind: "group", raw: before, policy: { generation: "old-generation", state: "never-enabled" } });
    expect(() => createHubCanonicalPolicyReader(r.options)()).toThrow("unavailable");
    expect((r.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body).toBe(before);
  });
  it("permits configured-root management repair without constructing the strict operational store", async () => {
    const r = fixture(), eligible = vi.fn(async () => ({ eligible: true as const, person: { key: r.root, login: "root", dn: "fixture", groups: [] } }));
    const clock = vi.fn(() => { throw Error("role clock must not be consulted for legacy repair"); });
    const authority = createHubManagementAuthority({ root: r.root, policy: managementReader(r.options),
      directory: { realm: "corp", checkEligibility: eligible }, reads: createHubDirectoryAdmission(() => true),
      current: () => true, version: () => 1, assertAuthorizationTime: clock, now: () => 100, elapsedNow: () => 0 });
    const ctx = { requestId: "repair", current: () => true };
    const proof = await authority.requireJoinIssuer(r.root, ctx); proof.assertCurrent();
    expect(proof.source).toBe("legacy"); expect(clock).not.toHaveBeenCalled(); expect(eligible).toHaveBeenCalledOnce();
    const other = { ...r.root, objectId: randomUUID() };
    eligible.mockImplementation(async () => ({ eligible: true as const, person: { key: other, login: "other", dn: "fixture", groups: [] } }));
    await expect(authority.requireJoinIssuer(other, ctx)).rejects.toMatchObject({ code: "denied" });
    authority.close();
  });
  it.each(["enabled", "suspended"])("refuses a legacy %s generation mismatch", state => {
    const r = fixture(); r.save({ ...r.old, state }); expect(() => managementReader(r.options)()).toThrow("unavailable");
  });
  it.each([true, false])("refuses a role never-enabled generation mismatch even when rolesActive=%s", rolesActive => {
    const r = fixture(); r.save(convertGroupPolicy(r.old, { root: r.root, now: 100, rolesActive }));
    expect(() => managementReader(r.options)()).toThrow("unavailable");
  });
  it.each(["group", "roles"])("accepts exact current %s binding without altering state or role bits", kind => {
    const r = fixture(), policy = { ...r.old, generation: r.options.generation };
    r.save(kind === "group" ? policy : convertGroupPolicy(policy, { root: r.root, now: 100, rolesActive: false }));
    expect(managementReader(r.options)()).toEqual(createHubCanonicalPolicyReader(r.options)());
  });
  it.each(["missing", "foreign-hub", "foreign-realm", "extra", "corrupt"])("never repairs %s state", kind => {
    const r = fixture();
    if (kind === "missing") r.db.prepare("DELETE FROM hub_group_policy").run();
    else if (kind === "foreign-hub") r.db.prepare("UPDATE hub_group_policy SET hub_id='other'").run();
    else if (kind === "corrupt") r.db.prepare("UPDATE hub_group_policy SET body='bad'").run();
    else r.save({ ...r.old, ...(kind === "foreign-realm" ? { realm: "other" } : { extra: true }) });
    expect(() => managementReader(r.options)()).toThrow();
  });
  it("checks the exact mount both before and after reading its repair image", () => {
    const r = fixture(); let calls = 0;
    expect(() => managementReader({ ...r.options, current: () => ++calls === 1 })()).toThrow();
    expect(calls).toBe(2);
  });
});
