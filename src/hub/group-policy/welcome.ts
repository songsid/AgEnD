/**
 * #3298 S-89: the signed-in welcome's projection (GET /hub/v1/me/welcome). DISPLAY ONLY, for the person of the request's own
 * session (`ctx.requirePerson()`, fresh; never a person passed in — Fable #3356 N1). One `store.describe` (one bounded fresh
 * membership read, none when never enabled), no audit, no provenance, no permit: every chat, pairing or publication still asks
 * its own permit. Unknown stays "unknown" (never a cached yes). No GUID or DN leaves here: only outcome, a whitelisted reason,
 * the fleet limit and this person's own fleets (label, status).
 */
import type { HubGroupDecision } from "./model.js";
import type { HubGroupPolicyStore } from "./store.js";
import type { GroupWelcomeContext, GroupWelcomeResponse, WelcomeEntry } from "./admin-dto.js";
import type { PersonKey } from "../types.js";

export interface HubWelcomeFleet { readonly id: string; readonly owner: PersonKey; readonly status: string; readonly label?: string | null }
export interface HubGroupWelcomeOptions {
  /** The composition's policy store (lazy: a repair-required binding is not constructed here — see `ready`). */
  policy(): HubGroupPolicyStore;
  /** True when the stored policy binding is ready; otherwise the welcome shows legacy (sign-in stays open; nothing is decided). */
  ready(): boolean;
  /** This Hub's fleets, as the store holds them now. */
  fleets(): readonly HubWelcomeFleet[];
}
const REASONS = new Set(["group", "person-denied", "no-group", "ineligible", "unknown", "suspended"]);
function entry(d: HubGroupDecision): WelcomeEntry {
  const state = d.outcome === "allow" ? "allow" : d.outcome === "unknown" ? "unknown" : "deny";
  return REASONS.has(d.reason) ? { state, reason: d.reason as NonNullable<WelcomeEntry["reason"]> } : { state };
}

export function createHubGroupWelcome(options: HubGroupWelcomeOptions): (ctx: GroupWelcomeContext) => Promise<GroupWelcomeResponse> {
  return async (ctx) => {
    const requestId = ctx.requestId, current = ctx.current.bind(ctx);
    const who = await ctx.requirePerson();
    if (!current()) throw new Error("unavailable");
    const mine = options.fleets().filter((f) => f.owner.realm === who.realm && f.owner.objectId === who.objectId)
      .map((f) => ({ id: f.id, label: typeof f.label === "string" ? f.label.slice(0, 120) : null, status: f.status === "active" ? "active" as const : "revoked" as const }));
    const legacy: GroupWelcomeResponse = { ok: true, v: 1, mode: "legacy", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "deny", maxFleets: 0, fleets: mine } };
    if (!options.ready()) return legacy;
    const { policy, decisions } = await options.policy().describe(who, { requestId, current });
    if (!current()) throw new Error("unavailable");
    if (policy.state === "never-enabled") return legacy;
    const pair = decisions.pair_fleet;
    return { ok: true, v: 1, mode: policy.state === "suspended" ? "suspended" : "enabled",
      chat: entry(decisions.ask_agents), publish: entry(decisions.publish_agents),
      connect: { ...entry(pair), maxFleets: pair.outcome === "allow" ? pair.maxFleets : 0, fleets: mine } };
  };
}
