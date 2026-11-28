/** History projection stays in its caller's synchronous authorization transaction. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await r?.close(); r = undefined; });

async function room() {
  r = await s3bRig({ attachments: true });
  const admin = await r.signIn("admin");
  const created = await r.call(admin, "POST", "/hub/v1/rooms", {
    name: "Synthetic history", people: [], agents: [], groups: [], teams: [],
  });
  expect(created.status).toBe(200);
  const id = created.json.room.id as string, subject = personKeyString(r.admin);
  for (let i = 0; i < 70; i++) {
    const post = randomUUID(), agent = i % 4 === 0, system = i % 4 === 1;
    const author = system ? "room-created" : agent ? randomUUID() : subject;
    r.db.prepare(`INSERT INTO hub_room_posts
      (id,room_id,sequence,author_kind,author_id,author_subject,author_name,content_ref,digest,mentions,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(post, id, i + 2, system ? "system" : agent ? "agent" : "person",
        author, subject, "Synthetic author", "missing", "a".repeat(64), "[]", i + 1);
  }
  // Production mount currency reads the transport/floor before each core unit.
  // Keep that read real here: a constant mock would conceal the per-row multiplier.
  const current = r.httpDeps.current;
  r.httpDeps.current = () => { r!.store.read(); return current(); };
  return { admin, id };
}

it("validates mount state a bounded number of times for a mixed 70-post page", async () => {
  const w = await room(), reads = vi.spyOn(r!.store, "read");
  const one = await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}/messages?limit=1`);
  expect(one.status).toBe(200);
  const base = reads.mock.calls.length;
  reads.mockClear();
  const page = await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}/messages?limit=100`);
  expect(page.status).toBe(200);
  expect(page.json.messages).toHaveLength(71);
  expect(new Set(page.json.messages.map((m: { author: { kind: string } }) => m.author.kind)))
    .toEqual(new Set(["system", "agent", "person"]));
  expect(reads.mock.calls.length).toBeLessThanOrEqual(base + 4);
});

it("still refuses a mount revoked while the page is projected", async () => {
  const w = await room(), original = r!.httpDeps.content.get;
  let reads = 0;
  r!.httpDeps.content.get = ref => {
    const value = original(ref);
    if (++reads === 2) r!.disable();
    return value;
  };
  const page = await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}/messages?limit=100`);
  expect(page.status).toBe(503);
  expect(page.json.messages).toBeUndefined();
});
