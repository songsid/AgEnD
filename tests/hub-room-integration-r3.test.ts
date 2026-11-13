/** Real R HTTP/SQLite boundary; invitation service and Team reader are injected C ports. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { RoomInvitationHost, HubRoomInvitations } from "../src/hub/invitations.js";
import type { HubExposure } from "../src/hub/types.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig(); const alex = r.addPerson("alex", "Alex"), admin = await r.signIn("admin"), a = await r.signIn("alex");
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Invitation room", people: [personKeyString(alex)] });
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin);
  const e: HubExposure = { id: randomUUID(), fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  return { alex, admin, a, id: made.json.room.id as string, e };
}
function service(): HubRoomInvitations {
  return { invite: async () => ({ invited: [] }), pending: async () => ({ invitations: [] }), forRoom: async () => [],
    accept: async () => ({ ok: true }), decline: async () => ({ ok: true }), cancel: async () => ({ ok: true }), roomsForExposure: async () => [] };
}
it("supplies current manager/publication and same-transaction add hooks, with owner inventory surviving pause", async () => {
  const w = await world(); let host!: RoomInvitationHost;
  r!.httpDeps.roomInvitations = (_core, h) => { host = h; return service(); }; await r!.restartHttp();
  expect(host.managerRoom(r!.db, w.id, personKeyString(r!.admin))).toMatchObject({ id: w.id, name: "Invitation room", people: 2 });
  expect(() => host.managerRoom(r!.db, w.id, personKeyString(w.alex))).toThrow();
  expect(host.publishedExposure(r!.db, w.e.id)).toMatchObject({ owner: { id: personKeyString(r!.admin), name: "Hub Admin" } });
  expect(() => r!.httpDeps.uow.atomic(tx => { host.addAgentMember(r!.sql(tx), tx, w.id, w.e.id, personKeyString(r!.admin)); throw new Error("rollback invitation"); })).toThrow("rollback invitation");
  expect(host.roomsForExposure(r!.db, w.e.id, personKeyString(r!.admin))).toEqual([]);
  r!.httpDeps.uow.atomic(tx => host.addAgentMember(r!.sql(tx), tx, w.id, w.e.id, personKeyString(r!.admin)));
  const memberId = (r!.db.prepare("SELECT id FROM hub_room_members WHERE kind='agent'").get() as { id: string }).id;
  expect(host.roomsForExposure(r!.db, w.e.id, personKeyString(r!.admin))).toEqual([{ id: w.id, name: "Invitation room", people: 2, memberId }]);
  expect(() => host.roomsForExposure(r!.db, w.e.id, personKeyString(w.alex))).toThrow();
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=1 WHERE id=?").run(w.e.id);
  expect(host.roomsForExposure(r!.db, w.e.id, personKeyString(r!.admin))).toHaveLength(1);
  expect(() => host.publishedExposure(r!.db, w.e.id)).toThrow();
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { archived: true });
  expect(() => host.room(r!.db, w.id)).toThrow();
});
it("routes invitation lists/actions and sends an owner invitation event without requiring room membership", async () => {
  const w = await world(), invitation = randomUUID(), calls: string[] = []; let host!: RoomInvitationHost;
  expect((await r!.call(w.admin, "GET", "/hub/v1/invitations")).status).toBe(404);
  r!.httpDeps.roomInvitations = (_core, h) => { host = h; return { ...service(),
    pending: async ctx => { await ctx.requirePerson(); return { invitations: [{ id: invitation, room: { id: w.id, name: "Invitation room", people: 2 }, agent: { exposureId: w.e.id, name: "Notes" }, by: { name: "Hub Admin" }, at: 100 }] }; },
    invite: async (_ctx, id) => { calls.push(`invite:${id}`); return { invited: [] }; },
    accept: async (_ctx, id) => { calls.push(`accept:${id}`); return { ok: true }; },
    decline: async (_ctx, id) => { calls.push(`decline:${id}`); return { ok: true }; },
    cancel: async (_ctx, id, inv) => { calls.push(`cancel:${id}:${inv}`); return { ok: true }; },
  }; }; await r!.restartHttp();
  expect((await r!.call(w.admin, "GET", "/hub/v1/invitations")).json.invitations).toHaveLength(1);
  expect((await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/invitations`, { agents: [w.e.id] })).status).toBe(200);
  expect((await r!.call(w.admin, "POST", `/hub/v1/invitations/${invitation}/accept`, {})).status).toBe(200);
  expect((await r!.call(w.admin, "POST", `/hub/v1/invitations/${invitation}/decline`, {})).status).toBe(200);
  expect((await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/invitations/${invitation}`)).status).toBe(200);
  expect(calls).toEqual([`invite:${w.id}`, `accept:${invitation}`, `decline:${invitation}`, `cancel:${w.id}:${invitation}`]);
  const outsider = r!.addPerson("owner", "Owner"), owner = await r!.signIn("owner"), abort = new AbortController();
  const response = await fetch(r!.base + "/hub/v1/rooms/events", { headers: { Cookie: owner.cookie }, signal: abort.signal }); const reader = response.body!.getReader();
  try {
    await reader.read(); host.changed({ roomId: w.id, ownerId: personKeyString(outsider), membershipChanged: false });
    const data = await reader.read(); expect(new TextDecoder().decode(data.value)).toContain("event: invitation.changed\ndata: {}");
    expect((await r!.call(owner, "GET", `/hub/v1/rooms/${w.id}`)).status).toBe(403);
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
});
it("uses a Team's live roster for creator rights and snapshots expansion when creating a room", async () => {
  const w = await world(), team = randomUUID(); let active = true, revision = 1;
  r!.httpDeps.roomTeams = { read: () => active ? { id: team, revision, name: "Project", department: { realm: "corp", objectGuid: randomUUID() }, lead: personKeyString(w.alex), members: [personKeyString(w.alex)] } : null,
    expand: (_db, ids) => ({ teams: active ? ids.map(id => ({ id, revision })) : [], people: active ? [personKeyString(w.alex)] : [], missing: active ? [] : [...ids] }),
    isMember: () => active ? { revision, member: true } : null };
  await r!.restartHttp();
  expect((await r!.call(w.admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [], teams: [team] })).status).toBe(200);
  expect((await r!.call(w.a, "GET", "/hub/v1/rooms?v=2")).json.me.canCreateRooms).toBe(true);
  const made = await r!.call(w.a, "POST", "/hub/v1/rooms", { name: "Team room", teams: [team] }); expect(made.status).toBe(200);
  active = false; revision++;
  expect((await r!.call(w.a, "GET", "/hub/v1/rooms?v=2")).json.me.canCreateRooms).toBe(false);
  expect((await r!.call(w.a, "POST", "/hub/v1/rooms", { name: "Not allowed" })).status).toBe(403);
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${made.json.room.id}`)).json.me.role).toBe("manager");
});
