/** Real Track R HTTP/SQLite + Track A service/runner; the physical worker is an owned inert port. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { RoomAssistantService } from "../src/hub/assistant/service.js";
import type { RoomAssistantAsk, RoomAssistantConfig } from "../src/hub/assistant/types.js";
import { personKeyString } from "../src/hub/identity.js";

let rig: Awaited<ReturnType<typeof s3bRig>> | undefined;
let service: RoomAssistantService | undefined;
afterEach(async () => { await rig?.close(); await service?.close(); rig = undefined; service = undefined; });
const config: RoomAssistantConfig = { enabled: true, backend: "claude-code", account: null, cap: 3, idleMinutes: 15 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function world() {
  rig = await s3bRig(); const alex = rig.addPerson("alex", "Alex"), admin = await rig.signIn("admin"), a = await rig.signIn("alex");
  const calls: RoomAssistantAsk[] = [], starts: string[] = [], stops: string[] = [];
  let answer = async (_input: RoomAssistantAsk) => ({ text: "From the real A service" }), stop = async () => {};
  service = new RoomAssistantService({
    host: { start: async input => { starts.push(input.roomId); return {
      ask: async request => { calls.push(request); return answer(request); }, stop: async () => { stops.push(input.roomId); await stop(); },
    }; } },
    store: { load: async () => null, save: async () => {} },
    backends: () => [{ id: "claude-code", name: "Claude", accounts: [{ id: null, name: "Default", state: "signed-in" }] }],
  });
  await service.settings();
  rig.httpDeps.roomAssistant = service; rig.httpDeps.assistantAdmin = service; await rig.restartHttp();
  return { alex, admin, a, calls, starts, stops, answer: (value: typeof answer) => { answer = value; }, stop: (value: typeof stop) => { stop = value; } };
}
const post = (actor: Awaited<ReturnType<typeof world>>["a"], id: string, text: string, mentions: string[] = []) => rig!.call(actor, "POST", `/hub/v1/rooms/${id}/messages`, { text, mentions, idempotencyKey: randomUUID() });

it("uses one real service for admin settings and private plain-message answers, and preserves a disabled soft warning", async () => {
  const w = await world();
  const before = await rig!.call(w.admin, "GET", "/hub/v1/admin/assistant");
  expect(before.json).toMatchObject({ ...config, enabled: false, running: [] }); expect(w.starts).toEqual([]);
  expect((await rig!.call(w.a, "PUT", "/hub/v1/admin/assistant", config)).status).toBe(403);
  expect((await rig!.call(w.admin, "PUT", "/hub/v1/admin/assistant", config)).status).toBe(200);
  const list = await rig!.call(w.a, "GET", "/hub/v1/rooms?v=2"), room = list.json.rooms.find((r: any) => r.assistant);
  expect(room).toMatchObject({ kind: "direct", assistant: true, presence: "idle" });
  const sent = await post(w.a, room.id, "Please answer without an at-mention"); expect(sent.status).toBe(200);
  await vi.waitFor(async () => expect((await rig!.call(w.a, "GET", `/hub/v1/rooms/${room.id}/messages`)).json.messages).toContainEqual(expect.objectContaining({ text: "From the real A service", answerTo: sent.json.id, stage: "answered" })));
  expect(w.calls).toHaveLength(1); expect(w.calls[0]).toMatchObject({ roomId: room.id, asker: { name: "Alex" }, text: "Please answer without an at-mention" });
  const usage = await rig!.call(w.admin, "GET", "/hub/v1/admin/assistant/usage"); expect(usage.json.days.reduce((sum: number, row: any) => sum + row.count, 0)).toBe(1);
  expect((await rig!.call(w.admin, "PUT", "/hub/v1/admin/assistant", { ...config, enabled: false })).status).toBe(200);
  const off = await post(w.a, room.id, "Keep this even while the assistant is off");
  expect(off.status).toBe(200); expect(off.json.warning).toBe("assistant-unavailable"); expect(w.calls).toHaveLength(1);
});

it("routes group at-assistant context through A and admin Stop waits for physical drain while cancelling queued inputs", async () => {
  const w = await world(); await rig!.call(w.admin, "PUT", "/hub/v1/admin/assistant", config);
  const made = await rig!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Integration", people: [personKeyString(w.alex)], assistant: true }), roomId = made.json.room.id;
  await post(w.a, roomId, "Context only"); expect(w.calls).toHaveLength(0);
  const output = deferred<{ text: string }>(), enteredStop = deferred<void>(), physicalStop = deferred<void>();
  w.answer(async () => output.promise); w.stop(async () => { enteredStop.resolve(); await physicalStop.promise; });
  await post(w.a, roomId, "Work", ["assistant"]); await vi.waitFor(() => expect(w.calls).toHaveLength(1));
  expect(w.calls[0]!.context).toEqual([expect.objectContaining({ author: "Alex", text: "Context only" })]);
  await post(w.a, roomId, "Queued", ["assistant"]);
  let completed = false; const stopped = rig!.call(w.admin, "POST", `/hub/v1/admin/assistant/rooms/${roomId}/stop`, {}).then(value => { completed = true; return value; });
  try {
    await enteredStop.promise; expect(completed).toBe(false);
    expect(rig!.db.prepare("SELECT state FROM hub_room_assistant_calls ORDER BY rowid").all()).toEqual([{ state: "failed" }, { state: "failed" }]);
  } finally { physicalStop.resolve(); output.resolve({ text: "Late stopped result" }); }
  expect((await stopped).status).toBe(200); expect(w.calls).toHaveLength(1);
  expect((await rig!.call(w.a, "GET", `/hub/v1/rooms/${roomId}/messages`)).text).not.toContain("Late stopped result");
  expect(w.stops).toEqual([roomId]);
});
