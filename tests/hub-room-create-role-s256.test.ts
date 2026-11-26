/** Current role authority and real room writes; no network/provider or migration grants. */
import { afterEach, expect, it, vi } from "vitest";
import { HubGroupRooms } from "../src/hub/rooms/service.js";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { builtinRoles, parseRolePolicy } from "../src/hub/roles/model.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import type { HubHttpDeps } from "../src/hub/http/deps.js";

const roomsToClose: HubGroupRooms[] = [];
afterEach(async () => { for (const rooms of roomsToClose.splice(0)) await rooms.close(); });
async function world() {
  const w = await roleAuthorityWorld();
  const deps: HubHttpDeps = w.core.deps;
  deps.management = w.authority; deps.roomCreation = w.authority;
  const contents = new Map<string, unknown>(); let next = 0;
  deps.content = { put(_tx, value) { const ref = `content-${++next}`; contents.set(ref, value); return ref; }, get(ref) { return contents.get(ref) as ReturnType<HubHttpDeps["content"]["get"]>; } };
  w.policy.roles.push({ id: "room-creators", name: "Room creators", kind: "custom", permissions: ["rooms.create"], defaultMaxFleets: 0 });
  w.policy.assignments[0]!.roleId = "room-creators"; w.save(w.policy);
  const rooms = new HubGroupRooms(w.core); roomsToClose.push(rooms);
  return { ...w, rooms, ctx: w.ctx.ctx };
}
it("grants custom-role creation and picker access; revocation stops new rooms, not existing management", async () => {
  const w = await world();
  expect((await w.rooms.list(w.ctx)).me.canCreateRooms).toBe(true);
  await expect(w.rooms.candidates(w.ctx, "", "person")).resolves.toEqual(expect.any(Array));
  const made = await w.rooms.create(w.ctx, { name: "Example room" });
  expect(made.room.id).toBeTruthy();
  w.policy.roles.find(r => r.id === "room-creators")!.permissions = []; w.save(w.policy);
  expect((await w.rooms.list(w.ctx)).me.canCreateRooms).toBe(false);
  await expect(w.rooms.create(w.ctx, { name: "Another room" })).rejects.toMatchObject({ code: "denied" });
  expect((await w.rooms.detail(w.ctx, made.room.id)).me.role).toBe("manager");
  await expect(w.rooms.candidates(w.ctx, "", "person")).resolves.toEqual(expect.any(Array));
});
it("keeps all built-in role defaults byte-identical and adds no grant when parsing an old policy", async () => {
  const w = await world(), baseline = builtinRoles();
  expect(baseline.map(r => r.permissions.length)).toEqual([10, 5, 3]);
  expect(baseline.every(r => !r.permissions.includes("rooms.create"))).toBe(true);
  w.policy.roles = baseline; w.policy.assignments = []; w.save(w.policy);
  expect(parseRolePolicy(w.policy)).toEqual(w.policy);
  expect((await w.rooms.list(w.ctx)).me.canCreateRooms).toBe(false);
});
it("rechecks role authority after held directory work before committing", async () => {
  const w = await world(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const current = w.core.current.bind(w.core);
  vi.spyOn(w.core, "current").mockImplementation(async person => { if (person.objectId === w.other.objectId) { entered(); await gate; } return current(person); });
  const pending = w.rooms.create(w.ctx, { name: "Held room", people: [personKeyString(w.other)] });
  await started; w.policy.assignments = []; w.save(w.policy); release();
  await expect(pending).rejects.toBeDefined();
  expect(w.db.prepare("SELECT id FROM hub_group_rooms WHERE name='Held room'").all()).toEqual([]);
});
it("keeps allowlisted creators working when the optional role provider is unavailable", async () => {
  const w = await world(), me = personKeyString(w.admin);
  w.db.prepare("INSERT INTO hub_room_creators(kind,subject) VALUES('person',?)").run(me);
  w.core.deps.roomCreation = { requireRoomCreation: vi.fn(async () => { throw Error("synthetic unavailable"); }) };
  await expect(w.rooms.create(w.ctx, { name: "Allowlisted room" })).resolves.toMatchObject({ room: { name: "Allowlisted room" } });
  expect(w.core.deps.roomCreation.requireRoomCreation).not.toHaveBeenCalled();
});
it.each(["off", "future", "expired", "other-person"])("refuses %s role grants without changing existing defaults", async state => {
  const w = await world();
  if (state === "off") w.policy.rolesActive = false;
  if (state === "future") w.policy.assignments[0]!.startsAt = 200;
  if (state === "expired") w.policy.assignments[0]!.expiresAt = 50;
  if (state === "other-person") w.policy.assignments[0]!.subject = { kind: "person", person: w.other };
  w.save(w.policy);
  expect((await w.rooms.list(w.ctx)).me.canCreateRooms).toBe(false);
  await expect(w.rooms.create(w.ctx, { name: "Denied" })).rejects.toMatchObject({ code: "denied" });
});
it("refuses an expired permit before a room commit", async () => {
  const w = await world(), current = w.core.current.bind(w.core);
  vi.spyOn(w.core, "current").mockImplementation(async person => { const result = await current(person); if (person.objectId === w.other.objectId) w.time(5_001); return result; });
  await expect(w.rooms.create(w.ctx, { name: "Expired", people: [personKeyString(w.other)] })).rejects.toMatchObject({ code: "unavailable" });
  expect(w.db.prepare("SELECT id FROM hub_group_rooms WHERE name='Expired'").all()).toEqual([]);
});
it("rolls back writes if the role changes reentrantly during the required creation audit", async () => {
  const w = await world(), append = w.core.deps.audit.append.bind(w.core.deps.audit);
  vi.spyOn(w.core.deps.audit, "append").mockImplementation((tx, event) => {
    append(tx, event);
    if (event.action === "room.created") { w.policy.assignments = []; w.save(w.policy); }
  });
  await expect(w.rooms.create(w.ctx, { name: "Reentrant" })).rejects.toMatchObject({ code: "unavailable" });
  expect(w.db.prepare("SELECT id FROM hub_group_rooms WHERE name='Reentrant'").all()).toEqual([]);
});
it("keeps legacy creator-team membership independent of the role provider", async () => {
  const w = await world(), me = personKeyString(w.admin), team = "11111111-1111-4111-8111-111111111111";
  w.db.prepare("INSERT INTO hub_room_creators(kind,subject) VALUES('team',?)").run(team);
  w.core.deps.roomTeams = { read: () => null, expand: () => ({ teams: [], people: [], missing: [] }),
    isMember: (_db, id, person) => ({ member: id === team && person === me, revision: 1 }) };
  w.core.deps.roomCreation = { requireRoomCreation: vi.fn(async () => { throw Error("synthetic unavailable"); }) };
  await expect(w.rooms.create(w.ctx, { name: "Team room" })).resolves.toMatchObject({ room: { name: "Team room" } });
  expect(w.core.deps.roomCreation.requireRoomCreation).not.toHaveBeenCalled();
});
it("reports removal of a room grant even when its holder also has the Administrator role", async () => {
  const w = await world(), { roleReview } = await import("../src/hub/roles/review.js"), { planRoleChange } = await import("../src/hub/roles/change.js");
  w.policy.assignments.push({ ...w.policy.assignments[0]!, id: "also-admin", roleId: "builtin:admin" });
  const next = structuredClone(w.policy); next.assignments = next.assignments.filter(a => a.roleId !== "room-creators");
  const facts = new Map([[personKeyString(w.admin), { kind: "eligible" as const, person: w.admin, observedAt: 100 }]]);
  expect(roleReview(planRoleChange(w.policy, next, w.root, 100), [w.admin], facts, w.root, 100).losingPermissions)
    .toEqual([{ person: w.admin, permissions: ["rooms.create"] }]);
});
async function groupWorld() {
  const w = await world(), group = { realm: "corp", objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const groups = vi.fn(async (person: typeof w.admin) => ({ kind: "complete" as const, person, groups: [group.objectId], observedAt: w.options.now() }));
  Object.assign(w.directory, { groupPolicy: "ad-direct-guid", readPolicyGroups: groups });
  w.core.deps.roomCreation = createHubManagementAuthority(w.options);
  w.policy.assignments[0]!.subject = { kind: "group", group, dn: "CN=Example Creators,DC=example,DC=test" }; w.save(w.policy);
  return { ...w, group, groups };
}
it("allows an eligible AD-group role, then observes membership removal without changing existing managers", async () => {
  const w = await groupWorld(); expect(parseRolePolicy(w.policy)).toEqual(w.policy);
  const made = await w.rooms.create(w.ctx, { name: "AD group room" });
  expect(w.groups).toHaveBeenCalledWith(w.admin);
  w.groups.mockImplementation(async person => ({ kind: "complete", person, groups: [], observedAt: w.options.now() }));
  expect((await w.rooms.list(w.ctx)).me.canCreateRooms).toBe(false);
  await expect(w.rooms.create(w.ctx, { name: "Removed member" })).rejects.toMatchObject({ code: "denied" });
  expect((await w.rooms.detail(w.ctx, made.room.id)).me.role).toBe("manager");
});
it.each(["unknown", "stale", "wrong-person", "future"])("does not grant AD-group creation from %s membership facts", async mode => {
  const w = await groupWorld();
  w.groups.mockImplementation(async person => mode === "unknown" ? { kind: "unknown" } as never : ({ kind: "complete", person: mode === "wrong-person" ? w.other : person,
    groups: [w.group.objectId], observedAt: w.options.now() + (mode === "stale" ? -1 : mode === "future" ? 1 : 0) }));
  await expect(w.rooms.create(w.ctx, { name: "No group proof" })).rejects.toMatchObject({ code: "unavailable" });
});
it("refuses a policy revoked while AD membership is being read", async () => {
  const w = await groupWorld(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
  w.groups.mockImplementation(async person => { entered(); await held; return { kind: "complete", person, groups: [w.group.objectId], observedAt: w.options.now() }; });
  const pending = w.rooms.create(w.ctx, { name: "Held group" }); await started;
  w.policy.assignments = []; w.save(w.policy); release();
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  expect(w.db.prepare("SELECT id FROM hub_group_rooms WHERE name='Held group'").all()).toEqual([]);
});

it.each(["unavailable", "expired"])("keeps existing rooms readable with a %s creation hint while writes stay strict", async state => {
 const w = await world(), made = await w.rooms.create(w.ctx, { name: "Readable room" });
 const provider = w.core.deps.roomCreation!;
 w.core.deps.roomCreation = { async requireRoomCreation(ctx) {
   if (state === "unavailable") throw new HubProtocolError("unavailable");
   const permit = await provider.requireRoomCreation(ctx); w.time(5_001); return permit;
 } };
 const listed = await w.rooms.list(w.ctx);
 expect(listed.rooms.some(room => room.id === made.room.id)).toBe(true); expect(listed.me.canCreateRooms).toBe(false);
 await expect(w.rooms.create(w.ctx, { name: "Strict write" })).rejects.toMatchObject({ code: "unavailable" });
});
it("avoids a role-directory read for a person with no potentially granting assignment", async () => {
 const w = await world(); w.policy.assignments = []; w.save(w.policy);
 const admission = vi.spyOn(w.pool, "withDirectoryRead");
 expect((await w.rooms.list(w.ctx)).me.canCreateRooms).toBe(false);
 expect(admission).not.toHaveBeenCalled();
});

it("the prior strict reader accepts unchanged defaults and fails closed on a new room grant", async () => {
 const { parseRolePolicy: olderReader } = await import("./fixtures/hub-room-create-role-s256/legacy-model.js");
 const w = await world(), before = { ...w.policy, roles: builtinRoles(), assignments: [] };
 expect(olderReader(before)).toEqual(before); expect(() => olderReader(w.policy)).toThrow(HubProtocolError);
 expect(parseRolePolicy(w.policy)).toEqual(w.policy);
});
