/** Published Track U DTOs against real room HTTP/SQLite, rather than the UI response fixture. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

it("wraps picker candidates in the object consumed by the shared client", async () => {
  r = await s3bRig(); const key = r.addPerson("alex", "Alex"), admin = await r.signIn("admin"); await r.signIn("alex");
  expect((await r.call(admin, "GET", "/hub/v1/rooms/candidates?kind=person&q=Al")).json).toEqual({ candidates: [{ kind: "person", id: personKeyString(key), name: "Alex" }] });
});
it("returns selected creator names on GET while preserving ID-only writes", async () => {
  r = await s3bRig(); const key = r.addPerson("alex", "Alex"), admin = await r.signIn("admin"); await r.signIn("alex");
  const input = { people: [personKeyString(key)], teams: [] }, path = "/hub/v1/admin/rooms/creators";
  expect((await r.call(admin, "PUT", path, input)).json).toEqual(input);
  expect((await r.call(admin, "GET", path)).json).toEqual({ people: [{ id: personKeyString(key), name: "Alex" }], teams: [] });
});
it("wraps the owner's agent room projection in rooms for the shared client", async () => {
  r = await s3bRig(); const admin = await r.signIn("admin"), link = r.link(randomUUID(), r.admin, 1, ["welcome-caps-v1", "room-ask-v1"]), exposure = randomUUID();
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposure, fleetId: link.fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "a".repeat(64) }] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Owned room", agents: [exposure] }); expect(made.status).toBe(200);
  const answer = await r.call(admin, "GET", `/hub/v1/exposures/${exposure}/rooms`);
  expect(answer.json).toEqual({ rooms: [{ id: made.json.room.id, name: "Owned room", people: 1, memberId: expect.any(String) }] });
});
