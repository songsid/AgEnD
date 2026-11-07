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
import { HubProtocolError } from "../validation.js";

export interface HubWelcomeFleet { readonly id: string; readonly owner: PersonKey; readonly status: string; readonly label?: string | null; readonly generation?: number }
/**
 * The stored binding as the welcome may show it (Cairn, #3372): "never-enabled" only for an INTACT binding that was never
 * enabled (today's behaviour: legacy, no store, no directory read); "ready" when the store may be constructed and asked;
 * "unavailable" for anything else — a binding that needs repair, or one that can't be read — which answers 503, never a
 * legacy "allow" for a policy that was once enabled.
 */
export type HubWelcomeReadiness = "ready" | "never-enabled" | "unavailable";
/** One fleet's lifecycle under the policy (S-88 `authorizer.resourceState`): null = not enrolled; throws when it can't be read. */
export type HubWelcomeFleetState = (resource: { readonly kind: "fleet"; readonly id: string; readonly revision: number; readonly owner: PersonKey }) => Promise<{ readonly state: string } | null>;
export interface HubGroupWelcomeOptions {
  /** The composition's policy store (lazy: constructed only when `readiness()` is "ready"). */
  policy(): HubGroupPolicyStore;
  readiness(): HubWelcomeReadiness;
  /** This Hub's fleets, as the store holds them now. */
  fleets(): readonly HubWelcomeFleet[];
  /** Optional: each own active fleet's paused state while the policy is on. Absent = shown as active (status only). */
  fleetState?: HubWelcomeFleetState;
}
type FleetRow = GroupWelcomeResponse["connect"]["fleets"][number];
const REASONS = new Set(["group", "person-denied", "no-group", "ineligible", "unknown", "suspended"]);
function entry(d: HubGroupDecision): WelcomeEntry {
  const state = d.outcome === "allow" ? "allow" : d.outcome === "unknown" ? "unknown" : "deny";
  return REASONS.has(d.reason) ? { state, reason: d.reason as NonNullable<WelcomeEntry["reason"]> } : { state };
}

export function createHubGroupWelcome(options: HubGroupWelcomeOptions): (ctx: GroupWelcomeContext) => Promise<GroupWelcomeResponse> {
  return async (ctx) => {
    const requestId = ctx.requestId, current = ctx.current.bind(ctx);
    const gone = () => new HubProtocolError("unavailable");
    const who = await ctx.requirePerson();
    if (!current()) throw gone();
    const own = options.fleets().filter((f) => f.owner.realm === who.realm && f.owner.objectId === who.objectId);
    const rows: FleetRow[] = own.map((f) => ({ id: f.id, label: typeof f.label === "string" ? f.label.slice(0, 120) : null, status: f.status === "active" ? "active" : "revoked" }));
    const readiness = options.readiness();
    if (readiness === "unavailable") throw gone();
    const legacy = (): GroupWelcomeResponse => ({ ok: true, v: 1, mode: "legacy", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "deny", maxFleets: 0, fleets: rows } });
    if (readiness !== "ready") return legacy();
    const { policy, decisions } = await options.policy().describe(who, { requestId, current });
    if (!current()) throw gone();
    if (policy.state === "never-enabled") return legacy();
    const fleets: FleetRow[] = [];
    for (let i = 0; i < own.length; i++) {
      const f = own[i]!, row = rows[i]!;
      if (row.status !== "active" || !options.fleetState) { fleets.push(row); continue; }
      let status: FleetRow["status"] = "unknown";
      if (Number.isSafeInteger(f.generation)) {
        try {
          const s = await options.fleetState({ kind: "fleet", id: f.id, revision: f.generation!, owner: f.owner });
          status = s === null ? "active" : s.state === "suspended" ? "suspended" : s.state === "active" ? "active" : "unknown";
        } catch { status = "unknown"; }
        if (!current()) throw gone();
      }
      fleets.push({ ...row, status });
    }
    const pair = decisions.pair_fleet;
    return { ok: true, v: 1, mode: policy.state === "suspended" ? "suspended" : "enabled",
      chat: entry(decisions.ask_agents), publish: entry(decisions.publish_agents),
      connect: { ...entry(pair), maxFleets: pair.outcome === "allow" ? pair.maxFleets : 0, fleets } };
  };
}
