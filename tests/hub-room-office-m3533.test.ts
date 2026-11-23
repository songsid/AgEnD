/**
 * M-3533 R1-server (docs/design/hub-office-visit.md §2): a group room's office — the setting, its line, and the
 * share-shaped view of the room's agents in the member list's states plus "answering in this room".
 */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { ROOM_OFFICE_DEFAULT, officeOn, newRoomOffice } from "../src/hub/rooms/office.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const caps = ["welcome-caps-v1", "room-ask-v1"];

async function world(opts: { office?: boolean; assistant?: boolean } = {}) {
  let at = Date.now();
  r = await s3bRig({ now: () => at, realAudit: true, ...(opts.office === false ? {} : { roomOffice: true }) });
  if (opts.assistant) {
    r.httpDeps.roomAssistant = { available: () => ({ enabled: true, backend: "inert", running: 0, cap: 3, state: "idle" }), ask: async () => ({ text: "Assistant reply" }), forget() {} };
    await r.restartHttp();
  }
  const alex = r.addPerson("alex", "Alex"), outsider = r.addPerson("outsider", "Outsider");
  const a = await r.signIn("alex"), o = await r.signIn("outsider"), admin = await r.signIn("admin");
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
  const exposure = (name: string): HubExposure => ({ id: randomUUID(), fleetId, owner: r!.admin, displayName: name, revision: 1, state: "published",
    dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  const e = exposure("Notes"), f = exposure("Planner");
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e, f] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex)], assistant: opts.assistant === true });
  expect(made.status).toBe(200); const id = made.json.room.id as string;
  for (const x of [e, f]) expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: x.id })).status).toBe(200);
  return { admin, a, o, fleetId, link, e, f, id, advance: (n: number) => { at += n; } };
}
type World = Awaited<ReturnType<typeof world>>;
const state = (w: World, who = w.a) => r!.call(who, "GET", `/hub/v1/rooms/${w.id}/office/state`);
const agent = async (w: World, id: string) => (await state(w)).json.instances.find((i: any) => i.name === id);
const messages = async (w: World) => (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages as any[];
const officeLines = async (w: World) => (await messages(w)).filter(m => m.system?.kind === "office-changed");
const asks = () => r!.sent.filter(s => s.frame.type === "room.ask");

it("is unreachable until the Hub offers room-office-v1: no feature, no setting, no field, no route", async () => {
  const w = await world({ office: false });
  expect((await r!.call(w.a, "GET", "/hub/v1/session")).json.features).not.toContain("room-office-v1");
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json.settings).not.toHaveProperty("office");
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { enabled: false } })).status).toBe(400);
  expect((await state(w)).status).toBe(404);
  expect(await officeLines(w)).toEqual([]);
});

it("offered: on for new and existing rooms from one default, with no line for starting on", async () => {
  const w = await world();
  expect((await r!.call(w.a, "GET", "/hub/v1/session")).json.features).toContain("room-office-v1");
  expect(ROOM_OFFICE_DEFAULT).toEqual({ existingRooms: true, newRooms: true });
  expect(r!.db.prepare("SELECT office_enabled FROM hub_group_rooms WHERE id=?").get(w.id)).toEqual({ office_enabled: newRoomOffice() });
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json.settings.office).toEqual({ enabled: true, style: "cozy" });
  // A room made before this shipped has no stored value: the default for existing rooms reads it.
  r!.db.prepare("UPDATE hub_group_rooms SET office_enabled=NULL WHERE id=?").run(w.id);
  expect(officeOn(null)).toBe(ROOM_OFFICE_DEFAULT.existingRooms);
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json.settings.office.enabled).toBe(true);
  expect((await state(w)).status).toBe(200);
  expect(await officeLines(w)).toEqual([]);
});

it("only managers turn it on or off; each change is one line, a no-change none; off refuses the view", async () => {
  const w = await world();
  expect((await r!.call(w.a, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { enabled: false } })).status).toBe(403);
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { enabled: false, style: "pixel" } })).status).toBe(400);
  const off = await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { enabled: false } });
  expect(off.status).toBe(200); expect(off.json.settings.office).toEqual({ enabled: false, style: "cozy" });
  await r!.restartHttp();
  expect((await officeLines(w)).map(m => [m.system, m.text])).toEqual([[{ kind: "office-changed", name: "Hub Admin", enabled: false }, "Hub Admin turned the room office off."]]);
  expect(await state(w)).toMatchObject({ status: 409, json: { code: "office-off" } });
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { enabled: false } });
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { name: "Weekly sync" });
  expect(await officeLines(w)).toHaveLength(1);
  // A room still on its default: setting it to the value it already shows is no change either.
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { enabled: true } });
  r!.db.prepare("UPDATE hub_group_rooms SET office_enabled=NULL WHERE id=?").run(w.id);
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { enabled: true } });
  expect((await officeLines(w)).map(m => m.text)).toEqual(["Hub Admin turned the room office off.", "Hub Admin turned the room office on."]);
  expect((await state(w)).status).toBe(200);
  // With a purpose in the same change: both lines.
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { purpose: "Weekly questions", office: { enabled: false } });
  expect((await messages(w)).slice(-2).map(m => m.system?.kind)).toEqual(["purpose-changed", "office-changed"]);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='room.office-changed'").get()).toEqual({ n: 3 });
});

it("is for the room's members only, and only read", async () => {
  const w = await world();
  expect([403, 404]).toContain((await state(w, w.o)).status);
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/office/state?x=1`)).status).toBe(400);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/office/state`, {})).status).toBe(405);
});

it("draws exactly the room's agents and assistant, share-shaped, with no words, levels, teams or traffic", async () => {
  const w = await world({ assistant: true });
  const view = (await state(w)).json;
  expect(view).toMatchObject({ org: { general: [], teams: [], instances: {} }, needs: [], text: false, office: "room",
    traffic: { items: [], delegations: [] } });
  expect(view.offices).toEqual({ rev: 0, readable: true, offices: [{ id: "room", name: "Weekly", skin: "cozy", members: view.instances.map((i: any) => i.name) }] });
  expect(view.instances.map((i: any) => i.name).sort()).toEqual(["assistant", w.e.id, w.f.id].sort());
  expect(view.instances.find((i: any) => i.name === w.e.id)).toEqual({ name: w.e.id, display_name: "Notes", status: "running", execution_state: "idle" });
  expect(view.instances.find((i: any) => i.name === "assistant")).toEqual({ name: "assistant", display_name: "Hub assistant", status: "running", execution_state: "idle", assistant: true });
  // An agent that leaves the room leaves its office at once.
  const member = (await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json.members.find((m: any) => m.id === w.f.id);
  expect((await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${member.id}`)).status).toBe(200);
  expect((await state(w)).json.instances.map((i: any) => i.name)).not.toContain(w.f.id);
});

it("shows each agent in the member list's own state, never a different one", async () => {
  const w = await world();
  const listed = async (id: string) => (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json.members.find((m: any) => m.id === id).presence;
  const frame = (s: Record<string, unknown>) => r!.http.receive(r!.frame("agent.state", { exposureId: w.e.id, ...s }, w.link) as never, w.link);
  await frame({ state: "working" });
  expect(await listed(w.e.id)).toBe("working");
  expect(await agent(w, w.e.id)).toEqual({ name: w.e.id, display_name: "Notes", status: "running", execution_state: "working" });
  await frame({ state: "paused", reason: "auth" });
  expect(await listed(w.e.id)).toBe("paused");
  expect(await agent(w, w.e.id)).toEqual({ name: w.e.id, display_name: "Notes", status: "paused" });
  w.link.alive = false;
  expect(await listed(w.e.id)).toBe("offline");
  expect(await agent(w, w.e.id)).toEqual({ name: w.e.id, display_name: "Notes", status: "stopped" });
});

it("marks an agent answering in this room while the Hub waits on its answer, and clears it on the answer", async () => {
  const w = await world();
  const post = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "Status?", mentions: [w.e.id], idempotencyKey: randomUUID() });
  expect(post.status).toBe(200);
  await vi.waitFor(() => expect(asks()).toHaveLength(1));
  expect(await agent(w, w.e.id)).toEqual({ name: w.e.id, display_name: "Notes", status: "running", execution_state: "working", answering: true });
  expect(await agent(w, w.f.id)).toEqual({ name: w.f.id, display_name: "Planner", status: "running", execution_state: "idle" });
  const input = asks()[0]!.frame.payload as HubRoomAsk;
  await r!.http.receive(r!.frame("room.answer", { messageId: input.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "Ready" }, w.link) as never, w.link);
  expect(await agent(w, w.e.id)).toEqual({ name: w.e.id, display_name: "Notes", status: "running", execution_state: "idle" });
});

it("clears answering when the wait ends without an answer", async () => {
  const w = await world();
  await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "Status?", mentions: [w.e.id], idempotencyKey: randomUUID() });
  await vi.waitFor(() => expect(asks()).toHaveLength(1));
  expect((await agent(w, w.e.id)).answering).toBe(true);
  w.advance(24 * 60 * 60_000);
  const fresh = await r!.signIn("alex");
  expect((await state(w, fresh)).json.instances.find((i: any) => i.name === w.e.id)).toEqual({ name: w.e.id, display_name: "Notes", status: "running", execution_state: "idle" });
});
