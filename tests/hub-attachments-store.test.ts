/** #3226 D: the Hub's attachment store — encrypted segments by digest, ordered staging, binding checks, retention. */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HUB_ATTACHMENTS_MIGRATION, HubAttachmentRefused, HubAttachmentStore } from "../src/hub/attachments/store.js";
import { attachmentLimits, classifyAttachment } from "../src/hub/attachments/limits.js";
import { HUB_ATTACHMENT_CHUNK } from "../src/hub/protocol.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function rig(start = 1_000_000) {
  const db = new Database(":memory:"); HUB_ATTACHMENTS_MIGRATION.up(db);
  let now = start; const store = new HubAttachmentStore({ contentKey: randomBytes(32), now: () => now });
  const tx = <T>(f: () => T): T => db.transaction(f).immediate();
  return { db, store, tx, at: (t: number) => { now = t; } };
}
const bytes = Buffer.concat([Buffer.from("a,b\n"), randomBytes(2 * HUB_ATTACHMENT_CHUNK)]);

describe("Hub attachment store", () => {
  it("stores once per digest, serves each chunk from its own segment, and the read is byte-exact", () => {
    const r = rig();
    const d = r.tx(() => r.store.storeBlob(r.db, bytes)); expect(r.tx(() => r.store.storeBlob(r.db, bytes))).toBe(d);
    expect((r.db.prepare("SELECT COUNT(*) AS n FROM hub_attachment_segments").get() as { n: number }).n).toBe(3);
    expect(r.tx(() => r.store.chunk(r.db, d, HUB_ATTACHMENT_CHUNK)).data.equals(bytes.subarray(HUB_ATTACHMENT_CHUNK, 2 * HUB_ATTACHMENT_CHUNK))).toBe(true);
    expect(r.tx(() => r.store.read(r.db, d)).equals(bytes)).toBe(true);
    expect(() => r.tx(() => r.store.chunk(r.db, d, 17))).toThrow();               // only chunk-aligned offsets
    // A segment moved to another index does not decrypt (its position is in the authenticated data).
    const seg = (i: number) => r.db.prepare("SELECT nonce, ciphertext FROM hub_attachment_segments WHERE sha256=? AND idx=?").get(d, i) as { nonce: Buffer; ciphertext: Buffer };
    const [a, b] = [seg(0), seg(1)], set = r.db.prepare("UPDATE hub_attachment_segments SET nonce=?, ciphertext=? WHERE sha256=? AND idx=?");
    set.run(b.nonce, b.ciphertext, d, 0); set.run(a.nonce, a.ciphertext, d, 1);
    expect(() => r.tx(() => r.store.read(r.db, d))).toThrow();
  });

  it("an answer's file is staged strictly in order, checked against its digest, and only then becomes bindable", () => {
    const r = rig(), id = randomUUID(), fleet = randomUUID(), digest = sha(bytes), total = bytes.length;
    const put = (offset: number, data = bytes.subarray(offset, offset + HUB_ATTACHMENT_CHUNK), f = fleet, s = digest) => r.tx(() => r.store.stage(r.db, f, { id, offset, total, sha256: s, data }));
    expect(() => put(HUB_ATTACHMENT_CHUNK)).toThrow();                            // out of order
    expect(put(0)).toEqual({ complete: false }); expect(put(0)).toEqual({ complete: false });   // a repeat is the same ACK
    expect(() => put(HUB_ATTACHMENT_CHUNK, undefined, randomUUID())).toThrow();    // another fleet's id
    expect(put(HUB_ATTACHMENT_CHUNK)).toEqual({ complete: false });
    expect(put(2 * HUB_ATTACHMENT_CHUNK)).toEqual({ complete: true });
    const ref = { id, name: "t.csv", size: total, mime: "text/csv", sha256: digest }, msg = randomUUID(), room = randomUUID();
    expect(() => r.tx(() => r.store.bindAnswer(r.db, [{ ...ref, mime: "image/png" }], msg, room, fleet))).toThrow();  // type by name, not by claim
    expect(() => r.tx(() => r.store.bindAnswer(r.db, [ref], msg, room, randomUUID()))).toThrow();                      // another fleet
    r.tx(() => r.store.bindAnswer(r.db, [ref], msg, room, fleet));
    expect(r.tx(() => r.store.forMessage(r.db, msg, "answer"))).toEqual([ref]);
  });

  it("a complete upload whose bytes do not match its digest is discarded", () => {
    const r = rig(), id = randomUUID(), data = Buffer.from("hello");
    expect(() => r.tx(() => r.store.stage(r.db, randomUUID(), { id, offset: 0, total: data.length, sha256: "0".repeat(64), data }))).toThrow();
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM hub_attachment_staging").get()).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM hub_attachments").get()).toEqual({ n: 0 });
  });

  it("retention: bound files older than the cut, expired uploads and stale staging go, then blobs nothing uses", () => {
    const r = rig(1_000_000), room = randomUUID();
    const old = r.tx(() => r.store.createUpload(r.db, { roomId: room, uploader: "corp/a", name: "old.txt", bytes: Buffer.from("old") }));
    r.tx(() => r.store.bindQuestion(r.db, [old], randomUUID(), randomUUID()));
    // Uploaded after the content cut but never used: gone once its hour is up, not by the content policy.
    r.at(1_000_000 + 10);
    r.tx(() => r.store.createUpload(r.db, { roomId: room, uploader: "corp/a", name: "unused.txt", bytes: Buffer.from("unused") }));
    r.at(1_000_000 + 2 * 3_600_000);
    const fresh = r.tx(() => r.store.createUpload(r.db, { roomId: room, uploader: "corp/a", name: "new.txt", bytes: Buffer.from("new") }));
    expect(r.tx(() => r.store.purge(r.db, 1_000_000 + 1))).toEqual({ files: 2, blobs: 2 });
    expect((r.db.prepare("SELECT id FROM hub_attachments").all() as { id: string }[]).map(x => x.id)).toEqual([fresh.id]);
  });

  it("limits can only be lowered; types by name, images by magic bytes, SVG never", () => {
    expect(attachmentLimits({ fileBytes: 999 * 1024 * 1024, files: 50, messageBytes: 1 })).toEqual({ fileBytes: 20 * 1024 * 1024, files: 10, messageBytes: 1 });
    expect(attachmentLimits({ fileBytes: 1024 })).toMatchObject({ fileBytes: 1024 });
    const small = new HubAttachmentStore({ contentKey: randomBytes(32), limits: { fileBytes: 4 } }), db = new Database(":memory:"); HUB_ATTACHMENTS_MIGRATION.up(db);
    expect(() => small.createUpload(db, { roomId: randomUUID(), uploader: "corp/a", name: "a.txt", bytes: Buffer.from("12345") })).toThrow();
    expect(classifyAttachment("a.svg", Buffer.from("<svg/>"))).toEqual({ refused: "type-not-allowed" });
    expect(classifyAttachment("a.PNG", Buffer.from("<html>"))).toEqual({ refused: "image-mismatch" });
    expect(classifyAttachment("a.gif", Buffer.from("GIF89a...."))).toEqual({ mime: "image/gif", image: true });
    expect(classifyAttachment("a.html", Buffer.from("<html>"))).toEqual({ mime: "text/html", image: false });
    expect(() => rig().store.createUpload(new Database(":memory:"), { roomId: "r", uploader: "u", name: "x.exe", bytes: Buffer.from("MZ") })).toThrow(HubAttachmentRefused);
  });
});
