/** Exact canonical policy image. Reading supplies no directory facts or operation authority. */
import type Database from "better-sqlite3";
import { initialGroupPolicy, parseGroupPolicy, type HubGroupPolicy } from "../group-policy/model.js";
import { HubProtocolError, identifier, parseStrictJson, validated } from "../validation.js";
import { parseRolePolicy, ROLE_POLICY_MAX_ASSIGNMENTS, type HubRolePolicy } from "./model.js";
import type { DirectoryPolicyGroup } from "../directory/groups.js";

export const MAX_POLICY_DIRECTORY_GROUPS = 2 * ROLE_POLICY_MAX_ASSIGNMENTS;

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

/** Retained graph continuity, including future/expired/off assignments; display DNs are not identities. */
export function collectPolicyDirectoryGroups(input: HubCanonicalPolicy["policy"]): readonly DirectoryPolicyGroup[] {
  const groups = "rolesActive" in input ? parseRolePolicy(input).assignments.flatMap(a => [
    ...(a.subject.kind === "group" ? [{ key: a.subject.group, dn: a.subject.dn }] : []),
    ...(a.scope.kind === "group" ? [{ key: a.scope.group, dn: a.scope.dn }] : []),
  ]) : parseGroupPolicy(input).groups.map(g => ({ key: g.group, dn: g.dn }));
  const retained = new Map(groups.map(g => [JSON.stringify([g.key.realm, g.key.objectId, g.dn]), g]));
  return [...retained].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, g]) => structuredClone(g));
}

/** Directory Save and compensation rebind the current graph; neither restores an old policy snapshot. */
export function rebindCanonicalPolicy(document: HubCanonicalPolicy, generation: string): HubCanonicalPolicy {
  if (document.policy.revision === Number.MAX_SAFE_INTEGER) throw new HubProtocolError("conflict");
  const next = parseCanonicalPolicy(JSON.stringify({ ...document.policy, generation: validated(identifier, generation), revision: document.policy.revision + 1 }));
  if (next.kind !== document.kind) throw new HubProtocolError("conflict");
  return next;
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
