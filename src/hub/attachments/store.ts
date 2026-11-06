/**
 * Hub attachments (attachments-v1): files stored by digest, each 180 KiB segment AES-256-GCM under the Hub content key
 * (the audit content key), so serving one chunk decrypts one segment. Rows say which room and message a file belongs
 * to and in which direction it travelled. Every method runs inside the caller's transaction (`db` is that tx's DB).
 *
 * - A question's file starts as the asker's pending upload (one hour), then is bound to the question that names it.
 * - An answer's file arrives from the member in chunks (`attachment.put`), staged under its id until the whole file is
 *   in and its SHA-256 matches; the answer that names it binds it, re-checking name, type and size.
 * - Retention deletes rows older than `contentDays`, expired uploads and staging, then blobs no row uses.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { HUB_ATTACHMENT_CHUNK } from "../protocol.js";
import { HubProtocolError } from "../validation.js";
import type { HubAttachmentRef } from "../types.js";
import { attachmentLimits, classifyAttachment, type HubAttachmentLimits } from "./limits.js";

export const UPLOAD_TTL_MS = 60 * 60 * 1000;
const STAGING_TTL_MS = 60 * 60 * 1000;
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_attachment_blobs(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_attachment_segments(sha256 TEXT NOT NULL, idx INTEGER NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, PRIMARY KEY(sha256, idx));
    CREATE TABLE IF NOT EXISTS hub_attachments(id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('question','answer')), state TEXT NOT NULL CHECK(state IN ('pending','staged','bound')),
      fleet_id TEXT, room_id TEXT, uploader TEXT, message_id TEXT, position INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER);
    CREATE INDEX IF NOT EXISTS hub_attachments_message ON hub_attachments(message_id, direction, position);
    CREATE TABLE IF NOT EXISTS hub_attachment_staging(id TEXT NOT NULL, idx INTEGER NOT NULL, fleet_id TEXT NOT NULL, total INTEGER NOT NULL, sha256 TEXT NOT NULL,
      nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id, idx));`);
}
/** Its own component (an older build that meets it refuses to open the state, as for every Hub component). */
export const HUB_ATTACHMENTS_MIGRATION = Object.freeze({ component: "s7-attachments", version: 1, up: migrate });

interface Row { id: string; sha256: string; name: string; size: number; mime: string; direction: "question" | "answer"; state: "pending" | "staged" | "bound";
  fleet_id: string | null; room_id: string | null; uploader: string | null; message_id: string | null; position: number | null; created_at: number; expires_at: number | null }
export type HubAttachmentRow = Readonly<Row>;
export const refOf = (r: Row): HubAttachmentRef => ({ id: r.id, name: r.name, size: r.size, mime: r.mime, sha256: r.sha256 });

export interface HubAttachmentStoreOptions { contentKey: Buffer; now?: () => number; limits?: Partial<HubAttachmentLimits> | null }
export class HubAttachmentStore {
  private readonly key: Buffer;
  readonly limits: HubAttachmentLimits;
  constructor(private readonly options: HubAttachmentStoreOptions) {
    if (!Buffer.isBuffer(options.contentKey) || options.contentKey.length !== 32) throw new Error("the Hub content key must be 32 bytes");
    this.key = Buffer.from(options.contentKey); this.limits = attachmentLimits(options.limits);
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private seal(aad: string, plain: Buffer): { nonce: Buffer; body: Buffer } {
    const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", this.key, nonce); c.setAAD(Buffer.from(aad));
    return { nonce, body: Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]) };
  }
  private open(aad: string, nonce: Buffer, body: Buffer): Buffer {
    const d = createDecipheriv("aes-256-gcm", this.key, nonce); d.setAAD(Buffer.from(aad)); d.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  }

  /** Store whole-file bytes under their digest (once per digest); returns the digest. */
  storeBlob(db: Database.Database, bytes: Buffer): string {
    if (bytes.length === 0 || bytes.length > this.limits.fileBytes) throw new HubProtocolError("invalid");
    const digest = sha(bytes);
    if (db.prepare("SELECT 1 FROM hub_attachment_blobs WHERE sha256=?").get(digest)) return digest;
    db.prepare("INSERT INTO hub_attachment_blobs(sha256, size, created_at) VALUES(?,?,?)").run(digest, bytes.length, this.now());
    const insert = db.prepare("INSERT INTO hub_attachment_segments(sha256, idx, nonce, ciphertext) VALUES(?,?,?,?)");
    for (let idx = 0, at = 0; at < bytes.length; idx++, at += HUB_ATTACHMENT_CHUNK) {
      const s = this.seal(`agend-hub-attachment-v1\n${digest}\n${idx}`, bytes.subarray(at, at + HUB_ATTACHMENT_CHUNK)); insert.run(digest, idx, s.nonce, s.body);
    }
    return digest;
  }
  /** One chunk of a stored file, at a chunk-aligned offset. */
  chunk(db: Database.Database, digest: string, offset: number): { data: Buffer; total: number } {
    const blob = db.prepare("SELECT size FROM hub_attachment_blobs WHERE sha256=?").get(digest) as { size: number } | undefined;
    if (!blob) throw new HubProtocolError("expired");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= blob.size || offset % HUB_ATTACHMENT_CHUNK !== 0) throw new HubProtocolError("invalid");
    const idx = offset / HUB_ATTACHMENT_CHUNK, seg = db.prepare("SELECT nonce, ciphertext FROM hub_attachment_segments WHERE sha256=? AND idx=?").get(digest, idx) as { nonce: Buffer; ciphertext: Buffer } | undefined;
    if (!seg) throw new HubProtocolError("expired");
    return { data: this.open(`agend-hub-attachment-v1\n${digest}\n${idx}`, seg.nonce, seg.ciphertext), total: blob.size };
  }
  /** A whole stored file (downloads; bounded by the file limit). */
  read(db: Database.Database, digest: string): Buffer {
    const parts: Buffer[] = []; let total = 0;
    for (let offset = 0; offset === 0 || offset < total; offset += HUB_ATTACHMENT_CHUNK) { const c = this.chunk(db, digest, offset); total = c.total; parts.push(c.data); }
    const all = Buffer.concat(parts); if (all.length !== total || sha(all) !== digest) throw new HubProtocolError("uncertain"); return all;
  }

  /** The asker's upload: classified by name and (for an image) magic bytes, stored, pending for one hour. */
  createUpload(db: Database.Database, input: { roomId: string; uploader: string; name: string; bytes: Buffer }): HubAttachmentRef {
    if (input.bytes.length > this.limits.fileBytes) throw new HubProtocolError("invalid");
    const kind = classifyAttachment(input.name, input.bytes.subarray(0, 64));
    if ("refused" in kind) throw new HubAttachmentRefused(kind.refused);
    const digest = this.storeBlob(db, input.bytes), now = this.now(), id = randomUUID();
    db.prepare(`INSERT INTO hub_attachments(id, sha256, name, size, mime, direction, state, room_id, uploader, created_at, expires_at)
      VALUES(?,?,?,?,?,'question','pending',?,?,?,?)`).run(id, digest, input.name, input.bytes.length, kind.mime, input.roomId, input.uploader, now, now + UPLOAD_TTL_MS);
    return { id, name: input.name, size: input.bytes.length, mime: kind.mime, sha256: digest };
  }
  /** The uploader's own unexpired pending files in this room, in the order named; refused as a whole otherwise. */
  pending(db: Database.Database, roomId: string, uploader: string, ids: readonly string[]): HubAttachmentRef[] {
    if (ids.length > this.limits.files || new Set(ids).size !== ids.length) throw new HubProtocolError("invalid");
    const now = this.now(), rows = ids.map(id => db.prepare("SELECT * FROM hub_attachments WHERE id=?").get(id) as Row | undefined);
    if (rows.some(r => !r || r.direction !== "question" || r.state !== "pending" || r.room_id !== roomId || r.uploader !== uploader || (r.expires_at ?? 0) <= now)) throw new HubProtocolError("not-found");
    const refs = rows.map(r => refOf(r!));
    if (refs.reduce((n, r) => n + r.size, 0) > this.limits.messageBytes) throw new HubProtocolError("invalid");
    return refs;
  }
  bindQuestion(db: Database.Database, refs: readonly HubAttachmentRef[], messageId: string, fleetId: string): void {
    const bind = db.prepare("UPDATE hub_attachments SET state='bound', message_id=?, fleet_id=?, position=?, expires_at=NULL WHERE id=? AND state='pending'");
    refs.forEach((r, i) => { if (bind.run(messageId, fleetId, i, r.id).changes !== 1) throw new HubProtocolError("conflict"); });
  }
  /** A message's files in one direction, in order. */
  forMessage(db: Database.Database, messageId: string, direction: "question" | "answer"): HubAttachmentRef[] {
    return (db.prepare("SELECT * FROM hub_attachments WHERE message_id=? AND direction=? AND state='bound' ORDER BY position").all(messageId, direction) as Row[]).map(refOf);
  }
  row(db: Database.Database, id: string): HubAttachmentRow | undefined { return db.prepare("SELECT * FROM hub_attachments WHERE id=?").get(id) as Row | undefined; }

  /** One chunk of an answer's file from the member, in order. Returns the next offset; the last chunk checks the digest. */
  stage(db: Database.Database, fleetId: string, c: { id: string; offset: number; total: number; sha256: string; data: Buffer }): { complete: boolean } {
    if (c.total > this.limits.fileBytes || c.data.length === 0 || c.data.length > HUB_ATTACHMENT_CHUNK || c.offset % HUB_ATTACHMENT_CHUNK !== 0) throw new HubProtocolError("invalid");
    const done = db.prepare("SELECT * FROM hub_attachments WHERE id=?").get(c.id) as Row | undefined;
    if (done) {
      if (done.direction !== "answer" || done.fleet_id !== fleetId || done.sha256 !== c.sha256 || done.size !== c.total) throw new HubProtocolError("conflict");
      return { complete: true };                     // a repeat after completion: the same ACK
    }
    const idx = c.offset / HUB_ATTACHMENT_CHUNK, last = c.offset + c.data.length === c.total;
    if (!last && c.data.length !== HUB_ATTACHMENT_CHUNK || c.offset + c.data.length > c.total) throw new HubProtocolError("invalid");
    const prior = db.prepare("SELECT fleet_id, total, sha256, COUNT(*) AS n, MAX(idx) AS top FROM hub_attachment_staging WHERE id=?").get(c.id) as { fleet_id: string | null; total: number; sha256: string; n: number; top: number | null };
    if (prior.n > 0 && (prior.fleet_id !== fleetId || prior.total !== c.total || prior.sha256 !== c.sha256)) throw new HubProtocolError("conflict");
    const seen = db.prepare("SELECT 1 FROM hub_attachment_staging WHERE id=? AND idx=?").get(c.id, idx);
    if (!seen) {
      if (idx !== prior.n) throw new HubProtocolError("stale");          // one chunk in flight, in order
      const s = this.seal(`agend-hub-attachment-staging-v1\n${c.id}\n${idx}`, c.data);
      db.prepare("INSERT INTO hub_attachment_staging(id, idx, fleet_id, total, sha256, nonce, ciphertext, created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(c.id, idx, fleetId, c.total, c.sha256, s.nonce, s.body, this.now());
    }
    if (!last) return { complete: false };
    const parts = (db.prepare("SELECT idx, nonce, ciphertext FROM hub_attachment_staging WHERE id=? ORDER BY idx").all(c.id) as { idx: number; nonce: Buffer; ciphertext: Buffer }[])
      .map(p => this.open(`agend-hub-attachment-staging-v1\n${c.id}\n${p.idx}`, p.nonce, p.ciphertext));
    const bytes = Buffer.concat(parts);
    db.prepare("DELETE FROM hub_attachment_staging WHERE id=?").run(c.id);
    if (bytes.length !== c.total || sha(bytes) !== c.sha256) throw new HubProtocolError("invalid");
    this.storeBlob(db, bytes);
    // Name and type are unknown until the answer names this file: placeholders, checked and filled at bind.
    db.prepare(`INSERT INTO hub_attachments(id, sha256, name, size, mime, direction, state, fleet_id, created_at, expires_at)
      VALUES(?,?,'',?,'','answer','staged',?,?,?)`).run(c.id, c.sha256, c.total, fleetId, this.now(), this.now() + STAGING_TTL_MS);
    return { complete: true };
  }
  /** Bind an answer's files: each must be a complete file this fleet sent, matching the ref's digest and size; its
   * name decides its type and an image must carry its magic bytes, exactly as for an asker's upload. */
  bindAnswer(db: Database.Database, refs: readonly HubAttachmentRef[], messageId: string, roomId: string, fleetId: string): void {
    if (refs.length > this.limits.files || refs.reduce((n, r) => n + r.size, 0) > this.limits.messageBytes) throw new HubProtocolError("invalid");
    refs.forEach((r, i) => {
      const row = db.prepare("SELECT * FROM hub_attachments WHERE id=?").get(r.id) as Row | undefined;
      if (!row || row.direction !== "answer" || row.fleet_id !== fleetId || row.sha256 !== r.sha256 || row.size !== r.size) throw new HubProtocolError("not-found");
      if (row.state === "bound") { if (row.message_id !== messageId || row.position !== i || row.name !== r.name || row.mime !== r.mime) throw new HubProtocolError("conflict"); return; }
      const kind = classifyAttachment(r.name, this.chunk(db, r.sha256, 0).data.subarray(0, 64));
      if ("refused" in kind || kind.mime !== r.mime) throw new HubProtocolError("invalid");
      db.prepare("UPDATE hub_attachments SET state='bound', name=?, mime=?, message_id=?, room_id=?, position=?, expires_at=NULL WHERE id=? AND state='staged'")
        .run(r.name, r.mime, messageId, roomId, i, r.id);
    });
  }

  /** Retention: bound files older than `contentCut`, expired uploads and staging, then blobs nothing uses. */
  purge(db: Database.Database, contentCut: number): { files: number; blobs: number } {
    const now = this.now();
    const files = db.prepare("DELETE FROM hub_attachments WHERE created_at < ? OR (state <> 'bound' AND expires_at IS NOT NULL AND expires_at <= ?)").run(contentCut, now).changes;
    db.prepare("DELETE FROM hub_attachment_staging WHERE created_at <= ?").run(now - STAGING_TTL_MS);
    const orphans = db.prepare("SELECT sha256 FROM hub_attachment_blobs b WHERE NOT EXISTS (SELECT 1 FROM hub_attachments a WHERE a.sha256 = b.sha256)").all() as { sha256: string }[];
    for (const o of orphans) { db.prepare("DELETE FROM hub_attachment_segments WHERE sha256=?").run(o.sha256); db.prepare("DELETE FROM hub_attachment_blobs WHERE sha256=?").run(o.sha256); }
    return { files, blobs: orphans.length };
  }
}
export class HubAttachmentRefused extends HubProtocolError {
  constructor(readonly refusal: "type-not-allowed" | "image-mismatch" | "empty") { super("invalid"); }
}

