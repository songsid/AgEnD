import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubCore } from "../src/hub/http/core.js";
import type { PersonKey } from "../src/hub/types.js";
import { createHubRoomAgentRequests, HUB_ROOM_AGENT_REQUESTS_MIGRATION, ROOM_AGENT_REQUEST_TTL } from "../src/hub/room-agent-requests.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await rig?.close(); rig = undefined; });
async function world() {
  let now = Date.UTC(2026, 10, 19, 12);
  const r = rig = await s3bRig({ realAudit: true, now: () => now });
  const owner = r.addPerson("example-owner", "Example owner"), other = r.addPerson("example-other", "Other owner");
  const manager = await r.signIn("admin"), browser = await r.signIn("example-owner"), outsider = await r.signIn("example-other");
  if (!r.db.prepare("SELECT 1 FROM sqlite_master WHERE name='hub_room_agent_requests'").get()) HUB_ROOM_AGENT_REQUESTS_MIGRATION.up(r.db);
  let core!: HubCore;
  r.httpDeps.roomAgentRequests = (c, host) => { core = c; return createHubRoomAgentRequests(c, host); };
  await r.restartHttp();
  const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: "Example project" });
  expect(made.status).toBe(200); const roomId = made.json.room.id;
  const sent = await r.call(manager, "POST", "/hub/v1/rooms/" + roomId + "/agent-requests", {
    owner: personKeyString(owner), note: "The agent for release notes", idempotencyKey: randomUUID(),
  });
  expect(sent.status).toBe(200); const id = sent.json.request.id, path = "/hub/v1/agent-requests/" + id;
  const publish = async (person: PersonKey, name: string) => {
    const link = r.link(randomUUID(), person), exposure = { id: randomUUID(), fleetId: link.fleetId, owner: person,
      displayName: name, state: "published" as const, revision: 1, dataViewId: "example", allowedTools: [], policyDigest: "c".repeat(64) };
    await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
    return exposure;
  };
  const shared = await publish(owner, "Release helper"), unshared = await publish(owner, "Scratch helper"), foreign = await publish(other, "Other helper");
  r.db.prepare("UPDATE hub_exposures SET state='withdrawn' WHERE id=?").run(unshared.id);
  const accept = (body: unknown = { exposureId: shared.id, revision: 1 }, who = browser) => r.call(who, "POST", path + "/accept", body);
  const row = () => r.db.prepare("SELECT * FROM hub_room_agent_requests WHERE id=?").get(id) as any;
  const members = () => r.db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent'").all(roomId);
  return { r, owner, other, manager, browser, outsider, id, roomId, path, shared, unshared, foreign, accept, row, members,
    get core() { return core; }, now: () => now, setNow: (value: number) => { now = value; } };
}

it("shows only the recipient's choices and adds one shared agent without a direct grant or owner membership", async () => {
  const w = await world();
  const view = await w.r.call(w.browser, "GET", w.path);
  expect(view.status).toBe(200);
  expect(view.json.request).toMatchObject({ note: "The agent for release notes", room: { id: w.roomId, people: 1 } });
  expect(view.json.choices.find((x: any) => x.exposureId === w.shared.id)).toMatchObject({ name: "Release helper", canAdd: true, revision: 1 });
  expect(view.json.choices.find((x: any) => x.exposureId === w.unshared.id)).toMatchObject({ name: "Scratch helper", canAdd: false, shared: false });
  expect(JSON.stringify(view.json)).not.toContain(w.foreign.id);
  expect((await w.r.call(w.outsider, "GET", w.path)).status).toBe(404);
  expect((await w.r.call(w.manager, "GET", w.path)).status).toBe(404);
  expect((await w.accept()).status).toBe(200);
  expect(w.row()).toMatchObject({ state: "accepted", exposure_id: w.shared.id });
  expect(w.members()).toHaveLength(1);
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(w.roomId, personKeyString(w.owner))).toEqual({ n: 0 });
  expect((await w.accept()).status).toBe(200); expect(w.members()).toHaveLength(1);
});

it("refuses unshared, foreign, stale and supplied-authority targets without changing membership", async () => {
  const w = await world();
  expect((await w.accept({ exposureId: w.unshared.id, revision: 1 })).status).toBe(409);
  expect((await w.accept({ exposureId: w.foreign.id, revision: 1 })).status).toBe(404);
  expect((await w.accept({ exposureId: w.shared.id, revision: 2 })).status).toBe(409);
  expect((await w.accept({ exposureId: w.shared.id, revision: 1, owner: personKeyString(w.owner) })).status).toBe(400);
  expect((await w.accept(undefined, w.outsider)).status).toBe(404);
  expect(w.row().state).toBe("pending"); expect(w.members()).toEqual([]);
});

it("keeps a pending request answerable after the owner turns off new requests", async () => {
  const w = await world();
  expect((await w.r.call(w.browser, "PUT", "/hub/v1/me/agent-request-settings", { accepting: false })).status).toBe(200);
  expect((await w.accept()).status).toBe(200);
  expect(w.row().state).toBe("accepted");
});

it("counts requests only for their owner and only for an opted-in rooms reader", async () => {
  const w = await world();
  expect((await w.r.call(w.browser, "GET", "/hub/v1/rooms?v=2")).json.invitations).toBe(0);
  expect((await w.r.call(w.browser, "GET", "/hub/v1/rooms?v=2&ownerRequests=1")).json.invitations).toBe(1);
  expect((await w.r.call(w.outsider, "GET", "/hub/v1/rooms?v=2&ownerRequests=1")).json.invitations).toBe(0);
  expect((await w.r.call(w.browser, "POST", w.path + "/decline", {})).status).toBe(200);
  expect((await w.r.call(w.browser, "GET", "/hub/v1/rooms?v=2&ownerRequests=1")).json.invitations).toBe(0);
});

it("lets only the owner decline, privately and idempotently", async () => {
  const w = await world();
  expect((await w.r.call(w.outsider, "POST", w.path + "/decline", {})).status).toBe(404);
  expect((await w.r.call(w.browser, "POST", w.path + "/decline", {})).status).toBe(200);
  expect((await w.r.call(w.browser, "POST", w.path + "/decline", {})).status).toBe(200);
  expect((await w.accept()).status).toBe(404);
  const manager = await w.r.call(w.manager, "GET", "/hub/v1/rooms/" + w.roomId + "/agent-requests");
  expect(manager.json.requests[0].state).toBe("declined");
  expect(JSON.stringify(manager.json)).not.toMatch(/Release helper|Scratch helper|release notes/);
  expect(w.members()).toEqual([]);
});

it.each(["cancel", "expiry"])("does not add an agent after %s wins", async state => {
  const w = await world();
  if (state === "cancel") expect((await w.r.call(w.manager, "DELETE", "/hub/v1/rooms/" + w.roomId + "/agent-requests/" + w.id)).status).toBe(200);
  else { w.setNow(w.now() + ROOM_AGENT_REQUEST_TTL); w.browser = await w.r.signIn("example-owner"); }
  expect((await w.r.call(w.browser, "POST", w.path + "/accept", { exposureId: w.shared.id, revision: 1 })).status).toBe(404);
  expect(w.row().state).toBe(state === "cancel" ? "cancelled" : "expired");
  expect(w.members()).toEqual([]);
});

it.each(["publication", "request"])("rechecks the %s after a held permission read", async changed => {
  const w = await world(), original = w.core.groupExposure.bind(w.core);
  let release!: () => void, entered = false;
  const hold = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(w.core, "groupExposure").mockImplementation(async (...args) => {
    const permit = await original(...args); entered = true; await hold; return permit;
  });
  const attempt = w.accept();
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    if (changed === "publication") w.r.db.prepare("UPDATE hub_exposures SET revision=2 WHERE id=?").run(w.shared.id);
    else w.r.db.prepare("UPDATE hub_room_agent_requests SET state='cancelled' WHERE id=?").run(w.id);
  } finally { release(); }
  expect((await attempt).status).toBe(changed === "publication" ? 409 : 404);
  expect(w.members()).toEqual([]);
  expect(w.row().state).toBe(changed === "publication" ? "pending" : "cancelled");
});
