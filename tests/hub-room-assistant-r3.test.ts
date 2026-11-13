import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig(); const alex = r.addPerson("alex", "Alex"), admin = await r.signIn("admin"), a = await r.signIn("alex");
  const calls: any[] = [], forgotten: string[] = []; let enabled = true;
  r.httpDeps.roomAssistant = { available: () => ({ enabled, backend: "inert", running: 0, cap: 3, state: enabled ? "idle" : "paused" }),
    ask: async input => { calls.push(input); return { text: "Assistant reply" }; }, forget: id => { forgotten.push(id); } };
  await r.restartHttp(); return { admin, a, alex, calls, forgotten, off: () => { enabled = false; } };
}
it("gives each person one private Hub-assistant row and answers a plain direct message", async () => {
  const w = await world(), list = await r!.call(w.a, "GET", "/hub/v1/rooms?v=2");
  const row = list.json.rooms.find((x: any) => x.assistant); expect(row).toMatchObject({ kind: "direct", people: 1, agents: 0, presence: "idle" });
  expect((await r!.call(w.a, "GET", "/hub/v1/rooms?v=2")).json.rooms.find((x: any) => x.assistant).id).toBe(row.id);
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${row.id}`)).status).toBe(403);
  const posted = await r!.call(w.a, "POST", `/hub/v1/rooms/${row.id}/messages`, { text: "Hello", mentions: [], idempotencyKey: randomUUID() }); expect(posted.status).toBe(200);
  await vi.waitFor(() => expect(w.calls).toHaveLength(1));
  await vi.waitFor(async () => expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${row.id}/messages`)).json.messages.some((m: any) => m.text === "Assistant reply" && m.answerTo === posted.json.id)).toBe(true));
});
it("uses @assistant in a group, and stores the message with a soft warning when unavailable", async () => {
  const w = await world(), made = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "With assistant", people: [personKeyString(w.alex)], assistant: true });
  expect(made.status).toBe(200); const id = made.json.room.id;
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "People only", mentions: [], idempotencyKey: randomUUID() })).status).toBe(200); expect(w.calls).toHaveLength(0);
  const post = await r!.call(w.a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "Summarize", mentions: ["assistant"], idempotencyKey: randomUUID() }); expect(post.status).toBe(200);
  await vi.waitFor(() => expect(w.calls).toHaveLength(1)); expect(w.calls[0]).toMatchObject({ roomId: id, asker: { name: "Alex" }, context: [{ text: "People only" }] });
  w.off();
  const held = await r!.call(w.a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "Keep this text", mentions: ["assistant"], idempotencyKey: randomUUID() });
  expect(held.status).toBe(200); expect(held.json.warning).toBe("assistant-unavailable");
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${id}/messages`)).text).toContain("Keep this text");
});

it("drops a held answer after assistant removal and does not revive it on re-add", async () => {
  const w = await world(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  r!.httpDeps.roomAssistant!.ask = async input => { w.calls.push(input); entered(); await held; return { text: "Retired assistant output" }; };
  const made = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Remove", people: [personKeyString(w.alex)], assistant: true }); const id = made.json.room.id;
  await r!.call(w.a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "Wait", mentions: ["assistant"], idempotencyKey: randomUUID() }); await started;
  try {
    expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${id}`, { assistant: false })).status).toBe(200);
    await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${id}`, { assistant: true });
  } finally { release(); }
  await vi.waitFor(() => expect(r!.db.prepare("SELECT state FROM hub_room_assistant_calls").get()).toEqual({ state: "failed" }));
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${id}/messages`)).text).not.toContain("Retired assistant output"); expect(w.calls).toHaveLength(1); expect(w.forgotten).toContain(id);
});

it("does not repeat an uncertain external input after the HTTP mount restarts", async () => {
  const w = await world(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  r!.httpDeps.roomAssistant!.ask = async input => { w.calls.push(input); entered(); await held; return { text: "Old mount output" }; };
  const list = await r!.call(w.a, "GET", "/hub/v1/rooms?v=2"), id = list.json.rooms.find((x: any) => x.assistant).id;
  await r!.call(w.a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "Once", mentions: [], idempotencyKey: randomUUID() }); await started;
  await r!.restartHttp(); release();
  expect(r!.db.prepare("SELECT state,reason FROM hub_room_assistant_calls").get()).toEqual({ state: "failed", reason: "interrupted" });
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${id}/messages`)).text).not.toContain("Old mount output"); expect(w.calls).toHaveLength(1);
});

it("stops the active call and queued room inputs before the admin stop response", async () => {
  const w = await world(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  r!.httpDeps.roomAssistant!.ask = async input => { w.calls.push(input); entered(); await held; return { text: "Stopped output" }; };
  r!.httpDeps.assistantAdmin = { settings: async () => ({}), configure: async () => ({}), usage: async () => ({}), stopRoom: async () => { release(); } };
  await r!.restartHttp();
  const list = await r!.call(w.a, "GET", "/hub/v1/rooms?v=2"), id = list.json.rooms.find((x: any) => x.assistant).id;
  const post = (text: string) => r!.call(w.a, "POST", `/hub/v1/rooms/${id}/messages`, { text, mentions: [], idempotencyKey: randomUUID() });
  await post("First"); await started; await post("Second");
  try { expect((await r!.call(w.admin, "POST", `/hub/v1/admin/assistant/rooms/${id}/stop`, {})).status).toBe(200); }
  finally { release(); }
  await vi.waitFor(() => expect(r!.db.prepare("SELECT state FROM hub_room_assistant_calls ORDER BY rowid").all()).toEqual([{ state: "failed" }, { state: "failed" }]));
  expect(w.calls).toHaveLength(1); expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${id}/messages`)).text).not.toContain("Stopped output");
});
