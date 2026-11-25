import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { RequestContextV1Schema, RequestOperationBindingV1Schema, type RequestContextV1, type RequestOperationBindingV1 } from "./request-context-protocol.js";

/** The digest covers JSON as delivered, independent of object property insertion order. */
export function requestContextJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, visit((item as Record<string, unknown>)[key])]));
    }
    throw Error("request-context invalid JSON");
  };
  return JSON.stringify(visit(value));
}
export const requestContextDigest = (value: unknown): string => createHash("sha256").update(requestContextJson(value)).digest("hex");
const CONTEXTS = "request_contexts_v1", OPERATIONS = "request_context_operations_v1";
export interface RequestContextOperationRecord {
  binding: RequestOperationBindingV1;
  sourceKey: string;
  deliveryId: string;
  admissionSha256: string;
}
/** Internal persistence only: receipt authentication and turn ownership belong to ingress, not this store. */
export class RequestContextStore {
  constructor(private readonly db: Database.Database) {}
  private present(): boolean {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE name IN (?,?)").all(CONTEXTS, OPERATIONS);
    const marker = (this.db.pragma("table_info(deliveries)") as Array<{ name: string }>).some(row => row.name === "request_context_id");
    if (rows.length === 1 || (rows.length === 2) !== marker) throw Error("request-context incomplete companion schema");
    return rows.length === 2;
  }
  private initialize(): void {
    if (this.present()) return;
    this.db.exec(`CREATE TABLE ${CONTEXTS} (
      context_id TEXT PRIMARY KEY, parent_id TEXT REFERENCES ${CONTEXTS}(context_id),
      context_json TEXT NOT NULL, context_sha256 TEXT NOT NULL);
      CREATE TABLE ${OPERATIONS} (
      source_instance TEXT NOT NULL, operation_id TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE,
      delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(delivery_id),
      context_id TEXT NOT NULL REFERENCES ${CONTEXTS}(context_id), record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL,
      PRIMARY KEY(source_instance,operation_id));
      ALTER TABLE deliveries ADD COLUMN request_context_id TEXT REFERENCES ${CONTEXTS}(context_id);`);
  }
  context(id: string): RequestContextV1 | null {
    if (!this.present()) return null;
    const row = this.db.prepare(`SELECT context_json,context_sha256 FROM ${CONTEXTS} WHERE context_id=?`).get(id) as
      { context_json: string; context_sha256: string } | undefined;
    if (!row) return null;
    const value = RequestContextV1Schema.parse(JSON.parse(row.context_json));
    if (value.ref.contextId !== id || requestContextDigest(value) !== row.context_sha256) throw Error("request-context corrupt context");
    return value;
  }
  /** Called inside the outbox's admission transaction. Contexts are append-only; retries must match exactly. */
  recordContext(input: RequestContextV1): RequestContextV1 {
    const context = RequestContextV1Schema.parse(input);
    if (Buffer.byteLength(requestContextJson(context)) > 16 * 1024) throw Error("request-context too large");
    this.initialize();
    const previous = this.context(context.ref.contextId);
    if (previous) {
      if (requestContextJson(previous) !== requestContextJson(context)) throw Error("request-context immutable context conflict");
      return previous;
    }
    if (context.ref.parentContextId) {
      const parent = this.context(context.ref.parentContextId);
      if (!parent || parent.ref.rootContextId !== context.ref.rootContextId) throw Error("request-context missing or wrong parent");
      for (const key of ["rootEvidenceRef", "initiatingActor", "ingress", "sourceAudience", "returnAudience"] as const) {
        if (requestContextJson(parent[key] ?? null) !== requestContextJson(context[key] ?? null)) throw Error("request-context lineage conflict");
      }
    }
    this.db.prepare(`INSERT INTO ${CONTEXTS} VALUES (?,?,?,?)`).run(context.ref.contextId, context.ref.parentContextId ?? null,
      requestContextJson(context), requestContextDigest(context));
    return context;
  }
  operation(source: string, operationId: string): RequestContextOperationRecord | null {
    if (!this.present()) return null;
    const row = this.db.prepare(`SELECT * FROM ${OPERATIONS} WHERE source_instance=? AND operation_id=?`).get(source, operationId) as
      { source_key: string; delivery_id: string; context_id: string; record_json: string; record_sha256: string } | undefined;
    if (!row) {
      if (this.db.prepare("SELECT 1 FROM deliveries WHERE source_instance=? AND operation_id=? AND request_context_id IS NOT NULL LIMIT 1").get(source, operationId)) {
        throw Error("request-context missing operation");
      }
      return null;
    }
    const record = JSON.parse(row.record_json) as RequestContextOperationRecord;
    const binding = RequestOperationBindingV1Schema.parse(record.binding);
    const context = this.context(binding.contextId);
    if (requestContextDigest(record) !== row.record_sha256 || binding.source.instance !== source || binding.operationId !== operationId
      || record.sourceKey !== row.source_key || record.deliveryId !== row.delivery_id || binding.contextId !== row.context_id
      || !context || context.ref.rootContextId !== binding.rootContextId) throw Error("request-context corrupt operation");
    const delivery = this.db.prepare("SELECT source_instance,operation_id,source_key,target_instance,payload_json,request_context_id FROM deliveries WHERE delivery_id=?")
      .get(record.deliveryId) as { source_instance: string; operation_id: string; source_key: string; target_instance: string; payload_json: string; request_context_id: string } | undefined;
    if (!delivery || delivery.request_context_id !== binding.contextId || delivery.source_instance !== source
      || delivery.operation_id !== operationId || delivery.source_key !== record.sourceKey || delivery.target_instance !== binding.target.instance
      || requestContextDigest(JSON.parse(delivery.payload_json)) !== binding.payloadSha256) throw Error("request-context delivery unavailable");
    return record;
  }
  forDelivery(deliveryId: string): RequestContextOperationRecord | null {
    if (!this.present()) return null;
    const row = this.db.prepare("SELECT source_instance,operation_id,request_context_id FROM deliveries WHERE delivery_id=?")
      .get(deliveryId) as { source_instance: string; operation_id: string; request_context_id: string | null } | undefined;
    if (!row?.request_context_id) {
      if (this.db.prepare(`SELECT 1 FROM ${OPERATIONS} WHERE delivery_id=?`).get(deliveryId)) throw Error("request-context missing delivery marker");
      return null;
    }
    const record = this.operation(row.source_instance, row.operation_id);
    if (!record || record.deliveryId !== deliveryId) throw Error("request-context missing delivery companion");
    return record;
  }
  assertLegacyAdmission(source: string, operationId: string, sourceKey: string): void {
    const present = this.present();
    if (present && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_context_contacts_v1'").get()
      && this.db.prepare("SELECT 1 FROM request_context_contacts_v1 WHERE (source_instance=? AND operation_id=?) OR source_key=? LIMIT 1").get(source, operationId, sourceKey)) throw Error("request-context required for scoped retry");
    if (present && this.db.prepare(`SELECT 1 FROM deliveries WHERE request_context_id IS NOT NULL AND ((source_instance=? AND operation_id=?) OR source_key=?)
      UNION ALL SELECT 1 FROM ${OPERATIONS} WHERE (source_instance=? AND operation_id=?) OR source_key=? LIMIT 1`)
      .get(source, operationId, sourceKey, source, operationId, sourceKey)) throw Error("request-context required for scoped retry");
  }
  recordOperation(record: RequestContextOperationRecord): void {
    const marked = this.db.prepare("UPDATE deliveries SET request_context_id=? WHERE delivery_id=? AND request_context_id IS NULL")
      .run(record.binding.contextId, record.deliveryId);
    if (marked.changes !== 1) throw Error("request-context delivery binding conflict");
    this.db.prepare(`INSERT INTO ${OPERATIONS} VALUES (?,?,?,?,?,?,?)`).run(record.binding.source.instance, record.binding.operationId,
      record.sourceKey, record.deliveryId, record.binding.contextId, requestContextJson(record), requestContextDigest(record));
  }
}
