/** Track R1: real HTTP + SQLite; directory/transport/content are the owned S3 fixture ports. */
import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig();
  const alex = r.addPerson("alex", "Alex"), bob = r.addPerson("bob", "Bob"), cara = r.addPerson("cara", "Cara");
  const [admin, a, b, c] = await Promise.all([r.signIn("admin"), r.signIn("alex"), r.signIn("bob"), r.signIn("cara")]);
  const created = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex), personKeyString(bob)], teams: [], groups: [], agents: [], assistant: false });
  expect(created.status).toBe(200);
  return { admin, a, b, c, alex, bob, cara, id: created.json.room.id as string };
}

it("creates a group room with the creator as manager and lists it only for its members", async () => {
  const w = await world();
  const list = await r!.call(w.a, "GET", "/hub/v1/rooms");
  expect(list.json).toMatchObject({ me: { canCreateRooms: false }, invitations: 0, rooms: [{ id: w.id, kind: "group", name: "Weekly", people: 3, agents: 0, unread: 1 }] });
  expect((await r!.call(w.c, "GET", "/hub/v1/rooms")).json.rooms).toEqual([]);
  const detail = await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`);
  expect(detail.json.members.find((m: any) => m.id === detail.json.me.id)).toMatchObject({ name: "Hub Admin", role: "manager", kind: "person" });
  expect(detail.json.settings).toEqual({ allMention: true, historyForNew: "since-join" });
  expect((await r!.call(w.c, "GET", `/hub/v1/rooms/${w.id}`)).status).toBe(403);
  expect((await r!.call(w.a, "POST", "/hub/v1/rooms", { name: "No privilege" })).status).toBe(403);
  expect((await r!.call(w.admin, "GET", "/hub/v1/rooms/candidates?kind=person&q=Al")).json).toEqual([{ kind: "person", id: personKeyString(w.alex), name: "Alex" }]);
  r!.setEligible("alex", false);
  expect((await r!.call(w.admin, "GET", "/hub/v1/rooms/candidates?kind=person&q=Al")).json).toEqual([]);
});

it("stores messages once, refuses conflicting idempotency, and pages newest-last without plaintext in SQL", async () => {
  const w = await world(), key = randomUUID(), input = { text: "private room text", mentions: [], idempotencyKey: key };
  const one = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, input);
  expect(one.status).toBe(200); expect(one.json).toMatchObject({ roomId: w.id, text: input.text, idempotencyKey: key, author: { name: "Alex", kind: "person" } });
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, input)).json.id).toBe(one.json.id);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { ...input, text: "different" })).status).toBe(409);
  const page = await r!.call(w.b, "GET", `/hub/v1/rooms/${w.id}/messages?limit=1`);
  expect(page.json).toMatchObject({ messages: [{ id: one.json.id }], more: true });
  const previous = await r!.call(w.b, "GET", `/hub/v1/rooms/${w.id}/messages?before=${one.json.id}&limit=1`);
  expect(previous.json.messages[0].author.kind).toBe("system");
  expect(JSON.stringify(r!.db.prepare("SELECT * FROM hub_room_posts").all())).not.toContain(input.text);
  expect((await r!.call(w.c, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.code).toBe("not-member");
});

it("keeps last-manager, member-only settings and all-mention restrictions distinct", async () => {
  const w = await world(), detail = (await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json;
  expect((await r!.call(w.a, "PATCH", `/hub/v1/rooms/${w.id}`, { name: "No" })).status).toBe(403);
  expect((await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${detail.me.id}`)).json.code).toBe("last-manager");
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}/members/${detail.me.id}`, { role: "member" })).json.code).toBe("last-manager");
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { allMention: false })).status).toBe(200);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "all", mentions: ["all"], idempotencyKey: randomUUID() })).json.code).toBe("all-mention-off");
  const a = detail.members.find((m: any) => m.name === "Alex");
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}/members/${a.id}`, { role: "manager" })).status).toBe(200);
  expect((await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${detail.me.id}`)).status).toBe(200);
});

it("since-join history does not reappear on removal/re-add, while all-history is explicit", async () => {
  const w = await world();
  const old = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "before Cara", mentions: [], idempotencyKey: randomUUID() });
  const add = () => r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "person", id: personKeyString(w.cara) });
  expect((await add()).status).toBe(200);
  expect((await r!.call(w.c, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.some((m: any) => m.id === old.json.id)).toBe(false);
  const detail = (await r!.call(w.c, "GET", `/hub/v1/rooms/${w.id}`)).json;
  await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${detail.me.id}`);
  expect((await r!.call(w.c, "GET", `/hub/v1/rooms/${w.id}/messages`)).status).toBe(403);
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { historyForNew: "all" }); await add();
  expect((await r!.call(w.c, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.some((m: any) => m.id === old.json.id)).toBe(true);
});

it("marks only an owned message read and keeps archived rooms readable but unsendable", async () => {
  const w = await world(), posted = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "hello", mentions: [], idempotencyKey: randomUUID() });
  expect((await r!.call(w.b, "POST", `/hub/v1/rooms/${w.id}/read`, { upTo: randomUUID() })).status).toBe(404);
  expect((await r!.call(w.b, "POST", `/hub/v1/rooms/${w.id}/read`, { upTo: posted.json.id })).status).toBe(200);
  expect((await r!.call(w.b, "GET", "/hub/v1/rooms")).json.rooms[0].unread).toBe(0);
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { archived: true });
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).status).toBe(200);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "late", mentions: [], idempotencyKey: randomUUID() })).json.code).toBe("archived");
});

it("required audit failure rolls back the room and every membership", async () => {
  r = await s3bRig(); const admin = await r.signIn("admin"); r.setAuditFails(true, "room.created");
  expect((await r.call(admin, "POST", "/hub/v1/rooms", { name: "Not saved", people: [], teams: [], groups: [], agents: [], assistant: false })).status).toBe(500);
  expect(r.db.prepare("SELECT count(*) AS n FROM hub_group_rooms").get()).toEqual({ n: 0 });
  expect(r.db.prepare("SELECT count(*) AS n FROM hub_room_members").get()).toEqual({ n: 0 });
});

it("emits named events only to current members, including a removal marker and no later room content", async () => {
  const w = await world(), stopB = new AbortController(), stopC = new AbortController();
  const timer = setTimeout(() => { stopB.abort(); stopC.abort(); }, 5000);
  const open = async (browser: typeof w.b, signal: AbortSignal) => {
    const res = await fetch(`${r!.base}/hub/v1/rooms/events`, { headers: { Cookie: browser.cookie }, signal });
    expect(res.status).toBe(200); const reader = res.body!.getReader(); let text = "";
    return { async until(needle: string) { while (!text.includes(needle)) { const chunk = await reader.read(); if (chunk.done) throw new Error("stream ended"); text += new TextDecoder().decode(chunk.value); } return text; } };
  };
  try {
    const b = await open(w.b, stopB.signal), c = await open(w.c, stopC.signal);
    await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "members only", mentions: [], idempotencyKey: randomUUID() });
    expect(await b.until("members only")).toContain("event: message.added");
    const own = await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Other room", people: [personKeyString(w.bob), personKeyString(w.cara)] });
    await r!.call(w.admin, "POST", `/hub/v1/rooms/${own.json.room.id}/messages`, { text: "other marker", idempotencyKey: randomUUID() });
    expect(await c.until("other marker")).not.toContain("members only");
    const detail = (await r!.call(w.b, "GET", `/hub/v1/rooms/${w.id}`)).json;
    await r!.call(w.admin, "DELETE", `/hub/v1/rooms/${w.id}/members/${detail.me.id}`);
    expect(await b.until('"removed":true')).toContain("event: room.changed");
    await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "after removal private", idempotencyKey: randomUUID() });
    await r!.call(w.admin, "POST", `/hub/v1/rooms/${own.json.room.id}/messages`, { text: "final marker", idempotencyKey: randomUUID() });
    expect(await b.until("final marker")).not.toContain("after removal private");
  } finally { clearTimeout(timer); stopB.abort(); stopC.abort(); }
});

it("retains room membership, history and unread across an HTTP remount", async () => {
  const w = await world();
  const posted = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "retained", idempotencyKey: randomUUID() });
  await r!.restartHttp();
  expect((await r!.call(w.b, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.at(-1).id).toBe(posted.json.id);
  expect((await r!.call(w.b, "GET", "/hub/v1/rooms")).json.rooms[0].unread).toBe(2);
});

it("keeps direct-chat grants, receipts and old history shapes alongside seam-1 messages", async () => {
  r = await s3bRig(); const owner = r.addPerson("owner", "Owner"), alex = r.addPerson("alex", "Alex"), fleetId = randomUUID(), exposureId = randomUUID();
  const link = r.link(fleetId, owner); await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner,
    displayName: "Probe", revision: 1, state: "published", dataViewId: "v", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const o = await r.signIn("owner"), a = await r.signIn("alex");
  const grant = await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "alex", days: 7 });
  const opened = await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.json.grant.id }), id = opened.json.room.id;
  const key = randomUUID(), ask = await r.call(a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "Direct question", mentions: [], idempotencyKey: key });
  expect(ask.json).toMatchObject({ id: ask.json.receipt.messageId, text: "Direct question", idempotencyKey: key, receipt: { stage: "queued" } });
  const list = (await r.call(a, "GET", "/hub/v1/rooms")).json;
  expect(list.rooms[0]).toMatchObject({ id, kind: "direct", name: "Probe", exposureId, agent: { presence: "idle" } });
  const detail = (await r.call(a, "GET", `/hub/v1/rooms/${id}`)).json;
  expect(detail.me.id).toBe(personKeyString(alex)); expect(detail.members[1].canAsk).toBe(true);
  const page = (await r.call(a, "GET", `/hub/v1/rooms/${id}/messages`)).json;
  expect(page).toMatchObject({ messages: [{ id: ask.json.id, text: "Direct question" }], entries: [{ messageId: ask.json.id, question: "Direct question" }], more: false });
  expect((await r.call(a, "POST", `/hub/v1/rooms/${id}/read`, { upTo: ask.json.id })).status).toBe(200);
  const stop = new AbortController(), deadline = setTimeout(() => stop.abort(), 5000);
  try {
    const stream = await fetch(`${r.base}/hub/v1/rooms/events`, { headers: { Cookie: a.cookie }, signal: stop.signal }), reader = stream.body!.getReader();
    const text = "Agent reply", answerId = randomUUID(), digest = createHash("sha256").update(text).digest("hex");
    const release = await r.http.receive(r.frame("authorize.request", { messageId: ask.json.id, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest: digest } }, link) as never, link) as any;
    expect(release.payload.ok).toBe(true);
    await r.http.receive(r.frame("answer", { messageId: ask.json.id, answerId, text, contentDigest: digest, releaseLease: release.payload.lease }, link) as never, link);
    let events = ""; while (!events.includes(text)) { const chunk = await reader.read(); expect(chunk.done).toBe(false); events += new TextDecoder().decode(chunk.value); }
    expect(events).toContain("event: message.added");
    expect((await r.call(a, "GET", "/hub/v1/rooms")).json.rooms[0].unread).toBe(1);
    expect((await r.call(a, "POST", `/hub/v1/rooms/${id}/read`, { upTo: `${ask.json.id}:answer` })).status).toBe(200);
    expect((await r.call(a, "GET", "/hub/v1/rooms")).json.rooms[0].unread).toBe(0);
    const latest = (await r.call(a, "GET", `/hub/v1/rooms/${id}/messages?limit=1`)).json;
    expect(latest).toMatchObject({ messages: [{ text }], more: true });
    expect((await r.call(a, "GET", `/hub/v1/rooms/${id}/messages?before=${latest.messages[0].id}&limit=1`)).json.messages[0].text).toBe("Direct question");
  } finally { clearTimeout(deadline); stop.abort(); }
  await r.call(o, "DELETE", `/hub/v1/grants/${grant.json.grant.id}?revision=1`);
  expect((await r.call(a, "GET", `/hub/v1/rooms/${id}/messages`)).status).toBe(403);
});
