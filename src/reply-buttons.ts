/**
 * #1266: buttons on an agent's reply — the same choice in the web chat, on Telegram (inline keyboard) and on Discord
 * (message components). Design: https://github.com/songsid/AgEnD/issues/1266#issuecomment-6082375631
 *
 * - A reply's `buttons` are checked here before anything is sent (the reply tool's arguments are not validated by
 *   the MCP schema at run time).
 * - Each button set is one row of a small SQLite store, so it outlives a restart. The platform sees only
 *   `rb:<32 hex>:<index>`; the labels and values stay here.
 * - A click is consumed once for the whole set (`UPDATE … WHERE consumed_at IS NULL`), only on the exact message the
 *   set was delivered on, and only before it expires: a replayed or late click changes nothing.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export const REPLY_BUTTONS_MAX = 10;
/** Discord's limit per label (the strictest of the three); counted in UTF-16 units, as Discord counts. */
export const REPLY_BUTTON_LABEL_MAX = 80;
export const REPLY_BUTTON_VALUE_MAX = 200;
export const REPLY_BUTTON_TTL_MS = 24 * 60 * 60 * 1000;
export const REPLY_BUTTON_PREFIX = "rb:";

export interface ReplyButton { label: string; value: string }

/**
 * The reply's `buttons`, checked: null when there are none, `{ error }` when they cannot be sent as given.
 * Labels are plain text on every surface; a newline or control character is refused rather than rewritten.
 */
export function parseReplyButtons(raw: unknown, args: { text?: unknown; stickers?: unknown }): { buttons: ReplyButton[] } | { error: string } | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return { error: "buttons must be a list of { label, value? }" };
  if (raw.length === 0) return null;
  if (raw.length > REPLY_BUTTONS_MAX) return { error: `at most ${REPLY_BUTTONS_MAX} buttons on one reply (${raw.length} given)` };
  if (typeof args.text !== "string" || !args.text.trim()) return { error: "buttons need text: they sit on the reply's message" };
  if (Array.isArray(args.stickers) && args.stickers.length) return { error: "buttons and stickers cannot go on one reply: send the stickers in another reply" };
  const out: ReplyButton[] = [];
  const seen = new Set<string>();
  for (const [i, b] of raw.entries()) {
    if (!b || typeof b !== "object" || Array.isArray(b)) return { error: `buttons[${i}] must be { label, value? }` };
    const { label, value } = b as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim()) return { error: `buttons[${i}].label must be non-empty text` };
    if (label.length > REPLY_BUTTON_LABEL_MAX) return { error: `buttons[${i}].label is ${label.length} characters; at most ${REPLY_BUTTON_LABEL_MAX}` };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(label)) return { error: `buttons[${i}].label must be one line of text` };
    if (value !== undefined && typeof value !== "string") return { error: `buttons[${i}].value must be text` };
    if (typeof value === "string" && value.length > REPLY_BUTTON_VALUE_MAX) return { error: `buttons[${i}].value is ${value.length} characters; at most ${REPLY_BUTTON_VALUE_MAX}` };
    const trimmed = label.trim();
    if (seen.has(trimmed)) return { error: `buttons[${i}].label "${trimmed}" is used twice` };
    seen.add(trimmed);
    out.push({ label: trimmed, value: typeof value === "string" && value !== "" ? value : trimmed });
  }
  return { buttons: out };
}

export function newReplyButtonsId(): string { return randomBytes(16).toString("hex"); }
/** What a platform carries for one button: an unguessable set id and the button's index — never its label or value. */
export function replyButtonCallback(id: string, index: number): string { return `${REPLY_BUTTON_PREFIX}${id}:${index}`; }
export function parseReplyButtonCallback(data: string): { id: string; index: number } | null {
  const m = /^rb:([0-9a-f]{32}):(\d{1,2})$/.exec(data);
  if (!m) return null;
  const index = Number(m[2]);
  return index < REPLY_BUTTONS_MAX ? { id: m[1]!, index } : null;
}

/** The message the agent receives for a click: an ordinary inbound line, marked as a button. */
export function replyButtonClickText(b: ReplyButton): string {
  return b.value === b.label ? `[button] ${b.label}` : `[button] ${b.label} (value: ${b.value})`;
}

/** Where buttons cannot be shown: the choices as text, so the question can still be answered by writing back. */
export function replyButtonsFallbackText(buttons: readonly ReplyButton[]): string {
  return `Options: ${buttons.map((b, i) => `${i + 1}) ${b.label}`).join("  ")} — reply with your choice.`;
}

/**
 * Is a platform click on this set's own message? Same adapter, same message id, and the click's chat or thread is the
 * set's chat or thread (Discord reports a click as guild + channel, Telegram as chat + topic; a reply recorded its
 * chat_id and thread). A callback copied onto another message, or replayed from another chat, is not.
 */
export function replyButtonsClickPlace(set: ReplyButtonSet, at: { adapterId: string; chatId: string; threadId?: string; messageId: string }): boolean {
  if (set.messageId === null || at.adapterId !== set.adapterId || at.messageId !== set.messageId) return false;
  const places = [set.chatId, set.threadId].filter(Boolean);
  return [at.chatId, at.threadId].some(v => !!v && places.includes(v));
}

export interface ReplyButtonSet {
  id: string;
  instance: string;
  /** The world (adapter id) it was sent through, or "web" on a web-only fleet. */
  adapterId: string;
  chatId: string;
  threadId: string;
  /** The platform message carrying the buttons; null while the send is in flight. */
  messageId: string | null;
  buttons: ReplyButton[];
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  chosenIndex: number | null;
  chosenBy: string | null;
  /** Set when the platform message was updated to its final state (chosen / expired). */
  settledAt: number | null;
}

export type ConsumeResult =
  | { ok: true; set: ReplyButtonSet; button: ReplyButton }
  | { ok: false; reason: "missing" | "pending" | "used" | "expired"; set?: ReplyButtonSet };

interface Row {
  id: string; instance: string; adapter_id: string; chat_id: string; thread_id: string; message_id: string | null;
  buttons: string; created_at: number; expires_at: number; consumed_at: number | null; chosen_index: number | null;
  chosen_by: string | null; settled_at: number | null;
}
const fromRow = (r: Row): ReplyButtonSet => ({
  id: r.id, instance: r.instance, adapterId: r.adapter_id, chatId: r.chat_id, threadId: r.thread_id, messageId: r.message_id,
  buttons: JSON.parse(r.buttons) as ReplyButton[], createdAt: r.created_at, expiresAt: r.expires_at, consumedAt: r.consumed_at,
  chosenIndex: r.chosen_index, chosenBy: r.chosen_by, settledAt: r.settled_at,
});

/** The button sets, in `<dataDir>/reply-buttons.db`. Wall-clock instants: an expiry is a calendar time that must hold across restarts. */
export class ReplyButtonStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reply_buttons (
        id TEXT PRIMARY KEY,
        instance TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        message_id TEXT,
        buttons TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        chosen_index INTEGER,
        chosen_by TEXT,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reply_buttons_open ON reply_buttons(settled_at, expires_at);
    `);
  }
  close(): void { this.db.close(); }

  /** Before the send: the set exists, unbound (a click cannot match it until the platform message is known). */
  create(set: Pick<ReplyButtonSet, "id" | "instance" | "adapterId" | "chatId" | "threadId" | "buttons">, now: number): ReplyButtonSet {
    this.db.prepare(`INSERT INTO reply_buttons (id, instance, adapter_id, chat_id, thread_id, buttons, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(set.id, set.instance, set.adapterId, set.chatId, set.threadId ?? "", JSON.stringify(set.buttons), now, now + REPLY_BUTTON_TTL_MS);
    return this.get(set.id)!;
  }
  /** After the send: the message the buttons are on. Only an unbound set can be bound. */
  bind(id: string, messageId: string): boolean {
    return this.db.prepare("UPDATE reply_buttons SET message_id = ? WHERE id = ? AND message_id IS NULL").run(messageId, id).changes === 1;
  }
  /** A send that failed: the set never existed for anyone. */
  remove(id: string): void { this.db.prepare("DELETE FROM reply_buttons WHERE id = ?").run(id); }
  get(id: string): ReplyButtonSet | null {
    const r = this.db.prepare("SELECT * FROM reply_buttons WHERE id = ?").get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /**
   * One click, already placed on this set's message by the caller (replyButtonsClickPlace). The first permitted click
   * consumes the whole set, atomically: of two clicks racing here only one changes the row.
   */
  consume(id: string, index: number, by: string, now: number): ConsumeResult {
    const set = this.get(id);
    if (!set) return { ok: false, reason: "missing" };
    if (set.messageId === null) return { ok: false, reason: "pending", set };
    if (set.consumedAt !== null) return { ok: false, reason: "used", set };
    if (now >= set.expiresAt) return { ok: false, reason: "expired", set };
    const button = set.buttons[index];
    if (!button) return { ok: false, reason: "missing", set };
    const won = this.db.prepare(`UPDATE reply_buttons SET consumed_at = ?, chosen_index = ?, chosen_by = ?
      WHERE id = ? AND consumed_at IS NULL AND message_id IS NOT NULL AND expires_at > ?`).run(now, index, by, id, now).changes === 1;
    const after = this.get(id)!;
    return won ? { ok: true, set: after, button } : { ok: false, reason: after.consumedAt !== null ? "used" : "expired", set: after };
  }
  /** A consumed click that could not reach the agent: the set is open again (only that click's own claim is undone). */
  release(id: string, consumedAt: number): void {
    this.db.prepare(`UPDATE reply_buttons SET consumed_at = NULL, chosen_index = NULL, chosen_by = NULL
      WHERE id = ? AND consumed_at = ? AND settled_at IS NULL`).run(id, consumedAt);
  }
  /** The platform message shows the final state now (chosen or expired). */
  markSettled(id: string, now: number): void { this.db.prepare("UPDATE reply_buttons SET settled_at = ? WHERE id = ? AND settled_at IS NULL").run(now, id); }
  /** Sets that ended (chosen or expired) and whose message does not show it yet: what a sweep or a restart finishes. */
  unsettled(now: number): ReplyButtonSet[] {
    return (this.db.prepare(`SELECT * FROM reply_buttons WHERE settled_at IS NULL AND message_id IS NOT NULL
      AND (consumed_at IS NOT NULL OR expires_at <= ?)`).all(now) as Row[]).map(fromRow);
  }
  /** The next expiry still to come, for the one sweep timer. */
  nextExpiry(now: number): number | null {
    const r = this.db.prepare(`SELECT MIN(expires_at) AS t FROM reply_buttons WHERE settled_at IS NULL AND consumed_at IS NULL
      AND message_id IS NOT NULL AND expires_at > ?`).get(now) as { t: number | null };
    return r.t ?? null;
  }
  /** Sets on these messages, for the web chat's view of a reply's buttons. */
  forMessages(instance: string, messageIds: readonly string[]): ReplyButtonSet[] {
    if (!messageIds.length) return [];
    const rows = this.db.prepare(`SELECT * FROM reply_buttons WHERE instance = ? AND message_id IN (${messageIds.map(() => "?").join(",")})`)
      .all(instance, ...messageIds) as Row[];
    return rows.map(fromRow);
  }
  /** Settled sets older than `before` are history the store no longer needs. */
  prune(before: number): number {
    return this.db.prepare("DELETE FROM reply_buttons WHERE settled_at IS NOT NULL AND settled_at < ?").run(before).changes;
  }
}
