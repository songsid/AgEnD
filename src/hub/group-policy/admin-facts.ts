/** Fresh bounded membership observations for a local-admin impact preview, never an action allowance. */
import type { HubDirectory } from "../directory/types.js";
import type { PolicyGroupFacts } from "../directory/groups.js";
import type { PersonKey } from "../types.js";
import { personKeyString } from "../identity.js";
import { person, uuid, validated } from "../validation.js";

export async function readHubGroupImpactFacts(options: {
  directory: HubDirectory; people: readonly { readonly key: PersonKey }[]; now(): number;
  /** Do not start another LDAP request after this bounded preparation budget. Unobserved people stay explicitly HELD. */
  deadline: number; assertCurrent(): void;
}) {
  const keys = options.people.map(p => validated(person, p.key)), facts = new Map<string, PolicyGroupFacts>();
  const { directory, now, deadline, assertCurrent } = options;
  for (const who of keys) {
    assertCurrent(); let result: PolicyGroupFacts = { kind: "unknown" };
    const started = now();
    if (started < deadline && directory.groupPolicy === "ad-direct-guid" && directory.realm === who.realm && directory.readPolicyGroups) {
      try {
        const observed = await directory.readPolicyGroups(Object.freeze({ ...who })), finished = now();
        // Copy the entire validated result before any subsequent await; typed driver output is still not an allow cache.
        if (observed.kind !== "unknown" && personKeyString(validated(person, observed.person)) === personKeyString(who)
          && Number.isSafeInteger(observed.observedAt) && observed.observedAt >= started && observed.observedAt <= finished) {
          if (observed.kind === "ineligible" && ["gone", "disabled"].includes(observed.reason)) result = { kind: "ineligible", person: { ...who }, reason: observed.reason, observedAt: observed.observedAt };
          else if (observed.kind === "complete" && Array.isArray(observed.groups) && observed.groups.length > 0 && observed.groups.length <= 256 && observed.groups.every(g => uuid.safeParse(g).success)) {
            result = { kind: "complete", person: { ...who }, groups: [...new Set(observed.groups)].sort(), observedAt: observed.observedAt };
          }
        }
      } catch { /* Failed/partial/unsupported observations remain unknown, not complete empty groups. */ }
    }
    assertCurrent(); facts.set(personKeyString(who), result);
  }
  // Fresh observation timestamps differ between preview and apply; semantic identity/membership must still match.
  const semantic = JSON.stringify([...facts].map(([id, fact]) => [id, fact.kind === "complete" ? { kind: fact.kind, groups: fact.groups }
    : fact.kind === "ineligible" ? { kind: fact.kind, reason: fact.reason } : { kind: "unknown" }]));
  return { facts, semantic };
}
