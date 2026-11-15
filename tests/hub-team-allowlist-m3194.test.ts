import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { evaluateGroupPolicy, initialGroupPolicy, parseGroupPolicy } from "../src/hub/group-policy/model.js";
import { assertHubSelfUseDecisionCurrent, createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { HUB_TEAMS_MIGRATION, HUB_TEAM_MANAGEMENT_MIGRATION } from "../src/hub/teams/store.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import { hubAllowedListUsesTeam } from "../src/hub/group-policy/team-subjects.js";

const user = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" };
const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", teamId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const caps = ["ask_agents", "publish_agents", "pair_fleet"] as const;
const base = () => ({ ...initialGroupPolicy("example", "gen-1"), state: "enabled" as const });
const team = () => ({ teamId, name: "Product team", allow: [...caps], maxFleets: 4 });
const facts = () => ({ kind: "complete" as const, person: user, groups: [groupId], observedAt: 100 });
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys=ON");
  for (const m of [HUB_AUDIT_MIGRATION, HUB_TEAMS_MIGRATION, HUB_TEAM_MANAGEMENT_MIGRATION, groupPolicyMigration("hub-1", "example", "gen-1")]) m.up(db);
  db.prepare("INSERT INTO hub_teams VALUES(?,1,'Product team','example',?,'Department',?,100,100,0)").run(teamId, groupId, `example/${user.objectId}`);
  db.prepare("INSERT INTO hub_team_members VALUES(?,?,'Alex','alex','')").run(teamId, `example/${user.objectId}`);
  const readPolicyGroups = vi.fn(async () => facts());
  const checkEligibility = vi.fn<HubDirectory["checkEligibility"]>(async () => ({ eligible: true, person: { key: user, displayName: "Alex", login: "alex", dn: "CN=Alex,DC=example", groups: [] } }));
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", readPolicyGroups, checkEligibility } as unknown as HubDirectory;
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => 100 });
  const store = createHubGroupPolicyStore({ db, hubId: "hub-1", realm: "example", generation: "gen-1", directory, audit, current: () => true, now: () => 100 });
  const ctx = { requestId: "request-1", current: () => true };
  const enable = () => store.replace({ ...store.read(), state: "enabled", teams: [team()] }, user, ctx);
  return { db, store, ctx, enable, readPolicyGroups, checkEligibility };
}

describe("T1 allowed-list subjects", () => {
  it("preserves old policy JSON without inserting new empty fields", () => {
    const old = initialGroupPolicy("example", "gen-1"); expect(parseGroupPolicy(old)).toEqual(old);
    expect(parseGroupPolicy(old)).not.toHaveProperty("teams");
  });
  it("unions AD groups, teams and a person, taking the highest Fleet limit", () => {
    const p = parseGroupPolicy({ ...base(),
      groups: [{ group: { realm: "example", objectId: groupId }, dn: "CN=Department,DC=example", allow: ["pair_fleet"], maxFleets: 2 }],
      teams: [team()], people: [{ person: user, name: "Alex", allow: ["pair_fleet"], maxFleets: 7 }] });
    for (const cap of caps) expect(evaluateGroupPolicy(p, user, cap, facts(), [teamId])).toMatchObject({ outcome: "allow" });
    expect(evaluateGroupPolicy(p, user, "pair_fleet", facts(), [teamId])).toMatchObject({ maxFleets: 7 });
  });
  it("keeps a person exclusion ahead of every matching allowance", () => {
    const p = parseGroupPolicy({ ...base(), teams: [team()], people: [{ person: user, name: "Alex", allow: [...caps], maxFleets: 8 }], denies: [{ person: user, deny: ["ask_agents", "pair_fleet"] }] });
    expect(evaluateGroupPolicy(p, user, "ask_agents", facts(), [teamId])).toMatchObject({ outcome: "deny", reason: "person-denied" });
    expect(evaluateGroupPolicy(p, user, "pair_fleet", facts(), [teamId])).toMatchObject({ outcome: "deny", maxFleets: 0 });
    expect(evaluateGroupPolicy(p, user, "publish_agents", facts(), [teamId])).toMatchObject({ outcome: "allow" });
  });
  it("does not let local membership replace current AD eligibility", () => {
    const p = parseGroupPolicy({ ...base(), teams: [team()] });
    expect(evaluateGroupPolicy(p, user, "ask_agents", { kind: "unknown" }, [teamId])).toMatchObject({ outcome: "unknown", authoritative: false });
    expect(evaluateGroupPolicy(p, user, "ask_agents", { kind: "ineligible", person: user, observedAt: 100, reason: "disabled" }, [teamId])).toMatchObject({ outcome: "deny", reason: "ineligible" });
  });
  it("rejects duplicate or foreign person/team selections", () => {
    expect(() => parseGroupPolicy({ ...base(), teams: [team(), team()] })).toThrow();
    expect(() => parseGroupPolicy({ ...base(), people: [{ person: { ...user, realm: "other" }, name: "Alex", allow: [...caps], maxFleets: 1 }] })).toThrow();
  });
  it("checks a team-only policy with one eligibility read and no AD group lookup", async () => {
    const f = fixture(); f.enable();
    expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "allow" });
    expect(f.checkEligibility).toHaveBeenCalledTimes(1); expect(f.readPolicyGroups).not.toHaveBeenCalled();
  });
  it("observes removed or deleted teams on the next action", async () => {
    const f = fixture(); f.enable();
    expect(await f.store.check(user, "publish_agents", f.ctx)).toMatchObject({ outcome: "allow" });
    f.db.prepare("DELETE FROM hub_team_members WHERE team_id=?").run(teamId);
    expect(await f.store.check(user, "publish_agents", f.ctx)).toMatchObject({ outcome: "deny" });
    f.db.prepare("UPDATE hub_teams SET deleted=1,revision=revision+1 WHERE id=?").run(teamId);
    expect(await f.store.check(user, "pair_fleet", f.ctx)).toMatchObject({ outcome: "deny" });
  });
  it("fences an already prepared decision when its team roster changes", async () => {
    const f = fixture(); f.enable(); const decision = await f.store.check(user, "ask_agents", f.ctx);
    assertHubSelfUseDecisionCurrent(decision, 100);
    f.db.prepare("DELETE FROM hub_team_members WHERE team_id=?").run(teamId);
    expect(() => assertHubSelfUseDecisionCurrent(decision, 100)).toThrow();
  });
  it("lets a direct person allowance work without treating AD groups as the source", async () => {
    const f = fixture(); f.store.replace({ ...f.store.read(), state: "enabled", people: [{ person: user, name: "Alex", allow: [...caps], maxFleets: 5 }] }, user, f.ctx);
    expect(await f.store.check(user, "pair_fleet", f.ctx)).toMatchObject({ outcome: "allow", maxFleets: 5, groups: [] });
    expect(f.readPolicyGroups).not.toHaveBeenCalled();
    f.checkEligibility.mockResolvedValue({ eligible: false, reason: "disabled" });
    expect(await f.store.check(user, "ask_agents", f.ctx)).toMatchObject({ outcome: "deny", reason: "ineligible" });
  });
  it("canonicalizes removed optional subjects away on write for the legacy strict format", () => {
    const f = fixture(); f.enable();
    f.store.replace({ ...f.store.read(), people: [{ person: user, name: "Alex", allow: ["ask_agents"], maxFleets: 1 }] }, user, f.ctx);
    f.store.replace({ ...f.store.read(), teams: [], people: [] }, user, f.ctx);
    const stored = JSON.parse((f.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body);
    expect(stored).not.toHaveProperty("teams"); expect(stored).not.toHaveProperty("people");
    expect(f.store.read()).toEqual(stored);
  });
  it("exposes the local T2 Used-for hook without a second team model", () => {
    const f = fixture(); expect(hubAllowedListUsesTeam(f.db, teamId)).toBe(false); f.enable();
    expect(hubAllowedListUsesTeam(f.db, teamId)).toBe(true);
    f.store.replace({ ...f.store.read(), teams: [] }, user, f.ctx);
    expect(hubAllowedListUsesTeam(f.db, teamId)).toBe(false);
    f.db.prepare("UPDATE hub_group_policy SET body='broken'").run();
    expect(() => hubAllowedListUsesTeam(f.db, teamId)).toThrow();
  });
});
