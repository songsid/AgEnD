/** M-3127 C: message search across the group rooms I am in — real HTTP + SQLite (the S3b rig). */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { searchSnippet } from "../src/hub/rooms/service.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  let at = Date.now(); r = await s3bRig({ now: () => at });
  const alex = r.addPerson("alex", "Alex"), bob = r.addPerson("bob", "Bob"), cara = r.addPerson("cara", "Cara");
  const [admin, a, b, c] = await Promise.all([r.signIn("admin"), r.signIn("alex"), r.signIn("bob"), r.signIn("cara")]);
  const room = async (name: string, people: any[]) => (await r!.call(admin, "POST", "/hub/v1/rooms", { name, people: people.map(personKeyString) })).json.room.id as string;
  const weekly = await room("Weekly", [alex, bob]), other = await room("Other", [bob]);
  const say = async (who: any, id: string, text: string) => { at += 1000; const p = await r!.call(who, "POST", `/hub/v1/rooms/${id}/messages`, { text, mentions: [], idempotencyKey: randomUUID() }); expect(p.status).toBe(200); return p.json.id as string; };
  return { admin, a, b, c, cara, weekly, other, say };
}
const search = (who: any, q: string, extra = "") => r!.call(who, "GET", `/hub/v1/rooms/search?q=${encodeURIComponent(q)}${extra}`);

it("finds messages in the rooms I am in, newest first, with the room, the author and the words marked", async () => {
  const w = await world();
  const first = await w.say(w.a, w.weekly, "Lunch at noon? The new noodle place");
  await w.say(w.b, w.other, "lunch plans for the other room");          // not Alex's room
  const second = await w.say(w.b, w.weekly, "I can't do lunch today, sorry");
  await w.say(w.a, w.weekly, "unrelated");
  const res = await search(w.a, "lunch");
  expect(res.status).toBe(200);
  expect(res.json.hits.map((h: any) => h.messageId)).toEqual([second, first]);
  expect(res.json.hits[0]).toMatchObject({ roomId: w.weekly, roomName: "Weekly", author: { kind: "person", name: "Bob" }, snippet: "I can't do lunch today, sorry", marks: [[11, 16]] });
  expect(res.json).not.toHaveProperty("cursor");
  expect((await search(w.b, "lunch")).json.hits).toHaveLength(3);      // Bob is in both rooms
  expect((await search(w.c, "lunch")).json.hits).toEqual([]);          // Cara in none
});

it("every word must appear, case and width folded (NFKC); room lines are not messages", async () => {
  const w = await world();
  const hit = await w.say(w.a, w.weekly, "Budget review on Friday");
  await w.say(w.a, w.weekly, "Budget only");
  expect((await search(w.a, "budget friday")).json.hits.map((h: any) => h.messageId)).toEqual([hit]);
  expect((await search(w.a, "ＢＵＤＧＥＴ ＦＲＩＤＡＹ")).json.hits.map((h: any) => h.messageId)).toEqual([hit]);
  expect((await search(w.a, "Hub Admin")).json.hits).toEqual([]);      // the "created the room" line's name is not searched
});

it("never shows what I could not read: messages before I joined (since-join)", async () => {
  const w = await world();
  const before = await w.say(w.a, w.weekly, "secret before Cara");
  // A post from before M-3118 has no lineage row: the joined_sequence bound alone keeps it hidden.
  expect(r!.db.prepare("DELETE FROM hub_room_post_lineage WHERE post_id=?").run(before).changes).toBe(1);
  await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.weekly}/members`, { kind: "person", id: personKeyString(w.cara) });
  const after = await w.say(w.a, w.weekly, "secret after Cara");
  expect((await search(w.c, "secret")).json.hits.map((h: any) => h.messageId)).toEqual([after]);
  // An archived room stays readable, so searchable.
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.weekly}`, { archived: true });
  expect((await search(w.c, "secret")).json.hits).toHaveLength(1);
});

it("follows the M-3118 lineage floor: a post in a thread rooted before I joined is not mine to find", async () => {
  const w = await world();
  await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.weekly}/members`, { kind: "person", id: personKeyString(w.cara) });
  const root = await w.say(w.a, w.weekly, "an old root");
  const late = await w.say(w.a, w.weekly, "hidden descendant");
  expect((await search(w.c, "descendant")).json.hits).toHaveLength(1);
  expect(r!.db.prepare("UPDATE hub_room_post_lineage SET root_id=?,depth=1,audience_sequence=1 WHERE post_id=?").run(root, late).changes).toBe(1);
  expect((await search(w.c, "descendant")).json.hits).toEqual([]);
  expect((await search(w.a, "descendant")).json.hits).toHaveLength(1);   // Alex was there
});

it("pages with a cursor when there are more hits than the limit", async () => {
  const w = await world();
  const ids = [await w.say(w.a, w.weekly, "deploy one"), await w.say(w.a, w.weekly, "deploy two"), await w.say(w.a, w.weekly, "deploy three")];
  const one = (await search(w.a, "deploy", "&limit=2")).json;
  expect(one.hits.map((h: any) => h.messageId)).toEqual([ids[2], ids[1]]);
  expect(one.cursor).toMatch(/^\d+\.[a-f0-9-]{36}$/);
  const two = (await search(w.a, "deploy", `&limit=2&cursor=${encodeURIComponent(one.cursor)}`)).json;
  expect(two.hits.map((h: any) => h.messageId)).toEqual([ids[0]]);
  expect(two).not.toHaveProperty("cursor");
});

it("refuses a bad query, limit or cursor", async () => {
  const w = await world();
  for (const extra of ["", "&limit=0", "&limit=51", "&limit=x", "&cursor=nope"]) expect((await search(w.a, extra ? "ok" : "   ", extra)).status, extra).toBe(400);
  expect((await search(w.a, "x".repeat(101))).status).toBe(400);
  expect((await search(w.a, "會")).status).toBe(200);   // one CJK character is a word
  expect((await r!.call(w.a, "POST", "/hub/v1/rooms/search", {})).status).toBe(405);
});

it("searchSnippet keeps whole characters around the first hit and merges marks", () => {
  const long = `${"前".repeat(100)}找到這裡😀了${"後".repeat(100)}`;
  const s = searchSnippet(long, ["這裡"], 40);
  expect(s.snippet.startsWith("…")).toBe(true); expect(s.snippet.endsWith("…")).toBe(true);
  expect(s.snippet).toContain("找到這裡😀了");
  expect(s.snippet.slice(s.marks[0]![0], s.marks[0]![1])).toBe("這裡");
  expect(searchSnippet("abcabc", ["abc", "bca"]).marks).toEqual([[0, 6]]);
  expect(searchSnippet("line\n\nbreaks", ["breaks"]).snippet).toBe("line breaks");
});
