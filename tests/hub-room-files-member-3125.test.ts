/**
 * M-3125 PR2, the Fleet side (HubRoomAskAdapter, room-files-v1): an ask's files reach the agent's inbox before the prompt
 * and are named in it; report_result's files are staged (attachment.put) before the frozen answer frame names them, again on
 * every resend; an older link (no room-files-v1) gets the words only and an answer with files is refused with a reason.
 */
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { HubRoomAskAdapter, migrateRoomAsks, type RoomAsk, type RoomAskLink, type RoomAnswer, type RoomAskOptions } from "../src/hub/member/room-ask.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";
import type { HubAttachmentChunk, HubAttachmentRef } from "../src/hub/types.js";
import type { HubMemberFiles } from "../src/hub/member/attachments.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => { if (db.open) db.close(); }));
const ref = (name: string, sha = "a"): HubAttachmentRef => ({ id: randomUUID(), name, size: 4, mime: "text/plain", sha256: sha.repeat(64) as never });

function member(opts: { roomFiles?: boolean; askFiles?: HubAttachmentRef[] } = {}) {
  const db = new Database(":memory:"); databases.push(db); migrateRoomAsks(db);
  const ask: RoomAsk = { messageId: randomUUID(), roomId: randomUUID(), exposureId: randomUUID(), roomName: "Weekly", asker: { name: "Alex" },
    text: "@Notes see the file", context: [], ...(opts.askFiles ? { attachments: opts.askFiles } : {}) };
  const inputs: HubRepresentativeDelivery[] = [], sent: RoomAnswer[] = [], events: string[] = [];
  const exposure = { agent: "notes", consentId: randomUUID(), revision: 1, token: "life-1" };
  const prepared = new Map<string, HubAttachmentRef>();
  const files = {
    receive: vi.fn(async (_agent: string, _id: string, refs: readonly HubAttachmentRef[], fetch: (id: string, offset: number) => Promise<HubAttachmentChunk>) => {
      for (const f of refs) await fetch(f.id, 0); return refs.map(f => `[📎 File: /inbox/${f.name}]`); }),
    prepare: vi.fn(async (_agent: string, paths: readonly string[]) => paths.map(p => {
      const r = prepared.get(p) ?? ref(p.split("/").pop()!); prepared.set(p, r); return { ref: r, bytes: Buffer.from("data") }; })),
    send: vi.fn(async (file: { ref: HubAttachmentRef; bytes: Buffer }, put: (c: HubAttachmentChunk) => Promise<void>) => {
      await put({ id: file.ref.id, offset: 0, total: file.ref.size, sha256: file.ref.sha256, data: file.bytes.toString("base64") }); }),
  };
  const link: RoomAskLink = { current: () => true, features: new Set(["welcome-caps-v1", "room-ask-v1", ...(opts.roomFiles === false ? [] : ["room-files-v1"])]),
    sendAnswer: vi.fn(async a => { events.push("answer"); sent.push(structuredClone(a)); }),
    fetchFile: vi.fn(async (id: string, offset: number) => { events.push(`get:${id}`); return { id, offset, total: 4, sha256: "a".repeat(64), data: "ZGF0YQ==" } as HubAttachmentChunk; }),
    putFile: vi.fn(async (c: HubAttachmentChunk) => { events.push(`put:${c.id}`); }) };
  const options: RoomAskOptions = { db, bindingKey: "test-binding", encryptionKey: randomBytes(32), current: () => true,
    localExposure: id => id === ask.exposureId ? exposure : null, files: files as unknown as HubMemberFiles,
    deliver: vi.fn(async input => { if (!input.stillCurrent() || !await input.beforeInput()) return false; inputs.push(input); return true; }) };
  const adapter = new HubRoomAskAdapter(options); adapter.connected(link);
  const report = (text: string, extras?: { files?: string[]; buttons?: unknown[] }) =>
    adapter.report({ caller: exposure.agent, correlationId: inputs[0]!.correlationId, text, ...(extras ? { extras: extras as never } : {}) });
  return { ask, inputs, sent, events, files, link, adapter, report };
}

it("an ask's files are pulled into the agent's inbox and named in the prompt before it is delivered", async () => {
  const a = ref("plan.txt"), f = member({ askFiles: [a] });
  f.adapter.accept(f.ask, f.link); await f.adapter.settled();
  expect(f.events).toEqual([`get:${a.id}`]);
  expect(f.inputs[0]!.text).toContain("Files attached to the question (saved in your inbox):\n[📎 File: /inbox/plan.txt]");
});

it("on a link without room-files-v1, the prompt names the files as not available and nothing is fetched", async () => {
  const f = member({ roomFiles: false, askFiles: [ref("plan.txt")] });
  f.adapter.accept(f.ask, f.link); await f.adapter.settled();
  expect(f.link.fetchFile).not.toHaveBeenCalled();
  expect(f.inputs[0]!.text).toContain("(plan.txt: not available on this Fleet)");
});

it("an answer's files are staged before the frozen answer names them, and staged again on every resend", async () => {
  const f = member(); f.adapter.accept(f.ask, f.link); await f.adapter.settled();
  expect(await f.report("see attached", { files: ["/work/out.csv"] })).toMatchObject({ ok: true });
  const first = f.sent[0]!;
  expect(first.attachments).toHaveLength(1); expect(first.attachments![0]!.name).toBe("out.csv");
  expect(f.events).toEqual([`put:${first.attachments![0]!.id}`, "answer"]);
  await f.adapter.flush();
  expect(f.sent).toEqual([first, first]);
  expect(f.events).toEqual([`put:${first.attachments![0]!.id}`, "answer", `put:${first.attachments![0]!.id}`, "answer"]);
});

it("a files-only answer is accepted; a different answer later is refused; buttons are still refused", async () => {
  const f = member(); f.adapter.accept(f.ask, f.link); await f.adapter.settled();
  expect(await f.report("", { buttons: [{ label: "Yes" }] })).toMatchObject({ ok: false });
  expect(await f.report("", { files: ["/work/a.png"] })).toMatchObject({ ok: true });
  expect(f.sent[0]!.text).toBe("");
  expect(await f.report("", { files: ["/work/b.png"] })).toMatchObject({ ok: false, message: expect.stringContaining("different saved answer") });
  expect(await f.report("", { files: ["/work/a.png"] })).toMatchObject({ ok: true });
});

it("on a link without room-files-v1, an answer with files is refused with a reason and nothing is sent", async () => {
  const f = member({ roomFiles: false }); f.adapter.accept(f.ask, f.link); await f.adapter.settled();
  const out = await f.report("see attached", { files: ["/work/out.csv"] });
  expect(out).toMatchObject({ ok: false, message: expect.stringContaining("does not take files in rooms") });
  expect(f.sent).toHaveLength(0); expect(f.files.prepare).not.toHaveBeenCalled();
});
