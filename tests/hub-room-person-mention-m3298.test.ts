/**
 * M-3298: "@Person" typed in a Hub room's web composer — does the person get the mention mark (the room list's @) and the
 * desktop ping? End to end on the real Hub (s3bRig: production HTTP + SQLite, inert member links, no agent started): Alex
 * types "@Hub Admin …" in the web composer, the page sends what the composer's own `mentionsIn` reads from the text, and
 * the admin's room list and the admin's live event are read as the page reads them (hub-room-unread.js counts/notifyKind).
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, expect, it } from "vitest";
import { page } from "./helpers/app-harness.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined, composer: any, unread: any, notify: any;
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  composer = await import("/ui/js/hub-room-composer.js"); unread = await import("/ui/js/hub-room-unread.js"); notify = await import("/ui/js/hub-room-notify.js");
  pg.restore();
});
afterEach(async () => { await r?.close(); r = undefined; });

async function world() {
  r = await s3bRig({ now: () => Date.now(), realAudit: true });
  const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, ["welcome-caps-v1", "room-ask-v1"]);
  const e: HubExposure = { id: randomUUID(), fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const id = (await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex)] })).json.room.id as string;
  await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: e.id });
  return { a, admin, id };
}

it("Alex's \"@Hub Admin\" from the web composer marks the admin mentioned and pings them", async () => {
  const w = await world();
  const asAlex = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json, asAdmin = (await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json;
  const target = asAlex.members.find((m: any) => m.kind === "person" && m.id !== asAlex.me.id);
  expect(target?.name).toBe("Hub Admin");
  // What the @ menu offers for the admin, and what the composer then sends for the text it leaves.
  const option = composer.mentionOptions(asAlex, "Hub").find((o: any) => o.kind === "person");
  expect(option).toMatchObject({ key: target.id, label: "@Hub Admin" });
  const text = `${option.label} please look at the numbers`;
  const mentions = composer.mentionsIn(text, asAlex);
  expect(mentions, "the composer sends the person it @s").toEqual([target.id]);
  const sent = await r!.call(w.a, "POST", `/hub/v1/rooms/${w.id}/messages`, { text, mentions, idempotencyKey: randomUUID() });
  expect(sent.status).toBe(200);
  // The admin's room list: unread, and the @ mark.
  expect((await r!.call(w.admin, "GET", "/hub/v1/rooms?v=2")).json.rooms[0]).toMatchObject({ unread: 1, mentioned: true });
  // The admin's page, on the live event: counted as an @ to me, and a desktop ping of kind "mention".
  const message = sent.json.message ?? sent.json, me = { id: asAdmin.me.id };
  const event = { type: "message.added", roomId: w.id, message };
  expect(unread.counts(event, me)).toMatchObject({ unread: 1, mentioned: true });
  expect(notify.notifyKind(event, me)).toBe("mention");
});

const listed = async (who: any) => (await r!.call(who, "GET", "/hub/v1/rooms?v=2")).json.rooms[0];
const post = async (who: any, room: string, text: string, mentions: string[] = []) => {
  const res = await r!.call(who, "POST", `/hub/v1/rooms/${room}/messages`, { text, mentions, idempotencyKey: randomUUID() });
  expect(res.status).toBe(200); return res.json.message ?? res.json;
};

it("a page that sends no person ids (an older open tab): the Hub reads \"@Name\" from the text and the person is reminded all the same", async () => {
  const w = await world(), adminMe = (await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json.me.id;
  const message = await post(w.a, w.id, "@Hub Admin can you check?");
  expect(message.mentions).toEqual([adminMe]);
  expect(await listed(w.admin)).toMatchObject({ unread: 1, mentioned: true });
  expect(notify.notifyKind({ type: "message.added", roomId: w.id, message }, { id: adminMe })).toBe("mention");
});

it("no one is reminded by code, an email address, an ambiguous name or oneself; agents are still routed only by what was sent", async () => {
  const w = await world(), asAlex = (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}`)).json;
  for (const text of ["`@Hub Admin` is the syntax", "write to alex@Hub Admin.example", "@Alex note to self"]) {
    expect((await post(w.a, w.id, text)).mentions, text).toEqual([]);
  }
  expect(await listed(w.admin)).toMatchObject({ mentioned: false });
  // Two people with one name: the text names no one (the @ menu's pick still names the one chosen, by id).
  const sam1 = r!.addPerson("sam1", "Sam"), sam2 = r!.addPerson("sam2", "Sam");
  await r!.signIn("sam1"); await r!.signIn("sam2");                   // (a person's name is the one their sign-in recorded)
  const twins = (await r!.call(w.admin, "POST", "/hub/v1/rooms", { name: "Twins", people: [personKeyString(sam1), personKeyString(sam2)] })).json.room.id as string;
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${twins}`)).json.members.filter((m: any) => m.name === "Sam")).toHaveLength(2);
  expect((await post(w.admin, twins, "@Sam which one?")).mentions).toEqual([]);
  // A person @ never asks an agent; an agent @ still does (the routing is what the page sent).
  const before = r!.sent.filter(s => s.frame.type === "room.ask").length;
  await post(w.a, w.id, "@Hub Admin fyi");
  expect(r!.sent.filter(s => s.frame.type === "room.ask").length).toBe(before);
  const agent = asAlex.members.find((m: any) => m.kind === "agent");
  expect((await post(w.a, w.id, "@Notes status?", [agent.id])).mentions).toEqual([agent.id]);
});

it("the composer: a longer name first (\"@Alex Chen\" is not \"@Alex\"), never me; agents read as before", () => {
  const detail = { me: { id: "m-me" }, members: [
    { kind: "person", id: "m-me", name: "Robin" }, { kind: "person", id: "m-alex", name: "Alex" }, { kind: "person", id: "m-chen", name: "Alex Chen" },
    { kind: "person", id: "m-wang", name: "王經理" }, { kind: "agent", id: "exp-1", name: "Notes" } ] };
  expect(composer.mentionsIn("@Alex Chen and @王經理, see @Notes", detail)).toEqual(["exp-1", "m-chen", "m-wang"]);
  expect(composer.mentionsIn("@Alex, then @Alex Chen", detail)).toEqual(["m-chen", "m-alex"]);
  expect(composer.mentionsIn("@Robin @Alexander alex@Alex.example \\@Alex", detail)).toEqual([]);
  // No space needed after a Chinese name (as an agent's has always been read): the page sends the person.
  expect(composer.mentionsIn("@王經理看一下", detail)).toEqual(["m-wang"]);
});
