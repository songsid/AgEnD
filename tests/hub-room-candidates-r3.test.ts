/** Room picker uses the production HTTP path and shared physical directory owner. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { createHubDirectoryAdmission } from "../src/hub/directory/admission.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig(); const alex = r.addPerson("alex", "Alex"), unseen = r.addPerson("new-person", "New Person");
  const admin = await r.signIn("admin"), a = await r.signIn("alex"); let entered = 0;
  const physical = createHubDirectoryAdmission(() => true);
  r.httpDeps.directoryReads = { ...physical, withDirectoryRead: (actor, work) => { entered++; return physical.withDirectoryRead(actor, work); } };
  r.directory.searchGrantPeople = async () => ({ ok: true, people: [{ person: unseen, login: "new-person", displayName: "New Person" }], truncated: false });
  r.directory.searchPolicyGroups = async () => ({ ok: true, groups: [{ objectId: "11111111-2222-4333-8444-555555555555", cn: "Project", dn: "CN=Project,DC=test" }], truncated: false });
  await r.restartHttp(); return { admin, a, alex, unseen, entered: () => entered };
}
it("finds a directory person before first Hub sign-in without creating a session or granting anything", async () => {
  const w = await world(), key = personKeyString(w.unseen), before = r!.db.prepare("SELECT COUNT(*) n FROM hub_sessions").get();
  const found = await r!.call(w.admin, "GET", "/hub/v1/rooms/candidates?kind=person&q=Ne");
  expect(found.json.candidates).toEqual([{ kind: "person", id: key, name: "New Person" }]); expect(w.entered()).toBeGreaterThan(0);
  expect(r!.db.prepare("SELECT * FROM hub_people WHERE person=?").get(key)).toBeUndefined();
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_sessions").get()).toEqual(before);
  const made = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Fresh selection", people: [key] }); expect(made.status).toBe(200);
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${made.json.room.id}`)).json.members.find((x: any) => x.name === "new-person")).toMatchObject({ signedIn: false });
  expect(r!.db.prepare("SELECT * FROM hub_people WHERE person=?").get(key)).toBeUndefined();
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_sessions").get()).toEqual(before);
  const first = await r!.signIn("new-person");
  expect((await r!.call(first, "GET", `/hub/v1/rooms/${made.json.room.id}`)).json.members.find((x: any) => x.name === "New Person")).toMatchObject({ signedIn: true });
});
it("lists AD group IDs and names without exposing their directory DNs", async () => {
  const w = await world(), found = await r!.call(w.admin, "GET", "/hub/v1/rooms/candidates?kind=group&q=Pr");
  expect(found.status).toBe(200); expect(found.json.candidates).toEqual([{ kind: "group", id: "11111111-2222-4333-8444-555555555555", name: "Project" }]);
  expect(found.text).not.toContain("DC=test");
  expect((await r!.call(w.a, "GET", "/hub/v1/rooms/candidates?kind=group&q=Pr")).status).toBe(403);
});
it("withholds a held directory suggestion after the selected creator loses permission", async () => {
  const w = await world(); await r!.call(w.admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [personKeyString(w.alex)], teams: [] });
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { entered = resolve; });
  r!.directory.searchGrantPeople = async () => { entered(); await hold; return { ok: true, people: [{ person: w.unseen, login: "new-person", displayName: "Held selection" }], truncated: false }; };
  const request = r!.call(w.a, "GET", "/hub/v1/rooms/candidates?kind=person&q=Ne");
  try { await start; await r!.call(w.admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [], teams: [] }); } finally { release(); }
  const answer = await request; expect(answer.status).toBe(403); expect(answer.text).not.toContain("Held selection");
});
it("previews a complete group count and snapshots unseen direct members, without manufacturing sign-in history", async () => {
  const w = await world(), group = randomUUID();
  r!.directory.roomGroupMembers = async key => ({ ok: true, group: { key, name: "Project" }, people: [{ key: w.unseen, login: "new-person", displayName: "New Person", dn: "private", groups: [] }] });
  const preview = await r!.call(w.admin, "GET", `/hub/v1/rooms/candidates/group/${group}`);
  expect(preview.json).toEqual({ kind: "group", id: group, name: "Project", people: 1 }); expect(preview.text).not.toContain("private");
  const made = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Snapshot", groups: [group], people: [personKeyString(w.unseen)] }); expect(made.status).toBe(200);
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${made.json.room.id}`)).json.members).toHaveLength(2);
  expect(r!.db.prepare("SELECT * FROM hub_people WHERE person=?").get(personKeyString(w.unseen))).toBeUndefined();
  r!.directory.roomGroupMembers = async key => ({ ok: true, group: { key, name: "Project" }, people: [] });
  const first = await r!.signIn("new-person");
  expect((await r!.call(first, "GET", "/hub/v1/rooms?v=2")).json.rooms.some((room: any) => room.id === made.json.room.id)).toBe(true);
});
it("refuses an over-limit union and an incomplete group snapshot before any room is created", async () => {
  const w = await world(), group = randomUUID(), people = Array.from({ length: 101 }, () => ({ key: { realm: "corp", objectId: randomUUID() }, login: "person", displayName: "Person", dn: "private", groups: [] }));
  r!.directory.roomGroupMembers = async key => ({ ok: true, group: { key, name: "Large group" }, people });
  const before = r!.db.prepare("SELECT COUNT(*) n FROM hub_group_rooms").get();
  const over = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Too large", groups: [group], people: [personKeyString(people[0]!.key)] });
  expect(over.status).toBe(409); expect(over.json).toEqual({ code: "people-limit", people: 102, limit: 100 });
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_group_rooms").get()).toEqual(before);
  r!.directory.roomGroupMembers = async () => ({ ok: false, reason: "unknown" });
  const unknown = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Held", groups: [group] });
  expect(unknown.status).toBe(503); expect(unknown.json).toEqual({ code: "group-unavailable", group });
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_group_rooms").get()).toEqual(before);
});
it("adds complete group/Team snapshots to an existing room and keeps their members when the source changes", async () => {
  const w = await world(), group = randomUUID(), team = randomUUID(), teamPerson = r!.addPerson("team-person", "Team Person"); let active = true;
  r!.directory.roomGroupMembers = async key => ({ ok: true, group: { key, name: "Project" }, people: active ? [{ key: w.unseen, login: "new-person", displayName: "New Person", dn: "private", groups: [] }] : [] });
  r!.httpDeps.roomTeams = { read: () => null, expand: (_db, ids) => ({ teams: ids.map(id => ({ id, revision: active ? 1 : 2 })), people: active ? [personKeyString(teamPerson)] : [], missing: [] }), isMember: () => null };
  r!.httpDeps.roomTeamCandidates = () => [{ id: team, name: "Small team", people: 1 }]; await r!.restartHttp();
  expect((await r!.call(w.admin, "GET", "/hub/v1/rooms/candidates?kind=team&q=Sm")).json.candidates).toEqual([{ kind: "team", id: team, name: "Small team", people: 1 }]);
  const made = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Add members" }), id = made.json.room.id;
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${id}/members`, { kind: "group", id: group })).status).toBe(403);
  expect((await r!.call(w.admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "group", id: group })).status).toBe(200);
  expect((await r!.call(w.admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "team", id: team })).status).toBe(200);
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${id}`)).json.members).toHaveLength(3);
  active = false;
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${id}`)).json.members).toHaveLength(3);
  expect((await r!.call(w.admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "assistant" })).status).toBe(200);
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${id}`)).json.members.some((m: any) => m.kind === "assistant")).toBe(true);
});
it("keeps archived history readable when the invitation manager port refuses archived actions", async () => {
  const w = await world();
  r!.httpDeps.roomInvitations = (_core, host) => ({ invite: async () => ({ invited: [] }), pending: async () => ({ invitations: [] }), forRoom: async (ctx, id) => {
    const me = await ctx.requirePerson(); r!.httpDeps.uow.atomic(tx => host.managerRoom(r!.sql(tx), id, personKeyString(me))); return []; },
    accept: async () => ({ ok: true }), decline: async () => ({ ok: true }), cancel: async () => ({ ok: true }), roomsForExposure: async () => [] });
  await r!.restartHttp(); const made = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Archive with invites" }), id = made.json.room.id;
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${id}`, { archived: true });
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${id}`)).status).toBe(200);
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${id}/messages`)).status).toBe(200);
});
