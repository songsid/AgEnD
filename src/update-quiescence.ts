/**
 * M-3770 slice 2.2 (S-244): the quiescence barrier.
 *
 * The product rules are design #4480 §3.3 step 2. Where this file meets the journal, the files and the replay rules
 * are #4494's §2.6 helpers (`writeInboxItem`, `writeDeferred`, `listHandback`, `handbackAction`, `markHandback`,
 * `handbackSourceKey`, `writeCancel`). The fleet does not write a stage. Source-cleared note #4493 is the behavior
 * this code follows where it supersedes the stage sentences in merged #4490. A Hub or room row is durable and
 * encrypted in the member journal: its producer leaves it queued, and this module never copies that text. A copy
 * is only adapter or web ingress that never became a durable row.
 *
 * Nothing in the live installer calls this. Wiring it into `launchInstalledUpdate` before slice 2.5 would hold
 * messages and then install with today's updater. The flag defaults down, so every hook is a no-op until a caller
 * binds an attempt and the second check holds.
 */
import { join } from "node:path";
import { DEFAULT_MAX_IDLE_WAIT_HOURS } from "./update-settings.js";
import {
  advance, attemptDir, defaultJournalIo, finish, handbackAction, handbackSourceKey, listHandback, markHandback,
  substep, writeCancel, writeDeferred, writeInboxItem,
  type AttemptRecord, type HandbackEntry, type InboxSource, type JournalIo, type JournalRead, type Stage,
} from "./update-journal.js";

export const DEFAULT_MAX_IDLE_WAIT_MS = DEFAULT_MAX_IDLE_WAIT_HOURS * 60 * 60 * 1000;

/** What the card offers again after a honoured cancel or an honoured idle timeout (§3.3 step 2.4). */
export const HONOURED_CANCEL_ACTIONS = ["Update now", "Keep waiting"] as const;
/** What the card says when a cancel is consumed after the snapshot (#4491 §2.6). */
export const TOO_LATE_CANCEL = "too late to cancel: the update is past the point of no return";

const AGENT_FENCE_SKIPS = new Set(["status", "cancel", "update", "card-cancel", "admin", "stop", "restart", "start", "service-install"]);
const SERVICE_LOCK = new Set(["stop", "restart", "start", "service-install"]);
const SLASH_CONTROL = /^\/(?:status|cancel|update|stop|restart)(?:@\S+)?(?:\s|$)/i;

/** Class Self, and both versions speak the transaction. Otherwise the caller stays on Phase 1. */
export function usesQuiescenceBarrier(tx: { txClass: string; from: number; to: number; vTx: number }): boolean {
  return tx.txClass === "Self" && tx.from >= tx.vTx && tx.to >= tx.vTx;
}

/** Control commands and admin edits are not agent turns. `/stop` and `/restart` are in this set too. */
export function skipsAgentFence(kind: string): boolean {
  return AGENT_FENCE_SKIPS.has(kind);
}

/**
 * The service lock (#4491 §3.4), as a reader of the journal. An open, unknown, or manual attempt refuses
 * `start` / `stop` / `restart` / `service install` (and chat `/stop` and `/restart`). `/status`, `/cancel`,
 * `/update`, the card's cancel, and an admin edit do not take that lock. A closing attempt has already released it.
 */
export function serviceCommandRefusal(read: JournalRead, kind: string): { refused: true; id: string; stage: string } | { refused: false } {
  if (!SERVICE_LOCK.has(kind)) return { refused: false };
  if (read.state === "open" || read.state === "manual") return { refused: true, id: read.attempt.id, stage: read.attempt.stage };
  if (read.state === "unknown") return { refused: true, id: "", stage: "unknown" };
  return { refused: false };
}

/**
 * What a state-writing command does after it takes the state lease and reads `current` (#4491 §4.2).
 * Refused while `current` names an open, unknown, or manual attempt. Admitted once `current` is gone.
 */
export function stateWriteRefused(read: JournalRead): boolean {
  return read.state === "open" || read.state === "unknown" || read.state === "manual";
}

export function cardAfterHonouredCancel(): { status: "waiting"; actions: readonly ["Update now", "Keep waiting"] } {
  return { status: "waiting", actions: HONOURED_CANCEL_ACTIONS };
}

/** The card is cancellable while the attempt is still `opened` (the wait, once published) or `barrier`. */
export function cancelAllowed(stage: Stage): boolean {
  return stage === "opened" || stage === "barrier";
}

export interface BarrierAgent {
  process: string;
  /** The daemon's own process status, for the paused-and-stopped skip `hubUpdateIdle` already uses. */
  daemonProcess?: string;
  execution: string;
  phase?: string;
  workerBusy?: boolean;
  workerInFlight?: boolean;
  restartInFlight?: boolean;
  stopInFlight?: boolean;
  handOffInFlight?: boolean;
  ipcConnectInFlight?: boolean;
  pendingIdleGated?: boolean;
  webEchoTail?: boolean;
  workLease?: boolean;
}

/**
 * One synchronous look at the fleet. `pending` is every outbox row `claimNext` could claim (queued or retry_wait,
 * not in flight), in any order. `scheduleInRun` is true when a schedule is already inside `runWithLock`: that is
 * not busy, and the check does not stop it.
 */
export interface BarrierSnapshot {
  pin: boolean;
  inPause: boolean;
  startupComplete: boolean;
  shuttingDown: boolean;
  reconcileInFlight: boolean;
  anotherClaim: boolean;
  scheduleInRun: boolean;
  outboxInFlight: boolean;
  agents: BarrierAgent[];
  pending: Array<{ deliveryId: string; createdSeq: number }>;
}

export type BarrierRefusal = "pin" | "pause" | "shutdown" | "reconcile" | "claim" | "starting";

/** Pin, pause, shutdown, a reconcile, another claim, and a fleet still starting refuse the attempt. They are not "busy". */
export function barrierRefusal(snap: BarrierSnapshot): BarrierRefusal | null {
  if (snap.pin) return "pin";
  if (snap.inPause) return "pause";
  if (snap.shuttingDown) return "shutdown";
  if (snap.reconcileInFlight) return "reconcile";
  if (snap.anotherClaim) return "claim";
  if (!snap.startupComplete) return "starting";
  return null;
}

/**
 * Sibling of `hubUpdateIdle`. The same agent loop, except `phase === "waiting"` counts as idle. A schedule already
 * inside `runWithLock` is not consulted: `scheduleInRun` does not fail this check.
 */
export function barrierIdle(snap: BarrierSnapshot): boolean {
  if (barrierRefusal(snap)) return false;
  if (snap.outboxInFlight) return false;
  for (const agent of snap.agents) {
    if (agent.process === "stopped" || agent.process === "crashed") continue;
    if (agent.process === "paused" && (agent.daemonProcess === "stopped" || agent.daemonProcess === "crashed")) continue;
    if (agent.workerBusy || agent.workerInFlight) return false;
    if (agent.restartInFlight || agent.stopInFlight || agent.handOffInFlight || agent.ipcConnectInFlight) return false;
    if (agent.pendingIdleGated || agent.webEchoTail) return false;
    if (agent.workLease) return false;
    if (agent.process !== "running") return false;
    if (agent.phase === "waiting") continue;
    if (agent.execution !== "idle") return false;
  }
  return true;
}

/** A pane payload that would start or continue an agent turn. Schedule triggers and control commands are not. */
export function isAgentTurn(payload: Record<string, unknown>): boolean {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "fleet_schedule_trigger" || type.endsWith("_response")) return false;
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (SLASH_CONTROL.test(content)) return false;
  return type === "fleet_inbound" || type === "raw_paste" || type === "steer" || type === "user_message";
}

export function turnSource(payload: Record<string, unknown>): InboxSource {
  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta as Record<string, unknown> : {};
  if (meta.from_display === "Hub" || meta.source === "hub") return "hub";
  if (meta.source === "web") return "web";
  return "adapter";
}

/**
 * The four commit points call this. Unarmed, every method allows the write. Armed, a claim or a turn is journaled
 * and not committed; a task claim is refused and is not a file.
 */
export interface QuiescenceGate {
  armed(): boolean;
  /** True: do not claim. A delivery id already in the sequence is not written again. */
  holdOutboxClaim(deliveryId: string, createdSeq: number): boolean;
  /** True: the occurrence is deferred. Do not call `onTrigger`, `markHandled`, or delete the row. */
  holdSchedule(scheduleId: string, runId: string): boolean;
  /** True: do not write the claim. Nothing is journaled. */
  holdTaskClaim(): boolean;
  /** After `admitDurableDelivery` inserts a row. The row stays; this writes a reference. */
  noteAdmission(deliveryId: string, createdSeq: number): void;
  /**
   * True: an adapter or web turn was journaled as a copy and must not be sent.
   * A Hub or room payload is not a copy. The producer leaves that row queued, and the caller must not send it.
   */
  commitTurn(payload: Record<string, unknown>): boolean;
}

export interface HandbackPorts {
  log(fields: { deliveryId: string; seq: number }, message: string): void;
  lookup(deliveryId: string): { state: string; target: string } | null;
  /** Claim this delivery id only. `ineligible` holds later entries for that same target. */
  claim(deliveryId: string): "claimed" | "ineligible" | "settled" | "missing";
  /** One insert under `sourceKey`. A replay returns the row the first insert created. */
  admitCopy(sourceKey: string, body: unknown): { deliveryId: string };
  runDeferred(job: { scheduleId: string; runId: string }): void;
  recordInterrupted(job: { scheduleId: string; runId: string }): void;
}

export type WaitResult = "ready" | "timeout" | "not-idle";

export interface WaitOpts {
  maxMs: number;
  pollMs: number;
  idle: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  /** `agend update --now` and the card's Update now: one look, no sleep. */
  once?: boolean;
}

/**
 * The updater's close when the second check is busy or refused (#4493). The fleet was not stopped, so `restart-old`
 * finds it running, hand-back has no files, and `finish` clears `current`. The fleet does not call this; the updater
 * does, and only after the flag is already down.
 */
export function closeUnusedAttempt(home: string, attempt: AttemptRecord, io: JournalIo = defaultJournalIo): AttemptRecord {
  if (attempt.stage !== "opened" && attempt.stage !== "barrier" && attempt.stage !== "abandoning") {
    throw new Error(`attempt ${attempt.id} is ${attempt.stage}; a busy check closes opened or barrier`);
  }
  let next = attempt.stage === "abandoning" ? attempt : advance(home, attempt, "abandoning", { note: "fleet was not idle" }, io);
  next = substep(home, next, "restart-old", io);
  next = substep(home, next, "hand-back", io);
  return finish(home, next, { kind: "abandoned", reason: "fleet was not idle" }, io);
}

export class QuiescenceBarrier implements QuiescenceGate {
  private flag = false;
  private seq = 0;
  private seen = new Set<string>();
  /** Deferred occurrences already on this attempt, so a re-offered run is not written twice. */
  private deferred = new Set<string>();
  private attempt: AttemptRecord | null = null;

  constructor(private readonly home: string, private readonly io: JournalIo = defaultJournalIo) {}

  armed(): boolean { return this.flag; }
  attemptId(): string | null { return this.attempt?.id ?? null; }

  /** The updater has published `opened`. Reloads the sequence already on disk so a retry does not renumber it. */
  bind(attempt: AttemptRecord): void {
    this.attempt = attempt;
    const entries = listHandback(this.home, attempt.id, this.io);
    this.seq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    this.seen.clear();
    this.deferred.clear();
    for (const entry of entries) {
      if (entry.kind === "inbox" && entry.item.kind === "reference") this.seen.add(entry.item.deliveryId);
      if (entry.kind === "deferred") this.deferred.add(`${entry.job.scheduleId}\0${entry.job.runId}`);
    }
  }

  /**
   * Fence and check again, with no await. The flag is set, the predicate runs, and only then does this return.
   * Busy or refused: the flag is cleared before any file is written. Idle: the outbox prefix is written while the
   * attempt is still `opened`, and the flag stays up. This does not advance the stage.
   */
  secondCheck(snap: BarrierSnapshot): "held" | "busy" | "refused" {
    if (!this.attempt) throw new Error("no attempt is bound");
    if (this.attempt.stage !== "opened") throw new Error(`the prefix is written at opened, not ${this.attempt.stage}`);
    if (this.flag) throw new Error("the fence is already up");
    this.flag = true;
    const refusal = barrierRefusal(snap);
    if (refusal || !barrierIdle(snap)) {
      this.flag = false;
      return refusal ? "refused" : "busy";
    }
    const rows = [...snap.pending].sort((a, b) => a.createdSeq - b.createdSeq || (a.deliveryId < b.deliveryId ? -1 : a.deliveryId > b.deliveryId ? 1 : 0));
    for (const row of rows) this.rememberReference(row.deliveryId, row.createdSeq);
    return "held";
  }

  /** The unfenced wait. The flag stays down, so a message that arrives here is delivered. */
  async waitForCandidate(opts: WaitOpts): Promise<WaitResult> {
    if (this.flag) throw new Error("the fence is already up");
    if (opts.once) return opts.idle() ? "ready" : "not-idle";
    const clock = opts.now ?? Date.now;
    const start = clock();
    for (;;) {
      if (opts.idle()) return "ready";
      const left = opts.maxMs - (clock() - start);
      if (left <= 0) return "timeout";
      await opts.sleep(Math.min(opts.pollMs, left));
    }
  }

  holdOutboxClaim(deliveryId: string, createdSeq: number): boolean {
    if (!this.flag) return false;
    this.rememberReference(deliveryId, createdSeq);
    return true;
  }

  holdSchedule(scheduleId: string, runId: string): boolean {
    if (!this.flag) return false;
    if (!this.attempt) throw new Error("no attempt is bound");
    const key = `${scheduleId}\0${runId}`;
    if (this.deferred.has(key)) return true;
    const seq = this.seq + 1;
    writeDeferred(this.home, this.attempt.id, seq, { scheduleId, runId }, this.io);
    this.seq = seq;
    this.deferred.add(key);
    return true;
  }

  holdTaskClaim(): boolean { return this.flag; }

  noteAdmission(deliveryId: string, createdSeq: number): void {
    if (!this.flag) return;
    this.rememberReference(deliveryId, createdSeq);
  }

  commitTurn(payload: Record<string, unknown>): boolean {
    if (!this.flag || !isAgentTurn(payload)) return false;
    // Hub and room text stays in the member journal, encrypted, and only while that row is queued.
    if (turnSource(payload) === "hub") return false;
    if (!this.attempt) throw new Error("no attempt is bound");
    const seq = this.seq + 1;
    writeInboxItem(this.home, this.attempt.id, seq, turnSource(payload), { kind: "copy", body: payload }, this.io);
    this.seq = seq;
    return true;
  }

  /**
   * The card action `cancel`, only while the attempt is cancellable. Writing the marker does not abandon.
   * `by` is the card's display label, the same kind Phase 1 stores on `lastAnswer.by`.
   */
  requestCancel(attempt: AttemptRecord, cancel: { reason: string; by: string }): boolean {
    if (!cancelAllowed(attempt.stage)) return false;
    const path = join(attemptDir(this.home, attempt.id), "cancel");
    if (this.io.read(path) !== null) return false;
    writeCancel(this.home, attempt.id, cancel, this.io);
    return true;
  }

  /**
   * Hand-back, only at substep `hand-back`. Reconciles each entry with durable state before doing it again, and
   * writes `.acked` only after that effect. A missing reference is logged, acknowledged, and the walk continues.
   * An ineligible row holds later entries for the same target only.
   */
  runHandback(attempt: AttemptRecord, ports: HandbackPorts): { walked: boolean; acked: number } {
    if (attempt.substep !== "hand-back") return { walked: false, acked: 0 };
    const entries = listHandback(this.home, attempt.id, this.io);
    const held = new Set<string>();
    let acked = 0;
    const acknowledge = (entry: HandbackEntry) => { markHandback(entry, "acked", this.io); acked += 1; };
    for (const entry of entries) {
      const action = handbackAction(entry);
      if (action === "skip") continue;
      if (entry.kind === "deferred") {
        if (action === "record-interrupted") { ports.recordInterrupted(entry.job); acknowledge(entry); continue; }
        markHandback(entry, "started", this.io);
        ports.runDeferred(entry.job);
        acknowledge(entry);
        continue;
      }
      const deliveryId = action === "admit-then-claim"
        ? ports.admitCopy(handbackSourceKey(attempt.id, entry.seq), entry.item.kind === "copy" ? entry.item.body : null).deliveryId
        : entry.item.kind === "reference" ? entry.item.deliveryId : "";
      if (!deliveryId) throw new Error(`hand-back entry ${entry.seq} has no delivery`);
      const row = ports.lookup(deliveryId);
      if (!row) {
        ports.log({ deliveryId, seq: entry.seq }, "hand-back reference has no outbox row; acknowledging and continuing");
        acknowledge(entry);
        continue;
      }
      if (held.has(row.target)) continue;
      if (row.state === "queued" || row.state === "retry_wait") {
        const result = ports.claim(deliveryId);
        if (result === "ineligible") { held.add(row.target); continue; }
        if (result === "missing") {
          ports.log({ deliveryId, seq: entry.seq }, "hand-back reference has no outbox row; acknowledging and continuing");
          acknowledge(entry);
          continue;
        }
      }
      acknowledge(entry);
    }
    return { walked: true, acked };
  }

  /** A reference, once. The journal sequence is the barrier's own counter; `createdSeq` stays the outbox's. */
  private rememberReference(deliveryId: string, createdSeq: number): void {
    if (!this.attempt) throw new Error("no attempt is bound");
    if (this.seen.has(deliveryId)) return;
    const seq = this.seq + 1;
    writeInboxItem(this.home, this.attempt.id, seq, "outbox", { kind: "reference", deliveryId, createdSeq }, this.io);
    this.seq = seq;
    this.seen.add(deliveryId);
  }
}
