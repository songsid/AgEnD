/**
 * M-3125 PR1: people's files in group rooms, on the actual Hub HTTP/SQLite/audit (the S3b rig with the attachment store).
 * A member uploads (POST /hub/v1/rooms/:id/files, the same route as a 1:1 chat), posts with up to 10 of their own pending
 * files (a post may be files only), every member who can see the post reads them, and nobody else does: not a non-member,
 * not another member while the file is someone else's pending upload, and not a member whose history floor starts after
 * the post (the listing's own visibility rule, including the M-3118 lineage audience).
 */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

async function world() {
  r = await s3bRig({ attachments: true, realAudit: true });
  const alexKey = r.addPerson("alex", "Alex"), beaKey = r.addPerson("bea", "Bea"); r.addPerson("cara", "Cara");
  const admin = await r.signIn("admin"), alex = await r.signIn("alex"), bea = await r.signIn("bea"), cara = await r.signIn("cara");
  const room = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alexKey)] });
  expect(room.status).toBe(200); const id = room.json.room.id as string;
  const upload = async (who: { cookie: string; csrf: string }, name: string, body: string, roomId = id) => {
    const res = await fetch(`${r!.base}/hub/v1/rooms/${roomId}/files`, { method: "POST", body,
      headers: { Origin: "https://hub.example.test", Cookie: who.cookie, "X-AgEnD-Hub-CSRF": who.csrf, "X-File-Name": name } });
    return { status: res.status, json: await res.json() as any };
  };
  const post = (who: typeof alex, body: Record<string, unknown>) => r!.call(who, "POST", `/hub/v1/rooms/${id}/messages`, { idempotencyKey: randomUUID(), text: "", ...body });
  const page = async (who: typeof alex) => (await r!.call(who, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages as any[];
  return { r: r!, id, admin, alex, bea, cara, beaKey, upload, post, page };
}

it("a member uploads, posts with files, and every member sees and reads them on the post", async () => {
  const w = await world();
  const up = await w.upload(w.alex, "notes.txt", "meeting notes");
  expect(up.status).toBe(200);
  expect(up.json.file).toMatchObject({ name: "notes.txt", size: 13, mime: "text/plain", url: `/hub/v1/rooms/${w.id}/files/${up.json.file.id}` });
  const sent = await w.post(w.alex, { text: "the notes", files: [up.json.file.id] });
  expect(sent.status).toBe(200);
  expect(sent.json.files).toEqual([up.json.file]);
  const seen = (await w.page(w.admin)).find(m => m.id === sent.json.id);
  expect(seen.files).toEqual([up.json.file]);
  const read = await w.r.call(w.admin, "GET", up.json.file.url);
  expect(read.status).toBe(200);
  const audited = (action: string) => (w.r.db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE action=? AND room_id=?").get(action, w.id) as { n: number }).n;
  expect(audited("file.upload")).toBe(1);
  expect(audited("file.read")).toBe(1);
});

it("a post may carry files with no text, but not neither; at most 10 files", async () => {
  const w = await world();
  const up = await w.upload(w.alex, "a.csv", "x,y\n1,2\n");
  expect((await w.post(w.alex, { text: "", files: [up.json.file.id] })).status).toBe(200);
  expect((await w.post(w.alex, { text: "   " })).status).toBe(400);
  expect((await w.post(w.alex, { text: "eleven", files: Array.from({ length: 11 }, () => randomUUID()) })).status).toBe(400);
});

it("a non-member can neither upload to nor read from the room", async () => {
  const w = await world();
  expect((await w.upload(w.cara, "x.txt", "nope")).status).toBe(403);
  const up = await w.upload(w.alex, "x.txt", "members only"); await w.post(w.alex, { text: "file", files: [up.json.file.id] });
  expect((await w.r.call(w.cara, "GET", up.json.file.url)).status).toBe(403);
});

it("a pending upload is its uploader's alone: another member can neither read nor attach it", async () => {
  const w = await world();
  const up = await w.upload(w.alex, "draft.txt", "not posted yet");
  expect((await w.r.call(w.alex, "GET", up.json.file.url)).status).toBe(200);
  expect((await w.r.call(w.admin, "GET", up.json.file.url)).status).toBe(404);
  expect((await w.post(w.admin, { text: "steal", files: [up.json.file.id] })).status).toBe(404);
});

it("a member who joins later (since-join) cannot read files posted before their floor, and can read later ones", async () => {
  const w = await world();
  const early = await w.upload(w.alex, "early.txt", "before bea"); await w.post(w.alex, { text: "early", files: [early.json.file.id] });
  expect((await w.r.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "person", id: personKeyString(w.beaKey) })).status).toBe(200);
  expect((await w.r.call(w.bea, "GET", early.json.file.url)).status).toBe(404);
  const late = await w.upload(w.alex, "late.txt", "after bea"); await w.post(w.alex, { text: "late", files: [late.json.file.id] });
  expect((await w.r.call(w.bea, "GET", late.json.file.url)).status).toBe(200);
});

it("a file belongs to its room, an archived room takes no uploads, and the same key with other files is a conflict", async () => {
  const w = await world();
  const other = await w.r.call(w.admin, "POST", "/hub/v1/rooms", { name: "Other", people: [] });
  const up = await w.upload(w.alex, "x.txt", "room one");
  expect((await w.r.call(w.admin, "GET", `/hub/v1/rooms/${other.json.room.id}/files/${up.json.file.id}`)).status).toBe(404);
  const key = randomUUID();
  expect((await w.r.call(w.alex, "POST", `/hub/v1/rooms/${w.id}/messages`, { idempotencyKey: key, text: "t", files: [up.json.file.id] })).status).toBe(200);
  const second = await w.upload(w.alex, "y.txt", "two");
  expect((await w.r.call(w.alex, "POST", `/hub/v1/rooms/${w.id}/messages`, { idempotencyKey: key, text: "t", files: [second.json.file.id] })).status).toBe(409);
  expect((await w.r.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { archived: true })).status).toBe(200);
  expect((await w.upload(w.alex, "z.txt", "late")).status).toBe(409);
});
