/**
 * Phase 2b (docs/design/phase2-submit-contract.md §1.2–§1.6, §3.1): the one
 * owner that wakes a paused target because durable work is waiting for it.
 *
 * Before this, the only code that woke a target for a queued cross-instance
 * message ran *after* the outbox pump had claimed the row, and the pump never
 * claims a target without a live daemon — so a marker-only paused instance
 * (paused across a fleet restart) was never woken: Bug1, the attempt_0
 * deadlock. The coordinator wakes first; the pump stays the only claimer and
 * only claims targets that are awake. Nothing here writes a pane or claims a
 * row.
 *
 * Active only for targets whose `delivery_worker` is `wake_only` or `on`;
 * `off` (the default) leaves every path as it was.
 */
import type { DeliveryWorkerMode } from "./types.js";
import type { OutboxDelivery } from "./delivery-outbox.js";
import type { PauseReason } from "./pause-marker.js";

/** Row kinds that never warrant waking a target. Empty: every current kind asks for action (§1.2). */
export const PASSIVE_KINDS: ReadonlySet<string> = new Set<string>();
export const isWakeEligibleKind = (kind: string): boolean => !PASSIVE_KINDS.has(kind);

export const WAKE_BACKOFF_BASE_MS = 1_000;
export const WAKE_BACKOFF_MAX_MS = 60_000;
/** Consecutive wake failures before both topics are told, once per failure episode. */
export const WAKE_FAILURE_NOTICE_AFTER = 3;
/** Pre-claim lease length (mirrors instance-lifecycle PRECLAIM_LEASE_MS). */
export const PRECLAIM_WINDOW_MS = 120_000;
export const PARK_BASE_MS = 60_000;
export const PARK_MAX_MS = 30 * 60_000;
/** Queued work on an awake target that has not been claimed for this long is reported once (§1.4). */
export const CLAIM_BLOCK_NOTICE_MS = 5 * 60_000;
/** How far `warm_cap` may be exceeded for leased work (§1.6). */
export const DEFAULT_WARM_OVERFLOW = 2;
export const WATCHDOG_INTERVAL_MS = 30_000;

export interface WakeCoordinatorDeps {
  mode(target: string): DeliveryWorkerMode;
  /** Rows still to deliver: queued, retry_wait, delivering, submission_started (created_seq order). */
  listPending(): OutboxDelivery[];
  isPaused(target: string): boolean;
  pauseReason(target: string): PauseReason | null;
  isRestarting(target: string): boolean;
  /** The single-flight lifecycle wake, marked as the coordinator's own. */
  wake(target: string): Promise<void>;
  /** Instances counted against warm_cap right now (running, not paused, not general). */
  residentNames(): string[];
  /** warm_cap; 0 or less means unlimited. */
  warmCap(): number;
  warmOverflow(): number;
  /** When the target was last woken or started for work (the pre-claim clock). */
  wokeAt(target: string): number | undefined;
  /** Why an awake target is not accepting input (dialog, auth hold…), or null. */
  notAcceptingReason(target: string): string | null;
  notifyTarget(target: string, text: string): void;
  /**
   * Run the outbox pump. A wake changes no outbox row, so nothing else would
   * tell the pump that the target it skipped while paused can be claimed now.
   */
  kickPump(): void;
  notifySender(source: string, text: string): void;
  now(): number;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; debug?(obj: object, msg: string): void };
}

interface TargetState {
  failures: number;
  backoffUntil: number;
  lastError: string | null;
  failureNoticeSent: boolean;
  parkedUntil: number;
  parkLevel: number;
  parkReason: string | null;
  authNoticeSent: boolean;
  claimBlockNoticeSent: boolean;
}

export class WakeCoordinator {
  private readonly states = new Map<string, TargetState>();
  /** Targets whose wake is in flight (a reservation each, counted against the hard cap). */
  private readonly reserved = new Map<string, symbol>();
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: WakeCoordinatorDeps) {}

  start(): void {
    if (this.watchdog || this.stopped) return;
    this.watchdog = setInterval(() => this.scan(), WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.watchdog = null;
    this.scanTimer = null;
  }

  /** Schedule a scan soon (coalesced). Safe to call from any event. */
  kick(delayMs = 0): void {
    if (this.stopped) return;
    if (this.scanTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.scanTimer);
    }
    this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scan(); }, Math.max(0, delayMs));
    this.scanTimer.unref?.();
  }

  private state(target: string): TargetState {
    let s = this.states.get(target);
    if (!s) {
      s = {
        failures: 0, backoffUntil: 0, lastError: null, failureNoticeSent: false,
        parkedUntil: 0, parkLevel: 0, parkReason: null, authNoticeSent: false, claimBlockNoticeSent: false,
      };
      this.states.set(target, s);
    }
    return s;
  }

  private active(target: string): boolean {
    return this.deps.mode(target) !== "off";
  }

  /** The pump must not claim this target: it is paused, being woken, or in wake backoff (§3.1). */
  blocksClaim(target: string): boolean {
    if (!this.active(target)) return false;
    return this.reserved.has(target) || this.deps.isPaused(target);
  }

  isWaking(target: string): boolean {
    return this.reserved.has(target);
  }

  /** The last wake error, while the target is failing to wake (for the expiry reason). */
  wakeFailure(target: string): string | null {
    const s = this.states.get(target);
    return s && s.failures > 0 ? s.lastError : null;
  }

  isParked(target: string): boolean {
    return (this.states.get(target)?.parkedUntil ?? 0) > this.deps.now();
  }

  /**
   * A wake that did not come from here (an operator's /wake or wake_instance,
   * a user's channel message): park and backoff block only *automatic* wakes,
   * so an explicit one clears them and gets its one controlled attempt (§1.6).
   * A failure afterwards re-parks without resetting the backoff.
   */
  noteExternalWake(target: string): void {
    const s = this.states.get(target);
    if (!s) return;
    s.parkedUntil = 0;
    s.backoffUntil = 0;
    s.authNoticeSent = false;
  }

  /** A row for `target` was delivered: the hold is over, and so are the backoffs. */
  noteDelivered(target: string): void {
    const s = this.states.get(target);
    if (!s) return;
    s.failures = 0;
    s.lastError = null;
    s.failureNoticeSent = false;
    s.parkLevel = 0;
    s.parkedUntil = 0;
    s.parkReason = null;
    s.claimBlockNoticeSent = false;
  }

  /** Free warm slots under the hard cap, counting every target exactly once. */
  private freeSlots(): number {
    const cap = this.deps.warmCap();
    if (!Number.isInteger(cap) || cap <= 0) return Number.POSITIVE_INFINITY;
    const hard = cap + Math.max(0, this.deps.warmOverflow());
    // A reserved target is counted as reserved, never also as resident: its
    // promotion (reservation released once it is running) cannot double-count.
    const resident = this.deps.residentNames().filter(name => !this.reserved.has(name)).length;
    return hard - resident - this.reserved.size;
  }

  /** Synchronously take a slot for `target` (before any await). */
  tryReserve(target: string): symbol | null {
    if (this.reserved.has(target)) return null;
    if (this.freeSlots() <= 0) return null;
    const token = Symbol(target);
    this.reserved.set(target, token);
    return token;
  }

  /** Return exactly the slot `token` holds (idempotent). */
  release(target: string, token: symbol): void {
    if (this.reserved.get(target) === token) this.reserved.delete(target);
  }

  get reservedCount(): number {
    return this.reserved.size;
  }

  /** One pass over the pending queue: wake what needs waking, park what will not take work. */
  scan(): void {
    if (this.stopped) return;
    const now = this.deps.now();
    const byTarget = new Map<string, OutboxDelivery[]>();
    for (const row of this.deps.listPending()) {
      if (!this.active(row.targetInstance)) continue;
      const list = byTarget.get(row.targetInstance) ?? [];
      list.push(row);
      byTarget.set(row.targetInstance, list);
    }
    // Capacity is handed out oldest-work-first.
    const ordered = [...byTarget.entries()].sort((a, b) => a[1][0]!.createdSeq - b[1][0]!.createdSeq);
    let nextDue = Number.POSITIVE_INFINITY;
    let wakeableAwake = false;
    for (const [target, rows] of ordered) {
      const waiting = rows.filter(r => r.state === "queued" || r.state === "retry_wait");
      // §1.2: the whole queue decides, not only its head.
      if (!waiting.some(r => isWakeEligibleKind(r.kind))) continue;
      const s = this.state(target);
      if (this.deps.isPaused(target)) {
        s.claimBlockNoticeSent = false;
        if (this.reserved.has(target) || this.deps.isRestarting(target)) continue;
        if (this.deps.pauseReason(target) === "auth") {
          if (!s.authNoticeSent) {
            s.authNoticeSent = true;
            this.deps.notifyTarget(target, `⏸️ ${target} is paused because its login failed; ${waiting.length} queued message(s) are waiting. Fix the login and /wake it.`);
          }
          continue;
        }
        if (s.parkedUntil > now) { nextDue = Math.min(nextDue, s.parkedUntil); continue; }
        if (s.backoffUntil > now) { nextDue = Math.min(nextDue, s.backoffUntil); continue; }
        this.startWake(target, waiting);
        continue;
      }
      s.authNoticeSent = false;
      wakeableAwake = true;
      this.checkAwakeTarget(target, s, rows, waiting, now);
    }
    if (Number.isFinite(nextDue)) this.kick(Math.max(1, nextDue - now));
    // Awake targets with work still waiting: make sure the pump looks again.
    if (wakeableAwake) this.deps.kickPump();
  }

  /**
   * An awake target with queued work: past its pre-claim window without the
   * work moving, it is parked (no automatic re-wake until the hold clears or
   * the park expires), and a long pre-claim block is reported once.
   */
  private checkAwakeTarget(target: string, s: TargetState, rows: OutboxDelivery[], waiting: OutboxDelivery[], now: number): void {
    const inFlight = rows.some(r => r.state === "delivering" || r.state === "submission_started" || r.state === "reconciliation_pending");
    if (inFlight) return;
    const head = waiting[0];
    const headCreated = head?.createdAt ? Date.parse(head.createdAt) : now;
    // Measured from whichever is later — the wake or the head row's admission —
    // so fresh work for a long-awake instance is not mistaken for a hold.
    const woke = this.deps.wokeAt(target);
    if (woke !== undefined && now - Math.max(woke, headCreated) >= PRECLAIM_WINDOW_MS && s.parkedUntil <= now) {
      const reason = this.deps.notAcceptingReason(target) ?? "queued work was not claimed within the pre-claim window";
      const span = Math.min(PARK_MAX_MS, PARK_BASE_MS * 2 ** s.parkLevel);
      s.parkLevel += 1;
      s.parkedUntil = now + span;
      s.parkReason = reason;
      this.deps.logger.warn({ target, reason, parkMs: span }, "Wake coordinator parked a target that is not taking its queued work");
    }
    const headAge = now - headCreated;
    if (!s.claimBlockNoticeSent && headAge >= CLAIM_BLOCK_NOTICE_MS) {
      const reason = this.deps.notAcceptingReason(target);
      if (reason) {
        s.claimBlockNoticeSent = true;
        this.deps.notifyTarget(target, `⚠️ ${target} has ${waiting.length} queued message(s) waiting ${Math.round(headAge / 60_000)} min: ${reason}.`);
      }
    }
  }

  private startWake(target: string, waiting: OutboxDelivery[]): void {
    const token = this.tryReserve(target);
    if (!token) {
      this.deps.logger.debug?.({ target, reserved: this.reserved.size }, "Wake deferred: no warm slot under the hard cap");
      return;
    }
    const s = this.state(target);
    this.deps.logger.info({ target, queued: waiting.length }, "Waking a paused target for queued durable work");
    this.deps.wake(target).then(() => {
      this.deps.kickPump();
      s.failures = 0;
      s.backoffUntil = 0;
      s.lastError = null;
      s.failureNoticeSent = false;
    }, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      s.failures += 1;
      s.lastError = message;
      const delay = Math.min(WAKE_BACKOFF_MAX_MS, WAKE_BACKOFF_BASE_MS * 2 ** (s.failures - 1));
      s.backoffUntil = this.deps.now() + delay;
      this.deps.logger.warn({ target, failures: s.failures, retryInMs: delay, err: message }, "Wake for queued durable work failed; rows stay queued");
      if (s.failures >= WAKE_FAILURE_NOTICE_AFTER && !s.failureNoticeSent) {
        s.failureNoticeSent = true;
        const text = `⚠️ ${target} could not be woken (${s.failures} attempts): ${message}. ${waiting.length} message(s) are still queued and will be retried.`;
        this.deps.notifyTarget(target, text);
        for (const source of new Set(waiting.map(r => r.sourceInstance))) {
          if (source && source !== target && source !== "agend-system") this.deps.notifySender(source, text);
        }
      }
    }).finally(() => {
      this.release(target, token);
      this.kick();
    });
  }
}
