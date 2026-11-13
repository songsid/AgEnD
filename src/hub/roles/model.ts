/** Inactive roles foundation. Parsing supplies no identity, consent or operation permit. */
import { z } from "zod";
import { epoch, HubProtocolError, identifier, person, plain, validated } from "../validation.js";
import { GROUP_CAPABILITIES } from "../group-policy/model.js";

export const SELF_PERMISSIONS = Object.freeze([...GROUP_CAPABILITIES] as const);
export const TEAM_PERMISSIONS = Object.freeze(["team.view", "team.usage", "team.approve_join", "team.approve_ask"] as const);
export const MANAGEMENT_PERMISSIONS = Object.freeze(["fleets.manage", "join.manage", "roles.assign", "audit.view", "hub.admin"] as const);
export const ROLE_PERMISSIONS = Object.freeze([...SELF_PERMISSIONS, ...TEAM_PERMISSIONS, ...MANAGEMENT_PERMISSIONS] as const);
/** Catalogue entries reserved for phase 3; phase 1/2 writers must refuse them in every role. */
export const ROLE_APPROVAL_PERMISSIONS = Object.freeze(["team.approve_join", "team.approve_ask"] as const);
export type RolePermission = typeof ROLE_PERMISSIONS[number];
export const ROLE_POLICY_MAX_BYTES = 256 * 1024;
export const ROLE_POLICY_MAX_ASSIGNMENTS = 256;
export const BUILTIN_ROLE_IDS = Object.freeze({ admin: "builtin:admin", manager: "builtin:manager", member: "builtin:member" });
const label = plain(120).refine(s => s.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(s));
const dn = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/);
const limit = z.number().int().min(0).max(8);
const permissions = z.array(z.enum(ROLE_PERMISSIONS)).max(12).refine(a => new Set(a).size === a.length);
const roleSchema = z.strictObject({ id: identifier, name: label, kind: z.enum(["admin", "manager", "member", "carried-over", "custom"]),
  permissions, defaultMaxFleets: limit });
export type HubRole = z.infer<typeof roleSchema>;
const assignmentSchema = z.strictObject({ id: identifier, roleId: identifier,
  subject: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("person"), person }), z.strictObject({ kind: z.literal("group"), group: person, dn })]),
  scope: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("hub") }), z.strictObject({ kind: z.literal("group"), group: person, dn })]),
  maxFleets: limit.nullable(), startsAt: epoch, expiresAt: epoch.nullable(), assignedBy: person, assignedAt: epoch,
}).refine(a => a.expiresAt === null || a.expiresAt > a.startsAt);
export type HubRoleAssignment = z.infer<typeof assignmentSchema>;
const policySchema = z.strictObject({ realm: person.shape.realm, generation: identifier, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  rolesActive: z.boolean(), state: z.enum(["never-enabled", "enabled", "suspended"]), everEnabled: z.boolean(),
  roles: z.array(roleSchema).min(3).max(32), assignments: z.array(assignmentSchema).max(ROLE_POLICY_MAX_ASSIGNMENTS),
  denies: z.array(z.strictObject({ person, deny: z.array(z.enum(SELF_PERMISSIONS)).max(3).refine(a => new Set(a).size === a.length) })).max(256),
});
export type HubRolePolicy = z.infer<typeof policySchema>;

/** Return fresh objects: editors cannot mutate the catalogue or another policy's defaults. */
export function builtinRoles(): HubRole[] {
  return [
    { id: BUILTIN_ROLE_IDS.admin, name: "Administrator", kind: "admin", permissions: ROLE_PERMISSIONS.filter(p => !(ROLE_APPROVAL_PERMISSIONS as readonly string[]).includes(p)), defaultMaxFleets: 8 },
    { id: BUILTIN_ROLE_IDS.manager, name: "Manager", kind: "manager", permissions: [...SELF_PERMISSIONS, "team.view", "team.usage"], defaultMaxFleets: 2 },
    { id: BUILTIN_ROLE_IDS.member, name: "Member", kind: "member", permissions: [...SELF_PERMISSIONS], defaultMaxFleets: 1 },
  ];
}
export function parseRolePermission(input: unknown): RolePermission { return validated(z.enum(ROLE_PERMISSIONS), input); }
export function parseRolePolicy(input: unknown): HubRolePolicy {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(input), "utf8"); } catch { throw new HubProtocolError(); }
  if (bytes > ROLE_POLICY_MAX_BYTES) throw new HubProtocolError("backpressure");
  const p = validated(policySchema, input), roles = new Map(p.roles.map(r => [r.id, r]));
  function invalid(): never { throw new HubProtocolError(); }
  if (p.everEnabled !== (p.state !== "never-enabled") || roles.size !== p.roles.length) invalid();
  for (const expected of builtinRoles()) {
    const actual = roles.get(expected.id);
    if (!actual || actual.kind !== expected.kind || p.roles.filter(r => r.kind === expected.kind).length !== 1) invalid();
    if (expected.kind === "admin" && (actual.name !== expected.name || actual.defaultMaxFleets !== expected.defaultMaxFleets
      || actual.permissions.length !== expected.permissions.length || expected.permissions.some(c => !actual.permissions.includes(c)))) invalid();
  }
  if (p.roles.filter(r => r.kind === "carried-over").length > 7
    || p.roles.some(r => r.id !== BUILTIN_ROLE_IDS.admin && r.permissions.includes("hub.admin"))) invalid();
  if (new Set(p.assignments.map(a => a.id)).size !== p.assignments.length
    || new Set(p.denies.map(d => d.person.objectId)).size !== p.denies.length
    || p.denies.some(d => d.person.realm !== p.realm)) invalid();
  for (const a of p.assignments) {
    const role = roles.get(a.roleId), subject = a.subject.kind === "person" ? a.subject.person : a.subject.group;
    if (!role || subject.realm !== p.realm || a.assignedBy.realm !== p.realm || (a.scope.kind === "group" && a.scope.group.realm !== p.realm)) invalid();
    // Validate the entire graph: editing an already group-assigned role cannot grant management indirectly.
    if (role.permissions.some(c => (MANAGEMENT_PERMISSIONS as readonly string[]).includes(c))
      && (a.subject.kind !== "person" || a.scope.kind !== "hub")) invalid();
  }
  return p;
}
