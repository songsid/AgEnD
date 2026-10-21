/**
 * #1386: the fleet side of "Needs you". One derivation (needs-you.ts), recomputed on change, rendered to:
 * - each world's live message in its General and, optionally, its admins' DMs — only that world's items (§5.0, §5);
 * - the web, globally: SSE `needs` and a `needs` field on /ui/poll (§6).
 * Plus Acknowledge for delivery items, from a world's live message (its admins, its items) or from the web (any); and
 * for task board cards (#2246 step 3), Confirm, Send back and Answer from the live message — the two that need words
 * ask for them as a reply to a prompt the bot posts, which only the admin who clicked may answer.
 *
 * The Acknowledge capabilities live in this hub's own registry, not in the fleet's prompt map: the map's walkers
 * (per-instance clear, shutdown retire, prompt expiry) edit the message an entry points at, and the live message must
 * only ever be edited by its own renderer. The checks are the same as every other button's: a 128-bit nonce, bound
 * to the world, chat, thread and message that showed it, and fleet admin of that world.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./backend/kiro-engine-ledger.js";
import type { ChannelAdapter } from "./channel/types.js";
import { isMessageEditLoss } from "./channel/message-edit-errors.js";
import {
  deriveNeedsYou, itemsForWorld, renderLiveMessage, renderSignature, messageLink, instanceLink,
  type DeliveryInput, type InstanceInput, type NeedsYouItem, type PromptInput, type TaskInput, type WorldPlace,
} from "./needs-you.js";
import { GroupMembership, topicUrl } from "./topic-link.js";
import { NeedsYouLiveMessage, canonicalTarget, samePlace, type LiveAcks, type LivePointer, type LiveTarget } from "./needs-you-live.js";

export const NEEDS_ACK_PREFIX = "needs-ack:";
const ACK_RE = /^needs-ack:([0-9a-f]{32}):(ack|confirm|back|answer)$/;
/** A Send back or Answer prompt waits this long for its reply (monotonic). */
export const TASK_REPLY_TTL_MS = 10 * 60_000;
/** Send back / Answer prompts open at once, being sent or waiting for their reply, over every card and person (#2306 review). */
export const TASK_REPLY_MAX = 32;
const BACKSTOP_MS = 10_000;
const ATTENTION_WINDOW_MS = 24 * 60 * 60_000;
/** awaiting_input pings (DM, browser) only once it has lasted this long; the list itself is never delayed (§6.3). */
export const AWAITING_PING_MIN_MS = 5_000;
const DM_MIN_MS = 60_000;
/** An Acknowledge button's capability lapses this long after it was minted, whether or not a renewal replaced it. */
export const ACK_TTL_MS = 15 * 60_000;

export interface NeedsYouWorld {
  id: string;
  place: WorldPlace;
  adapter: ChannelAdapter;
}

export interface NeedsYouHubContext {
  dataDir: string;
  /** Wall clock, for item ages and the outbox window. */
  now(): number;
  /** Monotonic clock, for every rate limit and debounce. */
  mono(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  prompts(): PromptInput[];
  instances(): InstanceInput[];
  deliveries(sinceIso: string): DeliveryInput[];
  /** The live world owning an instance, or undefined. */
  ownerOf(instance: string): string | undefined;
  worlds(): NeedsYouWorld[];
  /** Where a world's fleet notices go (its General), or null. */
  noticeTarget(world: string): LiveTarget | null;
  /** An instance's own thread/topic id, for its link. */
  instanceTopic(instance: string): string | undefined;
  isFleetAdmin(userId: string, world: string): boolean;
  fleetAdmins(world: string): string[];
  emitSse(event: string, data: unknown): void;
  /** outbox.acknowledge: true when this call acknowledged it; throws on a write error. */
  acknowledge(deliveryId: string, by: string): boolean;
  /** Task board cards waiting for the person (#2246 step 3); none when the board is not open. */
  tasks?(): TaskInput[];
  /**
   * The person's move on a card from the chat: confirm it, send it back with `text` (the reason), or answer its blocked
   * question with `text`. Checked against the version the button showed; the answer is said to the clicker.
   */
  taskAction?(action: TaskAction): { ok: boolean; message: string };
  settings(): { liveMessage: boolean; dm: boolean };
  stopping(): boolean;
  t(key: string, ...args: Array<string | number>): string;
  log(level: "info" | "warn" | "debug", message: string, extra?: Record<string, unknown>): void;
}

export type TaskVerb = "confirm" | "back" | "answer";
export interface TaskAction {
  verb: TaskVerb;
  code: string;
  version: number;
  /** The reason (back) or the answer (answer). */
  text?: string;
  /** The person, as the platform names them. */
  by: { platform: string; userId: string; username?: string };
}

/**
 * A Send back or Answer prompt, waiting for its reply in the place it was posted. It keeps whose card it is and the
 * world as it was (its connection, its place): the reply is taken only while they still hold (#2306 review).
 */
interface PendingReply {
  world: string;
  instance: string;
  adapter: ChannelAdapter;
  placeKey: string;
  /** Its reservation: one prompt per world, card, person and verb at a time. */
  askKey: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId: string;
  username?: string;
  verb: "back" | "answer";
  code: string;
  version: number;
  deadline: number;
}

/** A reply to a message, as the inbound handler sees it (InboundMessage's fields). */
export interface ReplyMessage {
  adapterId: string;
  chatId: string;
  threadId?: string;
  replyTo?: string;
  messageId: string;
  userId: string;
  username?: string;
  text: string;
}

interface AckEntry {
  world: string;
  /** The renderer that minted it: revoking is per renderer, so a replaced one cannot revoke its successor's. */
  owner: symbol;
  generation: number;
  /** Monotonic deadline: past it the capability is stale, whatever happened to renewals (#1398 review). */
  deadline: number;
  chatId: string;
  threadId?: string;
  messageId?: string;
  /** What the button does: Acknowledge a delivery, or a person's move on a task card. */
  verb: "ack" | TaskVerb;
  deliveryId?: string;
  card?: { code: string; version: number };
  instance: string;
}

export interface AckCallback {
  callbackData: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId?: string;
  username?: string;
  ack?(notice?: string): void;
}

/** What the web receives: the items without their chat coordinates. */
export type WebNeedsItem = Omit<NeedsYouItem, "promptAt">;

/** What a renderer is built for, besides its adapter: platform and group. */
function placeKey(place: WorldPlace): string {
  return `${place.type}|${place.groupId ?? ""}`;
}

export class NeedsYouHub {
  private items: NeedsYouItem[] = [];
  private webSignature = "";
  private readonly worldSignature = new Map<string, string>();
  private readonly worldSeen = new Map<string, Set<string>>();
  /** Each world's renderer, pinned to the adapter and place it was built for (#1398 review): a replaced adapter or
   *  moved place gets a new renderer, and the old one can no longer publish. */
  private readonly live = new Map<string, { renderer: NeedsYouLiveMessage; adapter: ChannelAdapter; placeKey: string }>();
  private readonly acks = new Map<string, AckEntry>();
  /** Send back / Answer prompts waiting for the clicker's reply, by `${world}|${chatId}|${messageId}`. */
  /** Pending replies by where their prompt is (`<chatId>|<messageId>`), whichever bot receives the reply. */
  private readonly replies = new Map<string, PendingReply>();
  /** Prompts on their way: reserved before the send, released when it is posted or fails (#2306 review). */
  private readonly asking = new Set<string>();
  private readonly dmSeen = new Map<string, Set<string>>();
  private readonly dmLastAt = new Map<string, number>();
  /** Per world: the ids waiting to be DMed, and the one timer that will send them. */
  private readonly dmPending = new Map<string, Set<string>>();
  private readonly dmTimer = new Map<string, unknown>();
  private pending: unknown = null;
  private backstop: unknown = null;
  private stopped = false;
  /** The first computation after start: what waits then is not news (a restart edits, it does not post or DM). */
  private seeded = false;

  /** #1990: a DM links into the group only for a confirmed member. */
  private readonly membership: GroupMembership;

  constructor(private readonly ctx: NeedsYouHubContext) {
    this.membership = new GroupMembership({ now: () => ctx.mono() });
  }

  start(): void {
    this.recompute();
    const tick = () => { this.backstop = this.ctx.setTimer(tick, BACKSTOP_MS); this.recompute(); };
    this.backstop = this.ctx.setTimer(tick, BACKSTOP_MS);
  }

  /** Something that may change the list happened: recompute once, soon (coalesced). */
  poke(): void {
    if (this.stopped || this.pending !== null) return;
    this.pending = this.ctx.setTimer(() => { this.pending = null; this.recompute(); }, 0);
  }

  /** The current list for the web (global, §5.0). */
  webItems(): WebNeedsItem[] {
    return this.items.map(({ promptAt: _promptAt, ...rest }) => rest);
  }

  recompute(): void {
    if (this.stopped) return;
    const now = this.ctx.now();
    for (const [key, r] of this.replies) if (this.ctx.mono() >= r.deadline) this.replies.delete(key);
    let deliveries: DeliveryInput[] = [];
    try {
      deliveries = this.ctx.deliveries(new Date(now - ATTENTION_WINDOW_MS).toISOString());
    } catch (err) {
      this.ctx.log("warn", "Needs you: could not read the delivery outbox", { err: String((err as Error)?.message ?? err) });
    }
    let tasks: TaskInput[] = [];
    try { tasks = this.ctx.tasks?.() ?? []; } catch (err) {
      this.ctx.log("warn", "Needs you: could not read the task board", { err: String((err as Error)?.message ?? err) });
    }
    this.items = deriveNeedsYou({ prompts: this.ctx.prompts(), instances: this.ctx.instances(), deliveries, tasks, ownerOf: i => this.ctx.ownerOf(i) });

    const webSig = renderSignature(this.items, now);
    if (webSig !== this.webSignature) {
      this.webSignature = webSig;
      this.ctx.emitSse("needs", { items: this.webItems() });
    }

    const settings = this.ctx.settings();
    const worlds = this.ctx.worlds();
    const worldIds = new Set(worlds.map(w => w.id));
    for (const [id, pinned] of this.live) {
      const current = worlds.find(w => w.id === id);
      if (!settings.liveMessage || !current) {
        this.live.delete(id); this.worldSignature.delete(id);
        void pinned.renderer.disable();
      } else if (current.adapter !== pinned.adapter || placeKey(current.place) !== pinned.placeKey) {
        // Another adapter (or place) under the same id: the old renderer stops without touching anything — its adapter
        // may be gone — and a new one picks up from the persisted pointer.
        this.live.delete(id); this.worldSignature.delete(id);
        pinned.renderer.abandon();
      }
    }
    if (!settings.dm) for (const id of [...this.dmPending.keys()]) this.cancelDms(id);
    for (const id of [...this.dmPending.keys()]) if (!worldIds.has(id)) this.cancelDms(id);
    const seeding = !this.seeded;
    this.seeded = true;
    for (const world of worlds) {
      const mine = itemsForWorld(this.items, world.id);
      if (seeding) {
        this.worldSeen.set(world.id, new Set(mine.map(i => i.id)));
        this.dmSeen.set(world.id, new Set(mine.map(i => i.id)));
      }
      const seen = this.worldSeen.get(world.id) ?? new Set<string>();
      const fresh = mine.filter(i => !seen.has(i.id));
      this.worldSeen.set(world.id, new Set(mine.map(i => i.id)));
      if (settings.liveMessage) {
        let pinned = this.live.get(world.id);
        if (!pinned) {
          pinned = { renderer: this.makeLive(world), adapter: world.adapter, placeKey: placeKey(world.place) };
          this.live.set(world.id, pinned);
        }
        const sig = renderSignature(mine, now);
        if (sig !== this.worldSignature.get(world.id)) {
          this.worldSignature.set(world.id, sig);
          pinned.renderer.changed(fresh.length > 0);
        }
      }
      if (settings.dm) this.queueDms(world, mine, now);
    }
  }

  // ── Live messages ──────────────────────────────────────────────────────────────────────────────────────────

  private pointerPath(): string { return join(this.ctx.dataDir, "needs-you-message.json"); }

  private readPointers(): Record<string, LivePointer> {
    try {
      const parsed = JSON.parse(readFileSync(this.pointerPath(), "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, LivePointer> = {};
      for (const [world, p] of Object.entries(parsed as Record<string, unknown>)) {
        const v = p as Partial<LivePointer>;
        if (v && typeof v.chatId === "string" && typeof v.messageId === "string" && (v.threadId === undefined || typeof v.threadId === "string")) {
          out[world] = { chatId: v.chatId, messageId: v.messageId, ...(v.threadId !== undefined ? { threadId: v.threadId } : {}) };
        }
      }
      return out;
    } catch { return {}; }
  }

  private writePointer(world: string, pointer: LivePointer | null): void {
    const all = this.readPointers();
    if (pointer) all[world] = pointer; else delete all[world];
    try { writeFileAtomic(this.pointerPath(), JSON.stringify(all, null, 2) + "\n"); }
    catch (err) { this.ctx.log("warn", "Needs you: could not save where the live message is", { world, err: String((err as Error)?.message ?? err) }); }
  }

  /** A line's words: why it waits — and for a card, which card and what it asks or lacks (the chat shows no detail). */
  private lineTitle(item: NeedsYouItem): string {
    const reason = this.ctx.t(`needs.reason.${item.reason}`);
    return item.type === "task" && item.detail ? `${reason}: ${item.detail}` : reason;
  }

  private makeLive(world: NeedsYouWorld): NeedsYouLiveMessage {
    const ctx = this.ctx;
    const owner = Symbol(world.id);
    return new NeedsYouLiveMessage({
      world: world.id,
      now: () => ctx.mono(),
      setTimer: (fn, ms) => ctx.setTimer(fn, ms),
      clearTimer: h => ctx.clearTimer(h),
      target: () => { const t = ctx.noticeTarget(world.id); return t ? canonicalTarget(t) : null; },
      enabled: () => ctx.settings().liveMessage,
      stopping: () => ctx.stopping() || this.stopped,
      // The same world means the same adapter object and place it was built for, not just the same id.
      worldExists: () => ctx.worlds().some(w => w.id === world.id && w.adapter === world.adapter && placeKey(w.place) === placeKey(world.place)),
      content: () => {
        const mine = itemsForWorld(this.items, world.id);
        const lines = mine.map(item => ({
          item, title: this.lineTitle(item),
          link: item.promptAt ? messageLink(world.place, item.promptAt) : instanceLink(world.place, ctx.instanceTopic(item.instance)),
        }));
        const rendered = renderLiveMessage(lines, ctx.now(), (k, ...a) => ctx.t(k, ...a));
        return { empty: mine.length === 0, ...rendered };
      },
      post: async (target, text, choices) => {
        const sent = await world.adapter.notifyAlert(target.chatId, { type: "needs_you", instanceName: "", message: text, choices },
          target.threadId ? { threadId: target.threadId } : undefined);
        return { ...canonicalTarget(target), messageId: sent.messageId };
      },
      edit: async (pointer, text, choices) => {
        if (!world.adapter.editAlert) throw new Error("adapter cannot edit an alert");
        await world.adapter.editAlert(pointer.chatId, pointer.messageId, { type: "needs_you", instanceName: "", message: text, choices },
          pointer.threadId ? { threadId: pointer.threadId } : undefined);
      },
      isEditLoss: isMessageEditLoss,
      remove: async pointer => { await world.adapter.deleteMessage?.(pointer.chatId, pointer.messageId, pointer.threadId); },
      loadPointer: () => this.readPointers()[world.id] ?? null,
      savePointer: pointer => this.writePointer(world.id, pointer),
      mintAcks: (generation, place, items) => this.mintAcks(world.id, owner, generation, place, items),
      revokeAcks: () => this.revokeAcks(owner),
      log: (message, extra) => ctx.log("info", `Needs you: ${message}`, extra),
      text: { stopped: ctx.t("needs.live_stopped"), off: ctx.t("needs.live_off") },
    });
  }

  private mintAcks(world: string, owner: symbol, generation: number, place: LiveTarget & { messageId?: string }, items: NeedsYouItem[]): LiveAcks {
    const minted: AckEntry[] = [];
    const mint = (item: NeedsYouItem, verb: AckEntry["verb"], label: string) => {
      const nonce = randomBytes(16).toString("hex");
      const entry: AckEntry = {
        world, owner, generation, deadline: this.ctx.mono() + ACK_TTL_MS, chatId: place.chatId, ...(place.threadId !== undefined ? { threadId: place.threadId } : {}),
        ...(place.messageId ? { messageId: place.messageId } : {}), verb, instance: item.instance,
        ...(item.deliveryId ? { deliveryId: item.deliveryId } : {}), ...(item.card ? { card: { ...item.card } } : {}),
      };
      this.acks.set(nonce, entry);
      minted.push(entry);
      return { id: `${NEEDS_ACK_PREFIX}${nonce}:${verb}`, label };
    };
    const choices = items.flatMap(item => {
      if (item.deliveryId) return [mint(item, "ack", this.ctx.t("needs.ack_button", item.instance))];
      if (item.type !== "task" || !item.card) return [];
      const code = item.card.code;
      return item.reason === "task_review"
        ? [mint(item, "confirm", this.ctx.t("needs.task_confirm_button", code)), mint(item, "back", this.ctx.t("needs.task_back_button", code))]
        : [mint(item, "answer", this.ctx.t("needs.task_answer_button", code))];
    });
    return { choices, bind: pointer => { for (const e of minted) e.messageId = pointer.messageId; } };
  }

  private revokeAcks(owner: symbol): void {
    for (const [nonce, e] of this.acks) if (e.owner === owner) this.acks.delete(nonce);
  }

  // ── Acknowledge ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A click on a live message's Acknowledge. true when it was ours (handled, whatever the answer), false otherwise.
   * Stale capabilities (an older render, a replaced message, a restart) only answer the clicker: the live message is
   * never edited from here — that would strip the current keyboard of the same message.
   */
  handleCallback(data: AckCallback, adapterId: string): boolean {
    if (!data.callbackData.startsWith(NEEDS_ACK_PREFIX)) return false;
    const m = ACK_RE.exec(data.callbackData);
    const found = m ? this.acks.get(m[1]) : undefined;
    const entry = found && found.verb === m![2] ? found : undefined;
    if (entry && this.ctx.mono() >= entry.deadline) this.acks.delete(m![1]);
    // Unknown, revoked, lapsed — or not yet bound to the message its post returned: no authority yet.
    if (!m || !entry || this.ctx.mono() >= entry.deadline || entry.messageId === undefined) {
      data.ack?.(this.ctx.t("needs.ack_stale")); return true;
    }
    const wrongPlace = entry.world !== adapterId || entry.chatId !== data.chatId
      || (entry.threadId !== undefined && data.threadId !== entry.threadId)
      || data.messageId !== entry.messageId;
    if (wrongPlace) { data.ack?.(this.ctx.t("buttons.wrong_place")); return true; }
    if (!data.userId || !this.ctx.isFleetAdmin(data.userId, adapterId)) { data.ack?.(this.ctx.t("buttons.admin_only")); return true; }
    // §5.0: the item must still belong to this world.
    if (this.ctx.ownerOf(entry.instance) !== adapterId) { data.ack?.(this.ctx.t("needs.ack_not_this_world")); return true; }
    const platform = this.ctx.worlds().find(w => w.id === adapterId)?.place.type ?? "chat";
    if (entry.verb === "ack") {
      data.ack?.(this.ctx.t(`needs.ack_${this.acknowledge(entry.deliveryId!, `${platform}:${data.userId}`)}`));
      return true;
    }
    const card = entry.card!;
    const by = { platform, userId: data.userId, ...(data.username ? { username: data.username } : {}) };
    if (entry.verb === "confirm") {
      const outcome = this.ctx.taskAction?.({ verb: "confirm", code: card.code, version: card.version, by }) ?? { ok: false, message: this.ctx.t("needs.task_board_closed") };
      data.ack?.(outcome.message);
      this.poke();
      return true;
    }
    // Send back and Answer take words: a prompt the clicker answers by replying to it (handleReply). One prompt per
    // world, card, person and verb at a time, reserved before the send (#2306 review): a second press while one is on
    // its way or still waits is told so, and the prompts open over everything are capped.
    const askKey = `${adapterId}|${card.code}|${data.userId}|${entry.verb}`;
    if (this.asking.has(askKey) || this.pendingFor(askKey)) { data.ack?.(this.ctx.t("needs.task_reply_already", card.code)); return true; }
    if (this.asking.size + this.livePending() >= TASK_REPLY_MAX) { data.ack?.(this.ctx.t("needs.task_reply_busy")); return true; }
    this.asking.add(askKey);
    data.ack?.(this.ctx.t("needs.task_reply_asked"));
    void this.askForReply(entry, entry.verb, by, askKey);
    return true;
  }

  /** A prompt for this reservation still waits for its reply. */
  private pendingFor(askKey: string): boolean {
    const now = this.ctx.mono();
    for (const r of this.replies.values()) if (r.askKey === askKey && now < r.deadline) return true;
    return false;
  }

  /** Prompts still waiting for their reply (lapsed ones go). */
  private livePending(): number {
    const now = this.ctx.mono();
    for (const [key, r] of this.replies) if (now >= r.deadline) this.replies.delete(key);
    return this.replies.size;
  }

  /**
   * The card's instance is still this world's, the world still the same connection in the same place, and its notice
   * place still where the prompt is: else a reply there is not this world's to take (#2306 review — an instance that
   * moved to another world, a replaced connection, a new notice room).
   */
  private stillHere(p: { world: string; instance: string; adapter: ChannelAdapter; placeKey: string; chatId: string; threadId?: string }): boolean {
    if (this.ctx.ownerOf(p.instance) !== p.world) return false;
    const now = this.ctx.worlds().find(w => w.id === p.world);
    if (!now || now.adapter !== p.adapter || placeKey(now.place) !== p.placeKey) return false;
    const target = this.ctx.noticeTarget(p.world);
    return !!target && samePlace(target, { chatId: p.chatId, ...(p.threadId !== undefined ? { threadId: p.threadId } : {}) });
  }

  /** Post the prompt for a Send back's reason or an answer, and wait for the clicker's reply to it. */
  private async askForReply(entry: AckEntry, verb: "back" | "answer", by: TaskAction["by"], askKey: string): Promise<void> {
    const card = entry.card!;
    try {
      const world = this.ctx.worlds().find(w => w.id === entry.world);
      if (!world || this.stopped) return;
      const target = { world: entry.world, instance: entry.instance, adapter: world.adapter, placeKey: placeKey(world.place),
        chatId: entry.chatId, ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}) };
      const who = by.username ? ` (@${by.username})` : "";
      const text = this.ctx.t(verb === "back" ? "needs.task_back_prompt" : "needs.task_answer_prompt", card.code, who, Math.round(TASK_REPLY_TTL_MS / 60_000));
      const sent = await world.adapter.sendText(entry.chatId, text, entry.threadId !== undefined ? { threadId: entry.threadId } : undefined);
      // While it was on its way the fleet may have stopped, or the card's instance, the connection or the room moved.
      if (this.stopped || !this.stillHere(target)) return;
      const pending: PendingReply = {
        ...target, askKey, messageId: sent.messageId,
        userId: by.userId, ...(by.username ? { username: by.username } : {}), verb, code: card.code, version: card.version,
        deadline: this.ctx.mono() + TASK_REPLY_TTL_MS,
      };
      this.replies.set(`${entry.chatId}|${sent.messageId}`, pending);
    } catch (err) {
      this.ctx.log("warn", "Needs you: could not ask for a reply", { code: card.code, err: String((err as Error)?.message ?? err) });
    } finally {
      this.asking.delete(askKey);
    }
  }

  /**
   * An inbound message that replies to one of our Send back / Answer prompts, by the admin who clicked: its text is
   * the reason or the answer, and the message goes no further (true). Anything else — another message, another
   * person, a lapsed prompt — is not ours (false) and flows on as usual.
   */
  handleReply(msg: ReplyMessage): boolean {
    if (!msg.replyTo) return false;
    // #2306 review: found by where the prompt is, whichever bot received the reply (in a shared Discord guild a
    // sibling bot's copy may come first), and judged by the prompt's world — its admins, its instance, its connection
    // and room as they are now — so the answer is taken once, and only with that world's authority.
    const key = `${msg.chatId}|${msg.replyTo}`;
    const pending = this.replies.get(key);
    if (!pending) return false;
    if (this.ctx.mono() >= pending.deadline) { this.replies.delete(key); return false; }
    if (msg.userId !== pending.userId || (pending.threadId !== undefined && msg.threadId !== undefined && msg.threadId !== pending.threadId)) return false;
    if (!this.ctx.isFleetAdmin(msg.userId, pending.world)) return false;
    if (!this.stillHere(pending)) { this.replies.delete(key); return false; }
    this.replies.delete(key);
    const text = msg.text.trim();
    const world = this.ctx.worlds().find(w => w.id === pending.world);
    const platform = world?.place.type ?? "chat";
    const outcome = text
      ? this.ctx.taskAction?.({ verb: pending.verb, code: pending.code, version: pending.version, text,
        by: { platform, userId: msg.userId, ...(msg.username ? { username: msg.username } : {}) } }) ?? { ok: false, message: this.ctx.t("needs.task_board_closed") }
      : { ok: false, message: this.ctx.t("needs.task_reply_empty", pending.code) };
    this.poke();
    if (world) {
      void world.adapter.sendText(msg.chatId, outcome.message, { ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}), replyTo: msg.messageId })
        .catch(err => this.ctx.log("warn", "Needs you: could not answer a reply", { code: pending.code, err: String((err as Error)?.message ?? err) }));
    }
    return true;
  }

  /** The web's Acknowledge: any item (the web is global, §5.0). `principal` is "web:<session handle>" or "cli". */
  webAcknowledge(itemId: string, principal: string): { status: 200 | 400 | 404 | 409 | 500; message: string } {
    const m = /^delivery:([A-Za-z0-9._:-]{1,128})$/.exec(itemId);
    if (!m) return { status: 400, message: "Not an item that can be acknowledged" };
    const listed = this.items.some(i => i.id === itemId);
    if (!listed) return { status: 409, message: this.ctx.t("needs.ack_already") };
    const outcome = this.acknowledge(m[1], principal);
    return { status: outcome === "failed" ? 500 : 200, message: this.ctx.t(`needs.ack_${outcome}`) };
  }

  /** done: this call acknowledged it; already: acknowledged, delivered or gone meanwhile; failed: not recorded. */
  private acknowledge(deliveryId: string, by: string): "done" | "already" | "failed" {
    let done: boolean;
    try {
      done = this.ctx.acknowledge(deliveryId, by);
    } catch (err) {
      this.ctx.log("warn", "Needs you: could not record an acknowledgement", { deliveryId, err: String((err as Error)?.message ?? err) });
      return "failed";
    }
    this.poke();
    if (done) this.ctx.log("info", "Needs you: delivery acknowledged", { deliveryId, by });
    return done ? "done" : "already";
  }

  // ── DMs (§5.5) ─────────────────────────────────────────────────────────────────────────────────────────────

  private queueDms(world: NeedsYouWorld, mine: NeedsYouItem[], now: number): void {
    const seen = this.dmSeen.get(world.id) ?? new Set<string>();
    const due = mine.filter(i => !seen.has(i.id) && (i.type !== "awaiting_input" || now - i.since >= AWAITING_PING_MIN_MS));
    for (const i of due) seen.add(i.id);
    // Forget ids that are gone, so a recurrence (a new id anyway) is not confused with an old one.
    const listed = new Set(mine.map(i => i.id));
    for (const id of [...seen]) if (!listed.has(id)) seen.delete(id);
    this.dmSeen.set(world.id, seen);
    if (due.length === 0) return;
    const pending = this.dmPending.get(world.id) ?? new Set<string>();
    for (const i of due) pending.add(i.id);
    this.dmPending.set(world.id, pending);
    this.scheduleDms(world.id);
  }

  /** One timer per world; it sends at once when the minute since the last DM has passed. */
  private scheduleDms(worldId: string): void {
    if (this.dmTimer.has(worldId)) return;
    const last = this.dmLastAt.get(worldId) ?? -Infinity;
    const wait = Math.max(0, last + DM_MIN_MS - this.ctx.mono());
    this.dmTimer.set(worldId, this.ctx.setTimer(() => { this.dmTimer.delete(worldId); this.flushDms(worldId); }, wait));
  }

  private cancelDms(worldId: string): void {
    const timer = this.dmTimer.get(worldId);
    if (timer !== undefined) this.ctx.clearTimer(timer);
    this.dmTimer.delete(worldId);
    this.dmPending.delete(worldId);
  }

  /**
   * Send what is pending — re-resolved now (#1398 review): only items still listed AND still owned by this world, to
   * this world's admins as they are now, through its current adapter; nothing at all once DMs are off, the world is
   * gone, or the hub is stopped.
   */
  private flushDms(worldId: string): void {
    const ids = this.dmPending.get(worldId) ?? new Set<string>();
    this.dmPending.delete(worldId);
    if (this.stopped || ids.size === 0 || !this.ctx.settings().dm || this.ctx.stopping()) return;
    const world = this.ctx.worlds().find(w => w.id === worldId);
    if (!world || !world.adapter.sendDirect) return;
    // Owned by this world NOW — asked of the fleet per item, not taken from the last derivation (#1398 review r2).
    const still = this.items.filter(i => ids.has(i.id) && this.ctx.ownerOf(i.instance) === worldId);
    if (still.length === 0) return;
    this.dmLastAt.set(worldId, this.ctx.mono());
    // #1990: links only for an admin the platform confirms is in the group (a DM reader may not be); a browser URL
    // either way, since a DM is outside the guild a channel mention would resolve in.
    const asked = { adapter: world.adapter, placeKey: placeKey(world.place) };
    for (const admin of this.ctx.fleetAdmins(worldId)) {
      void this.membership.isMember(world.adapter, world.place.groupId ?? "", admin).then(member => {
        // The read took time: everything above is resolved again now (#1398 review), and the verdict counts only for
        // the same adapter and group it was asked of.
        if (this.stopped || this.ctx.stopping() || !this.ctx.settings().dm) return;
        const now = this.ctx.worlds().find(w => w.id === worldId);
        if (!now?.adapter.sendDirect || now.adapter !== asked.adapter || placeKey(now.place) !== asked.placeKey) return;
        if (!this.ctx.fleetAdmins(worldId).includes(admin)) return;
        const current = this.items.filter(i => ids.has(i.id) && this.ctx.ownerOf(i.instance) === worldId);
        if (current.length === 0) return;
        // Telegram: only an admin who has started the bot can be messaged; the send fails otherwise, and that is fine.
        return now.adapter.sendDirect(admin, this.dmText(current, now.place, member));
      }).catch(err => this.ctx.log("debug", "Needs you: DM not delivered", { world: worldId, err: String((err as Error)?.message ?? err) }));
    }
  }

  /** A DM's text: its items, with links (browser URLs) only when `linked`. */
  private dmText(items: readonly NeedsYouItem[], place: WorldPlace, linked: boolean): string {
    return [this.ctx.t("needs.dm_header", items.length), ...items.slice(0, 10).map(item => {
      const link = !linked ? undefined
        : item.promptAt ? messageLink(place, item.promptAt) : topicUrl(place, this.ctx.instanceTopic(item.instance));
      return `• ${item.instance} — ${this.lineTitle(item)}${link ? ` · ${link}` : ""}`;
    })].join("\n");
  }

  /** Shutdown: every live message says so, without buttons; no further renders or DMs. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pending !== null) this.ctx.clearTimer(this.pending);
    if (this.backstop !== null) this.ctx.clearTimer(this.backstop);
    for (const id of [...this.dmPending.keys(), ...this.dmTimer.keys()]) this.cancelDms(id);
    await Promise.all([...this.live.values()].map(p => p.renderer.retire()));
    this.acks.clear();
    this.replies.clear();
    this.asking.clear();
  }
}

