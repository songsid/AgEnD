/** Team-scoped directory feedback: actual SQLite/session contexts, inert bounded directory methods. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubSessions } from "../src/hub/sessions.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubRequestContext } from "../src/hub/types.js";
import { createHubTeams, HUB_TEAMS_MIGRATION, type HubTeams } from "../src/hub/teams/index.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig();
  const lead = r.addPerson("lead"), member = r.addPerson("member"), other = r.addPerson("other");
  const department = randomUUID();
  const people = vi.fn(async () => ({ ok: true as const, people: [{ person: member, displayName: "Riley", login: "member" }], truncated: false }));
  const groups = vi.fn(async () => ({ ok: true as const, groups: [{ objectId: department, cn: "Engineering", dn: "CN=Engineering,DC=example,DC=test" }], truncated: false }));
  Object.assign(r.directory, { groupPolicy: "ad-direct-guid", searchGrantPeople: people, searchPolicyGroups: groups });
  r.directory.checkPolicyGroup = async key => ({ ok: true, group: { key, dn: "CN=Engineering,DC=example,DC=test" } });
  r.httpDeps.uow.atomic(tx => HUB_TEAMS_MIGRATION.up(r!.sql(tx)));
  const core = new HubCore(r.httpDeps, r.sql), sessions = new HubSessions(core), teams = createHubTeams(core);
  const context = async (login: string) => { const browser = await r!.signIn(login);
    return sessions.context({ headers: { cookie: browser.cookie } } as IncomingMessage); };
  const admin = await context("admin"), leadCtx = await context("lead"), otherCtx = await context("other");
  const team = await teams.create(admin, { name: "Project", department, lead: personKeyString(lead) });
  return { teams, team, admin, leadCtx, otherCtx, people, groups, department, lead, member, other };
}
function suggestions(teams: HubTeams, ctx: HubRequestContext, input: unknown): Promise<readonly { kind: string; id: string; name: string }[]> {
  const method = Reflect.get(teams, "suggestions"); expect(method).toBeTypeOf("function");
  return Reflect.apply(method, teams, [ctx, input]);
}

it("offers feedback to an admin or the current Team lead, without granting department search to leads or writing people", async () => {
  const w = await world();
  expect(await suggestions(w.teams, w.admin, { kind: "group", q: "En" })).toEqual([{ kind: "group", id: w.department, name: "Engineering" }]);
  expect(await suggestions(w.teams, w.admin, { kind: "person", q: "Ri" })).toEqual([{ kind: "person", id: personKeyString(w.member), name: "Riley", login: "member" }]);
  expect(await suggestions(w.teams, w.leadCtx, { kind: "person", q: "Ri", teamId: w.team.id })).toHaveLength(1);
  await expect(suggestions(w.teams, w.leadCtx, { kind: "person", q: "Ri" })).rejects.toMatchObject({ code: "denied" });
  await expect(suggestions(w.teams, w.leadCtx, { kind: "group", q: "En", teamId: w.team.id })).rejects.toMatchObject({ code: "denied" });
  await expect(suggestions(w.teams, w.otherCtx, { kind: "person", q: "Ri", teamId: w.team.id })).rejects.toMatchObject({ code: "denied" });
  expect(w.people).toHaveBeenCalledTimes(2); expect(w.groups).toHaveBeenCalledTimes(1);
  expect(r!.db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(personKeyString(w.member))).toBeUndefined();
  expect(w.teams.read(r!.db, w.team.id)?.members).toEqual([personKeyString(w.lead)]);
});

it("validates prefixes and result bounds before disclosing directory feedback", async () => {
  const w = await world();
  for (const q of ["x", " x", "x".repeat(65), "Ri\u0000"]) {
    await expect(suggestions(w.teams, w.admin, { kind: "person", q })).rejects.toMatchObject({ code: "invalid" });
  }
  expect(w.people).not.toHaveBeenCalled();
  w.people.mockResolvedValueOnce({ ok: true, people: Array.from({ length: 21 }, () => ({ person: w.member, displayName: "Riley", login: "member" })), truncated: false });
  await expect(suggestions(w.teams, w.admin, { kind: "person", q: "Ri" })).rejects.toMatchObject({ code: "unavailable" });
  w.people.mockResolvedValueOnce({ ok: true, people: [{ person: { ...w.member, realm: "elsewhere" }, displayName: "Riley", login: "member" }], truncated: false });
  await expect(suggestions(w.teams, w.admin, { kind: "person", q: "Ri" })).rejects.toMatchObject({ code: "unavailable" });
});

it("withholds a held search after the lead or exact Team image changes", async () => {
  const w = await world(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = w.people.getMockImplementation()!;
  w.people.mockImplementationOnce(async () => { entered(); await held; return original(); });
  const pending = suggestions(w.teams, w.leadCtx, { kind: "person", q: "Ri", teamId: w.team.id }); await started;
  await w.teams.update(w.admin, w.team.id, { lead: personKeyString(w.other) }); release();
  await expect(pending).rejects.toMatchObject({ code: "conflict" });
});

it("withholds a held search after sign-out or directory-method replacement", async () => {
  for (const change of ["session", "method"] as const) {
    const w = await world(); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const original = w.people.getMockImplementation()!;
    w.people.mockImplementationOnce(async () => { entered(); await held; return original(); });
    const pending = suggestions(w.teams, w.leadCtx, { kind: "person", q: "Ri", teamId: w.team.id }); await started;
    if (change === "session") r!.db.prepare("DELETE FROM hub_sessions WHERE person=?").run(personKeyString(w.lead));
    else r!.directory.searchGrantPeople = async () => original();
    release(); await expect(pending).rejects.toBeDefined();
    await r!.close(); r = undefined;
  }
});

it("bounds feedback per real session without reading the directory again after the cap", async () => {
  const w = await world();
  for (let i = 0; i < 30; i++) await suggestions(w.teams, w.leadCtx, { kind: "person", q: "Ri", teamId: w.team.id });
  await expect(suggestions(w.teams, w.leadCtx, { kind: "person", q: "Ri", teamId: w.team.id })).rejects.toMatchObject({ code: "backpressure" });
  expect(w.people).toHaveBeenCalledTimes(30);
});
