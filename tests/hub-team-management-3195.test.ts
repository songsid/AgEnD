/** Real SQLite transactions and inert directory: no external AD or agent calls. */
import { afterEach, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubSessions } from "../src/hub/sessions.js";
import { personKeyString } from "../src/hub/identity.js";
import { createHubTeams, HUB_TEAM_MANAGEMENT_MIGRATION, HUB_TEAMS_MIGRATION } from "../src/hub/teams/index.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig({ realAudit: true });
  const a = r.addPerson("manager", "Manager"), b = r.addPerson("second", "Second lead"), c = r.addPerson("member", "Member"), x = r.addPerson("outside", "Outside");
  r.httpDeps.uow.atomic(tx => HUB_TEAMS_MIGRATION.up(r!.sql(tx)));
  r.httpDeps.uow.atomic(tx => HUB_TEAM_MANAGEMENT_MIGRATION.up(r!.sql(tx)));
  const core = new HubCore(r.httpDeps, r.sql), teams = createHubTeams(core), sessions = new HubSessions(core);
  const ctx = async (login: string) => { const s = await r!.signIn(login); return sessions.context({ headers: { cookie: s.cookie } } as IncomingMessage); };
  return { core, teams, admin: await ctx("admin"), manager: await ctx("manager"), second: await ctx("second"), member: await ctx("member"), outside: await ctx("outside"), ids: [a,b,c,x].map(personKeyString) };
}
it("an authorised creator is the first lead; every lead manages name, roster and other leads", async () => {
  const w = await world();
  await w.teams.saveSettings(w.admin, { revision: 1, creators: [{ kind: "person", id: w.ids[0] }] });
  const t = await w.teams.create(w.manager, { name: "Launch", members: [w.ids[2]] });
  expect(t).toMatchObject({ leads: [w.ids[0]], department: null, memberCount: 2 });
  const changed = await w.teams.update(w.manager, t.id, { leads: [w.ids[0],w.ids[1]], revision: t.revision });
  expect(changed.leads).toEqual([w.ids[0],w.ids[1]]);
  expect((await w.teams.update(w.second, t.id, { name: "Renamed" })).name).toBe("Renamed");
  await expect(w.teams.update(w.member, t.id, { name: "Forged" })).rejects.toMatchObject({ code: "denied" });
  await expect(w.teams.update(w.second, t.id, { leads: [] })).rejects.toMatchObject({ code: "invalid" });
  await expect(w.teams.update(w.second, t.id, { leads: Array(6).fill(w.ids[0]) })).rejects.toMatchObject({ code: "invalid" });
  await w.teams.update(w.manager, t.id, { leads: [w.ids[1]], members: [w.ids[1],w.ids[2]] });
  await expect(w.teams.update(w.manager, t.id, { name: "No longer lead" })).rejects.toMatchObject({ code: "denied" });
  await w.teams.remove(w.second, t.id);
});
it("only admins edit creation permission; nonmembers see summaries, members see the roster", async () => {
  const w = await world();
  await expect(w.teams.create(w.manager, { name: "Denied" })).rejects.toMatchObject({ code: "denied" });
  await expect(w.teams.saveSettings(w.manager, { revision: 1, creators: [] })).rejects.toMatchObject({ code: "denied" });
  const t = await w.teams.create(w.admin, { name: "Private", members: [w.ids[2]] });
  const summary = (await w.teams.list(w.outside))[0];
  expect(summary).toMatchObject({ memberCount: 2, members: [] });
  expect(summary.memberInfo).toBeUndefined();
  await expect(w.teams.get(w.outside,t.id)).rejects.toMatchObject({ code: "denied" });
  expect((await w.teams.get(w.member,t.id)).memberInfo).toHaveLength(2);
  expect((await w.teams.get(w.member,t.id)).canManage).toBe(false);
});
it("AD group creation is explicit and a policy change during its lookup fails closed", async () => {
  const w = await world(), group = "12345678-1234-4123-8123-123456789abc";
  Object.assign(r!.directory,{groupPolicy:"ad-direct-guid"});
  r!.directory.checkPolicyGroup = async key => ({ok:true,group:{key,dn:"CN=Managers,DC=test"}});
  await w.teams.saveSettings(w.admin,{revision:1,creators:[{kind:"group",id:group}]});
  r!.directory.readPolicyGroups = async person => ({kind:"complete",person,groups:[group],observedAt:Date.now()});
  expect((await w.teams.settings(w.manager)).canCreate).toBe(true);
  expect((await w.teams.create(w.manager,{name:"Department free"})).department).toBeNull();
  let entered!:()=>void,release!:()=>void; const start=new Promise<void>(r => entered=r), held=new Promise<void>(r => release=r);
  r!.directory.readPolicyGroups = async person => {entered();await held;return {kind:"complete",person,groups:[group],observedAt:Date.now()};};
  const creating=w.teams.create(w.manager,{name:"Stale permission"}); await start;
  await w.teams.saveSettings(w.admin,{revision:2,creators:[]}); release();
  await expect(creating).rejects.toMatchObject({code:"conflict"});
  expect(r!.db.prepare("SELECT 1 FROM hub_teams WHERE name='Stale permission'").get()).toBeUndefined();
});
it("records member and lead changes with their actor and target, and audit failure rolls back", async () => {
  const w=await world(),t=await w.teams.create(w.admin,{name:"Audited",members:[w.ids[0]]});
  await w.teams.update(w.admin,t.id,{leads:[w.ids[0]],members:[w.ids[0]]});
  const rows=r!.db.prepare("SELECT action,actor,owner_at_event,reason_code FROM hub_audit WHERE reason_code=?").all(t.id) as any[];
  expect(rows).toContainEqual(expect.objectContaining({action:"team.lead-added",owner_at_event:w.ids[0],reason_code:t.id}));
  expect(rows.filter(r => r.action === "team.lead-added").every(row => JSON.parse(row.actor).kind === "person")).toBe(true);
  r!.setAuditFails(true,"team.member-added");
  await expect(w.teams.update(w.manager,t.id,{members:[w.ids[0],w.ids[1]]})).rejects.toThrow();
  expect(w.teams.read(r!.db,t.id)?.members).toEqual([w.ids[0]]);
});
it("migrates existing lead identity and defaults creation to administrators only", async () => {
  r=await s3bRig(); const member=r.addPerson("lead","Existing lead"),id="12345678-1234-4123-8123-123456789abc", person=personKeyString(member);
  r.httpDeps.uow.atomic(tx => {
    const db=r!.sql(tx); HUB_TEAMS_MIGRATION.up(db);
    db.prepare("INSERT INTO hub_teams VALUES(?,7,'Existing','','','',?,1,1,0)").run(id,person);
    db.prepare("INSERT INTO hub_team_members VALUES(?,?,?,'lead','')").run(id,person,"Existing lead");
    HUB_TEAM_MANAGEMENT_MIGRATION.up(db);
  });
  const teams=createHubTeams(new HubCore(r.httpDeps,r.sql));
  expect(teams.read(r.db,id)).toMatchObject({revision:7,lead:person,leads:[person],department:null,members:[person]});
  expect(r.db.prepare("SELECT creators FROM hub_team_creation_policy").get()).toEqual({creators:"[]"});
});
it("reads the primary-lead alias if a retained v1 import replaces it", async () => {
  const w=await world(),t=await w.teams.create(w.admin,{name:"Compatible",members:[w.ids[0],w.ids[1]]});
  await w.teams.update(w.admin,t.id,{leads:[w.ids[0],w.ids[1]]});
  r!.db.prepare("UPDATE hub_teams SET lead=?,revision=revision+1 WHERE id=?").run(w.ids[1],t.id);
  expect(w.teams.read(r!.db,t.id)?.leads).toEqual([w.ids[1]]);
});
it("uses a local canonical allowed-list reader for the Used-for detail", async () => {
  const w=await world(),t=await w.teams.create(w.admin,{name:"Used"});
  const reads:string[]=[]; const teams=createHubTeams(w.core,{allowedListUsesTeam:(db,id) => {expect(db).toBe(r!.db);reads.push(id);return true;}});
  expect((await teams.get(w.admin,t.id)).impact?.allowedList).toBe(true); expect(reads).toEqual([t.id]);
  expect((await w.teams.get(w.admin,t.id)).impact?.allowedList).toBe(false);
});
it("a non-admin creator cannot nominate extra leads during creation", async () => {
  const w=await world();
  await w.teams.saveSettings(w.admin,{revision:1,creators:[{kind:"person",id:w.ids[0]}]});
  await expect(w.teams.create(w.manager,{name:"Extra leads",leads:[w.ids[0],w.ids[1]]})).rejects.toMatchObject({code:"denied"});
  await expect(w.teams.create(w.manager,{name:"Other primary",lead:w.ids[1]})).rejects.toMatchObject({code:"denied"});
  expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_teams").get()).toEqual({n:0});
  expect((await w.teams.create(w.manager,{name:"Self lead",leads:[w.ids[0]]})).leads).toEqual([w.ids[0]]);
});
it("a group permit requires complete membership facts for the exact creator", async () => {
  const w=await world(),group="12345678-1234-4123-8123-123456789abc";
  Object.assign(r!.directory,{groupPolicy:"ad-direct-guid"});
  r!.directory.checkPolicyGroup=async key => ({ok:true,group:{key,dn:"CN=Managers,DC=test"}});
  await w.teams.saveSettings(w.admin,{revision:1,creators:[{kind:"group",id:group}]});
  r!.directory.readPolicyGroups=async () => ({kind:"unknown"});
  expect((await w.teams.settings(w.manager)).canCreate).toBe(false);
  await expect(w.teams.create(w.manager,{name:"Unknown facts"})).rejects.toMatchObject({code:"denied"});
  r!.directory.readPolicyGroups=async () => ({kind:"complete",person:await w.second.requirePerson(),groups:[group],observedAt:Date.now()});
  expect((await w.teams.settings(w.manager)).canCreate).toBe(false);
  await expect(w.teams.create(w.manager,{name:"Other person facts"})).rejects.toMatchObject({code:"denied"});
  expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_teams").get()).toEqual({n:0});
});
