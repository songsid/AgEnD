/** Durable member outbox boundary (P1: the representative adapter). No ordinary daemon or terminal API is imported here. */
import type Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { messageContentDigest, sha256, verifyLease } from "./identity.js";
import { questionSchema, answerSchema, receiptSchema, HUB_LIMITS } from "./protocol.js";
import { parseStrictJson, validated, HubProtocolError, uuid, hash, epoch } from "./validation.js";
import type { HubQuestion, HubReceipt, HubAnswer, HubAuthorizationLease, HubAuthorizationRequest, HubRevocation } from "./types.js";
import type { HubVersionFloor } from "./store.js";
// Retain two independently bounded frames: JSON escaping can make their combined payload larger than one frame.
const PAYLOAD_LIMIT = 2 * HUB_LIMITS.frame + 4096;
const rowSchema = z.strictObject({ messageId: uuid, contentDigest: hash, contextDigest: hash, operationId: uuid,
  payload: z.string().max(Math.ceil(PAYLOAD_LIMIT * 4 / 3) + 128), stage: z.enum(["preparing", "queued", "delivered", "consumed", "answered", "rejected", "cancelled", "failed", "uncertain"]),
  sequence: epoch, at: epoch, deliveryId: uuid.nullable(), inputIntent: uuid.nullable(), ackedSequence: epoch });
type Row = z.infer<typeof rowSchema>;
export interface HubRestrictedOutbox {
  /**
   * Same DB transaction, unique source key. P1: the representative adapter (docs/design/hub-representative-agent.md,
   * approved), which hands the question to the owner's published agent through ordinary delivery; the isolated S4
   * context is off and uncomposed in P1.
   */
  insert(db: Database.Database, question: HubQuestion, sourceKey: string): string;
  /** Re-reads the unique source row. It must match the same question and restricted context or throw. */
  lookup(db: Database.Database, question: HubQuestion, sourceKey: string): string | null;
}
export interface HubKnownMessagesPage {
  messages: readonly { messageId: string; contentDigest: string }[];
  nextAfterMessageId: string | null;
}
export interface HubUnackedReceiptsPage {
  receipts: readonly HubReceipt[]; nextAfterSequence: number; more: boolean;
}
const pageLimit = z.number().int().min(1).max(128).default(128);
const knownPage = z.strictObject({ afterMessageId: uuid.optional(), limit: pageLimit });
const receiptsPage = z.strictObject({ afterSequence: epoch.default(0), limit: pageLimit });
export interface HubJournalOptions {
  hubId: string; encryptionKey: Buffer; floor: HubVersionFloor; outbox: HubRestrictedOutbox; now?: () => number;
}
export function migrateHubMemberJournal(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_member_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, receipt_sequence INTEGER NOT NULL, revocation_version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_member_messages(message_id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}
export const HUB_MEMBER_JOURNAL_MIGRATION = Object.freeze({ component: "s1-member-journal", version: 1, up: migrateHubMemberJournal });
/** Signature refresh may change time/nonce/revocation but cannot redirect a previously admitted question. */
export function questionContextDigest(q: HubQuestion): string {
  const e = q.identity;
  return sha256(JSON.stringify(["agend-hub-message-v1", e.issuer, e.issuerKeyId, e.messageId, e.asker.realm, e.asker.objectId,
    e.owner.realm, e.owner.objectId, e.destinationFleetId, e.exposureId, e.roomId, e.grantId, e.grantRevision, e.exposureRevision, e.contentDigest]));
}
export class HubMemberJournal {
  private failed = false;
  constructor(private readonly db: Database.Database, private readonly options: HubJournalOptions) {
    validated(uuid, options.hubId); if (options.encryptionKey.length !== 32) throw new HubProtocolError();
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  initialize(): void {
    if (this.options.floor.read() !== 0 || this.db.prepare("SELECT 1 FROM hub_member_meta").get()) throw new HubProtocolError("conflict");
    this.db.prepare("INSERT INTO hub_member_meta VALUES(1,0,0,0)").run();
  }
  private meta(): { revision: number; receipt_sequence: number; revocation_version: number } {
    if (this.failed) throw new HubProtocolError("uncertain");
    const m = this.db.prepare("SELECT revision,receipt_sequence,revocation_version FROM hub_member_meta WHERE singleton=1").get() as { revision: number; receipt_sequence: number; revocation_version: number } | undefined;
    if (!m || ![m.revision, m.receipt_sequence, m.revocation_version].every(n => Number.isSafeInteger(n) && n >= 0) || this.options.floor.read() !== m.revision) { this.failed = true; throw new HubProtocolError("uncertain"); } return m;
  }
  private change<T>(fn: () => T): T {
    let writing = false;
    try { return this.db.transaction(() => {
      const m = this.meta(), result = fn(); writing = true; this.options.floor.raise(m.revision + 1);
      this.db.prepare("UPDATE hub_member_meta SET revision=? WHERE singleton=1").run(m.revision + 1); return result;
    }).immediate(); } catch (error) { if (writing) this.failed = true; throw error; }
  }
  private row(messageId: string): Row | null {
    this.meta(); validated(uuid, messageId); const r = this.db.prepare("SELECT value FROM hub_member_messages WHERE message_id=?").get(messageId) as { value: string } | undefined;
    if (!r) return null;
    const row = validated(rowSchema, parseStrictJson(r.value, 1024 * 1024)); if (row.messageId !== messageId || row.ackedSequence > row.sequence || row.sequence > this.meta().receipt_sequence
      || row.stage === "preparing" && (row.sequence !== 0 || row.deliveryId !== null || row.inputIntent !== null)
      || ["delivered", "consumed", "answered"].includes(row.stage) && !row.inputIntent
      || row.stage !== "preparing" && row.sequence === 0) throw new HubProtocolError("uncertain"); return row;
  }
  private write(row: Row): void { validated(rowSchema, row); this.db.prepare("INSERT INTO hub_member_messages VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET value=excluded.value").run(row.messageId, JSON.stringify(row)); }
  private source(messageId: string): string { return `hub:${this.options.hubId}:${messageId}`; }
  private aad(row: Pick<Row, "messageId" | "contentDigest" | "contextDigest">): Buffer { return Buffer.from(JSON.stringify(["agend-hub-local-payload-v1", this.options.hubId, row.messageId, row.contentDigest, row.contextDigest])); }
  private encrypt(value: { question: HubQuestion; answer?: HubAnswer }, row: Pick<Row, "messageId" | "contentDigest" | "contextDigest">): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.options.encryptionKey, iv); cipher.setAAD(this.aad(row));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map(b => b.toString("base64url")).join(".");
  }
  private decrypt(row: Row): { question: HubQuestion; answer?: HubAnswer } {
    try {
      const parts = row.payload.split("."); if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw Error();
      const [iv, tag, bytes] = parts.map(p => Buffer.from(p, "base64url")); if (iv.length !== 12 || tag.length !== 16) throw Error();
      const cipher = createDecipheriv("aes-256-gcm", this.options.encryptionKey, iv); cipher.setAAD(this.aad(row)); cipher.setAuthTag(tag);
      const payload = validated(z.strictObject({ question: questionSchema, answer: answerSchema.optional() }), parseStrictJson(Buffer.concat([cipher.update(bytes), cipher.final()]), PAYLOAD_LIMIT));
      if (payload.question.identity.messageId !== row.messageId || payload.question.identity.contentDigest !== row.contentDigest || questionContextDigest(payload.question) !== row.contextDigest) throw Error();
      return payload;
    } catch { this.failed = true; throw new HubProtocolError("uncertain"); }
  }
  prepare(question: HubQuestion): { operationId: string; receipt: HubReceipt | null } {
    const q = validated(questionSchema, question); if (q.identity.issuer !== this.options.hubId || q.identity.contentDigest !== messageContentDigest("question", q.text, { attachments: q.attachments })) throw new HubProtocolError("denied");
    return this.change(() => {
      const existing = this.row(q.identity.messageId);
      if (existing) {
        if (existing.contentDigest !== q.identity.contentDigest || existing.contextDigest !== questionContextDigest(q)) throw new HubProtocolError("conflict");
        this.decrypt(existing); return { operationId: existing.operationId, receipt: this.receipt(existing) };
      }
      if ((this.db.prepare("SELECT COUNT(*) AS n FROM hub_member_messages").get() as { n: number }).n >= 4096) throw new HubProtocolError("backpressure");
      const row: Row = { messageId: q.identity.messageId, contentDigest: q.identity.contentDigest, contextDigest: questionContextDigest(q),
        operationId: randomUUID(), payload: "", stage: "preparing", sequence: 0, at: this.now(), deliveryId: null, inputIntent: null, ackedSequence: 0 };
      row.payload = this.encrypt({ question: q }, row); this.write(row); return { operationId: row.operationId, receipt: null };
    });
  }
  private receipt(row: Row): HubReceipt | null {
    if (row.stage === "preparing") return null;
    return validated(receiptSchema, { messageId: row.messageId, contentDigest: row.contentDigest, stage: row.stage,
      sequence: row.sequence, at: row.at, ...(row.deliveryId ? { memberDeliveryId: row.deliveryId } : {}) });
  }
  private advance(row: Row, stage: Exclude<Row["stage"], "preparing">): HubReceipt {
    const m = this.meta(); row.stage = stage; row.at = this.now(); row.sequence = m.receipt_sequence + 1;
    this.db.prepare("UPDATE hub_member_meta SET receipt_sequence=? WHERE singleton=1").run(row.sequence); this.write(row); return this.receipt(row)!;
  }
  private authorize(row: Row, request: HubAuthorizationRequest, lease: HubAuthorizationLease, fence: { current(): boolean; linkEpoch: number; revocationVersion: number }): { question: HubQuestion; answer?: HubAnswer } {
    if (!fence.current() || request.messageId !== row.messageId || fence.revocationVersion < this.meta().revocation_version) throw new HubProtocolError("stale");
    const data = this.decrypt(row);
    if (request.exposureRevision !== data.question.identity.exposureRevision) throw new HubProtocolError("stale");
    verifyLease(lease, request, { ...fence, now: this.now() }); return data;
  }
  commitAdmission(question: HubQuestion, request: HubAuthorizationRequest, lease: HubAuthorizationLease, fence: { current(): boolean; linkEpoch: number; revocationVersion: number }): HubReceipt {
    return this.change(() => {
      const row = this.row(question.identity.messageId);
      if (!row || row.contextDigest !== questionContextDigest(question) || row.operationId !== request.operationId || request.phase !== "admit" || !fence.current()) throw new HubProtocolError("stale");
      this.authorize(row, request, lease, fence);
      if (row.stage !== "preparing") return this.receipt(row)!;
      const existing = this.options.outbox.lookup(this.db, question, this.source(row.messageId));
      if (existing) throw new HubProtocolError("uncertain"); // a source row without our atomic receipt is inconsistent, never re-admitted
      const deliveryId = validated(uuid, this.options.outbox.insert(this.db, question, this.source(row.messageId)));
      if (!fence.current()) throw new HubProtocolError("stale");
      row.deliveryId = deliveryId; return this.advance(row, "queued");
    });
  }
  /**
   * The admitted question for its representative hand-off (docs/design/hub-representative-agent.md): only while it is
   * queued with no input intent, i.e. before anything reached the agent. Later stages never re-read the text.
   */
  queuedQuestion(messageId: string): HubQuestion {
    const row = this.row(messageId);
    if (!row || row.stage !== "queued" || row.inputIntent) throw new HubProtocolError("uncertain");
    return this.decrypt(row).question;
  }
  markInputIntent(messageId: string, request: HubAuthorizationRequest, lease: HubAuthorizationLease, fence: { current(): boolean; linkEpoch: number; revocationVersion: number }): void {
    this.change(() => {
      const row = this.row(messageId); if (!row || row.stage !== "queued" || row.inputIntent || request.phase !== "begin" || request.messageId !== messageId || !fence.current()) throw new HubProtocolError("uncertain");
      this.authorize(row, request, lease, fence); row.inputIntent = request.operationId; this.write(row);
    });
  }
  recordEvidence(messageId: string, stage: "delivered" | "consumed" | "uncertain"): HubReceipt {
    return this.change(() => {
      const row = this.row(messageId);
      const allows = stage === "delivered" ? row?.stage === "queued" : stage === "consumed" ? row?.stage === "delivered" : row && ["queued", "uncertain"].includes(row.stage);
      if (!row || !row.inputIntent || !allows) throw new HubProtocolError("uncertain");
      return this.advance(row, stage);
    });
  }
  saveAnswer(answer: HubAnswer, request: HubAuthorizationRequest, fence: { current(): boolean; linkEpoch: number; revocationVersion: number }): HubReceipt {
    const a = validated(answerSchema, answer);
    return this.change(() => {
      const row = this.row(a.messageId); if (!row || !row.inputIntent || !["consumed", "uncertain", "answered"].includes(row.stage) || !fence.current()
        || request.phase !== "release-answer" || request.answer.answerId !== a.answerId || request.answer.contentDigest !== a.contentDigest || messageContentDigest("answer", a.text, { attachments: a.attachments }) !== a.contentDigest) throw new HubProtocolError("denied");
      const data = this.authorize(row, request, a.releaseLease, fence);
      if (data.answer) {
        if (data.answer.answerId !== a.answerId || data.answer.contentDigest !== a.contentDigest) throw new HubProtocolError("conflict");
        return this.receipt(row)!;
      }
      data.answer = a; row.payload = this.encrypt(data, row); return this.advance(row, "answered");
    });
  }
  recoverInterruptedInputs(): readonly HubReceipt[] {
    return this.change(() => {
      const receipts: HubReceipt[] = [];
      for (const r of this.db.prepare("SELECT message_id FROM hub_member_messages").all() as { message_id: string }[]) {
        const row = this.row(r.message_id)!; this.decrypt(row);
        if (row.inputIntent && row.stage === "queued") receipts.push(this.advance(row, "uncertain"));
      } return receipts;
    });
  }
  reconcile(after: number, ids: readonly { messageId: string; contentDigest: string }[]): readonly HubReceipt[] {
    validated(epoch, after); if (ids.length > 128) throw new HubProtocolError("backpressure"); this.meta();
    const out: HubReceipt[] = [];
    for (const id of ids) {
      validated(uuid, id.messageId); validated(hash, id.contentDigest); const row = this.row(id.messageId);
      if (!row) continue; if (row.contentDigest !== id.contentDigest) throw new HubProtocolError("conflict"); this.decrypt(row);
      const receipt = this.receipt(row); if (receipt && receipt.sequence > after) out.push(receipt);
    } return out.sort((a, b) => a.sequence - b.sequence);
  }
  /** Bounded metadata only; never expose stored question/answer bytes to composition. */
  knownMessages(input: { afterMessageId?: string; limit?: number } = {}): HubKnownMessagesPage {
    const page = validated(knownPage, input); this.meta();
    const rows = this.db.prepare("SELECT message_id FROM hub_member_messages WHERE message_id>? ORDER BY message_id LIMIT ?").all(page.afterMessageId ?? "", page.limit + 1) as { message_id: string }[];
    const messages = rows.slice(0, page.limit).map(id => {
      const row = this.row(id.message_id); if (!row) throw new HubProtocolError("uncertain"); this.decrypt(row);
      return { messageId: row.messageId, contentDigest: row.contentDigest };
    });
    return { messages, nextAfterMessageId: rows.length > page.limit ? messages.at(-1)!.messageId : null };
  }
  unackedReceipts(input: { afterSequence?: number; limit?: number } = {}): HubUnackedReceiptsPage {
    const page = validated(receiptsPage, input); this.meta();
    const rows = this.db.prepare(`SELECT message_id FROM hub_member_messages
      WHERE json_extract(value,'$.stage')!='preparing' AND json_extract(value,'$.sequence')>json_extract(value,'$.ackedSequence')
      AND json_extract(value,'$.sequence')>? ORDER BY json_extract(value,'$.sequence') LIMIT ?`).all(page.afterSequence, page.limit + 1) as { message_id: string }[];
    const receipts = rows.slice(0, page.limit).map(id => {
      const row = this.row(id.message_id); if (!row) throw new HubProtocolError("uncertain"); this.decrypt(row);
      const receipt = this.receipt(row); if (!receipt || row.ackedSequence >= row.sequence || receipt.sequence <= page.afterSequence) throw new HubProtocolError("uncertain"); return receipt;
    });
    return { receipts, nextAfterSequence: receipts.at(-1)?.sequence ?? page.afterSequence, more: rows.length > page.limit };
  }
  revocationVersion(): number { return this.meta().revocation_version; }
  /** A welcome version is a durable lower bound, never a lease or a fabricated scoped revocation. */
  observeRevocationVersion(version: number): void {
    validated(epoch, version); const current = this.revocationVersion();
    if (version < current) throw new HubProtocolError("stale"); if (version === current) return;
    this.change(() => { this.db.prepare("UPDATE hub_member_meta SET revocation_version=? WHERE singleton=1").run(version); });
  }
  acknowledge(receipt: HubReceipt): void {
    const r = validated(receiptSchema, receipt), row = this.row(r.messageId);
    if (!row || row.contentDigest !== r.contentDigest || r.sequence > row.sequence) throw new HubProtocolError("conflict");
    // Older committed evidence may arrive after local evidence advanced. Ignore it, never ACK/downgrade the newer row.
    if (r.sequence < row.sequence) return;
    if (row.stage !== r.stage) throw new HubProtocolError("conflict");
    if (row.ackedSequence === r.sequence) return;
    this.change(() => { row.ackedSequence = r.sequence; this.write(row); });
  }
  fence(revocation: HubRevocation, fenceLocal: (messageId: string) => void): readonly HubReceipt[] {
    return this.change(() => {
      const m = this.meta(); if (revocation.revocationVersion < m.revocation_version) throw new HubProtocolError("stale");
      const results: HubReceipt[] = [];
      for (const r of this.db.prepare("SELECT message_id FROM hub_member_messages").all() as { message_id: string }[]) {
        const row = this.row(r.message_id)!, e = this.decrypt(row).question.identity, scope = revocation.scope;
        const matches = scope.kind === "fleet" ? scope.fleetId === e.destinationFleetId : scope.kind === "exposure" ? scope.exposureId === e.exposureId : scope.kind === "grant" ? scope.grantId === e.grantId : scope.personId === `${e.asker.realm}/${e.asker.objectId}` || scope.personId === `${e.owner.realm}/${e.owner.objectId}`;
        if (matches && !["cancelled", "rejected", "failed"].includes(row.stage)) {
          fenceLocal(row.messageId);
          // Existing positive delivery/consumption/answer evidence is never downgraded by a policy change.
          if (["delivered", "consumed", "answered"].includes(row.stage)) results.push(this.receipt(row)!);
          else results.push(this.advance(row, row.inputIntent ? "uncertain" : "cancelled"));
        }
      }
      this.db.prepare("UPDATE hub_member_meta SET revocation_version=? WHERE singleton=1").run(revocation.revocationVersion); return results;
    });
  }
}
