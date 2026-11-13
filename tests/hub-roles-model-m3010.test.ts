import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HubProtocolError } from "../src/hub/validation.js";
import { builtinRoles, BUILTIN_ROLE_IDS, MANAGEMENT_PERMISSIONS, ROLE_PERMISSIONS, parseRolePermission, parseRolePolicy, type HubRoleAssignment, type HubRolePolicy } from "../src/hub/roles/model.js";
const owner = { realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" };
const group = { realm: "corp", objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
function assignment(patch: Partial<HubRoleAssignment> = {}): HubRoleAssignment {
  return { id: randomUUID(), roleId: BUILTIN_ROLE_IDS.member, subject: { kind: "person", person: owner }, scope: { kind: "hub" },
    maxFleets: null, startsAt: 0, expiresAt: null, assignedBy: owner, assignedAt: 100, ...patch };
}
function policy(patch: Partial<HubRolePolicy> = {}): HubRolePolicy {
  return { realm: "corp", generation: "g1", revision: 1, rolesActive: true, state: "enabled", everEnabled: true,
    roles: builtinRoles(), assignments: [], denies: [], ...patch };
}
describe("inactive Hub role model", () => {
  it("fixes twelve permissions, excludes content/cost and uses D7 defaults without delegated ask approval", () => {
    expect(ROLE_PERMISSIONS).toHaveLength(12); expect(new Set(ROLE_PERMISSIONS).size).toBe(12);
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true); expect(Object.isFrozen(MANAGEMENT_PERMISSIONS)).toBe(true);
    const roles = builtinRoles(); expect(roles.map(r => r.defaultMaxFleets)).toEqual([8, 2, 1]);
    expect(roles[0]!.permissions).toContain("hub.admin"); expect(roles[0]!.permissions).not.toContain("team.approve_ask");
    expect(roles[1]!.permissions).not.toContain("team.approve_ask"); expect(roles[2]!.permissions).toEqual(["ask_agents", "publish_agents", "pair_fleet"]);
    for (const name of ["readContent", "cost.view", "conversation.read", "__proto__", "constructor", "audit.*"]) expect(() => parseRolePermission(name)).toThrow();
    roles[0]!.permissions.length = 0; expect(builtinRoles()[0]!.permissions).toHaveLength(11);
  });
  it("accepts the named defaults with person-only admin and independently scoped manager", () => {
    const p = policy({ assignments: [assignment({ roleId: BUILTIN_ROLE_IDS.admin }), assignment({ roleId: BUILTIN_ROLE_IDS.manager,
      subject: { kind: "group", group, dn: "CN=Owners,DC=test" }, scope: { kind: "group", group, dn: "CN=Team,DC=test" }, maxFleets: 0 })] });
    expect(parseRolePolicy(p)).toEqual(p);
    const parsed = parseRolePolicy(p); parsed.roles[0]!.permissions.length = 0; expect(p.roles[0]!.permissions).toHaveLength(11);
  });
  it.each(["never-enabled", "enabled", "suspended"] as const)("keeps %s and its latch separate from rolesActive", state => {
    for (const rolesActive of [true, false]) expect(parseRolePolicy(policy({ state, rolesActive, everEnabled: state !== "never-enabled" }))).toMatchObject({ state, rolesActive });
    expect(() => parseRolePolicy(policy({ state, everEnabled: state === "never-enabled" }))).toThrow();
  });
  it.each(MANAGEMENT_PERMISSIONS)("refuses group-assigned %s even when added by a role edit", permission => {
    const p = policy(), role = { id: "custom:operator", name: "Operator", kind: "custom" as const, permissions: [permission], defaultMaxFleets: 0 };
    p.roles.push(role); p.assignments.push(assignment({ roleId: role.id, subject: { kind: "group", group, dn: "CN=Owners,DC=test" } }));
    expect(() => parseRolePolicy(p)).toThrow();
    role.permissions = []; expect(parseRolePolicy(p).assignments).toHaveLength(1);
  });
  it("reserves hub.admin and the fixed admin role; member/manager remain editable", () => {
    const p = policy(); p.roles[2]!.permissions.push("audit.view"); expect(parseRolePolicy(p)).toBeDefined();
    p.roles[2]!.permissions.push("hub.admin"); expect(() => parseRolePolicy(p)).toThrow();
    for (const edit of [ { name: "Other" }, { defaultMaxFleets: 7 }, { permissions: ["hub.admin"] }, { id: "another-admin" } ]) {
      const q = policy(); Object.assign(q.roles[0]!, edit); expect(() => parseRolePolicy(q)).toThrow();
    }
    const q = policy(); q.roles[2]!.id = BUILTIN_ROLE_IDS.admin; expect(() => parseRolePolicy(q)).toThrow();
    const r = policy(); r.roles.push({ ...r.roles[1]!, id: "imposter" }); expect(() => parseRolePolicy(r)).toThrow();
  });
  it("keeps management hub-wide and checks every realm and graph reference", () => {
    expect(() => parseRolePolicy(policy({ assignments: [assignment({ roleId: BUILTIN_ROLE_IDS.admin, scope: { kind: "group", group, dn: "CN=Team,DC=test" } })] }))).toThrow();
    for (const over of [ { roleId: "missing" }, { assignedBy: { ...owner, realm: "other" } }, { subject: { kind: "person" as const, person: { ...owner, realm: "other" } } },
      { subject: { kind: "group" as const, group: { ...group, realm: "other" }, dn: "CN=Team,DC=test" } }, { scope: { kind: "group" as const, group: { ...group, realm: "other" }, dn: "CN=Team,DC=test" } } ]) {
      expect(() => parseRolePolicy(policy({ assignments: [assignment(over)] }))).toThrow(HubProtocolError);
    }
    expect(() => parseRolePolicy(policy({ denies: [{ person: { ...owner, realm: "other" }, deny: [] }] }))).toThrow();
    const a = assignment(); expect(() => parseRolePolicy(policy({ assignments: [a, a] }))).toThrow();
    const d = { person: owner, deny: [] }; expect(() => parseRolePolicy(policy({ denies: [d, d] }))).toThrow();
  });
  it("rejects widened, malformed, oversized and contradictory documents", () => {
    const a = assignment();
    for (const over of [{ extra: true }, { realm: "Corp" }, { revision: 0 }, { roles: builtinRoles().slice(0, 2) },
      { assignments: [ { ...a, extra: true } ] }, { assignments: [ { ...a, expiresAt: 0 } ] }, { assignments: [ { ...a, maxFleets: 9 } ] },
      { assignments: [ { ...a, startsAt: -1 } ] }, { denies: [{ person: owner, deny: ["hub.admin"] }] } ]) expect(() => parseRolePolicy({ ...policy(), ...over })).toThrow();
    const p = policy(); p.roles[1]!.permissions.push(p.roles[1]!.permissions[0]!); expect(() => parseRolePolicy(p)).toThrow();
    const many = Array.from({ length: 257 }, () => assignment()); expect(() => parseRolePolicy(policy({ assignments: many }))).toThrow();
    const q = policy(); q.roles.push(...Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, name: "Custom", kind: "custom" as const, permissions: [], defaultMaxFleets: 0 }))); expect(() => parseRolePolicy(q)).toThrow();
    const big = policy({ assignments: Array.from({ length: 200 }, () => assignment({ subject: { kind: "group", group, dn: "x".repeat(1024) }, scope: { kind: "group", group, dn: "y".repeat(1024) } })) });
    expect(() => parseRolePolicy(big)).toThrow();
    const carried = policy(); carried.roles.push(...Array.from({ length: 8 }, (_, i) => ({ id: `legacy${i}`, name: "Legacy", kind: "carried-over" as const, permissions: [], defaultMaxFleets: 0 })));
    expect(() => parseRolePolicy(carried)).toThrow();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (const value of [undefined, null, circular, BigInt(1)]) expect(() => parseRolePolicy(value)).toThrow(HubProtocolError);
  });
});
