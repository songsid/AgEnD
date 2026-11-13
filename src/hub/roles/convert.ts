/** In-memory conversion only. It does not cut over storage or rewrite any resource/provenance row. */
import { GROUP_CAPABILITIES, parseGroupPolicy } from "../group-policy/model.js";
import type { PersonKey } from "../types.js";
import { epoch, HubProtocolError, person, validated } from "../validation.js";
import { builtinRoles, BUILTIN_ROLE_IDS, parseRolePolicy, type HubRolePolicy } from "./model.js";
/** IDs, capability order and assignment order are deterministic, independent of legacy row order.
 * The caller explicitly selects rolesActive; this helper neither enables roles nor advances revisions.
 * assignedBy/assignedAt describe synthetic conversion metadata, never an existing Fleet's approver.
 */
export function convertGroupPolicy(input: unknown, options: { root: PersonKey; now: number; rolesActive: boolean }): HubRolePolicy {
  const old = parseGroupPolicy(input), root = validated(person, options.root), now = validated(epoch, options.now);
  if (root.realm !== old.realm) throw new HubProtocolError();
  const converted = parseRolePolicy({ realm: old.realm, generation: old.generation, revision: old.revision,
    rolesActive: options.rolesActive, state: old.state, everEnabled: old.state !== "never-enabled", roles: builtinRoles(), assignments: [], denies: old.denies });
  for (const rule of [...old.groups].sort((a, b) => a.group.objectId.localeCompare(b.group.objectId))) {
    const mask = GROUP_CAPABILITIES.reduce((bits, c, i) => bits | (rule.allow.includes(c) ? 1 << i : 0), 0);
    const roleId = mask === 7 ? BUILTIN_ROLE_IDS.member : `carried:${mask}`;
    if (!converted.roles.some(r => r.id === roleId)) converted.roles.push({ id: roleId, name: `Carried over ${mask}`, kind: "carried-over",
      permissions: GROUP_CAPABILITIES.filter((_, i) => mask & (1 << i)), defaultMaxFleets: 0 });
    converted.assignments.push({ id: `legacy:group:${rule.group.objectId}`, roleId,
      subject: { kind: "group", group: rule.group, dn: rule.dn }, scope: { kind: "hub" }, maxFleets: rule.maxFleets,
      startsAt: 0, expiresAt: null, assignedBy: root, assignedAt: now });
  }
  return parseRolePolicy(converted);
}
