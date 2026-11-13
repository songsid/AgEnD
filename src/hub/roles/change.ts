/** Pure write planning. It does not authorize a caller, commit policy or mint an operation permit. */
import type { PersonKey } from "../types.js";
import { epoch, HubProtocolError, person, validated } from "../validation.js";
import { parseRolePolicy, ROLE_APPROVAL_PERMISSIONS, ROLE_PERMISSIONS, SELF_PERMISSIONS, type HubRole, type HubRoleAssignment, type HubRolePolicy } from "./model.js";
export interface RoleDelta<T> { readonly before: T | null; readonly after: T | null }
export interface RoleChangePlan {
  readonly before: HubRolePolicy;
  readonly next: HubRolePolicy;
  readonly roles: readonly RoleDelta<HubRole>[];
  readonly assignments: readonly RoleDelta<HubRoleAssignment>[];
  /** Includes assignments whose effective bundle changed through a referenced role edit. */
  readonly affected: readonly RoleDelta<HubRoleAssignment>[];
  readonly required: readonly ("hub.admin" | "roles.assign")[];
  readonly changed: boolean;
}
const text = (a: unknown) => JSON.stringify(a);
const equal = (a: unknown, b: unknown) => text(a) === text(b);
function canonical(input: unknown): HubRolePolicy {
  const p = parseRolePolicy(input);
  p.roles.sort((a, b) => a.id.localeCompare(b.id));
  for (const r of p.roles) r.permissions = ROLE_PERMISSIONS.filter(c => r.permissions.includes(c));
  p.assignments.sort((a, b) => a.id.localeCompare(b.id));
  p.denies.sort((a, b) => a.person.objectId.localeCompare(b.person.objectId));
  for (const d of p.denies) d.deny = SELF_PERMISSIONS.filter(c => d.deny.includes(c));
  return p;
}
/** Metadata is server-owned; only these public fields determine whether an assignment is edited. */
function publicAssignment(a: HubRoleAssignment): unknown {
  const { assignedBy: _by, assignedAt: _at, ...fields } = a; return fields;
}
function deltas<T extends { id: string }>(before: readonly T[], after: readonly T[]): RoleDelta<T>[] {
  const old = new Map(before.map(a => [a.id, a])), next = new Map(after.map(a => [a.id, a]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap(id => {
    const a = old.get(id) ?? null, b = next.get(id) ?? null; return equal(a, b) ? [] : [{ before: a, after: b }];
  });
}
export function planRoleChange(before: unknown, next: unknown, actor: PersonKey, at: number): RoleChangePlan {
  const old = canonical(before), proposed = canonical(next), who = validated(person, actor), time = validated(epoch, at);
  if (proposed.roles.some(r => r.permissions.some(c => (ROLE_APPROVAL_PERMISSIONS as readonly string[]).includes(c)))) throw new HubProtocolError("incompatible");
  if (who.realm !== old.realm || proposed.realm !== old.realm || proposed.generation !== old.generation) throw new HubProtocolError();
  if (old.rolesActive !== proposed.rolesActive && old.state !== proposed.state) throw new HubProtocolError();
  if (proposed.revision !== old.revision) throw new HubProtocolError("conflict");
  if ((old.everEnabled && !proposed.everEnabled) || (old.state === "never-enabled" && proposed.state === "suspended")) throw new HubProtocolError();
  const oldRoles = new Map(old.roles.map(r => [r.id, r])), oldAssignments = new Map(old.assignments.map(a => [a.id, a]));
  for (const r of proposed.roles) {
    const was = oldRoles.get(r.id);
    if ((!was && r.kind !== "custom") || (was && was.kind !== r.kind)) throw new HubProtocolError();
  }
  for (const a of proposed.assignments) {
    const was = oldAssignments.get(a.id);
    if (was && equal(publicAssignment(was), publicAssignment(a))) {
      if (!equal(was.assignedBy, a.assignedBy) || was.assignedAt !== a.assignedAt) throw new HubProtocolError();
    } else { a.assignedBy = { ...who }; a.assignedAt = time; }
  }
  const roles = deltas(old.roles, proposed.roles), assignments = deltas(old.assignments, proposed.assignments);
  const nextRoles = new Map(proposed.roles.map(r => [r.id, r]));
  const authority = (a: HubRoleAssignment | null, role: HubRole | undefined) => a && role
    ? { ...publicAssignment(a) as object, permissions: role.permissions, limit: a.maxFleets ?? role.defaultMaxFleets } : null;
  const nextAssignments = new Map(proposed.assignments.map(a => [a.id, a]));
  const affected = [...new Set([...oldAssignments.keys(), ...nextAssignments.keys()])].sort().flatMap(id => {
    const a = oldAssignments.get(id) ?? null, b = nextAssignments.get(id) ?? null;
    return equal(authority(a, a ? oldRoles.get(a.roleId) : undefined), authority(b, b ? nextRoles.get(b.roleId) : undefined)) ? [] : [{ before: a, after: b }];
  });
  const controls = old.rolesActive !== proposed.rolesActive || old.state !== proposed.state || !equal(old.denies, proposed.denies);
  const changed = roles.length > 0 || assignments.length > 0 || controls;
  const required: ("hub.admin" | "roles.assign")[] = [];
  if (roles.length || controls) required.push("hub.admin");
  if (assignments.length || affected.length || !changed) required.push("roles.assign");
  return Object.freeze({ before: old, next: proposed, roles: Object.freeze(roles), assignments: Object.freeze(assignments),
    affected: Object.freeze(affected), required: Object.freeze(required), changed });
}
