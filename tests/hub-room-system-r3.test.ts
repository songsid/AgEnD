/** Viewer-localized system events on the actual room HTTP/SQLite path. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

it("persists named creation and person-join events without parsing names out of English", async () => {
  r = await s3bRig(); const name = "Cara joined this room. <test>", cara = r.addPerson("cara", name), admin = await r.signIn("admin"); await r.signIn("cara");
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Localized room" }), id = made.json.room.id;
  expect(made.json.room.lastSystem).toEqual({ kind: "room-created", name: "Hub Admin" });
  expect((await r.call(admin, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages[0]).toMatchObject({
    author: { kind: "system" }, system: { kind: "room-created", name: "Hub Admin" }, text: "Hub Admin created this room.",
  });
  expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "person", id: personKeyString(cara) })).status).toBe(200);
  await r.restartHttp();
  const rows = (await r.call(admin, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages;
  expect(rows.at(-1).system).toEqual({ kind: "member-joined", name });
  expect((await r.call(admin, "GET", "/hub/v1/rooms?v=2")).json.rooms.find((room: any) => room.id === id).lastSystem).toEqual({ kind: "member-joined", name });
  const old = rows[0].id; r.db.prepare("UPDATE hub_room_posts SET author_id='system',author_name='' WHERE id=?").run(old);
  expect((await r.call(admin, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages[0]).not.toHaveProperty("system");
});
it("identifies the admin's explicit manager join for viewer wording", async () => {
  r = await s3bRig(); const alex = r.addPerson("alex", "Alex"), admin = await r.signIn("admin"), member = await r.signIn("alex");
  await r.call(admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [personKeyString(alex)], teams: [] });
  const made = await r.call(member, "POST", "/hub/v1/rooms", { name: "Other room" }), id = made.json.room.id;
  expect((await r.call(admin, "POST", `/hub/v1/admin/rooms/${id}/join`, {})).status).toBe(200);
  expect((await r.call(admin, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages.at(-1)).toMatchObject({ system: { kind: "admin-joined", name: "Hub Admin" }, text: "Hub Admin joined as a room manager." });
});
it("keeps an agent's display name as structured join-event data", async () => {
  r = await s3bRig(); const admin = await r.signIn("admin"), link = r.link(randomUUID(), r.admin, 1, ["welcome-caps-v1", "room-ask-v1"]), exposure = randomUUID();
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposure, fleetId: link.fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "a".repeat(64) }] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Agent room", agents: [exposure] }); expect(made.status).toBe(200);
  expect((await r.call(admin, "GET", `/hub/v1/rooms/${made.json.room.id}/messages`)).json.messages.at(-1).system).toEqual({ kind: "member-joined", name: "Notes" });
});
