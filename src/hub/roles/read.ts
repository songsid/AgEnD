import { readHubSqlRow } from "../read-statement.js";
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

// One non-secret decoded policy image may remain after unmount. This caches only
// a pure codec, never a binding, clock, floor, directory result or operation permit.
let decodedPolicy: HubCanonicalPolicy | undefined;
/** Test isolation only; clearing the codec memo grants no authority. */
export function resetCanonicalPolicyDecodeMemoForTest(): void { decodedPolicy = undefined; }
function copyPolicy(image: HubCanonicalPolicy): HubCanonicalPolicy {
  if (image.kind === "group") return Object.freeze({ kind: "group", raw: image.raw, policy: structuredClone(image.policy) });
  return Object.freeze({ kind: "roles", raw: image.raw, policy: structuredClone(image.policy) });
}
/** Both formats are strict. A role document is never flattened into legacy group rules. */
export function parseCanonicalPolicy(raw: string): HubCanonicalPolicy {
  if (typeof raw === "string" && decodedPolicy?.raw === raw) return copyPolicy(decodedPolicy);
  const value = parseStrictJson(raw);
  const image: HubCanonicalPolicy = value !== null && typeof value === "object" && Object.hasOwn(value, "rolesActive")
    ? { kind: "roles", raw, policy: parseRolePolicy(value) }
    : { kind: "group", raw, policy: parseGroupPolicy(value) };
  const out = copyPolicy(image);
  // Exact strings and successful decodes only. A failed attempt leaves the slot alone.
  if (typeof raw === "string") decodedPolicy = image;
  return out;
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

interface PolicyReaderOptions {
  db: Database.Database; hubId: string; realm: string; generation: string; current(): boolean;
}
/** One physical row and exact selected Hub/directory binding; no creation, repair or migration. */
export function createHubCanonicalPolicyReader(options: PolicyReaderOptions): () => HubCanonicalPolicy {
  return createReader(options, false);
}
/** Management only: retain the existing configured-root repair route for an intact legacy never-enabled image. */
export function createHubManagementPolicyReader(options: PolicyReaderOptions): () => HubCanonicalPolicy {
  return createReader(options, true);
}
function createReader(options: PolicyReaderOptions, legacyRepair: boolean): () => HubCanonicalPolicy {
  const hubId = validated(identifier, options.hubId), binding = initialGroupPolicy(options.realm, options.generation), current = options.current;
  let decoded: HubCanonicalPolicy | undefined;
  return () => {
    if (current() !== true) throw new HubProtocolError("unavailable");
    const row = readHubSqlRow(options.db, "SELECT hub_id,body FROM hub_group_policy WHERE singleton=1") as { hub_id: string; body: string } | undefined;
    if (!row || row.hub_id !== hubId) throw new HubProtocolError("unavailable");
    const known = decoded?.raw === row.body;
    const result = known ? copyPolicy(decoded!) : parseCanonicalPolicy(row.body);
    const repair = legacyRepair && result.kind === "group" && result.policy.state === "never-enabled";
    if (result.policy.realm !== binding.realm || result.policy.generation !== binding.generation && !repair
      || current() !== true) throw new HubProtocolError("unavailable");
    if (!known) decoded = copyPolicy(result);
    return result;
  };
}
