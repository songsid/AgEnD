/**
 * S5b audit (S-51; docs/design/hub-composition.md §4). One hash-chained table per database (the Hub's, or a member's
 * own), written synchronously inside the caller's transaction: if the append fails, the caller's transaction aborts,
 * so nothing is accepted, disclosed or reported as changed without its record.
 *
 * - `sequence` is S5's own monotonic key; a caller's record.sequence (S1's store revision) is kept as component_sequence.
 * - Question/answer text lives in hub_audit_content, AES-256-GCM under content.key; S5 generates every ref.
 * - Reads: only the asked owner (owner_at_event) or an assigned auditor; every read appends its own record first.
 * - Retention deletes a contiguous prefix of events and old content, keeping a checkpoint so the chain still verifies.
 */
import type Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { personKeyString } from "../directory/index.js";
import { hubTxDatabase, type HubMigration } from "../db.js";
import type { HubAuditContent, HubAuditRecord, HubAuditSink, HubRequestContext, HubTx, PersonKey } from "../types.js";

export const HUB_AUDIT_MIGRATION: HubMigration = Object.freeze({
  component: "s5-audit",
  version: 1,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_audit (
        sequence INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        at INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        message_id TEXT, room_id TEXT, fleet_id TEXT, exposure_id TEXT,
        owner_at_event TEXT, grant_id TEXT, grant_revision INTEGER,
        policy_version INTEGER NOT NULL,
        content_ref TEXT, reason_code TEXT,
        component_sequence INTEGER,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hub_audit_at ON hub_audit(at);
      CREATE INDEX IF NOT EXISTS hub_audit_exposure ON hub_audit(exposure_id);
      CREATE INDEX IF NOT EXISTS hub_audit_owner ON hub_audit(owner_at_event);
      CREATE INDEX IF NOT EXISTS hub_audit_fleet ON hub_audit(fleet_id);
      CREATE INDEX IF NOT EXISTS hub_audit_message ON hub_audit(message_id);
      CREATE TABLE IF NOT EXISTS hub_audit_head (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sequence INTEGER NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_audit_checkpoint (sequence INTEGER PRIMARY KEY, hash TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_audit_content (ref TEXT PRIMARY KEY, record_id TEXT UNIQUE, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hub_audit_content_created ON hub_audit_content(created_at);
      CREATE TABLE IF NOT EXISTS hub_auditors (person_id TEXT PRIMARY KEY, assigned_at INTEGER NOT NULL, assigned_by TEXT NOT NULL);
    `);
  },
});

const GENESIS = "0".repeat(64);
const RESULTS = new Set(["allowed", "denied", "held", "completed"]);
const ACTION = /^[a-z][a-z0-9.-]{0,127}$/;
const DAY_MS = 86_400_000;

export class HubAuditAccessError extends Error {
  constructor(message = "not allowed to read this audit") {
    super(message);
    this.name = "HubAuditAccessError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface AuditRow {
  sequence: number;
  id: string;
  at: number;
  request_id: string;
  actor: string;
  action: string;
  result: string;
  message_id: string | null;
  room_id: string | null;
  fleet_id: string | null;
  exposure_id: string | null;
  owner_at_event: string | null;
  grant_id: string | null;
  grant_revision: number | null;
  policy_version: number;
  content_ref: string | null;
  reason_code: string | null;
  component_sequence: number | null;
  prev_hash: string;
  hash: string;
}

/** The fields the hash covers: everything stored except the hash itself. */
function hashedFields(row: Omit<AuditRow, "hash">): Record<string, unknown> {
  const { prev_hash: _prev, ...rest } = row;
  return rest;
}

function chainHash(prevHash: string, row: Omit<AuditRow, "hash">): string {
  return createHash("sha256").update(`${prevHash}\n${canonical(hashedFields(row))}`).digest("hex");
}

function parsePersonId(id: string | null): PersonKey | undefined {
  if (!id) return undefined;
  const slash = id.indexOf("/");
  return slash > 0 ? { realm: id.slice(0, slash), objectId: id.slice(slash + 1) } : undefined;
}

function toRecord(row: AuditRow): HubAuditRecord {
  const owner = parsePersonId(row.owner_at_event);
  return {
    id: row.id,
    sequence: row.sequence,
    at: row.at,
    requestId: row.request_id,
    actor: JSON.parse(row.actor) as HubAuditRecord["actor"],
    action: row.action,
    result: row.result as HubAuditRecord["result"],
    policyVersion: row.policy_version,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.room_id ? { roomId: row.room_id } : {}),
    ...(row.fleet_id ? { fleetId: row.fleet_id } : {}),
    ...(row.exposure_id ? { exposureId: row.exposure_id } : {}),
    ...(owner ? { ownerAtEvent: owner } : {}),
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
    ...(row.grant_revision !== null ? { grantRevision: row.grant_revision } : {}),
    ...(row.content_ref ? { contentRef: row.content_ref } : {}),
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
  };
}

export interface HubContentPayload {
  question?: string;
  answer?: string;
  buttons?: import("../types.js").HubAnswerButtons;
  pollBallot?: import("../../reply-polls.js").PollBallot;
}

export interface HubContentStore {
  /** Encrypt and store inside `tx`; returns the S5-generated ref to use as the record's contentRef. */
  put(tx: HubTx, payload: HubContentPayload): string;
  /** For S3's own room projection after its audience check. undefined once retention removed it. */
  get(ref: string): HubContentPayload | undefined;
}

export interface HubAuditStore extends HubAuditSink {
  /** S1's store bridge: append inside the caller's own transaction on this exact database. */
  appendInTransaction(record: HubAuditRecord, database: Database.Database): void;
  readonly content: HubContentStore;
  /** Walk the chain from the latest checkpoint; reports the first sequence whose hash does not match. */
  verifyChain(): { ok: true; checked: number } | { ok: false; sequence: number };
  /** Assign or remove a security auditor (the change is itself audited, inside the same transaction). */
  setAuditor(tx: HubTx, person: PersonKey, assigned: boolean, by: HubAuditRecord["actor"], requestId: string): void;
  /**
   * Apply retention: content older than contentDays; a contiguous prefix of events older than eventDays, stopping at
   * the first one `retained` keeps (unresolved dedup/revocation evidence).
   */
  purge(retention: { contentDays: number; eventDays: number }, retained?: (record: HubAuditRecord) => boolean): { content: number; events: number };
}

export interface HubAuditOptions {
  db: Database.Database;
  /** 32 random bytes from the private content key file. */
  contentKey: Buffer;
  now?: () => number;
}

export function createHubAudit(options: HubAuditOptions): HubAuditStore {
  const { db } = options;
  if (!Buffer.isBuffer(options.contentKey) || options.contentKey.length !== 32) throw new Error("the Hub content key must be 32 bytes");
  const key = Buffer.from(options.contentKey);
  const now = options.now ?? Date.now;

  const insert = db.prepare(`INSERT INTO hub_audit (sequence, id, at, request_id, actor, action, result, message_id, room_id, fleet_id,
    exposure_id, owner_at_event, grant_id, grant_revision, policy_version, content_ref, reason_code, component_sequence, prev_hash, hash)
    VALUES (@sequence, @id, @at, @request_id, @actor, @action, @result, @message_id, @room_id, @fleet_id, @exposure_id, @owner_at_event,
    @grant_id, @grant_revision, @policy_version, @content_ref, @reason_code, @component_sequence, @prev_hash, @hash)`);

  const head = (): { sequence: number; hash: string } => {
    const row = db.prepare("SELECT sequence, hash FROM hub_audit_head WHERE singleton = 1").get() as { sequence: number; hash: string } | undefined;
    return row ?? { sequence: 0, hash: GENESIS };
  };

  /** The one write path. Caller guarantees we are inside a transaction on `db`. */
  const write = (record: HubAuditRecord): number => {
    if (!db.inTransaction) throw new Error("Hub audit is written only inside a transaction");
    if (!ACTION.test(record.action ?? "")) throw new Error("Hub audit: invalid action");
    if (!RESULTS.has(record.result)) throw new Error("Hub audit: invalid result");
    if (!Number.isSafeInteger(record.at) || !Number.isSafeInteger(record.policyVersion) || record.policyVersion < 0) throw new Error("Hub audit: invalid time or policy version");
    if (!record.actor || !["person", "local-host", "member"].includes(record.actor.kind)) throw new Error("Hub audit: invalid actor");
    const prev = head();
    const row: Omit<AuditRow, "hash"> = {
      sequence: prev.sequence + 1,
      id: typeof record.id === "string" && record.id ? record.id : randomUUID(),
      at: record.at,
      request_id: typeof record.requestId === "string" && record.requestId ? record.requestId : "-",
      actor: canonical(record.actor),
      action: record.action,
      result: record.result,
      message_id: record.messageId ?? null,
      room_id: record.roomId ?? null,
      fleet_id: record.fleetId ?? null,
      exposure_id: record.exposureId ?? null,
      owner_at_event: record.ownerAtEvent ? personKeyString(record.ownerAtEvent) : null,
      grant_id: record.grantId ?? null,
      grant_revision: record.grantRevision ?? null,
      policy_version: record.policyVersion,
      content_ref: record.contentRef ?? null,
      reason_code: record.reasonCode ?? null,
      component_sequence: Number.isSafeInteger(record.sequence) ? record.sequence : null,
      prev_hash: prev.hash,
    };
    if (record.contentRef !== undefined) bindContent(record.contentRef, row.id);
    const hash = chainHash(prev.hash, row);
    insert.run({ ...row, hash });
    db.prepare("INSERT INTO hub_audit_head(singleton, sequence, hash) VALUES(1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET sequence = excluded.sequence, hash = excluded.hash").run(row.sequence, hash);
    return row.sequence;
  };

  // GCM authenticated data binds a payload to its ref and, once its record exists, to that record's immutable id
  // (hub-composition.md §4): a ciphertext moved to another ref or record does not decrypt.
  const aad = (ref: string, recordId: string | null) => Buffer.from(`${ref}\n${recordId ?? ""}`);
  const encrypt = (ref: string, recordId: string | null, payload: HubContentPayload) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(ref, recordId));
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { nonce, body };
  };
  const decrypt = (ref: string, recordId: string | null, nonce: Buffer, body: Buffer): HubContentPayload => {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(ref, recordId));
    decipher.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as HubContentPayload;
  };

  /** Inside the record's own transaction: the content row gets the record's id, re-encrypted under it. Once only. */
  const bindContent = (ref: string, recordId: string) => {
    const row = db.prepare("SELECT record_id, nonce, ciphertext FROM hub_audit_content WHERE ref = ?").get(ref) as { record_id: string | null; nonce: Buffer; ciphertext: Buffer } | undefined;
    if (!row) throw new Error("Hub audit: contentRef was not stored in this transaction's database");
    if (row.record_id !== null) throw new Error("Hub audit: this content already belongs to another record");
    const payload = decrypt(ref, null, row.nonce, row.ciphertext);
    const { nonce, body } = encrypt(ref, recordId, payload);
    db.prepare("UPDATE hub_audit_content SET record_id = ?, nonce = ?, ciphertext = ? WHERE ref = ?").run(recordId, nonce, body, ref);
  };

  /** A bound content row, decrypted under its own (ref, record id); `expectedRecordId` must match when given. */
  const readBound = (ref: string, expectedRecordId?: string): HubContentPayload | undefined => {
    const row = db.prepare("SELECT record_id, nonce, ciphertext FROM hub_audit_content WHERE ref = ?").get(ref) as { record_id: string | null; nonce: Buffer; ciphertext: Buffer } | undefined;
    if (!row || row.record_id === null) return undefined;
    if (expectedRecordId !== undefined && row.record_id !== expectedRecordId) throw new HubAuditAccessError("this content belongs to another record");
    return decrypt(ref, row.record_id, row.nonce, row.ciphertext);
  };

  const sameDb = (tx: HubTx) => {
    if (hubTxDatabase(tx) !== db) throw new Error("Hub audit: the transaction belongs to another database");
  };

  const content: HubContentStore = {
    put(tx, payload) {
      sameDb(tx);
      const clean: HubContentPayload = {};
      if (typeof payload.question === "string") clean.question = payload.question;
      if (typeof payload.answer === "string") clean.answer = payload.answer;
      if (payload.buttons !== undefined) clean.buttons = payload.buttons;
      if (payload.pollBallot !== undefined) clean.pollBallot = payload.pollBallot;
      const ref = randomBytes(16).toString("hex");
      const { nonce, body } = encrypt(ref, null, clean);
      db.prepare("INSERT INTO hub_audit_content(ref, record_id, nonce, ciphertext, created_at) VALUES(?, NULL, ?, ?, ?)").run(ref, nonce, body, now());
      return ref;
    },
    get(ref) {
      if (typeof ref !== "string" || !/^[0-9a-f]{32}$/.test(ref)) return undefined;
      return readBound(ref);
    },
  };

  /**
   * Who is asking: resolved asynchronously (fresh session and directory eligibility). The scope itself (auditor
   * assignment, ownership) is decided later, synchronously, in the same transaction that records the read and runs the
   * query: nothing is awaited between that check and the data leaving.
   */
  const identity = async (ctx: HubRequestContext): Promise<{ personId: string; actor: HubAuditRecord["actor"] }> => {
    const actor = await ctx.current();
    if (actor.kind !== "directory") throw new HubAuditAccessError("audit is read with a directory identity; the local host is not an auditor");
    const person = await ctx.requirePerson();
    return { personId: personKeyString(person), actor: { kind: "person", person } };
  };
  const isAuditor = (personId: string) => db.prepare("SELECT 1 FROM hub_auditors WHERE person_id = ?").get(personId) !== undefined;

  const recordRead = (ctx: HubRequestContext, actor: HubAuditRecord["actor"], action: string, extra: Partial<HubAuditRecord> = {}) => {
    write({ id: randomUUID(), sequence: 0, at: now(), requestId: ctx.requestId, actor, action, result: "completed", policyVersion: 0, ...extra } as HubAuditRecord);
  };

  return {
    append(tx, record) {
      sameDb(tx);
      write(record);
    },

    appendInTransaction(record, database) {
      if (database !== db) throw new Error("Hub audit: another database");
      write(record);
    },

    content,

    async read(ctx, scope) {
      const who = await identity(ctx);
      return db.transaction(() => {
        const auditor = isAuditor(who.personId);
        const where: string[] = [];
        const args: unknown[] = [];
        if (!auditor) {
          where.push("owner_at_event = ?");
          args.push(who.personId);
        }
        if (scope.exposureId !== undefined) {
          where.push("exposure_id = ?");
          args.push(scope.exposureId);
        }
        if (scope.after !== undefined) {
          where.push("sequence > ?");
          args.push(scope.after);
        }
        // Recorded first, in the same transaction; a failed record fails the read.
        recordRead(ctx, who.actor, "audit.read", scope.exposureId ? { exposureId: scope.exposureId } : {});
        const rows = db.prepare(`SELECT * FROM hub_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sequence LIMIT 500`).all(...args) as AuditRow[];
        return rows.map(toRecord);
      }).immediate();
    },

    async readContent(ctx, recordId): Promise<HubAuditContent> {
      const who = await identity(ctx);
      return db.transaction(() => {
        const row = db.prepare("SELECT * FROM hub_audit WHERE id = ?").get(recordId) as AuditRow | undefined;
        if (!row || (!isAuditor(who.personId) && row.owner_at_event !== who.personId)) throw new HubAuditAccessError();
        recordRead(ctx, who.actor, "audit.read-content", { ...(row.message_id ? { messageId: row.message_id } : {}) });
        const payload = row.content_ref ? readBound(row.content_ref, row.id) : undefined;
        const audience: PersonKey[] = [];
        const actor = JSON.parse(row.actor) as HubAuditRecord["actor"];
        if (actor.kind === "person") audience.push(actor.person);
        const owner = parsePersonId(row.owner_at_event);
        if (owner && !audience.some((p) => personKeyString(p) === row.owner_at_event)) audience.push(owner);
        return { recordId: row.id, ...(payload?.question !== undefined ? { question: payload.question } : {}), ...(payload?.answer !== undefined ? { answer: payload.answer } : {}), audience };
      }).immediate();
    },

    verifyChain() {
      const checkpoint = db.prepare("SELECT sequence, hash FROM hub_audit_checkpoint ORDER BY sequence DESC LIMIT 1").get() as { sequence: number; hash: string } | undefined;
      let prev = checkpoint?.hash ?? GENESIS;
      let expected = (checkpoint?.sequence ?? 0) + 1;
      let checked = 0;
      for (const row of db.prepare("SELECT * FROM hub_audit WHERE sequence > ? ORDER BY sequence").iterate(checkpoint?.sequence ?? 0) as IterableIterator<AuditRow>) {
        const { hash, ...rest } = row;
        if (row.sequence !== expected || row.prev_hash !== prev || chainHash(prev, rest) !== hash) return { ok: false, sequence: row.sequence };
        prev = hash;
        expected += 1;
        checked += 1;
      }
      // The head must end exactly where the rows (or the checkpoint, or genesis) end: an erased table or suffix is
      // a broken chain even when no row is left to check.
      const h = head();
      if (h.hash !== prev || h.sequence !== expected - 1) return { ok: false, sequence: h.sequence };
      return { ok: true, checked };
    },

    setAuditor(tx, person, assigned, by, requestId) {
      sameDb(tx);
      const id = personKeyString(person);
      if (assigned) db.prepare("INSERT INTO hub_auditors(person_id, assigned_at, assigned_by) VALUES(?, ?, ?) ON CONFLICT(person_id) DO NOTHING").run(id, now(), canonical(by));
      else db.prepare("DELETE FROM hub_auditors WHERE person_id = ?").run(id);
      write({ id: randomUUID(), sequence: 0, at: now(), requestId, actor: by, action: assigned ? "audit.auditor-assigned" : "audit.auditor-removed", result: "completed", policyVersion: 0, ownerAtEvent: person } as HubAuditRecord);
    },

    purge(retention, retained) {
      for (const days of [retention.contentDays, retention.eventDays]) {
        if (!Number.isSafeInteger(days) || days < 1) throw new Error("Hub retention must be whole days (no default)");
      }
      const t = now();
      return db.transaction(() => {
        const contentCut = t - retention.contentDays * DAY_MS;
        const removedContent = db.prepare("DELETE FROM hub_audit_content WHERE created_at < ?").run(contentCut).changes;
        const eventCut = t - retention.eventDays * DAY_MS;
        let last: AuditRow | undefined;
        for (const row of db.prepare("SELECT * FROM hub_audit WHERE at < ? ORDER BY sequence").iterate(eventCut) as IterableIterator<AuditRow>) {
          if (retained?.(toRecord(row))) break;
          last = row;
        }
        let removedEvents = 0;
        if (last) {
          // A contiguous prefix only, so the chain verifies from the checkpoint onwards.
          const lowest = (db.prepare("SELECT MIN(sequence) AS s FROM hub_audit").get() as { s: number }).s;
          const gap = db.prepare("SELECT COUNT(*) AS n FROM hub_audit WHERE sequence BETWEEN ? AND ? AND at >= ?").get(lowest, last.sequence, eventCut) as { n: number };
          if (gap.n === 0) {
            db.prepare("INSERT INTO hub_audit_checkpoint(sequence, hash, at) VALUES(?, ?, ?) ON CONFLICT(sequence) DO NOTHING").run(last.sequence, last.hash, t);
            removedEvents = db.prepare("DELETE FROM hub_audit WHERE sequence <= ?").run(last.sequence).changes;
          }
        }
        write({ id: randomUUID(), sequence: 0, at: t, requestId: "retention", actor: { kind: "local-host" }, action: "audit.purge", result: "completed", policyVersion: 0, reasonCode: `content:${removedContent},events:${removedEvents}` } as HubAuditRecord);
        return { content: removedContent, events: removedEvents };
      }).immediate();
    },
  };
}
