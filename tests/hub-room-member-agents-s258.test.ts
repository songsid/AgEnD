/** Real HTTP/SQLite room membership, with inert synthetic Fleet links only. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure } from "../src/hub/types.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig({ realAudit: true });
  const member = r.addPerson("member", "Example Member"), stranger = r.addPerson("stranger", "Example Other");
  const admin = await r.signIn("admin"), own = await r.signIn("member"), outside = await r.signIn("stranger");
  const fleetId = randomUUID(), link = r.link(fleetId, member, 1, ["welcome-caps-v1", "room-ask-v1"]);
  const e: HubExposure = { id: randomUUID(), fleetId, owner: member, displayName: "Example Helper", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Example room", people: [personKeyString(member)] });
  expect(made.status).toBe(200);
  return { admin, own, outside, member, stranger, e, id: made.json.room.id as string };
}
it("defaults off; a manager enables it and a member adds only an owned, shared agent", async () => {
  const w = await world(), path = `/hub/v1/rooms/${w.id}`;
  expect((await r!.call(w.own, "GET", path)).json.settings.membersCanAddOwnAgents).toBe(false);
  expect((await r!.call(w.own, "POST", path + "/members", { kind: "agent", id: w.e.id })).status).toBe(403);
  expect((await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: true })).status).toBe(200);
  expect((await r!.call(w.own, "POST", path + "/members", { kind: "agent", id: w.e.id })).status).toBe(200);
  expect((await r!.call(w.admin, "GET", path)).json.members).toContainEqual(expect.objectContaining({ id: w.e.id, owner: expect.objectContaining({ id: personKeyString(w.member) }) }));
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='room.agent-added' AND room_id=?").get(w.id)).toEqual({ n: 1 });
  expect((await r!.call(w.admin, "DELETE", path + "/members/" + w.e.id)).status).toBe(200);
});
it("only managers change the setting; nonmembers cannot use it", async () => {
  const w = await world(), path = `/hub/v1/rooms/${w.id}`;
  expect((await r!.call(w.own, "PATCH", path, { membersCanAddOwnAgents: true })).status).toBe(403);
  await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: true });
  expect((await r!.call(w.outside, "POST", path + "/members", { kind: "agent", id: w.e.id })).status).toBe(403);
  expect((await r!.call(w.own, "POST", path + "/members", { kind: "person", id: personKeyString(w.stranger) })).status).toBe(403);
  expect((await r!.call(w.own, "POST", path + "/members", { kind: "assistant" })).status).toBe(403);
});
it("room-scoped candidates show owned shared agents only and disappear when the setting is disabled", async () => {
  const w = await world(), path = `/hub/v1/rooms/${w.id}`;
  await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: true });
  const found = await r!.call(w.own, "GET", path + "/own-agent-candidates?q=Example");
  expect(found.status).toBe(200); expect(found.json.candidates).toEqual([expect.objectContaining({ id: w.e.id, mine: true })]);
  expect((await r!.call(w.outside, "GET", path + "/own-agent-candidates?q=Example")).status).toBe(403);
  await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: false });
  expect((await r!.call(w.own, "GET", path + "/own-agent-candidates?q=Example")).status).toBe(403);
  expect((await r!.call(w.own, "POST", path + "/members", { kind: "agent", id: w.e.id })).status).toBe(403);
});

it("never admits another owner's exposure or an unpublished exposure, and leaves other rooms off", async () => {
  const w = await world(), path = `/hub/v1/rooms/${w.id}`;
  await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: true });
  const other = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Another room", people: [personKeyString(w.member)] });
  expect((await r!.call(w.own, "POST", `/hub/v1/rooms/${other.json.room.id}/members`, { kind: "agent", id: w.e.id })).status).toBe(403);
  r!.db.prepare("UPDATE hub_exposures SET owner=? WHERE id=?").run(personKeyString(w.stranger), w.e.id);
  expect((await r!.call(w.own, "POST", path + "/members", { kind: "agent", id: w.e.id })).status).toBe(403);
  r!.db.prepare("UPDATE hub_exposures SET owner=?,state='withdrawn' WHERE id=?").run(personKeyString(w.member), w.e.id);
  expect((await r!.call(w.own, "POST", path + "/members", { kind: "agent", id: w.e.id })).status).toBe(403);
  expect((await r!.call(w.own, "GET", path + "/own-agent-candidates?q=Example")).json.candidates).toEqual([]);
});
it.each(["setting", "membership", "sharing"])("rechecks %s after exposure authorization awaits, without adding or auditing an agent", async change => {
  const w = await world(), path = `/hub/v1/rooms/${w.id}`;
  await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: true });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const original = HubCore.prototype.groupExposure;
  vi.spyOn(HubCore.prototype, "groupExposure").mockImplementation(async function(this: HubCore, ...args) {
    if (args[0] === w.e.id) { entered(); await gate; }
    return original.apply(this, args);
  });
  const pending = r!.call(w.own, "POST", path + "/members", { kind: "agent", id: w.e.id });
  await started;
  if (change === "setting") await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: false });
  else if (change === "membership") r!.db.prepare("DELETE FROM hub_room_members WHERE room_id=? AND subject=?").run(w.id, personKeyString(w.member));
  else r!.db.prepare("UPDATE hub_exposures SET state='withdrawn' WHERE id=?").run(w.e.id);
  release();
  expect((await pending).status).toBe(403);
  expect(r!.db.prepare("SELECT id FROM hub_room_members WHERE room_id=? AND kind='agent'").all(w.id)).toEqual([]);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='room.agent-added' AND room_id=?").get(w.id)).toEqual({ n: 0 });
});
it("turning the setting off retains existing agents and manager removal", async () => {
  const w = await world(), path = `/hub/v1/rooms/${w.id}`;
  await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: true });
  await r!.call(w.own, "POST", path + "/members", { kind: "agent", id: w.e.id });
  await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: false });
  expect((await r!.call(w.own, "GET", path)).json.members.some((m: {id:string}) => m.id === w.e.id)).toBe(true);
  expect((await r!.call(w.admin, "DELETE", path + "/members/" + w.e.id)).status).toBe(200);
});
it("rolls back admission if the setting changes reentrantly during its audit", async () => {
  const w = await world(), path = `/hub/v1/rooms/${w.id}`;
  await r!.call(w.admin, "PATCH", path, { membersCanAddOwnAgents: true });
  const append = r!.httpDeps.audit.append.bind(r!.httpDeps.audit);
  vi.spyOn(r!.httpDeps.audit, "append").mockImplementation((tx, event) => {
    append(tx, event);
    if (event.action === "room.agent-added") r!.db.prepare("UPDATE hub_group_rooms SET members_add_own_agents=0 WHERE id=?").run(w.id);
  });
  expect((await r!.call(w.own, "POST", path + "/members", { kind: "agent", id: w.e.id })).status).toBe(403);
  expect(r!.db.prepare("SELECT id FROM hub_room_members WHERE room_id=? AND kind='agent'").all(w.id)).toEqual([]);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='room.agent-added' AND room_id=?").get(w.id)).toEqual({ n: 0 });
});
