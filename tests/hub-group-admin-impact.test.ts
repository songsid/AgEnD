/** Pure confirmation-plan semantics only. No authority, directory I/O, policy write or resource mutation. */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildHubGroupImpact, type HubGroupImpactResource } from "../src/hub/group-policy/admin-impact.js";
import { initialGroupPolicy, type HubGroupPolicy } from "../src/hub/group-policy/model.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";
import { personKeyString } from "../src/hub/identity.js";
const key = () => ({ realm: "example", objectId: randomUUID() });
function fixture() {
  const administrator = key(), owner = key(), asker = key(), group = key(), other = key();
  const before = initialGroupPolicy("example", "generation-1");
  const next: HubGroupPolicy = { ...before, state: "enabled", groups: [{ group, dn: "CN=Members,DC=example,DC=test",
    allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 2 }] };
  const people = [{ key: administrator, name: "Avery Admin", login: "avery", hasAskGrant: false },
    { key: owner, name: "Morgan Owner", login: "morgan", hasAskGrant: false }, { key: asker, name: "Riley Asker", login: "riley", hasAskGrant: true }];
  const resource = (kind: "fleet" | "exposure" | "asker", source: "manual" | "group" | null = null): HubGroupImpactResource => {
    const person = kind === "asker" ? asker : owner, id = kind === "asker" ? asker.objectId : randomUUID();
    return { resource: { kind, id, revision: 1, owner: person }, display: { kind, id, revision: 1, label: kind === "exposure" ? "Helper" : null, owner: { name: kind === "asker" ? "Riley Asker" : "Morgan Owner" } },
      lifecycle: source ? { source, state: "active", revision: 1 } : null };
  };
  const facts = new Map<string, PolicyGroupFacts>(people.map(p => [personKeyString(p.key), { kind: "complete", person: p.key,
    groups: [p.key === owner ? group.objectId : other.objectId], observedAt: 100 }]));
  const resources = [resource("fleet"), resource("exposure")];
  return { before, next, administrator, owner, asker, group, other, people, facts, resources, resource };
}
describe("group-policy confirmation impact", () => {
  it("names the grant holder and configured admin outside Chat, with exact manual inventory kept and no automatic pairing loss invented", () => {
    const w = fixture(), result = buildHubGroupImpact(w);
    expect(result.impact.adminLosesChat).toBe(true);
    expect(result.impact.losingActions).toEqual([
      { personId: personKeyString(w.administrator), name: "Avery Admin", login: "avery", capabilities: ["ask_agents"] },
      { personId: personKeyString(w.asker), name: "Riley Asker", login: "riley", capabilities: ["ask_agents"] },
    ].sort((a, b) => a.personId.localeCompare(b.personId)));
    expect(result.capture).toHaveLength(2); expect(result.impact.grandfathered).toHaveLength(2);
    expect(result.suspend).toEqual([]); expect(result.impact.held).toEqual([]); expect(result.impact.losingPublication).toEqual([]);
  });
  it("shows unknown people separately as HELD, never as a denial or a resource suspension", () => {
    const w = fixture(); w.before = { ...w.next }; w.resources = [w.resource("fleet", "group"), w.resource("exposure", "group"), w.resource("asker", "group")];
    for (const p of w.people) w.facts.set(personKeyString(p.key), { kind: "unknown" });
    const result = buildHubGroupImpact(w);
    expect(result.impact.held).toHaveLength(3);
    expect(result.impact.held.every(p => p.reason === "membership-unknown" && p.capabilities?.length === 3)).toBe(true);
    expect(result.impact.losingActions).toEqual([]); expect(result.impact.losingPublication).toEqual([]);
    expect(result.suspend).toEqual([]); expect(result.capture).toEqual([]); expect(result.impact.adminLosesChat).toBe(false);
  });
  it("plans complete-negative suspension only for active group-derived resources", () => {
    const w = fixture(); w.before = { ...w.next };
    w.resources = [w.resource("fleet", "group"), w.resource("exposure", "group"), w.resource("asker", "group"), w.resource("exposure", "manual")];
    w.facts.set(personKeyString(w.owner), { kind: "complete", person: w.owner, groups: [w.other.objectId], observedAt: 100 });
    const result = buildHubGroupImpact(w);
    expect(result.suspend).toHaveLength(3); expect(result.impact.suspendedOnSave).toHaveLength(3);
    expect(result.impact.grandfathered).toEqual([w.resources[3]!.display]); expect(result.impact.losingPublication).toHaveLength(1);
  });
  it("makes an explicit person deny visible and suspends even exact manual publication, independently of unknown membership", () => {
    const w = fixture(); w.before = { ...w.next }; w.resources = [w.resource("exposure", "manual")];
    w.facts.set(personKeyString(w.owner), { kind: "unknown" }); w.next = { ...w.next, denies: [{ person: w.owner, deny: ["publish_agents"] }] };
    const result = buildHubGroupImpact(w);
    expect(result.suspend).toEqual([w.resources[0]!.resource]); expect(result.impact.grandfathered).toEqual([]);
    expect(result.impact.losingPublication).toEqual([{ personId: personKeyString(w.owner), name: "Morgan Owner", login: "morgan" }]);
    expect(result.impact.held.find(p => p.personId === personKeyString(w.owner))?.capabilities).toEqual(["ask_agents", "pair_fleet"]);
  });
  it("switching off suspends group rows, keeps manual rows and does not infer a directory outage", () => {
    const w = fixture(); w.before = { ...w.next }; w.next = { ...w.next, state: "suspended" };
    w.resources = [w.resource("fleet", "group"), w.resource("exposure", "manual")]; w.facts.clear();
    const result = buildHubGroupImpact(w);
    expect(result.suspend).toEqual([w.resources[0]!.resource]); expect(result.impact.grandfathered).toEqual([w.resources[1]!.display]);
    expect(result.impact.held).toEqual([]);
  });
  it("rejoining or switching on never plans a suspended row's resumption", () => {
    const w = fixture(); w.before = { ...w.next, state: "suspended" }; const row = w.resource("exposure", "group");
    w.resources = [{ ...row, lifecycle: { ...row.lifecycle!, state: "suspended" } }];
    const result = buildHubGroupImpact(w);
    expect(result.capture).toEqual([]); expect(result.suspend).toEqual([]); expect(result.impact.grandfathered).toEqual([]);
  });
  it("a reduced positive fleet limit applies to new enrollment and does not suspend existing fleets", () => {
    const w = fixture(); w.before = { ...w.next }; w.next = { ...w.next, groups: w.next.groups.map(g => ({ ...g, maxFleets: 1 })) };
    w.resources = [w.resource("fleet", "group"), w.resource("fleet", "group")];
    expect(buildHubGroupImpact(w).suspend).toEqual([]);
  });
  it("names an owner who loses new publication while keeping existing exact manual revisions", () => {
    const w = fixture(); w.facts.set(personKeyString(w.owner), { kind: "complete", person: w.owner, groups: [w.other.objectId], observedAt: 100 });
    const result = buildHubGroupImpact(w);
    expect(result.impact.losingPublication).toEqual([{ personId: personKeyString(w.owner), name: "Morgan Owner", login: "morgan" }]);
    expect(result.capture).toHaveLength(2); expect(result.impact.grandfathered).toHaveLength(2); expect(result.suspend).toEqual([]);
  });
  it("never grandfather askers and captures only exact business revisions with independent nested keys", () => {
    const w = fixture(), row = w.resource("asker", "group"); w.resources.push(row);
    const result = buildHubGroupImpact(w); expect(result.capture).toHaveLength(2);
    const copy = result.capture[0]!, originalOwner = w.owner.objectId; w.resources.find(r => r.resource.id === copy.id)!.resource.owner.objectId = randomUUID();
    expect(copy.owner.objectId).toBe(originalOwner);
    expect(result.capture.some(r => r.kind === "asker")).toBe(false);
  });
  it.each(["realm", "generation", "revision", "never-enabled-reset", "suspend-never-enabled"] as const)("refuses invalid %s before creating a confirmation plan", changed => {
    const w = fixture();
    if (changed === "realm") w.next = { ...w.next, realm: "other", groups: [] };
    else if (changed === "generation") w.next = { ...w.next, generation: "other-generation" };
    else if (changed === "revision") w.next = { ...w.next, revision: 2 };
    else if (changed === "never-enabled-reset") { w.before = { ...w.next }; w.next = { ...w.before, state: "never-enabled" }; }
    else w.next = { ...w.next, state: "suspended" };
    expect(() => buildHubGroupImpact(w)).toThrow("group_policy_invalid");
  });
});
