/** No file opening/migration on import. Composition supplies a private DB, independent floor and transactional audit. */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { operationDigest } from "../identity.js";
import { questionContextDigest, type HubRestrictedOutbox } from "../member-journal.js";
import { authorizationSchema } from "../protocol.js";
import { epoch, hash, identifier, uuid, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import type { HubVersionFloor } from "../store.js";
import type { HubAuthorizationRequest, HubQuestion } from "../types.js";

const contextSchema = z.strictObject({ id: uuid, source: z.string().max(128), messageId: uuid, exposureId: uuid,
  bindingDigest: hash, state: z.enum(["prepared", "running", "held", "finished"]), bootId: uuid, agent: identifier });
export type ExecutionContextRecord = z.infer<typeof contextSchema>;
export interface ExecutionAuditEvent { kind: string; contextId?: string; messageId?: string; operationId?: string; reason?: string }
export interface ExecutionStoreOptions {
  floor: HubVersionFloor;
  /** Synchronous insert in this exact transaction. Throw on required audit failure. */
  audit(event: ExecutionAuditEvent, db: Database.Database): void;
}
export function migrateHubExecution(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_execution_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_execution_queue(source TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, binding_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_execution_contexts(id TEXT PRIMARY KEY, source TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_execution_operations(id TEXT PRIMARY KEY, context_id TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_execution_attention(id TEXT PRIMARY KEY, context_id TEXT NOT NULL, value TEXT NOT NULL);`);
}

export class HubExecutionStore {
  private failed = false;
  constructor(readonly database: Database.Database, private readonly options: ExecutionStoreOptions) {}
  initialize(): void {
    if (this.options.floor.read() !== 0 || this.database.prepare("SELECT 1 FROM hub_execution_meta").get()) throw new HubProtocolError("uncertain");
    this.database.prepare("INSERT INTO hub_execution_meta VALUES(1,0)").run();
  }
  check(): number {
    if (this.failed) throw new HubProtocolError("uncertain");
    try {
      const row = this.database.prepare("SELECT revision FROM hub_execution_meta WHERE singleton=1").get() as { revision: number } | undefined;
      if (!row || validated(epoch, row.revision) !== this.options.floor.read()) throw Error();
      return row.revision;
    } catch { this.failed = true; throw new HubProtocolError("uncertain"); }
  }
  private change<T>(event: ExecutionAuditEvent, work: () => T): T {
    let writing = false;
    try {
      return this.database.transaction(() => {
        const revision = this.check(), value = work(); writing = true;
        this.options.audit(event, this.database);
        this.options.floor.raise(revision + 1);
        this.database.prepare("UPDATE hub_execution_meta SET revision=? WHERE singleton=1").run(revision + 1);
        return value;
      }).immediate();
    } catch (error) { if (writing) this.failed = true; throw error; }
  }
  outbox(binding: (question: HubQuestion) => string): HubRestrictedOutbox {
    const checkSource = (q: HubQuestion, source: string) => {
      if (source !== `hub:${q.identity.issuer}:${q.identity.messageId}`) throw new HubProtocolError("denied");
    };
    return {
      insert: (db, q, source) => {
        // The S1 journal's floor/audit transaction owns this insertion. Never advance another floor inside it.
        this.check(); checkSource(q, source);
        if (db !== this.database || !db.inTransaction) throw new HubProtocolError("denied");
        if ((db.prepare("SELECT COUNT(*) AS n FROM hub_execution_queue").get() as { n: number }).n >= 4096) throw new HubProtocolError("backpressure");
        const digest = validated(hash, binding(q)), id = randomUUID();
        this.options.audit({ kind: "question.queued", messageId: q.identity.messageId }, db);
        db.prepare("INSERT INTO hub_execution_queue VALUES(?,?,?,?)").run(source, id, questionContextDigest(q), digest);
        return id;
      },
      lookup: (db, q, source) => {
        this.check(); checkSource(q, source); if (db !== this.database) throw new HubProtocolError("denied");
        const row = this.queued(source);
        if (row && row.digest !== questionContextDigest(q)) throw new HubProtocolError("conflict");
        return row?.id ?? null;
      },
    };
  }
  queued(source: string): { id: string; digest: string; binding_digest: string } | null {
    this.check(); const row = this.database.prepare("SELECT id,digest,binding_digest FROM hub_execution_queue WHERE source=?").get(source);
    return row ? validated(z.strictObject({ id: uuid, digest: hash, binding_digest: hash }), row) : null;
  }
  claim(record: ExecutionContextRecord): void {
    validated(contextSchema, record);
    this.change({ kind: "context.prepared", contextId: record.id, messageId: record.messageId }, () => {
      if ((this.database.prepare("SELECT COUNT(*) AS n FROM hub_execution_contexts").get() as { n: number }).n >= 4096) throw new HubProtocolError("backpressure");
      this.database.prepare("INSERT INTO hub_execution_contexts VALUES(?,?,?)").run(record.id, record.source, JSON.stringify(record));
    });
  }
  context(id: string): ExecutionContextRecord {
    this.check(); validated(uuid, id);
    const row = this.database.prepare("SELECT value FROM hub_execution_contexts WHERE id=?").get(id) as { value: string } | undefined;
    if (!row) throw new HubProtocolError("denied");
    const value = validated(contextSchema, parseStrictJson(row.value));
    if (value.id !== id) throw new HubProtocolError("uncertain");
    return value;
  }
  contexts(): ExecutionContextRecord[] {
    this.check();
    return (this.database.prepare("SELECT id FROM hub_execution_contexts LIMIT 4096").all() as { id: string }[]).map(r => this.context(r.id));
  }
  note(event: ExecutionAuditEvent): void { this.change(event, () => {}); }
  state(id: string, state: ExecutionContextRecord["state"]): void {
    this.change({ kind: `context.${state}`, contextId: id }, () => {
      const row = this.context(id);
      if (row.state === "held" && state !== "held" || row.state === "finished" && state !== "held") throw new HubProtocolError("stale");
      row.state = state; this.database.prepare("UPDATE hub_execution_contexts SET value=? WHERE id=?").run(JSON.stringify(row), id);
    });
  }
  reserve(contextId: string, request: HubAuthorizationRequest): void {
    const r = validated(authorizationSchema, request);
    this.change({ kind: "operation.reserved", contextId, messageId: r.messageId, operationId: r.operationId }, () => {
      const row = this.context(contextId);
      if (row.messageId !== r.messageId || !["prepared", "running"].includes(row.state)) throw new HubProtocolError("stale");
      if ((this.database.prepare("SELECT COUNT(*) AS n FROM hub_execution_operations WHERE context_id=?").get(contextId) as { n: number }).n >= 128) throw new HubProtocolError("backpressure");
      this.database.prepare("INSERT INTO hub_execution_operations VALUES(?,?,?,?)").run(r.operationId, contextId, JSON.stringify(r), "reserved");
    });
  }
  consume(contextId: string, request: HubAuthorizationRequest): void {
    this.change({ kind: "operation.consumed", contextId, operationId: request.operationId }, () => {
      const row = this.database.prepare("SELECT context_id,request,state FROM hub_execution_operations WHERE id=?").get(request.operationId) as { context_id: string; request: string; state: string } | undefined;
      if (!row || row.context_id !== contextId || row.state !== "reserved" || operationDigest(validated(authorizationSchema, parseStrictJson(row.request))) !== operationDigest(request)) throw new HubProtocolError("uncertain");
      this.database.prepare("UPDATE hub_execution_operations SET state='consumed' WHERE id=?").run(request.operationId);
    });
  }
  attention(contextId: string, id: string, value: unknown): void {
    this.change({ kind: "owner.attention", contextId }, () => {
      const existing = this.database.prepare("SELECT context_id,value FROM hub_execution_attention WHERE id=?").get(id) as { context_id: string; value: string } | undefined;
      const bytes = JSON.stringify(value);
      if (existing && (existing.context_id !== contextId || existing.value !== bytes)) throw new HubProtocolError("conflict");
      if (!existing) {
        if ((this.database.prepare("SELECT COUNT(*) AS n FROM hub_execution_attention").get() as { n: number }).n >= 256
          || (this.database.prepare("SELECT COUNT(*) AS n FROM hub_execution_attention WHERE context_id=?").get(contextId) as { n: number }).n >= 32) throw new HubProtocolError("backpressure");
        this.database.prepare("INSERT INTO hub_execution_attention VALUES(?,?,?)").run(id, contextId, bytes);
      }
    });
  }
  attentionItems(): unknown[] {
    this.check();
    return (this.database.prepare("SELECT value FROM hub_execution_attention LIMIT 4096").all() as { value: string }[]).map(r => parseStrictJson(r.value));
  }
}
