/** Exact channel destination captured when a human-facing turn is delivered. */
export interface TurnReplyTarget {
  adapterId?: string;
  chatId: string;
  threadId?: string;
  messageId?: string;
  correlationId?: string;
  inboundMarker?: string;
  /** #1510: exactly what was pasted, and when (wall clock) — how a transcript turn is proven to be this delivery's. */
  deliveredText?: string;
  deliveredAt?: number;
}

/**
 * #2544: only a person waiting on a channel answer arms the reply-completion
 * guard. Schedules (silent or not), cross-instance traffic, and AgEnD system
 * notices must not expect a reply to a person.
 */
export function turnExpectsPersonReply(meta: Record<string, string>): boolean {
  if (meta.from_instance) return false;
  const source = meta.source ?? "";
  if (source === "agend-system" || source === "schedule") return false;
  if (meta.user === "scheduler") return false;
  if (!meta.chat_id && source !== "web") return false;
  return true;
}

/** Short, stable diagnostic summary for daemon.log and the web Log; never channel text. */
export function formatReplyDropDetection(
  turn: {
    replyAttempted: boolean;
    replyDelivered: boolean;
    completionDelivered: boolean;
    target: { chatId?: string; threadId?: string };
  },
  reason: string,
): string {
  const bits = [reason, turn.replyDelivered ? "reply-delivered" : "no-adapter-confirmed-reply"];
  if (turn.replyAttempted) bits.push("reply-attempted");
  if (turn.completionDelivered) bits.push("completion-delivered");
  if (turn.target.chatId) bits.push(`chat=${turn.target.chatId}`);
  if (turn.target.threadId) bits.push(`thread=${turn.target.threadId}`);
  return bits.join(", ");
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
  /** #1377: a reply was attempted AND the adapter returned a definitive error. */
  replyAttemptFailed: boolean;
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
  replyAttemptFailedAt: number;
  replyDeliveredAt: number;
  completionDeliveredAt: number;
  outboundDeliveredAt: number;
  busyObservedAt: number;
}

/** Adapter evidence captured while no generation was armed (Codex paste-proof lag). */
interface PendingToolEvidence {
  at: number;
  replyAttempted: boolean;
  replyAttemptFailed: boolean;
  replyDelivered: boolean;
  completionDelivered: boolean;
  outboundDelivered: boolean;
}

const PRE_ARM_GENERATION = 0;

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
   * #2544: a completion tool can begin/settle before paste proof arms the
   * guard (codex: reply at 22:22:25, task_complete + idle confirm later).
   * Bounded by the next arm's ingress, same as pendingActivityAt.
   */
  private pendingTool: PendingToolEvidence | null = null;
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
      const pending = this.pendingTool && this.pendingTool.at >= ingressAt ? this.pendingTool : null;
      this.pendingTool = null;
      this.active = {
        generation: ++this.generation,
        phase: "awaiting",
        cancelledByUser: false,
        target,
        latestObligation: 1,
        replyAttemptedAt: pending?.replyAttempted ? 1 : 0,
        replyAttemptFailedAt: pending?.replyAttemptFailed ? 1 : 0,
        replyDeliveredAt: pending?.replyDelivered ? 1 : 0,
        completionDeliveredAt: pending?.completionDelivered ? 1 : 0,
        outboundDeliveredAt: pending?.outboundDelivered ? 1 : 0,
        busyObservedAt: carried,
      };
      return this.active.generation;
    }

    if (this.pendingActivityAt >= ingressAt) {
      this.active.busyObservedAt = Math.max(this.active.busyObservedAt, this.pendingActivityAt);
    }
    this.pendingActivityAt = 0;
    this.pendingTool = null;
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
    if (!active) {
      // #2544: Codex can call reply before paste proof arms this generation.
      this.stashPendingBegin(reply);
      return {
        generation: PRE_ARM_GENERATION,
        obligation: 0,
        reply,
        completionAction,
      };
    }
    if (reply) active.replyAttemptedAt = Math.max(active.replyAttemptedAt, active.latestObligation);
    return {
      generation: active.generation,
      obligation: active.latestObligation,
      reply,
      completionAction,
    };
  }

  settleToolAttempt(token: ReplyAttemptToken | null, delivered: boolean): void {
    if (!token) return;
    const active = this.active;
    if (token.generation === PRE_ARM_GENERATION) {
      if (active && !active.cancelledByUser) {
        this.applySettle(active, token, delivered, active.latestObligation);
        return;
      }
      if (active?.cancelledByUser) return;
      this.stashPendingSettle(token, delivered);
      return;
    }
    if (!active || token.generation !== active.generation) return;
    this.applySettle(active, token, delivered, token.obligation);
  }

  private applySettle(active: ActiveTurn, token: ReplyAttemptToken, delivered: boolean, obligation: number): void {
    if (!delivered) {
      // #1377: a definitive failure (adapter returned an error) is recorded so
      // maybeProxyReplyOnTurnEnd can distinguish "in-flight" from "known-failed".
      if (token.reply) active.replyAttemptFailedAt = Math.max(active.replyAttemptFailedAt, obligation);
      return;
    }
    active.outboundDeliveredAt = Math.max(active.outboundDeliveredAt, obligation);
    if (token.reply) active.replyDeliveredAt = Math.max(active.replyDeliveredAt, obligation);
    if (token.completionAction) active.completionDeliveredAt = Math.max(active.completionDeliveredAt, obligation);
  }

  private stashPendingBegin(reply: boolean): void {
    const prev = this.pendingTool;
    this.pendingTool = {
      at: Date.now(),
      replyAttempted: (prev?.replyAttempted ?? false) || reply,
      replyAttemptFailed: prev?.replyAttemptFailed ?? false,
      replyDelivered: prev?.replyDelivered ?? false,
      completionDelivered: prev?.completionDelivered ?? false,
      outboundDelivered: prev?.outboundDelivered ?? false,
    };
  }

  private stashPendingSettle(token: ReplyAttemptToken, delivered: boolean): void {
    const at = Date.now();
    const prev = this.pendingTool ?? {
      at,
      replyAttempted: token.reply,
      replyAttemptFailed: false,
      replyDelivered: false,
      completionDelivered: false,
      outboundDelivered: false,
    };
    if (!delivered) {
      if (token.reply) prev.replyAttemptFailed = true;
    } else {
      prev.outboundDelivered = true;
      if (token.reply) prev.replyDelivered = true;
      if (token.completionAction) prev.completionDelivered = true;
    }
    prev.at = at;
    this.pendingTool = prev;
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
      replyAttemptFailed: active.replyAttemptFailedAt >= active.latestObligation,
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
    this.pendingTool = null;
  }
}
