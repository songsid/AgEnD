import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../src/hub/invitations.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, PersonKey } from "../src/hub/types.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

async function world() {
  const r = rig = await s3bRig();
  const owner = r.addPerson("owner", "Example owner");
  const manager = await r.signIn("admin"), ownerSession = await r.signIn("owner");
  r.httpDeps.uow.atomic(tx => HUB_ROOM_INVITATIONS_MIGRATION.up(r.sql(tx)));
  r.httpDeps.roomInvitations = createHubRoomInvitations;
  await r.restartHttp();
  const created = await r.call(manager, "POST", "/hub/v1/rooms", { name: "Example room" });
  expect(created.status).toBe(200);
  const roomId = created.json.room.id as string;
  const publish = async (person: PersonKey, name: string) => {
    const fleetId = randomUUID(), link = r.link(fleetId, person);
    const exposure: HubExposure = { id: randomUUID(), fleetId, owner: person, displayName: name, revision: 1,
      state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
    await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
    return exposure;
  };
  const hidden = await publish(owner, "Private example agent");
  const invite = (agents: string[]) => r.call(manager, "POST", `/hub/v1/rooms/${roomId}/invitations`, { agents });
  return { r, owner, manager, ownerSession, roomId, hidden, publish, invite };
}

it("refuses a hidden agent id like a missing one, without identity disclosure or invitation effects", async () => {
  const w = await world();
  const picker = await w.r.call(w.manager, "GET", "/hub/v1/rooms/candidates?kind=agent&q=Private");
  expect(picker.json.candidates).toEqual([]);
  const missing = await w.invite([randomUUID()]);
  const before = w.r.db.prepare("SELECT COUNT(*) n FROM audit_rows").get();
  const refused = await w.invite([w.hidden.id]);
  expect(refused.status).toBe(404);
  expect(refused.json).toEqual(missing.json);
  expect(JSON.stringify(refused.json)).not.toMatch(/Private example agent|Example owner/);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_invitations").get()).toEqual({ n: 0 });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE kind='agent'").get()).toEqual({ n: 0 });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM audit_rows").get()).toEqual(before);
  expect((await w.r.call(w.ownerSession, "GET", "/hub/v1/invitations")).json.invitations).toEqual([]);
});

it("still invites an askable agent for its owner's room-only consent", async () => {
  const w = await world();
  const granted = await w.r.call(w.ownerSession, "POST", "/hub/v1/grants", {
    exposureId: w.hidden.id, exposureRevision: 1, login: "admin", days: 7,
  });
  expect(granted.status).toBe(200);
  const answer = await w.invite([w.hidden.id]);
  expect(answer.status).toBe(200);
  expect(answer.json.invited).toHaveLength(1);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE kind='agent'").get()).toEqual({ n: 0 });
  const accepted = await w.r.call(w.ownerSession, "POST", `/hub/v1/invitations/${answer.json.invited[0].id}/accept`, {});
  expect(accepted.status).toBe(200);
  expect(w.r.db.prepare("SELECT owner_at_join FROM hub_room_members WHERE kind='agent'").get()).toEqual({ owner_at_join: personKeyString(w.owner) });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 1 });
});

it("still adds the manager's own published agent without an invitation", async () => {
  const w = await world(), own = await w.publish(w.r.admin, "Own example agent");
  const answer = await w.invite([own.id]);
  expect(answer.status).toBe(200);
  expect(answer.json.invited).toEqual([]);
  expect(w.r.db.prepare("SELECT subject FROM hub_room_members WHERE kind='agent'").get()).toEqual({ subject: own.id });
});

it("rolls back an explicit batch containing both an allowed and a hidden agent", async () => {
  const w = await world(), own = await w.publish(w.r.admin, "Own example agent");
  const answer = await w.invite([own.id, w.hidden.id]);
  expect(answer.status).toBe(404);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_invitations").get()).toEqual({ n: 0 });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE kind='agent'").get()).toEqual({ n: 0 });
});

function teamFor(w: Awaited<ReturnType<typeof world>>) {
  const team = randomUUID();
  w.r.httpDeps.roomTeams = { read: () => null, isMember: () => null,
    expand: (_db, ids) => ({ teams: ids.map(id => ({ id, revision: 1 })), people: [personKeyString(w.owner)], missing: [] }) };
  return () => w.r.call(w.manager, "POST", `/hub/v1/rooms/${w.roomId}/invitations`, { team });
}

it("returns the same empty team result with only hidden agents as with no published agents", async () => {
  const w = await world(), inviteTeam = teamFor(w);
  const hidden = await inviteTeam();
  expect(hidden.status).toBe(200);
  expect(hidden.json).toEqual({ invited: [] });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_invitations").get()).toEqual({ n: 0 });
  expect((await w.r.call(w.ownerSession, "GET", "/hub/v1/invitations")).json.invitations).toEqual([]);
  w.r.db.prepare("UPDATE hub_exposures SET state='withdrawn' WHERE id=?").run(w.hidden.id);
  const empty = await inviteTeam();
  expect(empty.status).toBe(hidden.status);
  expect(empty.json).toEqual(hidden.json);
});

it("returns only allowed team agents, without excluded-owner rows or counts", async () => {
  const w = await world(), allowed = await w.publish(w.owner, "Allowed example agent");
  expect((await w.r.call(w.ownerSession, "POST", "/hub/v1/grants", {
    exposureId: allowed.id, exposureRevision: 1, login: "admin", days: 7,
  })).status).toBe(200);
  const answer = await teamFor(w)();
  expect(answer.status).toBe(200);
  expect(Object.keys(answer.json)).toEqual(["invited"]);
  expect(answer.json.invited).toHaveLength(1);
  expect(answer.json.invited[0]).toMatchObject({ exposureId: allowed.id, name: allowed.displayName });
  expect(JSON.stringify(answer.json)).not.toContain(w.hidden.id);
  expect(JSON.stringify(answer.json)).not.toContain(w.hidden.displayName);
  expect(w.r.db.prepare("SELECT exposure_id FROM hub_room_invitations").all()).toEqual([{ exposure_id: allowed.id }]);
});

it("rechecks the grant before commit if an invitation effect invalidates its proof", async () => {
  const w = await world();
  expect((await w.r.call(w.ownerSession, "POST", "/hub/v1/grants", {
    exposureId: w.hidden.id, exposureRevision: 1, login: "admin", days: 7,
  })).status).toBe(200);
  const append = w.r.httpDeps.audit.append.bind(w.r.httpDeps.audit);
  let invalidated = false;
  w.r.httpDeps.audit.append = (tx, record) => {
    append(tx, record);
    if (record.action === "room.invitation-created") {
      invalidated = true;
      w.r.sql(tx).prepare("UPDATE hub_grants SET state='revoked' WHERE exposure_id=?").run(w.hidden.id);
    }
  };
  const answer = await w.invite([w.hidden.id]);
  expect(invalidated).toBe(true);
  expect(answer.json).toMatchObject({ code: "revoked" });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_invitations").get()).toEqual({ n: 0 });
  expect(w.r.db.prepare("SELECT state FROM hub_grants WHERE exposure_id=?").get(w.hidden.id)).toEqual({ state: "active" });
});
