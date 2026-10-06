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
   * Fired exactly when a turn actually completes (stale generations are
   * fenced out, like the boolean result). #1209 registers a marker-clear
   * here so every completion path — not just the ones someone remembered —
   * keeps a finished turn from resuming after a later restart.
   */
  onComplete: (() => void) | undefined;

  arm(target: TurnReplyTarget): number {
    if (!this.active || this.active.cancelledByUser) {
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
      };
      return this.active.generation;
    }

    this.active.latestObligation++;
    this.active.target = target;
    return this.active.generation;
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
  }
}
