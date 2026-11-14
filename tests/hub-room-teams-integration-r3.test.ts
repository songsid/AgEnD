/** The real HTTP/session/SQLite composition of C's Team provider and R's room consumers. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { createHubTeams, HUB_TEAMS_MIGRATION, HUB_TEAM_GRANTS_MIGRATION } from "../src/hub/teams/index.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig();
  const lead = r.addPerson("lead", "Team lead"), member = r.addPerson("member", "Member"), outsider = r.addPerson("outsider", "Outsider");
  const department = randomUUID();
  Object.assign(r.directory, { groupPolicy: "ad-direct-guid" });
  r.directory.checkPolicyGroup = async key => ({ ok: true, group: { key, dn: "CN=Engineering,DC=example,DC=test" } });
  r.directory.searchGrantPeople = async () => ({ ok: true, people: [{ person: member, displayName: "Member", login: "member" }], truncated: false });
  r.directory.searchPolicyGroups = async () => ({ ok: true, groups: [{ objectId: department, cn: "Engineering", dn: "CN=Engineering,DC=example,DC=test" }], truncated: false });
  r.httpDeps.uow.atomic(tx => { HUB_TEAMS_MIGRATION.up(r!.sql(tx)); HUB_TEAM_GRANTS_MIGRATION.up(r!.sql(tx)); });
  let instances = 0;
  r.httpDeps.teams = core => { instances++; return createHubTeams(core); };
  await r.restartHttp();
  const admin = await r.signIn("admin"), l = await r.signIn("lead"), m = await r.signIn("member"), o = await r.signIn("outsider");
  const leadId = personKeyString(lead), memberId = personKeyString(member), outsiderId = personKeyString(outsider);
  const create = () => r!.call(admin, "POST", "/hub/v1/teams", { name: "Project", department, lead: leadId, members: [memberId] });
  return { admin, l, m, o, leadId, memberId, outsiderId, department, create, instances: () => instances };
}

it("mounts one Team instance for CRUD, static suggestions and room candidates", async () => {
  const w = await world();
  expect((await r!.call(null, "GET", "/hub/v1/teams")).status).toBe(401);
  const made = await w.create(); expect(made.status).toBe(201);
  const team = made.json.team;
  expect(team).toMatchObject({ name: "Project", department: w.department, lead: w.leadId, members: [w.leadId, w.memberId].sort() });
  expect((await r!.call(w.m, "GET", "/hub/v1/teams")).json.teams).toContainEqual(expect.objectContaining({ id: team.id }));
  expect((await r!.call(w.m, "GET", `/hub/v1/teams/${team.id}`)).json.team.id).toBe(team.id);
  expect((await r!.call(w.admin, "GET", "/hub/v1/teams/candidates?kind=group&q=En")).json).toEqual({ candidates: [{ kind: "group", id: w.department, name: "Engineering" }] });
  expect((await r!.call(w.admin, "GET", "/hub/v1/rooms/candidates?kind=team&q=Pro")).json.candidates).toEqual([{ kind: "team", id: team.id, name: "Project", people: 2 }]);
  expect((await r!.call(w.m, "GET", "/hub/v1/session")).json.features).toContain("teams-v1");
  expect(w.instances()).toBe(1);
});

it("keeps Team routes and the feature absent without the provider", async () => {
  r = await s3bRig(); const admin = await r.signIn("admin");
  expect((await r.call(admin, "GET", "/hub/v1/teams")).status).toBe(404);
  expect((await r.call(admin, "GET", "/hub/v1/session")).json.features).not.toContain("teams-v1");
});

it("allows the current lead to edit the roster while reserving name, lead and deletion for the admin", async () => {
  const w = await world(), made = await w.create(), path = `/hub/v1/teams/${made.json.team.id}`;
  expect((await r!.call(w.l, "PATCH", path, { members: [w.leadId, w.outsiderId] })).json.team.members).toEqual([w.leadId, w.outsiderId].sort());
  expect((await r!.call(w.l, "PATCH", path, { name: "Not allowed" })).status).toBe(403);
  expect((await r!.call(w.o, "PATCH", path, { members: [w.leadId, w.memberId] })).status).toBe(403);
  expect((await r!.call(w.l, "DELETE", path)).status).toBe(403);
  expect((await r!.call(w.admin, "PATCH", path, { name: "Renamed" }, { "X-AgEnD-Hub-CSRF": "" })).status).toBe(403);
  expect((await r!.call(w.admin, "PATCH", path, { name: "Renamed" })).json.team.name).toBe("Renamed");
  expect((await r!.call(w.admin, "DELETE", path)).json).toEqual({ ok: true });
  expect((await r!.call(w.m, "GET", path)).status).toBe(404);
});

it("serves person suggestions to the current lead only with the exact Team selection", async () => {
  const w = await world(), made = await w.create(), suffix = `&teamId=${made.json.team.id}`;
  expect((await r!.call(w.l, "GET", `/hub/v1/teams/candidates?kind=person&q=Me${suffix}`)).json).toEqual({ candidates: [{ kind: "person", id: w.memberId, name: "Member", login: "member" }] });
  expect((await r!.call(w.l, "GET", "/hub/v1/teams/candidates?kind=person&q=Me")).status).toBe(403);
  expect((await r!.call(w.l, "GET", `/hub/v1/teams/candidates?kind=group&q=En${suffix}`)).status).toBe(403);
  expect((await r!.call(w.o, "GET", `/hub/v1/teams/candidates?kind=person&q=Me${suffix}`)).status).toBe(403);
});

it("uses the same live roster for creators while room membership remains a snapshot", async () => {
  const w = await world(), made = await w.create(), teamId = made.json.team.id;
  await r!.call(w.admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [], teams: [teamId] });
  expect((await r!.call(w.m, "GET", "/hub/v1/rooms?v=2")).json.me.canCreateRooms).toBe(true);
  const room = await r!.call(w.m, "POST", "/hub/v1/rooms", { name: "Snapshot", teams: [teamId] }); expect(room.status).toBe(200);
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/teams/${teamId}`, { members: [w.leadId] })).status).toBe(200);
  expect((await r!.call(w.m, "GET", "/hub/v1/rooms?v=2")).json.me.canCreateRooms).toBe(false);
  expect((await r!.call(w.m, "GET", `/hub/v1/rooms/${room.json.room.id}`)).status).toBe(200);
  expect((await r!.call(w.l, "GET", `/hub/v1/rooms/${room.json.room.id}`)).status).toBe(200);
});

it("projects canAsk for a Team grant and removes it after a live roster edit without changing room membership", async () => {
  const w = await world(), made = await w.create(), teamId = made.json.team.id;
  const exposureId = randomUUID(), link = r!.link(randomUUID(), r!.admin);
  await r!.http.receive(r!.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner: r!.admin,
    displayName: "Project notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const grant = await r!.call(w.admin, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, days: 1, subject: { kind: "team", teamId } }); expect(grant.status).toBe(200);
  const room = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Team asks", people: [w.memberId, w.outsiderId], agents: [exposureId] }); expect(room.status).toBe(200);
  const path = `/hub/v1/rooms/${room.json.room.id}`;
  const canAsk = async (browser: typeof w.m) => (await r!.call(browser, "GET", path)).json.members.find((m: { id: string }) => m.id === exposureId).canAsk;
  expect(await canAsk(w.m)).toBe(true); expect(await canAsk(w.o)).toBe(false);
  const retained = r!.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(grant.json.grant.id);
  await r!.call(w.l, "PATCH", `/hub/v1/teams/${teamId}`, { members: [w.leadId] });
  expect(await canAsk(w.m)).toBe(false);
  expect(r!.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(grant.json.grant.id)).toEqual(retained);
});
