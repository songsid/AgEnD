/** Exact canonical policy image. Reading supplies no directory facts or operation authority. */
import type Database from "better-sqlite3";
import { initialGroupPolicy, parseGroupPolicy, type HubGroupPolicy } from "../group-policy/model.js";
import { HubProtocolError, identifier, parseStrictJson, validated } from "../validation.js";
import { parseRolePolicy, type HubRolePolicy } from "./model.js";

export type HubCanonicalPolicy =
  | { readonly kind: "group"; readonly raw: string; readonly policy: HubGroupPolicy }
  | { readonly kind: "roles"; readonly raw: string; readonly policy: HubRolePolicy };

/** Both formats are strict. A role document is never flattened into legacy group rules. */
export function parseCanonicalPolicy(raw: string): HubCanonicalPolicy {
  const value = parseStrictJson(raw);
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "rolesActive")) {
    return Object.freeze({ kind: "roles", raw, policy: parseRolePolicy(value) });
  }
  return Object.freeze({ kind: "group", raw, policy: parseGroupPolicy(value) });
}

/** One physical row and exact selected Hub/directory binding; no creation, repair or migration. */
export function createHubCanonicalPolicyReader(options: {
  db: Database.Database; hubId: string; realm: string; generation: string; current(): boolean;
}): () => HubCanonicalPolicy {
  const hubId = validated(identifier, options.hubId), binding = initialGroupPolicy(options.realm, options.generation), current = options.current;
  return () => {
    if (current() !== true) throw new HubProtocolError("unavailable");
    const row = options.db.prepare("SELECT hub_id,body FROM hub_group_policy WHERE singleton=1").get() as { hub_id: string; body: string } | undefined;
    if (!row || row.hub_id !== hubId) throw new HubProtocolError("unavailable");
    const result = parseCanonicalPolicy(row.body);
    if (result.policy.realm !== binding.realm || result.policy.generation !== binding.generation
      || current() !== true) throw new HubProtocolError("unavailable");
    return result;
  };
}
