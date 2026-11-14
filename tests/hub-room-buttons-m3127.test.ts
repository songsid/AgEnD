/** M-3127 B: an agent answer's buttons (its asker only) and poll (everyone in the room) — real HTTP + SQLite (S3b rig). */
import { afterEach, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const CAPS = ["welcome-caps-v1", "room-ask-v1", "room-answer-buttons-v1"];
async function world(caps = CAPS) {
  let at = Date.now(); r = await s3bRig({ now: () => at, realAudit: true });
  const alex = r.addPerson("alex", "Alex"), bob = r.addPerson("bob", "Bob"); r.addPerson("cara", "Cara");
  const [a, b, c, admin] = await Promise.all([r.signIn("alex"), r.signIn("bob"), r.signIn("cara"), r.signIn("admin")]);
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
  const e: HubExposure = { id: randomUUID(), fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex), personKeyString(bob)] });
  const id = made.json.room.id as string;
  expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: e.id })).status).toBe(200);
  const me = async (browser: typeof a) => (await r!.call(browser, "GET", `/hub/v1/rooms/${id}`)).json.me.id as string;
  return { a, b, c, admin, e, id, link, me, advance: (n: number) => { at += n; } };
}
type W = Awaited<ReturnType<typeof world>>;
const asks = () => r!.sent.filter(s => s.frame.type === "room.ask").map(s => s.frame.payload as HubRoomAsk);
/** Alex asks the agent; it answers with `buttons` → the answer's message. */
async function answered(w: W, buttons: Record<string, unknown>, text = "Pick one") {
  const before = asks().length;
  const q = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "Lunch?", mentions: [w.e.id], idempotencyKey: randomUUID() });
  await vi.waitFor(() => expect(asks().length).toBe(before + 1));
  const ask = asks().at(-1)!;
  const ack = await r!.http.receive(r!.frame("room.answer", { messageId: ask.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text, buttons }, w.link) as never, w.link);
  expect(ack).toMatchObject({ type: "room.answer-ack" });
  return (await page(w)).find((m: any) => m.answerTo === q.json.id);
}
const page = async (w: W, who: any = w.a) => (await r!.call(who, "GET", `/hub/v1/rooms/${w.id}/messages?limit=100`)).json.messages as any[];
const press = (w: W, who: any, body: Record<string, unknown>) => r!.call(who, "POST", `/hub/v1/rooms/${w.id}/buttons`, { idempotencyKey: randomUUID(), ...body });
const set = () => randomBytes(16).toString("hex");

it("plain buttons answer only their asker: the first press is the asker's own post, delivered to the agent as the click", async () => {
  const w = await world(), id = set(), alexId = await w.me(w.a);
  const answer = await answered(w, { id, labels: ["Yes", "No"], values: ["yes-go", "no-stop"] });
  expect(answer.buttons).toEqual({ id, labels: ["Yes", "No"], state: "open", asker: { id: alexId, name: "Alex" } });
  expect((await press(w, w.b, { setId: id, index: 0 })).json.code).toBe("not-asker");
  expect((await press(w, w.c, { setId: id, index: 0 })).json.code).toBe("not-member");
  const before = asks().length, key = randomUUID();
  expect((await press(w, w.a, { setId: id, index: 1, idempotencyKey: key })).json).toEqual({ ok: true });
  const after = await page(w, w.b), mine = after.find((m: any) => m.replyTo === answer.id);
  expect(mine).toMatchObject({ author: { kind: "person", name: "Alex" }, text: "No", mentions: [w.e.id] });
  expect(after.find((m: any) => m.id === answer.id).buttons).toMatchObject({ state: "chosen", chosen: 1, by: "Alex" });
  await vi.waitFor(() => expect(asks().length).toBe(before + 1));
  expect(asks().at(-1)!.text).toContain("No");
  expect(asks().at(-1)!.text).toContain("no-stop");   // the agent gets the click line (value), the room shows the label
  expect(asks().at(-1)!.asker).toEqual({ name: "Alex" });
  // The same press again (its key): no second post. Another press: the set is answered.
  expect((await press(w, w.a, { setId: id, index: 1, idempotencyKey: key })).status).toBe(200);
  expect((await press(w, w.a, { setId: id, index: 0 })).json.code).toBe("expired");
  expect((await page(w)).filter((m: any) => m.replyTo === answer.id)).toHaveLength(1);
  expect((await press(w, w.a, { setId: id, index: 0, idempotencyKey: key })).json.code).toBe("conflict");
});

it("refuses bad presses: unknown set, index out of range, options on buttons, extra keys", async () => {
  const w = await world(), id = set();
  await answered(w, { id, labels: ["A", "B"] });
  expect((await press(w, w.a, { setId: set(), index: 0 })).status).toBe(404);
  expect((await press(w, w.a, { setId: id, index: 2 })).status).toBe(400);
  expect((await press(w, w.a, { setId: id, options: [0] })).status).toBe(400);
  expect((await press(w, w.a, { setId: id, index: 0, extra: 1 })).status).toBe(400);
});

it("a poll takes one ballot per person until it closes; then a room line in its lineage and the results to the agent", async () => {
  const w = await world(), id = set();
  const poll = { seconds: 60, multi: false, reveal: "live", showVoters: true, question: "Pick one" };
  const answer = await answered(w, { id, labels: ["Noodles", "Rice"], poll });
  expect(answer.buttons).toMatchObject({ id, state: "open", poll: { answered: 0, multi: false, reveal: "live", counts: [0, 0] } });
  expect((await press(w, w.a, { setId: id, options: [0] })).status).toBe(200);
  expect((await press(w, w.b, { setId: id, options: [1] })).status).toBe(200);
  expect((await press(w, w.b, { setId: id, options: [0] })).status).toBe(200);   // a later vote replaces mine
  expect((await press(w, w.b, { setId: id, options: [0, 1] })).status).toBe(400); // single choice
  expect((await press(w, w.b, { setId: id, index: 0 })).status).toBe(400);       // a poll takes options
  expect((await page(w)).find((m: any) => m.id === answer.id).buttons.poll).toMatchObject({ answered: 2, counts: [2, 0] });
  const before = asks().length;
  w.advance(61_000);
  const after = await page(w, w.b), closed = after.find((m: any) => m.id === answer.id).buttons;
  expect(closed).toMatchObject({ state: "closed", poll: { answered: 2, counts: [2, 0] } });
  expect(closed.poll.voters.map((v: string[]) => [...v].sort())).toEqual([["Alex", "Bob"], []]);
  const line = after.find((m: any) => m.system?.kind === "poll-closed");
  expect(line).toMatchObject({ author: { kind: "system" }, system: { kind: "poll-closed", name: "Notes" }, text: "Poll closed · 2 voted" });
  expect(line.text).not.toContain("Alex");   // names stay on the poll (showVoters), never in the line
  expect((await press(w, w.a, { setId: id, options: [1] })).json.code).toBe("expired");
  await vi.waitFor(() => expect(asks().length).toBe(before + 1));
  const results = asks().at(-1)!;
  expect(results.asker).toEqual({ name: "Poll results" });
  expect(results.text).toMatch(/^\[poll results\] poll [a-f0-9]{8} · single choice · 60 s · 2 voted/);
  expect(results.text).toMatch(/1\) Noodles — 2: (Alex|Bob) \[[a-f0-9-]{36}\] \d+ ms; (Alex|Bob) \[/);   // voters by member id, never a person key
  // Ridge (M-3118): the line keeps the poll's lineage — no fresh human root.
  const l = (post: string) => r!.db.prepare("SELECT root_id,audience_sequence FROM hub_room_post_lineage WHERE post_id=?").get(post) as any;
  expect(l(line.id)).toEqual(l(answer.id));
  // Closed once: reading again changes nothing.
  expect((await page(w)).filter((m: any) => m.system?.kind === "poll-closed")).toHaveLength(1);
});

it("a reveal=close poll shows no counts while open, and no names without showVoters", async () => {
  const w = await world(), id = set();
  const answer = await answered(w, { id, labels: ["X", "Y"], poll: { seconds: 30, multi: true, reveal: "close", showVoters: false, question: "Pick one" } });
  await press(w, w.a, { setId: id, options: [0, 1] });
  const open = (await page(w)).find((m: any) => m.id === answer.id).buttons.poll;
  expect(open).toMatchObject({ answered: 1, multi: true }); expect(open).not.toHaveProperty("counts");
  w.advance(31_000);
  const closed = (await page(w)).find((m: any) => m.id === answer.id).buttons.poll;
  expect(closed).toMatchObject({ counts: [1, 1] }); expect(closed).not.toHaveProperty("voters");
});

it("plain buttons expire after a day without a room line; an archived room takes no press", async () => {
  const w = await world(), id = set(), id2 = set();
  const answer = await answered(w, { id, labels: ["A", "B"] });
  await answered(w, { id: id2, labels: ["C", "D"] }, "Second");
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { archived: true });
  expect((await press(w, w.a, { setId: id2, index: 0 })).json.code).toBe("archived");
  w.advance(24 * 60 * 60_000 + 1);
  const after = await page(w, await r!.signIn("alex"));   // a day later: a fresh sign-in
  expect(after.find((m: any) => m.id === answer.id).buttons.state).toBe("expired");
  expect(after.some((m: any) => m.system?.kind === "poll-closed")).toBe(false);
});

it("a link without room-answer-buttons-v1 cannot send buttons; text answers are unchanged", async () => {
  const w = await world(["welcome-caps-v1", "room-ask-v1"]);
  await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "Lunch?", mentions: [w.e.id], idempotencyKey: randomUUID() });
  await vi.waitFor(() => expect(asks().length).toBe(1));
  const ask = asks()[0]!;
  await expect(r!.http.receive(r!.frame("room.answer", { messageId: ask.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "x", buttons: { id: set(), labels: ["A", "B"] } }, w.link) as never, w.link)).rejects.toThrow();
  expect(await r!.http.receive(r!.frame("room.answer", { messageId: ask.messageId, roomId: w.id, exposureId: w.e.id, answerId: randomUUID(), text: "plain" }, w.link) as never, w.link)).toMatchObject({ type: "room.answer-ack" });
  expect((await page(w)).find((m: any) => m.text === "plain")).not.toHaveProperty("buttons");
});

// ── The Fleet member side (room-ask.ts): report_result's buttons/poll ride with a room answer only on a link that takes them.
import Database from "better-sqlite3";
import { HubRoomAskAdapter, migrateRoomAsks, type RoomAsk, type RoomAskLink, type RoomAnswer } from "../src/hub/member/room-ask.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";
function memberSide(features: string[]) {
  const db = new Database(":memory:"); migrateRoomAsks(db);
  const ask: RoomAsk = { messageId: randomUUID(), roomId: randomUUID(), exposureId: randomUUID(), roomName: "Weekly", asker: { name: "Alex" }, text: "Lunch?", context: [] };
  const inputs: HubRepresentativeDelivery[] = [], sent: RoomAnswer[] = [], exposure = { agent: "notes", consentId: randomUUID(), revision: 1, token: "t" };
  const link: RoomAskLink = { current: () => true, features: new Set(features), sendAnswer: vi.fn(async a => { sent.push(structuredClone(a)); }) };
  const adapter = new HubRoomAskAdapter({ db, bindingKey: "k", encryptionKey: randomBytes(32), current: () => true, localExposure: id => id === ask.exposureId ? exposure : null,
    deliver: vi.fn(async input => { if (!input.stillCurrent() || !await input.beforeInput()) return false; inputs.push(input); return true; }) });
  adapter.connected(link); adapter.accept(ask, link);
  const report = (extras?: any, text = "Pick one") => adapter.report({ caller: "notes", correlationId: inputs[0]!.correlationId, text, ...(extras ? { extras } : {}) })!;
  return { db, adapter, sent, report, close: () => { adapter.close(); db.close(); } };
}
const BUTTONS = [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }];

it("member: a link with room-answer-buttons-v1 sends the buttons (and a poll) frozen with the answer", async () => {
  const m = memberSide(["welcome-caps-v1", "room-ask-v1", "room-answer-buttons-v1"]); await m.adapter.settled();
  expect(await m.report({ buttons: BUTTONS })).toMatchObject({ ok: true });
  expect(m.sent[0]!.buttons).toMatchObject({ labels: ["Yes", "No"], values: ["yes", "no"] });
  expect(m.sent[0]!.buttons!.id).toMatch(/^[a-f0-9]{32}$/);
  // The same answer again is the same frozen answer; without its buttons it is a different one.
  expect(await m.report({ buttons: BUTTONS })).toMatchObject({ ok: true });
  expect(await m.report()).toMatchObject({ ok: false, message: expect.stringContaining("different saved answer") });
  await m.adapter.flush(); expect(m.sent.every(a => a.buttons?.id === m.sent[0]!.buttons!.id)).toBe(true);
  m.close();
  const p = memberSide(["welcome-caps-v1", "room-ask-v1", "room-answer-buttons-v1"]); await p.adapter.settled();
  expect(await p.report({ buttons: BUTTONS, poll: { seconds: 60, multi: false, reveal: "live", showVoters: false, question: "Pick one" } })).toMatchObject({ ok: true });
  expect(p.sent[0]!.buttons!.poll).toMatchObject({ seconds: 60, multi: false, reveal: "live" });
  p.close();
});

it("member: an older Hub (no room-answer-buttons-v1) refuses buttons with words the agent can act on; files stay refused", async () => {
  const m = memberSide(["welcome-caps-v1", "room-ask-v1"]); await m.adapter.settled();
  expect(await m.report({ buttons: BUTTONS })).toMatchObject({ ok: false, message: expect.stringContaining("Send the answer as text") });
  expect(await m.report({ files: ["f"] })).toMatchObject({ ok: false, message: expect.stringContaining("files") });
  expect(m.sent).toHaveLength(0);
  expect(await m.report()).toMatchObject({ ok: true }); expect(m.sent[0]).not.toHaveProperty("buttons");
  m.close();
});
