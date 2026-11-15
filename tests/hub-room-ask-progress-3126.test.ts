/** M-3126: optional ask.failed / ask.blocked / ask.reason on the room projection. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const caps = ["welcome-caps-v1", "room-ask-v1"];

async function world(opts: { assistant?: boolean; second?: boolean } = {}) {
  let at = Date.now(), enabled = true;
  r = await s3bRig({ now: () => at, realAudit: true });
  r.httpDeps.roomAssistant = { available: () => ({ enabled, backend: "inert", running: 0, cap: 3, state: enabled ? "idle" : "paused" }),
    ask: async () => ({ text: "Assistant reply" }), forget() {} };
  if (opts.assistant) await r.restartHttp();
  const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
  const exposure = (name: string): HubExposure => ({ id: randomUUID(), fleetId, owner: r!.admin, displayName: name, revision: 1, state: "published",
    dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  const e = exposure("Notes"), extra = opts.second ? exposure("Planner") : undefined;
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: extra ? [e, extra] : [e] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex)], assistant: opts.assistant === true });
  expect(made.status).toBe(200); const id = made.json.room.id as string;
  expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: e.id })).status).toBe(200);
  if (extra) expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: extra.id })).status).toBe(200);
  return { admin, a, alex, fleetId, link, e, extra, id, advance: (n: number) => { at += n; }, off: () => { enabled = false; } };
}
async function send(w: Awaited<ReturnType<typeof world>>, text = "Status?", mentions = [w.e.id]) {
  const result = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text, mentions, idempotencyKey: randomUUID() });
  expect(result.status).toBe(200); return result.json;
}
const parentAsk = async (w: Awaited<ReturnType<typeof world>>, parentId: string) =>
  (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.find((m: any) => m.id === parentId).ask;
const asks = () => r!.sent.filter(s => s.frame.type === "room.ask");

it("keeps queued/sent/answered and omits zero failed/blocked for older clients", async () => {
  const w = await world(), post = await send(w);
  expect(post.ask).toEqual({ total: 1, answered: 0, working: 0, later: 1 });
  expect(post.ask.failed).toBeUndefined(); expect(post.ask.blocked).toBeUndefined(); expect(post.ask.reason).toBeUndefined();
  await vi.waitFor(() => expect(asks()).toHaveLength(1));
  const input = asks()[0]!.frame.payload as HubRoomAsk;
  await r!.http.receive(r!.frame("room.answer", { messageId: input.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "Ready" }, w.link) as never, w.link);
  expect(await parentAsk(w, post.id)).toEqual({ total: 1, answered: 1, working: 0, later: 0 });
});

it("projects a single expired delivery as failed with reason expired", async () => {
  const w = await world(); r!.setTransport(false); const post = await send(w); w.advance(24 * 60 * 60_000);
  r!.setTransport(true); w.link.alive = false;
  const link = r!.link(w.fleetId, r!.admin, 2, caps);
  await r!.http.receive(r!.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, link) as never, link);
  const fresh = await r!.signIn("alex");
  await vi.waitFor(async () => expect((await r!.call(fresh, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.find((m: any) => m.id === post.id).ask)
    .toMatchObject({ failed: 1, reason: "expired" }));
  expect((await r!.call(fresh, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.find((m: any) => m.id === post.id).ask)
    .toEqual({ total: 1, answered: 0, working: 0, later: 0, failed: 1, reason: "expired" });
});

it("projects a single retired delivery as blocked with reason retired", async () => {
  const w = await world(); r!.setTransport(false); const post = await send(w);
  const detail = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json;
  await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${detail.me.id}`);
  await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "person", id: personKeyString(w.alex) });
  r!.setTransport(true); w.link.alive = false;
  const link = r!.link(w.fleetId, r!.admin, 2, caps);
  await r!.http.receive(r!.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, link) as never, link);
  await vi.waitFor(() => expect(r!.db.prepare("SELECT state FROM hub_room_deliveries").get()).toEqual({ state: "retired" }));
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.find((m: any) => m.id === post.id).ask)
    .toEqual({ total: 1, answered: 0, working: 0, later: 0, blocked: 1, reason: "retired" });
});

it("omits reason when more than one delivery settled as a miss", async () => {
  const w = await world({ second: true }); r!.setTransport(false);
  const post = await send(w, "Both", [w.e.id, w.extra!.id]);
  expect(post.ask).toEqual({ total: 2, answered: 0, working: 0, later: 2 });
  r!.db.prepare("UPDATE hub_room_deliveries SET state='expired' WHERE exposure_id=?").run(w.e.id);
  r!.db.prepare("UPDATE hub_room_deliveries SET state='retired' WHERE exposure_id=?").run(w.extra!.id);
  expect(await parentAsk(w, post.id)).toEqual({ total: 2, answered: 0, working: 0, later: 0, failed: 1, blocked: 1 });
});

it("projects an unavailable assistant as failed with its retained reason", async () => {
  const w = await world({ assistant: true }); w.off();
  const post = await send(w, "Summarize", ["assistant"]);
  expect(post.warning).toBe("assistant-unavailable");
  expect(post.ask).toEqual({ total: 1, answered: 0, working: 0, later: 0, failed: 1, reason: "unavailable" });
});

it("projects an interrupted assistant as failed with interrupted, never raw exception text", async () => {
  const w = await world({ assistant: true });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  r!.httpDeps.roomAssistant!.ask = async () => { entered(); await held; return { text: "Old mount" }; };
  const list = await r!.call(w.a, "GET", "/hub/v1/rooms?v=2"), direct = list.json.rooms.find((x: any) => x.assistant).id;
  const post = await r!.call(w.a, "POST", `/hub/v1/rooms/${direct}/messages`, { text: "Once", mentions: [], idempotencyKey: randomUUID() });
  await started; await r!.restartHttp(); release();
  expect(r!.db.prepare("SELECT state,reason FROM hub_room_assistant_calls").get()).toEqual({ state: "failed", reason: "interrupted" });
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${direct}/messages`)).json.messages.find((m: any) => m.id === post.json.id).ask)
    .toEqual({ total: 1, answered: 0, working: 0, later: 0, failed: 1, reason: "interrupted" });
  r!.db.prepare("UPDATE hub_room_assistant_calls SET reason=?").run("TypeError: boom at worker.js:12");
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${direct}/messages`)).json.messages.find((m: any) => m.id === post.json.id).ask.reason).toBe("unknown");
});

it("sums agent and assistant counts and keeps reason only for a combined total of one", async () => {
  const w = await world({ assistant: true }); r!.setTransport(false); w.off();
  const post = await send(w, "Both", [w.e.id, "assistant"]);
  expect(post.ask).toEqual({ total: 2, answered: 0, working: 0, later: 1, failed: 1 });
  expect("reason" in post.ask).toBe(false);
  w.advance(24 * 60 * 60_000);
  w.link.alive = false; r!.setTransport(true);
  const link = r!.link(w.fleetId, r!.admin, 2, caps);
  await r!.http.receive(r!.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, link) as never, link);
  const fresh = await r!.signIn("alex");
  await vi.waitFor(async () => expect((await r!.call(fresh, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.find((m: any) => m.id === post.id).ask.failed).toBe(2));
  expect((await r!.call(fresh, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.find((m: any) => m.id === post.id).ask)
    .toEqual({ total: 2, answered: 0, working: 0, later: 0, failed: 2 });
});
