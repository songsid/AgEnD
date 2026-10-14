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
import { nextBallot, type PollBallot, type PollConfig } from "./reply-polls.js";

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
  /**
   * When the agent was given the choice (#1500 review). A claim (consumedAt) is not a choice until then: only a
   * delivered one is shown as chosen; one that cannot be delivered is released.
   */
  deliveredAt: number | null;
  /** Set when the platform message was updated to its final state (chosen / expired). */
  settledAt: number | null;
  /**
   * #1823: a poll — everyone may vote until `expiresAt` (its deadline; `createdAt` is when it opened). Null: ordinary
   * buttons, the first click answers for everyone.
   */
  poll: PollConfig | null;
  /** #1823: when the poll stopped taking votes (at or after its deadline). */
  closedAt: number | null;
  /** #1823: when the results were handed to the delivery outbox (idempotent per poll: the agent gets them once). */
  resultsAt: number | null;
}

/** #1823: one click on a poll. */
export type VoteResult =
  | { ok: true; set: ReplyButtonSet; options: number[]; changed: boolean }
  | { ok: false; reason: "missing" | "pending" | "closed"; set?: ReplyButtonSet };

export type ConsumeResult =
  | { ok: true; set: ReplyButtonSet; button: ReplyButton }
  | { ok: false; reason: "missing" | "pending" | "used" | "expired"; set?: ReplyButtonSet };

interface Row {
  id: string; instance: string; adapter_id: string; chat_id: string; thread_id: string; message_id: string | null;
  buttons: string; created_at: number; expires_at: number; consumed_at: number | null; chosen_index: number | null;
  chosen_by: string | null; settled_at: number | null; delivered_at: number | null;
  poll: string | null; closed_at: number | null; results_at: number | null;
}
const fromRow = (r: Row): ReplyButtonSet => ({
  id: r.id, instance: r.instance, adapterId: r.adapter_id, chatId: r.chat_id, threadId: r.thread_id, messageId: r.message_id,
  buttons: JSON.parse(r.buttons) as ReplyButton[], createdAt: r.created_at, expiresAt: r.expires_at, consumedAt: r.consumed_at,
  chosenIndex: r.chosen_index, chosenBy: r.chosen_by, deliveredAt: r.delivered_at ?? null, settledAt: r.settled_at,
  poll: r.poll ? JSON.parse(r.poll) as PollConfig : null, closedAt: r.closed_at ?? null, resultsAt: r.results_at ?? null,
});
interface BallotRow { voter: string; name: string; options: string; at: number }

/** The button sets, in `<dataDir>/reply-buttons.db`. Wall-clock instants: an expiry is a calendar time that must hold across restarts. */
export class ReplyButtonStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
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
        settled_at INTEGER,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reply_buttons_open ON reply_buttons(settled_at, expires_at);
    `);
    const columns = (this.db.prepare("PRAGMA table_info(reply_buttons)").all() as Array<{ name: string }>).map(c => c.name);
    if (!columns.includes("delivered_at")) this.db.exec("ALTER TABLE reply_buttons ADD COLUMN delivered_at INTEGER");
    // #1823: polls. Older rows are ordinary buttons (poll NULL).
    for (const c of ["poll TEXT", "closed_at INTEGER", "results_at INTEGER"]) {
      if (!columns.includes(c.split(" ")[0]!)) this.db.exec(`ALTER TABLE reply_buttons ADD COLUMN ${c}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS poll_ballots (
        poll_id TEXT NOT NULL,
        voter TEXT NOT NULL,
        name TEXT NOT NULL,
        options TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (poll_id, voter)
      );
    `);
  }
  close(): void { this.db.close(); }

  /**
   * Before the send: the set exists, unbound (a click cannot match it until the platform message is known). A poll
   * opens now: its deadline is `seconds` from here, and its votes are timed from here.
   */
  create(set: Pick<ReplyButtonSet, "id" | "instance" | "adapterId" | "chatId" | "threadId" | "buttons"> & { poll?: PollConfig | null }, now: number): ReplyButtonSet {
    const expires = set.poll ? now + set.poll.seconds * 1000 : now + REPLY_BUTTON_TTL_MS;
    this.db.prepare(`INSERT INTO reply_buttons (id, instance, adapter_id, chat_id, thread_id, buttons, created_at, expires_at, poll)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(set.id, set.instance, set.adapterId, set.chatId, set.threadId ?? "", JSON.stringify(set.buttons), now, expires,
      set.poll ? JSON.stringify(set.poll) : null);
    return this.get(set.id)!;
  }
  /** After the send: the message the buttons are on. Only an unbound set can be bound. */
  bind(id: string, messageId: string): boolean {
    return this.db.prepare("UPDATE reply_buttons SET message_id = ? WHERE id = ? AND message_id IS NULL").run(messageId, id).changes === 1;
  }
  /** A send that failed: the set never existed for anyone. */
  remove(id: string): void {
    this.db.prepare("DELETE FROM reply_buttons WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM poll_ballots WHERE poll_id = ?").run(id);
  }
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
    if (set.poll) return { ok: false, reason: "missing", set };          // a poll is voted on, never consumed
    const won = this.db.prepare(`UPDATE reply_buttons SET consumed_at = ?, chosen_index = ?, chosen_by = ?
      WHERE id = ? AND consumed_at IS NULL AND message_id IS NOT NULL AND expires_at > ? AND poll IS NULL`).run(now, index, by, id, now).changes === 1;
    const after = this.get(id)!;
    return won ? { ok: true, set: after, button } : { ok: false, reason: after.consumedAt !== null ? "used" : "expired", set: after };
  }
  /** The claim reached the agent: from now on it is the choice. */
  markDelivered(id: string, now: number): void {
    this.db.prepare("UPDATE reply_buttons SET delivered_at = ? WHERE id = ? AND consumed_at IS NOT NULL AND delivered_at IS NULL").run(now, id);
  }
  /** A consumed click that could not reach the agent: the set is open again (only that click's own claim is undone). */
  release(id: string, consumedAt: number): void {
    this.db.prepare(`UPDATE reply_buttons SET consumed_at = NULL, chosen_index = NULL, chosen_by = NULL
      WHERE id = ? AND consumed_at = ? AND delivered_at IS NULL AND settled_at IS NULL`).run(id, consumedAt);
  }
  /** Claims never delivered nor released — in flight now, or left by a process that stopped mid-delivery. */
  undeliveredClaims(): ReplyButtonSet[] {
    return (this.db.prepare(`SELECT * FROM reply_buttons WHERE settled_at IS NULL AND message_id IS NOT NULL
      AND consumed_at IS NOT NULL AND delivered_at IS NULL ORDER BY created_at, id`).all() as Row[]).map(fromRow);
  }
  /** The platform message shows the final state now (chosen or expired). */
  markSettled(id: string, now: number): void { this.db.prepare("UPDATE reply_buttons SET settled_at = ? WHERE id = ? AND settled_at IS NULL").run(now, id); }
  /**
   * Sets that ended and whose message does not show it yet: a delivered choice, or an expiry nobody claimed. A claim
   * still being delivered is neither (#1500 review): it may yet be released.
   */
  unsettled(now: number): ReplyButtonSet[] {
    return (this.db.prepare(`SELECT * FROM reply_buttons WHERE settled_at IS NULL AND message_id IS NOT NULL AND poll IS NULL
      AND (delivered_at IS NOT NULL OR (consumed_at IS NULL AND expires_at <= ?))`).all(now) as Row[]).map(fromRow);
  }
  /** The next expiry or poll deadline still to come, for the one sweep timer. */
  nextExpiry(now: number): number | null {
    const r = this.db.prepare(`SELECT MIN(expires_at) AS t FROM reply_buttons WHERE settled_at IS NULL AND message_id IS NOT NULL
      AND expires_at > ? AND ((poll IS NULL AND consumed_at IS NULL) OR (poll IS NOT NULL AND closed_at IS NULL))`).get(now) as { t: number | null };
    return r.t ?? null;
  }

  // ── #1823: polls ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * One voter's click on a poll, already placed on its message and permitted by the caller. In one transaction: the poll
   * must be bound, not closed and before its deadline; the voter's ballot becomes `nextBallot` of it, timed `now` when
   * it changed (an unchanged ballot keeps its time). An emptied ballot withdraws the voter.
   */
  vote(id: string, voter: string, name: string, index: number, now: number): VoteResult {
    return this.db.transaction((): VoteResult => {
      const set = this.get(id);
      if (!set || !set.poll) return { ok: false, reason: "missing" };
      if (set.messageId === null) return { ok: false, reason: "pending", set };
      if (set.closedAt !== null || now >= set.expiresAt) return { ok: false, reason: "closed", set };
      if (!Number.isInteger(index) || index < 0 || index >= set.buttons.length) return { ok: false, reason: "missing", set };
      const row = this.db.prepare("SELECT options FROM poll_ballots WHERE poll_id = ? AND voter = ?").get(id, voter) as { options: string } | undefined;
      const next = nextBallot(row ? JSON.parse(row.options) as number[] : null, index, set.poll.multi);
      if (next.changed) {
        if (next.options.length) {
          this.db.prepare(`INSERT INTO poll_ballots (poll_id, voter, name, options, at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (poll_id, voter) DO UPDATE SET name = excluded.name, options = excluded.options, at = excluded.at`)
            .run(id, voter, name, JSON.stringify(next.options), now);
        } else {
          this.db.prepare("DELETE FROM poll_ballots WHERE poll_id = ? AND voter = ?").run(id, voter);
        }
      }
      return { ok: true, set, options: next.options, changed: next.changed };
    })();
  }
  /** A poll's ballots, earliest change first. */
  ballots(id: string): PollBallot[] {
    return (this.db.prepare("SELECT voter, name, options, at FROM poll_ballots WHERE poll_id = ? ORDER BY at, voter").all(id) as BallotRow[])
      .map(r => ({ voter: r.voter, name: r.name, options: JSON.parse(r.options) as number[], at: r.at }));
  }
  /** Stop taking votes, once: true for the one call that closed it. */
  closePoll(id: string, now: number): boolean {
    return this.db.prepare("UPDATE reply_buttons SET closed_at = ? WHERE id = ? AND poll IS NOT NULL AND closed_at IS NULL AND message_id IS NOT NULL")
      .run(now, id).changes === 1;
  }
  /** Bound polls still open whose deadline has come. */
  pollsDue(now: number): ReplyButtonSet[] {
    return (this.db.prepare(`SELECT * FROM reply_buttons WHERE poll IS NOT NULL AND closed_at IS NULL AND message_id IS NOT NULL
      AND expires_at <= ? ORDER BY expires_at, id`).all(now) as Row[]).map(fromRow);
  }
  /** Bound polls still taking votes (their countdowns are redrawn after a restart). */
  openPolls(): ReplyButtonSet[] {
    return (this.db.prepare("SELECT * FROM reply_buttons WHERE poll IS NOT NULL AND closed_at IS NULL AND message_id IS NOT NULL ORDER BY expires_at, id")
      .all() as Row[]).map(fromRow);
  }
  /** Closed polls whose results the outbox has not taken yet (a crash, or an outbox that was not open). */
  pollsAwaitingResults(): ReplyButtonSet[] {
    return (this.db.prepare("SELECT * FROM reply_buttons WHERE poll IS NOT NULL AND closed_at IS NOT NULL AND results_at IS NULL ORDER BY closed_at, id")
      .all() as Row[]).map(fromRow);
  }
  markResults(id: string, now: number): void {
    this.db.prepare("UPDATE reply_buttons SET results_at = ? WHERE id = ? AND closed_at IS NOT NULL AND results_at IS NULL").run(now, id);
  }
  /** Closed polls whose platform message does not show it yet. */
  pollsUnsettled(): ReplyButtonSet[] {
    return (this.db.prepare("SELECT * FROM reply_buttons WHERE poll IS NOT NULL AND closed_at IS NOT NULL AND settled_at IS NULL ORDER BY closed_at, id")
      .all() as Row[]).map(fromRow);
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
    // A poll's results not yet handed over are kept whatever its age: they are owed to the agent.
    const n = this.db.prepare("DELETE FROM reply_buttons WHERE settled_at IS NOT NULL AND settled_at < ? AND (poll IS NULL OR results_at IS NOT NULL)").run(before).changes;
    if (n) this.db.prepare("DELETE FROM poll_ballots WHERE poll_id NOT IN (SELECT id FROM reply_buttons)").run();
    return n;
  }
}
