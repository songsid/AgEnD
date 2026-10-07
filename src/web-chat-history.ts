/**
 * What the web chat has said, kept so that a reload — or a dropped SSE stream — does not leave the chat empty.
 *
 * The browser used to hold the only copy (500 messages per instance, in memory): a reload showed nothing, and a
 * stream that reconnected silently lost whatever was said while it was down. Now every chat message the fleet
 * pushes over SSE is recorded here with a monotonically increasing id: `/ui/history` serves the recent messages
 * of one instance, and an EventSource that reconnects with `Last-Event-ID` is sent what it missed.
 *
 * Bounded by count AND by bytes per instance, so a chatty agent cannot grow the fleet process without limit.
 * In memory only: it survives a page reload, not a fleet restart (persisting chat text is a separate decision).
 *
 * Ids count from 1 in every fleet process, so an id alone is not an identity across a restart: each history
 * has a random `boot` generation, every message carries it, and the SSE cursor is `<boot>-<id>`. A cursor
 * from another boot is not compared with this boot's ids at all — that client gets this boot's backlog.
 */
import { randomBytes } from "node:crypto";

/** A file shown with a message: an id the dashboard can fetch, never a path. */
export interface WebChatAttachment { id: string; kind: "photo" | "document"; name: string; size: number; mime: string }

/**
 * How far a message the web user sent has got (web track C3) — the ticks under it. The same lifecycle a
 * Telegram message shows as reactions: waiting behind another message, handed to the agent, taken up by it,
 * or not delivered; and `cancelled` when a Stop dropped it while it was still waiting.
 */
export type WebDeliveryState = "queued" | "processing" | "delivered" | "failed" | "cancelled";

/**
 * Ranks for the order a message moves through. Events can arrive late or twice (a queued after the spawn
 * settles, a retry): a tick never moves back. `delivered` and `failed` are final; `cancelled` is not, since
 * a Stop races a delivery already under way — what the agent actually got wins.
 */
const DELIVERY_RANK: Record<WebDeliveryState, number> = { queued: 1, processing: 2, cancelled: 3, delivered: 4, failed: 4 };

/** The state after `next` arrives at a message in `prev`; `prev` itself when `next` would move it back. */
export function nextDeliveryState(prev: WebDeliveryState | undefined, next: WebDeliveryState): WebDeliveryState | undefined {
  // Own keys only: "__proto__" or "constructor" is in every object, and is no state.
  if (!Object.hasOwn(DELIVERY_RANK, next)) return prev;
  if (prev === undefined || !Object.hasOwn(DELIVERY_RANK, prev)) return next;
  return DELIVERY_RANK[next] > DELIVERY_RANK[prev] ? next : prev;
}

export type WebChatRole = "agent" | "user" | "status";
const ROLES: ReadonlySet<string> = new Set(["agent", "user", "status"]);

export interface WebChatMessage {
  /** Files shown with the message (absent when none). */
  attachments?: WebChatAttachment[];
  /** The fleet process generation the id belongs to. */
  boot: string;
  /** Where a web user's message has got (absent: nothing reported yet, or not the web user's). */
  delivery?: WebDeliveryState;
  id: number;
  instance: string;
  /** The `message_id` the agent was given for a web user's message — what delivery reports name it by. */
  messageId?: string;
  /**
   * Who the server says wrote it (#1306), set by the code path that emitted it — never read from the text or the
   * sender name: `agent` (a delivered reply), `user` (a person, on any surface; the default), `status` (a daemon
   * status line on a web-only fleet). Only `agent` messages may get HTML preview cards.
   */
  role: WebChatRole;
  sender: string;
  text: string;
  ts: string;
}

export interface WebChatHistoryOptions {
  /** Messages kept per instance. */
  perInstance?: number;
  /** Bytes of text kept per instance (UTF-16 length × 2 is close enough for a bound). */
  perInstanceChars?: number;
  /** Most messages one SSE reconnect is sent. */
  replayMax?: number;
  /** The generation id (tests); random otherwise. */
  boot?: string;
}

export const WEB_CHAT_TEXT_MAX = 16_000;

/**
 * The `message_id` a message from the web chat is delivered under. Unique (two sends in one millisecond used
 * to share `web-<ms>`), and never a platform id: Telegram and Discord ids are digits only.
 */
export function newWebMessageId(): string {
  return `web-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Whether a delivery report is about a message from the web chat rather than one on a platform. */
export function isWebMessageId(messageId: string): boolean {
  return messageId.startsWith("web-");
}

export class WebChatHistory {
  private nextId = 1;
  /** This process's generation: ids are only unique within it. */
  readonly boot: string;
  private readonly byInstance = new Map<string, { messages: WebChatMessage[]; chars: number }>();
  private readonly perInstance: number;
  private readonly perInstanceChars: number;
  private readonly replayMax: number;

  constructor(opts: WebChatHistoryOptions = {}) {
    this.perInstance = opts.perInstance ?? 500;
    this.perInstanceChars = opts.perInstanceChars ?? 1_000_000;
    this.replayMax = opts.replayMax ?? 500;
    this.boot = opts.boot ?? randomBytes(6).toString("hex");
  }

  /** The id the next message will get minus one: the newest id handed out so far (0 when none). */
  get lastId(): number { return this.nextId - 1; }

  /** Record one message; returns it with its id. Text beyond WEB_CHAT_TEXT_MAX is cut. */
  record(msg: { instance: string; sender: string; text: string; ts: string; attachments?: WebChatAttachment[]; messageId?: string; role?: string }): WebChatMessage {
    const entry: WebChatMessage = {
      boot: this.boot,
      id: this.nextId++,
      instance: String(msg.instance),
      // Anything not one of the three — or absent — is a person's message.
      role: typeof msg.role === "string" && ROLES.has(msg.role) ? msg.role as WebChatRole : "user",
      sender: String(msg.sender),
      text: String(msg.text ?? "").slice(0, WEB_CHAT_TEXT_MAX),
      ts: String(msg.ts),
      ...(msg.attachments && msg.attachments.length ? { attachments: msg.attachments.slice(0, 20).map(a => ({ id: a.id, kind: a.kind, name: a.name, size: a.size, mime: a.mime })) } : {}),
      ...(typeof msg.messageId === "string" && msg.messageId ? { messageId: msg.messageId.slice(0, 64) } : {}),
    };
    let slot = this.byInstance.get(entry.instance);
    if (!slot) { slot = { messages: [], chars: 0 }; this.byInstance.set(entry.instance, slot); }
    slot.messages.push(entry);
    slot.chars += entry.text.length;
    while (slot.messages.length > 1 && (slot.messages.length > this.perInstance || slot.chars > this.perInstanceChars)) {
      slot.chars -= slot.messages.shift()!.text.length;
    }
    return entry;
  }

  /** The most recent `limit` messages of one instance, oldest first. */
  list(instance: string, limit = this.perInstance): WebChatMessage[] {
    const slot = this.byInstance.get(instance);
    if (!slot) return [];
    const n = Math.max(0, Math.min(Math.floor(limit), this.perInstance));
    return n === 0 ? [] : slot.messages.slice(-n);
  }

  /**
   * Every message newer than `lastId`, across instances, oldest first, at most `replayMax` (the newest ones).
   * Ids are this boot's: a cursor from another boot goes through replayFor(), never straight here.
   */
  after(lastId: number): WebChatMessage[] {
    if (!Number.isFinite(lastId) || lastId < 0) return [];
    const out: WebChatMessage[] = [];
    for (const slot of this.byInstance.values()) {
      for (const m of slot.messages) if (m.id > lastId) out.push(m);
    }
    out.sort((a, b) => a.id - b.id);
    return out.length > this.replayMax ? out.slice(-this.replayMax) : out;
  }

  /**
   * A delivery report for one of this instance's messages. Returns the message when its state changed (so the
   * caller tells the pages), null when there is no such message or the report would move it back.
   */
  setDelivery(instance: string, messageId: string, state: WebDeliveryState): WebChatMessage | null {
    const messages = this.byInstance.get(instance)?.messages ?? [];
    let m: WebChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0 && !m; i--) if (messages[i]!.messageId === messageId) m = messages[i];
    if (!m) return null;
    const next = nextDeliveryState(m.delivery, state);
    if (next === m.delivery) return null;
    m.delivery = next;
    return m;
  }

  /**
   * A Stop on this instance: the web user's messages still waiting (nothing reported, or queued) were dropped
   * from the queue. The queue is first in, first out, so nothing older than a message that got further can
   * still be waiting: the walk goes back from the newest and stops there. Returns the messages it changed.
   */
  /**
   * Where every retained web message got — the ticks — in one list. A delivery report has no cursor of its own and
   * changes a message already sent, so a page that missed one (a dropped stream, a poll) catches up from this:
   * the stream sends it on every (re)connect and each poll carries it (#1253 review). Ticks only move forward on
   * the page, so receiving it twice changes nothing.
   */
  deliveries(): Array<{ instance: string; messageId: string; delivery: WebDeliveryState }> {
    const out: Array<{ instance: string; messageId: string; delivery: WebDeliveryState }> = [];
    for (const [instance, slot] of this.byInstance) {
      for (const m of slot.messages) if (m.messageId !== undefined && m.delivery !== undefined) out.push({ instance, messageId: m.messageId, delivery: m.delivery });
    }
    return out;
  }

  cancelPending(instance: string): WebChatMessage[] {
    const changed: WebChatMessage[] = [];
    const messages = this.byInstance.get(instance)?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.messageId === undefined) continue;
      if (m.delivery !== undefined && m.delivery !== "queued") break;
      m.delivery = "cancelled";
      changed.push(m);
    }
    return changed.reverse();
  }

  /** Forget an instance (deleted). */
  forget(instance: string): void { this.byInstance.delete(instance); }

  /** The SSE cursor for one message: `<boot>-<id>`. */
  cursorOf(m: WebChatMessage): string { return `${m.boot}-${m.id}`; }

  /**
   * What a reconnecting stream with this `Last-Event-ID` should be sent. A cursor of this boot replays what
   * came after it; a cursor of another boot (the fleet restarted) gets this boot's whole retained backlog,
   * since none of it can have been seen; no cursor, or one that is not ours in shape, gets nothing.
   */
  replayFor(cursor: { boot: string; id: number } | null): WebChatMessage[] {
    if (!cursor) return [];
    return cursor.boot === this.boot ? this.after(cursor.id) : this.after(0);
  }
}

/** `Last-Event-ID` as `<boot>-<id>`, or null when absent or not that shape. */
export function parseLastEventId(header: string | string[] | undefined): { boot: string; id: number } | null {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim();
  const m = raw === undefined ? null : /^([0-9a-f]{1,32})-(\d{1,15})$/.exec(raw);
  return m ? { boot: m[1]!, id: Number(m[2]) } : null;
}
