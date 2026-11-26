import { describe, expect, it } from "vitest";
import { builtinRoles, BUILTIN_ROLE_IDS, MANAGEMENT_PERMISSIONS, SELF_PERMISSIONS, type HubRoleAssignment, type HubRolePolicy } from "../src/hub/roles/model.js";
import { evaluateRolePolicy, type RolePersonFacts } from "../src/hub/roles/evaluate.js";
const root = { realm: "corp", objectId: "00000000-0000-4000-8000-000000000000" };
const alice = { realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" };
const bob = { realm: "corp", objectId: "22222222-2222-4222-8222-222222222222" };
const g1 = { realm: "corp", objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, g2 = { realm: "corp", objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
function assignment(id: string, patch: Partial<HubRoleAssignment> = {}): HubRoleAssignment {
  return { id, roleId: BUILTIN_ROLE_IDS.member, subject: { kind: "person", person: alice }, scope: { kind: "hub" },
    maxFleets: null, startsAt: 0, expiresAt: null, assignedBy: root, assignedAt: 1, ...patch };
}
function policy(assignments: HubRoleAssignment[] = []): HubRolePolicy {
  return { realm: "corp", generation: "g1", revision: 1, rolesActive: true, state: "enabled", everEnabled: true,
    roles: builtinRoles(), assignments, denies: [] };
}
const facts = (person = alice, groups = [g1.objectId]): RolePersonFacts => ({ kind: "complete", person, groups, observedAt: 100 });
const eligible = (person = alice): RolePersonFacts => ({ kind: "eligible", person, observedAt: 100 });
function can(p: HubRolePolicy, permission: Parameters<typeof evaluateRolePolicy>[2] = "pair_fleet", who = alice, f = facts(who), now = 200) {
  return evaluateRolePolicy(p, who, permission, null, { subject: f }, now, root);
}
describe("pure Hub role evaluation (not a live operation permit)", () => {
  it("unions self-use permissions with MAX, preserves explicit zero and ignores team scope", () => {
    const p = policy([assignment("one", { maxFleets: 0, scope: { kind: "group", group: g2, dn: "CN=Other" } }), assignment("two", { maxFleets: 3 })]);
    expect(can(p)).toMatchObject({ outcome: "allow", via: ["one", "two"], maxFleets: 3 });
    p.assignments.pop(); expect(can(p)).toMatchObject({ outcome: "deny", maxFleets: 0 });
    expect(can(p, "ask_agents")).toMatchObject({ outcome: "allow", via: ["one"] });
  });
  it("preserves distinct legacy for all three permissions, including automatic pairing", () => {
    const p = policy(); p.state = "never-enabled"; p.everEnabled = false;
    for (const permission of SELF_PERMISSIONS) expect(can(p, permission, alice, { kind: "unknown" })).toMatchObject({ outcome: "legacy", reason: "legacy", via: [] });
  });
  it("keeps suspended self-use distinct from management and applies explicit self-use denies", () => {
    const p = policy([assignment("admin", { roleId: BUILTIN_ROLE_IDS.admin })]); p.state = "suspended";
    expect(can(p, "ask_agents")).toMatchObject({ outcome: "deny", reason: "suspended" });
    expect(can(p, "join.manage")).toMatchObject({ outcome: "allow" });
    p.state = "enabled"; p.denies.push({ person: alice, deny: ["ask_agents"] });
    expect(can(p, "ask_agents")).toMatchObject({ outcome: "deny", reason: "person-denied" });
    expect(can(p, "ask_agents", alice, { kind: "unknown" })).toMatchObject({ outcome: "unknown", authoritative: false });
    expect(can(p, "publish_agents")).toMatchObject({ outcome: "allow" });
  });
  it("grants no root self-use implicitly and needs fresh eligibility, not group membership, for root management", () => {
    const p = policy();
    for (const permission of SELF_PERMISSIONS) expect(can(p, permission, root, eligible(root))).toMatchObject({ outcome: "deny" });
    for (const permission of MANAGEMENT_PERMISSIONS) expect(can(p, permission, root, eligible(root))).toMatchObject({ outcome: "allow", reason: "root", via: [] });
    expect(can(p, "hub.admin", root, { kind: "unknown" })).toMatchObject({ outcome: "unknown", authoritative: false });
    expect(can(p, "hub.admin", root, { kind: "ineligible", person: root, reason: "disabled", observedAt: 100 })).toMatchObject({ outcome: "deny", reason: "ineligible" });
    expect(can(p, "hub.admin", alice, eligible())).toMatchObject({ outcome: "deny" });
    expect(evaluateRolePolicy(p, root, "team.view", bob, { subject: eligible(root), target: eligible(bob) }, 200, root)).toMatchObject({ outcome: "allow", reason: "root" });
    expect(evaluateRolePolicy(p, root, "team.view", bob, { subject: eligible(root), target: { kind: "unknown" } }, 200, root)).toMatchObject({ outcome: "unknown" });
  });
  it("keeps off assignments inert for management/team while projecting current self-use, denies and suspension", () => {
    const p = policy([assignment("admin", { roleId: BUILTIN_ROLE_IDS.admin, maxFleets: 2 })]); p.rolesActive = false;
    expect(can(p, "join.manage")).toMatchObject({ outcome: "deny", reason: "roles-off" });
    expect(can(p, "hub.admin", root, eligible(root))).toMatchObject({ outcome: "allow" });
    expect(evaluateRolePolicy(p, alice, "team.view", bob, { subject: facts(), target: facts(bob) }, 200, root)).toMatchObject({ outcome: "deny", reason: "roles-off" });
    expect(can(p)).toMatchObject({ outcome: "allow", maxFleets: 2 });
    p.denies = [{ person: alice, deny: ["pair_fleet"] }]; expect(can(p)).toMatchObject({ outcome: "deny", reason: "person-denied" });
    p.denies = []; p.state = "suspended"; expect(can(p)).toMatchObject({ outcome: "deny", reason: "suspended" });
    p.state = "enabled"; p.assignments = []; p.rolesActive = true; expect(can(p, "hub.admin")).toMatchObject({ outcome: "deny" });
    expect(can(p)).toMatchObject({ outcome: "deny" });
  });
  it("does not flatten team scopes or confuse the actor's membership with the target's", () => {
    const p = policy([assignment("manager", { roleId: BUILTIN_ROLE_IDS.manager, scope: { kind: "group", group: g1, dn: "CN=Team" } })]);
    const run = (target: RolePersonFacts) => evaluateRolePolicy(p, alice, "team.view", bob, { subject: facts(), target }, 200, root);
    expect(run(facts(bob, [g1.objectId]))).toMatchObject({ outcome: "allow", via: ["manager"] });
    expect(run(facts(bob, [g2.objectId]))).toMatchObject({ outcome: "deny" });
    expect(run(eligible(bob))).toMatchObject({ outcome: "unknown", authoritative: false });
    p.assignments[0]!.scope = { kind: "hub" }; expect(run(eligible(bob))).toMatchObject({ outcome: "allow" });
    expect(run({ kind: "ineligible", person: bob, reason: "gone", observedAt: 100 })).toMatchObject({ outcome: "deny", reason: "ineligible" });
    expect(run(facts(alice))).toMatchObject({ outcome: "unknown" });
    expect(evaluateRolePolicy(p, alice, "team.view", { ...bob, realm: "other" }, { subject: facts(), target: facts(bob) }, 200, root)).toMatchObject({ outcome: "unknown" });
    expect(can(p, "team.view")).toMatchObject({ outcome: "deny" });
    expect(can(p, "team.approve_ask")).toMatchObject({ outcome: "deny" });
    p.assignments[0]!.subject = { kind: "group", group: g2, dn: "CN=Other" };
    expect(run(facts(bob))).toMatchObject({ outcome: "deny" });
  });
  it("requires exact, bounded current-person facts; incomplete facts never become removal", () => {
    const p = policy([assignment("group", { subject: { kind: "group", group: g1, dn: "CN=Team" } })]);
    for (const f of [{ kind: "unknown" } as const, eligible(), facts(bob), facts({ ...alice, realm: "other" }), facts(alice, ["bad"]), facts(alice, Array(257).fill(g1.objectId)),
      { ...facts(), observedAt: 201 }, { ...facts(), observedAt: -1 }]) expect(can(p, "pair_fleet", alice, f)).toMatchObject({ outcome: "unknown", authoritative: false });
    expect(can(p, "pair_fleet", alice, facts(alice, []))).toMatchObject({ outcome: "deny", authoritative: true });
    expect(can(p, "pair_fleet", alice, { kind: "ineligible", person: alice, reason: "disabled", observedAt: 100 })).toMatchObject({ outcome: "deny", reason: "ineligible" });
    expect(can(p, "pair_fleet", { ...alice, realm: "other" })).toMatchObject({ outcome: "unknown" });
    expect(can(p, "pair_fleet", bob, facts(bob))).toMatchObject({ outcome: "allow" }); // group applies to both; person identity is still exact
    p.assignments.push(assignment("person")); expect(can(p, "pair_fleet", alice, eligible())).toMatchObject({ outcome: "unknown", authoritative: false });
    expect(can(policy([assignment("person")]), "pair_fleet", alice, eligible())).toMatchObject({ outcome: "allow", via: ["person"] });
    expect(can(policy([assignment("only-alice")]), "pair_fleet", bob, eligible(bob))).toMatchObject({ outcome: "deny" });
    expect(evaluateRolePolicy(p, alice, "pair_fleet", bob, { subject: facts() }, 200, root)).toMatchObject({ outcome: "deny" });
  });
  it("keeps each permission attached to its own target scope", () => {
    const p = policy([assignment("view", { roleId: "viewer", scope: { kind: "group", group: g1, dn: "CN=One" } }),
      assignment("usage", { roleId: "meter", scope: { kind: "group", group: g2, dn: "CN=Two" } })]);
    p.roles.push({ id: "viewer", name: "Viewer", kind: "custom", permissions: ["team.view"], defaultMaxFleets: 0 },
      { id: "meter", name: "Meter", kind: "custom", permissions: ["team.usage"], defaultMaxFleets: 0 });
    for (const [permission, group] of [["team.view", g1], ["team.usage", g2]] as const) {
      const other = group === g1 ? g2 : g1;
      expect(evaluateRolePolicy(p, alice, permission, bob, { subject: eligible(), target: facts(bob, [group.objectId]) }, 200, root).outcome).toBe("allow");
      expect(evaluateRolePolicy(p, alice, permission, bob, { subject: eligible(), target: facts(bob, [other.objectId]) }, 200, root).outcome).toBe("deny");
    }
  });
  it("uses the injected clock at exact start/expiry and returns only the matching permission's earliest expiry", () => {
    const p = policy([assignment("short", { startsAt: 200, expiresAt: 250, maxFleets: 2 }), assignment("long", { expiresAt: 300, maxFleets: 3 })]);
    expect(can(p, "pair_fleet", alice, facts(), 199)).toMatchObject({ via: ["long"], maxFleets: 3, nextExpiry: 300 });
    expect(can(p, "pair_fleet", alice, facts(), 200)).toMatchObject({ via: ["long", "short"], nextExpiry: 250 });
    expect(can(p, "pair_fleet", alice, facts(), 250)).toMatchObject({ via: ["long"], nextExpiry: 300 });
    expect(can(p, "pair_fleet", alice, facts(), 300)).toMatchObject({ outcome: "deny", nextExpiry: null });
    expect(can(p, "pair_fleet", alice, facts(), 299)).toMatchObject({ outcome: "allow", nextExpiry: 300 });
    expect(() => can(p, "pair_fleet", alice, facts(), -1)).toThrow();
    const result = can(p); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.via)).toBe(true);
  });
});
