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

export interface WebChatMessage {
  /** Files shown with the message (absent when none). */
  attachments?: WebChatAttachment[];
  /** The fleet process generation the id belongs to. */
  boot: string;
  id: number;
  instance: string;
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
  record(msg: { instance: string; sender: string; text: string; ts: string; attachments?: WebChatAttachment[] }): WebChatMessage {
    const entry: WebChatMessage = {
      boot: this.boot,
      id: this.nextId++,
      instance: String(msg.instance),
      sender: String(msg.sender),
      text: String(msg.text ?? "").slice(0, WEB_CHAT_TEXT_MAX),
      ts: String(msg.ts),
      ...(msg.attachments && msg.attachments.length ? { attachments: msg.attachments.slice(0, 20).map(a => ({ id: a.id, kind: a.kind, name: a.name, size: a.size, mime: a.mime })) } : {}),
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
