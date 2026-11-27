import { requestContextDigest } from "./request-context-store.js";
import { RETIRABLE_LEGACY_DISPOSITIONS, legacyTicketDigest } from "./request-context-migration.js";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { ContactGrant, ContactHistoryRow, ContactOrigin, ContactOriginClear, ContactPerson, ContactPermissionsWrite, ContactRoomTools, ContactTicket, ContactTicketDecision, ContactVerb } from "./contact-auth-types.js";

export const CONTACT_APPLICATION_TTL_MS = 30 * 60_000;
/** M-3716: an approved message still queued this long after the decision is announced as approved and queued. */
export const CONTACT_APPROVAL_NOTICE_WAIT_MS = 2 * 60_000;
/** M-3716: outbox states of a delivery still on its way to the target. */
export const CONTACT_DELIVERY_IN_FLIGHT: readonly string[] = ["queued", "delivering", "submission_started", "retry_wait"];
/** M-3716: what the requester is told about one held request. */
export type ContactOutcome = "declined" | "expired" | "delivered" | "unconfirmed" | "queued";
export interface ContactRequest {
  requestContext?: import("./request-context-protocol.js").RequestContextRefV1;
  operationId: string;
  source: string;
  target: string;
  sourceGeneration: string;
  targetGeneration: string;
  verb: ContactVerb;
  origin: ContactOrigin;
  message: string;
  correlationId: string;
  correlationExplicit?: boolean;
  resultRecipient: string;
  payload: Record<string, unknown>;
  forwards?: readonly string[];
}
export interface ContactDecisionAuthority {
  requestContextVersion?: 1;
  rootApprovalTicketId?: string;
  canDecide(target: string, actor: ContactPerson): boolean;
  /** Checks generations, current policy and prior Hub contact restriction. */
  current(request: ContactRequest): boolean;
  /** Synchronous admission using this SAME SQLite connection, within the decision transaction. */
  admit(request: ContactRequest, ticketId: string): string;
}
type TicketRow = { id: string; request_json: string; request_hash: string; ticket_json: string };
export interface ContactStoredPolicy {
  revision: number;
  generation?: string;
  approvers?: ContactPerson[];
  grants: ContactGrant[];
  roomTools: ContactRoomTools;
}
export function contactPersonKey(person: ContactPerson): string {
  return JSON.stringify([person.platform, person.userId]);
}
function unique<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map(value => [key(value), value])).values()];
}
/** A bot adapter records the route/proof, not a different human on the same platform. */
export function normalizeContactPersonKey(value: string): string | undefined {
  try {
    const parts: unknown = JSON.parse(value);
    if (!Array.isArray(parts) || ![2, 3].includes(parts.length) || !["discord", "telegram", "host"].includes(parts[0])
      || !parts.every(part => typeof part === "string" && part.length > 0)) return;
    return JSON.stringify([parts[0], parts[parts.length - 1]]);
  } catch { return; }
}
export function normalizeContactOrigin(origin: ContactOrigin): ContactOrigin {
  const people = unique(origin.people, contactPersonKey);
  // Only collapse a known duplicate-person union. Explicit unknown and a mixed single-person marker stay restricted.
  const duplicatePerson = origin.kind === "mixed" && origin.people.length > 1 && people.length === 1;
  const kind = origin.kind === "unknown" || people.length > 16 ? "unknown"
    : origin.kind === "mixed" && !duplicatePerson ? "mixed" : people.length === 1 ? "human" : "mixed";
  return { kind, people: people.slice(0, 16), receiptIds: [...new Set(origin.receiptIds)].slice(-64), chain: [...new Set(origin.chain)].slice(-32) };
}
export function mergeContactOrigins(before: ContactOrigin | undefined, next: ContactOrigin): ContactOrigin {
  next = normalizeContactOrigin(next);
  if (!before) return next;
  before = normalizeContactOrigin(before);
  const people = unique([...before.people, ...next.people], contactPersonKey);
  const unknown = before.kind === "unknown" || next.kind === "unknown" || people.length > 16;
  return { kind: unknown ? "unknown" : people.length === 1 && before.kind !== "mixed" && next.kind !== "mixed" ? "human" : "mixed",
    people: people.slice(0, 16), receiptIds: [...new Set([...before.receiptIds, ...next.receiptIds])].slice(-64),
    chain: [...new Set([...before.chain, ...next.chain])].slice(-32) };
}

/**
 * M-3897 (Sentinel's Go back contract): a read-only image of every owner retirement of an earlier ticket, for the Go back
 * guard to compare a snapshot's outbox with the current one. A Go back must never undo a retirement: a snapshot whose image
 * differs from the current one (a retirement since) is not restored. "none" when the table does not exist (older homes).
 */
export function contactRetirementImage(db: Database.Database): string {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contact_auth_retirements'").get()) return "none";
  const rows = db.prepare("SELECT ticket_id,ticket_sha256,disposition FROM contact_auth_retirements ORDER BY ticket_id,ticket_sha256").all();
  return rows.length ? createHash("sha256").update(JSON.stringify(rows)).digest("hex") : "none";
}

/** Server-private data, on the durable outbox connection so approval and admission commit together. */
export class ContactAuthStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS contact_auth_tickets (
      id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL, ticket_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_auth_origins (instance TEXT PRIMARY KEY, origin_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_auth_policies (instance TEXT PRIMARY KEY, revision INTEGER NOT NULL, policy_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_auth_history (id TEXT PRIMARY KEY, instance TEXT NOT NULL, at INTEGER NOT NULL, row_json TEXT NOT NULL);`);
    db.exec("CREATE TABLE IF NOT EXISTS contact_auth_suggestions (instance TEXT PRIMARY KEY, dismissed_at INTEGER NOT NULL)");
    // M-3897: an owner's retirement of an earlier ticket nothing can settle (no readable delivery record). Append-only,
    // bound to the ticket's exact stored image: the ticket row itself is kept as it is (outcome unknown, history kept).
    db.exec("CREATE TABLE IF NOT EXISTS contact_auth_retirements (ticket_id TEXT NOT NULL, ticket_sha256 TEXT NOT NULL, disposition TEXT NOT NULL, retired_at INTEGER NOT NULL, actor_json TEXT NOT NULL, PRIMARY KEY (ticket_id, ticket_sha256))");
    db.exec("CREATE TABLE IF NOT EXISTS contact_auth_origin_revisions (instance TEXT PRIMARY KEY, revision INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS contact_auth_room_context (instance TEXT PRIMARY KEY, context_json TEXT NOT NULL)");
    // M-3381: when the restricted-mode suggestion was first raised for a room (its age counts from here, not from the room).
    db.exec("CREATE TABLE IF NOT EXISTS contact_auth_suggestion_raised (instance TEXT PRIMARY KEY, raised_at INTEGER NOT NULL)");
    db.transaction(() => {
      const existed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contact_auth_outcome_notices'").get();
      db.exec("CREATE TABLE IF NOT EXISTS contact_auth_outcome_notices (ticket_id TEXT PRIMARY KEY)");
      // Do not re-announce decisions already terminal before this feature was installed.
      if (!existed) db.exec("INSERT INTO contact_auth_outcome_notices SELECT id FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.state') IN ('declined','expired')");
      // M-3716: approvals are announced too; approvals from before this table are not.
      const approvals = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contact_auth_approval_notices'").get();
      db.exec("CREATE TABLE IF NOT EXISTS contact_auth_approval_notices (ticket_id TEXT PRIMARY KEY)");
      if (!approvals) db.exec("INSERT INTO contact_auth_approval_notices SELECT id FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.state')='approved'");
    })();
  }
  roomContext(instance: string, generation?: string): { threadId?: string; fileIds: string[] } {
    const row = this.db.prepare("SELECT context_json FROM contact_auth_room_context WHERE instance=?").get(instance) as { context_json: string } | undefined;
    const context = row ? JSON.parse(row.context_json) as { generation?: string; threadId?: string; fileIds: string[] } : undefined;
    return context && (!generation || context.generation === generation) ? context : { fileIds: [] };
  }
  recordRoomContext(instance: string, input: { threadId?: string; fileIds: string[] }, generation?: string): void {
    const prior = this.roomContext(instance, generation);
    const next = { generation, threadId: input.threadId, fileIds: [...new Set([...prior.fileIds, ...input.fileIds])].slice(-256) };
    this.db.prepare("INSERT INTO contact_auth_room_context VALUES (?,?) ON CONFLICT(instance) DO UPDATE SET context_json=excluded.context_json")
      .run(instance, JSON.stringify(next));
  }
  /** M-3381: when the restricted-mode suggestion was first raised for `instance` (recorded now, the first time it is asked). */
  suggestionRaisedAt(instance: string): number {
    this.db.prepare("INSERT INTO contact_auth_suggestion_raised VALUES (?,?) ON CONFLICT(instance) DO NOTHING").run(instance, this.now());
    return (this.db.prepare("SELECT raised_at FROM contact_auth_suggestion_raised WHERE instance=?").get(instance) as { raised_at: number }).raised_at;
  }
  suggestionDismissed(instance: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM contact_auth_suggestions WHERE instance=?").get(instance);
  }
  dismissSuggestion(instance: string): void {
    this.db.prepare("INSERT INTO contact_auth_suggestions VALUES (?,?) ON CONFLICT(instance) DO UPDATE SET dismissed_at=excluded.dismissed_at").run(instance, this.now());
  }
  inheritOrigin(instance: string, origin: ContactOrigin): ContactOrigin {
    return this.db.transaction(() => {
      const combined = mergeContactOrigins(this.origin(instance), origin);
      this.db.prepare("INSERT INTO contact_auth_origins VALUES (?,?) ON CONFLICT(instance) DO UPDATE SET origin_json=excluded.origin_json")
        .run(instance, JSON.stringify(combined));
      this.bumpOriginRevision(instance);
      return combined;
    })();
  }
  private bumpOriginRevision(instance: string): void {
    this.db.prepare("INSERT INTO contact_auth_origin_revisions VALUES (?,1) ON CONFLICT(instance) DO UPDATE SET revision=revision+1").run(instance);
  }
  originRevision(instance: string): number {
    return (this.db.prepare("SELECT revision FROM contact_auth_origin_revisions WHERE instance=?").get(instance) as { revision: number } | undefined)?.revision ?? 0;
  }
  clearOrigin(instance: string, input: ContactOriginClear, actor: ContactPerson, currentGeneration: () => string): void {
    this.db.transaction(() => {
      const generation = currentGeneration();
      if (generation !== input.generation || this.policy(instance, generation).revision !== input.revision
        || this.originRevision(instance) !== input.originRevision) throw Error("conflict");
      const before = this.origin(instance);
      if (!before) throw Error("conflict");
      const after: ContactOrigin = { kind: "human", people: [actor], receiptIds: [], chain: [instance] };
      this.db.prepare("UPDATE contact_auth_origins SET origin_json=? WHERE instance=?").run(JSON.stringify(after), instance);
      this.bumpOriginRevision(instance);
      const image = (value: ContactOrigin) => ({ kind: value.kind, people: value.people, chain: value.chain, receiptCount: value.receiptIds.length });
      this.history(instance, actor, "origin-clear", "", undefined, undefined, { generation, originChange: { before: image(before), after: image(after) } });
    })();
  }
  lastOriginClear(instance: string, generation: string): { actor: ContactPerson; at: string } | undefined {
    const row = this.db.prepare("SELECT row_json FROM contact_auth_history WHERE instance=? AND json_extract(row_json,'$.action')='origin-clear' "
      + "AND json_extract(row_json,'$.generation')=? ORDER BY at DESC,rowid DESC LIMIT 1").get(instance, generation) as { row_json: string } | undefined;
    if (!row) return;
    const entry = JSON.parse(row.row_json) as ContactHistoryRow;
    return { actor: entry.actor, at: entry.at };
  }
  origin(instance: string): ContactOrigin | undefined {
    const row = this.db.prepare("SELECT origin_json FROM contact_auth_origins WHERE instance=?").get(instance) as { origin_json: string } | undefined;
    return row ? normalizeContactOrigin(JSON.parse(row.origin_json) as ContactOrigin) : undefined;
  }
  policy(instance: string, generation?: string): ContactStoredPolicy {return this.readPolicy(instance,generation,true);}
  policySnapshot(instance:string,generation?:string):ContactStoredPolicy {return this.readPolicy(instance,generation,false);}
  private readPolicy(instance: string, generation: string|undefined, persist:boolean): ContactStoredPolicy {
    const row = this.db.prepare("SELECT policy_json FROM contact_auth_policies WHERE instance=?").get(instance) as { policy_json: string } | undefined;
    const previous = row ? JSON.parse(row.policy_json) as ContactStoredPolicy : undefined;
    if (previous && (!generation || previous.generation === generation)) return previous;
    const fresh: ContactStoredPolicy = { revision: previous ? previous.revision + 1 : 0,
      ...(generation ? { generation } : {}), grants: [], roomTools: { publicRead: true, allowedMcpTools: [], wouldDisable: [] } };
    if (persist && previous && generation) this.db.prepare("UPDATE contact_auth_policies SET revision=?,policy_json=? WHERE instance=?")
      .run(fresh.revision, JSON.stringify(fresh), instance);
    return fresh;
  }
  writePolicy(instance: string, input: ContactPermissionsWrite, actor: ContactPerson, generation?: (name: string) => string): ContactStoredPolicy {
    return this.db.transaction(() => {
      const previous = this.policy(instance, generation?.(instance));
      if (input.revision !== previous.revision) throw Error("conflict");
      const now = new Date(this.now()).toISOString();
      const next: ContactStoredPolicy = { revision: previous.revision + 1, generation: generation?.(instance) ?? previous.generation,
        approvers: input.approvers ?? previous.approvers,
        roomTools: input.roomTools ? { ...input.roomTools, wouldDisable: [] } : previous.roomTools,
        grants: input.grants ? input.grants.map(grant => {
          const old = previous.grants.find(row => row.id === grant.id);
          return { ...grant, id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? now, createdBy: old?.createdBy ?? actor,
            sourceGeneration: old?.source === grant.source ? old.sourceGeneration : generation?.(grant.source) ?? (grant as ContactGrant).sourceGeneration,
            targetGeneration: old?.target === grant.target ? old.targetGeneration : generation?.(grant.target) ?? (grant as ContactGrant).targetGeneration };
        }) : previous.grants };
      this.db.prepare("INSERT INTO contact_auth_policies VALUES (?,?,?) ON CONFLICT(instance) DO UPDATE SET revision=excluded.revision,policy_json=excluded.policy_json")
        .run(instance, next.revision, JSON.stringify(next));
      const changedGrants = (left: ContactGrant[], right: ContactGrant[]) => left.filter(row => JSON.stringify(row) !== JSON.stringify(right.find(other => row.id === other.id)));
      const policyChange: NonNullable<ContactHistoryRow["policyChange"]> = {};
      if (JSON.stringify(previous.approvers) !== JSON.stringify(next.approvers)) policyChange.approvers = { before: previous.approvers ?? null, after: next.approvers ?? null };
      const removed = changedGrants(previous.grants, next.grants), added = changedGrants(next.grants, previous.grants);
      if (removed.length || added.length) policyChange.grants = { before: removed, after: added };
      if (JSON.stringify(previous.roomTools) !== JSON.stringify(next.roomTools)) policyChange.roomTools = { before: previous.roomTools, after: next.roomTools };
      if (input.mode) policyChange.modeRequested = input.mode;
      this.history(instance, actor, "policy", "Contact permissions updated", undefined, policyChange);
      return next;
    })();
  }
  private history(instance: string, actor: ContactPerson, action: ContactHistoryRow["action"], summary: string, ticketId?: string, policyChange?: ContactHistoryRow["policyChange"], details?: Pick<ContactHistoryRow, "generation" | "originChange">): void {
    const id = randomUUID(), at = this.now();
    const ticket = ticketId ? this.get(ticketId) : undefined;
    const row: ContactHistoryRow = { id, at: new Date(at).toISOString(), actor, action, summary, target: instance, generation: details?.generation ?? ticket?.targetGeneration ?? this.policy(instance).generation,
      ...(ticket ? { source: ticket.source } : {}), ...(ticketId ? { ticketId } : {}), ...(policyChange ? { policyChange } : {}), ...(details?.originChange ? { originChange: details.originChange } : {}) };
    this.db.prepare("INSERT INTO contact_auth_history VALUES (?,?,?,?)").run(id, instance, at, JSON.stringify(row));
  }
  histories(instance: string, generation?: string): ContactHistoryRow[] {
    return (this.db.prepare("SELECT row_json FROM contact_auth_history WHERE instance=? ORDER BY at DESC,id LIMIT 50").all(instance) as { row_json: string }[])
      .map(row => JSON.parse(row.row_json) as ContactHistoryRow).filter(row => !generation || row.generation === generation);
  }
  /** Every known originating person needs an exact row; an unknown origin never matches. */
  matchingGrants(request: ContactRequest): ContactGrant[] {
    request = { ...request, origin: normalizeContactOrigin(request.origin) };
    if (request.origin.kind === "unknown" || request.origin.people.length === 0) return [];
    const table = this.policy(request.target, request.targetGeneration).grants;
    const matched = request.origin.people.map(person => table.find(grant => grant.target === request.target && grant.source === request.source
      && contactPersonKey(grant.person) === contactPersonKey(person)
      && grant.sourceGeneration === request.sourceGeneration && grant.targetGeneration === request.targetGeneration
      && grant.verbs.includes(request.verb) && Date.parse(grant.expiresAt) > this.now()
      && (grant.remainingUses === null || grant.remainingUses > 0)));
    return matched.every((grant): grant is ContactGrant => !!grant) ? unique(matched, grant => grant.id) : [];
  }
  /** M-3897: the ticket's current stored image, digested as the migration shadow does; null when absent or oversized. */
  private legacyImage(id: string): string | null {
    const row = this.db.prepare("SELECT id,request_json,ticket_json,operation_key,request_hash,created_at FROM contact_auth_tickets WHERE id=? "
      + "AND length(CAST(request_json AS BLOB))+length(CAST(ticket_json AS BLOB))<=262144").get(id) as
      { id: string; request_json: string; ticket_json: string; operation_key: string; request_hash: string; created_at: number } | undefined;
    return row ? legacyTicketDigest(row) : null;
  }
  /** M-3897: retired by an owner, and still the exact image that was retired (a changed row is not covered). */
  retired(id: string): boolean {
    const image = this.legacyImage(id);
    return !!image && !!this.db.prepare("SELECT 1 FROM contact_auth_retirements WHERE ticket_id=? AND ticket_sha256=?").get(id, image);
  }
  /**
   * M-3897: an owner stops waiting for an earlier ticket nothing can settle (its shadow disposition is retirable). Exactly
   * the image the page showed (`expectedSha256`), in one transaction; appends the retirement and changes nothing else.
   * It never says the request happened or didn't, never grants a receipt, and fences its replay (hold, approvedReturn).
   */
  retireLegacy(id: string, expectedSha256: string, disposition: string, actor: ContactPerson, current: () => boolean,
    acknowledge?: (deliveryId: string, by: string) => boolean): void {
    this.db.transaction(() => {
      if (!RETIRABLE_LEGACY_DISPOSITIONS.includes(disposition)) throw Error("invalid-request");
      if (this.legacyImage(id) !== expectedSha256 || current() !== true) throw Error("stale");
      // Fable #4600 (with Sentinel): an unconfirmed ticket's own delivery ended uncertain. The same owner acknowledges
      // exactly that delivery, re-matched as the shadow matches it, in this transaction (the outbox's own CAS); the
      // inventory leaves acknowledged ones out. A row that moved since the page showed it refuses the whole retirement.
      if (disposition === "legacy-unconfirmed") {
        const row = this.db.prepare("SELECT request_json,ticket_json FROM contact_auth_tickets WHERE id=?").get(id) as { request_json: string; ticket_json: string };
        const request = JSON.parse(row.request_json), ticket = JSON.parse(row.ticket_json);
        const delivery = typeof ticket.deliveryId === "string" && ticket.deliveryId ? this.db.prepare("SELECT state,source_instance,target_instance,operation_id,acknowledged_at FROM deliveries WHERE delivery_id=?").get(ticket.deliveryId) as
          { state: string; source_instance: string; target_instance: string; operation_id: string; acknowledged_at: string | null } | undefined : undefined;
        if (!delivery || delivery.source_instance !== request.source || delivery.target_instance !== request.target || delivery.operation_id !== request.operationId) throw Error("stale");
        // Only an unscoped (pre-L) delivery: one bound to a request is never acknowledged from here.
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_context_operations_v1'").get()
          && this.db.prepare("SELECT 1 FROM request_context_operations_v1 WHERE delivery_id=?").get(ticket.deliveryId)) throw Error("stale");
        if (delivery.state === "uncertain" && !delivery.acknowledged_at && acknowledge?.(ticket.deliveryId, actor.label || actor.userId) !== true) throw Error("stale");
      }
      this.db.prepare("INSERT OR IGNORE INTO contact_auth_retirements VALUES (?,?,?,?,?)")
        .run(id, expectedSha256, disposition, this.now(), JSON.stringify(actor));
    })();
  }
  approvedReturn(source: string, target: string, correlationId: string): ContactTicket[] {
    const rows = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.target')=? "
      + "AND json_extract(ticket_json,'$.resultRecipient')=? AND json_extract(ticket_json,'$.correlationId')=? "
      + "AND json_extract(ticket_json,'$.state') IN ('approved','delivered') AND created_at>? LIMIT 16")
      .all(source, target, correlationId, this.now() - 24 * 60 * 60_000) as TicketRow[];
    return rows.filter(row => !this.retired(row.id)).map(row => this.read(row));   // M-3897: a retired request allows no reply
  }
  hold(input: ContactRequest): ContactTicket {
    if (!input.operationId || !input.source || !input.target || !input.sourceGeneration || !input.targetGeneration
      || !input.correlationId || Buffer.byteLength(JSON.stringify(input), "utf8") > 96 * 1024) throw Error("invalid-request");
    // Generated correlation/message ids and timestamps do not change retry identity.
    // The exact first payload remains retained, never rebuilt from an approval form.
    const stable = { operationId: input.operationId, source: input.source, target: input.target,
      sourceGeneration: input.sourceGeneration, targetGeneration: input.targetGeneration,
      verb: input.verb, message: input.message, resultRecipient: input.resultRecipient,
      correlationId: input.correlationExplicit === false ? undefined : input.correlationId,
      forwards: input.forwards ?? [], requestContext: input.requestContext, targetSession: input.payload.targetSession, type: input.payload.type,
      metadata: Object.fromEntries(Object.entries((input.payload.meta ?? {}) as Record<string, unknown>)
        .filter(([key]) => !["message_id", "correlation_id", "ts"].includes(key))) };
    const hash = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    const key = JSON.stringify([input.source, input.operationId, input.target, input.verb]);
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE operation_key=?").get(key) as TicketRow | undefined;
      if (previous) {
        if (previous.request_hash !== hash) throw Error("operation-conflict");
        // M-3897: an owner retired this earlier request (outcome unknown): it is never replayed under its old decision.
        if (this.retired(previous.id)) throw Error("operation-retired");
        return this.read(previous);
      }
      const now = this.now();
      // Bound accidental tool retry loops without deleting pending decisions or replaying anything.
      const active = this.db.prepare("SELECT count(*) AS n FROM contact_auth_tickets WHERE created_at>? "
        + "AND json_extract(ticket_json,'$.state')='pending' AND json_extract(ticket_json,'$.source')=?")
        .get(now - CONTACT_APPLICATION_TTL_MS, input.source) as { n: number };
      if (active.n >= 32) throw Error("application-capacity");
      const total = this.db.prepare("SELECT count(*) AS n FROM contact_auth_tickets WHERE created_at>? "
        + "AND json_extract(ticket_json,'$.state')='pending'").get(now - CONTACT_APPLICATION_TTL_MS) as { n: number };
      if (total.n >= 512) throw Error("application-capacity");
      const scoped = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_context_contacts_v1'").get();
      this.db.prepare("DELETE FROM contact_auth_tickets WHERE created_at<?" + (scoped ? " AND id NOT IN (SELECT ticket_id FROM request_context_contacts_v1)" : ""))
        .run(now - 30 * 24 * 60 * 60_000);
      this.db.exec("DELETE FROM contact_auth_outcome_notices WHERE ticket_id NOT IN (SELECT id FROM contact_auth_tickets)");
      this.db.exec("DELETE FROM contact_auth_approval_notices WHERE ticket_id NOT IN (SELECT id FROM contact_auth_tickets)");
      this.db.prepare("DELETE FROM contact_auth_history WHERE at<?").run(now - 90 * 24 * 60 * 60_000);
      const ticket: ContactTicket = { ...(input.requestContext ? { requestContext: input.requestContext } : {}), id: `R${randomUUID()}`, revision: 1, scope: "peer.dispatch", state: "pending",
        source: input.source, target: input.target, sourceGeneration: input.sourceGeneration, targetGeneration: input.targetGeneration,
        verb: input.verb, origin: structuredClone(input.origin), message: input.message, requestHash: hash,
        correlationId: input.correlationId, resultRecipient: input.resultRecipient,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + CONTACT_APPLICATION_TTL_MS).toISOString(), canDecide: false };
      this.db.prepare("INSERT INTO contact_auth_tickets VALUES (?,?,?,?,?,?)")
        .run(ticket.id, key, hash, JSON.stringify(input), JSON.stringify(ticket), now);
      return ticket;
    })();
  }
  operationTicket(source: string, operationId: string, target: string, verb: ContactVerb): ContactTicket | undefined {
    const row = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE operation_key=?")
      .get(JSON.stringify([source, operationId, target, verb])) as TicketRow | undefined;
    return row ? this.read(row) : undefined;
  }
  private read(row: TicketRow,persist=true): ContactTicket {
    const ticket = JSON.parse(row.ticket_json) as ContactTicket;
    ticket.origin = normalizeContactOrigin(ticket.origin);
    if (ticket.state === "pending" && Date.parse(ticket.expiresAt) <= this.now()) {
      ticket.state = "expired"; ticket.revision++;
      if(persist)this.write(ticket);
    }
    return ticket;
  }
  private write(ticket: ContactTicket): void {
    this.db.prepare("UPDATE contact_auth_tickets SET ticket_json=? WHERE id=?").run(JSON.stringify(ticket), ticket.id);
  }
  get(id: string): ContactTicket | undefined {
    const row = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id) as TicketRow | undefined;
    return row ? this.read(row) : undefined;
  }
  /** Read-only card snapshot; logical expiry is not persisted by a pre-verification read. */
  peek(id:string):ContactTicket|undefined {
    const row=this.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id) as TicketRow|undefined;
    return row?this.read(row,false):undefined;
  }
  requestSnapshot(id:string):{ticket:ContactTicket;request:ContactRequest;imageSha256:string}|null {
    const row=this.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id) as (TicketRow&{operation_key:string})|undefined;
    if(!row)return null;
    const ticket=this.read(row,false),request=JSON.parse(row.request_json) as ContactRequest;
    if(ticket.id!==row.id||!request.operationId||request.source!==ticket.source||request.target!==ticket.target||request.verb!==ticket.verb||request.sourceGeneration!==ticket.sourceGeneration||request.targetGeneration!==ticket.targetGeneration||request.message!==ticket.message||!!request.requestContext!==!!ticket.requestContext||requestContextDigest(normalizeContactOrigin(request.origin))!==requestContextDigest(ticket.origin)||row.operation_key!==JSON.stringify([request.source,request.operationId,request.target,request.verb]))throw Error("operation-conflict");
    return {ticket,request,imageSha256:createHash("sha256").update(row.request_json).digest("hex")};
  }
  /** Legacy-only CAS on the same connection/transaction as the existing decision writer. */
  decideExpected(id:string,input:ContactTicketDecision,actor:ContactPerson,authority:ContactDecisionAuthority,expected:{policyRevision:number;imageSha256:string}):ContactTicket {
    return this.db.transaction(()=>{
      if(authority.requestContextVersion!==undefined)throw Error("request-context legacy decision required");
      this.assertDecisionScope(id,authority);
      const snapshot=this.requestSnapshot(id);if(!snapshot)throw Error("not-found");
      if(snapshot.imageSha256!==expected.imageSha256)throw Error("operation-conflict");
      if(this.policy(snapshot.ticket.target,snapshot.ticket.targetGeneration).revision!==expected.policyRevision)throw Error("policy-conflict");
      return this.decide(id,input,actor,authority);
    })();
  }
  /**
   * M-3693: pending tickets as they stand, WITHOUT the expiry write the other reads do (General's contact_state is
   * read-only). A ticket past its expiry or the application TTL is left out, exactly as those reads would mark it.
   * `limit` rows at most; `truncated` says more were pending.
   */
  pendingSnapshot(limit = 1000): { items: ContactTicket[]; truncated: boolean } {
    const rows = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.state')='pending' AND created_at>? ORDER BY created_at DESC,id LIMIT ?")
      .all(this.now() - CONTACT_APPLICATION_TTL_MS, limit + 1) as TicketRow[];
    const items = rows.slice(0, limit).map(row => JSON.parse(row.ticket_json) as ContactTicket).filter(t => Date.parse(t.expiresAt) > this.now());
    return { items, truncated: rows.length > limit };
  }
  /** M-3693: up to two live pending tickets whose id starts with `prefix` (no write); [] for a prefix that is not an id's. */
  pendingByPrefix(prefix: string): ContactTicket[] {
    if (!/^[A-Za-z0-9-]+$/.test(prefix)) return [];
    const rows = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE substr(id,1,?)=? AND json_extract(ticket_json,'$.state')='pending' AND created_at>?")
      .all(prefix.length, prefix, this.now() - CONTACT_APPLICATION_TTL_MS) as TicketRow[];
    return rows.map(row => JSON.parse(row.ticket_json) as ContactTicket).filter(t => Date.parse(t.expiresAt) > this.now()).slice(0, 2);
  }
  pending(): ContactTicket[] {
    this.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.state','expired','$.revision',json_extract(ticket_json,'$.revision')+1) "
      + "WHERE created_at<=? AND json_extract(ticket_json,'$.state')='pending'").run(this.now() - CONTACT_APPLICATION_TTL_MS);
    return (this.db.prepare("SELECT * FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.state')='pending' ORDER BY created_at,id LIMIT 512")
      .all() as TicketRow[]).map(row => this.read(row));
  }
  /**
   * M-3372: the callback admits a system notice on this same outbox connection. M-3716: a person's approval is
   * announced too, once its delivery to the target settles (`delivery` reads the outbox row): delivered, still in flight
   * after CONTACT_APPROVAL_NOTICE_WAIT_MS (queued), or anything else, a missing or pruned row included (not confirmed). A standing rule's approval is not: the send itself returned it.
   */
  notifyOutcomes(admit: (ticket: ContactTicket, outcome: ContactOutcome) => void,
    delivery: (ticket: ContactTicket) => string | undefined = () => undefined): number {
    return this.db.transaction(() => {
      // A timer calls this even if no person opens the web page.
      this.pending();
      const rows = this.db.prepare("SELECT t.* FROM contact_auth_tickets t LEFT JOIN contact_auth_outcome_notices n ON n.ticket_id=t.id "
        + "WHERE n.ticket_id IS NULL AND json_extract(t.ticket_json,'$.state') IN ('declined','expired') ORDER BY t.created_at,t.id LIMIT 64")
        .all() as TicketRow[];
      for (const row of rows) {
        const ticket = this.read(row);
        admit(ticket, ticket.state === "declined" ? "declined" : "expired");
        this.db.prepare("INSERT INTO contact_auth_outcome_notices VALUES (?)").run(row.id);
      }
      const approved = this.db.prepare("SELECT t.* FROM contact_auth_tickets t LEFT JOIN contact_auth_approval_notices n ON n.ticket_id=t.id "
        + "WHERE n.ticket_id IS NULL AND json_extract(t.ticket_json,'$.state')='approved' ORDER BY t.created_at,t.id LIMIT 256")
        .all() as TicketRow[];
      let sent = rows.length;
      for (const row of approved) {
        const ticket = this.read(row);
        if (ticket.grantId) { this.db.prepare("INSERT INTO contact_auth_approval_notices VALUES (?)").run(row.id); continue; }
        const state = delivery(ticket);
        // Prism #4452 P2-2: "queued" only for a row really still in flight; a missing or pruned row is not confirmed.
        const outcome: ContactOutcome | undefined = state === "delivered" ? "delivered"
          : !CONTACT_DELIVERY_IN_FLIGHT.includes(state ?? "") ? "unconfirmed"
          : this.now() - Date.parse(ticket.decidedAt ?? ticket.createdAt) >= CONTACT_APPROVAL_NOTICE_WAIT_MS ? "queued" : undefined;
        if (!outcome) continue;
        admit(ticket, outcome);
        this.db.prepare("INSERT INTO contact_auth_approval_notices VALUES (?)").run(row.id);
        sent++;
      }
      return sent;
    })();
  }
  /**
   * M-3716: the requests one agent sent that were held, newest first, for that agent's own delivery_status. No write:
   * a pending request past its expiry reads as expired, exactly as the sweep will mark it.
   */
  requestsBy(source: string, limit = 20): ContactTicket[] {
    const rows = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.source')=? ORDER BY created_at DESC,id LIMIT ?")
      .all(source, limit) as Array<TicketRow & { created_at: number }>;
    return rows.map(row => {
      const ticket = JSON.parse(row.ticket_json) as ContactTicket;
      return ticket.state === "pending" && (Date.parse(ticket.expiresAt) <= this.now() || row.created_at <= this.now() - CONTACT_APPLICATION_TTL_MS)
        ? { ...ticket, state: "expired" as const } : ticket;
    });
  }
  list(filter: { agent?: string; status?: string; cursor?: string } = {}): { items: ContactTicket[]; nextCursor: string | null } {
    const offset = filter.cursor ? Number(filter.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw Error("invalid-cursor");
    // Read a bounded page; identity visibility is applied by the service, not query parameters.
    const rows = this.db.prepare("SELECT * FROM contact_auth_tickets ORDER BY created_at DESC,id LIMIT 51 OFFSET ?").all(offset) as TicketRow[];
    const items = rows.slice(0, 50).map(row => this.read(row))
      .filter(ticket => (!filter.agent || ticket.source === filter.agent || ticket.target === filter.agent)
        && (!filter.status || ticket.state === filter.status));
    return { items, nextCursor: rows.length > 50 ? String(offset + 50) : null };
  }
  private assertDecisionScope(id: string, authority: ContactDecisionAuthority): void {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_context_contacts_v1'").get();
    const scoped = !!table && !!this.db.prepare("SELECT 1 FROM request_context_contacts_v1 WHERE ticket_id=?").get(id);
    const row = this.db.prepare("SELECT request_json FROM contact_auth_tickets WHERE id=?").get(id) as {request_json:string}|undefined;
    if (scoped !== (authority.requestContextVersion === 1) || !!(row && JSON.parse(row.request_json).requestContext) !== scoped) throw Error("request-context scoped-ticket mismatch");
  }
  decide(id: string, decision: ContactTicketDecision, actor: ContactPerson, authority: ContactDecisionAuthority, automatic = false): ContactTicket {
    this.db.transaction(() => this.assertDecisionScope(id, authority))();
    // Expiry is persisted outside the decision transaction, even when deciding throws.
    this.get(id);
    return this.db.transaction(() => {
      this.assertDecisionScope(id, authority);
      const row = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id) as TicketRow | undefined;
      if (!row) throw Error("not-found");
      const ticket = this.read(row), request = JSON.parse(row.request_json) as ContactRequest;
      request.origin = normalizeContactOrigin(request.origin);
      if (!authority.canDecide(ticket.target, actor)) throw Error("forbidden");
      if (ticket.state === "expired") throw Error("expired");
      if (ticket.state !== "pending") throw Error("already-decided");
      if (decision.revision !== ticket.revision) throw Error("conflict");
      if (decision.decision !== "approve-once" && decision.decision !== "decline") throw Error("invalid-decision");
      ticket.decidedAt = new Date(this.now()).toISOString(); ticket.decidedBy = actor; ticket.revision++;
      if (decision.decision === "decline") ticket.state = "declined";
      else {
        if (!authority.current(request)) throw Error("stale-generation");
        // An administrator approval (including a standing grant) endorses this delivery.
        // Keep its original origin on the ticket/source; do not merge it into the receiving agent.
        if (decision.grant) {
          const choice = decision.grant;
          if (!["human", "mixed"].includes(request.origin.kind) || !request.origin.people.length || request.origin.people.length > 16
            || (!choice.personKeys && (request.origin.kind !== "human" || request.origin.people.length !== 1))) throw Error("invalid-grant-origin");
          const keys = choice.personKeys ? choice.personKeys.map(key => normalizeContactPersonKey(key) ?? "") : [contactPersonKey(request.origin.people[0]!)];
          if (!keys.length || keys.length > 16 || new Set(keys).size !== keys.length
            || keys.some(key => !request.origin.people.some(person => contactPersonKey(person) === key))) throw Error("invalid-grant-origin");
          if (!Number.isFinite(Date.parse(choice.expiresAt)) || Date.parse(choice.expiresAt) <= this.now()
            || (choice.remainingUses !== null && (!Number.isInteger(choice.remainingUses) || choice.remainingUses < 1 || choice.remainingUses > 10_000))) throw Error("invalid-grant");
          const previous = this.policy(request.target, request.targetGeneration);
          if (previous.grants.length + keys.length > 100) throw Error("invalid-grant");
          const grants: ContactGrant[] = keys.map(key => ({ id: randomUUID(),
            person: request.origin.people.find(person => contactPersonKey(person) === key)!, source: request.source,
            target: request.target, sourceGeneration: request.sourceGeneration, targetGeneration: request.targetGeneration,
            verbs: [request.verb], expiresAt: choice.expiresAt, remainingUses: choice.remainingUses,
            createdAt: ticket.decidedAt!, createdBy: actor }));
          const saved = this.writePolicy(request.target, { revision: previous.revision, grants: [...previous.grants, ...grants] }, actor,
            name => name === request.target ? request.targetGeneration : name === request.source ? request.sourceGeneration : "unavailable");
          // writePolicy assigns fresh ids to appended rows; reference the persisted images.
          ticket.grantIds = saved.grants.slice(previous.grants.length).map(grant => grant.id);
        }
        ticket.deliveryId = authority.admit(request, ticket.id);
        ticket.state = "approved";
        if (authority.rootApprovalTicketId) ticket.rootApprovalTicketId = authority.rootApprovalTicketId;
      }
      this.write(ticket);
      this.history(ticket.target, actor, automatic ? "grant-use" : decision.decision === "decline" ? "decline" : "approve", authority.rootApprovalTicketId ? `Request approval ${authority.rootApprovalTicketId} continued` : automatic ? "Standing contact grant used" : decision.decision, ticket.id);
      return ticket;
    })();
  }
  applyStandingGrant(id: string, authority: ContactDecisionAuthority): ContactTicket | undefined {
    return this.db.transaction(() => {
      this.assertDecisionScope(id, authority);
      const row = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id) as TicketRow | undefined;
      if (!row) return undefined;
      const ticket = this.read(row);
      if (ticket.state !== "pending") return ticket;
      const request = JSON.parse(row.request_json) as ContactRequest;
      request.origin = normalizeContactOrigin(request.origin);
      const grants = this.matchingGrants(request), grant = grants[0];
      if (!grant || !grants.every(row => authority.canDecide(request.target, row.createdBy))) return undefined;
      const next = this.decide(id, { revision: ticket.revision, decision: "approve-once" }, grant.createdBy,
        { ...authority, canDecide: () => true }, true);
      const policy = this.policy(request.target, request.targetGeneration);
      if (grants.some(row => row.remainingUses !== null)) {
        const used = new Set(grants.map(row => row.id));
        const updated = policy.grants.map(item => used.has(item.id) && item.remainingUses !== null ? { ...item, remainingUses: item.remainingUses - 1 } : item);
        const changed = { ...policy, revision: policy.revision + 1, grants: updated };
        this.db.prepare("UPDATE contact_auth_policies SET revision=?,policy_json=? WHERE instance=?")
          .run(changed.revision, JSON.stringify(changed), request.target);
      }
      next.grantId = grant.id;
      next.grantIds = grants.map(row => row.id);
      this.write(next);
      return next;
    })();
  }
}
