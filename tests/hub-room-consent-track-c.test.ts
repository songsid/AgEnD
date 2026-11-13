/** Actual R HTTP/SQLite with C consent storage; directory/delivery callbacks are inert. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import * as invitationModule from "../src/hub/invitations.js";
import type { HubCore } from "../src/hub/http/core.js";
import type { HubHttpMigration } from "../src/hub/http/schema.js";
import type { HubRoomInvitations, RoomInvitationHost } from "../src/hub/invitations.js";
import type { HubExposure } from "../src/hub/types.js";

const DAY = 86_400_000;
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  let now = Date.UTC(2026, 10, 13, 18);
  r = await s3bRig({ now: () => now });
  const owner = r.addPerson("owner", "Agent owner"), stranger = r.addPerson("stranger", "Other person");
  const admin = await r.signIn("admin"), o = await r.signIn("owner"), s = await r.signIn("stranger");
  // Before implementation this stays uncomposed, giving semantic HTTP404 instead of an import/load failure.
  const api = invitationModule as unknown as { HUB_ROOM_INVITATIONS_MIGRATION?: HubHttpMigration;
    createHubRoomInvitations?: (core: HubCore, host: RoomInvitationHost) => HubRoomInvitations };
  if (api.HUB_ROOM_INVITATIONS_MIGRATION && api.createHubRoomInvitations) {
    r.httpDeps.uow.atomic(tx => api.HUB_ROOM_INVITATIONS_MIGRATION!.up(r!.sql(tx)));
    r.httpDeps.roomInvitations = api.createHubRoomInvitations; await r.restartHttp();
  }
  const room = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Project" });
  expect(room.status).toBe(200);
  const fleetId = randomUUID(), link = r.link(fleetId, owner);
  const e: HubExposure = { id: randomUUID(), fleetId, owner, displayName: "Notes", revision: 1, state: "published",
    dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const roomId = room.json.room.id as string;
  const invite = async () => {
    const result = await r!.call(admin, "POST", `/hub/v1/rooms/${roomId}/invitations`, { agents: [e.id] });
    expect(result.status).toBe(200); return result.json.invited[0];
  };
  const pending = async (browser = o) => { const result = await r!.call(browser, "GET", "/hub/v1/invitations"); expect(result.status).toBe(200); return result.json.invitations; };
  return { owner, stranger, admin, o, s, roomId, e, invite, pending, setNow: (value: number) => { now = value; }, now: () => now };
}
const members = () => r!.db.prepare("SELECT * FROM hub_room_members WHERE kind='agent'").all();
it("invites only through a current manager and shows pending consent only to the agent owner", async () => {
  const w = await world(), inv = await w.invite();
  expect(await w.pending()).toEqual([{ id: inv.id, room: { id: w.roomId, name: "Project", people: 1 }, agent: { exposureId: w.e.id, name: "Notes" }, by: { name: "Hub Admin" }, at: w.now() }]);
  expect(await w.pending(w.s)).toEqual([]);
  expect((await r!.call(w.s, "POST", `/hub/v1/rooms/${w.roomId}/invitations`, { agents: [w.e.id] })).status).toBe(403);
  expect((await r!.call(w.s, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(403);
  expect((await r!.call(w.s, "POST", `/hub/v1/invitations/${inv.id}/decline`, {})).status).toBe(403);
  expect(members()).toEqual([]); expect(await w.pending()).toHaveLength(1);
});
it("accepts the exact named agent once without adding its owner as a room person", async () => {
  const w = await world(), inv = await w.invite();
  const before = r!.db.prepare("SELECT COUNT(*) AS n FROM hub_room_posts WHERE author_kind='system'").get() as { n: number };
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).json).toEqual({ ok: true });
  expect(members()).toEqual([expect.objectContaining({ room_id: w.roomId, subject: w.e.id, owner_at_join: personKeyString(w.owner) })]);
  expect(r!.db.prepare("SELECT 1 FROM hub_room_members WHERE kind='person' AND subject=?").get(personKeyString(w.owner))).toBeUndefined();
  expect(await w.pending()).toEqual([]);
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(200);
  expect(members()).toHaveLength(1);
  expect(r!.db.prepare("SELECT COUNT(*) AS n FROM hub_room_posts WHERE author_kind='system'").get()).toEqual({ n: before.n + 1 });
});
it("decline and manager cancel consume only their exact pending invitations without joining", async () => {
  const w = await world(), first = await w.invite();
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${first.id}/decline`, {})).status).toBe(200);
  const second = await w.invite(); expect(second.id).not.toBe(first.id);
  expect((await r!.call(w.s, "DELETE", `/hub/v1/rooms/${w.roomId}/invitations/${second.id}`)).status).toBe(403);
  expect((await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.roomId}/invitations/${second.id}`)).status).toBe(200);
  expect(await w.pending()).toEqual([]); expect(members()).toEqual([]);
});
it("keeps duplicate pending invitations at their original absolute seven-day expiry and permits a fresh invite after expiry", async () => {
  const w = await world(), first = await w.invite(), at = w.now();
  w.setNow(at + 60_000); expect((await w.invite()).id).toBe(first.id);
  w.setNow(at + 7 * DAY);
  // Renew browser sessions after the deliberate clock jump; the invitation remains the original durable row.
  w.o = await r!.signIn("owner"); w.admin = await r!.signIn("admin");
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${first.id}/accept`, {})).status).toBe(404);
  const detail = await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.roomId}`);
  expect(detail.json.invited).toContainEqual(expect.objectContaining({ id: first.id, state: "expired", at }));
  expect(members()).toEqual([]);
  const again = await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.roomId}/invitations`, { agents: [w.e.id] });
  expect(again.status).toBe(200); expect(again.json.invited[0].id).not.toBe(first.id);
});
it("rolls membership and invitation consumption back together when its audit fails", async () => {
  const w = await world(), inv = await w.invite();
  r!.setAuditFails(true, "room.invitation-accepted");
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(500);
  expect(members()).toEqual([]); expect(await w.pending()).toHaveLength(1);
  r!.setAuditFails(false);
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(200);
  expect(members()).toHaveLength(1);
});
it("retains pending invitations through pause, refuses accept while paused, then accepts after resume", async () => {
  const w = await world(), inv = await w.invite();
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=1 WHERE id=?").run(w.e.id);
  expect(await w.pending()).toHaveLength(1);
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(403);
  expect(members()).toEqual([]);
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=0 WHERE id=?").run(w.e.id);
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(200);
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=1 WHERE id=?").run(w.e.id);
  expect(members()).toHaveLength(1);
});
it("refuses withdrawn or archived targets without consuming pending consent", async () => {
  const w = await world(), inv = await w.invite();
  r!.db.prepare("UPDATE hub_exposures SET state='withdrawn' WHERE id=?").run(w.e.id);
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(403);
  r!.db.prepare("UPDATE hub_exposures SET state='published' WHERE id=?").run(w.e.id);
  expect(await w.pending()).toHaveLength(1);
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.roomId}`, { archived: true })).status).toBe(200);
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(409);
  expect(members()).toEqual([]);
});
it("lets an owner add their own agent directly without making a pending consent row", async () => {
  const w = await world();
  const ownRoom = await r!.call(w.o, "POST", "/hub/v1/rooms", { name: "Owner's room", agents: [w.e.id] });
  // Room creation is an admin/creator permission; grant it explicitly rather than using the invitation as a permit.
  if (ownRoom.status === 403) {
    await r!.call(w.admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [personKeyString(w.owner)], teams: [] });
    expect((await r!.call(w.o, "POST", "/hub/v1/rooms", { name: "Owner's room", agents: [w.e.id] })).status).toBe(200);
  } else expect(ownRoom.status).toBe(200);
  expect(members()).toHaveLength(1); expect(await w.pending()).toEqual([]);
});
it("publishes refresh events only after the atomic consent and membership commit", async () => {
  const w = await world(), observations: { transaction: boolean; state: string | undefined; members: number }[] = [];
  const api = invitationModule as unknown as { createHubRoomInvitations: (core: HubCore, host: RoomInvitationHost) => HubRoomInvitations };
  r!.httpDeps.roomInvitations = (core, host) => api.createHubRoomInvitations(core, { ...host, changed(change) {
    observations.push({ transaction: r!.db.inTransaction, state: (r!.db.prepare("SELECT state FROM hub_room_invitations ORDER BY rowid DESC LIMIT 1").get() as { state: string } | undefined)?.state, members: members().length });
    host.changed(change);
  } }); await r!.restartHttp();
  const inv = await w.invite(); expect(observations).toEqual([{ transaction: false, state: "pending", members: 0 }]);
  observations.length = 0; r!.setAuditFails(true, "room.invitation-accepted");
  await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {}); expect(observations).toEqual([]);
  r!.setAuditFails(false); await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {});
  expect(observations).toEqual([{ transaction: false, state: "accepted", members: 1 }]);
});
it("never re-adds an agent removed after an accepted invitation is replayed", async () => {
  const w = await world(), inv = await w.invite();
  await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {});
  const member = members()[0] as { id: string };
  expect((await r!.call(w.o, "DELETE", `/hub/v1/rooms/${w.roomId}/members/${member.id}`)).status).toBe(200);
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(200);
  expect(members()).toEqual([]);
});
it("an archived room's invitation does not break another pending room or delete the retained row", async () => {
  const w = await world(), old = await w.invite();
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.roomId}`, { archived: true });
  const other = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Another project" });
  const fresh = await r!.call(w.admin, "POST", `/hub/v1/rooms/${other.json.room.id}/invitations`, { agents: [w.e.id] });
  expect(fresh.status).toBe(200); expect((await w.pending()).map((i: { id: string }) => i.id)).toEqual([fresh.json.invited[0].id]);
  expect(r!.db.prepare("SELECT state FROM hub_room_invitations WHERE id=?").get(old.id)).toEqual({ state: "pending" });
});
it("a withdrawn owner binding or changed invitation during audit rolls the whole acceptance back", async () => {
  const w = await world(), inv = await w.invite(), append = r!.httpDeps.audit.append.bind(r!.httpDeps.audit);
  r!.httpDeps.audit.append = (tx, record) => { append(tx, record); if (record.action === "room.invitation-accepted") r!.sql(tx).prepare("UPDATE hub_room_invitations SET exposure_id=? WHERE id=?").run(randomUUID(), inv.id); };
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(409);
  expect(members()).toEqual([]); expect(r!.db.prepare("SELECT state,exposure_id FROM hub_room_invitations WHERE id=?").get(inv.id)).toEqual({ state: "pending", exposure_id: w.e.id });
});
it("does not revive an observed expired invitation after the wall clock returns to its former window", async () => {
  const w = await world(), inv = await w.invite(), at = w.now();
  w.setNow(at + 7 * DAY); const expiredOwner = await r!.signIn("owner");
  expect((await r!.call(expiredOwner, "GET", "/hub/v1/invitations")).json.invitations).toEqual([]);
  expect(r!.db.prepare("SELECT state FROM hub_room_invitations WHERE id=?").get(inv.id)).toEqual({ state: "expired" });
  w.setNow(at + 60_000); const back = await r!.signIn("owner");
  expect((await r!.call(back, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(404);
  expect(members()).toEqual([]);
});
it("session or server retirement during a member effect rolls back consent and membership", async () => {
  const w = await world(), inv = await w.invite();
  const api = invitationModule as unknown as { createHubRoomInvitations: (core: HubCore, host: RoomInvitationHost) => HubRoomInvitations };
  r!.httpDeps.roomInvitations = (core, host) => api.createHubRoomInvitations(core, { ...host,
    addAgentMember(...args) { host.addAgentMember(...args); r!.disable(); } }); await r!.restartHttp();
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(503);
  expect(members()).toEqual([]); expect(r!.db.prepare("SELECT state FROM hub_room_invitations WHERE id=?").get(inv.id)).toEqual({ state: "pending" });
});
it("retiring the owner's actual browser session during acceptance rolls back both durable effects", async () => {
  const w = await world(), inv = await w.invite();
  const api = invitationModule as unknown as { createHubRoomInvitations: (core: HubCore, host: RoomInvitationHost) => HubRoomInvitations };
  r!.httpDeps.roomInvitations = (core, host) => api.createHubRoomInvitations(core, { ...host,
    addAgentMember(...args) { host.addAgentMember(...args); args[0].prepare("UPDATE hub_sessions SET state='ended' WHERE person=?").run(personKeyString(w.owner)); } }); await r!.restartHttp();
  expect((await r!.call(w.o, "POST", `/hub/v1/invitations/${inv.id}/accept`, {})).status).toBe(403);
  expect(members()).toEqual([]); expect(r!.db.prepare("SELECT state FROM hub_room_invitations WHERE id=?").get(inv.id)).toEqual({ state: "pending" });
});
