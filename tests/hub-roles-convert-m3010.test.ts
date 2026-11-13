import { describe, expect, it } from "vitest";
import { evaluateGroupPolicy, GROUP_CAPABILITIES, parseGroupPolicy } from "../src/hub/group-policy/model.js";
import { convertGroupPolicy } from "../src/hub/roles/convert.js";
import { evaluateRolePolicy } from "../src/hub/roles/evaluate.js";
import { BUILTIN_ROLE_IDS } from "../src/hub/roles/model.js";
const root = { realm: "corp", objectId: "00000000-0000-4000-8000-000000000000" }, user = { ...root, objectId: "11111111-1111-4111-8111-111111111111" };
const ids = Array.from({ length: 8 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`);
const rules = (limit = 0) => ids.map((objectId, mask) => ({ group: { realm: "corp", objectId }, dn: `CN=Rule${mask}`, allow: GROUP_CAPABILITIES.filter((_, bit) => mask & (1 << bit)), maxFleets: limit }));
const old = (state: "never-enabled" | "enabled" | "suspended" = "enabled") => parseGroupPolicy({ realm: "corp", generation: "g1", revision: 42, state, groups: rules(), denies: [] });
const options = { root, now: 200, rolesActive: true };
describe("pure legacy-to-role conversion, with no storage cutover", () => {
  it("preserves all eight bitsets, including empty, exact zero quotas, IDs and no automatic root self grant", () => {
    const before = old(), after = convertGroupPolicy(before, options);
    expect(after).toMatchObject({ realm: before.realm, generation: before.generation, revision: 42, state: "enabled", everEnabled: true, rolesActive: true });
    expect(after.assignments).toHaveLength(8); expect(after.roles.filter(r => r.kind === "carried-over")).toHaveLength(7);
    for (let i = 0; i < 8; i++) {
      const a = after.assignments.find(a => a.subject.kind === "group" && a.subject.group.objectId === ids[i])!;
      expect(a).toMatchObject({ maxFleets: 0, scope: { kind: "hub" }, startsAt: 0, expiresAt: null });
      expect(after.roles.find(r => r.id === a.roleId)!.permissions).toEqual(before.groups[i]!.allow);
      if (i === 7) expect(a.roleId).toBe(BUILTIN_ROLE_IDS.member);
    }
    expect(after.assignments.every(a => a.subject.kind === "group")).toBe(true);
    expect(convertGroupPolicy(before, options)).toEqual(after);
    expect(convertGroupPolicy({ ...before, groups: [...before.groups].reverse() }, options)).toEqual(after);
    after.denies.push({ person: user, deny: ["ask_agents"] }); expect(before.denies).toEqual([]);
    const facts = { kind: "complete" as const, person: root, groups: [], observedAt: 100 };
    expect(evaluateRolePolicy(after, root, "pair_fleet", null, { subject: facts }, 200, root).outcome).toBe("deny");
  });
  it("matches legacy outcomes, authoritativeness and MAX quota across states, combinations, overlap, denies and zero", () => {
    let checked = 0;
    for (const state of ["never-enabled", "enabled", "suspended"] as const) for (let quota = 0; quota <= 8; quota++) for (let mask = 0; mask < 8; mask++) for (const denied of [false, true]) for (const overlap of [false, true]) {
      const before = old(state); before.groups = rules(quota);
      const overlapId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      if (overlap) before.groups.push({ group: { realm: "corp", objectId: overlapId }, dn: "CN=Overlap", allow: [...GROUP_CAPABILITIES], maxFleets: 2 });
      if (denied) before.denies = [{ person: user, deny: ["ask_agents", "pair_fleet"] }];
      const after = convertGroupPolicy(before, options);
      const facts = { kind: "complete" as const, person: user, groups: overlap ? [ids[mask]!, overlapId] : [ids[mask]!], observedAt: 100 };
      for (const cap of GROUP_CAPABILITIES) {
        const expected = evaluateGroupPolicy(before, user, cap, facts), actual = evaluateRolePolicy(after, user, cap, null, { subject: facts }, 200, root);
        expect(actual).toMatchObject({ outcome: expected.outcome, authoritative: expected.authoritative, maxFleets: expected.maxFleets }); checked++;
      }
      after.rolesActive = false;
      expect(evaluateRolePolicy(after, user, "pair_fleet", null, { subject: facts }, 200, root).outcome).toBe(evaluateGroupPolicy(before, user, "pair_fleet", facts).outcome);
    }
    expect(checked).toBe(2592);
  });
  it("preserves unknown/ineligible and exact denies; validates migration metadata and explicit activation choice", () => {
    const before = old(); before.denies = [{ person: user, deny: ["publish_agents"] }];
    const after = convertGroupPolicy(before, { ...options, rolesActive: false }); expect(after.denies).toEqual(before.denies); expect(after.rolesActive).toBe(false);
    for (const facts of [{ kind: "unknown" } as const, { kind: "ineligible", person: user, reason: "gone", observedAt: 100 } as const]) {
      expect(evaluateRolePolicy(after, user, "publish_agents", null, { subject: facts }, 200, root).outcome).toBe(evaluateGroupPolicy(before, user, "publish_agents", facts).outcome);
    }
    for (const over of [{ root: { ...root, realm: "other" } }, { now: -1 }, { now: Number.NaN }]) expect(() => convertGroupPolicy(before, { ...options, ...over })).toThrow();
    expect(() => convertGroupPolicy({ ...before, groups: [before.groups[0], before.groups[0]] }, options)).toThrow();
  });
});
