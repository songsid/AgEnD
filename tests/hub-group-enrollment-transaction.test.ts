/** Real SQLite outer transaction, real group evidence/authorization; all directory facts and actual-resource rows are inert. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION, type HubGroupResource } from "../src/hub/group-policy/resources.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import type { HubDirectory } from "../src/hub/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys=ON");
  for (const m of [HUB_AUDIT_MIGRATION, groupPolicyMigration("hub-1", "example", "generation-1"), HUB_GROUP_RESOURCES_MIGRATION]) m.up(db);
  db.exec("CREATE TABLE actual_resource(id TEXT PRIMARY KEY)");
  const owner = { realm: "example", objectId: randomUUID() }, group = { realm: "example", objectId: randomUUID() };
  const resource: HubGroupResource = { kind: "exposure", id: randomUUID(), revision: 1, owner };
  let live = true, caller = true, epoch = 0, generation = "generation-1";
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => 100 });
  const append = vi.fn((...args: Parameters<typeof audit.appendInTransaction>) => audit.appendInTransaction(...args));
  const current = () => live, ctx = { requestId: randomUUID(), current: () => caller };
  const lookup = vi.fn(async (): Promise<PolicyGroupFacts> => ({ kind: "complete", person: { ...owner }, groups: [group.objectId], observedAt: 100 }));
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", readPolicyGroups: lookup } as unknown as HubDirectory;
  const policy = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation, directory, audit: { appendInTransaction: append }, current, now: () => 100 });
  const policyOf = vi.fn(() => policy);
  const options = { db, administrator: owner, current, audit: { appendInTransaction: append }, policy: policyOf,
    binding: () => inspectHubGroupPolicyBinding(db, "hub-1", "example", generation), version: () => epoch,
    advanceAuthorization: () => { epoch++; }, refreshAuthorization: vi.fn(), now: () => 100 };
  const authorization = createHubGroupAuthorization(options), resources = createHubGroupResources({ db, policy, audit, current, now: () => 100 });
  const enable = () => policy.replace({ ...policy.read(), state: "enabled", groups: [{ group, dn: "CN=Members,DC=example,DC=test",
    allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 2 }] }, owner, ctx);
  const write = () => db.prepare("INSERT INTO actual_resource VALUES(?)").run(resource.id);
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  return { db, owner, group, resource, audit, append, policy, policyOf, resources, lookup, authorization, ctx, options, enable, write, count,
    advance: () => { epoch++; }, signOut: () => { caller = false; }, stop: () => { live = false; }, generation: () => { generation = "generation-2"; } };
}
describe("prepared group enrollment at the actual-resource transaction", () => {
  it("legacy preserves ordinary writes without membership or provenance and still requires the owning transaction", async () => {
    const w = fixture(), permit = await w.authorization.prepareEnrollment(w.resource, w.ctx);
    expect(permit.source).toBe("legacy"); expect(permit.maxFleets).toBe(0); permit.assertCurrent();
    expect(() => permit.commit(w.db)).toThrow("group_policy_invalid");
    w.db.transaction(() => { w.write(); permit.commit(w.db); permit.assertCurrent(); }).immediate();
    expect(w.count("actual_resource")).toBe(1); expect(w.count("hub_group_resources")).toBe(0); expect(w.lookup).not.toHaveBeenCalled();
    expect(() => w.db.transaction(() => permit.commit(w.db)).immediate()).toThrow("group_policy_invalid");
  });
  it("prepares only an allowance, then commits actual row, provenance and registration audit atomically", async () => {
    const w = fixture(); w.enable(); const permit = await w.authorization.prepareEnrollment(w.resource, w.ctx);
    expect(permit.source).toBe("group"); expect(permit.maxFleets).toBe(2); permit.assertCurrent();
    expect(w.count("actual_resource")).toBe(0); expect(w.count("hub_group_resources")).toBe(0);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-resource.registered'").all()).toEqual([]);
    w.db.transaction(() => { w.write(); permit.commit(w.db); permit.assertCurrent(); }).immediate();
    permit.assertCurrent(); expect(w.count("actual_resource")).toBe(1); expect(w.count("hub_group_resources")).toBe(1);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-resource.registered'").all()).toHaveLength(1);
    expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it("rolls back provenance and registration evidence with the actual resource, and cannot replay the preparation", async () => {
    const w = fixture(); w.enable(); const permit = await w.authorization.prepareEnrollment(w.resource, w.ctx);
    expect(() => w.db.transaction(() => { w.write(); permit.commit(w.db); throw Error("actual operation failed"); }).immediate()).toThrow("actual operation failed");
    expect(w.count("actual_resource")).toBe(0); expect(w.count("hub_group_resources")).toBe(0);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-resource.registered'").all()).toEqual([]);
    // The earlier fresh allowance is diagnostic evidence, not an assertion that the underlying operation committed.
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-policy.publish-agents' AND result='allowed'").all()).toHaveLength(1);
    expect(() => w.db.transaction(() => { w.write(); permit.commit(w.db); }).immediate()).toThrow("group_policy_invalid");
    expect(w.count("actual_resource")).toBe(0); expect(() => permit.assertCurrent()).toThrow();
    const fresh = await w.authorization.prepareEnrollment(w.resource, w.ctx);
    w.db.transaction(() => { w.write(); fresh.commit(w.db); fresh.assertCurrent(); }).immediate(); expect(w.count("hub_group_resources")).toBe(1);
  });
  it("refuses a different database or a commit outside SQL without creating provenance", async () => {
    const w = fixture(); w.enable(); const permit = await w.authorization.prepareEnrollment(w.resource, w.ctx), other = new Database(":memory:"); databases.push(other);
    expect(() => permit.commit(w.db)).toThrow("group_policy_invalid");
    expect(() => other.transaction(() => permit.commit(other)).immediate()).toThrow("group_policy_invalid");
    expect(() => w.db.transaction(() => other.transaction(() => permit.commit(other)).immediate()).immediate()).toThrow("group_policy_invalid");
    expect(w.count("hub_group_resources")).toBe(0);
  });
  it.each(["unknown", "denied"] as const)("cannot prepare %s membership or produce an enrollment row", async result => {
    const w = fixture(); w.enable(); w.lookup.mockResolvedValueOnce(result === "unknown" ? { kind: "unknown" }
      : { kind: "complete", person: w.owner, groups: [randomUUID()], observedAt: 100 });
    await expect(w.authorization.prepareEnrollment(w.resource, w.ctx)).rejects.toMatchObject({ outcome: result === "unknown" ? "held" : "denied" });
    expect(w.count("hub_group_resources")).toBe(0); expect(w.count("actual_resource")).toBe(0);
  });
  it.each(["policy", "epoch", "caller", "close", "server"] as const)("fences a held preparation after %s changes", async changed => {
    const w = fixture(); w.enable(); const held = gate<PolicyGroupFacts>(); w.lookup.mockReturnValueOnce(held.promise);
    const pending = w.authorization.prepareEnrollment(w.resource, w.ctx), checked = expect(pending).rejects.toThrow();
    if (changed === "policy") w.policy.replace({ ...w.policy.read(), groups: [] }, w.owner, w.ctx);
    else if (changed === "epoch") w.advance(); else if (changed === "caller") w.signOut(); else if (changed === "close") w.authorization.close(); else w.stop();
    held.resolve({ kind: "complete", person: w.owner, groups: [w.group.objectId], observedAt: 100 }); await checked;
    expect(w.count("hub_group_resources")).toBe(0); expect(w.count("actual_resource")).toBe(0);
  });
  it.each(["policy", "epoch", "caller", "close", "server"] as const)("rolls back a pending actual write after prepared %s becomes stale", async changed => {
    const w = fixture(); w.enable(); const permit = await w.authorization.prepareEnrollment(w.resource, w.ctx);
    if (changed === "policy") w.policy.replace({ ...w.policy.read(), groups: [] }, w.owner, w.ctx);
    else if (changed === "epoch") w.advance(); else if (changed === "caller") w.signOut(); else if (changed === "close") w.authorization.close(); else w.stop();
    expect(() => w.db.transaction(() => { w.write(); permit.commit(w.db); }).immediate()).toThrow();
    expect(w.count("actual_resource")).toBe(0); expect(w.count("hub_group_resources")).toBe(0);
  });
  it("snapshots the prepared resource before directory I/O and never captures caller replacements", async () => {
    const w = fixture(); w.enable(); const held = gate<PolicyGroupFacts>(); w.lookup.mockReturnValueOnce(held.promise);
    const input = structuredClone(w.resource), pending = w.authorization.prepareEnrollment(input, w.ctx);
    input.id = randomUUID(); input.owner.objectId = randomUUID(); input.revision = 9;
    held.resolve({ kind: "complete", person: w.owner, groups: [w.group.objectId], observedAt: 100 });
    const permit = await pending; w.db.transaction(() => { w.write(); permit.commit(w.db); }).immediate();
    expect(w.resources.read(w.resource)).toMatchObject({ resource: w.resource }); expect(w.resources.read(input)).toBeNull();
  });
  it("rejects reentrant policy changes inside registration audit, rolling back the actual row too", async () => {
    const w = fixture(); w.enable(); const permit = await w.authorization.prepareEnrollment(w.resource, w.ctx), before = w.policy.read();
    w.append.mockImplementation((...args) => {
      w.audit.appendInTransaction(...args);
      if (args[0].action === "group-resource.registered") w.db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify({ ...before, revision: before.revision + 1 }));
    });
    expect(() => w.db.transaction(() => { w.write(); permit.commit(w.db); }).immediate()).toThrow(/group_policy_(conflict|unavailable)/);
    expect(w.count("actual_resource")).toBe(0); expect(w.count("hub_group_resources")).toBe(0); expect(w.policy.read()).toEqual(before);
  });
  it("does not accept alternate asker provenance through the actual-resource enrollment seam", async () => {
    const w = fixture(); w.enable();
    await expect(w.authorization.prepareEnrollment({ ...w.resource, kind: "asker" }, w.ctx)).rejects.toThrow("group_policy_invalid");
    expect(w.lookup).not.toHaveBeenCalled();
  });
  it("captures the resource callback with its receiver before the directory wait", async () => {
    const w = fixture(); w.enable(); const held = gate<PolicyGroupFacts>(); w.lookup.mockReturnValueOnce(held.promise);
    const ctx = { requestId: randomUUID(), active: true, current() { return this.active; } };
    const pending = w.resources.prepareRegistration(w.resource, ctx).then(prepared => ({ prepared }), error => ({ error }));
    ctx.current = () => false;
    held.resolve({ kind: "complete", person: w.owner, groups: [w.group.objectId], observedAt: 100 });
    const result = await pending; expect(result).toHaveProperty("prepared");
    if (!("prepared" in result)) throw Error("positive callback control refused"); const prepared = result.prepared;
    w.db.transaction(() => { w.write(); prepared.commit(w.db); }).immediate();
    expect(w.resources.read(w.resource)).toMatchObject({ state: "active" });
  });
  it.each(["state", "revision"] as const)("fences the committed enrollment permit when its exact row %s changes", async change => {
    const w = fixture(); w.enable(); const permit = await w.authorization.prepareEnrollment(w.resource, w.ctx);
    w.db.transaction(() => { w.write(); permit.commit(w.db); permit.assertCurrent(); }).immediate(); permit.assertCurrent();
    if (change === "state") w.db.prepare("UPDATE hub_group_resources SET state='suspended'").run();
    else w.db.prepare("UPDATE hub_group_resources SET revision=revision+1").run();
    expect(() => permit.assertCurrent()).toThrow("group_policy_conflict");
  });
  it("projects exact lifecycle without fresh allowance, writes or cached authorization", async () => {
    const w = fixture(); w.enable(); expect(w.authorization.resourceState(w.resource)).toBeNull();
    await w.authorization.enroll(w.resource, w.ctx); w.lookup.mockClear(); const before = w.count("hub_audit");
    expect(w.authorization.resourceState(w.resource)).toEqual({ source: "group", state: "active", revision: 1 });
    expect(w.authorization.resourceState({ ...w.resource, revision: 2 })).toBeNull();
    expect(w.lookup).not.toHaveBeenCalled(); expect(w.count("hub_audit")).toBe(before);
    w.db.prepare("UPDATE hub_group_resources SET state='suspended',revision=2").run();
    expect(w.authorization.resourceState(w.resource)).toEqual({ source: "group", state: "suspended", revision: 2 });
    w.generation(); w.policyOf.mockClear(); w.policyOf.mockImplementation(() => { throw Error("strict repair store must not run"); });
    expect(() => w.authorization.resourceState(w.resource)).toThrow("group_policy_unavailable"); expect(w.policyOf).not.toHaveBeenCalled();
  });
});
