import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });
it("answers a private room through the real bound encrypted audit content store", async () => {
  rig = await s3bRig({ realAudit: true }); rig.addPerson("carol", "Carol");
  const ask = vi.fn(async (_input: unknown) => ({ text: "Bound assistant answer" }));
  rig.httpDeps.roomAssistant = { available: () => ({ enabled: true, backend: "inert", running: 0, cap: 3, state: "idle" }), ask, forget() {} };
  await rig.restartHttp(); const user = await rig.signIn("carol");
  const list = await rig.call(user, "GET", "/hub/v1/rooms?v=2"), room = list.json.rooms.find((r: any) => r.assistant).id;
  const post = await rig.call(user, "POST", `/hub/v1/rooms/${room}/messages`, { text: "Please summarize this room", mentions: [], idempotencyKey: randomUUID() });
  expect(post.status).toBe(200);
  await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
  expect(ask.mock.calls[0]?.[0]).toMatchObject({ text: "Please summarize this room", roomId: room });
  await vi.waitFor(() => expect(rig!.db.prepare("SELECT state FROM hub_room_assistant_calls").get()).toEqual({ state: "answered" }));
  const messages = await rig.call(user, "GET", `/hub/v1/rooms/${room}/messages`);
  expect(messages.json.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Bound assistant answer", stage: "answered", answerTo: post.json.id })]));
  const bindings = rig.db.prepare("SELECT a.action FROM hub_audit a JOIN hub_audit_content c ON c.record_id=a.id WHERE a.action LIKE 'room.assistant-%' ORDER BY a.sequence").all();
  expect(bindings).toEqual([{ action: "room.assistant-queued" }, { action: "room.assistant-answer" }]);
});
it.each(["payload-read", "worker"])("logs a bounded %s reason without room text or raw exceptions", async phase => {
  rig = await s3bRig({ realAudit: true }); rig.addPerson("carol", "Carol");
  const log = vi.fn(), ask = vi.fn(async () => { throw new Error("RAW_VENDOR_ERROR_DO_NOT_LOG"); });
  rig.httpDeps.log = log;
  rig.httpDeps.roomAssistant = { available: () => ({ enabled: true, backend: "inert", running: 0, cap: 3, state: "idle" }), ask, forget() {} };
  if (phase === "payload-read") {
    const read = rig.httpDeps.content.get.bind(rig.httpDeps.content);
    rig.httpDeps.content.get = ref => { const payload = read(ref); return payload?.question?.startsWith('{"roomId":') ? undefined : payload; };
  }
  await rig.restartHttp(); const user = await rig.signIn("carol");
  const list = await rig.call(user, "GET", "/hub/v1/rooms?v=2"), room = list.json.rooms.find((r: any) => r.assistant).id;
  const post = await rig.call(user, "POST", `/hub/v1/rooms/${room}/messages`, { text: "PRIVATE_ROOM_TEXT_DO_NOT_LOG", mentions: [], idempotencyKey: randomUUID() });
  expect(post.status).toBe(200);
  await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
  expect(log).toHaveBeenCalledWith("warn", "Hub room assistant could not answer", { roomId: room, requestId: expect.any(String), phase, ...(phase === "payload-read" ? { code: "uncertain" } : {}) });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE_ROOM_TEXT|RAW_VENDOR_ERROR/);
  expect(rig.db.prepare("SELECT state,reason FROM hub_room_assistant_calls").get()).toEqual({ state: "failed", reason: "unavailable" });
  expect(ask).toHaveBeenCalledTimes(phase === "payload-read" ? 0 : 1);
});
it("rolls back input and dispatch together if binding the queued audit fails", async () => {
  rig = await s3bRig({ realAudit: true }); rig.addPerson("carol", "Carol");
  const ask = vi.fn(async () => ({ text: "Must not run" }));
  rig.httpDeps.roomAssistant = { available: () => ({ enabled: true, backend: "inert", running: 0, cap: 3, state: "idle" }), ask, forget() {} };
  await rig.restartHttp(); const user = await rig.signIn("carol");
  const list = await rig.call(user, "GET", "/hub/v1/rooms?v=2"), room = list.json.rooms.find((r: any) => r.assistant).id;
  rig.setAuditFails(true, "room.assistant-queued");
  const post = await rig.call(user, "POST", `/hub/v1/rooms/${room}/messages`, { text: "Must roll back", mentions: [], idempotencyKey: randomUUID() });
  expect(post.status).toBe(500);
  expect(rig.db.prepare("SELECT COUNT(*) n FROM hub_room_posts").get()).toEqual({ n: 0 });
  expect(rig.db.prepare("SELECT COUNT(*) n FROM hub_room_assistant_calls").get()).toEqual({ n: 0 });
  expect(rig.db.prepare("SELECT COUNT(*) n FROM hub_audit_content").get()).toEqual({ n: 0 });
  expect(ask).not.toHaveBeenCalled();
});
