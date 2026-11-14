/** M-3127 A: people's emoji reactions in a group room — real HTTP + SQLite (the S3b rig). */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { validRoomEmoji, ROOM_REACTION_LIMIT } from "../src/hub/rooms/service.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig();
  const alex = r.addPerson("alex", "Alex"), bob = r.addPerson("bob", "Bob"), cara = r.addPerson("cara", "Cara");
  const [admin, a, b, c] = await Promise.all([r.signIn("admin"), r.signIn("alex"), r.signIn("bob"), r.signIn("cara")]);
  const created = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex), personKeyString(bob)], teams: [], groups: [], agents: [], assistant: false });
  expect(created.status).toBe(200);
  const id = created.json.room.id as string;
  const post = await r.call(a, "POST", `/hub/v1/rooms/${id}/messages`, { text: "lunch at noon?", mentions: [], idempotencyKey: randomUUID() });
  const me = async (browser: typeof a) => (await r!.call(browser, "GET", `/hub/v1/rooms/${id}`)).json.me.id as string;
  return { admin, a, b, c, cara, id, post: post.json.id as string, me };
}
const react = (browser: any, roomId: string, postId: string, emoji: string, on = true) =>
  r!.call(browser, "POST", `/hub/v1/rooms/${roomId}/messages/${postId}/reactions`, { emoji, on });

it("adds and takes back reactions with set semantics; every member reads who reacted with what", async () => {
  const w = await world(), alexId = await w.me(w.a), bobId = await w.me(w.b);
  expect((await react(w.b, w.id, w.post, "👍")).json).toEqual({ reactions: [{ emoji: "👍", count: 1, members: [bobId] }] });
  expect((await react(w.b, w.id, w.post, "👍")).json.reactions).toEqual([{ emoji: "👍", count: 1, members: [bobId] }]);   // twice = once
  await react(w.a, w.id, w.post, "🎉"); await react(w.a, w.id, w.post, "👍");
  const page = await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}/messages`);
  expect(page.json.messages.find((m: any) => m.id === w.post).reactions).toEqual([
    { emoji: "👍", count: 2, members: [bobId, alexId] }, { emoji: "🎉", count: 1, members: [alexId] }]);
  expect((await react(w.b, w.id, w.post, "👍", false)).json.reactions).toEqual([{ emoji: "🎉", count: 1, members: [alexId] }, { emoji: "👍", count: 1, members: [alexId] }]);   // order: first reaction still there
  expect((await react(w.b, w.id, w.post, "👍", false)).status).toBe(200);   // removing what is not there: no change
  await react(w.a, w.id, w.post, "👍", false); await react(w.a, w.id, w.post, "🎉", false);
  // No reactions left: the field is gone (an older reader sees the message as it was).
  expect((await r!.call(w.b, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages.find((m: any) => m.id === w.post)).not.toHaveProperty("reactions");
});

it("refuses non-members, unseen history, room lines, archived rooms, bad emoji and a thirteenth emoji", async () => {
  const w = await world();
  expect((await react(w.c, w.id, w.post, "👍")).json.code).toBe("not-member");
  // Cara joins after the post (since-join): she cannot react to what she cannot read.
  await r!.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "person", id: personKeyString(w.cara) });
  expect((await react(w.c, w.id, w.post, "👍")).status).toBe(404);
  expect((await react(w.a, w.id, randomUUID(), "👍")).status).toBe(404);
  const system = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages?limit=100`)).json.messages.find((m: any) => m.author.kind === "system");
  expect((await react(w.a, w.id, system.id, "👍")).status).toBe(409);
  for (const bad of ["a", "👍👍", "", "x👍", " 👍", "\u0007", "😀".repeat(9)]) expect((await react(w.a, w.id, w.post, bad)).status, bad).toBe(400);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages/${w.post}/reactions`, { emoji: "👍" })).status).toBe(400);
  expect((await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages/${w.post}/reactions`, { emoji: "👍", on: true, extra: 1 })).status).toBe(400);
  const twelve = ["😀", "😂", "😍", "🤔", "👏", "🙏", "🔥", "✅", "❤️", "🎉", "👀", "🚀"];
  expect(twelve).toHaveLength(ROOM_REACTION_LIMIT);
  for (const e of twelve) expect((await react(w.a, w.id, w.post, e)).status, e).toBe(200);
  expect((await react(w.b, w.id, w.post, "🍕")).json.code).toBe("limit");
  expect((await react(w.b, w.id, w.post, "🚀")).status).toBe(200);   // an emoji already there is still open to others
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { archived: true });
  expect((await react(w.b, w.id, w.post, "😀")).json.code).toBe("archived");
});

it("pushes the reacted post on the members' stream as message.updated, and nothing for a no-op", async () => {
  const w = await world(), stop = new AbortController(), timer = setTimeout(() => stop.abort(), 5000);
  try {
    const res = await fetch(`${r!.base}/hub/v1/rooms/events`, { headers: { Cookie: w.b.cookie }, signal: stop.signal });
    const reader = res.body!.getReader(); let text = "";
    const until = async (needle: string) => { while (!text.includes(needle)) { const c = await reader.read(); if (c.done) throw new Error("ended"); text += new TextDecoder().decode(c.value); } return text; };
    await until(": connected");
    await react(w.a, w.id, w.post, "🎉");
    await react(w.a, w.id, w.post, "🎉");   // no-op: no second event
    await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text: "marker after", mentions: [], idempotencyKey: randomUUID() });
    const seen = await until("marker after");
    const updates = seen.split("\n\n").filter(e => e.startsWith("event: message.updated"));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0]!.split("\ndata: ")[1]!).message).toMatchObject({ id: w.post, text: "lunch at noon?", reactions: [{ emoji: "🎉", count: 1 }] });
  } finally { clearTimeout(timer); stop.abort(); }
});

it("validRoomEmoji takes one pictograph grapheme, ZWJ, skin tone and flags included", () => {
  for (const ok of ["👍", "❤️", "👍🏽", "👩‍💻", "🇹🇼", "☕", "✅"]) expect(validRoomEmoji(ok), ok).toBe(true);
  for (const no of ["", "a", "1", "👍👍", "👍 ", "ab", "<b>", null, 1]) expect(validRoomEmoji(no), String(no)).toBe(false);
});
