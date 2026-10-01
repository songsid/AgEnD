/**
 * Phase 2c (docs/design/phase2-submit-contract.md §1.1, §1.5, §4 2c): the
 * per-target owner of a durable delivery lane when `delivery_worker: on`.
 *
 * ENSURE_AWAKE belongs to the WakeCoordinator (2b); this worker only runs
 * once the target is awake: WAIT_ACCEPTING (the daemon's own verdict, via
 * the coordinator's blocksClaim — the worker never reads a pane) → CLAIM →
 * HANDOFF → AWAIT_RESULT, one row at a time, in created_seq order.
 *
 * Ownership is granted and released by the FleetManager, only while the lane
 * is empty (no row of the target in flight, neither the pump's nor this
 * worker's), inside the pump's synchronous section. The pump skips every
 * target a worker owns. With the outbox claim CAS, the attempt/generation
 * fence and "never replay an unknown submission", that keeps one claimer and
 * one pane writer per target at any time (§1.5).
 */
import type { ClaimedOutboxDelivery } from "./delivery-outbox.js";

export interface TargetQueueWorkerDeps {
  /** Whether this worker still owns its target's lane. */
  owns(): boolean;
  /**
   * Whether the target is still `delivery_worker: on`. Checked before every
   * claim: after a switch back, the worker finishes only the row it already
   * claimed and then stops, so the pump takes the lane over (synchronously,
   * in its next pass) instead of the worker draining the queue to the end.
   */
  wanted(): boolean;
  /** Whether the outbox can be queried (closed database / shutting down → false). */
  available(): boolean;
  /** Paused, being woken, restarting, or not accepting by the daemon's own account. */
  blocked(): boolean;
  /** The target daemon's current bootId (null when it has none). */
  daemonBootId(): string | null;
  /** Claim the head row of this target for `bootId` (synchronous CAS). */
  claim(bootId: string): ClaimedOutboxDelivery | undefined;
  /** Shared active-delivery budget with the pump. */
  tryAcquireBudget(): boolean;
  /**
   * Return the budget taken for one attempt, exactly once. It never kicks the
   * pump: with nothing claimable (e.g. a retry not yet due) a kick would turn
   * an unexpired retry_wait into a zero-delay claim loop; a not-yet-due retry
   * is woken by the pump's nextRetryAt timer. The kick after a *claimed* row
   * belongs to `dispatch` (it runs once the hand-off has settled).
   */
  releaseBudget(): void;
  /** HANDOFF + AWAIT_RESULT: resolves when the row has left delivering/submission_started. */
  dispatch(claimed: ClaimedOutboxDelivery): Promise<void>;
  /** Ask the wake coordinator to look at this target (it is paused/blocked). */
  kickCoordinator(): void;
  logger: { warn(obj: object, msg: string): void };
}

export class TargetQueueWorker {
  private running: Promise<void> | null = null;
  private again = false;
  /** A row of this target is claimed by this worker and not yet released. */
  inFlight = false;

  constructor(readonly target: string, private readonly deps: TargetQueueWorkerDeps) {}

  /** Whether a drain loop is running (the lane may become in-flight at any step). */
  get busy(): boolean {
    return this.running !== null;
  }

  /** Drain the lane until it is empty or blocked. Re-entrant calls join the running loop. */
  drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = this.loop().catch(err => {
      this.deps.logger.warn({ target: this.target, err: err instanceof Error ? err.message : String(err) }, "Queue worker drain failed; rows stay in the outbox");
    }).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      for (;;) {
        if (!this.deps.owns() || !this.deps.wanted() || !this.deps.available()) return;
        // WAIT_ACCEPTING and CLAIM in one synchronous step: the verdict, the
        // bootId and the claim are about the same daemon generation.
        if (this.deps.blocked()) { this.deps.kickCoordinator(); break; }
        const bootId = this.deps.daemonBootId();
        if (!bootId) { this.deps.kickCoordinator(); break; }
        if (!this.deps.tryAcquireBudget()) break;
        let claimed: ClaimedOutboxDelivery | undefined;
        try {
          claimed = this.deps.claim(bootId);
        } catch (err) {
          // e.g. SQLITE_BUSY: nothing was claimed, so the budget goes back now —
          // a leaked slot here would starve every lane once eight leaked.
          this.deps.releaseBudget();
          throw err;
        }
        if (!claimed) { this.deps.releaseBudget(); break; }
        this.inFlight = true;
        try {
          await this.deps.dispatch(claimed);
        } finally {
          this.inFlight = false;
          this.deps.releaseBudget();
        }
      }
    } while (this.again);
  }
}
