/**
 * #1266: what happens to a reply's buttons after they are sent — a click on a platform or in the web chat, the one
 * choice it makes, the message showing how it ended, and the expiry sweep. The store (reply-buttons.ts) is the truth;
 * this decides who may click and keeps every surface in step with it. FleetManager supplies the fleet's own pieces.
 */
import type { ChannelAdapter } from "./channel/types.js";
import { webHumanOrigin, type HumanOrigin } from "./human-delivery-receipts.js";
import { t } from "./locale.js";
import {
  REPLY_BUTTON_PREFIX, newReplyButtonsId, parseReplyButtonCallback, replyButtonCallback, replyButtonsClickPlace,
  type ReplyButton, type ReplyButtonSet, type ReplyButtonStore,
} from "./reply-buttons.js";
import {
  POLL_CLOSED_CALLBACK, POLL_STATUS_CALLBACK, pollCounts, pollRender, pollResultsText, pollTickMs, pollVoteNotice, pollVotersText,
  type PollConfig, type PollRender,
} from "./reply-polls.js";

/** A click from a platform adapter (the fleet's callback shape). */
export interface ReplyButtonClick {
  humanOrigin?: HumanOrigin;
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
  state: "open" | "chosen" | "expired" | "closed";
  chosen?: number;
  by?: string;
  /** #1823: the set is a poll ("closed" once its deadline came). */
  poll?: PollView;
}
/**
 * #1823: a poll as a page shows it. Counts only when revealed (`reveal: "live"`, or closed); voters' names only when
 * closed with `show_voters`. `rev` orders views of one poll (a page keeps the newest).
 */
export interface PollView {
  deadline: number;
  answered: number;
  multi: boolean;
  reveal: "close" | "live";
  rev: number;
  counts?: number[];
  voters?: string[][];
}

export interface ReplyButtonsDeps {
  store: ReplyButtonStore;
  /** Wall clock: an expiry is a calendar instant that must hold across restarts. */
  now(): number;
  adapterFor(adapterId: string): ChannelAdapter | undefined;
  /** May this platform user answer this set — someone who may message its instance there? */
  mayClick(set: ReplyButtonSet, userId: string): boolean;
  /** Deliver the choice to the instance as an inbound message; false when it could not be delivered. */
  deliver(set: ReplyButtonSet, button: ReplyButton, by: { userId: string; username: string; source: "web" | string; humanOrigin?: HumanOrigin }): Promise<boolean>;
  /** Tell the web pages a set changed. */
  publish(instance: string, view: ReplyButtonsView): void;
  /**
   * #1823: hand a closed poll's results to the instance, durably and once per `key` (the delivery outbox's system
   * notice): true when the outbox holds them (newly, or from an earlier call), false when it cannot take them now.
   */
  admitResults(set: ReplyButtonSet, key: string, text: string): boolean;
  /** #1823: a monotonic clock, for the redraw throttle (a deadline is wall clock; spacing edits is a duration). */
  monotonic(): number;
  logger: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Settled sets are kept a week (a page may still show the reply), then pruned. */
const KEEP_SETTLED_MS = 7 * 24 * 60 * 60 * 1000;
/** setTimeout's ceiling; a later expiry is reached by re-arming. */
const MAX_TIMER_MS = 2_147_483_647;
/** #1823: redraw spacing for an adapter that names none. */
const DEFAULT_POLL_EDIT_INTERVAL_MS = 3_000;
/** #1823: how often a web-only poll's pages are told about new votes. */
const WEB_POLL_PUBLISH_MS = 1_000;
/** #1823: how soon results the outbox could not take are offered again. */
const RESULTS_RETRY_MS = 30_000;

/** #1823: a poll's redraw state in this process (the store is the truth; this only paces the edits). */
interface PollPace { timer: unknown; tick: unknown; dirty: boolean; lastAt: number; inflight: Promise<void> | null }

export class ReplyButtonsController {
  private timer: unknown = null;
  private stopped = false;
  /** Claims this process is delivering right now (a sweep leaves them alone). */
  private readonly inFlight = new Set<string>();
  /** #1823: per poll, its pending redraw and countdown tick. */
  private readonly pace = new Map<string, PollPace>();
  /** #1823: per chat, the earliest a next poll redraw may go out (monotonic): polls in one chat share its edit limit. */
  private readonly chatNextFree = new Map<string, number>();
  private resultsRetry: unknown = null;
  constructor(private readonly deps: ReplyButtonsDeps) {}

  /**
   * Before the send: a set for these buttons, and the callbacks the platform will carry. A poll (#1823) opens here: its
   * deadline is fixed now, and `poll` is how it looks when posted.
   */
  prepare(where: { instance: string; adapterId: string; chatId: string; threadId?: string }, buttons: readonly ReplyButton[], poll: PollConfig | null = null): { id: string; callbacks: Array<{ id: string; label: string }>; poll?: PollRender } {
    const id = newReplyButtonsId();
    const set = this.deps.store.create({ id, instance: where.instance, adapterId: where.adapterId, chatId: where.chatId, threadId: where.threadId ?? "", buttons: [...buttons], poll }, this.deps.now());
    const callbacks = buttons.map((b, i) => ({ id: replyButtonCallback(id, i), label: b.label }));
    return { id, callbacks, ...(poll ? { poll: this.pollRenderOf(set, false) } : {}) };
  }
  /** After a confirmed send: the message the buttons are on. From now on a click there can match. */
  bind(id: string, messageId: string): void {
    this.deps.store.bind(id, messageId);
    const set = this.deps.store.get(id);
    if (set?.poll) this.scheduleTick(set);
    this.arm();
  }
  /** A send that failed: the set never existed. */
  discard(id: string): void { this.deps.store.remove(id); }

  /** #1823: how a poll looks now (open: "N answered"; closed: the tally). */
  private pollRenderOf(set: ReplyButtonSet, closed: boolean): PollRender {
    return pollRender(set.buttons.map(b => b.label), set.buttons.map((_, i) => replyButtonCallback(set.id, i)), set.poll!,
      this.deps.store.ballots(set.id), set.expiresAt, closed);
  }

  view(set: ReplyButtonSet, now = this.deps.now()): ReplyButtonsView {
    const labels = set.buttons.map(b => b.label);
    if (set.poll) {
      const ballots = this.deps.store.ballots(set.id);
      const closed = set.closedAt !== null;
      const counts = closed || set.poll.reveal === "live" ? pollCounts(labels.length, ballots) : undefined;
      const voters = closed && set.poll.showVoters ? labels.map((_, i) => ballots.filter(b => b.options.includes(i)).map(b => b.name)) : undefined;
      return {
        id: set.id, labels, state: closed ? "closed" : "open",
        poll: { deadline: set.expiresAt, answered: ballots.length, multi: set.poll.multi, reveal: set.poll.reveal, rev: now, ...(counts ? { counts } : {}), ...(voters ? { voters } : {}) },
      };
    }
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
    // #1823: a poll's status button says something, it does nothing; a closed poll's options say it is closed.
    if (data.callbackData === POLL_STATUS_CALLBACK) { data.ack?.(); return true; }
    if (data.callbackData.startsWith(`${POLL_CLOSED_CALLBACK}:`)) { data.ack?.(t("poll.closed")); return true; }
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
    if (set.poll) {
      this.vote(set.id, `${adapterId}:${data.userId}`, data.username || data.userId, parsed.index, data.ack);
      return true;
    }
    await this.choose(set.id, parsed.index, { userId: data.userId, username: data.username || data.userId, source: "platform", humanOrigin: data.humanOrigin }, data.ack);
    return true;
  }

  /**
   * #1823: one vote. The voter alone is told what their ballot is now (Discord: ephemeral; Telegram: a toast); the
   * message shows only "N answered" (or the counts, with `reveal: "live"`), redrawn within the platform's limits.
   */
  vote(id: string, voter: string, name: string, index: number, ack?: (notice?: string) => void): { ok: boolean; options?: number[]; error?: string } {
    const result = this.deps.store.vote(id, voter, name, index, this.deps.now());
    if (!result.ok) {
      // Sent but not yet bound to its message (a click in that instant): not closed — try again in a moment.
      const error = result.reason === "pending" ? t("poll.not_ready") : t("poll.closed");
      ack?.(error);
      if (result.reason === "closed") void this.sweep();                 // a deadline the timer has not reached yet
      return { ok: false, error };
    }
    ack?.(pollVoteNotice(result.set.buttons.map(b => b.label), result.options));
    if (result.changed) this.requestRedraw(result.set);
    return { ok: true, options: result.options };
  }

  /**
   * A click in the web chat (the caller has passed the /ui gate: a session, or the public link). On a poll (#1823) it
   * is `voter`'s vote — a session's public handle, so each signed-in device is one voter — and the answer carries the
   * ballot, for the page to mark the voter's own choice.
   */
  async clickWeb(instance: string, id: string, index: number, voter?: { key: string; userId: string; name: string }): Promise<{ status: 200 | 400 | 403 | 409; error?: string; options?: number[] }> {
    if (!/^[0-9a-f]{32}$/.test(id) || !Number.isInteger(index) || index < 0) return { status: 400, error: "Malformed button" };
    const set = this.deps.store.get(id);
    if (!set) return { status: 409, error: t("reply_buttons.closed") };
    if (set.instance !== instance) return { status: 403, error: "This button belongs to another instance" };
    if (set.poll) {
      if (!voter) return { status: 403, error: "A vote needs a signed-in session" };
      const r = this.vote(id, voter.key, voter.name, index);
      return r.ok ? { status: 200, options: r.options } : { status: 409, error: r.error };
    }
    let notice: string | undefined;
    // #1827: the choice is the web person's (their web id and name; "web-user" when there is none) — still `via web`
    // with no verified actor (webHumanOrigin).
    const ok = await this.choose(id, index, { userId: voter?.userId ?? "web-user", username: voter?.name ?? "web-user", source: "web", humanOrigin: webHumanOrigin(true) }, n => { notice = n; });
    return ok ? { status: 200 } : { status: 409, error: notice ?? t("reply_buttons.closed") };
  }

  /** Consume, deliver, then show it everywhere. A choice the agent could not be given is undone (the set reopens). */
  private async choose(id: string, index: number, by: { userId: string; username: string; source: string; humanOrigin?: HumanOrigin }, ack?: (notice?: string) => void): Promise<boolean> {
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
    // Invariant (#1500 review r2): an orphan close only closes a set that is STILL claimed and not delivered. A claim
    // released while a sweep was awaiting another set's edit is open again — re-read here, it is not an orphan.
    const ended = fresh.deliveredAt !== null || (fresh.consumedAt === null && now >= fresh.expiresAt)
      || (closeClaim && fresh.consumedAt !== null && fresh.deliveredAt === null && !this.inFlight.has(fresh.id));
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
    await this.sweepPolls();
    this.deps.store.prune(now - KEEP_SETTLED_MS);
    this.arm();
  }

  /**
   * #1823: polls whose deadline came are closed (no vote counts after that), their results handed to the outbox once,
   * and their message redrawn as closed. After a restart this also catches up: a deadline passed while AgEnD was down
   * closes now (the results say how late), and an open poll's countdown is drawn again.
   */
  private async sweepPolls(): Promise<void> {
    for (const set of this.deps.store.pollsDue(this.deps.now())) {
      if (this.deps.store.closePoll(set.id, this.deps.now())) this.deps.logger.info({ set: set.id, instance: set.instance }, "Poll closed");
    }
    let owed = false;
    for (const set of this.deps.store.pollsAwaitingResults()) {
      const ballots = this.deps.store.ballots(set.id);
      let admitted = false;
      try { admitted = this.deps.admitResults(set, `poll:${set.id}`, pollResultsText(set, set.poll!, ballots, set.closedAt!)); }
      catch (err) { this.deps.logger.warn({ err: (err as Error).message, set: set.id }, "Poll results could not be handed to the outbox"); }
      if (admitted) this.deps.store.markResults(set.id, this.deps.now());
      else owed = true;
    }
    for (const set of this.deps.store.pollsUnsettled()) await this.settlePoll(set);
    // Drawn again once per process (after a restart its countdown is stale), then paced by its own ticks.
    for (const set of this.deps.store.openPolls()) if (!this.pace.has(set.id)) this.requestRedraw(set);
    if (owed && this.resultsRetry === null && !this.stopped) {
      this.resultsRetry = this.deps.setTimer(() => { this.resultsRetry = null; void this.sweep(); }, RESULTS_RETRY_MS);
    }
  }

  /**
   * #1823: `instance` closes its own open poll before the deadline (close_poll). The close is the same one the deadline
   * makes — once, results through the outbox, the message redrawn — and the results say it closed early.
   */
  async closeEarly(instance: string, id: string): Promise<{ ok: true; voted: number } | { ok: false; error: string }> {
    const set = this.deps.store.get(id);
    if (!set?.poll || set.instance !== instance) return { ok: false, error: "no open poll of yours has that id" };
    if (set.messageId === null) return { ok: false, error: "that poll is still being posted; try again in a moment" };
    // The close itself is the check: of two closes (or a close and the deadline) only one changes the row.
    if (!this.deps.store.closePoll(id, this.deps.now())) return { ok: false, error: "that poll is already closed" };
    this.deps.logger.info({ set: id, instance }, "Poll closed early");
    await this.sweep();
    return { ok: true, voted: this.deps.store.ballots(id).length };
  }

  /** #1823: a closed poll's message shows the tally, once (a failed edit is logged, not retried); with show_voters, who. */
  private async settlePoll(set: ReplyButtonSet): Promise<void> {
    const fresh = this.deps.store.get(set.id);
    if (!fresh?.poll || fresh.closedAt === null || fresh.settledAt !== null || fresh.messageId === null) return;
    this.deps.store.markSettled(fresh.id, this.deps.now());               // first: a concurrent settle does nothing
    const pace = this.pace.get(fresh.id);
    this.dropPace(fresh.id);                                                 // a redraw waiting to go now stands down
    while (pace?.inflight) await pace.inflight;                              // the one going lands before the closed one
    this.deps.publish(fresh.instance, this.view(fresh));
    const adapter = this.deps.adapterFor(fresh.adapterId);
    if (!adapter?.renderPoll) return;
    try { await adapter.renderPoll(fresh.chatId, fresh.messageId, fresh.threadId || undefined, this.pollRenderOf(fresh, true)); }
    catch (err) { this.deps.logger.warn({ err: (err as Error).message, set: fresh.id }, "Could not show a closed poll on the platform"); }
    if (!fresh.poll.showVoters) return;
    const ballots = this.deps.store.ballots(fresh.id);
    if (!ballots.length) return;
    try {
      await adapter.sendText(fresh.chatId, pollVotersText(fresh.buttons.map(b => b.label), ballots),
        { threadId: fresh.threadId || undefined, replyTo: fresh.messageId, allowedMentions: { parse: [] } });
    } catch (err) { this.deps.logger.warn({ err: (err as Error).message, set: fresh.id }, "Could not post a closed poll's voters"); }
  }

  /**
   * #1823: redraw a poll soon, coalesced: one pending redraw per poll, and per chat no closer than the adapter's edit
   * interval to the last one (polls in one chat share it). What is drawn is read when it goes out, not now.
   */
  private requestRedraw(set: ReplyButtonSet): void {
    if (this.stopped) return;
    const pace = this.paceOf(set.id);
    pace.dirty = true;
    if (pace.timer !== null) return;
    const adapter = this.deps.adapterFor(set.adapterId);
    // Only the web chat (no platform message to edit): its pages are told as often as once a second.
    const interval = adapter ? adapter.pollEditIntervalMs ?? DEFAULT_POLL_EDIT_INTERVAL_MS : WEB_POLL_PUBLISH_MS;
    // The platform's limit is per chat (Telegram: the whole group, its topics included) or per thread (Discord: each
    // channel or thread has its own bucket) — the adapter says which (#1824 review).
    const chat = adapter?.pollRateScope === "chat" ? `${set.adapterId}\u0000${set.chatId}` : `${set.adapterId}\u0000${set.chatId}\u0000${set.threadId}`;
    const now = this.deps.monotonic();
    for (const [k, free] of this.chatNextFree) if (free <= now) this.chatNextFree.delete(k);   // past slots: forgotten
    const slot = Math.max(now, this.chatNextFree.get(chat) ?? 0, pace.lastAt ? pace.lastAt + interval : 0);
    this.chatNextFree.set(chat, slot + interval);
    pace.timer = this.deps.setTimer(() => { pace.timer = null; void this.redraw(set.id); }, slot - now);
  }

  private async redraw(id: string): Promise<void> {
    const pace = this.pace.get(id);
    if (!pace || !pace.dirty) return;
    pace.dirty = false;
    pace.lastAt = this.deps.monotonic();
    // One edit at a time per poll, in order: every waiter re-checks after waking (two woken by the same edit must not
    // both go — #1824 review).
    while (pace.inflight) await pace.inflight;
    if (this.pace.get(id) !== pace) return;                                // the close took it over meanwhile
    const set = this.deps.store.get(id);
    if (!set?.poll || set.closedAt !== null || set.messageId === null) return;   // closing draws its own final state
    if (this.deps.now() >= set.expiresAt) { void this.sweep(); return; }
    this.deps.publish(set.instance, this.view(set));                        // the web chat, whatever the platform
    const adapter = this.deps.adapterFor(set.adapterId);
    if (adapter?.renderPoll) {
      // Kept while in flight: the close waits for it, so an open redraw never lands on top of the closed one.
      const run = adapter.renderPoll(set.chatId, set.messageId, set.threadId || undefined, this.pollRenderOf(set, false))
        .catch(err => { this.deps.logger.warn({ err: (err as Error).message, set: id }, "Could not redraw a poll on the platform"); });
      pace.inflight = run;
      await run;
      if (pace.inflight === run) pace.inflight = null;
    }
    if (this.pace.get(id) === pace) this.scheduleTick(set);                 // not if the close took it over meanwhile
  }

  /** #1823: a platform that cannot count down by itself is redrawn as time passes, coarser the more is left. */
  private scheduleTick(set: ReplyButtonSet): void {
    if (this.stopped) return;
    const pace = this.paceOf(set.id);
    if (pace.tick !== null) { this.deps.clearTimer(pace.tick); pace.tick = null; }
    if (!this.deps.adapterFor(set.adapterId)?.pollCountdownTicks) return;
    const left = set.expiresAt - this.deps.now();
    if (left <= 0) return;
    // On the step's boundaries of the time left (…0:15, 0:10…), so a redraw that went out late does not shift the next.
    const step = pollTickMs(left);
    const delay = left % step || step;
    if (delay >= left) return;                                             // the close draws the rest
    pace.tick = this.deps.setTimer(() => { pace.tick = null; this.requestRedraw(set); }, delay);
  }

  private paceOf(id: string): PollPace {
    let pace = this.pace.get(id);
    if (!pace) { pace = { timer: null, tick: null, dirty: false, lastAt: 0, inflight: null }; this.pace.set(id, pace); }
    return pace;
  }
  private dropPace(id: string): void {
    const pace = this.pace.get(id);
    if (!pace) return;
    if (pace.timer !== null) this.deps.clearTimer(pace.timer);
    if (pace.tick !== null) this.deps.clearTimer(pace.tick);
    this.pace.delete(id);
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
    if (this.resultsRetry !== null) this.deps.clearTimer(this.resultsRetry);
    this.resultsRetry = null;
    for (const id of [...this.pace.keys()]) this.dropPace(id);
  }
}
