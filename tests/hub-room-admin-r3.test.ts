/** Room permissions/admin metadata through the real owned HTTP/SQLite fixture. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
const assistantSettings = () => ({ enabled: false, backend: "claude-code", account: null, cap: 3, idleMinutes: 15, backends: [], running: [] });
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig(); const alex = r.addPerson("alex", "Alex"), cara = r.addPerson("cara", "Cara");
  const admin = await r.signIn("admin"), a = await r.signIn("alex"), c = await r.signIn("cara");
  return { admin, a, c, alex, cara };
}
it("lets a current selected person create rooms, and removal affects future creation only", async () => {
  const w = await world(), path = "/hub/v1/admin/rooms/creators", selected = { people: [personKeyString(w.alex)], teams: [] };
  expect((await r!.call(w.admin, "GET", path)).json).toEqual({ people: [], teams: [] });
  expect((await r!.call(w.a, "PUT", path, selected)).status).toBe(403);
  expect((await r!.call(w.admin, "PUT", path, selected)).json).toEqual(selected);
  expect((await r!.call(w.a, "GET", "/hub/v1/rooms?v=2")).json.me.canCreateRooms).toBe(true);
  expect((await r!.call(w.a, "GET", "/hub/v1/rooms/candidates?kind=person&q=Ca")).json).toEqual([{ kind: "person", id: personKeyString(w.cara), name: "Cara" }]);
  const made = await r!.call(w.a, "POST", "/hub/v1/rooms", { name: "My room", people: [personKeyString(w.cara)] }); expect(made.status).toBe(200);
  await r!.call(w.admin, "PUT", path, { people: [], teams: [] });
  expect((await r!.call(w.a, "POST", "/hub/v1/rooms", { name: "Another" })).status).toBe(403);
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${made.json.room.id}`)).json.me.role).toBe("manager");
});
it("shows administrators room metadata only until they explicitly join as a manager", async () => {
  const w = await world(); await r!.call(w.admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [personKeyString(w.alex)], teams: [] });
  const made = await r!.call(w.a, "POST", "/hub/v1/rooms", { name: "Private", people: [personKeyString(w.cara)] }); expect(made.status).toBe(200); const id = made.json.room.id;
  await r!.call(w.a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "Room content stays private", mentions: [], idempotencyKey: randomUUID() });
  expect((await r!.call(w.a, "GET", "/hub/v1/admin/rooms")).status).toBe(403);
  const metadata = await r!.call(w.admin, "GET", "/hub/v1/admin/rooms");
  expect(metadata.json.rooms).toEqual([{ id, name: "Private", people: 2, agents: 0, managers: ["Alex"], lastAt: expect.any(Number), archived: false }]);
  expect(metadata.text).not.toContain("Room content stays private");
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${id}/messages`)).status).toBe(403);
  expect((await r!.call(w.admin, "POST", `/hub/v1/admin/rooms/${id}/join`, {})).status).toBe(200);
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${id}`)).json.me.role).toBe("manager");
  const messages = (await r!.call(w.admin, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages;
  expect(messages.some((m: any) => m.author.kind === "system" && m.text.includes("Hub Admin"))).toBe(true);
});
it("archives through the admin metadata route without changing room memberships or readable history", async () => {
  const w = await world(), made = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Archive", people: [personKeyString(w.alex)] }), id = made.json.room.id;
  expect((await r!.call(w.a, "PATCH", `/hub/v1/admin/rooms/${id}`, { archived: true })).status).toBe(403);
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/admin/rooms/${id}`, { archived: true })).status).toBe(200);
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${id}`)).json.room.archived).toBe(true);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "No", mentions: [], idempotencyKey: randomUUID() })).json.code).toBe("archived");
});
it("requires current eligibility and required audit to change creator assignments", async () => {
  const w = await world(), path = "/hub/v1/admin/rooms/creators", body = { people: [personKeyString(w.alex)], teams: [] };
  r!.setAuditFails(true, "room.creators"); expect((await r!.call(w.admin, "PUT", path, body)).status).toBe(500);
  expect((await r!.call(w.admin, "GET", path)).json).toEqual({ people: [], teams: [] });
  r!.setAuditFails(false); r!.setEligible("alex", false);
  expect((await r!.call(w.admin, "PUT", path, body)).status).toBe(400);
});

it("serves assistant administration only with both ports and current Hub admin authority", async () => {
  const w = await world(), path = "/hub/v1/admin/assistant";
  expect((await r!.call(w.admin, "GET", path)).status).toBe(404);
  let calls = 0; const stopped: string[] = [];
  r!.httpDeps.roomAssistant = { available: () => ({ enabled: false, backend: "claude-code", running: 0, cap: 3, state: "paused" }), ask: async () => ({ text: "Inert" }), forget() {} };
  r!.httpDeps.assistantAdmin = { settings: async () => { calls++; return assistantSettings(); },
    configure: async () => assistantSettings(), usage: async () => ({ days: [], quota: { band: "unknown" } }), stopRoom: async id => { stopped.push(id); } };
  await r!.restartHttp();
  expect((await r!.call(w.admin, "GET", "/hub/v1/session")).json.features).toContain("room-assistant-v1");
  expect((await r!.call(w.a, "GET", path)).status).toBe(403); expect(calls).toBe(0);
  expect((await r!.call(w.admin, "GET", path)).json.cap).toBe(3);
  expect((await r!.call(w.admin, "GET", path + "/usage")).json).toEqual({ days: [], quota: { band: "unknown" } });
  const id = randomUUID(); expect((await r!.call(w.admin, "POST", path + `/rooms/${id}/stop`, {})).status).toBe(200); expect(stopped).toEqual([id]);
});

it("withholds a held assistant admin read after the actual browser signs out", async () => {
  const w = await world(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  r!.httpDeps.roomAssistant = { available: () => ({ enabled: false, backend: "claude-code", running: 0, cap: 3, state: "paused" }), ask: async () => ({ text: "Inert" }), forget() {} };
  r!.httpDeps.assistantAdmin = { settings: async () => { entered(); await held; return { ...assistantSettings(), backends: [{ id: "privatePicker", name: "privatePicker", accounts: [] }] }; }, configure: async () => assistantSettings(), usage: async () => ({ days: [], quota: { band: "unknown" } }), stopRoom: async () => {} };
  await r!.restartHttp();
  const result = r!.call(w.admin, "GET", "/hub/v1/admin/assistant");
  try { await started; expect((await r!.call(w.admin, "DELETE", "/hub/v1/session")).status).toBe(200); }
  finally { release(); }
  const refused = await result; expect(refused.status).toBe(401); expect(refused.text).not.toContain("privatePicker");
});
