import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readHubGroupImpactFacts } from "../src/hub/group-policy/admin-facts.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubDirectory, PersonKey } from "../src/hub/types.js";
import type { PolicyGroupFacts } from "../src/hub/directory/groups.js";

const key = (): PersonKey => ({ realm: "example", objectId: randomUUID() });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let clock = 100, current = true;
  const first = key(), second = key(), group = randomUUID(), another = randomUUID();
  const read = vi.fn(async (person: PersonKey): Promise<PolicyGroupFacts> => ({ kind: "complete", person, groups: [group], observedAt: clock }));
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", readPolicyGroups: read } as unknown as HubDirectory;
  const options = { directory, people: [{ key: first }, { key: second }], now: () => clock, deadline: 120,
    assertCurrent() { if (!current) throw Error("stale session"); } };
  return { first, second, group, another, options, read, time: (value: number) => { clock = value; }, stop: () => { current = false; } };
}
describe("fresh facts for the sealed group impact preview", () => {
  it("compares semantic membership independently of timestamps and directory order, without sharing driver arrays", async () => {
    const w = fixture(), groups = [w.another, w.group, w.group];
    w.read.mockImplementation(async person => ({ kind: "complete", person, groups, observedAt: w.options.now() }));
    const before = await readHubGroupImpactFacts(w.options); groups.reverse(); w.time(110);
    const after = await readHubGroupImpactFacts(w.options);
    expect(after.semantic).toBe(before.semantic);
    expect(before.facts.get(personKeyString(w.first))).toEqual({ kind: "complete", person: w.first, groups: [...new Set(groups)].sort(), observedAt: 100 });
    groups.length = 0; expect(before.facts.get(personKeyString(w.first))).toHaveProperty("groups", [w.another, w.group].sort());
  });
  it.each(["empty", "over-limit", "malformed-guid", "wrong-person", "wrong-realm", "stale", "future", "invalid-time", "thrown"] as const)("keeps %s observations unknown instead of a complete negative", async changed => {
    const w = fixture();
    w.read.mockImplementation(async person => {
      if (changed === "thrown") throw Error("directory unavailable");
      return { kind: "complete", person: changed === "wrong-person" ? key() : changed === "wrong-realm" ? { ...person, realm: "other" } : person,
        groups: changed === "empty" ? [] : changed === "over-limit" ? Array.from({ length: 257 }, () => randomUUID()) : changed === "malformed-guid" ? ["invalid"] : [w.group],
        observedAt: changed === "stale" ? 99 : changed === "future" ? 101 : changed === "invalid-time" ? NaN : 100 };
    });
    const result = await readHubGroupImpactFacts(w.options);
    expect([...result.facts.values()]).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
  });
  it.each(["gone", "disabled"] as const)("preserves a fresh immutable %s result for authoritative narrowing", async reason => {
    const w = fixture(); w.read.mockImplementation(async person => ({ kind: "ineligible", person, reason, observedAt: 100 }));
    const result = await readHubGroupImpactFacts(w.options);
    expect(result.facts.get(personKeyString(w.first))).toEqual({ kind: "ineligible", person: w.first, reason, observedAt: 100 });
  });
  it("does not start another physical directory read after its budget, and retains remaining people as HELD", async () => {
    const w = fixture(), held = gate<PolicyGroupFacts>(), entered = gate<PersonKey>();
    w.read.mockImplementationOnce(person => { entered.resolve(person); return held.promise; });
    const pending = readHubGroupImpactFacts(w.options), person = await entered.promise;
    expect(w.read).toHaveBeenCalledTimes(1); w.time(125);
    held.resolve({ kind: "complete", person, groups: [w.group], observedAt: 100 });
    const result = await pending;
    expect(w.read).toHaveBeenCalledTimes(1); expect(result.facts.get(personKeyString(w.first))).toHaveProperty("kind", "complete");
    expect(result.facts.get(personKeyString(w.second))).toEqual({ kind: "unknown" });
  });
  it("snapshots all subject keys before an await and copies each result before the next await", async () => {
    const w = fixture(), originalSecond = { ...w.second }, firstHeld = gate<PolicyGroupFacts>(), firstEntered = gate<PersonKey>(), held = gate<PolicyGroupFacts>(), entered = gate<PersonKey>();
    const observed: PolicyGroupFacts = { kind: "complete", person: { ...w.first }, groups: [w.group], observedAt: 100 };
    w.read.mockImplementationOnce(person => { firstEntered.resolve(person); return firstHeld.promise; }).mockImplementationOnce(person => { entered.resolve(person); return held.promise; });
    const pending = readHubGroupImpactFacts(w.options); await firstEntered.promise;
    Object.assign(w.options.people[1]!.key, { objectId: randomUUID() }); firstHeld.resolve(observed);
    const person = await entered.promise; expect(person).toEqual(originalSecond);
    if (observed.kind === "complete") { (observed.groups as string[]).length = 0; Object.assign(observed.person, { objectId: randomUUID() }); }
    held.resolve({ kind: "complete", person, groups: [w.another], observedAt: 100 });
    const result = await pending;
    expect(result.facts.get(personKeyString(w.first))).toHaveProperty("groups", [w.group]);
    expect(result.facts.get(personKeyString(originalSecond))).toHaveProperty("groups", [w.another]);
  });
  it("does not turn a lost request/session fence into a tolerated directory outage", async () => {
    const w = fixture(); w.read.mockImplementationOnce(async person => { w.stop(); return { kind: "complete", person, groups: [w.group], observedAt: 100 }; });
    await expect(readHubGroupImpactFacts(w.options)).rejects.toThrow("stale session"); expect(w.read).toHaveBeenCalledOnce();
  });
  it.each(["unsupported", "foreign-realm", "missing-reader"] as const)("makes no directory call for %s", async changed => {
    const w = fixture(); Object.assign(w.options.directory, changed === "unsupported" ? { groupPolicy: undefined }
      : changed === "foreign-realm" ? { realm: "other" } : { readPolicyGroups: undefined });
    const result = await readHubGroupImpactFacts(w.options);
    expect([...result.facts.values()]).toEqual([{ kind: "unknown" }, { kind: "unknown" }]); expect(w.read).not.toHaveBeenCalled();
  });
});
