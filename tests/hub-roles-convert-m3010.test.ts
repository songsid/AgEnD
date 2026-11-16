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

describe("T1 compatibility required before production role cutover", () => {
  it("keeps named-person allowed-list capabilities and exact Fleet quotas", () => {
    const before=parseGroupPolicy({...old(),groups:[],people:[{person:user,name:"Named person",allow:[...GROUP_CAPABILITIES],maxFleets:6}]});
    const after=convertGroupPolicy(before,options),facts={subject:{kind:"eligible" as const,person:user,observedAt:100}};
    for (const cap of GROUP_CAPABILITIES) expect(evaluateRolePolicy(after,user,cap,null,facts,200,root))
      .toMatchObject({outcome:evaluateGroupPolicy(before,user,cap,facts.subject).outcome,maxFleets:6});
  });
  it("keeps local-team allowed-list capabilities through role activation", () => {
    const teamId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const before=parseGroupPolicy({...old(),groups:[],teams:[{teamId,name:"Selected team",allow:[...GROUP_CAPABILITIES],maxFleets:4}]});
    const after=convertGroupPolicy(before,options),facts={subject:{kind:"eligible" as const,person:user,observedAt:100},teams:[teamId]};
    for (const cap of GROUP_CAPABILITIES) expect(evaluateRolePolicy(after,user,cap,null,facts,200,root))
      .toMatchObject({outcome:evaluateGroupPolicy(before,user,cap,facts.subject,facts.teams).outcome,maxFleets:4});
  });
});

it("preserves T1 union/MAX/denies across activation and forward-only roles off", async () => {
  const teamId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const {planRoleChange}=await import("../src/hub/roles/change.js");
  for(const state of ["never-enabled","enabled","suspended"] as const) for(const rolesActive of [false,true]) for(const deny of [false,true]) {
    const before=parseGroupPolicy({...old(state),groups:[],teams:[{teamId,name:"Team",allow:[...GROUP_CAPABILITIES],maxFleets:3}],
      people:[{person:user,name:"Person",allow:[...GROUP_CAPABILITIES],maxFleets:7}],denies:deny ? [{person:user,deny:["pair_fleet"]}] : []});
    const after=convertGroupPolicy(before,{...options,rolesActive}),facts={subject:{kind:"eligible" as const,person:user,observedAt:100},teams:[teamId]};
    for(const cap of GROUP_CAPABILITIES) {
      const expected=evaluateGroupPolicy(before,user,cap,facts.subject,facts.teams);
      expect(evaluateRolePolicy(after,user,cap,null,facts,200,root)).toMatchObject({outcome:expected.outcome,maxFleets:expected.maxFleets,authoritative:expected.authoritative});
    }
    expect(after.people).toEqual(before.people);expect(after.teams).toEqual(before.teams);
    expect(() => planRoleChange(after,{...after,people:[]},root,200)).toThrow();
    expect(() => planRoleChange(after,{...after,teams:[]},root,200)).toThrow();
  }
});

it("a carried person ask-only rule cannot grant publish or pair",()=>{
 const before=parseGroupPolicy({...old(),groups:[],people:[{person:user,name:"Person",allow:["ask_agents"],maxFleets:7}]});
 const after=convertGroupPolicy(before,options),facts={subject:{kind:"eligible" as const,person:user,observedAt:100}};
 expect(evaluateRolePolicy(after,user,"ask_agents",null,facts,200,root).outcome).toBe("allow");
 for(const cap of ["publish_agents","pair_fleet"] as const) expect(evaluateRolePolicy(after,user,cap,null,facts,200,root)).toMatchObject({outcome:"deny",maxFleets:0});
});
it("a carried team ask-only rule cannot grant publish or pair",()=>{
 const teamId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const before=parseGroupPolicy({...old(),groups:[],teams:[{teamId,name:"Team",allow:["ask_agents"],maxFleets:4}]});
 const after=convertGroupPolicy(before,options),facts={subject:{kind:"eligible" as const,person:user,observedAt:100},teams:[teamId]};
 expect(evaluateRolePolicy(after,user,"ask_agents",null,facts,200,root).outcome).toBe("allow");
 for(const cap of ["publish_agents","pair_fleet"] as const) expect(evaluateRolePolicy(after,user,cap,null,facts,200,root)).toMatchObject({outcome:"deny",maxFleets:0});
});
it("missing or invalid local team facts stay unknown on the role side",()=>{
 const teamId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const before=parseGroupPolicy({...old(),groups:[],teams:[{teamId,name:"Team",allow:["ask_agents"],maxFleets:4}]});
 const after=convertGroupPolicy(before,options),subject={kind:"eligible" as const,person:user,observedAt:100};
 expect(evaluateRolePolicy(after,user,"ask_agents",null,{subject},200,root)).toMatchObject({outcome:"unknown",authoritative:false});
 expect(evaluateRolePolicy(after,user,"ask_agents",null,{subject,teams:["invalid"]},200,root)).toMatchObject({outcome:"unknown",authoritative:false});
 expect(evaluateRolePolicy(after,user,"ask_agents",null,{subject,teams:[]},200,root).outcome).toBe("deny");
});
