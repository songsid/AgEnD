/**
 * M-3340 (the user: personal pins): a group room's pins are each person's own — kept on the Hub per person per room, never
 * shown to anyone else. Real HTTP + SQLite (the S3b rig): GET/PUT/DELETE /hub/v1/rooms/<id>/pins[/<message>], the
 * room-pins-v1 feature, at most 50, only messages the person can see (since-join, the lineage floor), never a room line;
 * the person's other streams hear pins.changed (which room only), nobody else does.
 */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { ROOM_PINS_MAX } from "../src/hub/rooms/service.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig();
  const alex = r.addPerson("alex", "Alex"), bob = r.addPerson("bob", "Bob"), cara = r.addPerson("cara", "Cara");
  const [admin, a, b, c] = await Promise.all([r.signIn("admin"), r.signIn("alex"), r.signIn("bob"), r.signIn("cara")]);
  const created = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex), personKeyString(bob)], teams: [], groups: [], agents: [], assistant: false });
  expect(created.status).toBe(200);
  const id = created.json.room.id as string;
  const say = async (who: typeof a, text: string) => (await r!.call(who, "POST", `/hub/v1/rooms/${id}/messages`, { text, mentions: [], idempotencyKey: randomUUID() })).json.id as string;
  const first = await say(a, "release notes are in the doc"), second = await say(b, "rehearsal at 3pm");
  return { admin, a, b, c, alex, cara, id, first, second, say };
}
const pins = (who: any, id: string) => r!.call(who, "GET", `/hub/v1/rooms/${id}/pins`);
const pin = (who: any, id: string, msg: string, on = true) => r!.call(who, on ? "PUT" : "DELETE", `/hub/v1/rooms/${id}/pins/${msg}`);
const ids = (res: any) => res.json.pins.map((p: any) => p.messageId);

it("each person's own: Alex's pins are Alex's — Bob reads only his; newest first, with the message as they see it; twice = once", async () => {
  const w = await world();
  expect((await pins(w.a, w.id)).json).toEqual({ pins: [] });
  expect(ids(await pin(w.a, w.id, w.first))).toEqual([w.first]);
  expect(ids(await pin(w.a, w.id, w.first))).toEqual([w.first]);                     // twice = once
  const two = await pin(w.a, w.id, w.second);
  expect(ids(two)).toEqual([w.second, w.first]);                                      // newest first
  expect(two.json.pins[1]).toMatchObject({ messageId: w.first, message: { id: w.first, text: "release notes are in the doc", author: { name: "Alex" } } });
  expect(typeof two.json.pins[1].pinnedAt).toBe("number");
  expect((await pins(w.b, w.id)).json.pins, "Bob never sees Alex's pins").toEqual([]);
  expect(ids(await pin(w.b, w.id, w.first))).toEqual([w.first]);
  expect(ids(await pins(w.a, w.id))).toEqual([w.second, w.first]);
  expect(ids(await pin(w.a, w.id, w.second, false))).toEqual([w.first]);              // unpin
  expect(ids(await pin(w.a, w.id, w.second, false))).toEqual([w.first]);              // unpinning what isn't: no change
  expect(ids(await pins(w.b, w.id))).toEqual([w.first]);
});

it("the Hub says so: room-pins-v1 among the session's features", async () => {
  const w = await world();
  expect((await r!.call(w.a, "GET", "/hub/v1/session")).json.features).toContain("room-pins-v1");
});

it("refuses non-members, unseen history, room lines, unknown or malformed messages, a 51st pin, other methods and queries", async () => {
  const w = await world();
  expect((await pin(w.c, w.id, w.first)).json.code).toBe("not-member");
  expect((await pins(w.c, w.id)).json.code).toBe("not-member");
  // Cara joins after the posts (since-join): what she can't read, she can't pin.
  await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "person", id: personKeyString(w.cara) });
  expect((await pin(w.c, w.id, w.first)).status).toBe(404);
  expect((await pin(w.a, w.id, randomUUID())).status).toBe(404);
  expect((await pin(w.a, w.id, "not-a-uuid")).status).toBe(400);
  const system = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages?limit=100`)).json.messages.find((m: any) => m.author.kind === "system");
  expect((await pin(w.a, w.id, system.id)).status).toBe(409);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/pins/${w.first}`, {})).status).toBe(405);
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/pins?x=1`)).status).toBe(400);
  expect((await pins(w.a, randomUUID())).status).toBe(404);
  const many: string[] = [];
  for (let i = 0; i < ROOM_PINS_MAX; i++) many.push(await w.say(w.a, `note ${i}`));
  for (const m of many) expect((await pin(w.a, w.id, m)).status).toBe(200);
  expect(ROOM_PINS_MAX).toBe(50);
  expect((await pin(w.a, w.id, w.first)).json.code).toBe("pins-full");
  expect((await pin(w.a, w.id, many[0]!)).status, "one already pinned is no new pin").toBe(200);
  expect((await pin(w.b, w.id, w.first)).status, "the limit is per person").toBe(200);
});

it("an archived room keeps my pins readable and changeable (they are mine, not the room's)", async () => {
  const w = await world();
  await pin(w.a, w.id, w.first);
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { archived: true });
  expect(ids(await pins(w.a, w.id))).toEqual([w.first]);
  expect(ids(await pin(w.a, w.id, w.first, false))).toEqual([]);
});

it("pins.changed reaches the person's own stream (which room only), never another member's", async () => {
  const w = await world(), stop = new AbortController(), timer = setTimeout(() => stop.abort(), 5000);
  try {
    const open = async (cookie: string) => {
      const res = await fetch(`${r!.base}/hub/v1/rooms/events`, { headers: { Cookie: cookie }, signal: stop.signal });
      const reader = res.body!.getReader(); let text = "";
      const until = async (needle: string) => { while (!text.includes(needle)) { const c = await reader.read(); if (c.done) throw new Error("ended"); text += new TextDecoder().decode(c.value); } return text; };
      await until(": connected");
      return until;
    };
    const mine = await open(w.a.cookie), bobs = await open(w.b.cookie);
    await pin(w.a, w.id, w.first);
    await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "marker after", mentions: [], idempotencyKey: randomUUID() });
    const a = await mine("marker after"), b = await bobs("marker after");
    const events = (t: string) => t.split("\n\n").filter((e) => e.startsWith("event: pins.changed"));
    expect(events(a)).toHaveLength(1);
    expect(JSON.parse(events(a)[0]!.split("\ndata: ")[1]!)).toEqual({ roomId: w.id });
    expect(events(b), "Bob hears nothing of Alex's pins").toEqual([]);
  } finally { clearTimeout(timer); stop.abort(); }
});

it("a pin of a message I can no longer see (I left and was added back: since-join) is not shown", async () => {
  const w = await world();
  expect(ids(await pin(w.a, w.id, w.first))).toEqual([w.first]);
  const meId = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json.me.id as string;
  expect((await r!.call(w.a, "DELETE", `/hub/v1/rooms/${w.id}/members/${meId}`)).status).toBe(200);     // Alex leaves
  expect((await pins(w.a, w.id)).json.code).toBe("not-member");
  expect((await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "person", id: personKeyString(w.alex) })).status).toBe(200);   // and is added back
  const later = await w.say(w.a, "back again");
  expect(ids(await pins(w.a, w.id)), "the old message is older than her joining now").toEqual([]);
  expect(ids(await pin(w.a, w.id, later))).toEqual([later]);
});
