import { describe, expect, it } from "vitest";
import { builtinRoles, BUILTIN_ROLE_IDS, type HubRoleAssignment, type HubRolePolicy } from "../src/hub/roles/model.js";
import { heldRoleBundle, checkRoleChange } from "../src/hub/roles/delegation.js";
import { planRoleChange } from "../src/hub/roles/change.js";
import type { RolePersonFacts } from "../src/hub/roles/evaluate.js";
const root = { realm: "corp", objectId: "00000000-0000-4000-8000-000000000000" }, actor = { ...root, objectId: "11111111-1111-4111-8111-111111111111" }, target = { ...root, objectId: "22222222-2222-4222-8222-222222222222" };
const g1 = { ...root, objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, g2 = { ...root, objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const a = (id: string, roleId: string = BUILTIN_ROLE_IDS.member, patch: Partial<HubRoleAssignment> = {}): HubRoleAssignment => ({ id, roleId, subject: { kind: "person", person: actor }, scope: { kind: "hub" }, maxFleets: null, startsAt: 0, expiresAt: null, assignedBy: root, assignedAt: 10, ...patch });
function policy(): HubRolePolicy { return { realm: "corp", generation: "g1", revision: 1, rolesActive: true, state: "enabled", everEnabled: true, roles: builtinRoles(), assignments: [], denies: [] }; }
const facts = (who = actor, groups: string[] = []): RolePersonFacts => ({ kind: "complete", person: who, groups, observedAt: 100 });
function check(before: HubRolePolicy, after: HubRolePolicy, who = actor, f = facts(who)) { return checkRoleChange(planRoleChange(before, after, who, 200), heldRoleBundle(before, who, f, 200, root)); }
const copy = <T>(x: T) => structuredClone(x);
const assignOther = (p: HubRolePolicy, roleId: string = BUILTIN_ROLE_IDS.member, patch: Partial<HubRoleAssignment> = {}) => { const n = copy(p); n.assignments.push(a("new", roleId, { subject: { kind: "person", person: target }, ...patch })); return n; };
function operator(): HubRolePolicy {
  const p = policy(); p.roles.push({ id: "operator", name: "Assign", kind: "custom", permissions: ["roles.assign"], defaultMaxFleets: 0 }); p.assignments.push(a("operator", "operator")); return p;
}
describe("inactive writer delegation", () => {
  it("allows admin delegation to others independently of root self-use, self-use state and actor denies", () => {
    for (const state of ["never-enabled", "enabled", "suspended"] as const) {
      const p = policy(); p.state = state; p.everEnabled = state !== "never-enabled"; p.denies = [{ person: root, deny: ["pair_fleet"] }];
      expect(check(p, assignOther(p, BUILTIN_ROLE_IDS.admin), root, facts(root))).toBe("allow");
      p.assignments.push(a("admin", BUILTIN_ROLE_IDS.admin, { maxFleets: 0 })); p.denies.push({ person: actor, deny: ["pair_fleet"] });
      expect(check(p, assignOther(p, BUILTIN_ROLE_IDS.admin))).toBe("allow");
    }
  });
  it("requires live eligibility and assignment time; off is configured-root-only", () => {
    const p = policy(); p.assignments.push(a("admin", BUILTIN_ROLE_IDS.admin, { expiresAt: 200 }));
    expect(check(p, assignOther(p))).toBe("denied");
    p.assignments[0]!.expiresAt = null; p.assignments[0]!.startsAt = 201; expect(check(p, assignOther(p))).toBe("denied");
    p.assignments[0]!.startsAt = 0;
    expect(check(p, assignOther(p), actor, { kind: "unknown" })).toBe("unknown");
    expect(check(p, assignOther(p), actor, { kind: "ineligible", person: actor, reason: "disabled", observedAt: 100 })).toBe("denied");
    p.rolesActive = false; expect(check(p, assignOther(p))).toBe("denied"); expect(check(p, assignOther(p), root, facts(root))).toBe("allow");
  });
  it("never combines quota and expiry from different held assignments", () => {
    const p = operator(); p.assignments.push(a("large-short", BUILTIN_ROLE_IDS.member, { maxFleets: 3, expiresAt: 300 }), a("small-long", BUILTIN_ROLE_IDS.member, { maxFleets: 1 }));
    expect(check(p, assignOther(p, BUILTIN_ROLE_IDS.member, { maxFleets: 2, expiresAt: 400 }))).toBe("denied");
    expect(check(p, assignOther(p, BUILTIN_ROLE_IDS.member, { maxFleets: 2, expiresAt: 300 }))).toBe("allow");
    expect(check(p, assignOther(p, BUILTIN_ROLE_IDS.member, { maxFleets: 1 }))).toBe("allow");
    p.denies = [{ person: actor, deny: ["pair_fleet"] }]; expect(check(p, assignOther(p, BUILTIN_ROLE_IDS.member, { maxFleets: 1 }))).toBe("denied");
  });
  it("checks each permission on its own identical team scope with no group subset inference", () => {
    const p = operator(); p.roles.push({ id: "view", name: "View", kind: "custom", permissions: ["team.view"], defaultMaxFleets: 0 }, { id: "usage", name: "Usage", kind: "custom", permissions: ["team.usage"], defaultMaxFleets: 0 }, { id: "both", name: "Both", kind: "custom", permissions: ["team.view", "team.usage"], defaultMaxFleets: 0 });
    p.assignments.push(a("view", "view", { scope: { kind: "group", group: g1, dn: "CN=One" } }), a("usage", "usage", { scope: { kind: "group", group: g2, dn: "CN=Two" } }));
    expect(check(p, assignOther(p, "both", { scope: { kind: "group", group: g1, dn: "CN=One" } }))).toBe("denied");
    expect(check(p, assignOther(p, "view", { scope: { kind: "group", group: g1, dn: "CN=Renamed" } }))).toBe("allow");
    expect(check(p, assignOther(p, "view", { scope: { kind: "group", group: g2, dn: "CN=One" } }))).toBe("denied");
    expect(check(p, assignOther(p, "view"))).toBe("denied");
  });
  it("uses unscoped self-use bundles for delegation and refuses stale/wrong/unbounded membership", () => {
    const p = operator(); p.assignments.push(a("self", BUILTIN_ROLE_IDS.member, { subject: { kind: "group", group: g1, dn: "CN=One" }, scope: { kind: "group", group: g2, dn: "CN=Two" }, maxFleets: 2 }));
    expect(check(p, assignOther(p, BUILTIN_ROLE_IDS.member, { maxFleets: 2 }), actor, facts(actor, [g1.objectId]))).toBe("allow");
    expect(check(p, assignOther(p), actor, { kind: "eligible", person: actor, observedAt: 100 })).toBe("unknown");
    for (const f of [facts(target), facts(actor, Array(257).fill(g1.objectId)), { ...facts(actor, [g1.objectId]), observedAt: 201 }]) expect(check(p, assignOther(p), actor, f)).toBe("unknown");
  });
  it("refuses direct own assignment creation, narrowing and removal for admins too", () => {
    const p = policy(); p.assignments.push(a("admin", BUILTIN_ROLE_IDS.admin));
    const n = copy(p); n.assignments.push(a("own")); expect(check(p, n)).toBe("self-target");
    const q = copy(p); q.assignments[0]!.maxFleets = 0; expect(check(p, q)).toBe("self-target");
    q.assignments = []; expect(check(p, q)).toBe("self-target");
    const r = copy(p); r.assignments.push(a("root-own", BUILTIN_ROLE_IDS.member, { subject: { kind: "person", person: root } })); expect(check(p, r, root, facts(root))).toBe("self-target");
  });
  it("refuses indirect own group increases and unknown self-membership, but permits narrowing", () => {
    const p = policy(); p.assignments.push(a("admin", BUILTIN_ROLE_IDS.admin));
    const n = copy(p); n.assignments.push(a("group", BUILTIN_ROLE_IDS.member, { subject: { kind: "group", group: g1, dn: "CN=One" }, maxFleets: 1 }));
    expect(check(p, n, actor, facts(actor, [g1.objectId]))).toBe("self-target");
    expect(check(p, n, actor, { kind: "eligible", person: actor, observedAt: 100 })).toBe("unknown");
    expect(check(p, n)).toBe("allow");
    p.assignments.push(copy(n.assignments[1]!)); const smaller = copy(p); smaller.assignments[1]!.maxFleets = 0;
    expect(check(p, smaller, actor, { kind: "eligible", person: actor, observedAt: 100 })).toBe("allow");
    const longer = copy(p); p.assignments[1]!.expiresAt = 300; longer.assignments[1]!.expiresAt = null;
    expect(check(p, longer, actor, facts(actor, [g1.objectId]))).toBe("self-target");
  });
  it("refuses role-edit increases through own existing assignments; labels/narrowing stay possible", () => {
    const p = policy(); p.assignments.push(a("admin", BUILTIN_ROLE_IDS.admin)); p.roles.push({ id: "own-custom", name: "Own", kind: "custom", permissions: ["ask_agents"], defaultMaxFleets: 0 }); p.assignments.push(a("own", "own-custom"));
    const n = copy(p); n.roles[3]!.permissions.push("publish_agents"); expect(check(p, n)).toBe("self-target");
    const q = copy(p); q.roles[3]!.name = "Label only"; expect(check(p, q)).toBe("allow");
    q.roles[3]!.permissions = []; expect(check(p, q)).toBe("allow");
  });
  it("requires a limited assigner to dominate the old bundle before any destructive edit", () => {
    const p = operator(); p.assignments.push(a("other-admin", BUILTIN_ROLE_IDS.admin, { subject: {kind:"person",person:target} }));
    for (const remove of [true, false]) {
      const n = copy(p); if (remove) n.assignments.pop(); else n.assignments.at(-1)!.expiresAt = 300;
      expect(check(p, n)).toBe("denied");
    }
    const q = operator(); q.assignments.push(a("held", BUILTIN_ROLE_IDS.member, { maxFleets: 2 }), a("other-member", BUILTIN_ROLE_IDS.member, {subject:{kind:"person",person:target},maxFleets:2}));
    const n = copy(q); n.assignments.pop(); expect(check(q,n)).toBe("allow");
    q.assignments[1]!.maxFleets=1; const narrowed = copy(q); narrowed.assignments.pop(); expect(check(q,narrowed)).toBe("denied");
  });

});
