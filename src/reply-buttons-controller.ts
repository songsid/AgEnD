/**
 * #1266: what happens to a reply's buttons after they are sent — a click on a platform or in the web chat, the one
 * choice it makes, the message showing how it ended, and the expiry sweep. The store (reply-buttons.ts) is the truth;
 * this decides who may click and keeps every surface in step with it. FleetManager supplies the fleet's own pieces.
 */
import type { ChannelAdapter } from "./channel/types.js";
import { t } from "./locale.js";
import {
  REPLY_BUTTON_PREFIX, newReplyButtonsId, parseReplyButtonCallback, replyButtonCallback, replyButtonsClickPlace,
  type ReplyButton, type ReplyButtonSet, type ReplyButtonStore,
} from "./reply-buttons.js";

/** A click from a platform adapter (the fleet's callback shape). */
export interface ReplyButtonClick {
  callbackData: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId?: string;
  username?: string;
  ack?: (notice?: string) => void;
}

/** What a web page shows for a reply's buttons. */
export interface ReplyButtonsView {
  id: string;
  labels: string[];
  state: "open" | "chosen" | "expired";
  chosen?: number;
  by?: string;
}

export interface ReplyButtonsDeps {
  store: ReplyButtonStore;
  /** Wall clock: an expiry is a calendar instant that must hold across restarts. */
  now(): number;
  adapterFor(adapterId: string): ChannelAdapter | undefined;
  /** May this platform user answer this set — someone who may message its instance there? */
  mayClick(set: ReplyButtonSet, userId: string): boolean;
  /** Deliver the choice to the instance as an inbound message; false when it could not be delivered. */
  deliver(set: ReplyButtonSet, button: ReplyButton, by: { userId: string; username: string; source: "web" | string }): Promise<boolean>;
  /** Tell the web pages a set changed. */
  publish(instance: string, view: ReplyButtonsView): void;
  logger: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Settled sets are kept a week (a page may still show the reply), then pruned. */
const KEEP_SETTLED_MS = 7 * 24 * 60 * 60 * 1000;
/** setTimeout's ceiling; a later expiry is reached by re-arming. */
const MAX_TIMER_MS = 2_147_483_647;

export class ReplyButtonsController {
  private timer: unknown = null;
  private stopped = false;
  /** Claims this process is delivering right now (a sweep leaves them alone). */
  private readonly inFlight = new Set<string>();
  constructor(private readonly deps: ReplyButtonsDeps) {}

  /** Before the send: a set for these buttons, and the callbacks the platform will carry. */
  prepare(where: { instance: string; adapterId: string; chatId: string; threadId?: string }, buttons: readonly ReplyButton[]): { id: string; callbacks: Array<{ id: string; label: string }> } {
    const id = newReplyButtonsId();
    this.deps.store.create({ id, instance: where.instance, adapterId: where.adapterId, chatId: where.chatId, threadId: where.threadId ?? "", buttons: [...buttons] }, this.deps.now());
    return { id, callbacks: buttons.map((b, i) => ({ id: replyButtonCallback(id, i), label: b.label })) };
  }
  /** After a confirmed send: the message the buttons are on. From now on a click there can match. */
  bind(id: string, messageId: string): void {
    this.deps.store.bind(id, messageId);
    this.arm();
  }
  /** A send that failed: the set never existed. */
  discard(id: string): void { this.deps.store.remove(id); }

  view(set: ReplyButtonSet, now = this.deps.now()): ReplyButtonsView {
    const labels = set.buttons.map(b => b.label);
    if (set.deliveredAt !== null && set.chosenIndex !== null) return { id: set.id, labels, state: "chosen", chosen: set.chosenIndex, by: set.chosenBy ?? "" };
    // Settled without a delivered choice: expired, or a claim a stopped process never delivered (closed as expired).
    if (set.settledAt !== null) return { id: set.id, labels, state: "expired" };
    return { id: set.id, labels, state: now >= set.expiresAt && set.consumedAt === null ? "expired" : "open" };
  }
  viewOf(id: string): ReplyButtonsView | null {
    const set = this.deps.store.get(id);
    return set ? this.view(set) : null;
  }

  /** A platform click. True when the callback is a reply button's (handled here, whatever the outcome). */
  async handleCallback(data: ReplyButtonClick, adapterId: string): Promise<boolean> {
    if (!data.callbackData.startsWith(REPLY_BUTTON_PREFIX)) return false;
    const parsed = parseReplyButtonCallback(data.callbackData);
    const set = parsed ? this.deps.store.get(parsed.id) : null;
    if (!parsed || !set) { data.ack?.(t("reply_buttons.closed")); return true; }
    if (!replyButtonsClickPlace(set, { adapterId, chatId: data.chatId, threadId: data.threadId, messageId: data.messageId })) {
      this.deps.logger.warn({ adapterId, set: set.id }, "Refused reply-button click: not on the message the buttons were sent on");
      data.ack?.(t("buttons.wrong_place"));
      return true;
    }
    if (!data.userId || !this.deps.mayClick(set, data.userId)) {
      this.deps.logger.warn({ adapterId, set: set.id, userId: data.userId }, "Refused reply-button click: not someone who may message this instance here");
      data.ack?.(t("buttons.not_allowed"));
      return true;
    }
    await this.choose(set.id, parsed.index, { userId: data.userId, username: data.username || data.userId, source: "platform" }, data.ack);
    return true;
  }

  /** A click in the web chat (the caller has passed the /ui gate: a session, or the public link). */
  async clickWeb(instance: string, id: string, index: number): Promise<{ status: 200 | 400 | 403 | 409; error?: string }> {
    if (!/^[0-9a-f]{32}$/.test(id) || !Number.isInteger(index) || index < 0) return { status: 400, error: "Malformed button" };
    const set = this.deps.store.get(id);
    if (!set) return { status: 409, error: t("reply_buttons.closed") };
    if (set.instance !== instance) return { status: 403, error: "This button belongs to another instance" };
    let notice: string | undefined;
    const ok = await this.choose(id, index, { userId: "web-user", username: "web-user", source: "web" }, n => { notice = n; });
    return ok ? { status: 200 } : { status: 409, error: notice ?? t("reply_buttons.closed") };
  }

  /** Consume, deliver, then show it everywhere. A choice the agent could not be given is undone (the set reopens). */
  private async choose(id: string, index: number, by: { userId: string; username: string; source: string }, ack?: (notice?: string) => void): Promise<boolean> {
    const now = this.deps.now();
    const result = this.deps.store.consume(id, index, by.username, now);
    if (!result.ok) {
      ack?.(result.reason === "used" ? t("reply_buttons.answered") : t("reply_buttons.closed"));
      if (result.reason === "expired" && result.set) void this.settle(result.set);
      return false;
    }
    let delivered = false;
    this.inFlight.add(id);
    try { delivered = await this.deps.deliver(result.set, result.button, by); }
    catch (err) { this.deps.logger.warn({ err: (err as Error).message, set: id }, "Reply-button choice could not be delivered"); }
    finally { this.inFlight.delete(id); }
    if (!delivered) {
      this.deps.store.release(id, now);
      ack?.(t("reply_buttons.closed"));
      return false;
    }
    this.deps.store.markDelivered(id, this.deps.now());
    ack?.(t("reply_buttons.sent", result.button.label));
    await this.settle(result.set);
    return true;
  }

  /**
   * Show how a set ended on its platform message and in the web chat; once. A failed edit is not retried. Ended is: a
   * delivered choice, an expiry with no claim, or (`closeClaim`) a claim no process is delivering any more.
   */
  async settle(set: ReplyButtonSet, closeClaim = false): Promise<void> {
    const fresh = this.deps.store.get(set.id);
    if (!fresh || fresh.settledAt !== null || fresh.messageId === null) return;
    const now = this.deps.now();
    const ended = fresh.deliveredAt !== null || (fresh.consumedAt === null && now >= fresh.expiresAt) || (closeClaim && fresh.deliveredAt === null);
    if (!ended) return;                                                     // open, or a claim being delivered
    this.deps.store.markSettled(fresh.id, now);                             // first: a concurrent settle does nothing
    const view = this.view({ ...fresh, settledAt: now }, now);
    this.deps.publish(fresh.instance, view);
    const adapter = this.deps.adapterFor(fresh.adapterId);
    if (!adapter?.settleReplyButtons) return;
    const outcome = view.state === "chosen" ? { chosenIndex: view.chosen!, by: view.by ?? "" } : { expired: true as const };
    try { await adapter.settleReplyButtons(fresh.chatId, fresh.messageId, fresh.threadId || undefined, view.labels, outcome); }
    catch (err) { this.deps.logger.warn({ err: (err as Error).message, set: fresh.id }, "Could not update a reply's buttons on the platform"); }
  }

  /**
   * Settle what has ended (an expiry, or a choice whose message was not updated before a restart), then re-arm. A
   * claim no one in this process is delivering was left by a process that stopped mid-delivery: whether the agent got
   * it is unknown, so it is closed as expired ("reply in text") rather than reopened — reopening could deliver a
   * second choice.
   */
  async sweep(): Promise<void> {
    const now = this.deps.now();
    for (const set of this.deps.store.unsettled(now)) await this.settle(set);
    for (const set of this.deps.store.undeliveredClaims()) if (!this.inFlight.has(set.id)) await this.settle(set, true);
    this.deps.store.prune(now - KEEP_SETTLED_MS);
    this.arm();
  }

  /** One timer, for the next expiry. A wall-clock jump makes it fire early or late; the sweep re-reads the clock. */
  arm(): void {
    if (this.stopped) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    const next = this.deps.store.nextExpiry(this.deps.now());
    if (next === null) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(1000, next - this.deps.now()));
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.sweep(); }, delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}
