/** Experimental Hub base capabilities, separate from sign-in and exact owner ask grants (#3298). */
import { z } from "zod";
import { identifier, person, uuid, validated } from "../validation.js";
import type { PersonKey } from "../types.js";
import type { PolicyGroupFacts } from "../directory/groups.js";

export const GROUP_CAPABILITIES = ["ask_agents", "publish_agents", "pair_fleet"] as const;
export type GroupCapability = typeof GROUP_CAPABILITIES[number];
const capabilities = z.array(z.enum(GROUP_CAPABILITIES)).max(3).refine(a => new Set(a).size === a.length);
const label = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/);
const rule = z.strictObject({ group: person, dn: label, allow: capabilities, maxFleets: z.number().int().min(0).max(8) });
const deny = z.strictObject({ person, deny: capabilities });
const schema = z.strictObject({ realm: person.shape.realm, generation: identifier, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["never-enabled", "enabled", "suspended"]), groups: z.array(rule).max(32), denies: z.array(deny).max(256),
}).refine(p => p.groups.every(r => r.group.realm === p.realm) && p.denies.every(d => d.person.realm === p.realm)
  && new Set(p.groups.map(r => r.group.objectId)).size === p.groups.length
  && new Set(p.denies.map(d => d.person.objectId)).size === p.denies.length);
export type HubGroupPolicy = z.infer<typeof schema>;
export interface HubGroupDecision {
  readonly outcome: "allow" | "deny" | "unknown" | "legacy";
  /** Only a complete negative/policy denial can justify durable suspension; unknown must not mutate authority. */
  readonly authoritative: boolean;
  readonly reason: "group" | "person-denied" | "no-group" | "ineligible" | "unknown" | "suspended" | "legacy";
  readonly groups: readonly string[];
  readonly maxFleets: number;
  readonly observedAt?: number;
}
export function parseGroupPolicy(input: unknown): HubGroupPolicy { return validated(schema, input); }
export function initialGroupPolicy(realm: string, generation: string): HubGroupPolicy {
  return parseGroupPolicy({ realm, generation, revision: 1, state: "never-enabled", groups: [], denies: [] });
}
export function parseGroupCapability(input: unknown): GroupCapability { return validated(z.enum(GROUP_CAPABILITIES), input); }

/** Pure evaluation. No result creates a session, pairs a fleet, publishes an agent or replaces an owner grant. */
export function evaluateGroupPolicy(input: unknown, subject: PersonKey, capability: GroupCapability, facts: PolicyGroupFacts): HubGroupDecision {
  const p = parseGroupPolicy(input), who = validated(person, subject), cap = parseGroupCapability(capability);
  const decision = (outcome: HubGroupDecision["outcome"], reason: HubGroupDecision["reason"], authoritative = true, groups: string[] = [], maxFleets = 0, observedAt?: number): HubGroupDecision =>
    Object.freeze({ outcome, reason, authoritative, groups: Object.freeze(groups), maxFleets, ...(observedAt !== undefined ? { observedAt } : {}) });
  if (who.realm !== p.realm) return decision("unknown", "unknown", false);
  if (p.state === "never-enabled") return decision("legacy", "legacy");
  if (p.state === "suspended") return decision("deny", "suspended");
  // Unknown is never converted into an empty membership set or an authoritative removal.
  if (facts.kind === "unknown") return decision("unknown", "unknown", false);
  if (facts.person.realm !== who.realm || facts.person.objectId !== who.objectId || !Number.isSafeInteger(facts.observedAt) || facts.observedAt < 0) return decision("unknown", "unknown", false);
  if (facts.kind === "ineligible") return decision("deny", "ineligible", true, [], 0, facts.observedAt);
  if (facts.groups.length > 256 || facts.groups.some(g => !uuid.safeParse(g).success)) return decision("unknown", "unknown", false);
  if (p.denies.some(d => d.person.objectId === who.objectId && d.deny.includes(cap))) return decision("deny", "person-denied", true, [], 0, facts.observedAt);
  const membership = new Set(facts.groups);
  const matches = p.groups.filter(r => membership.has(r.group.objectId) && r.allow.includes(cap));
  const maxFleets = Math.max(0, ...matches.map(r => r.maxFleets));
  const allowed = matches.length > 0 && (cap !== "pair_fleet" || maxFleets > 0);
  return decision(allowed ? "allow" : "deny", allowed ? "group" : "no-group", true, matches.map(r => r.group.objectId).sort(), maxFleets, facts.observedAt);
}
