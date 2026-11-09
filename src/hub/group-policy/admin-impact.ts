/** Pure confirmation projection. Facts must be freshly acquired by the server control; this returns no action permit. */
import type { PersonKey } from "../types.js";
import { personKeyString } from "../identity.js";
import { person, validated } from "../validation.js";
import type { PolicyGroupFacts } from "../directory/groups.js";
import { evaluateGroupPolicy, GROUP_CAPABILITIES, parseGroupPolicy, type GroupCapability, type HubGroupDecision, type HubGroupPolicy } from "./model.js";
import { parseHubGroupResource, type HubGroupResource, type HubGroupResourceView } from "./resources.js";
import { HubGroupPolicyError } from "./store.js";
import type { GroupImpact, GroupImpactPerson, GroupImpactResource } from "./admin-dto.js";

export interface HubGroupImpactPerson {
  readonly key: PersonKey; readonly name: string | null; readonly login: string | null; readonly hasAskGrant: boolean;
}
export interface HubGroupImpactResource {
  readonly resource: HubGroupResource; readonly display: GroupImpactResource;
  readonly lifecycle: Pick<HubGroupResourceView, "source" | "state" | "revision"> | null;
}
export interface HubGroupHeldImpact extends GroupImpactPerson { readonly reason: "membership-unknown"; readonly capabilities: readonly GroupCapability[] }
const capability = (r: HubGroupResource): GroupCapability => r.kind === "fleet" ? "pair_fleet" : r.kind === "exposure" ? "publish_agents" : "ask_agents";
const denied = (p: HubGroupPolicy, key: PersonKey, cap: GroupCapability) => p.state !== "never-enabled"
  && p.denies.some(d => personKeyString(d.person) === personKeyString(key) && d.deny.includes(cap));
/** Explicit narrowing is confirmed independently of an uncertain directory observation. */
function decision(p: HubGroupPolicy, key: PersonKey, cap: GroupCapability, facts: PolicyGroupFacts): HubGroupDecision {
  if (denied(p, key, cap)) return { outcome: "deny", reason: "person-denied", authoritative: true, groups: [], maxFleets: 0 };
  return evaluateGroupPolicy(p, key, cap, facts);
}
export function buildHubGroupImpact(input: {
  before: HubGroupPolicy; next: HubGroupPolicy; administrator: PersonKey;
  people: readonly HubGroupImpactPerson[]; resources: readonly HubGroupImpactResource[];
  facts: ReadonlyMap<string, PolicyGroupFacts>;
}) {
  const before = parseGroupPolicy(input.before), next = parseGroupPolicy(input.next), administrator = validated(person, input.administrator);
  if (next.realm !== before.realm || next.generation !== before.generation || next.revision !== before.revision || administrator.realm !== before.realm) throw new HubGroupPolicyError("invalid");
  if ((before.state !== "never-enabled" && next.state === "never-enabled") || (before.state === "never-enabled" && next.state === "suspended")) throw new HubGroupPolicyError("invalid");
  const people = new Map<string, HubGroupImpactPerson>(), owners = new Set<string>();
  const add = (value: HubGroupImpactPerson) => {
    const key = validated(person, value.key), id = personKeyString(key);
    if (key.realm !== before.realm || people.has(id)) throw new HubGroupPolicyError("invalid");
    people.set(id, { key, name: value.name, login: value.login, hasAskGrant: value.hasAskGrant });
  };
  for (const p of input.people) add(p);
  if (!people.has(personKeyString(administrator))) add({ key: administrator, name: null, login: null, hasAskGrant: false });
  const resources = input.resources.map(row => {
    const resource = parseHubGroupResource(row.resource), id = personKeyString(resource.owner);
    if (resource.owner.realm !== before.realm || (resource.kind === "asker" && row.lifecycle?.source === "manual")) throw new HubGroupPolicyError("invalid");
    if (!people.has(id)) add({ key: resource.owner, name: null, login: null, hasAskGrant: false });
    if (resource.kind !== "asker") owners.add(id);
    return { resource, lifecycle: row.lifecycle, display: { kind: resource.kind, id: resource.id, revision: resource.revision,
      label: row.display.label, owner: row.display.owner ? { name: row.display.owner.name } : null } };
  }).sort((a, b) => JSON.stringify(a.resource).localeCompare(JSON.stringify(b.resource)));
  const losingActions: GroupImpactPerson[] = [], losingPublication: GroupImpactPerson[] = [], held: HubGroupHeldImpact[] = [];
  for (const [id, p] of [...people].sort(([a], [b]) => a.localeCompare(b))) {
    const facts = input.facts.get(id) ?? { kind: "unknown" as const }, losing: GroupCapability[] = [], uncertain: GroupCapability[] = [];
    for (const cap of GROUP_CAPABILITIES) {
      const current = decision(before, p.key, cap, facts), after = decision(next, p.key, cap, facts);
      if (after.outcome === "unknown") uncertain.push(cap);
      else if (after.outcome === "deny") {
        const grantOrAdmin = p.hasAskGrant || id === personKeyString(administrator);
        const legacyAction = current.outcome === "legacy" && (cap === "ask_agents" ? grantOrAdmin : cap === "publish_agents" && owners.has(id));
        if (current.outcome === "allow" || legacyAction || (cap === "ask_agents" && grantOrAdmin)) losing.push(cap);
      }
    }
    const display = { personId: id, name: p.name, login: p.login };
    if (losing.length) losingActions.push({ ...display, capabilities: losing });
    if (uncertain.length) held.push({ ...display, capabilities: uncertain, reason: "membership-unknown" });
    if (owners.has(id) && decision(next, p.key, "publish_agents", facts).outcome === "deny") losingPublication.push(display);
  }
  const capture: HubGroupResource[] = [], suspend: HubGroupResource[] = [], grandfathered: GroupImpactResource[] = [], suspendedOnSave: GroupImpactResource[] = [];
  for (const row of resources) {
    const r = row.resource, firstEnable = before.state === "never-enabled" && next.state === "enabled" && r.kind !== "asker";
    if (firstEnable && row.lifecycle?.source === "group") throw new HubGroupPolicyError("conflict");
    const manual = row.lifecycle?.source === "manual" || firstEnable, active = row.lifecycle?.state !== "suspended";
    if (firstEnable && !row.lifecycle) capture.push(r);
    const after = decision(next, r.owner, capability(r), input.facts.get(personKeyString(r.owner)) ?? { kind: "unknown" });
    const narrowing = manual ? denied(next, r.owner, capability(r)) : row.lifecycle?.source === "group" && after.outcome === "deny" && after.authoritative;
    if (active && narrowing) { suspend.push(r); suspendedOnSave.push(row.display); }
    else if (active && manual) grandfathered.push(row.display);
  }
  const adminAfter = decision(next, administrator, "ask_agents", input.facts.get(personKeyString(administrator)) ?? { kind: "unknown" });
  const impact: GroupImpact & { readonly held: readonly HubGroupHeldImpact[] } = {
    losingActions, losingPublication, grandfathered, suspendedOnSave, adminLosesChat: adminAfter.outcome === "deny", held,
  };
  return { impact, capture, suspend };
}
