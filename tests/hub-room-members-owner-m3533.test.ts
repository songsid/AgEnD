/**
 * M-3533 M1 (Lumen's check on #4366): an agent member's owner in the room's detail carries its id (two owners of one
 * name are two groups in the compact list) and, for the viewer's own agents, `mine` (their group first).
 */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

it("an agent's owner: name, id, and mine for its owner only", async () => {
  r = await s3bRig();
  const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
  const link = r.link(randomUUID(), r.admin, 1, ["welcome-caps-v1", "room-ask-v1"]), id = randomUUID();
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id, fleetId: link.fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Room", people: [personKeyString(alex)], agents: [id] });
  const owner = async (who: unknown) => (await r!.call(who as never, "GET", `/hub/v1/rooms/${made.json.room.id}`)).json.members.find((m: any) => m.id === id).owner;
  expect(await owner(admin)).toEqual({ name: "Hub Admin", id: personKeyString(r.admin), mine: true });
  expect(await owner(a)).toEqual({ name: "Hub Admin", id: personKeyString(r.admin) });
});
