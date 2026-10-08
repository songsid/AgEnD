/**
 * #1386: the fleet side of "Needs you". One derivation (needs-you.ts), recomputed on change, rendered to:
 * - each world's live message in its General and, optionally, its admins' DMs — only that world's items (§5.0, §5);
 * - the web, globally: SSE `needs` and a `needs` field on /ui/poll (§6).
 * Plus Acknowledge for delivery items, from a world's live message (its admins, its items) or from the web (any).
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
import {
  deriveNeedsYou, itemsForWorld, renderLiveMessage, renderSignature, messageLink, instanceLink,
  type DeliveryInput, type InstanceInput, type NeedsYouItem, type PromptInput, type WorldPlace,
} from "./needs-you.js";
import { NeedsYouLiveMessage, canonicalTarget, type LiveAcks, type LivePointer, type LiveTarget } from "./needs-you-live.js";

export const NEEDS_ACK_PREFIX = "needs-ack:";
const ACK_RE = /^needs-ack:([0-9a-f]{32}):ack$/;
const BACKSTOP_MS = 10_000;
const ATTENTION_WINDOW_MS = 24 * 60 * 60_000;
/** awaiting_input pings (DM, browser) only once it has lasted this long; the list itself is never delayed (§6.3). */
export const AWAITING_PING_MIN_MS = 5_000;
const DM_MIN_MS = 60_000;

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
  settings(): { liveMessage: boolean; dm: boolean };
  stopping(): boolean;
  t(key: string, ...args: Array<string | number>): string;
  log(level: "info" | "warn" | "debug", message: string, extra?: Record<string, unknown>): void;
}

interface AckEntry {
  world: string;
  generation: number;
  chatId: string;
  threadId?: string;
  messageId?: string;
  deliveryId: string;
  instance: string;
}

export interface AckCallback {
  callbackData: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId?: string;
  ack?(notice?: string): void;
}

/** What the web receives: the items without their chat coordinates. */
export type WebNeedsItem = Omit<NeedsYouItem, "promptAt">;

export class NeedsYouHub {
  private items: NeedsYouItem[] = [];
  private webSignature = "";
  private readonly worldSignature = new Map<string, string>();
  private readonly worldSeen = new Map<string, Set<string>>();
  private readonly live = new Map<string, NeedsYouLiveMessage>();
  private readonly acks = new Map<string, AckEntry>();
  private readonly dmSeen = new Map<string, Set<string>>();
  private readonly dmLastAt = new Map<string, number>();
  private readonly dmPending = new Map<string, NeedsYouItem[]>();
  private pending: unknown = null;
  private backstop: unknown = null;
  private stopped = false;
  /** The first computation after start: what waits then is not news (a restart edits, it does not post or DM). */
  private seeded = false;

  constructor(private readonly ctx: NeedsYouHubContext) {}

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
    let deliveries: DeliveryInput[] = [];
    try {
      deliveries = this.ctx.deliveries(new Date(now - ATTENTION_WINDOW_MS).toISOString());
    } catch (err) {
      this.ctx.log("warn", "Needs you: could not read the delivery outbox", { err: String((err as Error)?.message ?? err) });
    }
    this.items = deriveNeedsYou({ prompts: this.ctx.prompts(), instances: this.ctx.instances(), deliveries, ownerOf: i => this.ctx.ownerOf(i) });

    const webSig = renderSignature(this.items, now);
    if (webSig !== this.webSignature) {
      this.webSignature = webSig;
      this.ctx.emitSse("needs", { items: this.webItems() });
    }

    const settings = this.ctx.settings();
    const worlds = this.ctx.worlds();
    const worldIds = new Set(worlds.map(w => w.id));
    for (const [id, renderer] of this.live) {
      if (!settings.liveMessage || !worldIds.has(id)) { this.live.delete(id); void renderer.disable(); this.worldSignature.delete(id); }
    }
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
        let renderer = this.live.get(world.id);
        if (!renderer) { renderer = this.makeLive(world); this.live.set(world.id, renderer); }
        const sig = renderSignature(mine, now);
        if (sig !== this.worldSignature.get(world.id)) {
          this.worldSignature.set(world.id, sig);
          renderer.changed(fresh.length > 0);
        }
      }
      if (settings.dm) this.queueDms(world, mine, fresh, now);
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

  private lineTitle(item: NeedsYouItem): string { return this.ctx.t(`needs.reason.${item.reason}`); }

  private makeLive(world: NeedsYouWorld): NeedsYouLiveMessage {
    const ctx = this.ctx;
    return new NeedsYouLiveMessage({
      world: world.id,
      now: () => ctx.mono(),
      setTimer: (fn, ms) => ctx.setTimer(fn, ms),
      clearTimer: h => ctx.clearTimer(h),
      target: () => { const t = ctx.noticeTarget(world.id); return t ? canonicalTarget(t) : null; },
      enabled: () => ctx.settings().liveMessage,
      stopping: () => ctx.stopping() || this.stopped,
      worldExists: () => ctx.worlds().some(w => w.id === world.id),
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
      remove: async pointer => { await world.adapter.deleteMessage?.(pointer.chatId, pointer.messageId, pointer.threadId); },
      loadPointer: () => this.readPointers()[world.id] ?? null,
      savePointer: pointer => this.writePointer(world.id, pointer),
      mintAcks: (generation, place, items) => this.mintAcks(world.id, generation, place, items),
      revokeAcks: () => this.revokeAcks(world.id),
      log: (message, extra) => ctx.log("info", `Needs you: ${message}`, extra),
      text: { stopped: ctx.t("needs.live_stopped"), off: ctx.t("needs.live_off") },
    });
  }

  private mintAcks(world: string, generation: number, place: LiveTarget & { messageId?: string }, items: NeedsYouItem[]): LiveAcks {
    const minted: AckEntry[] = [];
    const choices = items.filter(i => i.deliveryId).map(item => {
      const nonce = randomBytes(16).toString("hex");
      const entry: AckEntry = {
        world, generation, chatId: place.chatId, ...(place.threadId !== undefined ? { threadId: place.threadId } : {}),
        ...(place.messageId ? { messageId: place.messageId } : {}), deliveryId: item.deliveryId!, instance: item.instance,
      };
      this.acks.set(nonce, entry);
      minted.push(entry);
      return { id: `${NEEDS_ACK_PREFIX}${nonce}:ack`, label: this.ctx.t("needs.ack_button", item.instance) };
    });
    return { choices, bind: pointer => { for (const e of minted) e.messageId = pointer.messageId; } };
  }

  private revokeAcks(world: string): void {
    for (const [nonce, e] of this.acks) if (e.world === world) this.acks.delete(nonce);
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
    const entry = m ? this.acks.get(m[1]) : undefined;
    if (!m || !entry) { data.ack?.(this.ctx.t("needs.ack_stale")); return true; }
    const wrongPlace = entry.world !== adapterId || entry.chatId !== data.chatId
      || (entry.threadId !== undefined && data.threadId !== entry.threadId)
      || (entry.messageId !== undefined && data.messageId !== entry.messageId);
    if (wrongPlace) { data.ack?.(this.ctx.t("buttons.wrong_place")); return true; }
    if (!data.userId || !this.ctx.isFleetAdmin(data.userId, adapterId)) { data.ack?.(this.ctx.t("buttons.admin_only")); return true; }
    // §5.0: the item must still belong to this world.
    if (this.ctx.ownerOf(entry.instance) !== adapterId) { data.ack?.(this.ctx.t("needs.ack_not_this_world")); return true; }
    const platform = this.ctx.worlds().find(w => w.id === adapterId)?.place.type ?? "chat";
    data.ack?.(this.ctx.t(`needs.ack_${this.acknowledge(entry.deliveryId, `${platform}:${data.userId}`)}`));
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

  private queueDms(world: NeedsYouWorld, mine: NeedsYouItem[], _fresh: NeedsYouItem[], now: number): void {
    const seen = this.dmSeen.get(world.id) ?? new Set<string>();
    const due = mine.filter(i => !seen.has(i.id) && (i.type !== "awaiting_input" || now - i.since >= AWAITING_PING_MIN_MS));
    for (const i of due) seen.add(i.id);
    // Forget ids that are gone, so a recurrence (a new id anyway) is not confused with an old one.
    const live = new Set(mine.map(i => i.id));
    for (const id of [...seen]) if (!live.has(id)) seen.delete(id);
    this.dmSeen.set(world.id, seen);
    if (due.length === 0) return;
    this.dmPending.set(world.id, [...(this.dmPending.get(world.id) ?? []), ...due]);
    this.flushDms(world);
  }

  private flushDms(world: NeedsYouWorld): void {
    const pending = this.dmPending.get(world.id) ?? [];
    if (pending.length === 0) return;
    const at = this.ctx.mono();
    const last = this.dmLastAt.get(world.id) ?? -Infinity;
    if (at - last < DM_MIN_MS) {
      this.ctx.setTimer(() => this.flushDms(world), DM_MIN_MS - (at - last));
      return;
    }
    // Only what still waits.
    const still = pending.filter(p => this.items.some(i => i.id === p.id));
    this.dmPending.set(world.id, []);
    if (still.length === 0 || !world.adapter.sendDirect) return;
    this.dmLastAt.set(world.id, at);
    const text = [this.ctx.t("needs.dm_header", still.length), ...still.slice(0, 10).map(item => {
      const link = item.promptAt ? messageLink(world.place, item.promptAt) : instanceLink(world.place, this.ctx.instanceTopic(item.instance));
      return `• ${item.instance} — ${this.lineTitle(item)}${link ? ` · ${link}` : ""}`;
    })].join("\n");
    for (const admin of this.ctx.fleetAdmins(world.id)) {
      // Telegram: only an admin who has started the bot can be messaged; the send fails otherwise, and that is fine.
      world.adapter.sendDirect(admin, text).catch(err => this.ctx.log("debug", "Needs you: DM not delivered", { world: world.id, err: String((err as Error)?.message ?? err) }));
    }
  }

  /** Shutdown: every live message says so, without buttons; no further renders or DMs. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pending !== null) this.ctx.clearTimer(this.pending);
    if (this.backstop !== null) this.ctx.clearTimer(this.backstop);
    await Promise.all([...this.live.values()].map(r => r.retire()));
    this.acks.clear();
  }
}

