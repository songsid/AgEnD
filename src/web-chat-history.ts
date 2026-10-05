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
 */

export interface WebChatMessage {
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
}

export const WEB_CHAT_TEXT_MAX = 16_000;

export class WebChatHistory {
  private nextId = 1;
  private readonly byInstance = new Map<string, { messages: WebChatMessage[]; chars: number }>();
  private readonly perInstance: number;
  private readonly perInstanceChars: number;
  private readonly replayMax: number;

  constructor(opts: WebChatHistoryOptions = {}) {
    this.perInstance = opts.perInstance ?? 500;
    this.perInstanceChars = opts.perInstanceChars ?? 1_000_000;
    this.replayMax = opts.replayMax ?? 500;
  }

  /** The id the next message will get minus one: the newest id handed out so far (0 when none). */
  get lastId(): number { return this.nextId - 1; }

  /** Record one message; returns it with its id. Text beyond WEB_CHAT_TEXT_MAX is cut. */
  record(msg: { instance: string; sender: string; text: string; ts: string }): WebChatMessage {
    const entry: WebChatMessage = {
      id: this.nextId++,
      instance: String(msg.instance),
      sender: String(msg.sender),
      text: String(msg.text ?? "").slice(0, WEB_CHAT_TEXT_MAX),
      ts: String(msg.ts),
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
   * An id from before a fleet restart (larger than anything handed out since) gets nothing: the ids restarted.
   */
  after(lastId: number): WebChatMessage[] {
    if (!Number.isFinite(lastId) || lastId < 0 || lastId >= this.nextId) return [];
    const out: WebChatMessage[] = [];
    for (const slot of this.byInstance.values()) {
      for (const m of slot.messages) if (m.id > lastId) out.push(m);
    }
    out.sort((a, b) => a.id - b.id);
    return out.length > this.replayMax ? out.slice(-this.replayMax) : out;
  }

  /** Forget an instance (deleted). */
  forget(instance: string): void { this.byInstance.delete(instance); }
}

/** `Last-Event-ID` as a non-negative integer, or null when absent or not one. */
export function parseLastEventId(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || !/^\d{1,15}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}
