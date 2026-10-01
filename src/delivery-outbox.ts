import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { QueueResumePolicy } from "./delivery-queue-evidence.js";

export const DURABLE_DELIVERY_MAX_ATTEMPTS = 8;
export const DURABLE_DELIVERY_MAX_AGE_MS = 24 * 60 * 60_000;
export const DURABLE_DELIVERY_ABORT_BACKOFF_MS = 5_000;

export interface DaemonDeliveryPort {
  begin(deliveryId: string, targetBootId: string, attemptNo: number, evidence?: DeliveryAttemptEvidence): "begun" | "duplicate" | "stale";
  markEnterStarted(deliveryId: string, targetBootId: string, attemptNo: number): boolean;
  abort(deliveryId: string, targetBootId: string, attemptNo: number, reason: string): boolean;
  complete(deliveryId: string, targetBootId: string, attemptNo: number, outcome: "delivered" | "failed" | "uncertain", evidence?: string): boolean;
  retryBeforeBegin(deliveryId: string, targetBootId: string, attemptNo: number, reason: string, delayMs?: number): boolean;
}

export type OutboxState =
  | "queued"
  | "delivering"
  | "submission_started"
  | "reconciliation_pending"
  | "retry_wait"
  | "delivered"
  | "failed"
  | "uncertain"
  | "cancelled";

export interface NewOutboxDelivery {
  operationId: string;
  sourceKey: string;
  sourceInstance: string;
  sourceDaemonBootId: string;
  targetInstance: string;
  targetSession?: string;
  kind: string;
  correlationId?: string;
  payload: Record<string, unknown>;
}

export interface OutboxDelivery {
  deliveryId: string;
  operationId: string;
  sourceKey: string;
  sourceInstance: string;
  sourceDaemonBootId: string;
  targetInstance: string;
  targetSession: string | null;
  targetDaemonBootId: string | null;
  kind: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
  state: OutboxState;
  attemptNo: number;
  createdSeq: number;
  managerBootId: string | null;
  responseDeliveredAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  reconciliationPending: boolean;
}

export type DeliveryStatusSelector =
  | { deliveryId: string; operationId?: never; correlationId?: never; messageId?: never; limit?: never; cursor?: never }
  | { operationId: string; deliveryId?: never; correlationId?: never; messageId?: never; limit?: number; cursor?: string }
  | { correlationId: string; deliveryId?: never; operationId?: never; messageId?: never; limit?: number; cursor?: string }
  /**
   * #856: the `message_id` a receiver sees in the envelope header. Lets an
   * agent check that a peer message it is about to act on was really
   * delivered by the fleet — a model can "see" one nobody sent.
   */
  | { messageId: string; deliveryId?: never; operationId?: never; correlationId?: never; limit?: number; cursor?: string };

/** The one mapping from validated tool/CLI arguments to a selector. */
export function deliveryStatusSelector(args: {
  delivery_id?: string; operation_id?: string; correlation_id?: string; message_id?: string; limit?: number; cursor?: string;
}): DeliveryStatusSelector {
  const page = { ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) };
  if (args.delivery_id) return { deliveryId: args.delivery_id };
  if (args.operation_id) return { operationId: args.operation_id, ...page };
  if (args.message_id) return { messageId: args.message_id, ...page };
  return { correlationId: args.correlation_id!, ...page };
}

/** sha256 of a delivered text, as hex. The same function hashes admission and paste. */
export function deliveryContentDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The text a durable row delivers, for kinds whose payload carries one. */
function payloadContent(payload: unknown): string | null {
  const content = payload && typeof payload === "object" ? (payload as Record<string, unknown>).content : undefined;
  return typeof content === "string" ? content : null;
}

/** #926 reminders and overdue notices; never themselves the subject of a failure notice. */
export const REPLY_OBLIGATION_NOTICE_KIND = "reply_obligation_notice";

/** Kinds that carry a peer request or its answer. Broadcasts are one-to-many and deferred (#926 §6). */
const REPLY_OBLIGATION_KINDS = ["fleet_inbound", "steer"] as const;

function payloadRequiresReply(payload: unknown): boolean {
  const meta = payload && typeof payload === "object" ? (payload as Record<string, unknown>).meta : undefined;
  return !!meta && typeof meta === "object" && (meta as Record<string, unknown>).requires_reply === "true";
}

function payloadMessageId(payload: unknown): string | null {
  const meta = payload && typeof payload === "object" ? (payload as Record<string, unknown>).meta : undefined;
  const id = meta && typeof meta === "object" ? (meta as Record<string, unknown>).message_id : undefined;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface DeliveryStatusItem {
  delivery_id: string;
  operation_id: string;
  correlation_id: string | null;
  source_instance: string;
  target_instance: string;
  kind: string;
  state: OutboxState;
  attempt_no: number;
  created_at: string;
  updated_at: string;
  status_summary: string;
  error_summary: string | null;
  safe_to_retry: boolean;
  /** Fleet message ID of the delivered envelope, when it had one. */
  message_id: string | null;
  /** sha256 of the delivered text as admitted (#856). */
  content_sha256: string | null;
  /**
   * The text as admitted — only on a `message_id` query by the row's own
   * source or target: the caller already sent or received it, and verifying
   * a value (a SHA, a PR number) needs the text, not just its digest. Every
   * other query, and operator reads, stay redacted as before (#982).
   */
  content?: string | null;
  /** #926: the reply this request is owed, when it asked for one. */
  reply_obligation?: { state: "open" | "answered"; opened_at: string; last_asked_at: string; nudged_at: string | null; overdue_notified_at: string | null; answered_at: string | null } | null;
}

/**
 * #926: a peer asked with `requires_reply` and the owner has not answered it
 * through the fleet yet. Terminal text is not an answer: only a message the
 * owner sends back to the requester with the same correlation_id closes it.
 */
export interface ReplyObligation {
  correlationId: string;
  requesterInstance: string;
  ownerInstance: string;
  requestDeliveryId: string;
  openedAt: string;
  lastAskedAt: string;
  state: "open" | "answered";
  nudgedAt: string | null;
  overdueNotifiedAt: string | null;
  answeredAt: string | null;
  answeredDeliveryId: string | null;
}

export interface DeliveryStatusPage {
  items: DeliveryStatusItem[];
  next_cursor: string | null;
}

export type DurableSubmissionMode = "idle_submit" | "native_queue_handoff" | "steer" | "raw_paste";

/** Checkpoint committed with begin, before any pane paste can occur. */
export interface DeliveryAttemptEvidence {
  backend: string;
  backendVersion?: string | null;
  windowId: string | null;
  transcriptPath: string | null;
  transcriptOffset: number | null;
  transcriptSessionId: string | null;
  submissionMode: DurableSubmissionMode;
  queueResumePolicy?: QueueResumePolicy;
  /** sha256 of the text the target daemon received, before formatting (#856). */
  pastedContentSha256?: string | null;
  /** sha256 of the exact string handed to the pane write (#856). */
  pastedBytesSha256?: string | null;
}

export interface DeliveryReconciliationCandidate extends OutboxDelivery {
  attempt: {
    targetDaemonBootId: string;
    attemptNo: number;
    backend: string | null;
    backendVersion: string | null;
    windowId: string | null;
    transcriptPath: string | null;
    transcriptOffset: number | null;
    transcriptSessionId: string | null;
    submissionMode: DurableSubmissionMode | null;
    queueResumePolicy: QueueResumePolicy | null;
    enterStartedAt: string | null;
  };
}

interface OutboxRow {
  delivery_id: string;
  operation_id: string;
  source_key: string;
  source_instance: string;
  source_daemon_boot_id: string;
  target_instance: string;
  target_session: string | null;
  target_daemon_boot_id: string | null;
  kind: string;
  correlation_id: string | null;
  payload_json: string;
  message_id?: string | null;
  content_sha256?: string | null;
  state: OutboxState;
  attempt_no: number;
  created_seq: number;
  manager_boot_id: string | null;
  response_delivered_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  reconciliation_pending: number;
  created_at: string;
}

export interface ClaimedOutboxDelivery extends OutboxDelivery {
  targetDaemonBootId: string;
}

function mapRow(row: OutboxRow): OutboxDelivery {
  return {
    deliveryId: row.delivery_id,
    operationId: row.operation_id,
    sourceKey: row.source_key,
    sourceInstance: row.source_instance,
    sourceDaemonBootId: row.source_daemon_boot_id,
    targetInstance: row.target_instance,
    targetSession: row.target_session,
    targetDaemonBootId: row.target_daemon_boot_id,
    kind: row.kind,
    correlationId: row.correlation_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    state: row.state === "submission_started" && row.reconciliation_pending === 1
      ? "reconciliation_pending"
      : row.state,
    attemptNo: row.attempt_no,
    createdSeq: row.created_seq,
    managerBootId: row.manager_boot_id,
    responseDeliveredAt: row.response_delivered_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    reconciliationPending: row.reconciliation_pending === 1,
  };
}

function safeErrorSummary(error: string | null): string | null {
  if (!error) return null;
  const normalized = error.toLowerCase();
  if (normalized.includes("ttl expired")) return "Delivery expired before the target became available.";
  if (normalized.includes("attempt limit")) return "Delivery exhausted its bounded retry attempts.";
  if (normalized.includes("reconcil") || normalized.includes("uncertain") || normalized.includes("restart")) {
    return "Submission may have occurred; do not resend until the outcome is reconciled.";
  }
  return "A delivery error was recorded; details are omitted for safety.";
}

function statusSummary(state: OutboxState): string {
  switch (state) {
    case "queued": return "Accepted and waiting for delivery.";
    case "delivering": return "Waiting for the target to become ready; submission has not started.";
    case "retry_wait": return "Waiting for a bounded retry; submission has not started for the next attempt.";
    case "submission_started":
    case "reconciliation_pending": return "Submission may have occurred; do not resend.";
    case "delivered": return "Delivery was confirmed; this does not mean the agent finished processing it.";
    case "failed": return "Delivery failed after bounded retries or expiry.";
    case "uncertain": return "Delivery may have occurred; do not resend blindly.";
    case "cancelled": return "Delivery was cancelled.";
  }
}

function safeToRetry(state: OutboxState): boolean {
  return state === "queued" || state === "delivering" || state === "retry_wait" || state === "failed";
}

function hasTable(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/** The obligation a request row opened, if any; absent on databases from before #926. */
function obligationFor(db: Database.Database, correlationId: string | null, requester: string, owner: string): DeliveryStatusItem["reply_obligation"] {
  if (!correlationId || !hasTable(db, "reply_obligations")) return null;
  const row = db.prepare(`
    SELECT state, opened_at, last_asked_at, nudged_at, overdue_notified_at, answered_at FROM reply_obligations
    WHERE correlation_id=? AND requester_instance=? AND owner_instance=?
  `).get(correlationId, requester, owner) as NonNullable<DeliveryStatusItem["reply_obligation"]> | undefined;
  return row ?? null;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column);
}

/** Derived from the stored payload, so it is the same for pre-#856 rows. */
function rowContentEvidence(payloadJson: string, withContent: boolean): Pick<DeliveryStatusItem, "message_id" | "content_sha256" | "content"> {
  let payload: unknown = null;
  try { payload = JSON.parse(payloadJson); } catch { /* corrupt row: report no evidence */ }
  const content = payloadContent(payload);
  return {
    message_id: payloadMessageId(payload),
    content_sha256: content === null ? null : deliveryContentDigest(content),
    ...(withContent ? { content } : {}),
  };
}

function queryStatusPage(
  db: Database.Database,
  selector: DeliveryStatusSelector,
  callerInstance: string | null,
): DeliveryStatusPage {
  const where: string[] = [];
  const params: (string | number)[] = [];
  // An operator may read a database written before the column existed.
  const messageIdColumn = hasColumn(db, "deliveries", "message_id")
    ? "d.message_id" : "json_extract(d.payload_json,'$.meta.message_id')";
  if (selector.deliveryId) { where.push("d.delivery_id = ?"); params.push(selector.deliveryId); }
  else if (selector.operationId) { where.push("d.operation_id = ?"); params.push(selector.operationId); }
  else if (selector.messageId) { where.push(`${messageIdColumn} = ?`); params.push(selector.messageId); }
  else { where.push("d.correlation_id = ?"); params.push(selector.correlationId!); }
  if (callerInstance !== null) {
    where.push("(d.source_instance = ? OR d.target_instance = ?)");
    params.push(callerInstance, callerInstance);
  }
  if (selector.cursor) {
    const cursorScope = ["c.delivery_id = ?"];
    const cursorParams: (string | number)[] = [selector.cursor];
    if (selector.operationId) { cursorScope.push("c.operation_id = ?"); cursorParams.push(selector.operationId); }
    else if (selector.messageId) {
      cursorScope.push(`${messageIdColumn.replace(/\bd\./g, "c.")} = ?`);
      cursorParams.push(selector.messageId);
    } else { cursorScope.push("c.correlation_id = ?"); cursorParams.push(selector.correlationId!); }
    if (callerInstance !== null) {
      cursorScope.push("(c.source_instance = ? OR c.target_instance = ?)");
      cursorParams.push(callerInstance, callerInstance);
    }
    where.push(`d.created_seq > (SELECT c.created_seq FROM deliveries c WHERE ${cursorScope.join(" AND ")} LIMIT 1)`);
    params.push(...cursorParams);
  }
  const limit = selector.deliveryId ? 1 : Math.max(1, Math.min(100, selector.limit ?? 20));
  const rows = db.prepare(`
    SELECT d.delivery_id,d.operation_id,d.correlation_id,d.source_instance,d.target_instance,
      d.kind,
      CASE WHEN d.state='submission_started' AND d.reconciliation_pending=1
        THEN 'reconciliation_pending' ELSE d.state END AS state,
      d.attempt_no,d.created_at,d.updated_at,d.last_error,d.payload_json
    FROM deliveries d
    WHERE ${where.join(" AND ")}
    ORDER BY d.created_seq
    LIMIT ?
  `).all(...params, limit + 1) as Array<{
    delivery_id: string;
    operation_id: string;
    correlation_id: string | null;
    source_instance: string;
    target_instance: string;
    kind: string;
    state: OutboxState;
    attempt_no: number;
    created_at: string;
    updated_at: string;
    last_error: string | null;
    payload_json: string;
  }>;
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return {
    items: visible.map(row => ({
      delivery_id: row.delivery_id,
      operation_id: row.operation_id,
      correlation_id: row.correlation_id,
      source_instance: row.source_instance,
      target_instance: row.target_instance,
      kind: row.kind,
      state: row.state,
      attempt_no: row.attempt_no,
      created_at: row.created_at,
      updated_at: row.updated_at,
      status_summary: statusSummary(row.state),
      error_summary: safeErrorSummary(row.last_error),
      safe_to_retry: safeToRetry(row.state),
      // Text only for the explicit verification query (#856), and only to the
      // row's own source/target; every other query keeps #982's redaction.
      ...rowContentEvidence(row.payload_json, callerInstance !== null && !!selector.messageId),
      reply_obligation: obligationFor(db, row.correlation_id, row.source_instance, row.target_instance),
    })),
    next_cursor: hasMore ? visible.at(-1)?.delivery_id ?? null : null,
  };
}

interface ReplyObligationRow {
  correlation_id: string; requester_instance: string; owner_instance: string; request_delivery_id: string;
  opened_at: string; last_asked_at: string; state: "open" | "answered";
  nudged_at: string | null; overdue_notified_at: string | null; answered_at: string | null; answered_delivery_id: string | null;
}

function mapObligation(row: ReplyObligationRow): ReplyObligation {
  return {
    correlationId: row.correlation_id, requesterInstance: row.requester_instance, ownerInstance: row.owner_instance,
    requestDeliveryId: row.request_delivery_id, openedAt: row.opened_at, lastAskedAt: row.last_asked_at, state: row.state,
    nudgedAt: row.nudged_at, overdueNotifiedAt: row.overdue_notified_at, answeredAt: row.answered_at,
    answeredDeliveryId: row.answered_delivery_id,
  };
}

/** Durable admission and fenced state transitions for the fleet delivery queue. */
export class DeliveryOutbox extends EventEmitter {
  private readonly db: Database.Database;
  readonly managerBootId: string;

  constructor(dbPath: string, managerBootId: string = randomUUID()) {
    super();
    this.managerBootId = managerBootId;
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 1000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        source_key TEXT NOT NULL UNIQUE,
        source_instance TEXT NOT NULL,
        source_daemon_boot_id TEXT NOT NULL,
        target_instance TEXT NOT NULL,
        target_session TEXT,
        target_daemon_boot_id TEXT,
        kind TEXT NOT NULL,
        correlation_id TEXT,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued','delivering','submission_started','retry_wait',
          'delivered','failed','uncertain','cancelled'
        )),
        attempt_no INTEGER NOT NULL DEFAULT 0,
        created_seq INTEGER NOT NULL UNIQUE,
        manager_boot_id TEXT,
        response_delivered_at TEXT,
        reconciliation_pending INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        submitted_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_state_seq
        ON deliveries(state, created_seq);
      CREATE INDEX IF NOT EXISTS idx_delivery_target_state_seq
        ON deliveries(target_instance, state, created_seq);
      CREATE INDEX IF NOT EXISTS idx_delivery_operation_source
        ON deliveries(source_instance, operation_id);
      CREATE INDEX IF NOT EXISTS idx_delivery_operation_seq
        ON deliveries(operation_id, created_seq);
      CREATE INDEX IF NOT EXISTS idx_delivery_correlation_seq
        ON deliveries(correlation_id, created_seq);

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
        target_daemon_boot_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('begun','aborted','delivered','failed','uncertain')),
        begin_ack_at TEXT,
        abort_at TEXT,
        finished_at TEXT,
        evidence TEXT,
        backend TEXT,
        window_id TEXT,
        transcript_path TEXT,
        transcript_offset INTEGER,
        transcript_session_id TEXT,
        submission_mode TEXT,
        backend_version TEXT,
        queue_resume_policy TEXT,
        enter_started_at TEXT,
        PRIMARY KEY (delivery_id, target_daemon_boot_id, attempt_no)
      );

      CREATE TABLE IF NOT EXISTS outcome_notices (
        source_instance TEXT NOT NULL,
        source_daemon_boot_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        target_instance TEXT NOT NULL,
        notice_delivery_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_instance, source_daemon_boot_id, operation_id, target_instance)
      );
      CREATE TABLE IF NOT EXISTS reply_obligations (
        correlation_id TEXT NOT NULL,
        requester_instance TEXT NOT NULL,
        owner_instance TEXT NOT NULL,
        request_delivery_id TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        last_asked_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open','answered')),
        nudged_at TEXT,
        overdue_notified_at TEXT,
        answered_at TEXT,
        answered_delivery_id TEXT,
        PRIMARY KEY (correlation_id, requester_instance, owner_instance)
      );
      CREATE INDEX IF NOT EXISTS idx_reply_obligation_owner_state ON reply_obligations(owner_instance, state);
      CREATE TABLE IF NOT EXISTS failure_notices (
        parent_delivery_id TEXT PRIMARY KEY,
        notice_delivery_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    // Additive migration: existing Phase 1 databases keep their row identities,
    // foreign keys, and WAL while gaining reconciliation evidence columns.
    this.ensureColumn("deliveries", "reconciliation_pending", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("delivery_attempts", "backend", "TEXT");
    this.ensureColumn("delivery_attempts", "window_id", "TEXT");
    this.ensureColumn("delivery_attempts", "transcript_path", "TEXT");
    this.ensureColumn("delivery_attempts", "transcript_offset", "INTEGER");
    this.ensureColumn("delivery_attempts", "transcript_session_id", "TEXT");
    this.ensureColumn("delivery_attempts", "submission_mode", "TEXT");
    this.ensureColumn("delivery_attempts", "backend_version", "TEXT");
    this.ensureColumn("delivery_attempts", "queue_resume_policy", "TEXT");
    this.ensureColumn("delivery_attempts", "enter_started_at", "TEXT");
    // #856: a receiver can look a message up by the ID in its envelope, and
    // admission vs pane-write digests tell transport rewrites apart from a
    // receiver acting on a message nobody sent.
    this.ensureColumn("deliveries", "message_id", "TEXT");
    this.ensureColumn("deliveries", "content_sha256", "TEXT");
    this.ensureColumn("delivery_attempts", "pasted_content_sha256", "TEXT");
    this.ensureColumn("delivery_attempts", "pasted_bytes_sha256", "TEXT");
    this.ensureColumn("delivery_attempts", "content_digest_mismatch", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_delivery_message_id ON deliveries(message_id)");
    this.backfillMessageEvidence();
    this.db.pragma("user_version = 4");
  }

  /**
   * #926: a delivered `requires_reply` request opens (or, asked again,
   * re-opens) the owner's obligation. Runs inside the delivered transition.
   * An answer admitted before the request finished its submission proof —
   * an owner can reply while the daemon is still confirming — counts.
   */
  private openReplyObligation(request: OutboxRow, now: string): void {
    if (!(REPLY_OBLIGATION_KINDS as readonly string[]).includes(request.kind) || !request.correlation_id) return;
    let payload: unknown = null;
    try { payload = JSON.parse(request.payload_json); } catch { return; }
    if (!payloadRequiresReply(payload)) return;
    const earlyAnswer = this.db.prepare(`
      SELECT delivery_id FROM deliveries
      WHERE correlation_id=? AND source_instance=? AND target_instance=? AND created_seq > ?
        AND kind IN (${REPLY_OBLIGATION_KINDS.map(() => "?").join(",")})
      ORDER BY created_seq LIMIT 1
    `).get(request.correlation_id, request.target_instance, request.source_instance, request.created_seq, ...REPLY_OBLIGATION_KINDS) as { delivery_id: string } | undefined;
    this.db.prepare(`
      INSERT INTO reply_obligations(correlation_id, requester_instance, owner_instance, request_delivery_id,
        opened_at, last_asked_at, state, answered_at, answered_delivery_id)
      VALUES (@cid, @requester, @owner, @request, @now, @now, @state, @answeredAt, @answeredId)
      ON CONFLICT(correlation_id, requester_instance, owner_instance) DO UPDATE SET
        request_delivery_id=excluded.request_delivery_id, last_asked_at=excluded.last_asked_at,
        state=excluded.state, nudged_at=NULL, overdue_notified_at=NULL,
        answered_at=excluded.answered_at, answered_delivery_id=excluded.answered_delivery_id
    `).run({
      cid: request.correlation_id, requester: request.source_instance, owner: request.target_instance,
      request: request.delivery_id, now,
      state: earlyAnswer ? "answered" : "open",
      answeredAt: earlyAnswer ? now : null, answeredId: earlyAnswer?.delivery_id ?? null,
    });
  }

  /** The owner's message back to the requester on the same correlation_id answers it — at admission. */
  private answerReplyObligation(answer: OutboxRow, now: string): void {
    if (!(REPLY_OBLIGATION_KINDS as readonly string[]).includes(answer.kind) || !answer.correlation_id) return;
    this.db.prepare(`
      UPDATE reply_obligations SET state='answered', answered_at=?, answered_delivery_id=?
      WHERE correlation_id=? AND owner_instance=? AND requester_instance=? AND state='open'
    `).run(now, answer.delivery_id, answer.correlation_id, answer.source_instance, answer.target_instance);
  }

  /**
   * #926 safety net 1: remind an owner that has not answered. `turn-ended`
   * reminds once per ask, after the grace (a reply seconds after the ask is
   * normal); `restart` reminds once per restart, because the interrupted turn
   * does not resume on its own. Marked in the same transaction as the notice.
   */
  remindReplyObligations(ownerInstance: string, opts: { now?: Date; graceMs: number; reason: "turn-ended" | "restart"; since?: Date }): number {
    const now = opts.now ?? new Date();
    const nowIso = now.toISOString();
    const graceCutoff = new Date(now.getTime() - opts.graceMs).toISOString();
    const sinceIso = (opts.since ?? now).toISOString();
    const inserted = this.db.transaction(() => {
      const due = this.db.prepare(opts.reason === "turn-ended"
        ? "SELECT * FROM reply_obligations WHERE owner_instance=? AND state='open' AND nudged_at IS NULL AND last_asked_at <= ?"
        : "SELECT * FROM reply_obligations WHERE owner_instance=? AND state='open' AND (nudged_at IS NULL OR nudged_at < ?)",
      ).all(ownerInstance, opts.reason === "turn-ended" ? graceCutoff : sinceIso) as ReplyObligationRow[];
      let count = 0;
      for (const row of due) {
        const content = opts.reason === "turn-ended"
          ? `[system:reply-pending] Your turn ended without answering ${row.requester_instance} (correlation_id ${row.correlation_id}, asked ${row.last_asked_at}). Send your conclusion with report_result (correlation_id ${row.correlation_id}) now — text you write in the terminal does not reach them.`
          : `[system:reply-pending] A restart interrupted your work on correlation_id ${row.correlation_id} from ${row.requester_instance} (asked ${row.last_asked_at}). Resume it and answer with report_result (correlation_id ${row.correlation_id}); terminal text does not reach them.`;
        const key = `reply-pending:${opts.reason}:${row.correlation_id}:${row.requester_instance}:${row.owner_instance}:${opts.reason === "turn-ended" ? row.last_asked_at : sinceIso}`;
        if (this.insertReplyObligationNotice(row.owner_instance, row.correlation_id, key, content, nowIso)) count++;
        this.db.prepare(`
          UPDATE reply_obligations SET nudged_at=? WHERE correlation_id=? AND requester_instance=? AND owner_instance=? AND state='open'
        `).run(nowIso, row.correlation_id, row.requester_instance, row.owner_instance);
      }
      return count;
    })();
    if (inserted > 0) this.emit("admitted");
    return inserted;
  }

  /**
   * #926 safety net 2 (poll-on-timeout, in code): tell the requester once when
   * the owner is not working and nothing has come back for `overdueMs` since
   * the last ask or reminder. A still-working owner is never reported.
   */
  notifyOverdueReplyObligations(opts: { now?: Date; overdueMs: number; ownerIdle: (owner: string) => boolean }): number {
    if (!(opts.overdueMs > 0)) return 0;
    const now = opts.now ?? new Date();
    const nowIso = now.toISOString();
    const inserted = this.db.transaction(() => {
      const open = this.db.prepare(`
        SELECT * FROM reply_obligations WHERE state='open' AND overdue_notified_at IS NULL ORDER BY opened_at
      `).all() as ReplyObligationRow[];
      let count = 0;
      for (const row of open) {
        const quietSince = Math.max(Date.parse(row.last_asked_at), row.nudged_at ? Date.parse(row.nudged_at) : 0);
        if (now.getTime() - quietSince < opts.overdueMs || !opts.ownerIdle(row.owner_instance)) continue;
        const content = `[system:reply-overdue] ${row.owner_instance} has not answered correlation_id ${row.correlation_id} (asked ${row.last_asked_at}${row.nudged_at ? `, reminded ${row.nudged_at}` : ""}) and is not working on anything now. Check with describe_instance or delivery_status (correlation_id ${row.correlation_id}), or ask again.`;
        const key = `reply-overdue:${row.correlation_id}:${row.requester_instance}:${row.owner_instance}:${row.last_asked_at}`;
        if (this.insertReplyObligationNotice(row.requester_instance, row.correlation_id, key, content, nowIso)) count++;
        this.db.prepare(`
          UPDATE reply_obligations SET overdue_notified_at=? WHERE correlation_id=? AND requester_instance=? AND owner_instance=? AND state='open'
        `).run(nowIso, row.correlation_id, row.requester_instance, row.owner_instance);
      }
      return count;
    })();
    if (inserted > 0) this.emit("admitted");
    return inserted;
  }

  /** A system notice as a durable row, like #929's outcome notices; the key makes it idempotent. */
  private insertReplyObligationNotice(target: string, correlationId: string, sourceKey: string, content: string, now: string): boolean {
    const noticeId = randomUUID();
    const payload = {
      type: "fleet_inbound",
      content,
      meta: {
        user: "AgEnD delivery outbox", user_id: "agend-system", message_id: `reply-obligation-${noticeId}`,
        chat_id: "", thread_id: "", source: "delivery-outbox",
      },
    };
    return this.db.prepare(`
      INSERT OR IGNORE INTO deliveries (
        delivery_id,operation_id,source_key,source_instance,source_daemon_boot_id,
        target_instance,target_session,target_daemon_boot_id,kind,correlation_id,payload_json,message_id,content_sha256,state,
        attempt_no,created_seq,manager_boot_id,created_at,updated_at,accepted_at
      ) VALUES (?,?,?,'agend-system',?,?,NULL,NULL,?,?,?,?,?,'queued',0,
        (SELECT COALESCE(MAX(created_seq),0)+1 FROM deliveries),NULL,?,?,?)
    `).run(
      noticeId, `notice:${sourceKey}`, sourceKey, this.managerBootId, target, REPLY_OBLIGATION_NOTICE_KIND, correlationId,
      JSON.stringify(payload), payload.meta.message_id, deliveryContentDigest(content), now, now, now,
    ).changes === 1;
  }

  /** The owner's open obligations, oldest first (#926). */
  openReplyObligations(ownerInstance: string): ReplyObligation[] {
    const rows = this.db.prepare(`
      SELECT * FROM reply_obligations WHERE owner_instance=? AND state='open' ORDER BY opened_at, correlation_id
    `).all(ownerInstance) as ReplyObligationRow[];
    return rows.map(mapObligation);
  }

  getReplyObligation(correlationId: string, requesterInstance: string, ownerInstance: string): ReplyObligation | undefined {
    const row = this.db.prepare(`
      SELECT * FROM reply_obligations WHERE correlation_id=? AND requester_instance=? AND owner_instance=?
    `).get(correlationId, requesterInstance, ownerInstance) as ReplyObligationRow | undefined;
    return row ? mapObligation(row) : undefined;
  }

  /** Rows admitted before #856 get the same message_id / digest a new row would. */
  private backfillMessageEvidence(): void {
    const rows = this.db.prepare(`
      SELECT delivery_id, payload_json FROM deliveries WHERE message_id IS NULL AND content_sha256 IS NULL
    `).all() as Array<{ delivery_id: string; payload_json: string }>;
    if (rows.length === 0) return;
    const update = this.db.prepare("UPDATE deliveries SET message_id=?, content_sha256=? WHERE delivery_id=?");
    this.db.transaction(() => {
      for (const row of rows) {
        let payload: unknown = null;
        try { payload = JSON.parse(row.payload_json); } catch { continue; }
        const content = payloadContent(payload);
        update.run(payloadMessageId(payload), content === null ? null : deliveryContentDigest(content), row.delivery_id);
      }
    })();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some(item => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** Commit admission before returning success. Duplicate source keys return their original row. */
  admit(input: NewOutboxDelivery): { delivery: OutboxDelivery; inserted: boolean } {
    const now = new Date().toISOString();
    const deliveryId = randomUUID();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO deliveries (
        delivery_id, operation_id, source_key, source_instance, source_daemon_boot_id,
        target_instance, target_session, kind, correlation_id, payload_json, message_id, content_sha256, state,
        attempt_no, created_seq, manager_boot_id, created_at, updated_at, accepted_at
      ) VALUES (
        @delivery_id, @operation_id, @source_key, @source_instance, @source_daemon_boot_id,
        @target_instance, @target_session, @kind, @correlation_id, @payload_json, @message_id, @content_sha256, 'queued',
        0, (SELECT COALESCE(MAX(created_seq), 0) + 1 FROM deliveries), NULL,
        @created_at, @updated_at, @accepted_at
      )
    `);
    const select = this.db.prepare("SELECT * FROM deliveries WHERE source_key = ?");
    const transaction = this.db.transaction(() => {
      const result = insert.run({
        delivery_id: deliveryId,
        operation_id: input.operationId,
        source_key: input.sourceKey,
        source_instance: input.sourceInstance,
        source_daemon_boot_id: input.sourceDaemonBootId,
        target_instance: input.targetInstance,
        target_session: input.targetSession ?? null,
        kind: input.kind,
        correlation_id: input.correlationId ?? null,
        payload_json: JSON.stringify(input.payload),
        message_id: payloadMessageId(input.payload),
        content_sha256: (content => content === null ? null : deliveryContentDigest(content))(payloadContent(input.payload)),
        created_at: now,
        updated_at: now,
        accepted_at: now,
      });
      const row = select.get(input.sourceKey) as OutboxRow | undefined;
      if (!row) throw new Error("outbox admission committed without a readable row");
      if (result.changes === 1) this.answerReplyObligation(row, now);
      return { delivery: mapRow(row), inserted: result.changes === 1 };
    });
    return transaction();
  }

  get(deliveryId: string): OutboxDelivery | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId) as OutboxRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  getByOperation(sourceInstance: string, operationId: string): OutboxDelivery[] {
    const rows = this.db.prepare(`
      SELECT * FROM deliveries WHERE source_instance = ? AND operation_id = ? ORDER BY created_seq
    `).all(sourceInstance, operationId) as OutboxRow[];
    return rows.map(mapRow);
  }

  /**
   * Query only rows owned by the authenticated instance as source or target.
   * This method accepts caller identity separately from user arguments so a
   * caller cannot widen its own visibility with a forged source name.
   */
  queryStatusForInstance(callerInstance: string, selector: DeliveryStatusSelector): DeliveryStatusPage {
    return queryStatusPage(this.db, selector, callerInstance);
  }

  /** Open the existing outbox without migrations or writes for the operator CLI. */
  static queryStatusReadOnly(dbPath: string, selector: DeliveryStatusSelector): DeliveryStatusPage {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma("busy_timeout = 1000");
      db.pragma("query_only = ON");
      return queryStatusPage(db, selector, null);
    } finally {
      db.close();
    }
  }

  listPending(): OutboxDelivery[] {
    const rows = this.db.prepare(`
      SELECT * FROM deliveries
      WHERE state IN ('queued','delivering','submission_started','retry_wait')
      ORDER BY created_seq
    `).all() as OutboxRow[];
    return rows.map(mapRow);
  }

  /** Rows addressed to `target` in any of `states` (indexed: target_instance, state). */
  countForTarget(target: string, states: readonly OutboxState[]): number {
    if (states.length === 0) return 0;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM deliveries
      WHERE target_instance=? AND state IN (${states.map(() => "?").join(",")})
    `).get(target, ...states) as { n: number };
    return row.n;
  }

  nextRetryAt(): string | null {
    const row = this.db.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at FROM deliveries
      WHERE state='retry_wait' AND next_attempt_at IS NOT NULL
    `).get() as { next_attempt_at: string | null };
    return row.next_attempt_at;
  }

  /** Claim the earliest eligible target row; one caller owns each target lane. */
  claimNext(
    managerBootId: string,
    targetBootIdFor: (target: string) => string | null,
    blockedTargets: ReadonlySet<string>,
  ): ClaimedOutboxDelivery | undefined {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM deliveries WHERE state IN ('queued','retry_wait')
      ORDER BY created_seq
    `).all() as OutboxRow[];
    // The oldest pending row owns its target lane even while it is in retry
    // backoff or the target is temporarily unavailable. Later rows must not
    // pass it merely because they happen to be eligible first.
    const reconciliationTargets = new Set((this.db.prepare(`
      SELECT DISTINCT target_instance FROM deliveries
      WHERE state='submission_started' AND reconciliation_pending=1
    `).all() as Array<{ target_instance: string }>).map(item => item.target_instance));
    const visitedTargets = new Set<string>();
    for (const row of rows) {
      if (visitedTargets.has(row.target_instance)) continue;
      visitedTargets.add(row.target_instance);
      if (blockedTargets.has(row.target_instance)) continue;
      // A recovered submission owns only its target lane while its evidence is
      // classified; independent targets can keep dispatching.
      if (reconciliationTargets.has(row.target_instance)) continue;
      if (row.state === "retry_wait" && row.next_attempt_at && row.next_attempt_at > now) continue;
      const targetBootId = targetBootIdFor(row.target_instance);
      if (!targetBootId) continue;
      const claimedAt = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE deliveries
        SET state='delivering', target_daemon_boot_id=?, manager_boot_id=?,
            attempt_no=attempt_no+1, updated_at=?, last_error=NULL,next_attempt_at=NULL
        WHERE delivery_id=? AND state IN ('queued','retry_wait')
      `).run(targetBootId, managerBootId, claimedAt, row.delivery_id);
      if (result.changes !== 1) continue;
      const claimed = this.get(row.delivery_id);
      if (claimed) return { ...claimed, targetDaemonBootId: targetBootId };
    }
    return undefined;
  }

  /** Idempotent begin permit, committed immediately before the pane side effect. */
  begin(deliveryId: string, targetBootId: string, attemptNo: number, evidence?: DeliveryAttemptEvidence): "begun" | "duplicate" | "stale" {
    const now = new Date().toISOString();
    const transaction = this.db.transaction((): { outcome: "begun" | "duplicate" | "stale"; failed: boolean; mismatch?: boolean } => {
      const row = this.db.prepare("SELECT * FROM deliveries WHERE delivery_id=?").get(deliveryId) as OutboxRow | undefined;
      if (!row || row.target_daemon_boot_id !== targetBootId || row.attempt_no !== attemptNo) {
        return { outcome: "stale", failed: false };
      }
      const existing = this.db.prepare(`
        SELECT state FROM delivery_attempts
        WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=?
      `).get(deliveryId, targetBootId, attemptNo) as { state: string } | undefined;
      if (existing) return { outcome: existing.state === "begun" ? "duplicate" : "stale", failed: false };
      if (row.state !== "delivering") return { outcome: "stale", failed: false };
      const started = this.db.prepare(`
        SELECT COUNT(*) AS count FROM delivery_attempts WHERE delivery_id=?
      `).get(deliveryId) as { count: number };
      // Only a digest on BOTH sides can disagree: a pre-#856 row or a caller
      // that could not hash is "unknown", never a mismatch.
      const mismatch = !!row.content_sha256 && !!evidence?.pastedContentSha256
        && row.content_sha256 !== evidence.pastedContentSha256;
      if (started.count >= DURABLE_DELIVERY_MAX_ATTEMPTS) {
        const update = this.db.prepare(`
          UPDATE deliveries SET state='failed',updated_at=?,finished_at=?,last_error='delivery submission attempt limit reached'
          WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=? AND state='delivering'
        `).run(now, now, deliveryId, targetBootId, attemptNo);
        if (update.changes !== 1) return { outcome: "stale", failed: false };
        this.insertFailureNotice(row, "failed", "delivery submission attempt limit reached", now);
        return { outcome: "stale", failed: true };
      }
      this.db.prepare(`
        INSERT INTO delivery_attempts(
          delivery_id,target_daemon_boot_id,attempt_no,state,begin_ack_at,
          backend,window_id,transcript_path,transcript_offset,transcript_session_id,submission_mode,
          backend_version,queue_resume_policy,pasted_content_sha256,pasted_bytes_sha256,content_digest_mismatch
        ) VALUES (?,?,?,'begun',?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        deliveryId, targetBootId, attemptNo, now,
        evidence?.backend ?? null,
        evidence?.windowId ?? null,
        evidence?.transcriptPath ?? null,
        evidence?.transcriptOffset ?? null,
        evidence?.transcriptSessionId ?? null,
        evidence?.submissionMode ?? null,
        evidence?.backendVersion ?? null,
        evidence?.queueResumePolicy ?? null,
        evidence?.pastedContentSha256 ?? null,
        evidence?.pastedBytesSha256 ?? null,
        mismatch ? 1 : 0,
      );
      this.db.prepare(`
        UPDATE deliveries SET state='submission_started', submitted_at=?, updated_at=?
        WHERE delivery_id=? AND state='delivering'
      `).run(now, now, deliveryId);
      return { outcome: "begun", failed: false, mismatch };
    });
    const result = transaction();
    if (result.mismatch) {
      this.emit("content_digest_mismatch", { deliveryId, targetBootId, attemptNo, targetInstance: this.get(deliveryId)?.targetInstance });
    }
    if (result.outcome === "begun") this.emit("state", { deliveryId, state: "submission_started" });
    else if (result.failed) this.emit("state", { deliveryId, state: "failed" });
    return result.outcome;
  }

  /** Write-ahead fence: commit before tmux is allowed to receive Enter. */
  markEnterStarted(deliveryId: string, targetBootId: string, attemptNo: number): boolean {
    const now = new Date().toISOString();
    const changed = this.db.prepare(`
      UPDATE delivery_attempts SET enter_started_at=COALESCE(enter_started_at,?)
      WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=? AND state='begun'
        AND EXISTS (
          SELECT 1 FROM deliveries WHERE delivery_id=? AND target_daemon_boot_id=?
            AND attempt_no=? AND state='submission_started'
        )
    `).run(now, deliveryId, targetBootId, attemptNo, deliveryId, targetBootId, attemptNo).changes;
    return changed === 1;
  }

  /** Safe only when the caller can prove no pane write occurred for this attempt. */
  abort(deliveryId: string, targetBootId: string, attemptNo: number, reason: string): boolean {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const attempt = this.db.prepare(`
        SELECT state FROM delivery_attempts
        WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=?
      `).get(deliveryId, targetBootId, attemptNo) as { state: string } | undefined;
      if (attempt?.state === "aborted") return true;
      if (attempt?.state !== "begun") return false;
      const delivery = this.db.prepare(`
        SELECT state,target_daemon_boot_id,attempt_no FROM deliveries WHERE delivery_id=?
      `).get(deliveryId) as { state: string; target_daemon_boot_id: string | null; attempt_no: number } | undefined;
      if (delivery?.state !== "submission_started"
        || delivery.target_daemon_boot_id !== targetBootId
        || delivery.attempt_no !== attemptNo) return false;
      const updateAttempt = this.db.prepare(`
        UPDATE delivery_attempts SET state='aborted',abort_at=?,evidence=?
        WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=? AND state='begun'
      `).run(now, reason.slice(0, 300), deliveryId, targetBootId, attemptNo);
      if (updateAttempt.changes !== 1) return false;
      const updateDelivery = this.db.prepare(`
        UPDATE deliveries SET state='retry_wait',reconciliation_pending=0,updated_at=?,last_error=?,next_attempt_at=?
        WHERE delivery_id=? AND state='submission_started' AND target_daemon_boot_id=? AND attempt_no=?
      `).run(
        now,
        reason.slice(0, 300),
        new Date(Date.now() + DURABLE_DELIVERY_ABORT_BACKOFF_MS).toISOString(),
        deliveryId,
        targetBootId,
        attemptNo,
      );
      if (updateDelivery.changes !== 1) throw new Error("outbox abort lost its delivery fence");
      return true;
    });
    const changed = transaction();
    if (changed) this.emit("state", { deliveryId, state: "retry_wait" });
    return changed;
  }

  complete(
    deliveryId: string,
    targetBootId: string,
    attemptNo: number,
    outcome: "delivered" | "failed" | "uncertain",
    evidence?: string,
  ): boolean {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const parent = this.db.prepare("SELECT * FROM deliveries WHERE delivery_id=?").get(deliveryId) as OutboxRow | undefined;
      const result = this.db.prepare(`
        UPDATE deliveries SET state=?,reconciliation_pending=0,updated_at=?,finished_at=?,last_error=?
        WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=? AND state='submission_started'
      `).run(outcome, now, now, outcome === "delivered" ? null : (evidence ?? outcome).slice(0, 300), deliveryId, targetBootId, attemptNo);
      if (result.changes !== 1) {
        const existing = this.db.prepare("SELECT state FROM deliveries WHERE delivery_id=?").get(deliveryId) as { state: string } | undefined;
        return { changed: false, accepted: existing?.state === outcome };
      }
      this.db.prepare(`
        UPDATE delivery_attempts SET state=?,finished_at=?,evidence=?
        WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=? AND state='begun'
      `).run(outcome, now, evidence?.slice(0, 300) ?? null, deliveryId, targetBootId, attemptNo);
      if (parent && (outcome === "failed" || outcome === "uncertain")) {
        this.insertFailureNotice(parent, outcome, evidence ?? outcome, now);
      }
      if (parent && outcome === "delivered") this.openReplyObligation(parent, now);
      return { changed: true, accepted: true };
    });
    const result = transaction();
    if (result.changed) this.emit("state", { deliveryId, state: outcome });
    return result.accepted;
  }

  /** Transient pre-submit failure: state is retryable and the same row keeps its FIFO position. */
  retryBeforeBegin(deliveryId: string, targetBootId: string, attemptNo: number, reason: string, delayMs = 30_000): boolean {
    const now = new Date().toISOString();
    const next = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM deliveries WHERE delivery_id=?").get(deliveryId) as OutboxRow | undefined;
      if (!row || row.target_daemon_boot_id !== targetBootId || row.attempt_no !== attemptNo || row.state !== "delivering") {
        return undefined;
      }
      const ageMs = Date.now() - Date.parse(row.created_at);
      // Readiness and idle deferrals occur before begin and do not consume the
      // submission-attempt budget. The age limit remains the visible bound for
      // work that never reaches a pane-side-effect attempt.
      const exhausted = ageMs >= DURABLE_DELIVERY_MAX_AGE_MS;
      const outcome = exhausted ? "failed" : "retry_wait";
      const update = this.db.prepare(`
        UPDATE deliveries SET state=?,updated_at=?,finished_at=?,last_error=?,next_attempt_at=?
        WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=? AND state='delivering'
      `).run(outcome, now, exhausted ? now : null, reason.slice(0, 300), exhausted ? null : next,
        deliveryId, targetBootId, attemptNo);
      if (update.changes !== 1) return undefined;
      if (exhausted) this.insertFailureNotice(row, "failed", `${reason}; delivery age limit reached`, now);
      return outcome;
    });
    const outcome = transaction();
    if (outcome) this.emit("state", { deliveryId, state: outcome });
    return outcome !== undefined;
  }

  failBeforeBegin(deliveryId: string, reason: string): boolean {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM deliveries WHERE delivery_id=?").get(deliveryId) as OutboxRow | undefined;
      if (!row) return false;
      const changed = this.db.prepare(`
        UPDATE deliveries SET state='failed',updated_at=?,finished_at=?,last_error=?,next_attempt_at=NULL
        WHERE delivery_id=? AND state IN ('queued','delivering','retry_wait')
      `).run(now, now, reason.slice(0, 300), deliveryId).changes === 1;
      if (changed) this.insertFailureNotice(row, "failed", reason, now);
      return changed;
    });
    const changed = transaction();
    if (changed) this.emit("state", { deliveryId, state: "failed" });
    return changed;
  }

  /** Bound both unavailable rows and unresolved reconciliation without stealing a live lease. */
  expireStale(nowMs = Date.now(), maxAgeMs = DURABLE_DELIVERY_MAX_AGE_MS): number {
    const cutoff = new Date(nowMs - maxAgeMs).toISOString();
    const now = new Date(nowMs).toISOString();
    const transaction = this.db.transaction(() => {
      const stale = this.db.prepare(`
        SELECT * FROM deliveries
        WHERE state IN ('queued','retry_wait') AND created_at<=?
        ORDER BY created_seq
      `).all(cutoff) as OutboxRow[];
      const update = this.db.prepare(`
        UPDATE deliveries SET state='failed',updated_at=?,finished_at=?,last_error='delivery TTL expired before target became available',next_attempt_at=NULL
        WHERE delivery_id=? AND state IN ('queued','retry_wait')
      `);
      let changed = 0;
      let uncertain = 0;
      for (const row of stale) {
        if (update.run(now, now, row.delivery_id).changes !== 1) continue;
        this.insertFailureNotice(row, "failed", "delivery TTL expired before target became available", now);
        changed++;
      }
      const unresolved = this.db.prepare(`
        SELECT * FROM deliveries
        WHERE state='submission_started' AND reconciliation_pending=1 AND created_at<=?
        ORDER BY created_seq
      `).all(cutoff) as OutboxRow[];
      const markUncertain = this.db.prepare(`
        UPDATE deliveries SET state='uncertain',reconciliation_pending=0,updated_at=?,finished_at=?,
          last_error='reconciliation TTL expired without sufficient evidence'
        WHERE delivery_id=? AND state='submission_started' AND reconciliation_pending=1
      `);
      for (const row of unresolved) {
        if (markUncertain.run(now, now, row.delivery_id).changes !== 1) continue;
        this.db.prepare(`
          UPDATE delivery_attempts SET state='uncertain',finished_at=?,evidence='reconciliation TTL expired without sufficient evidence'
          WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=? AND state='begun'
        `).run(now, row.delivery_id, row.target_daemon_boot_id, row.attempt_no);
        this.insertFailureNotice(row, "uncertain", "reconciliation TTL expired without sufficient evidence", now);
        changed++;
        uncertain++;
      }
      return { changed, uncertain };
    });
    const result = transaction();
    if (result.changed) this.emit("expired", { count: result.changed, uncertain: result.uncertain });
    return result.changed;
  }

  /** Next queued/retry expiry for bounded maintenance scheduling. */
  nextExpiryAt(): string | null {
    const row = this.db.prepare(`
      SELECT MIN(created_at) AS created_at FROM deliveries
      WHERE state IN ('queued','retry_wait') OR (state='submission_started' AND reconciliation_pending=1)
    `).get() as { created_at: string | null };
    return row.created_at ? new Date(Date.parse(row.created_at) + DURABLE_DELIVERY_MAX_AGE_MS).toISOString() : null;
  }

  markResponseDelivered(sourceInstance: string, operationId: string): number {
    const now = new Date().toISOString();
    return this.db.prepare(`
      UPDATE deliveries SET response_delivered_at=?,updated_at=?
      WHERE source_instance=? AND operation_id=? AND response_delivered_at IS NULL
    `).run(now, now, sourceInstance, operationId).changes;
  }

  /** Old process leases are recoverable; an old submission attempt needs evidence reconciliation. */
  recoverForBoot(managerBootId: string): { queued: number; reconciliationPending: number } {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const queued = this.db.prepare(`
        UPDATE deliveries SET state='queued',manager_boot_id=NULL,target_daemon_boot_id=NULL,next_attempt_at=NULL,updated_at=?
        WHERE manager_boot_id IS NOT NULL AND manager_boot_id<>? AND state IN ('delivering','retry_wait')
      `).run(now, managerBootId).changes;
      // Keep the submission fence and target lane while bounded pane/transcript
      // evidence is captured. Never replay an in-flight row blindly.
      const reconciliationPending = this.db.prepare(`
        UPDATE deliveries SET reconciliation_pending=1,updated_at=?,last_error='process restarted during submission; reconciliation required'
        WHERE manager_boot_id IS NOT NULL AND manager_boot_id<>? AND state='submission_started'
      `).run(now, managerBootId).changes;
      return { queued, reconciliationPending };
    });
    return transaction();
  }

  /** Atomically create a post-restart notice for an accepted operation whose response was not recorded. */
  admitPostRestartOutcomeNotice(parent: OutboxDelivery, currentSourceBootId: string): OutboxDelivery | undefined {
    const sourceKey = `post-restart:${parent.sourceInstance}:${parent.sourceDaemonBootId}:${parent.operationId}:${parent.targetInstance}`;
    const operationId = `notice:${parent.sourceDaemonBootId}:${parent.operationId}:${parent.targetInstance}`;
    const now = new Date().toISOString();
    const deliveryId = randomUUID();
    const noticeText = `[system:delivery-outcome] A previous tool operation was durably accepted before restart. operation_id=${parent.operationId}; target=${parent.targetInstance}; current_state=${parent.state}. Do not resend this operation. Ask the operator to inspect its delivery status.`;
    const payload = {
      type: "fleet_inbound",
      content: noticeText,
      meta: {
        user: "AgEnD recovery",
        user_id: "agend-system",
        message_id: `delivery-notice-${parent.operationId}-${parent.targetInstance}`,
        chat_id: "",
        thread_id: "",
        source: "delivery-outbox",
      },
    };
    const transaction = this.db.transaction(() => {
      const prior = this.db.prepare(`
        SELECT d.* FROM outcome_notices n JOIN deliveries d ON d.delivery_id=n.notice_delivery_id
        WHERE n.source_instance=? AND n.source_daemon_boot_id=? AND n.operation_id=? AND n.target_instance=?
      `).get(parent.sourceInstance, parent.sourceDaemonBootId, parent.operationId, parent.targetInstance) as OutboxRow | undefined;
      if (prior) return mapRow(prior);
      const terminalNotice = this.db.prepare(`
        SELECT d.* FROM failure_notices n JOIN deliveries d ON d.delivery_id=n.notice_delivery_id
        WHERE n.parent_delivery_id=?
      `).get(parent.deliveryId) as OutboxRow | undefined;
      if (terminalNotice) return mapRow(terminalNotice);
      const reserved = this.db.prepare(`
        INSERT OR IGNORE INTO outcome_notices
        (source_instance,source_daemon_boot_id,operation_id,target_instance,notice_delivery_id,created_at)
        VALUES (?,?,?,?,?,?)
      `).run(parent.sourceInstance, parent.sourceDaemonBootId, parent.operationId, parent.targetInstance, deliveryId, now);
      if (reserved.changes !== 1) return undefined;
      this.db.prepare(`
        INSERT INTO deliveries (
          delivery_id,operation_id,source_key,source_instance,source_daemon_boot_id,
          target_instance,target_session,kind,correlation_id,payload_json,state,
          attempt_no,created_seq,manager_boot_id,created_at,updated_at,accepted_at
        ) VALUES (?,?,?,?,?,?,NULL,'post_restart_outcome_notice',NULL,?,'queued',0,
          (SELECT COALESCE(MAX(created_seq),0)+1 FROM deliveries),NULL,?,?,?)
      `).run(
        deliveryId,
        operationId,
        sourceKey,
        "agend-system",
        currentSourceBootId,
        parent.sourceInstance,
        JSON.stringify(payload),
        now,
        now,
        now,
      );
      return mapRow(this.db.prepare("SELECT * FROM deliveries WHERE delivery_id=?").get(deliveryId) as OutboxRow);
    });
    const notice = transaction();
    if (notice) this.emit("admitted", notice);
    return notice;
  }

  recoverTargetGeneration(targetInstance: string, currentTargetBootId: string): { queued: number; reconciliationPending: number } {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const queued = this.db.prepare(`
        UPDATE deliveries SET state='queued',manager_boot_id=NULL,target_daemon_boot_id=NULL,next_attempt_at=NULL,updated_at=?
        WHERE target_instance=? AND target_daemon_boot_id IS NOT NULL AND target_daemon_boot_id<>?
          AND state IN ('delivering','retry_wait')
      `).run(now, targetInstance, currentTargetBootId).changes;
      const reconciliationPending = this.db.prepare(`
        UPDATE deliveries SET reconciliation_pending=1,updated_at=?,last_error='target daemon generation changed during submission; reconciliation required'
        WHERE target_instance=? AND target_daemon_boot_id IS NOT NULL AND target_daemon_boot_id<>?
          AND state='submission_started'
      `).run(now, targetInstance, currentTargetBootId).changes;
      return { queued, reconciliationPending };
    });
    const result = transaction();
    if (result.queued + result.reconciliationPending > 0) this.emit("generation_recovered", { targetInstance, ...result });
    return result;
  }

  /** Fence in-flight writes before an in-process target stop begins. */
  markTargetReconciliationPending(targetInstance: string, targetBootId: string): number {
    const now = new Date().toISOString();
    return this.db.prepare(`
      UPDATE deliveries SET reconciliation_pending=1,updated_at=?,last_error='target daemon stopping; reconciliation required'
      WHERE target_instance=? AND target_daemon_boot_id=? AND state='submission_started'
    `).run(now, targetInstance, targetBootId).changes;
  }

  getReconciliationCandidates(targetInstance: string): DeliveryReconciliationCandidate[] {
    const rows = this.db.prepare(`
      SELECT d.*, a.target_daemon_boot_id AS attempt_target_boot_id,
        a.attempt_no AS attempt_attempt_no, a.backend AS attempt_backend,
        a.window_id AS attempt_window_id, a.transcript_path AS attempt_transcript_path,
        a.transcript_offset AS attempt_transcript_offset,
        a.transcript_session_id AS attempt_transcript_session_id,
        a.submission_mode AS attempt_submission_mode, a.backend_version AS attempt_backend_version,
        a.queue_resume_policy AS attempt_queue_resume_policy,
        a.enter_started_at AS attempt_enter_started_at
      FROM deliveries d JOIN delivery_attempts a ON a.delivery_id=d.delivery_id
        AND a.attempt_no=d.attempt_no AND a.target_daemon_boot_id=d.target_daemon_boot_id
      WHERE d.target_instance=? AND d.state='submission_started' AND d.reconciliation_pending=1
      ORDER BY d.created_seq
    `).all(targetInstance) as Array<OutboxRow & {
      attempt_target_boot_id: string; attempt_attempt_no: number; attempt_backend: string | null;
      attempt_window_id: string | null; attempt_transcript_path: string | null;
      attempt_transcript_offset: number | null; attempt_transcript_session_id: string | null;
      attempt_submission_mode: DurableSubmissionMode | null; attempt_backend_version: string | null;
      attempt_queue_resume_policy: QueueResumePolicy | null; attempt_enter_started_at: string | null;
    }>;
    return rows.map(row => ({
      ...mapRow(row),
      attempt: {
        targetDaemonBootId: row.attempt_target_boot_id,
        attemptNo: row.attempt_attempt_no,
        backend: row.attempt_backend,
        backendVersion: row.attempt_backend_version,
        windowId: row.attempt_window_id,
        transcriptPath: row.attempt_transcript_path,
        transcriptOffset: row.attempt_transcript_offset,
        transcriptSessionId: row.attempt_transcript_session_id,
        submissionMode: row.attempt_submission_mode,
        queueResumePolicy: row.attempt_queue_resume_policy,
        enterStartedAt: row.attempt_enter_started_at,
      },
    }));
  }

  /** Atomically settle one old attempt using only its boot/attempt fence. */
  reconcileAttempt(
    deliveryId: string,
    targetBootId: string,
    attemptNo: number,
    outcome: "delivered" | "retry_wait" | "uncertain",
    evidence: string,
  ): boolean {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const parent = this.db.prepare("SELECT * FROM deliveries WHERE delivery_id=?").get(deliveryId) as OutboxRow | undefined;
      if (!parent || parent.state !== "submission_started" || parent.target_daemon_boot_id !== targetBootId
        || parent.attempt_no !== attemptNo || parent.reconciliation_pending !== 1) return false;
      const terminal = outcome !== "retry_wait";
      const changed = this.db.prepare(`
        UPDATE deliveries SET state=?,reconciliation_pending=0,manager_boot_id=?,
          target_daemon_boot_id=?,updated_at=?,finished_at=?,last_error=?,next_attempt_at=?
        WHERE delivery_id=? AND state='submission_started' AND reconciliation_pending=1
          AND target_daemon_boot_id=? AND attempt_no=?
      `).run(
        outcome,
        outcome === "retry_wait" ? null : parent.manager_boot_id,
        outcome === "retry_wait" ? null : targetBootId,
        now,
        terminal ? now : null,
        outcome === "delivered" ? null : evidence.slice(0, 300),
        outcome === "retry_wait" ? new Date(Date.now() + DURABLE_DELIVERY_ABORT_BACKOFF_MS).toISOString() : null,
        deliveryId, targetBootId, attemptNo,
      ).changes;
      if (changed !== 1) return false;
      const attemptState = outcome === "retry_wait" ? "aborted" : outcome;
      this.db.prepare(`
        UPDATE delivery_attempts SET state=?,abort_at=?,finished_at=?,evidence=?
        WHERE delivery_id=? AND target_daemon_boot_id=? AND attempt_no=? AND state='begun'
      `).run(attemptState, outcome === "retry_wait" ? now : null, terminal ? now : null,
        evidence.slice(0, 300), deliveryId, targetBootId, attemptNo);
      if (outcome === "uncertain") this.insertFailureNotice(parent, "uncertain", evidence, now);
      if (outcome === "delivered") this.openReplyObligation(parent, now);
      return true;
    });
    const changed = transaction();
    if (changed) this.emit("state", { deliveryId, state: outcome });
    return changed;
  }

  getUnansweredAccepted(sourceInstance: string, currentBootId: string): OutboxDelivery[] {
    const rows = this.db.prepare(`
      SELECT * FROM deliveries
      WHERE source_instance=? AND source_daemon_boot_id<>? AND response_delivered_at IS NULL
        -- Scheduler admission has no waiting source-agent tool response; its
        -- stable run key and durable row are the recovery/lookup contract.
        AND kind NOT IN ('raw_paste')
      ORDER BY created_seq
    `).all(sourceInstance, currentBootId) as OutboxRow[];
    return rows.map(mapRow);
  }

  close(): void {
    this.db.close();
  }

  /** Must be called inside the same SQLite transaction as the terminal transition. */
  private insertFailureNotice(parent: OutboxRow, outcome: "failed" | "uncertain", reason: string, now: string): void {
    if (parent.kind === "delivery_outcome_notice" || parent.kind === "post_restart_outcome_notice"
      || parent.kind === REPLY_OBLIGATION_NOTICE_KIND) return;
    const noticeId = randomUUID();
    const operationId = `notice:${parent.operation_id}:${parent.delivery_id}`;
    const payload = {
      type: "fleet_inbound",
      content: `[system:delivery-outcome] Cross-instance operation outcome: operation_id=${parent.operation_id}; delivery_id=${parent.delivery_id}; target=${parent.target_instance}; state=${outcome}; detail=${reason.slice(0, 200)}. ${outcome === "uncertain" ? "Do not resend until an operator reconciles this delivery." : "The delivery failed after bounded retries; report this outcome to the operator."}`,
      meta: {
        user: "AgEnD delivery outbox",
        user_id: "agend-system",
        message_id: `delivery-outcome-${parent.delivery_id}`,
        chat_id: "",
        thread_id: "",
        source: "delivery-outbox",
      },
    };
    const reserved = this.db.prepare(`
      INSERT OR IGNORE INTO failure_notices(parent_delivery_id,notice_delivery_id,created_at) VALUES (?,?,?)
    `).run(parent.delivery_id, noticeId, now);
    if (reserved.changes !== 1) return;
    this.db.prepare(`
      INSERT INTO deliveries (
        delivery_id,operation_id,source_key,source_instance,source_daemon_boot_id,
        target_instance,target_session,target_daemon_boot_id,kind,correlation_id,payload_json,state,
        attempt_no,created_seq,manager_boot_id,created_at,updated_at,accepted_at
      ) VALUES (?,?,?,?,?,?,NULL,NULL,'delivery_outcome_notice',?,?,'queued',0,
        (SELECT COALESCE(MAX(created_seq),0)+1 FROM deliveries),NULL,?,?,?)
    `).run(
      noticeId,
      operationId,
      `failure-notice:${parent.delivery_id}`,
      "agend-system",
      this.managerBootId,
      parent.source_instance,
      parent.correlation_id,
      JSON.stringify(payload),
      now,
      now,
      now,
    );
  }
}
