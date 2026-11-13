/** R2 production HTTP/SQLite queue with owned inert member links; never starts an agent. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const caps = ["welcome-caps-v1", "room-ask-v1"];
async function world() {
  let at = Date.now(); r = await s3bRig({ now: () => at });
  const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
  const e: HubExposure = { id: randomUUID(), fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex)] });
  expect(made.status).toBe(200); const id = made.json.room.id as string;
  const add = await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: e.id });
  expect(add.status).toBe(200);
  return { admin, a, alex, fleetId, link, e, id, advance: (n: number) => { at += n; } };
}
async function send(w: Awaited<ReturnType<typeof world>>, text = "Status?", mentions = [w.e.id]) {
  const result = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text, mentions, idempotencyKey: randomUUID() });
  expect(result.status).toBe(200); return result.json;
}
const asks = () => r!.sent.filter(s => s.frame.type === "room.ask");
const lastAsk = () => asks().at(-1)!.frame.payload as HubRoomAsk;
async function reconnect(w: Awaited<ReturnType<typeof world>>, epoch: number) {
  w.link.alive = false; const link = r!.link(w.fleetId, r!.admin, epoch, caps);
  await r!.http.receive(r!.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, link) as never, link); return link;
}

it("adds only an owner's own published agent directly and projects portable presence", async () => {
  const w = await world(), detail = (await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json;
  expect(detail.members.find((m: any) => m.kind === "agent")).toMatchObject({ id: w.e.id, name: "Notes", owner: { name: "Hub Admin" }, presence: "idle" });
  await r!.http.receive(r!.frame("agent.state", { exposureId: w.e.id, state: "paused", reason: "auth" }, w.link) as never, w.link);
  const held = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json.members.find((m: any) => m.id === w.e.id);
  expect(held).toMatchObject({ presence: "paused", presenceReason: "auth" }); expect(held.presenceNote).toBeUndefined();
  const other = await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "agent", id: randomUUID() }); expect(other.status).toBe(404);
});

it("routes @all plus the same explicit agent once and retains exact delivery bytes on reconnect", async () => {
  const w = await world(), post = await send(w, "Status?", ["all", w.e.id]);
  await vi.waitFor(() => expect(asks()).toHaveLength(1));
  expect(post.ask).toEqual({ total: 1, answered: 0, working: 0, later: 1 });
  const input = lastAsk(); expect(input).toMatchObject({ roomId: w.id, exposureId: w.e.id, text: "Status?", asker: { name: "Alex" } });
  expect(input.messageId).not.toBe(post.id);
  await reconnect(w, 2); await vi.waitFor(() => expect(asks()).toHaveLength(2)); expect(lastAsk()).toEqual(input);
});

it("persists one exact answer and ACKs retries without duplicate room posts", async () => {
  const w = await world(), parent = await send(w); await vi.waitFor(() => expect(asks()).toHaveLength(1));
  const input = lastAsk(), answer = { messageId: input.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "Ready" };
  const receive = () => r!.http.receive(r!.frame("room.answer", answer, w.link) as never, w.link);
  expect(await receive()).toMatchObject({ type: "room.answer-ack", payload: { messageId: input.messageId, answerId: answer.answerId } });
  expect(await receive()).toMatchObject({ type: "room.answer-ack" });
  const page = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages;
  expect(page.filter((m: any) => m.text === "Ready")).toHaveLength(1);
  expect(page.find((m: any) => m.text === "Ready")).toMatchObject({ answerTo: parent.id, stage: "answered" });
  expect(page.find((m: any) => m.id === parent.id).ask).toEqual({ total: 1, answered: 1, working: 0, later: 0 });
  await expect(r!.http.receive(r!.frame("room.answer", { ...answer, text: "Changed" }, w.link) as never, w.link)).rejects.toThrow();
});

it("keeps paused membership and queues until Resume, but removal retires queued consent", async () => {
  const w = await world(); r!.db.prepare("UPDATE hub_exposures SET sharing_paused=1,sharing_epoch=1 WHERE id=?").run(w.e.id);
  await send(w); await new Promise(resolve => setTimeout(resolve, 30)); expect(asks()).toHaveLength(0);
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=0,sharing_epoch=2 WHERE id=?").run(w.e.id);
  await reconnect(w, 2); await vi.waitFor(() => expect(asks()).toHaveLength(1));
  r!.setTransport(false); await send(w, "Second");
  expect((await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${w.e.id}`)).status).toBe(200);
  r!.setTransport(true); await reconnect(w, 3); await new Promise(resolve => setTimeout(resolve, 30)); expect(asks()).toHaveLength(1);
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.some((m: any) => m.stage === "not-answered")).toBe(true);
});

it("expires an offline ask at 24 hours without delivery", async () => {
  const w = await world(); r!.setTransport(false); await send(w); w.advance(24 * 60 * 60_000);
  r!.setTransport(true); await reconnect(w, 2); await new Promise(resolve => setTimeout(resolve, 30)); expect(asks()).toHaveLength(0);
  const fresh = await r!.signIn("alex");
  expect((await r!.call(fresh, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.some((m: any) => m.stage === "not-answered")).toBe(true);
});

it("keeps the latest 30 context rows plus one older replied-to anchor, oldest first", async () => {
  const w = await world(), anchor = await send(w, "Anchor", []);
  for (let n = 0; n < 31; n++) await send(w, `Line ${n}`, []);
  const result = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "Reply", mentions: [w.e.id], replyTo: anchor.id, idempotencyKey: randomUUID() });
  expect(result.status).toBe(200); await vi.waitFor(() => expect(asks()).toHaveLength(1));
  expect(lastAsk().context).toHaveLength(31); expect(lastAsk().context[0]).toMatchObject({ text: "Anchor", repliedTo: true });
  expect(lastAsk().context.at(-1)?.text).toBe("Line 30");
});

it("counts a late agent answer as unread even for its owner after reading the pending question", async () => {
  const w = await world(), parent = await send(w); await vi.waitFor(() => expect(asks()).toHaveLength(1));
  await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/read`, { upTo: parent.id });
  const input = lastAsk(); await r!.http.receive(r!.frame("room.answer", { messageId: input.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "Late" }, w.link) as never, w.link);
  expect((await r!.call(w.admin, "GET", "/hub/v1/rooms?v=2")).json.rooms[0].unread).toBe(1);
});

it("keeps a person's @ reminder separate from agent routing", async () => {
  const w = await world(), detail = (await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json;
  const me = detail.me.id; await send(w, "For you", [me]);
  expect(asks()).toHaveLength(0);
  expect((await r!.call(w.admin, "GET", "/hub/v1/rooms?v=2")).json.rooms[0]).toMatchObject({ unread: 1, mentioned: true });
});

it("makes an already-dispatched answer terminal without disclosure after consent is removed", async () => {
  const w = await world(); await send(w); await vi.waitFor(() => expect(asks()).toHaveLength(1));
  const input = lastAsk(); await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${w.e.id}`);
  const answer = { messageId: input.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "Retired answer" };
  expect(await r!.http.receive(r!.frame("room.answer", answer, w.link) as never, w.link)).toMatchObject({ type: "room.answer-ack" });
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).text).not.toContain(answer.text);
});

it("persists dispatch intent before a fast member answer arrives during socket send", async () => {
  const w = await world(), original = r!.httpDeps.transport;
  r!.httpDeps.transport = () => ({ ...original()!, send: async (fleetId, frame) => {
    await original()!.send(fleetId, frame);
    if (frame.type === "room.ask") await r!.http.receive(r!.frame("room.answer", { messageId: frame.payload.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "Fast" }, w.link) as never, w.link);
  } });
  await send(w);
  await vi.waitFor(() => expect((r!.db.prepare("SELECT state FROM hub_room_deliveries").get() as any).state).toBe("answered"));
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).text).toContain("Fast");
});

it("keeps message idempotency and required-audit rollback across its per-agent queue", async () => {
  const w = await world(); r!.setTransport(false);
  const input = { text: "Once", mentions: [w.e.id], idempotencyKey: randomUUID() };
  const post = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, input);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, input)).json.id).toBe(post.json.id);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries").get()).toEqual({ n: 1 });
  expect(JSON.stringify(r!.db.prepare("SELECT * FROM hub_room_deliveries").all())).not.toContain(input.text);
  r!.setAuditFails(true, "room.message");
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { ...input, text: "Rollback", idempotencyKey: randomUUID() })).status).toBe(500);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries").get()).toEqual({ n: 1 });
});

it("does not revive a queued ask when its asker leaves and rejoins", async () => {
  const w = await world(); r!.setTransport(false); await send(w);
  const detail = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json;
  await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${detail.me.id}`);
  await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "person", id: personKeyString(w.alex) });
  r!.setTransport(true); await reconnect(w, 2);
  await vi.waitFor(() => expect(r!.db.prepare("SELECT state FROM hub_room_deliveries").get()).toEqual({ state: "retired" }));
  expect(asks()).toHaveLength(0);
});

it("keeps a paused answer retained until a fresh resumed publication allows disclosure", async () => {
  const w = await world(); await send(w); await vi.waitFor(() => expect(asks()).toHaveLength(1));
  const input = lastAsk(), answer = { messageId: input.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "After resume" };
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=1,sharing_epoch=1 WHERE id=?").run(w.e.id);
  expect(await r!.http.receive(r!.frame("room.answer", answer, w.link) as never, w.link)).toBeUndefined(); // held, no ACK and no broken link
  expect(r!.db.prepare("SELECT answer_id FROM hub_room_deliveries").get()).toEqual({ answer_id: null });
  r!.db.prepare("UPDATE hub_exposures SET sharing_paused=0,sharing_epoch=2 WHERE id=?").run(w.e.id);
  expect(await r!.http.receive(r!.frame("room.answer", answer, w.link) as never, w.link)).toMatchObject({ type: "room.answer-ack" });
});

it("refuses adding another owner's agent without the invitation seam", async () => {
  const w = await world(), other = r!.addPerson("owner", "Other owner"), link = r!.link(randomUUID(), other, 1, caps);
  const e = { ...w.e, id: randomUUID(), fleetId: link.fleetId, owner: other };
  await r!.http.receive(r!.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  expect((await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "agent", id: e.id })).status).toBe(403);
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json.members.filter((m: any) => m.kind === "agent")).toHaveLength(1);
});
