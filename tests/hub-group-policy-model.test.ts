import { describe, expect, it } from "vitest";
import { evaluateGroupPolicy, initialGroupPolicy, parseGroupPolicy } from "../src/hub/group-policy/model.js";
import { extendedGroupIds } from "../src/hub/directory/groups.js";
const user = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" };
const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const group = (id = a, maxFleets = 1) => ({ group: { realm: "example", objectId: id }, dn: "CN=Owners,DC=example,DC=test", allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets });
const policy = (over: Record<string, unknown> = {}) => parseGroupPolicy({ ...initialGroupPolicy("example", "generation-1"), state: "enabled", groups: [group()], ...over });
const facts = (groups = [a]) => ({ kind: "complete" as const, person: user, groups, observedAt: 100 });

describe("reviewed Hub group policy model", () => {
  it("starts never-enabled and supplies no new legacy allowance", () => {
    expect(initialGroupPolicy("example", "generation-1")).toMatchObject({ state: "never-enabled", groups: [], revision: 1 });
    expect(evaluateGroupPolicy(initialGroupPolicy("example", "generation-1"), user, "pair_fleet", { kind: "unknown" })).toMatchObject({ outcome: "legacy", reason: "legacy" });
  });
  it("unions permissions and takes the largest fleet limit, not the sum", () => {
    const p = policy({ groups: [group(a, 1), { ...group(b, 3), allow: ["pair_fleet"] }] });
    expect(evaluateGroupPolicy(p, user, "pair_fleet", facts([a, b]))).toMatchObject({ outcome: "allow", maxFleets: 3, groups: [a, b] });
    expect(evaluateGroupPolicy(p, user, "ask_agents", facts([b]))).toMatchObject({ outcome: "deny", reason: "no-group" });
  });
  it("per-person deny wins every group allow and cannot become an outside-group allow", () => {
    expect(evaluateGroupPolicy(policy({ denies: [{ person: user, deny: ["ask_agents"] }] }), user, "ask_agents", facts())).toMatchObject({ outcome: "deny", reason: "person-denied" });
    expect(() => policy({ denies: [{ person: user, allow: ["ask_agents"], deny: [] }] })).toThrow();
  });
  it("requires a positive fleet limit as well as pairing permission", () => {
    expect(evaluateGroupPolicy(policy({ groups: [group(a, 0)] }), user, "pair_fleet", facts())).toMatchObject({ outcome: "deny" });
    expect(evaluateGroupPolicy(policy({ groups: [group(a, 0)] }), user, "ask_agents", facts())).toMatchObject({ outcome: "allow" });
  });
  it("unknown never becomes an authoritative removal; complete negative does", () => {
    expect(evaluateGroupPolicy(policy(), user, "publish_agents", { kind: "unknown" })).toMatchObject({ outcome: "unknown", authoritative: false });
    expect(evaluateGroupPolicy(policy(), user, "publish_agents", facts([b]))).toMatchObject({ outcome: "deny", authoritative: true, reason: "no-group" });
    expect(evaluateGroupPolicy(policy(), user, "publish_agents", { kind: "ineligible", person: user, reason: "disabled", observedAt: 100 })).toMatchObject({ outcome: "deny", reason: "ineligible" });
  });
  it("switch-off suspension denies even a current matching group", () => {
    expect(evaluateGroupPolicy(policy({ state: "suspended" }), user, "ask_agents", facts())).toMatchObject({ outcome: "deny", reason: "suspended" });
  });
  it("matches immutable GUIDs through rename and reuse of the old DN", () => {
    const renamed = extendedGroupIds({ memberOf: `<GUID=${a}>;CN=Renamed,DC=example,DC=test` })!;
    const recreated = extendedGroupIds({ memberOf: `<GUID=${b}>;CN=Owners,DC=example,DC=test` })!;
    expect(evaluateGroupPolicy(policy(), user, "ask_agents", facts([...renamed]))).toMatchObject({ outcome: "allow" });
    expect(evaluateGroupPolicy(policy(), user, "ask_agents", facts([...recreated]))).toMatchObject({ outcome: "deny" });
  });
  it.each([
    { signin: true }, { nested: true }, { state: "off" }, { groups: [group(), group()] },
    { groups: [{ ...group(), maxFleets: 9 }] }, { groups: [{ ...group(), allow: ["ask_agents", "ask_agents"] }] },
    { groups: [{ ...group(), group: { ...user, realm: "other" } }] },
    { denies: [{ person: user, deny: [] }, { person: user, deny: [] }] },
  ])("rejects unapproved/widened policy shape %j", over => expect(() => policy(over)).toThrow());
  it("refuses wrong-person/realm, malformed IDs or unbounded membership as unknown", () => {
    for (const f of [{ ...facts(), person: { ...user, objectId: b } }, { ...facts(), person: { ...user, realm: "other" } }, facts(["not-guid"]), facts(Array(257).fill(a)), { ...facts(), observedAt: -1 }]) {
      expect(evaluateGroupPolicy(policy(), user, "ask_agents", f)).toMatchObject({ outcome: "unknown", authoritative: false });
    }
    expect(evaluateGroupPolicy(policy(), { ...user, realm: "other" }, "ask_agents", facts())).toMatchObject({ outcome: "unknown" });
  });
});
describe("same-response extended-DN facts", () => {
  it("accepts dashed GUIDs with optional SID, deduplicates and returns no mutable DN identity", () => {
    expect(extendedGroupIds({ memberOf: [`<GUID=${a.toUpperCase()}>;<SID=S-1-5-21-42>;CN=A,DC=example,DC=test`, `<GUID=${a}>;CN=Renamed,DC=example,DC=test`] })).toEqual([a]);
    expect(extendedGroupIds({ MEMBEROF: [] })).toBeNull();
  });
  it.each([
    {}, { memberOf: "CN=Owners,DC=example,DC=test" }, { memberOf: `<GUID=${a.replaceAll("-", "")}>;CN=A` },
    { "memberOf;range=0-1499": [`<GUID=${a}>;CN=A`] }, { memberOf: [`<GUID=${a}>;CN=A`, "CN=Plain"] },
    { memberOf: Buffer.from("DN") }, { memberOf: [`<GUID=${a}>;CN=A\n`] },
    { memberOf: Array(257).fill(`<GUID=${a}>;CN=A`) }, { memberOf: [], MEMBEROF: [] },
  ])("does not mistake missing/plain/partial data for negative proof: %j", entry => expect(extendedGroupIds(entry)).toBeNull());
});
