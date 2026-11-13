/** Existing action/resource code against canonical SQL; directory and link boundaries are inert. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { createHubGroupPolicyStore, groupPolicyMigration, inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { createHubGroupResources, HUB_GROUP_RESOURCES_MIGRATION, type HubGroupResource } from "../src/hub/group-policy/resources.js";
import { initialGroupPolicy } from "../src/hub/group-policy/model.js";
import { createHubGroupWelcome } from "../src/hub/group-policy/welcome.js";
import { builtinRoles, BUILTIN_ROLE_IDS, type HubRolePolicy } from "../src/hub/roles/model.js";
import { HubTransportStore, HUB_TRANSPORT_MIGRATION } from "../src/hub/store.js";
import type { Eligibility, HubDirectory } from "../src/hub/directory/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db); db.pragma("foreign_keys=ON");
  for (const m of [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, groupPolicyMigration("hub1", "corp", "g1"), HUB_GROUP_RESOURCES_MIGRATION]) m.up(db);
  const root = { realm: "corp", objectId: randomUUID() }, owner = { realm: "corp", objectId: randomUUID() }; let time = 100, floor = 0;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => time });
  const transport = new HubTransportStore(db, { floor: { read: () => floor, raise: n => { floor = n; } }, appendAudit(event, tx) { audit.appendInTransaction(event, tx); } }); transport.initialize();
  const eligibility = vi.fn(async (who: typeof owner): Promise<Eligibility> => ({ eligible: true, person: { key: who, login: "synthetic", dn: "CN=Synthetic", groups: [] } }));
  const groups = vi.fn(async (who: typeof owner): Promise<PolicyGroupFacts> => ({ kind: "complete", person: who, observedAt: time, groups: [] }));
  const directory: HubDirectory = { realm: "corp", groupPolicy: "ad-direct-guid", checkEligibility: eligibility, readPolicyGroups: groups,
    async signIn() { return { ok: false, reason: "invalid-credentials" }; }, async close() {} };
  const clock = vi.fn(() => {}), options = { db, hubId: "hub1", realm: "corp", generation: "g1", directory, audit, current: () => true, now: () => time,
    roles: { root, assertAuthorizationTime: clock } };
  const policy = createHubGroupPolicyStore(options);
  const body: HubRolePolicy = { realm: "corp", generation: "g1", revision: 1, rolesActive: true, state: "enabled", everEnabled: true,
    roles: builtinRoles(), assignments: [{ id: "member1", roleId: BUILTIN_ROLE_IDS.member, subject: { kind: "person", person: owner }, scope: { kind: "hub" },
      maxFleets: 1, startsAt: 0, expiresAt: 200, assignedBy: root, assignedAt: 0 }], denies: [] };
  const save = () => db.prepare("UPDATE hub_group_policy SET body=?").run(JSON.stringify(body)); save();
  const resources = createHubGroupResources({ db, policy, audit, directory, current: () => true, now: () => time });
  const refresh = vi.fn();
  const actions = createHubGroupAuthorization({ db, policy: () => policy, administrator: root, audit, directory,
    binding: () => inspectHubGroupPolicyBinding(db, "hub1", "corp", "g1"), current: () => true, now: () => time,
    version: () => transport.read().revocationVersion, advanceAuthorization(tx) { expect(tx).toBe(db); transport.mutate({ at: time, requestId: randomUUID(), actor: { kind: "local-host" }, action: "synthetic.narrow", result: "completed" }, s => { s.revocationVersion++; }); }, refreshAuthorization: refresh });
  const resource: HubGroupResource = { kind: "exposure", id: "exposure1", revision: 1, owner }, ctx = { requestId: "request1", current: () => true };
  return { db, root, owner, policy, body, save, audit, directory, groups, eligibility, clock, options, resources, actions, resource, ctx, transport, refresh, time: (ms: number) => { time += ms; } };
}
describe("S129 canonical self-use and retained resource consumers", () => {
  it("uses personal role assignments in the existing check and shared-pool paths without legacy projection", async () => {
    const w = fixture();
    expect(await w.policy.check(w.owner, "publish_agents", w.ctx)).toMatchObject({ outcome: "allow", reason: "role", via: ["member1"], nextExpiry: 200 });
    expect(w.eligibility).toHaveBeenCalled(); expect(w.clock).toHaveBeenCalled();
    expect(() => w.policy.read()).toThrow();
    const permit = await w.actions.enroll(w.resource, w.ctx); expect(permit.source).toBe("group"); permit.assertCurrent();
    expect(w.resources.read(w.resource)).toMatchObject({ source: "group", state: "active" });
  });
  it("retires the existing action permit at assignment expiry even when the policy and epoch do not change", async () => {
    const w = fixture(), permit = await w.actions.enroll(w.resource, w.ctx); w.time(100);
    expect(() => permit.assertCurrent()).toThrow();
    await expect(w.actions.check(w.resource, w.ctx)).rejects.toMatchObject({ reason: "denied" });
    expect(w.resources.read(w.resource)).toMatchObject({ state: "suspended" });
  });
  it("refuses role authorization without its mandatory persistent clock fence", async () => {
    const w = fixture();
    const { roles: _roles, ...without } = w.options, unguarded = createHubGroupPolicyStore(without);
    await expect(unguarded.check(w.owner, "ask_agents", w.ctx)).rejects.toBeTruthy();
    w.clock.mockImplementation(() => { throw Error("clock floor"); });
    await expect(w.policy.check(w.owner, "ask_agents", w.ctx)).rejects.toBeTruthy();
    expect(w.eligibility).not.toHaveBeenCalled();
  });
  it("keeps unknown membership held and never silently resumes a restored role", async () => {
    const w = fixture(); await w.actions.enroll(w.resource, w.ctx);
    w.eligibility.mockResolvedValueOnce({ eligible: false, reason: "unavailable" });
    await expect(w.actions.check(w.resource, w.ctx)).rejects.toMatchObject({ reason: "held" });
    expect(w.resources.read(w.resource)).toMatchObject({ state: "active", revision: 1 });
    w.body.assignments = []; w.save(); await expect(w.actions.check(w.resource, w.ctx)).rejects.toMatchObject({ reason: "denied" });
    w.body.assignments.push({ id: "restored", roleId: BUILTIN_ROLE_IDS.member, subject: { kind: "person", person: w.owner }, scope: { kind: "hub" },
      maxFleets: 1, startsAt: 0, expiresAt: null, assignedBy: w.root, assignedAt: 100 }); w.save();
    await expect(w.actions.check(w.resource, w.ctx)).rejects.toMatchObject({ reason: "resume-required" });
    expect(w.resources.read(w.resource)).toMatchObject({ state: "suspended", revision: 2 });
  });
  it("keeps MAX quotas, zero limits and person denies while roles are off", async () => {
    const w = fixture(); w.body.rolesActive = false; w.body.assignments[0]!.maxFleets = 0; w.save();
    expect(await w.policy.check(w.owner, "pair_fleet", w.ctx)).toMatchObject({ outcome: "deny", maxFleets: 0 });
    w.body.assignments.push({ ...w.body.assignments[0]!, id: "second", maxFleets: 3 }); w.save();
    expect(await w.policy.check(w.owner, "pair_fleet", w.ctx)).toMatchObject({ outcome: "allow", maxFleets: 3 });
    w.body.denies = [{ person: w.owner, deny: ["pair_fleet"] }]; w.save();
    expect(await w.policy.check(w.owner, "pair_fleet", w.ctx)).toMatchObject({ outcome: "deny", reason: "person-denied" });
    expect(await w.policy.check(w.root, "publish_agents", w.ctx)).toMatchObject({ outcome: "deny" });
  });
  it("uses group GUID membership for group subjects but never scopes a person's own self-use", async () => {
    const w = fixture(), group = { realm: "corp", objectId: randomUUID() };
    w.body.assignments[0]!.scope = { kind: "group", group, dn: "CN=Not a membership grant" }; w.save();
    expect(await w.policy.check(w.owner, "publish_agents", w.ctx)).toMatchObject({ outcome: "allow" }); expect(w.groups).not.toHaveBeenCalled();
    w.body.assignments[0]!.subject = { kind: "group", group, dn: "CN=Display only" }; w.save();
    expect(await w.policy.check(w.owner, "publish_agents", w.ctx)).toMatchObject({ outcome: "deny" });
    w.groups.mockImplementation(async who => ({ kind: "complete", person: who, groups: [group.objectId], observedAt: 100 }));
    expect(await w.policy.check(w.owner, "publish_agents", w.ctx)).toMatchObject({ outcome: "allow", via: ["member1"] });
  });
  it("keeps exact manual/code provenance and eligibility exemption while preserving explicit code denies", async () => {
    const w = fixture(); w.body.assignments = []; w.body.rolesActive = false; w.body.state = "never-enabled"; w.body.everEnabled = false; w.save();
    const manual = { ...w.resource, kind: "fleet" as const, id: "manual1" }, code = { ...manual, id: "code1" };
    const prepared = w.resources.prepareManualRegistration(manual, w.root, w.ctx);
    w.db.transaction(() => prepared.commit(w.db)).immediate();
    const byCode = w.resources.prepareCodeRegistration(code, { codeId: randomUUID(), approvedBy: w.root }, w.ctx);
    w.db.transaction(() => byCode.commit(w.db)).immediate();
    const rows = w.db.prepare("SELECT * FROM hub_group_resources ORDER BY resource_key").all();
    expect((await w.actions.check(manual, w.ctx)).source).toBe("manual"); expect((await w.actions.check(code, w.ctx)).source).toBe("code");
    expect(w.db.prepare("SELECT * FROM hub_group_resources ORDER BY resource_key").all()).toEqual(rows);
    w.body.denies = [{ person: w.owner, deny: ["pair_fleet"] }]; w.save();
    await expect(w.actions.check(code, w.ctx)).rejects.toMatchObject({ reason: "denied" });
    expect(w.resources.read(code)).toMatchObject({ source: "code", state: "suspended", code: { approvedBy: w.root } });
  });
  it("refuses a pending registration that expires during its required audit and rolls back all writes", async () => {
    const w = fixture(), prepared = await w.resources.prepareRegistration(w.resource, w.ctx);
    const append = w.audit.appendInTransaction.bind(w.audit);
    const spy = vi.spyOn(w.audit, "appendInTransaction").mockImplementation((...args) => { const out = append(...args); w.time(100); return out; });
    try { expect(() => w.db.transaction(() => prepared.commit(w.db)).immediate()).toThrow(); }
    finally { spy.mockRestore(); }
    expect(w.resources.read(w.resource)).toBe(null); expect(w.db.prepare("SELECT * FROM hub_group_resource_events").all()).toEqual([]);
  });
  it("never revives an expired action proof after the wall clock is restored", async () => {
    const w = fixture(), permit = await w.actions.enroll(w.resource, w.ctx); w.time(100);
    expect(() => permit.assertCurrent()).toThrow(); w.time(-100); expect(() => permit.assertCurrent()).toThrow();
  });
  it.each(["audit", "invalidation"] as const)("rolls back an actual SQL Resume that expires during required %s, without publishing a refresh", async stage => {
    const w = fixture(), assignment = structuredClone(w.body.assignments[0]!);
    await w.actions.enroll(w.resource, w.ctx);
    w.body.assignments = []; w.save();
    await expect(w.actions.check(w.resource, w.ctx)).rejects.toMatchObject({ reason: "denied" });
    const before = w.resources.read(w.resource), events = w.db.prepare("SELECT * FROM hub_group_resource_events ORDER BY id").all();
    expect(before).toMatchObject({ state: "suspended", revision: 2 });
    expect(w.transport.read().revocationVersion).toBe(1); w.refresh.mockClear();
    w.body.assignments = [assignment]; w.save();
    const append = w.audit.appendInTransaction.bind(w.audit), boundary = stage === "audit" ? "group-resource.resumed" : "synthetic.narrow";
    const spy = vi.spyOn(w.audit, "appendInTransaction").mockImplementation((...args) => {
      const out = append(...args); if (args[0].action === boundary) w.time(100); return out;
    });
    try { await expect(w.actions.resume(w.resource, { ...w.ctx, requireAdmin: async () => ({ kind: "directory", person: w.root, sessionId: "root-session" }) }))
      .rejects.toThrow("group_policy_conflict"); }
    finally { spy.mockRestore(); }
    expect(w.resources.read(w.resource)).toEqual(before);
    expect(w.db.prepare("SELECT * FROM hub_group_resource_events ORDER BY id").all()).toEqual(events);
    const state = (w.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state;
    expect(JSON.parse(state).revocationVersion).toBe(1);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-resource.resumed'").all()).toEqual([]);
    expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='synthetic.narrow'").all()).toHaveLength(1);
    expect(w.refresh).not.toHaveBeenCalled(); expect(w.audit.verifyChain()).toMatchObject({ ok: true });
    // The independent floor may stay raised after rollback; restoring a role still cannot reactivate the SQL row.
    assignment.expiresAt = 400; w.save();
    expect(await w.resources.check(w.resource, w.ctx)).toMatchObject({ outcome: "resume-required" });
    expect(w.resources.read(w.resource)).toEqual(before);
  });
  it.each(["audit", "invalidation"] as const)("commits and refreshes an actual SQL Resume that remains unexpired after required %s", async stage => {
    const w = fixture(), assignment = structuredClone(w.body.assignments[0]!);
    await w.actions.enroll(w.resource, w.ctx); w.body.assignments = []; w.save();
    await expect(w.actions.check(w.resource, w.ctx)).rejects.toMatchObject({ reason: "denied" });
    w.body.assignments = [assignment]; w.save(); w.refresh.mockClear();
    const append = w.audit.appendInTransaction.bind(w.audit), boundary = stage === "audit" ? "group-resource.resumed" : "synthetic.narrow";
    const spy = vi.spyOn(w.audit, "appendInTransaction").mockImplementation((...args) => {
      const out = append(...args); if (args[0].action === boundary) w.time(99); return out;
    });
    try {
      const permit = await w.actions.resume(w.resource, { ...w.ctx, requireAdmin: async () => ({ kind: "directory", person: w.root, sessionId: "root-session" }) });
      permit.assertCurrent(); expect(w.resources.read(w.resource)).toMatchObject({ state: "active", revision: 3 });
      expect(w.transport.read().revocationVersion).toBe(2); expect(w.refresh).toHaveBeenCalledOnce();
      expect(w.db.prepare("SELECT id FROM hub_audit WHERE action='group-resource.resumed'").all()).toHaveLength(1);
      w.time(1); expect(() => permit.assertCurrent()).toThrow("group_policy_conflict");
    } finally { spy.mockRestore(); }
    expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it("does not let the legacy whole-document editor erase a canonical graph", () => {
    const w = fixture(), before = (w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body;
    expect(() => w.policy.replace(initialGroupPolicy("corp", "g1"), w.root, w.ctx)).toThrow();
    expect((w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body).toBe(before);
  });
  it("keeps the old welcome shape without assignment IDs, role labels or directory identity disclosure", async () => {
    const w = fixture(), welcome = createHubGroupWelcome({ policy: () => w.policy, readiness: () => "ready", fleets: () => [] });
    const result = await welcome({ ...w.ctx, requirePerson: async () => w.owner });
    expect(result).toEqual({ ok: true, v: 1, mode: "enabled", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "allow", maxFleets: 1, fleets: [] } });
    expect(JSON.stringify(result)).not.toContain(w.owner.objectId); expect(JSON.stringify(result)).not.toContain("member1");
  });
});
