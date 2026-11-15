import { afterEach, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const path = "/hub/v1/admin/dashboard";

function directRows(now: number) {
  const db = r!.db, person = personKeyString(r!.admin), fleet = randomUUID(), exposure = randomUUID(), grant = randomUUID(), room = randomUUID();
  db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Stats agent',1,'published','agent','[]','digest',?)").run(exposure, fleet, person, now);
  db.prepare(`INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state)
    VALUES(?,1,?,?,1,?,0,?,'[]',0,?,'active')`).run(grant, person, exposure, person, person, now + 86_400_000);
  db.prepare("INSERT INTO hub_rooms VALUES(?,?,?,? ,?,'active',?)").run(room, person, exposure, person, grant, now);
  let sequence = 0;
  return (value: { created?: number; stage?: string; reason?: string; answer?: boolean; answeredAt?: number; expires?: number } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO hub_messages(id,room_id,idempotency_key,sequence,fleet_id,exposure_id,exposure_revision,grant_id,grant_revision,asker,owner,
      content_digest,question_ref,stage,reason_code,stage_at,answer_id,created_at,expires_at,answered_at)
      VALUES(@id,@room,@id,@sequence,@fleet,@exposure,1,@grant,1,@person,@person,'digest','secret content ref',@stage,@reason,@created,@answer,@created,@expires,@answeredAt)`)
      .run({ id, room, sequence: ++sequence, fleet, exposure, grant, person, created: value.created ?? now - 10_000,
        stage: value.stage ?? (value.answer ? "answered" : "queued"), reason: value.reason ?? null,
        answer: value.answer ? randomUUID() : null, expires: value.expires ?? now + 86_400_000, answeredAt: value.answeredAt ?? null });
    return id;
  };
}

it("requires the administrator and strictly bounds the read without reading content", async () => {
  r = await s3bRig(); r.addPerson("colleague");
  const admin = await r.signIn("admin"), colleague = await r.signIn("colleague");
  expect((await r.call(null, "GET", path)).status).toBe(401);
  expect((await r.call(colleague, "GET", path)).status).toBe(403);
  const get = vi.spyOn(r.httpDeps.content, "get").mockImplementation(() => { throw new Error("must not read content"); });
  const answer = await r.call(admin, "GET", path);
  expect(answer.status).toBe(200);
  expect(answer.json).toMatchObject({ range: "7d", timeZone: "UTC", people: { total: 2, signedInNow: 2 },
    questions: { asked: 0, waiting: 0, longestWaitMs: null, answerTime: { medianMs: null, p90Ms: null, samples: 0 } },
    rooms: { messages: 0, chainsStopped: 0 }, topAgents: [] });
  expect(get).not.toHaveBeenCalled();
  expect(JSON.stringify(answer.json)).not.toContain(personKeyString(r.admin));
  for (const query of ["range=month", "timeZone=bad-zone", "person=admin", "range=today&range=7d"]) {
    expect((await r.call(admin, "GET", `${path}?${query}`)).status).toBe(400);
  }
  expect((await r.call(admin, "POST", path, {})).status).toBe(405);
});

it("uses local calendar boundaries including a DST day and deduplicates people across sessions", async () => {
  const now = Date.parse("2026-11-02T04:30:00Z"); // Nov 1, 23:30 in New York (25-hour day).
  r = await s3bRig({ now: () => now }); r.addPerson("sam");
  const admin = await r.signIn("admin"); await r.signIn("sam"); await r.signIn("sam");
  const out = await r.call(admin, "GET", `${path}?range=today&timeZone=America%2FNew_York`);
  expect(out.status).toBe(200);
  expect(out.json).toMatchObject({ start: Date.parse("2026-11-01T04:00:00Z"), end: now,
    people: { total: 2, activeToday: 2, active7d: 2, joined7d: 2, signedInNow: 2 } });
  expect(out.json.questions.perDay).toHaveLength(7);
  expect(out.json.questions.perDay.at(-1)).toEqual({ date: "2026-11-01", count: 0 });
});

it("counts recent activity separately from current usable sessions and first-time joins", async () => {
  let now = Date.parse("2026-10-01T08:00:00Z");
  r = await s3bRig({ now: () => now }); r.addPerson("sam"); await r.signIn("sam");
  now = Date.parse("2026-11-15T08:00:00Z");
  const admin = await r.signIn("admin"); await r.signIn("sam");
  // An ended and a previous-directory session are activity, but do not mean signed in now.
  r.db.prepare("UPDATE hub_sessions SET directory_epoch=directory_epoch+1 WHERE person=?").run(personKeyString(r.people.get("sam")!.key));
  let view = (await r.call(admin, "GET", path)).json.people;
  expect(view).toMatchObject({ total: 2, activeToday: 2, active7d: 2, joined7d: 1, signedInNow: 1 });
  r.db.prepare("UPDATE hub_sessions SET directory_epoch=0,state='ended' WHERE person=?").run(personKeyString(r.people.get("sam")!.key));
  view = (await r.call(admin, "GET", path)).json.people; expect(view.signedInNow).toBe(1);
});

it("counts actual room asks/answers and persists one stop for a replayed two-agent loop", async () => {
  let now = Date.parse("2026-11-15T08:00:00Z");
  r = await s3bRig({ now: () => now, realAudit: true });
  const admin = await r.signIn("admin"), fleetId = randomUUID();
  const link = r.link(fleetId, r.admin, 1, ["welcome-caps-v1", "room-ask-v1", "room-post-v1"]);
  const expose = (displayName: string): HubExposure => ({ id: randomUUID(), fleetId, owner: r!.admin, displayName,
    revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  const a = expose("Notes"), b = expose("Planner");
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [a, b] }, link) as never, link);
  const id = (await r.call(admin, "POST", "/hub/v1/rooms", { name: "Private room marker" })).json.room.id;
  for (const agent of [a, b]) expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: agent.id })).status).toBe(200);
  const asks = () => [...new Map(r!.sent.filter(s => s.frame.type === "room.ask").map(s => { const p = s.frame.payload as HubRoomAsk; return [p.messageId, p]; })).values()];
  expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/messages`, { text: "@Notes secret question marker", mentions: [a.id], idempotencyKey: randomUUID() })).status).toBe(200);
  const answer = async (index: number, text: string) => {
    await vi.waitFor(() => expect(asks()).toHaveLength(index + 1));
    now += 1000 * (index + 1);
    const ask = asks()[index]!, body = { messageId: ask.messageId, roomId: id, exposureId: ask.exposureId, answerId: randomUUID(), text };
    if (index === 2) {
      r!.setAuditFails(true, "room.agent-mention-stopped");
      await expect(r!.http.receive(r!.frame("room.answer", body, link) as never, link)).rejects.toThrow();
      expect(r!.db.prepare("SELECT answered_at FROM hub_room_deliveries WHERE id=?").get(body.messageId)).toEqual({ answered_at: null });
      expect(r!.db.prepare("SELECT COALESCE(SUM(count),0) n FROM hub_chain_stop_counts").get()).toEqual({ n: 0 });
      r!.setAuditFails(false);
    }
    await r!.http.receive(r!.frame("room.answer", body, link) as never, link);
    return body;
  };
  await answer(0, "@Planner check"); await answer(1, "@Notes check again");
  const final = await answer(2, "@Planner secret answer marker");
  const recorded = r.db.prepare("SELECT answered_at FROM hub_room_deliveries WHERE id=?").get(final.messageId) as { answered_at: number };
  expect(recorded.answered_at).toBe(now);
  now += 60_000;
  await r.http.receive(r.frame("room.answer", final, link) as never, link);
  expect(r.db.prepare("SELECT answered_at FROM hub_room_deliveries WHERE id=?").get(final.messageId)).toEqual(recorded);
  const view = (await r.call(admin, "GET", path)).json;
  expect(view.questions).toMatchObject({ asked: 3, waiting: 0, answerTime: { medianMs: null, p90Ms: null, samples: 3 } });
  expect(view.rooms).toMatchObject({ active: 1, agentQuestions: 3, messages: 4, byAuthor: { people: 1, agents: 3, assistant: 0 }, chainsStopped: 1 });
  expect(view.topAgents[0]).toMatchObject({ id: a.id, name: "Notes", ownerName: "Hub Admin", questions: 2, medianMs: null });
  const serialized = JSON.stringify(view);
  for (const secret of ["Private room marker", "secret question marker", "secret answer marker", id, personKeyString(r.admin)]) expect(serialized).not.toContain(secret);
  for (let i = 0; i < 5; i++) {
    const result = await r.http.receive(r.frame("room.post", { exposureId: a.id, room: id, text: "Daily update", idempotencyKey: randomUUID() }, link) as never, link);
    expect(result).toMatchObject({ payload: { ok: true } });
  }
  for (let i = 0; i < 2; i++) expect(await r.http.receive(r.frame("room.post", { exposureId: a.id, room: id, text: "Too fast", idempotencyKey: randomUUID() }, link) as never, link)).toMatchObject({ payload: { ok: false, code: "rate-limited" } });
  expect((await r.call(admin, "GET", path)).json.rooms.chainsStopped).toBe(2);
  await r.restartHttp();
  r.db.prepare("DELETE FROM hub_room_agent_stops").run(); // Retaining aggregate counts does not depend on retaining room events.
  expect((await r.call(admin, "GET", path)).json.rooms.chainsStopped).toBe(2);
});

it("computes target counts, measured percentiles and known/unknown failures without inferring offline", async () => {
  const now = Date.parse("2026-11-15T08:00:00Z");
  r = await s3bRig({ now: () => now }); const admin = await r.signIn("admin"), add = directRows(now);
  for (let seconds = 1; seconds <= 6; seconds++) add({ answer: true, answeredAt: now - 10_000 + seconds * 1000 });
  add({ answer: true }); // Old answer: no invented timestamp.
  for (const reason of ["expired", "revoked", "incompatible", "unavailable", undefined]) add({ stage: "failed", reason });
  add({ stage: "uncertain", reason: "uncertain" });
  add({ created: now - 14 * 3_600_000 }); // Waiting since yesterday, outside today's question count.
  add({ expires: now }); // Due expiry is not a new waiting question, even before the next sweep.
  add({ created: now - 10 * 86_400_000, stage: "failed", reason: "expired" });
  vi.spyOn(r.httpDeps.content, "get").mockImplementation(() => { throw new Error("must not read content"); });
  const out = await r.call(admin, "GET", `${path}?range=today`);
  expect(out.status).toBe(200);
  expect(out.json.questions).toMatchObject({ asked: 14, answerTime: { samples: 6, medianMs: 3500, p90Ms: 6000 }, waiting: 1,
    longestWaitMs: 14 * 3_600_000, notAnswered: { total: 7, reasons: { offline: 0, timedOut: 2, permissionEnded: 1, stoppedOrRefused: 1, unknown: 3 } } });
  expect(out.json.topAgents[0]).toMatchObject({ questions: 14, medianMs: 3500, notAnswered: 7 });
  expect(out.json.questions.perDay.reduce((sum: number, d: { count: number }) => sum + d.count, 0)).toBe(15);
  expect((await r.call(admin, "GET", path)).json.questions.asked).toBe(15);
});

it("excludes Hub-assistant jobs from questions while counting their visible room answers", async () => {
  r = await s3bRig({ realAudit: true }); const admin = await r.signIn("admin");
  r.httpDeps.roomAssistant = { available: () => ({ enabled: true, backend: "inert", running: 0, cap: 3, state: "idle" }),
    ask: async () => ({ text: "Private assistant answer" }), forget() {} };
  await r.restartHttp();
  const room = (await r.call(admin, "POST", "/hub/v1/rooms", { name: "Assistant room", assistant: true })).json.room.id;
  expect((await r.call(admin, "POST", `/hub/v1/rooms/${room}/messages`, { text: "Summarize", mentions: ["assistant"], idempotencyKey: randomUUID() })).status).toBe(200);
  await vi.waitFor(() => expect(r!.db.prepare("SELECT state FROM hub_room_assistant_calls").get()).toEqual({ state: "answered" }));
  const view = (await r.call(admin, "GET", path)).json;
  expect(view.questions).toMatchObject({ asked: 0, waiting: 0 }); expect(view.topAgents).toEqual([]);
  expect(view.rooms).toMatchObject({ agentQuestions: 0, messages: 2, byAuthor: { people: 1, agents: 0, assistant: 1 } });
});

it("uses active Fleets and the existing live/version view, hiding revoked publications from the shared total", async () => {
  r = await s3bRig(); const admin = await r.signIn("admin"), ids = Array.from({ length: 4 }, () => randomUUID());
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push(...ids.map((id, index) => ({ id, owner: r!.admin, generation: 1,
      credentialHash: index === 3 ? null : "a".repeat(64), status: index === 3 ? "revoked" as const : "active" as const })));
  });
  const modern = r.link(ids[0]!, r.admin, 1, ["welcome-caps-v1", "room-ask-v1", "fleet-info-v1"]);
  r.http.memberConnected!(modern);
  await r.http.receive(r.frame("fleet.info", { version: "2.4.0", runsAsService: true }, modern) as never, modern);
  r.http.memberConnected!(r.link(ids[1]!, r.admin, 1, []));
  const person = personKeyString(r.admin);
  for (const id of [ids[0]!, ids[3]!]) r.db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Shared',1,'published','agent','[]','digest',0)").run(randomUUID(), id, person);
  const view = (await r.call(admin, "GET", path)).json;
  expect(view.fleets).toEqual({ total: 3, connected: 2, needsUpdate: 0, tooOldRooms: 1, unknownVersion: 1, recommendedVersion: null });
  expect(view.sharedAgents).toBe(1);
});

it("keeps a direct answer time unchanged after a later receipt and exact answer replay", async () => {
  let now = Date.parse("2026-11-15T08:00:00Z");
  r = await s3bRig({ now: () => now, realAudit: true }); r.addPerson("asker");
  const admin = await r.signIn("admin"), asker = await r.signIn("asker"), fleetId = randomUUID(), exposureId = randomUUID();
  const link = r.link(fleetId, r.admin);
  const exposure: HubExposure = { id: exposureId, fleetId, owner: r.admin, displayName: "Agent", revision: 1, state: "published", dataViewId: "a", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
  const grant = (await r.call(admin, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 1 })).json.grant;
  const room = (await r.call(asker, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.id })).json.room.id;
  const messageId = (await r.call(asker, "POST", `/hub/v1/rooms/${room}/messages`, { text: "Question", idempotencyKey: randomUUID() })).json.receipt.messageId;
  const digest = (text: string) => createHash("sha256").update(text).digest("hex"), answerId = randomUUID(), text = "Answer";
  const authorized = await r.http.receive(r.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1,
    phase: "release-answer", answer: { answerId, contentDigest: digest(text) } }, link) as never, link) as any;
  expect(authorized.payload.ok).toBe(true); now += 1500;
  const answer = { messageId, answerId, text, contentDigest: digest(text), releaseLease: authorized.payload.lease };
  r.setAuditFails(true, "answer.accepted");
  await expect(r.http.receive(r.frame("answer", answer, link) as never, link)).rejects.toThrow();
  expect(r.db.prepare("SELECT answered_at FROM hub_messages WHERE id=?").get(messageId)).toEqual({ answered_at: null });
  r.setAuditFails(false);
  await r.http.receive(r.frame("answer", answer, link) as never, link);
  const recorded = now; now += 1000;
  await r.http.receive(r.frame("receipt", { messageId, contentDigest: digest("Question"), stage: "answered", sequence: 1, at: now }, link) as never, link);
  await r.http.receive(r.frame("answer", answer, link) as never, link);
  expect(r.db.prepare("SELECT answered_at,stage_at FROM hub_messages WHERE id=?").get(messageId)).toEqual({ answered_at: recorded, stage_at: now });
});
