import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubRoomsService } from "../src/hub/rooms.js";
import { HubPolicyService } from "../src/hub/policy.js";
import { HubSessions } from "../src/hub/sessions.js";
import { buttonsDigest } from "../src/hub/buttons-model.js";
import { messageContentDigest } from "../src/hub/identity.js";
import type { HubAnswerButtons, HubAttachmentRef } from "../src/hub/types.js";
import { directMessages } from "../src/hub/rooms/direct-view.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world(rich = false) {
  r = await s3bRig(rich ? { attachments: true, realAudit: true } : undefined); const owner = r.addPerson("owner", "Owner"); r.addPerson("alex", "Alex"); r.addPerson("other", "Other");
  const fleetId = randomUUID(), exposureId = randomUUID(), link = r.link(fleetId, owner);
  if (rich) for (const feature of ["attachments-v1", "buttons-v1", "direct-posts-v1", "welcome-caps-v1", "room-ask-v1", "room-post-v1"]) (link.features as Set<string>).add(feature);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner, displayName: "Synthetic", revision: 1, state: "published", dataViewId: "v", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const o = await r.signIn("owner"), a = await r.signIn("alex"), other = await r.signIn("other");
  const grant = await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "alex", days: 7 });
  const opened = await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.json.grant.id }); expect(opened.status).toBe(200);
  const roomId = opened.json.room.id, core = new HubCore(r.httpDeps, r.sql), sessions = new HubSessions(core), service = new HubRoomsService(core, new HubPolicyService(core));
  const context = (cookie: string) => sessions.context({ headers: { cookie } } as IncomingMessage);
  const ctx = context(a.cookie), session = sessions.session(ctx.token)!;
  const ask = async (text: string) => { const out = await r!.call(a, "POST", `/hub/v1/rooms/${roomId}/messages`, { text, idempotencyKey: randomUUID() }); expect(out.status).toBe(200); return out.json.id as string; };
  const answer = async (id: string, text: string, buttons?: HubAnswerButtons, attachments?: HubAttachmentRef[]) => {
    const answerId = randomUUID(), contentDigest = messageContentDigest("answer", text, { ...(buttons ? { buttonsDigest: buttonsDigest(buttons) } : {}), attachments });
    const auth = await r!.http.receive(r!.frame("authorize.request", { messageId: id, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest } }, link) as never, link) as any;
    expect(auth.payload.ok).toBe(true);
    await r!.http.receive(r!.frame("answer", { messageId: id, answerId, text, contentDigest, ...(buttons ? { buttons } : {}), ...(attachments ? { attachments } : {}), releaseLease: auth.payload.lease }, link) as never, link);
  };
  return { o, a, other, link, grant: grant.json.grant, roomId, service, ctx, key: session.sessionId, context, ask, answer };
}
it("selects one direct event row and preserves every existing entry/message projection", async () => {
  const w = await world(); const queued = await w.ask("queued"), answered = await w.ask("answered"); await w.answer(answered, "exact final");
  const failed = await w.ask("declined"), expired = await w.ask("expired question"); await w.answer(expired, "retained answer");
  r!.db.prepare("UPDATE hub_messages SET stage='failed',reason_code='owner-declined' WHERE id=?").run(failed);
  const ref = (r!.db.prepare("SELECT question_ref FROM hub_messages WHERE id=?").get(expired) as { question_ref: string }).question_ref; r!.contents.delete(ref);
  const page = await w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100 });
  const messages = directMessages(page.room, page.entries, "Session-specific name"); expect(messages.length).toBeGreaterThanOrEqual(7);
  let checked = 0;
  for (const expected of messages) {
    const exact = await w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100, messageId: expected.id });
    expect(exact.entries.map(e => e.messageId)).toEqual([expected.id.replace(/:answer$/, "")]);
    expect(exact.entries[0]).toEqual(page.entries.find(e => e.messageId === expected.id.replace(/:answer$/, "")));
    expect(directMessages(exact.room, exact.entries, "Session-specific name").find(m => m.id === expected.id)).toEqual(expected); checked++;
  }
  expect(checked).toBe(messages.length); expect(new Set([queued, answered, failed, expired]).size).toBe(4);
});
it("does not disclose another room or another asker through an exact ID", async () => {
  const w = await world(), id = await w.ask("private");
  const grant = await r!.call(w.o, "POST", "/hub/v1/grants", { exposureId: w.grant.exposureId, exposureRevision: 1, login: "other", days: 7 });
  const otherRoom = await r!.call(w.other, "POST", "/hub/v1/rooms", { exposureId: w.grant.exposureId, grantId: grant.json.grant.id });
  expect(otherRoom.status).toBe(200);
  const otherMessage = await r!.call(w.other, "POST", `/hub/v1/rooms/${otherRoom.json.room.id}/messages`, { text: "another room", idempotencyKey: randomUUID() });
  expect(otherMessage.status).toBe(200);
  const scoped = await w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100, messageId: otherMessage.json.id }); expect(scoped.entries).toEqual([]);
  const none = await w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100, messageId: randomUUID() }); expect(none.entries).toEqual([]);
  await expect(w.service.readPage(w.context(w.other.cookie), w.roomId, 0, "other-session", { before: null, limit: 100, messageId: id })).rejects.toMatchObject({ code: "not-found" });
});
it("selects a visible old message outside the newest page without broadening room access", async () => {
  const w = await world(), id = await w.ask("visible old question");
  const old = r!.db.prepare("SELECT * FROM hub_messages WHERE id=?").get(id) as Record<string, unknown>;
  const columns = Object.keys(old); expect(columns.every(c => /^[a-z_]+$/.test(c))).toBe(true);
  const insert = r!.db.prepare(`INSERT INTO hub_messages(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
  for (let i = 0; i < 105; i++) { const copy = { ...old, id: randomUUID(), idempotency_key: randomUUID(), sequence: i + 2 }; insert.run(...columns.map(c => copy[c as keyof typeof copy])); }
  const newest = await w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100 });
  expect(newest.entries).toHaveLength(100); expect(newest.entries.some(e => e.messageId === id)).toBe(false);
  const exact = await w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100, messageId: id });
  expect(exact.entries.map(e => e.messageId)).toEqual([id]); expect(directMessages(exact.room, exact.entries, "Alex")[0]).toMatchObject({ id, text: "visible old question" });
});
it("retains fresh grant refusal on exact selection", async () => {
  const w = await world(), id = await w.ask("private");
  expect((await r!.call(w.o, "DELETE", `/hub/v1/grants/${w.grant.id}?revision=1`)).status).toBe(200);
  await expect(w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100, messageId: id })).rejects.toBeDefined();
});

it("keeps files, buttons, generated poll results and standalone agent posts identical to the shared page", async () => {
  const w = await world(true);
  const upload = await fetch(`${r!.base}/hub/v1/rooms/${w.roomId}/files`, { method: "POST", body: "question file", headers: { Origin: "https://hub.example.test", Cookie: w.a.cookie, "X-AgEnD-Hub-CSRF": w.a.csrf, "X-File-Name": "question.txt" } });
  expect(upload.status).toBe(200); const uploaded = await upload.json() as any;
  const asked = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/messages`, { text: "with files", files: [uploaded.file.id], idempotencyKey: randomUUID() }); expect(asked.status).toBe(200);
  const bytes = Buffer.from("answer file"), id = randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex"), file = { id, name: "answer.txt", size: bytes.length, mime: "text/plain", sha256 };
  await r!.http.receive(r!.frame("attachment.put", { id, offset: 0, total: bytes.length, sha256, data: bytes.toString("base64") }, w.link) as never, w.link);
  await w.answer(asked.json.id, "file answer", undefined, [file]);
  const pollQuestion = await w.ask("poll question"), buttons: HubAnswerButtons = { id: randomUUID().replaceAll("-", ""), labels: ["Yes", "No"], values: ["yes", "no"], poll: { seconds: 10, multi: false, reveal: "close", showVoters: true, question: "Pick" } };
  await w.answer(pollQuestion, "Choose", buttons);
  const voted = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.roomId}/buttons`, { setId: buttons.id, idempotencyKey: randomUUID(), options: [1] }); expect(voted.status).toBe(200);
  const posted = await r!.http.receive(r!.frame("room.post", { exposureId: w.grant.exposureId, room: w.roomId, text: "standalone", direct: true, idempotencyKey: randomUUID() }, w.link) as never, w.link) as any; expect(posted.payload.ok).toBe(true);
  const page = await w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100 });
  expect(page.entries.some(e => e.questionFiles?.length && e.answerFiles?.length)).toBe(true);
  expect(page.entries.some(e => e.buttons)).toBe(true); expect(page.entries.some(e => e.pollResult)).toBe(true); expect(page.entries.some(e => e.ownPost)).toBe(true);
  for (const expected of page.entries) {
    const exact = await w.service.readPage(w.ctx, w.roomId, 0, w.key, { before: null, limit: 100, messageId: expected.messageId });
    expect(exact.entries).toEqual([expected]);
    expect(directMessages(exact.room, exact.entries, "Alex")).toEqual(directMessages(page.room, [expected], "Alex"));
  }
});
