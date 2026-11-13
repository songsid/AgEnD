/** Pure decisions only. Callers must obtain fresh directory facts and an operation permit. */
import type { PolicyGroupFacts } from "../directory/groups.js";
import type { PersonKey } from "../types.js";
import { z } from "zod";
import { epoch, person, uuid, validated } from "../validation.js";
import { BUILTIN_ROLE_IDS, MANAGEMENT_PERMISSIONS, parseRolePermission, parseRolePolicy, SELF_PERMISSIONS, TEAM_PERMISSIONS, type RolePermission } from "./model.js";
export type RolePersonFacts = PolicyGroupFacts | { readonly kind: "eligible"; readonly person: PersonKey; readonly observedAt: number };
export interface RoleDecision {
  readonly outcome: "allow" | "deny" | "unknown" | "legacy";
  readonly authoritative: boolean;
  readonly reason: "role" | "root" | "person-denied" | "no-role" | "ineligible" | "unknown" | "suspended" | "legacy" | "roles-off";
  readonly via: readonly string[];
  readonly maxFleets: number;
  readonly nextExpiry: number | null;
}
export interface RoleEvaluationFacts { readonly subject: RolePersonFacts; readonly target?: RolePersonFacts }
const knownFacts = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("eligible"), person, observedAt: epoch }),
  z.strictObject({ kind: z.literal("complete"), person, observedAt: epoch, groups: z.array(uuid).max(256) }),
  z.strictObject({ kind: z.literal("ineligible"), person, observedAt: epoch, reason: z.enum(["gone", "disabled"]) }),
]);
const same = (a: PersonKey, b: PersonKey) => a.realm === b.realm && a.objectId === b.objectId;
function readFacts(input: RolePersonFacts | undefined, who: PersonKey, now: number) {
  const parsed = knownFacts.safeParse(input);
  return parsed.success && same(parsed.data.person, who) && parsed.data.observedAt <= now ? parsed.data : null;
}
/** Detached shape/identity/time check only; callers still bind this to their own fresh physical read. */
export const snapshotRolePersonFacts = readFacts;
/** observedAt is bounded by now here; live callers must additionally bind facts to their own fresh read interval. */
export function evaluateRolePolicy(input: unknown, subject: PersonKey, permission: RolePermission,
  target: PersonKey | null, facts: RoleEvaluationFacts, now: number, root: PersonKey): RoleDecision {
  const p = parseRolePolicy(input), who = validated(person, subject), cap = parseRolePermission(permission);
  const at = validated(epoch, now), configuredRoot = validated(person, root);
  const self = (SELF_PERMISSIONS as readonly string[]).includes(cap), team = (TEAM_PERMISSIONS as readonly string[]).includes(cap);
  const management = (MANAGEMENT_PERMISSIONS as readonly string[]).includes(cap), isRoot = same(who, configuredRoot);
  const decision = (outcome: RoleDecision["outcome"], reason: RoleDecision["reason"], via: string[] = [], maxFleets = 0, nextExpiry: number | null = null): RoleDecision =>
    Object.freeze({ outcome, authoritative: outcome !== "unknown", reason, via: Object.freeze(via.sort()), maxFleets, nextExpiry });
  if (who.realm !== p.realm || configuredRoot.realm !== p.realm) return decision("unknown", "unknown");
  if (self && target !== null) return decision("deny", "no-role");
  if (self && p.state === "never-enabled") return decision("legacy", "legacy");
  if (self && p.state === "suspended") return decision("deny", "suspended");
  if (!self && !p.rolesActive && !(management && isRoot)) return decision("deny", "roles-off");
  const actor = readFacts(facts.subject, who, at);
  if (!actor) return decision("unknown", "unknown");
  if (actor.kind === "ineligible") return decision("deny", "ineligible");
  if (self && p.denies.some(d => same(d.person, who) && d.deny.includes(cap as typeof SELF_PERMISSIONS[number]))) return decision("deny", "person-denied");
  let targetFacts: ReturnType<typeof readFacts> = null;
  if (team) {
    if (target === null) return decision("deny", "no-role");
    const to = validated(person, target);
    if (to.realm !== p.realm) return decision("unknown", "unknown");
    targetFacts = readFacts(facts.target, to, at);
    if (!targetFacts) return decision("unknown", "unknown");
    if (targetFacts.kind === "ineligible") return decision("deny", "ineligible");
  } else if (!self && target !== null) return decision("deny", "no-role");
  // The configured root has virtual management/team authority, never implicit self-use defaults.
  if (!self && isRoot && p.roles.find(r => r.id === BUILTIN_ROLE_IDS.admin)!.permissions.includes(cap)) return decision("allow", "root");
  const roles = new Map(p.roles.map(r => [r.id, r]));
  const matches: { id: string; limit: number; expiresAt: number | null }[] = [];
  let uncertain = false;
  for (const a of p.assignments) {
    const role = roles.get(a.roleId)!;
    if (!role.permissions.includes(cap) || a.startsAt > at || (a.expiresAt !== null && a.expiresAt <= at)) continue;
    if (a.subject.kind === "person") { if (!same(a.subject.person, who)) continue; }
    else {
      if (actor.kind !== "complete") { uncertain = true; continue; }
      if (!actor.groups.includes(a.subject.group.objectId)) continue;
    }
    if (team && a.scope.kind === "group") {
      if (targetFacts?.kind !== "complete") { uncertain = true; continue; }
      if (!targetFacts.groups.includes(a.scope.group.objectId)) continue;
    }
    matches.push({ id: a.id, limit: a.maxFleets ?? role.defaultMaxFleets, expiresAt: a.expiresAt });
  }
  const maxFleets = Math.max(0, ...matches.map(m => m.limit));
  const allowed = matches.length > 0 && (cap !== "pair_fleet" || maxFleets > 0);
  // An unobserved relevant group could change the quota/scope. Do not turn a partial positive into a
  // complete decision that a later inventory writer could mistake for an authoritative reduction.
  if (uncertain) return decision("unknown", "unknown");
  const expiries = matches.flatMap(m => m.expiresAt === null ? [] : [m.expiresAt]);
  return decision(allowed ? "allow" : "deny", allowed ? "role" : "no-role", matches.map(m => m.id), maxFleets, expiries.length ? Math.min(...expiries) : null);
}
