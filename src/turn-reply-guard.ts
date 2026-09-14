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
  reply: boolean;
}

export interface TurnReplySnapshot {
  generation: number;
  phase: TurnReplyPhase;
  target: TurnReplyTarget;
  replyAttempted: boolean;
  replyDelivered: boolean;
  outboundDelivered: boolean;
}

interface ActiveTurn {
  generation: number;
  phase: TurnReplyPhase;
  target: TurnReplyTarget;
  latestObligation: number;
  replyAttemptedAt: number;
  replyDeliveredAt: number;
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

  arm(target: TurnReplyTarget): number {
    if (!this.active) {
      this.active = {
        generation: ++this.generation,
        phase: "awaiting",
        target,
        latestObligation: 1,
        replyAttemptedAt: 0,
        replyDeliveredAt: 0,
        outboundDeliveredAt: 0,
      };
      return this.active.generation;
    }

    this.active.latestObligation++;
    this.active.target = target;
    return this.active.generation;
  }

  beginToolAttempt(reply: boolean): ReplyAttemptToken | null {
    const active = this.active;
    if (!active) return null;
    if (reply) active.replyAttemptedAt = Math.max(active.replyAttemptedAt, active.latestObligation);
    return {
      generation: active.generation,
      obligation: active.latestObligation,
      reply,
    };
  }

  settleToolAttempt(token: ReplyAttemptToken | null, delivered: boolean): void {
    const active = this.active;
    if (!token || !active || token.generation !== active.generation || !delivered) return;
    active.outboundDeliveredAt = Math.max(active.outboundDeliveredAt, token.obligation);
    if (token.reply) active.replyDeliveredAt = Math.max(active.replyDeliveredAt, token.obligation);
  }

  snapshot(): TurnReplySnapshot | null {
    const active = this.active;
    if (!active) return null;
    return {
      generation: active.generation,
      phase: active.phase,
      target: { ...active.target },
      replyAttempted: active.replyAttemptedAt >= active.latestObligation,
      replyDelivered: active.replyDeliveredAt >= active.latestObligation,
      outboundDelivered: active.outboundDeliveredAt >= active.latestObligation,
    };
  }

  beginRecovery(generation: number): boolean {
    if (!this.active || this.active.generation !== generation || this.active.phase !== "awaiting") return false;
    this.active.phase = "recovering";
    return true;
  }

  complete(generation: number): boolean {
    if (!this.active || this.active.generation !== generation) return false;
    this.active = null;
    return true;
  }

  reset(): void {
    this.active = null;
  }
}
