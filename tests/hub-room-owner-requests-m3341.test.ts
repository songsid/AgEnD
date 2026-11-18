import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import {
  createHubRoomAgentRequests, HUB_ROOM_AGENT_REQUESTS_MIGRATION, ROOM_AGENT_REQUEST_TTL,
  type HubRoomAgentRequests,
} from "../src/hub/room-agent-requests.js";

const DAY = 86_400_000;
let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await rig?.close(); rig = undefined; });
async function world(realAudit = false) {
  let now = Date.UTC(2026, 10, 19, 12);
  const r = rig = await s3bRig({ now: () => now, realAudit });
  const owner = r.addPerson("request-owner", "Example owner"), other = r.addPerson("other", "Other person");
  const manager = await r.signIn("admin"), outsider = await r.signIn("other");
  if (!r.db.prepare("SELECT 1 FROM sqlite_master WHERE name='hub_room_agent_requests'").get()) r.httpDeps.uow.atomic(tx => HUB_ROOM_AGENT_REQUESTS_MIGRATION.up(r.sql(tx)));
  const events: { transaction: boolean; owner: string }[] = [];
  let service!: HubRoomAgentRequests;
  r.httpDeps.roomAgentRequests = (core, host) => service = createHubRoomAgentRequests(core, { ...host,
    changed: value => { events.push({ transaction: r.db.inTransaction, owner: value.ownerId }); host.changed(value); },
  });
  await r.restartHttp();
  const makeRoom = async () => {
    const result = await r.call(manager, "POST", "/hub/v1/rooms", { name: "Example room" });
    expect(result.status).toBe(200); return result.json.room.id as string;
  };
  const roomId = await makeRoom(), ownerId = personKeyString(owner);
  const path = "/hub/v1/rooms/" + roomId + "/agent-requests";
  const request = (over: Record<string, unknown> = {}) => r.call(manager, "POST", path,
    { owner: ownerId, note: "Example private hint", idempotencyKey: randomUUID(), ...over });
  const ownerSession = () => r.signIn("request-owner");
  const rows = () => r.db.prepare("SELECT * FROM hub_room_agent_requests ORDER BY id").all() as any[];
  const sends = () => (r.db.prepare("SELECT SUM(sends) n FROM hub_room_agent_request_days").get() as { n: number | null }).n ?? 0;
  events.length = 0;
  return { r, owner, other, ownerId, manager, outsider, roomId, path, request, ownerSession, makeRoom, rows, sends, events,
    get service() { return service; }, now: () => now, setNow: (value: number) => { now = value; } };
}

it("requests a person with no agent, without revealing an inventory or the private hint to managers", async () => {
  const w = await world(true), answer = await w.request();
  expect(answer.status).toBe(200);
  expect(answer.json.request).toMatchObject({ owner: { id: w.ownerId, name: "request-owner" }, state: "pending",
    expiresAt: w.now() + ROOM_AGENT_REQUEST_TTL });
  expect(JSON.stringify(answer.json)).not.toMatch(/Example private hint|exposureId|"agent":/);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_exposures").get()).toEqual({ n: 0 });
  expect(w.rows()[0].note_ref).toMatch(/^[a-f0-9]{32}$/);
  expect(JSON.stringify(w.rows())).not.toContain("Example private hint");
  const owner = await w.ownerSession();
  const pending = await w.r.call(owner, "GET", "/hub/v1/agent-requests");
  expect(pending.json.requests).toHaveLength(1);
  expect(pending.json.requests[0]).toMatchObject({ kind: "owner-request", note: "Example private hint",
    room: { id: w.roomId, name: "Example room", people: 1 } });
  expect((await w.r.call(w.outsider, "GET", "/hub/v1/agent-requests")).json.requests).toEqual([]);
  expect((await w.r.call(w.manager, "GET", w.path)).json.requests).toHaveLength(1);
  expect(JSON.stringify((await w.r.call(w.manager, "GET", w.path)).json)).not.toContain("Example private hint");
  expect(w.events.length).toBeGreaterThan(0);
  expect(w.events.every(event => !event.transaction)).toBe(true);
  expect(w.r.sent).toHaveLength(0);
  expect(w.service.retainedNoteRefs()).toEqual([w.rows()[0].note_ref]);
});

it("binds admission to a current manager and rejects client-supplied authority fields", async () => {
  const w = await world(), body = { owner: w.ownerId, idempotencyKey: randomUUID() };
  expect((await w.r.call(w.outsider, "POST", w.path, body)).status).toBe(403);
  expect((await w.r.call(w.outsider, "GET", w.path)).status).toBe(403);
  expect((await w.request({ by: personKeyString(w.other) })).status).toBe(400);
  expect(w.rows()).toEqual([]); expect(w.sends()).toBe(0);
});

it("replays only the same actor-bound operation and does not charge duplicates", async () => {
  const w = await world(), idempotencyKey = randomUUID();
  const first = await w.request({ idempotencyKey }), replay = await w.request({ idempotencyKey });
  expect(replay.status).toBe(200); expect(replay.json).toEqual(first.json);
  expect(w.sends()).toBe(1);
  const duplicate = await w.request();
  expect(duplicate).toMatchObject({ status: 409, json: { code: "request-open" } });
  const conflict = await w.request({ idempotencyKey, note: "Another hint" });
  expect(conflict).toMatchObject({ status: 409, json: { code: "idempotency-conflict" } });
  expect(w.rows()).toHaveLength(1); expect(w.sends()).toBe(1);
});

it("an owner opts out of new requests without changing existing pending cards", async () => {
  const w = await world(), first = await w.request(), owner = await w.ownerSession();
  expect((await w.r.call(owner, "GET", "/hub/v1/me/agent-request-settings")).json).toEqual({ accepting: true });
  expect((await w.r.call(owner, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).json).toEqual({ accepting: false });
  const another = await w.makeRoom();
  const refused = await w.r.call(w.manager, "POST", "/hub/v1/rooms/" + another + "/agent-requests",
    { owner: w.ownerId, idempotencyKey: randomUUID() });
  expect(refused).toMatchObject({ status: 409, json: { code: "owner-not-taking-requests" } });
  expect(w.sends()).toBe(1);
  const pending = (await w.r.call(owner, "GET", "/hub/v1/agent-requests")).json.requests;
  expect(pending.map((row: any) => row.id)).toEqual([first.json.request.id]);
  expect((await w.r.call(w.manager, "GET", w.path)).json.requests[0].state).toBe("pending");
});

it("charges cancelled sends, stops at five, and resets at the next UTC calendar day", async () => {
  const w = await world();
  for (let n = 0; n < 5; n++) {
    const created = await w.request();
    expect(created.status).toBe(200);
    expect((await w.r.call(w.manager, "DELETE", w.path + "/" + created.json.request.id)).status).toBe(200);
  }
  const reset = (Math.floor(w.now() / DAY) + 1) * DAY;
  expect(await w.request()).toMatchObject({ status: 429, json: { code: "request-limit", resetsAt: reset } });
  expect(w.sends()).toBe(5); expect(w.rows()).toHaveLength(5);
  w.setNow(reset);
  const manager = await w.r.signIn("admin");
  const next = await w.r.call(manager, "POST", w.path, { owner: w.ownerId, idempotencyKey: randomUUID() });
  expect(next.status).toBe(200); expect(w.sends()).toBe(6);
});

it("persists observed expiry and never revives the card when the clock goes back", async () => {
  const w = await world(), created = await w.request(), start = w.now();
  w.setNow(start + ROOM_AGENT_REQUEST_TTL);
  let owner = await w.ownerSession();
  expect((await w.r.call(owner, "GET", "/hub/v1/agent-requests")).json.requests).toEqual([]);
  expect(w.rows()[0].state).toBe("expired");
  expect(w.service.retainedNoteRefs()).toEqual([]);
  w.setNow(start + 60_000); owner = await w.ownerSession();
  expect((await w.r.call(owner, "GET", "/hub/v1/agent-requests")).json.requests).toEqual([]);
  expect(w.rows()[0].id).toBe(created.json.request.id);
});

it("rolls back the request and quota together when the audit cannot commit", async () => {
  const w = await world();
  w.r.setAuditFails(true, "room.agent-request-created");
  expect((await w.request()).status).toBe(500);
  expect(w.rows()).toEqual([]); expect(w.sends()).toBe(0); expect(w.events).toEqual([]);
});

it("rechecks manager authority after a held recipient eligibility read", async () => {
  const w = await world(), original = w.r.directory.checkEligibility.bind(w.r.directory);
  let release!: () => void, entered = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(w.r.directory, "checkEligibility").mockImplementation(async person => {
    if (personKeyString(person) === w.ownerId) { entered = true; await held; }
    return original(person);
  });
  const sending = w.request();
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    w.r.db.prepare("UPDATE hub_room_members SET role='member' WHERE room_id=? AND subject=?").run(w.roomId, personKeyString(w.r.admin));
  } finally { release(); }
  expect((await sending).status).toBe(403);
  expect(w.rows()).toEqual([]); expect(w.sends()).toBe(0); expect(w.events).toEqual([]);
});

it("keeps cancellation and cursors bound to their room, and hides requests from ordinary members", async () => {
  const w = await world(), created = await w.request(), otherRoom = await w.makeRoom();
  const id = created.json.request.id;
  expect((await w.r.call(w.manager, "DELETE", "/hub/v1/rooms/" + otherRoom + "/agent-requests/" + id)).status).toBe(404);
  expect((await w.r.call(w.manager, "GET", "/hub/v1/rooms/" + otherRoom + "/agent-requests?after=" + id)).status).toBe(400);
  expect((await w.r.call(w.manager, "POST", "/hub/v1/rooms/" + w.roomId + "/members", { kind: "person", id: personKeyString(w.other) })).status).toBe(200);
  const detail = await w.r.call(w.outsider, "GET", "/hub/v1/rooms/" + w.roomId);
  expect(detail.status).toBe(200); expect(detail.json.agentRequests).toBeUndefined();
  expect(detail.json.settings.ownerAgentRequests).toBeUndefined();
  expect((await w.r.call(w.outsider, "DELETE", w.path + "/" + id)).status).toBe(403);
  expect(w.rows()[0].state).toBe("pending");
  expect((await w.r.call(w.manager, "DELETE", w.path + "/" + id)).status).toBe(200);
  expect((await w.r.call(w.manager, "GET", w.path)).json.requests).toEqual([]);
  expect((await w.r.call(await w.ownerSession(), "GET", "/hub/v1/agent-requests")).json.requests).toEqual([]);
});

it("never replays another manager's operation key", async () => {
  const w = await world(), idempotencyKey = randomUUID();
  const first = await w.request({ idempotencyKey });
  expect((await w.r.call(w.manager, "POST", "/hub/v1/rooms/" + w.roomId + "/members", { kind: "person", id: personKeyString(w.other) })).status).toBe(200);
  w.r.db.prepare("UPDATE hub_room_members SET role='manager' WHERE room_id=? AND subject=?").run(w.roomId, personKeyString(w.other));
  const replay = await w.r.call(w.outsider, "POST", w.path, { owner: w.ownerId, idempotencyKey, note: "Example private hint" });
  expect(replay).toMatchObject({ status: 409, json: { code: "request-open" } });
  expect(JSON.stringify(replay.json)).not.toContain(first.json.request.id);
  expect(w.sends()).toBe(1);
});

it.each(["owner", "quota"])("rolls back a create when its %s changes during audit", async changed => {
  const w = await world(), append = w.r.httpDeps.audit.append.bind(w.r.httpDeps.audit);
  vi.spyOn(w.r.httpDeps.audit, "append").mockImplementation((tx, record) => {
    append(tx, record);
    if (record.action !== "room.agent-request-created") return;
    if (changed === "owner") w.r.db.prepare("INSERT INTO hub_room_agent_request_settings VALUES(?,0,1)").run(w.ownerId);
    else w.r.db.prepare("UPDATE hub_room_agent_request_days SET sends=5").run();
  });
  expect((await w.request()).status).toBe(409);
  expect(w.rows()).toEqual([]); expect(w.sends()).toBe(0); expect(w.events).toEqual([]);
});

it("refuses a private hint whose content reference was replaced", async () => {
  const w = await world(true);
  await w.request();
  const first = w.rows()[0], otherRoom = await w.makeRoom();
  expect((await w.r.call(w.manager, "POST", "/hub/v1/rooms/" + otherRoom + "/agent-requests", {
    owner: w.ownerId, note: "Another room's private hint", idempotencyKey: randomUUID(),
  })).status).toBe(200);
  const second = w.rows().find(row => row.id !== first.id);
  w.r.db.prepare("UPDATE hub_room_agent_requests SET note_ref=? WHERE id=?").run(second.note_ref, first.id);
  const result = await w.r.call(await w.ownerSession(), "GET", "/hub/v1/agent-requests");
  expect(result.status).toBe(503);
  expect(JSON.stringify(result.json)).not.toContain("private hint");
});

it("registers storage while leaving the routes and feature absent without their composition", async () => {
  const r = rig = await s3bRig(), admin = await r.signIn("admin");
  expect(r.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'hub_room_agent_request%'").all()).toHaveLength(3);
  expect(r.http.features).not.toContain("room-owner-requests-v1");
  expect((admin.body as any).features).not.toContain("room-owner-requests-v1");
  expect((await r.call(admin, "GET", "/hub/v1/agent-requests")).status).toBe(404);
  expect((await r.call(admin, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).status).toBe(404);
});
