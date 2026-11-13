/** Actual SQLite/UOW and Hub session contexts; directory facts are inert, no external AD or agent calls. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubSessions } from "../src/hub/sessions.js";
import { personKeyString } from "../src/hub/identity.js";
import { createHubTeams, HUB_TEAMS_MIGRATION, TEAM_LIMIT } from "../src/hub/teams/index.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig();
  const lead = r.addPerson("lead", "Team lead"), other = r.addPerson("other", "Other department"), replacement = r.addPerson("next", "Next lead");
  r.directory.checkPolicyGroup = async key => ({ ok: true, group: { key, dn: "CN=Engineering,DC=example,DC=test" } });
  const original = r.directory.checkEligibility.bind(r.directory);
  r.directory.checkEligibility = async key => { const value = await original(key);
    return value.eligible ? { ...value, person: { ...value.person, department: key.objectId === other.objectId ? "Design" : "Engineering" } } : value;
  };
  r.httpDeps.uow.atomic(tx => HUB_TEAMS_MIGRATION.up(r!.sql(tx)));
  const core = new HubCore(r.httpDeps, r.sql), sessions = new HubSessions(core), teams = createHubTeams(core);
  const context = async (login: string) => { const browser = await r!.signIn(login);
    return sessions.context({ headers: { cookie: browser.cookie } } as IncomingMessage); };
  const admin = await context("admin"), l = await context("lead"), o = await context("other");
  const department = randomUUID(), leadId = personKeyString(lead), otherId = personKeyString(other), nextId = personKeyString(replacement);
  const create = (members = [otherId]) => teams.create(admin, { name: "Project", department, lead: leadId, members });
  return { core, teams, admin, l, o, context, department, lead, other, replacement, leadId, otherId, nextId, create };
}

it("an admin creates an explicit cross-department roster and the lead is always included", async () => {
  const w = await world(), team = await w.create();
  expect(team).toMatchObject({ name: "Project", department: w.department, departmentName: "Engineering", lead: w.leadId,
    members: [w.leadId, w.otherId].sort(), revision: 1 });
  expect((await w.teams.get(w.admin, team.id)).memberInfo).toContainEqual(expect.objectContaining({ id: w.otherId, department: "Design" }));
  expect(r!.db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(w.nextId)).toBeUndefined();
  await expect(w.teams.create(w.l, { name: "No", department: w.department, lead: w.leadId })).rejects.toMatchObject({ code: "denied" });
});
it("only the admin or current lead changes members; only the admin changes the Team's name or lead", async () => {
  const w = await world(), team = await w.create();
  await expect(w.teams.update(w.o, team.id, { members: [w.leadId] })).rejects.toMatchObject({ code: "denied" });
  await expect(w.teams.update(w.l, team.id, { name: "Renamed" })).rejects.toMatchObject({ code: "denied" });
  const changed = await w.teams.update(w.l, team.id, { members: [w.leadId, w.nextId] });
  expect(changed.members).toEqual([w.leadId, w.nextId].sort());
  expect(w.teams.isMember(r!.db, team.id, w.otherId)).toEqual({ revision: 2, member: false });
});
it("replacing the lead includes the new person and keeps the former lead until a later removal", async () => {
  const w = await world(), team = await w.create();
  const changed = await w.teams.update(w.admin, team.id, { lead: w.nextId, members: [w.nextId] });
  expect(changed.members).toEqual([w.leadId, w.nextId].sort());
  await expect(w.teams.update(w.l, team.id, { members: [w.leadId] })).rejects.toMatchObject({ code: "denied" });
  const next = await w.context("next");
  expect((await w.teams.update(next, team.id, { members: [w.nextId] })).members).toEqual([w.nextId]);
  await expect(w.teams.update(next, team.id, { members: [] })).rejects.toMatchObject({ code: "conflict" });
});
it("a disabled lead stays in the roster with a warning observation and no automatic replacement", async () => {
  const w = await world(), team = await w.create();
  r!.people.get("lead")!.eligible = false;
  const detail = await w.teams.get(w.admin, team.id);
  expect(detail.leadEligible).toBe(false); expect(detail.lead).toBe(w.leadId); expect(detail.members).toContain(w.leadId);
  expect(w.teams.read(r!.db, team.id)?.revision).toBe(1);
});
it("snapshot expansion is deduplicated and frozen data, while live membership follows later edits and deletion", async () => {
  const w = await world(), team = await w.create(), before = w.teams.expand(r!.db, [team.id, team.id]);
  expect(before).toEqual({ teams: [{ id: team.id, revision: 1 }], people: [w.leadId, w.otherId].sort(), missing: [] });
  await w.teams.update(w.l, team.id, { members: [w.leadId] });
  expect(before.people).toContain(w.otherId); expect(w.teams.isMember(r!.db, team.id, w.otherId)?.member).toBe(false);
  await w.teams.remove(w.admin, team.id);
  expect(w.teams.read(r!.db, team.id)).toBeNull(); expect(w.teams.isMember(r!.db, team.id, w.leadId)).toBeNull();
  expect(w.teams.expand(r!.db, [team.id])).toEqual({ teams: [], people: [], missing: [team.id] });
  expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_team_members WHERE team_id=?").get(team.id)).toEqual({ n: 1 });
});
it("audit failure rolls the complete roster write back", async () => {
  const w = await world(), team = await w.create(); r!.setAuditFails(true, "team.updated");
  await expect(w.teams.update(w.l, team.id, { members: [w.leadId, w.nextId] })).rejects.toThrow("disk full");
  expect(w.teams.read(r!.db, team.id)).toMatchObject({ revision: 1, members: [w.leadId, w.otherId].sort() });
});
it("a roster changed during a held directory selection refuses instead of overwriting that edit", async () => {
  const w = await world(), team = await w.create();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = r!.directory.checkEligibility.bind(r!.directory);
  r!.directory.checkEligibility = async key => { if (key.objectId === w.replacement.objectId) { entered(); await held; } return original(key); };
  const changing = w.teams.update(w.l, team.id, { members: [w.leadId, w.nextId] }); await started;
  r!.db.prepare("UPDATE hub_teams SET revision=revision+1 WHERE id=?").run(team.id); release();
  await expect(changing).rejects.toMatchObject({ code: "conflict" });
  expect(w.teams.read(r!.db, team.id)).toMatchObject({ revision: 2, members: [w.leadId, w.otherId].sort() });
});
it("200 Teams and 200 selected members are independent from a room's smaller union limit", async () => {
  const w = await world(), team = await w.create();
  for (let n = 1; n < TEAM_LIMIT; n++) {
    const id = randomUUID();
    r!.db.prepare("INSERT INTO hub_teams SELECT ?,revision,name,department_realm,department_guid,department_name,lead,created_at,updated_at,deleted FROM hub_teams WHERE id=?").run(id, team.id);
    r!.db.prepare("INSERT INTO hub_team_members SELECT ?,person,display_name,login_label,department FROM hub_team_members WHERE team_id=?").run(id, team.id);
  }
  await expect(w.create()).rejects.toMatchObject({ code: "backpressure" });
  await expect(w.teams.update(w.admin, team.id, { members: Array.from({ length: 201 }, () => `corp/${randomUUID()}`) })).rejects.toMatchObject({ code: "invalid" });
});
it("candidate prefixes are literal and stable, and deleted teams disappear from the list", async () => {
  const w = await world(), team = await w.create();
  expect(w.teams.candidates(r!.db, "Proj")).toEqual([{ id: team.id, name: "Project", people: 2 }]);
  expect(w.teams.candidates(r!.db, "%")).toEqual([]);
  await expect(w.teams.remove(w.l, team.id)).rejects.toMatchObject({ code: "denied" });
  await w.teams.remove(w.admin, team.id); expect(await w.teams.list(w.admin)).toEqual([]);
});
