import { describe, expect, it } from "vitest";
import { builtinRoles, BUILTIN_ROLE_IDS, type HubRoleAssignment, type HubRolePolicy } from "../src/hub/roles/model.js";
import { planRoleChange } from "../src/hub/roles/change.js";
import { HubProtocolError } from "../src/hub/validation.js";
const root = { realm: "corp", objectId: "00000000-0000-4000-8000-000000000000" }, actor = { ...root, objectId: "11111111-1111-4111-8111-111111111111" };
function assignment(): HubRoleAssignment { return { id: "a1", roleId: BUILTIN_ROLE_IDS.member, subject: { kind: "person", person: root }, scope: { kind: "hub" }, maxFleets: 0,
  startsAt: 0, expiresAt: null, assignedBy: root, assignedAt: 10 }; }
function policy(): HubRolePolicy { return { realm: "corp", generation: "g1", revision: 1, rolesActive: true, state: "enabled", everEnabled: true, roles: builtinRoles(), assignments: [assignment()], denies: [] }; }
const copy = <T>(p: T): T => structuredClone(p);
describe("inactive role write planning", () => {
  it("stamps changed/new assignments with the actual actor and server time, keeping zero and unchanged history", () => {
    const before = policy(), next = copy(before); next.assignments[0]!.maxFleets = 2;
    const a = planRoleChange(before, next, actor, 100);
    expect(a).toMatchObject({ changed: true, required: ["roles.assign"] });
    expect(a.next.assignments[0]).toMatchObject({ assignedBy: actor, assignedAt: 100, maxFleets: 2 });
    expect(a.assignments).toHaveLength(1); expect(a.affected).toHaveLength(1);
    next.assignments[0]!.id = "a2"; next.assignments.push(assignment());
    const b = planRoleChange(before, next, actor, 100);
    expect(b.next.assignments.find(a => a.id === "a1")).toEqual(before.assignments[0]);
    expect(b.next.assignments.find(a => a.id === "a2")).toMatchObject({ assignedBy: actor, assignedAt: 100 });
    expect(before.assignments[0]!.assignedBy).toEqual(root); expect(next.assignments[0]!.assignedBy).toEqual(root);
  });
  it("refuses rewriting read-only history without a real assignment change", () => {
    const before = policy();
    for (const patch of [{ assignedBy: actor }, { assignedAt: 0 }]) {
      const next = copy(before); Object.assign(next.assignments[0]!, patch);
      expect(() => planRoleChange(before, next, actor, 100)).toThrow(HubProtocolError);
    }
  });
  it("requires hub.admin for definitions and detects every referenced assignment's changed authority", () => {
    const before = policy(), next = copy(before); next.roles[2]!.permissions.push("team.view");
    const p = planRoleChange(before, next, actor, 100);
    expect(p.required).toEqual(["hub.admin", "roles.assign"]); expect(p.roles).toHaveLength(1); expect(p.affected).toHaveLength(1);
    expect(p.assignments).toEqual([]); expect(p.next.assignments[0]).toEqual(before.assignments[0]);
    const rename = copy(before); rename.roles[2]!.name = "Another label";
    const q = planRoleChange(before, rename, actor, 100); expect(q.required).toEqual(["hub.admin"]); expect(q.affected).toEqual([]);
  });
  it("treats definition/assignment deletion atomically and requires both controls", () => {
    const before = policy(); before.roles.push({ id: "custom:one", name: "One", kind: "custom", permissions: ["ask_agents"], defaultMaxFleets: 0 });
    before.assignments[0]!.roleId = "custom:one";
    const next = copy(before); next.roles.pop(); next.assignments = [];
    const p = planRoleChange(before, next, actor, 100); expect(p.roles).toHaveLength(1); expect(p.assignments).toHaveLength(1);
    expect(p.affected[0]).toMatchObject({ before: { id: "a1" }, after: null }); expect(p.required).toEqual(["hub.admin", "roles.assign"]);
    next.assignments = copy(before.assignments); expect(() => planRoleChange(before, next, actor, 100)).toThrow(HubProtocolError);
  });
  it("keeps denies, self-use state and rolesActive controls admin-only and never resets the latch", () => {
    const before = policy();
    for (const patch of [{ rolesActive: false }, { state: "suspended" as const }, { denies: [{ person: actor, deny: ["ask_agents" as const] }] }]) {
      expect(planRoleChange(before, { ...copy(before), ...patch }, actor, 100)).toMatchObject({ changed: true, required: ["hub.admin"] });
    }
    expect(() => planRoleChange(before, { ...copy(before), state: "never-enabled", everEnabled: false }, actor, 100)).toThrow(HubProtocolError);
    expect(() => planRoleChange(before, { ...copy(before), state: "suspended", rolesActive: false }, actor, 100)).toThrow(HubProtocolError);
    const legacy = { ...copy(before), state: "never-enabled", everEnabled: false };
    expect(() => planRoleChange(legacy, { ...copy(before), state: "suspended" }, actor, 100)).toThrow(HubProtocolError);
  });
  it("treats permission/role/assignment order as a no-op and detaches every candidate object", () => {
    const before = policy(), next = copy(before); next.roles.reverse(); next.roles[0]!.permissions.reverse();
    const p = planRoleChange(before, next, actor, 100); expect(p).toMatchObject({ changed: false, required: ["roles.assign"], roles: [], assignments: [], affected: [] });
    p.next.roles[0]!.name = "Detached"; expect(before.roles.some(r => r.name === "Detached")).toBe(false); expect(next.roles.some(r => r.name === "Detached")).toBe(false);
  });
  it("refuses stale revision, rebinding, role kind forgery and invalid actor/time before planning", () => {
    const before = policy();
    for (const patch of [{ revision: 2 }, { generation: "g2" }, { realm: "other", assignments: [] }]) expect(() => planRoleChange(before, { ...copy(before), ...patch }, actor, 100)).toThrow(HubProtocolError);
    for (const who of [{ ...actor, realm: "other" }, { ...actor, objectId: "bad" }]) expect(() => planRoleChange(before, copy(before), who, 100)).toThrow(HubProtocolError);
    expect(() => planRoleChange(before, copy(before), actor, -1)).toThrow(HubProtocolError);
    const next = copy(before); next.roles.push({ id: "fake-legacy", name: "Legacy", kind: "carried-over", permissions: [], defaultMaxFleets: 0 });
    expect(() => planRoleChange(before, next, actor, 100)).toThrow(HubProtocolError);
  });
  it.each(["team.approve_join", "team.approve_ask"] as const)("refuses phase 3 %s in every proposed role", permission => {
    const before = policy(), next = copy(before); next.roles[1]!.permissions.push(permission);
    expect(() => planRoleChange(before, next, actor, 100)).toThrow(HubProtocolError);
    next.roles[1]!.permissions.pop(); next.roles.push({ id: "custom:future", name: "Future", kind: "custom", permissions: [permission], defaultMaxFleets: 0 });
    expect(() => planRoleChange(before, next, actor, 100)).toThrow(HubProtocolError);
  });
});
