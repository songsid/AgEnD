/** Pure held-authority checks, not an operation permit. Writers must bind fresh facts/session/epoch at commit. */
import type { PersonKey } from "../types.js";
import { epoch, person, validated } from "../validation.js";
import { snapshotRolePersonFacts, type RolePersonFacts } from "./evaluate.js";
import { parseRolePolicy, SELF_PERMISSIONS, TEAM_PERMISSIONS, type HubRoleAssignment, type HubRolePolicy, type RolePermission } from "./model.js";
import type { RoleChangePlan } from "./change.js";
export interface HeldRoleGrant { readonly permission: RolePermission; readonly scope: HubRoleAssignment["scope"]; readonly maxFleets: number; readonly startsAt: number; readonly expiresAt: number | null }
export interface HeldRoleBundle {
  readonly kind: "known" | "unknown" | "ineligible";
  readonly actor: PersonKey;
  readonly administrator: boolean;
  readonly rolesActive: boolean;
  readonly groups: readonly string[] | null;
  readonly grants: readonly HeldRoleGrant[];
  readonly denied: readonly RolePermission[];
  readonly unknownGroups: boolean;
}
const same = (a: PersonKey, b: PersonKey) => a.realm === b.realm && a.objectId === b.objectId;
const self = (p: RolePermission) => (SELF_PERMISSIONS as readonly string[]).includes(p);
const team = (p: RolePermission) => (TEAM_PERMISSIONS as readonly string[]).includes(p);
const end = (at: number | null) => at ?? Infinity;
const scopeCovers = (held: HubRoleAssignment["scope"], next: HubRoleAssignment["scope"]) =>
  held.kind === "hub" || (next.kind === "group" && same(held.group, next.group));
const subjectSame = (a: HubRoleAssignment["subject"], b: HubRoleAssignment["subject"]) =>
  a.kind === "person" ? b.kind === "person" && same(a.person, b.person) : b.kind === "group" && same(a.group, b.group);
export function heldRoleBundle(input: HubRolePolicy, actor: PersonKey, facts: RolePersonFacts, now: number, root: PersonKey): HeldRoleBundle {
  const p = parseRolePolicy(input), who = validated(person, actor), configuredRoot = validated(person, root), at = validated(epoch, now);
  const f = snapshotRolePersonFacts(facts, who, at), grants: HeldRoleGrant[] = [];
  const base = { actor: who, administrator: false, rolesActive: p.rolesActive, groups: null, grants, denied: [], unknownGroups: true };
  if (who.realm !== p.realm || configuredRoot.realm !== p.realm || !f) return { ...base, kind: "unknown" };
  if (f.kind === "ineligible") return { ...base, kind: "ineligible" };
  const groups = f.kind === "complete" ? [...f.groups] : null, roles = new Map(p.roles.map(r => [r.id, r]));
  let unknownGroups = false;
  for (const a of p.assignments) {
    if (a.startsAt > at || end(a.expiresAt) <= at) continue;
    if (a.subject.kind === "person") { if (!same(a.subject.person, who)) continue; }
    else {
      if (!groups) { unknownGroups = true; continue; }
      if (!groups.includes(a.subject.group.objectId)) continue;
    }
    const r = roles.get(a.roleId)!;
    for (const permission of r.permissions) grants.push({ permission, scope: self(permission) ? { kind: "hub" } : a.scope,
      maxFleets: a.maxFleets ?? r.defaultMaxFleets, startsAt: a.startsAt, expiresAt: a.expiresAt });
  }
  const administrator = same(who, configuredRoot) || (p.rolesActive && grants.some(g => g.permission === "hub.admin"));
  const denied = p.denies.find(d => same(d.person, who))?.deny ?? [];
  return { kind: "known", actor: who, administrator, rolesActive: p.rolesActive, groups, grants, denied, unknownGroups };
}
/** Does this very assignment already contain the proposed permission, time, scope and quota? */
function contained(plan: RoleChangePlan, before: HubRoleAssignment | null, after: HubRoleAssignment, permission: RolePermission): boolean {
  if (!before || !subjectSame(before.subject, after.subject) || before.startsAt > after.startsAt || end(before.expiresAt) < end(after.expiresAt)) return false;
  const old = plan.before.roles.find(r => r.id === before.roleId)!, next = plan.next.roles.find(r => r.id === after.roleId)!;
  return old.permissions.includes(permission) && (!team(permission) || scopeCovers(before.scope, after.scope))
    && (permission !== "pair_fleet" || (before.maxFleets ?? old.defaultMaxFleets) >= (after.maxFleets ?? next.defaultMaxFleets));
}
export function checkRoleChange(plan: RoleChangePlan, bundle: HeldRoleBundle): "allow" | "denied" | "unknown" | "self-target" {
  if (bundle.kind !== "known") return bundle.kind === "unknown" ? "unknown" : "denied";
  if (!bundle.administrator) {
    if (!bundle.rolesActive) return "denied";
    if (plan.required.some(p => !bundle.grants.some(g => g.permission === p))) return bundle.unknownGroups ? "unknown" : "denied";
  }
  // Direct self edits are never delegated to the ordinary writer, including root edits. The named
  // one-time self-use activation has its own sealed operation, rather than a bypass in this check.
  for (const d of plan.assignments) for (const a of [d.before, d.after]) {
    if (a?.subject.kind === "person" && same(a.subject.person, bundle.actor)) return "self-target";
  }
  if (!bundle.administrator) for (const d of plan.assignments) if (d.before) {
    const a = d.before, role = plan.before.roles.find(r => r.id === a.roleId)!;
    for (const permission of role.permissions) {
      if (bundle.denied.includes(permission)) return "denied";
      if (!bundle.grants.some(g => g.permission === permission && (!team(permission) || scopeCovers(g.scope, a.scope))
        && end(g.expiresAt) >= end(a.expiresAt) && (permission !== "pair_fleet" || g.maxFleets >= (a.maxFleets ?? role.defaultMaxFleets)))) return bundle.unknownGroups ? "unknown" : "denied";
    }
  }
  for (const d of plan.affected) {
    const a = d.after; if (!a) continue;
    const role = plan.next.roles.find(r => r.id === a.roleId)!;
    const increases = role.permissions.filter(p => !contained(plan, d.before, a, p));
    if (!increases.length) continue;
    if (a.subject.kind === "person") { if (same(a.subject.person, bundle.actor)) return "self-target"; }
    else {
      if (bundle.groups === null) return "unknown";
      if (bundle.groups.includes(a.subject.group.objectId)) return "self-target";
    }
    if (bundle.administrator) continue;
    for (const permission of increases) {
      if (bundle.denied.includes(permission)) return "denied";
      const supported = bundle.grants.some(g => g.permission === permission && (!team(permission) || scopeCovers(g.scope, a.scope))
        && end(g.expiresAt) >= end(a.expiresAt) && (permission !== "pair_fleet" || g.maxFleets >= (a.maxFleets ?? role.defaultMaxFleets)));
      if (!supported) return bundle.unknownGroups ? "unknown" : "denied";
    }
  }
  return "allow";
}
