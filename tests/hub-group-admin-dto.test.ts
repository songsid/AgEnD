/**
 * #3298 S-89/S-88 seam (contract on M-2624): the closed request shapes of Hub Administration → Group permissions (admin-dto.ts).
 * Behaviour-free: these pin what the HTTP layer accepts before the S-88 control is called.
 */
import { describe, expect, it } from "vitest";
import { applyRequest, previewRequest, resolveRequest, resumeRequest } from "../src/hub/group-policy/admin-dto.js";
import { initialGroupPolicy } from "../src/hub/group-policy/model.js";

const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const DN = "CN=Hub-Members,OU=Groups,DC=example,DC=test";
const policy = { ...initialGroupPolicy("corp", "gen-1"), state: "enabled", groups: [{ group: { realm: "corp", objectId: ID }, dn: DN, allow: ["ask_agents"], maxFleets: 1 }] };

describe("group policy admin request shapes", () => {
  it("resolve takes one DN, no control characters", () => {
    expect(resolveRequest.parse({ dn: DN })).toEqual({ dn: DN });
    for (const bad of [{ dn: "" }, { dn: "CN=a\u0000" }, { dn: DN, id: ID }, {}]) expect(resolveRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("preview takes the whole policy; each group keeps its selected key with its DN", () => {
    expect(previewRequest.parse({ policy })).toEqual({ policy });
    const group = policy.groups[0]!;
    for (const bad of [
      { policy: { ...policy, groups: [{ dn: DN, allow: ["ask_agents"], maxFleets: 1 }] } },                       // no selected key
      { policy: { ...policy, groups: [{ ...group, group: { realm: "corp", objectId: "not-a-guid" } }] } },
      { policy: { ...policy, groups: [{ ...group, group: { realm: "other", objectId: ID } }] } },                   // another realm
      { policy: { ...policy, groups: [{ ...group, allow: ["admin"] }] } }, { policy: { ...policy, groups: [{ ...group, maxFleets: 9 }] } },
      { policy: { ...policy, state: "on" } }, { policy, extra: 1 }, {},
    ]) expect(previewRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("apply takes the previewed policy and that preview's digest", () => {
    const ok = { policy, previewDigest: "a".repeat(64) };
    expect(applyRequest.parse(ok)).toEqual(ok);
    for (const bad of [{ ...ok, previewDigest: "x" }, { policy }, { ...ok, revision: 2 }]) expect(applyRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("resume names one exact resource with the policy and lifecycle revisions shown", () => {
    const ok = { resource: { kind: "exposure", id: "exp-1", revision: 4 }, expectedPolicyRevision: 3, expectedLifecycleRevision: 2 };
    expect(resumeRequest.parse(ok)).toEqual(ok);
    for (const bad of [{ ...ok, expectedLifecycleRevision: undefined }, { ...ok, resource: { ...ok.resource, kind: "room" } }, { ...ok, resource: { ...ok.resource, owner: "x" } }, { ...ok, revision: 3 }])
      expect(resumeRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
