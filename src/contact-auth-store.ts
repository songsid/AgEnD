import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { ContactGrant, ContactHistoryRow, ContactOrigin, ContactPerson, ContactPermissionsWrite, ContactRoomTools, ContactTicket, ContactTicketDecision, ContactVerb } from "./contact-auth-types.js";

export const CONTACT_APPLICATION_TTL_MS = 30 * 60_000;
export interface ContactRequest {
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
  return JSON.stringify([person.platform, person.adapterId, person.userId]);
}
function unique<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map(value => [key(value), value])).values()];
}
export function mergeContactOrigins(before: ContactOrigin | undefined, next: ContactOrigin): ContactOrigin {
  before ??= { kind: next.kind, people: [], receiptIds: [], chain: [] };
  const people = unique([...before.people, ...next.people], contactPersonKey);
  const receipts = [...new Set([...before.receiptIds, ...next.receiptIds])];
  const chain = [...new Set([...before.chain, ...next.chain])];
  // Receipt/hop history is diagnostic. Trimming it must not change the known people's authority.
  const unknown = before.kind === "unknown" || next.kind === "unknown" || people.length > 16;
  return { kind: unknown ? "unknown" : people.length === 1 && before.kind !== "mixed" && next.kind !== "mixed" ? "human" : "mixed",
    people: people.slice(0, 16), receiptIds: receipts.slice(-64), chain: chain.slice(-32) };
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
    db.exec("CREATE TABLE IF NOT EXISTS contact_auth_room_context (instance TEXT PRIMARY KEY, context_json TEXT NOT NULL)");
    // M-3381: when the restricted-mode suggestion was first raised for a room (its age counts from here, not from the room).
    db.exec("CREATE TABLE IF NOT EXISTS contact_auth_suggestion_raised (instance TEXT PRIMARY KEY, raised_at INTEGER NOT NULL)");
    db.transaction(() => {
      const existed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contact_auth_outcome_notices'").get();
      db.exec("CREATE TABLE IF NOT EXISTS contact_auth_outcome_notices (ticket_id TEXT PRIMARY KEY)");
      // Do not re-announce decisions already terminal before this feature was installed.
      if (!existed) db.exec("INSERT INTO contact_auth_outcome_notices SELECT id FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.state') IN ('declined','expired')");
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
      return combined;
    })();
  }
  origin(instance: string): ContactOrigin | undefined {
    const row = this.db.prepare("SELECT origin_json FROM contact_auth_origins WHERE instance=?").get(instance) as { origin_json: string } | undefined;
    return row ? JSON.parse(row.origin_json) as ContactOrigin : undefined;
  }
  policy(instance: string, generation?: string): ContactStoredPolicy {
    const row = this.db.prepare("SELECT policy_json FROM contact_auth_policies WHERE instance=?").get(instance) as { policy_json: string } | undefined;
    const previous = row ? JSON.parse(row.policy_json) as ContactStoredPolicy : undefined;
    if (previous && (!generation || previous.generation === generation)) return previous;
    const fresh: ContactStoredPolicy = { revision: previous ? previous.revision + 1 : 0,
      ...(generation ? { generation } : {}), grants: [], roomTools: { publicRead: true, allowedMcpTools: [], wouldDisable: [] } };
    if (previous && generation) this.db.prepare("UPDATE contact_auth_policies SET revision=?,policy_json=? WHERE instance=?")
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
  private history(instance: string, actor: ContactPerson, action: ContactHistoryRow["action"], summary: string, ticketId?: string, policyChange?: ContactHistoryRow["policyChange"]): void {
    const id = randomUUID(), at = this.now();
    const ticket = ticketId ? this.get(ticketId) : undefined;
    const row: ContactHistoryRow = { id, at: new Date(at).toISOString(), actor, action, summary, target: instance, generation: ticket?.targetGeneration ?? this.policy(instance).generation,
      ...(ticket ? { source: ticket.source } : {}), ...(ticketId ? { ticketId } : {}), ...(policyChange ? { policyChange } : {}) };
    this.db.prepare("INSERT INTO contact_auth_history VALUES (?,?,?,?)").run(id, instance, at, JSON.stringify(row));
  }
  histories(instance: string, generation?: string): ContactHistoryRow[] {
    return (this.db.prepare("SELECT row_json FROM contact_auth_history WHERE instance=? ORDER BY at DESC,id LIMIT 50").all(instance) as { row_json: string }[])
      .map(row => JSON.parse(row.row_json) as ContactHistoryRow).filter(row => !generation || row.generation === generation);
  }
  /** Every known originating person needs an exact row; an unknown origin never matches. */
  matchingGrants(request: ContactRequest): ContactGrant[] {
    if (request.origin.kind === "unknown" || request.origin.people.length === 0) return [];
    const table = this.policy(request.target, request.targetGeneration).grants;
    const matched = request.origin.people.map(person => table.find(grant => grant.target === request.target && grant.source === request.source
      && contactPersonKey(grant.person) === contactPersonKey(person)
      && grant.sourceGeneration === request.sourceGeneration && grant.targetGeneration === request.targetGeneration
      && grant.verbs.includes(request.verb) && Date.parse(grant.expiresAt) > this.now()
      && (grant.remainingUses === null || grant.remainingUses > 0)));
    return matched.every((grant): grant is ContactGrant => !!grant) ? unique(matched, grant => grant.id) : [];
  }
  approvedReturn(source: string, target: string, correlationId: string): ContactTicket[] {
    const rows = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.target')=? "
      + "AND json_extract(ticket_json,'$.resultRecipient')=? AND json_extract(ticket_json,'$.correlationId')=? "
      + "AND json_extract(ticket_json,'$.state') IN ('approved','delivered') AND created_at>? LIMIT 16")
      .all(source, target, correlationId, this.now() - 24 * 60 * 60_000) as TicketRow[];
    return rows.map(row => this.read(row));
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
      forwards: input.forwards ?? [], targetSession: input.payload.targetSession, type: input.payload.type,
      metadata: Object.fromEntries(Object.entries((input.payload.meta ?? {}) as Record<string, unknown>)
        .filter(([key]) => !["message_id", "correlation_id", "ts"].includes(key))) };
    const hash = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    const key = JSON.stringify([input.source, input.operationId, input.target, input.verb]);
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE operation_key=?").get(key) as TicketRow | undefined;
      if (previous) {
        if (previous.request_hash !== hash) throw Error("operation-conflict");
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
      this.db.prepare("DELETE FROM contact_auth_tickets WHERE created_at<?")
        .run(now - 30 * 24 * 60 * 60_000);
      this.db.exec("DELETE FROM contact_auth_outcome_notices WHERE ticket_id NOT IN (SELECT id FROM contact_auth_tickets)");
      this.db.prepare("DELETE FROM contact_auth_history WHERE at<?").run(now - 90 * 24 * 60 * 60_000);
      const ticket: ContactTicket = { id: `R${randomUUID()}`, revision: 1, scope: "peer.dispatch", state: "pending",
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
  private read(row: TicketRow): ContactTicket {
    const ticket = JSON.parse(row.ticket_json) as ContactTicket;
    if (ticket.state === "pending" && Date.parse(ticket.expiresAt) <= this.now()) {
      ticket.state = "expired"; ticket.revision++;
      this.write(ticket);
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
  pending(): ContactTicket[] {
    this.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.state','expired','$.revision',json_extract(ticket_json,'$.revision')+1) "
      + "WHERE created_at<=? AND json_extract(ticket_json,'$.state')='pending'").run(this.now() - CONTACT_APPLICATION_TTL_MS);
    return (this.db.prepare("SELECT * FROM contact_auth_tickets WHERE json_extract(ticket_json,'$.state')='pending' ORDER BY created_at,id LIMIT 512")
      .all() as TicketRow[]).map(row => this.read(row));
  }
  /** M-3372: the callback admits a system notice on this same outbox connection. */
  notifyOutcomes(admit: (ticket: ContactTicket) => void): number {
    return this.db.transaction(() => {
      // A timer calls this even if no person opens the web page.
      this.pending();
      const rows = this.db.prepare("SELECT t.* FROM contact_auth_tickets t LEFT JOIN contact_auth_outcome_notices n ON n.ticket_id=t.id "
        + "WHERE n.ticket_id IS NULL AND json_extract(t.ticket_json,'$.state') IN ('declined','expired') ORDER BY t.created_at,t.id LIMIT 64")
        .all() as TicketRow[];
      for (const row of rows) {
        admit(this.read(row));
        this.db.prepare("INSERT INTO contact_auth_outcome_notices VALUES (?)").run(row.id);
      }
      return rows.length;
    })();
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
  decide(id: string, decision: ContactTicketDecision, actor: ContactPerson, authority: ContactDecisionAuthority, automatic = false): ContactTicket {
    // Expiry is persisted outside the decision transaction, even when deciding throws.
    this.get(id);
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id) as TicketRow | undefined;
      if (!row) throw Error("not-found");
      const ticket = this.read(row), request = JSON.parse(row.request_json) as ContactRequest;
      if (!authority.canDecide(ticket.target, actor)) throw Error("forbidden");
      if (ticket.state === "expired") throw Error("expired");
      if (ticket.state !== "pending") throw Error("already-decided");
      if (decision.revision !== ticket.revision) throw Error("conflict");
      if (decision.decision !== "approve-once" && decision.decision !== "decline") throw Error("invalid-decision");
      ticket.decidedAt = new Date(this.now()).toISOString(); ticket.decidedBy = actor; ticket.revision++;
      if (decision.decision === "decline") ticket.state = "declined";
      else {
        if (!authority.current(request)) throw Error("stale-generation");
        ticket.deliveryId = authority.admit(request, ticket.id);
        ticket.state = "approved";
        // An administrator approval (including a standing grant) endorses this delivery.
        // Keep its original origin on the ticket/source; do not merge it into the receiving agent.
        if (decision.grant) {
          if (request.origin.kind !== "human" || request.origin.people.length !== 1) throw Error("invalid-grant-origin");
          const previous = this.policy(request.target, request.targetGeneration);
          const grant: ContactGrant = { id: randomUUID(), person: request.origin.people[0]!, source: request.source,
            target: request.target, sourceGeneration: request.sourceGeneration, targetGeneration: request.targetGeneration,
            verbs: [request.verb], ...decision.grant, createdAt: ticket.decidedAt, createdBy: actor };
          this.writePolicy(request.target, { revision: previous.revision, grants: [...previous.grants, grant] }, actor,
            name => name === request.target ? request.targetGeneration : name === request.source ? request.sourceGeneration : "unavailable");
        }
      }
      this.write(ticket);
      this.history(ticket.target, actor, automatic ? "grant-use" : decision.decision === "decline" ? "decline" : "approve", automatic ? "Standing contact grant used" : decision.decision, ticket.id);
      return ticket;
    })();
  }
  applyStandingGrant(id: string, authority: ContactDecisionAuthority): ContactTicket | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id) as TicketRow | undefined;
      if (!row) return undefined;
      const ticket = this.read(row);
      if (ticket.state !== "pending") return ticket;
      const request = JSON.parse(row.request_json) as ContactRequest;
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
