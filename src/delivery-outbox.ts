import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DURABLE_DELIVERY_MAX_ATTEMPTS = 8;
export const DURABLE_DELIVERY_MAX_AGE_MS = 24 * 60 * 60_000;
export const DURABLE_DELIVERY_ABORT_BACKOFF_MS = 5_000;

export interface DaemonDeliveryPort {
  begin(deliveryId: string, targetBootId: string, attemptNo: number): "begun" | "duplicate" | "stale";
  abort(deliveryId: string, targetBootId: string, attemptNo: number, reason: string): boolean;
  complete(deliveryId: string, targetBootId: string, attemptNo: number, outcome: "delivered" | "failed" | "uncertain", evidence?: string): boolean;
  retryBeforeBegin(deliveryId: string, targetBootId: string, attemptNo: number, reason: string, delayMs?: number): boolean;
}

export type OutboxState =
  | "queued"
  | "delivering"
  | "submission_started"
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
  state: OutboxState;
  attempt_no: number;
  created_seq: number;
  manager_boot_id: string | null;
  response_delivered_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
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
    state: row.state,
    attemptNo: row.attempt_no,
    createdSeq: row.created_seq,
    managerBootId: row.manager_boot_id,
    responseDeliveredAt: row.response_delivered_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
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

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
        target_daemon_boot_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('begun','aborted','delivered','failed','uncertain')),
        begin_ack_at TEXT,
        abort_at TEXT,
        finished_at TEXT,
        evidence TEXT,
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
      CREATE TABLE IF NOT EXISTS failure_notices (
        parent_delivery_id TEXT PRIMARY KEY,
        notice_delivery_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }

  /** Commit admission before returning success. Duplicate source keys return their original row. */
  admit(input: NewOutboxDelivery): { delivery: OutboxDelivery; inserted: boolean } {
    const now = new Date().toISOString();
    const deliveryId = randomUUID();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO deliveries (
        delivery_id, operation_id, source_key, source_instance, source_daemon_boot_id,
        target_instance, target_session, kind, correlation_id, payload_json, state,
        attempt_no, created_seq, manager_boot_id, created_at, updated_at, accepted_at
      ) VALUES (
        @delivery_id, @operation_id, @source_key, @source_instance, @source_daemon_boot_id,
        @target_instance, @target_session, @kind, @correlation_id, @payload_json, 'queued',
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
        created_at: now,
        updated_at: now,
        accepted_at: now,
      });
      const row = select.get(input.sourceKey) as OutboxRow | undefined;
      if (!row) throw new Error("outbox admission committed without a readable row");
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

  listPending(): OutboxDelivery[] {
    const rows = this.db.prepare(`
      SELECT * FROM deliveries
      WHERE state IN ('queued','delivering','submission_started','retry_wait')
      ORDER BY created_seq
    `).all() as OutboxRow[];
    return rows.map(mapRow);
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
    const visitedTargets = new Set<string>();
    for (const row of rows) {
      if (visitedTargets.has(row.target_instance)) continue;
      visitedTargets.add(row.target_instance);
      if (blockedTargets.has(row.target_instance)) continue;
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
  begin(deliveryId: string, targetBootId: string, attemptNo: number): "begun" | "duplicate" | "stale" {
    const now = new Date().toISOString();
    const transaction = this.db.transaction((): { outcome: "begun" | "duplicate" | "stale"; failed: boolean } => {
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
        INSERT INTO delivery_attempts(delivery_id,target_daemon_boot_id,attempt_no,state,begin_ack_at)
        VALUES (?,?,?,'begun',?)
      `).run(deliveryId, targetBootId, attemptNo, now);
      this.db.prepare(`
        UPDATE deliveries SET state='submission_started', submitted_at=?, updated_at=?
        WHERE delivery_id=? AND state='delivering'
      `).run(now, now, deliveryId);
      return { outcome: "begun", failed: false };
    });
    const result = transaction();
    if (result.outcome === "begun") this.emit("state", { deliveryId, state: "submission_started" });
    else if (result.failed) this.emit("state", { deliveryId, state: "failed" });
    return result.outcome;
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
        UPDATE deliveries SET state='retry_wait',updated_at=?,last_error=?,next_attempt_at=?
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
        UPDATE deliveries SET state=?,updated_at=?,finished_at=?,last_error=?
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

  /** Expire unavailable/pre-submit rows instead of leaving them queued forever. */
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
      for (const row of stale) {
        if (update.run(now, now, row.delivery_id).changes !== 1) continue;
        this.insertFailureNotice(row, "failed", "delivery TTL expired before target became available", now);
        changed++;
      }
      return changed;
    });
    const changed = transaction();
    if (changed) this.emit("expired", { count: changed });
    return changed;
  }

  /** Next queued/retry expiry for bounded maintenance scheduling. */
  nextExpiryAt(): string | null {
    const row = this.db.prepare(`
      SELECT MIN(created_at) AS created_at FROM deliveries WHERE state IN ('queued','retry_wait')
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
  recoverForBoot(managerBootId: string): { queued: number; uncertain: number } {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const uncertainRows = this.db.prepare(`
        SELECT * FROM deliveries WHERE manager_boot_id IS NOT NULL AND manager_boot_id<>? AND state='submission_started'
      `).all(managerBootId) as OutboxRow[];
      const queued = this.db.prepare(`
        UPDATE deliveries SET state='queued',manager_boot_id=NULL,target_daemon_boot_id=NULL,next_attempt_at=NULL,updated_at=?
        WHERE manager_boot_id IS NOT NULL AND manager_boot_id<>? AND state IN ('delivering','retry_wait')
      `).run(now, managerBootId).changes;
      // Until transcript reconciliation is enabled, never blindly replay a row
      // whose pane side effect may already have happened.
      const uncertain = this.db.prepare(`
        UPDATE deliveries SET state='uncertain',updated_at=?,finished_at=?,last_error='process restarted during submission; reconciliation required'
        WHERE manager_boot_id IS NOT NULL AND manager_boot_id<>? AND state='submission_started'
      `).run(now, now, managerBootId).changes;
      for (const row of uncertainRows) {
        this.insertFailureNotice(row, "uncertain", "process restarted during submission; reconciliation required", now);
      }
      return { queued, uncertain };
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

  recoverTargetGeneration(targetInstance: string, currentTargetBootId: string): { queued: number; uncertain: number } {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const uncertainRows = this.db.prepare(`
        SELECT * FROM deliveries WHERE target_instance=? AND target_daemon_boot_id IS NOT NULL
          AND target_daemon_boot_id<>? AND state='submission_started'
      `).all(targetInstance, currentTargetBootId) as OutboxRow[];
      const queued = this.db.prepare(`
        UPDATE deliveries SET state='queued',manager_boot_id=NULL,target_daemon_boot_id=NULL,next_attempt_at=NULL,updated_at=?
        WHERE target_instance=? AND target_daemon_boot_id IS NOT NULL AND target_daemon_boot_id<>?
          AND state IN ('delivering','retry_wait')
      `).run(now, targetInstance, currentTargetBootId).changes;
      const uncertain = this.db.prepare(`
        UPDATE deliveries SET state='uncertain',updated_at=?,finished_at=?,last_error='target daemon generation changed during submission; reconciliation required'
        WHERE target_instance=? AND target_daemon_boot_id IS NOT NULL AND target_daemon_boot_id<>?
          AND state='submission_started'
      `).run(now, now, targetInstance, currentTargetBootId).changes;
      for (const row of uncertainRows) {
        this.insertFailureNotice(row, "uncertain", "target daemon generation changed during submission; reconciliation required", now);
      }
      return { queued, uncertain };
    });
    const result = transaction();
    if (result.queued + result.uncertain > 0) this.emit("generation_recovered", { targetInstance, ...result });
    return result;
  }

  getUnansweredAccepted(sourceInstance: string, currentBootId: string): OutboxDelivery[] {
    const rows = this.db.prepare(`
      SELECT * FROM deliveries
      WHERE source_instance=? AND source_daemon_boot_id<>? AND response_delivered_at IS NULL
      ORDER BY created_seq
    `).all(sourceInstance, currentBootId) as OutboxRow[];
    return rows.map(mapRow);
  }

  close(): void {
    this.db.close();
  }

  /** Must be called inside the same SQLite transaction as the terminal transition. */
  private insertFailureNotice(parent: OutboxRow, outcome: "failed" | "uncertain", reason: string, now: string): void {
    if (parent.kind === "delivery_outcome_notice" || parent.kind === "post_restart_outcome_notice") return;
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
