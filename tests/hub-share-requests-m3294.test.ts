import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubAgentCatalogs } from "../src/hub/agent-catalog.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubSharingRequests } from "../src/hub/sharing-requests.js";
import { personKeyString } from "../src/hub/identity.js";
import { parseMemberFrame } from "../src/hub/protocol.js";
import type { HubAgentCatalog } from "../src/hub/agent-catalog-model.js";
import type { HubRequestContext, HubFleetExposure, HubMemberFrame } from "../src/hub/types.js";
let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
async function world(ownerAdmin = false) {
  let now = 1_800_000_000_000;
  const r = rig = await s3bRig({ now: () => now });
  const owner = ownerAdmin ? r.admin : r.addPerson("owner", "Owner"), reader = r.addPerson("reader", "Reader"), fleetId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: now, actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push({ id: fleetId, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
  });
  const link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1"]);
  r.http.memberConnected!(link);
  let catalogRevision = 0;
  const exposureId = randomUUID();
  const exposure = (revision: number): HubFleetExposure => ({ id: exposureId, owner, fleetId, displayName: "Document helper", revision,
    state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  const snapshot = async (exposures: HubFleetExposure[], revision: number) => r.http.receive(r.frame("exposure.snapshot", { revision, exposures }, link), link);
  const catalog = async (state: "published" | "withdrawn" | "absent", revision = 1) => {
    catalogRevision++;
    const body: HubAgentCatalog = { enabled: true, requests: true, revision: String(catalogRevision).padStart(64, "0"), agents: [{ instance: "Docs", displayName: "Document helper", description: "A helper", avatar: null,
      kind: "agent", general: false, shareable: true, exposure: state === "absent" ? null : { id: exposureId, revision, state } }] };
    await r.http.receive(r.frame("agent.catalog", body, link), link); return body;
  };
  await r.signIn("reader");
  const browser = await r.signIn(ownerAdmin ? "admin" : "owner"), other = await r.signIn("admin");
  const request = async (share = ["Docs"], stop: string[] = [], revision?: string) => {
    const current = revision ?? (await catalog(share.length ? "absent" : "published")).revision;
    const input = { idempotencyKey: randomUUID(), fleetId, catalogRevision: current, share, stop };
    return { input, response: await r.call(browser, "POST", "/hub/v1/me/agent-sharing", input) };
  };
  const result = async (id: string, results: unknown[], noticeAt = now) => r.http.receive({ ...r.frame("exposure.request-result", { noticeAt, undoUntil: noticeAt + 86_400_000, results }, link), requestId: id } as Exclude<HubMemberFrame, { type: "hello" }>, link);
  const undo = async (id: string, originalRequestId: string, results: unknown[], noticeAt = now) => r.http.receive({ ...r.frame("exposure.undo", { originalRequestId, noticeAt, results }, link), requestId: id } as Exclude<HubMemberFrame, { type: "hello" }>, link);
  return { r, now: () => now, setNow: (value: number) => { now = value; }, owner, reader, fleetId, link, exposureId, exposure, snapshot, catalog, browser, other, request, result, undo };
}
it("admits only the exact owner's current browser, freezes retries, and does not add any member-list endpoint", async () => {
  const w = await world(), report = await w.catalog("absent");
  const input = { idempotencyKey: randomUUID(), fleetId: w.fleetId, catalogRevision: report.revision, share: ["Docs"], stop: [] };
  expect((await w.r.call(w.other, "POST", "/hub/v1/me/agent-sharing", input)).status).toBe(404);
  expect((await w.r.call(null, "POST", "/hub/v1/me/agent-sharing", input)).status).toBe(401);
  expect((await w.r.call(w.browser, "POST", "/hub/v1/me/agent-sharing", input, { "X-AgEnD-Hub-CSRF": "wrong" })).status).toBe(403);
  const accepted = await w.r.call(w.browser, "POST", "/hub/v1/me/agent-sharing", input);
  expect(accepted.status).toBe(200); expect(accepted.json).toMatchObject({ id: input.idempotencyKey, state: "queued", result: null });
  expect((await w.r.call(w.browser, "POST", "/hub/v1/me/agent-sharing", input)).json).toEqual(accepted.json);
  expect((await w.r.call(w.browser, "POST", "/hub/v1/me/agent-sharing", { ...input, share: ["Other"] })).status).toBe(409);
  const row = w.r.db.prepare("SELECT body FROM hub_sharing_requests WHERE id=?").get(input.idempotencyKey) as { body: string };
  expect(JSON.parse(row.body)).toMatchObject({ by: w.owner, byName: "Owner" });
  await expect.poll(() => w.r.sent.filter(item => item.frame.type === "exposure.request").length).toBe(1);
  expect(w.r.sent.find(item => item.frame.type === "exposure.request")!.frame.requestId).toBe(input.idempotencyKey);
  w.setNow(w.now() + 600_000);
  expect((await w.r.call(w.browser, "GET", `/hub/v1/me/agent-sharing/${input.idempotencyKey}`)).json.state).toBe("expired");
  expect((await w.r.call(w.other, "GET", `/hub/v1/me/agent-sharing/${input.idempotencyKey}`)).status).toBe(404);
});
it("refuses a directory-shaped app context and a replaced session before queueing", async () => {
  const w = await world(), core = new HubCore(w.r.httpDeps, w.r.sql), catalogs = new HubAgentCatalogs(core), queue = new HubSharingRequests(core, catalogs);
  const session = w.r.db.prepare("SELECT id FROM hub_sessions WHERE person=?").get(personKeyString(w.owner)) as { id: string };
  const ctx: HubRequestContext = { requestId: randomUUID(), requirePerson: async () => w.owner, requireAdmin: async () => { throw Error("unused"); }, isCurrent: () => true,
    current: async () => ({ kind: "directory", person: w.owner, sessionId: `mcp:${session.id}` }) };
  const input = { idempotencyKey: randomUUID(), fleetId: w.fleetId, catalogRevision: "a".repeat(64), share: ["Docs"], stop: [] };
  await expect(queue.request(ctx, input)).rejects.toMatchObject({ code: "denied" });
  ctx.current = async () => ({ kind: "directory", person: w.owner, sessionId: session.id });
  w.r.db.prepare("UPDATE hub_sessions SET state='ended' WHERE id=?").run(session.id);
  await expect(queue.request(ctx, input)).rejects.toMatchObject({ code: "revoked" });
  expect(w.r.db.prepare("SELECT * FROM hub_sharing_requests").all()).toEqual([]); queue.close();
});
it("accepts late frozen evidence after expiry, refuses altered outcomes and foreign links", async () => {
  const w = await world(), { input, response } = await w.request(); expect(response.status).toBe(200);
  const at = w.now(), rows = [{ instance: "Docs", ok: true, before: null, after: { id: w.exposureId, revision: 1, state: "published" } }];
  w.setNow(at + 600_001);
  expect(await w.result(input.idempotencyKey, rows, at)).toMatchObject({ type: "exposure.request-ack", payload: { ok: true } });
  expect(await w.result(input.idempotencyKey, rows, at)).toMatchObject({ type: "exposure.request-ack" });
  await expect(w.result(input.idempotencyKey, [{ ...rows[0], after: { ...rows[0].after, revision: 2 } }], at)).rejects.toMatchObject({ code: "invalid" });
  const foreign = w.r.link(w.fleetId, w.reader, 5, [...w.link.features]);
  const foreignFrame = parseMemberFrame(JSON.stringify({ ...w.r.frame("exposure.request-result", { noticeAt: at, undoUntil: at + 86_400_000, results: rows }, foreign), requestId: input.idempotencyKey }));
  if (foreignFrame.type === "hello") throw Error("invalid fixture");
  await expect(w.r.http.receive(foreignFrame, foreign)).rejects.toMatchObject({ code: "denied" });
});
it.each([false, true])("restores the stopped list only on explicit Undo, preserving expiry and closing old history (coalesced=%s)", async coalesced => {
  const w = await world(); await w.snapshot([w.exposure(1)], 1);
  const granted = await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "reader", days: 7 });
  expect(granted.status).toBe(200); const grant = granted.json.grant;
  const report = await w.catalog("published"), { input, response } = await w.request([], [w.exposureId], report.revision); expect(response.status).toBe(200);
  const at = w.now();
  if (!coalesced) await w.snapshot([], 2);
  expect(await w.result(input.idempotencyKey, [{ exposureId: w.exposureId, ok: true, before: { id: w.exposureId, revision: 1, state: "published" },
    after: { id: w.exposureId, revision: 2, state: "withdrawn" } }], at)).toMatchObject({ type: "exposure.request-ack" });
  const undoId = randomUUID();
  expect(await w.undo(undoId, input.idempotencyKey, [{ index: 0, ok: true, before: { id: w.exposureId, revision: 2, state: "withdrawn" },
    after: { id: w.exposureId, revision: 3, state: "published" } }], at)).toMatchObject({ type: "exposure.undo-result" });
  await w.snapshot([w.exposure(3)], 3);
  const restored = w.r.db.prepare("SELECT * FROM hub_grants WHERE exposure_id=? AND state='active'").all(w.exposureId) as { id: string; exposure_revision: number; expires_at: number }[];
  expect(restored).toHaveLength(1); expect(restored[0]).toMatchObject({ exposure_revision: 3, expires_at: grant.expiresAt }); expect(restored[0].id).not.toBe(grant.id);
  expect(w.r.db.prepare("SELECT state FROM hub_grants WHERE id=?").get(grant.id)).toEqual({ state: "revoked" });
  await w.undo(undoId, input.idempotencyKey, [{ index: 0, ok: true, before: { id: w.exposureId, revision: 2, state: "withdrawn" }, after: { id: w.exposureId, revision: 3, state: "published" } }], at);
  await w.snapshot([w.exposure(3)], 3);
  expect(w.r.db.prepare("SELECT id FROM hub_grants WHERE exposure_id=? AND state='active'").all(w.exposureId)).toHaveLength(1);
});
it("does not revive a stopped list on an ordinary re-share", async () => {
  const w = await world(); await w.snapshot([w.exposure(1)], 1);
  const grant = (await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "reader", days: 7 })).json.grant;
  await w.snapshot([], 2); await w.snapshot([w.exposure(3)], 3);
  expect(w.r.db.prepare("SELECT * FROM hub_grants WHERE state='active'").all()).toEqual([]);
  expect(w.r.db.prepare("SELECT state FROM hub_grants WHERE id=?").get(grant.id)).toEqual({ state: "revoked" });
  expect(w.r.db.prepare("SELECT exposure_id FROM hub_stopped_ask_lists").all()).toEqual([{ exposure_id: w.exposureId }]);
});

it.each([false, true])("settles pending direct and room asks without reopening history or accepting late answers (coalesced=%s)", async coalesced => {
  const w = await world(true); await w.snapshot([w.exposure(1)], 1);
  const grant = (await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "reader", days: 7 })).json.grant;
  const reader = await w.r.signIn("reader");
  const direct = (await w.r.call(reader, "POST", "/hub/v1/rooms", { exposureId: w.exposureId, grantId: grant.id })).json.room.id;
  const asked = await w.r.call(reader, "POST", `/hub/v1/rooms/${direct}/messages`, { text: "A question", idempotencyKey: randomUUID() });
  expect(asked.status).toBe(200);
  const messageId = asked.json.receipt.messageId;
  const group = (await w.r.call(w.browser, "POST", "/hub/v1/rooms", { name: "Planning", people: [personKeyString(w.reader)] })).json.room.id;
  expect((await w.r.call(w.browser, "POST", `/hub/v1/rooms/${group}/members`, { kind: "agent", id: w.exposureId })).status).toBe(200);
  const roomAsked = await w.r.call(reader, "POST", `/hub/v1/rooms/${group}/messages`, { text: "A room question", mentions: [w.exposureId], idempotencyKey: randomUUID() });
  expect(roomAsked.status).toBe(200);
  if (coalesced) {
    const report = await w.catalog("published"), { input, response } = await w.request([], [w.exposureId], report.revision);
    expect(response.status).toBe(200);
    await w.snapshot([w.exposure(3)], 3);
    await w.result(input.idempotencyKey, [{ exposureId: w.exposureId, ok: true, before: { id: w.exposureId, revision: 1, state: "published" }, after: { id: w.exposureId, revision: 2, state: "withdrawn" } }]);
  } else await w.snapshot([], 2);
  expect(w.r.db.prepare("SELECT stage,reason_code FROM hub_messages WHERE id=?").get(messageId)).toEqual({ stage: "cancelled", reason_code: "owner-stopped-sharing" });
  expect(w.r.db.prepare("SELECT state,reason_code FROM hub_room_deliveries WHERE parent_id=?").get(roomAsked.json.id)).toEqual({ state: "retired", reason_code: "owner-stopped-sharing" });
  const posts = (await w.r.call(reader, "GET", `/hub/v1/rooms/${group}/messages`)).json.messages;
  expect(posts.find((row: { id: string }) => row.id === roomAsked.json.id).ask).toMatchObject({ blocked: 1, later: 0, working: 0, reason: "owner-stopped-sharing" });
  expect(posts.find((row: { answerTo?: string }) => row.answerTo === roomAsked.json.id)).toMatchObject({ stage: "not-answered", reasonCode: "owner-stopped-sharing", author: { owner: { name: "Hub Admin" } } });
  const metadata = await w.r.call(reader, "GET", `/hub/v1/rooms/${direct}`);
  expect(metadata.status).toBe(200); expect(metadata.json.room).toMatchObject({ state: "closed", waiting: false, closureReason: "owner-stopped-sharing" });
  expect((await w.r.call(reader, "GET", `/hub/v1/rooms/${direct}/messages`)).status).toBe(403);
  const row = w.r.db.prepare("SELECT content_digest FROM hub_messages WHERE id=?").get(messageId) as { content_digest: string };
  await w.r.http.receive(w.r.frame("receipt", { messageId, contentDigest: row.content_digest, stage: "consumed" as const, sequence: 1, at: w.now() }, w.link), w.link);
  expect(w.r.db.prepare("SELECT stage,reason_code FROM hub_messages WHERE id=?").get(messageId)).toEqual({ stage: "cancelled", reason_code: "owner-stopped-sharing" });
  const delivery = w.r.db.prepare("SELECT id FROM hub_room_deliveries WHERE parent_id=?").get(roomAsked.json.id) as { id: string };
  await w.r.http.receive(w.r.frame("room.answer", { messageId: delivery.id, roomId: group, exposureId: w.exposureId, answerId: randomUUID(), text: "A late answer" }, w.link), w.link);
  expect(JSON.stringify((await w.r.call(reader, "GET", `/hub/v1/rooms/${group}/messages`)).json)).not.toContain("A late answer");
});

it.each(["grant", "freeze", "sharing-epoch", "generation", "expired"])("does not restore an old ask list after %s changes", async change => {
  const w = await world(); await w.snapshot([w.exposure(1)], 1);
  const old = (await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 1, login: "reader", days: 7 })).json.grant;
  const report = await w.catalog("published"), { input, response } = await w.request([], [w.exposureId], report.revision);
  expect(response.status).toBe(200); const at = w.now();
  await w.snapshot([], 2);
  await w.result(input.idempotencyKey, [{ exposureId: w.exposureId, ok: true, before: { id: w.exposureId, revision: 1, state: "published" }, after: { id: w.exposureId, revision: 2, state: "withdrawn" } }], at);
  await w.snapshot([w.exposure(3)], 3);
  let newer: { id: string } | undefined;
  if (change === "grant") {
    const granted = await w.r.call(w.browser, "POST", "/hub/v1/grants", { exposureId: w.exposureId, exposureRevision: 3, login: "reader", days: 1 });
    expect(granted.status).toBe(200); newer = granted.json.grant;
  } else if (change === "freeze") w.r.db.prepare("UPDATE hub_exposures SET frozen_through=3 WHERE id=?").run(w.exposureId);
  else if (change === "sharing-epoch") w.r.db.prepare("UPDATE hub_exposures SET sharing_epoch=sharing_epoch+1 WHERE id=?").run(w.exposureId);
  else if (change === "expired") w.setNow(at + 86_400_000);
  else w.r.store.mutate({ requestId: randomUUID(), at, actor: { kind: "local-host" }, action: "fixture.generation", result: "completed" }, state => { state.fleets.find(row => row.id === w.fleetId)!.generation++; });
  const undo = () => w.undo(randomUUID(), input.idempotencyKey, [{ index: 0, ok: true, before: { id: w.exposureId, revision: 2, state: "withdrawn" }, after: { id: w.exposureId, revision: 3, state: "published" } }], at);
  if (change === "generation") await expect(undo()).rejects.toMatchObject({ code: "denied" });
  else { await undo(); await w.snapshot([w.exposure(3)], 3); }
  expect(w.r.db.prepare("SELECT state FROM hub_grants WHERE id=?").get(old.id)).toEqual({ state: "revoked" });
  const active = w.r.db.prepare("SELECT id FROM hub_grants WHERE exposure_id=? AND state='active'").all(w.exposureId);
  expect(active).toEqual(newer ? [{ id: newer.id }] : []);
});
