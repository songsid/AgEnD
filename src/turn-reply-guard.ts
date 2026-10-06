/** Exact channel destination captured when a human-facing turn is delivered. */
export interface TurnReplyTarget {
  adapterId?: string;
  chatId: string;
  threadId?: string;
  messageId?: string;
  correlationId?: string;
  inboundMarker?: string;
}

export type TurnReplyPhase = "awaiting" | "recovering";

export interface ReplyAttemptToken {
  generation: number;
  obligation: number;
  /** A literal reply call, used to avoid duplicating an uncertain delivery. */
  reply: boolean;
  /** A user-facing channel action that satisfies the completion obligation. */
  completionAction: boolean;
}

export interface TurnReplySnapshot {
  generation: number;
  phase: TurnReplyPhase;
  cancelledByUser: boolean;
  target: TurnReplyTarget;
  replyAttempted: boolean;
  replyDelivered: boolean;
  completionDelivered: boolean;
  outboundDelivered: boolean;
  /**
   * #1241: whether a non-idle execution snapshot was observed after this
   * generation armed. An idle edge with no observed work since the arm is not
   * a turn end — the pane flickered idle while the turn never observably
   * started (or the working state predates the arm).
   */
  busyObserved: boolean;
  /** Unix timestamp of the last observed non-idle snapshot, 0 when none. */
  lastBusyAt: number;
}

interface ActiveTurn {
  generation: number;
  phase: TurnReplyPhase;
  cancelledByUser: boolean;
  target: TurnReplyTarget;
  latestObligation: number;
  replyAttemptedAt: number;
  replyDeliveredAt: number;
  completionDeliveredAt: number;
  outboundDeliveredAt: number;
  busyObservedAt: number;
}

/**
 * Generation-scoped evidence for one human-facing turn (or a batch of messages
 * delivered into the same busy interval).  A tool invocation is only an
 * attempt; delivery is recorded later, after the channel adapter acknowledges
 * it.  The obligation sequence prevents a reply that started before a newer
 * steering message from satisfying that newer message.
 */
export class TurnReplyGuard {
  private active: ActiveTurn | null = null;
  private generation = 0;
  /**
   * #1241 P2-1: work observed while no turn was armed. A paste's output can
   * land before the paste confirms and the arm runs; dropping it would hold a
   * genuine miss forever. A fresh arm carries it over only when it postdates
   * that delivery's ingress — anything older belongs to an earlier turn.
   */
  private pendingActivityAt = 0;
  /**
   * Fired exactly when a turn actually completes (stale generations are
   * fenced out, like the boolean result). #1209 registers a marker-clear
   * here so every completion path — not just the ones someone remembered —
   * keeps a finished turn from resuming after a later restart.
   */
  onComplete: (() => void) | undefined;

  arm(target: TurnReplyTarget, ingressAt = Date.now()): number {
    if (!this.active || this.active.cancelledByUser) {
      const carried = this.pendingActivityAt >= ingressAt ? this.pendingActivityAt : 0;
      this.pendingActivityAt = 0;
      this.active = {
        generation: ++this.generation,
        phase: "awaiting",
        cancelledByUser: false,
        target,
        latestObligation: 1,
        replyAttemptedAt: 0,
        replyDeliveredAt: 0,
        completionDeliveredAt: 0,
        outboundDeliveredAt: 0,
        busyObservedAt: carried,
      };
      return this.active.generation;
    }

    if (this.pendingActivityAt >= ingressAt) {
      this.active.busyObservedAt = Math.max(this.active.busyObservedAt, this.pendingActivityAt);
    }
    this.pendingActivityAt = 0;
    this.active.latestObligation++;
    this.active.target = target;
    return this.active.generation;
  }

  /**
   * #1241: record that the CLI was observably working during the active turn.
   * The daemon calls this for every non-idle execution snapshot. A fresh
   * generation starts unobserved (apart from carried pre-arm evidence, see
   * arm); an obligation bump keeps the flag, since work for the earlier
   * obligation belongs to the same turn.
   */
  noteTurnActivity(): void {
    const active = this.active;
    // A cancelled turn is over: activity from here on belongs to whatever
    // arms next, so it waits in pending (still ingress-bounded at that arm)
    // instead of dying on the doomed generation. (#1241 R3: cancel → new
    // held-writer output used to be lost the same way pre-arm output was.)
    if (active && !active.cancelledByUser) active.busyObservedAt = Date.now();
    else this.pendingActivityAt = Date.now();
  }

  /** Keep outstanding adapter acknowledgments valid until this turn finishes. */
  cancelByUser(): number | null {
    if (!this.active) return null;
    this.active.cancelledByUser = true;
    return this.active.generation;
  }

  beginToolAttempt(reply: boolean, completionAction = reply): ReplyAttemptToken | null {
    const active = this.active;
    if (!active) return null;
    if (reply) active.replyAttemptedAt = Math.max(active.replyAttemptedAt, active.latestObligation);
    return {
      generation: active.generation,
      obligation: active.latestObligation,
      reply,
      completionAction,
    };
  }

  settleToolAttempt(token: ReplyAttemptToken | null, delivered: boolean): void {
    const active = this.active;
    if (!token || !active || token.generation !== active.generation || !delivered) return;
    active.outboundDeliveredAt = Math.max(active.outboundDeliveredAt, token.obligation);
    if (token.reply) active.replyDeliveredAt = Math.max(active.replyDeliveredAt, token.obligation);
    if (token.completionAction) active.completionDeliveredAt = Math.max(active.completionDeliveredAt, token.obligation);
  }

  snapshot(): TurnReplySnapshot | null {
    const active = this.active;
    if (!active) return null;
    return {
      generation: active.generation,
      phase: active.phase,
      cancelledByUser: active.cancelledByUser,
      target: { ...active.target },
      replyAttempted: active.replyAttemptedAt >= active.latestObligation,
      replyDelivered: active.replyDeliveredAt >= active.latestObligation,
      completionDelivered: active.completionDeliveredAt >= active.latestObligation,
      outboundDelivered: active.outboundDeliveredAt >= active.latestObligation,
      busyObserved: active.busyObservedAt > 0,
      lastBusyAt: active.busyObservedAt,
    };
  }

  beginRecovery(generation: number): boolean {
    if (!this.active || this.active.generation !== generation || this.active.phase !== "awaiting"
      || this.active.cancelledByUser) return false;
    this.active.phase = "recovering";
    return true;
  }

  complete(generation: number): boolean {
    if (!this.active || this.active.generation !== generation) return false;
    this.active = null;
    try {
      this.onComplete?.();
    } catch { /* a consumer callback must never break completion */ }
    return true;
  }

  reset(): void {
    this.active = null;
    this.pendingActivityAt = 0;
  }
}
