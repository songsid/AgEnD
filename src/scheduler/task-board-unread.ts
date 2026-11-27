/**
 * What is new on the task board for one person (docs/design/task-board.md, "Unread"): the cards where someone answered them,
 * named them with `@`, or handed them a card to confirm or answer, since they last opened the card. Nothing is copied — a card's
 * unread is worked out from its comments and its history and from one mark per person and card (`task_card_reads`), so the
 * mark is all that is ever written, and an older release neither reads nor writes it.
 *
 * What counts as "for the person" P (what a card's other activity does not):
 *   - `reply`   a comment by someone else under one of P's comments (`parent_id`), or
 *   - `mention` a comment by someone else whose words `@`-name P, or
 *   - `answer`  the first comment by an instance after a comment of P's that woke it (`task_entries.wakes`): the answer P was
 *               waiting for, which an agent writes without a `reply_to`, or
 *   - `review` / `blocked` the card is now P's to confirm or answer (waitsForPerson) and someone else put it there.
 * P's own words are never news to P, nor is a comment that was deleted, one older than UNREAD_WINDOW_DAYS, or one on a cancelled card.
 *
 * A fresh start does not make the whole history unread: the first time a person is asked, the newest comment and event numbers
 * are written as their floor (`task_reads_floor`), and only what comes after it can be unread.
 */
import type Database from "better-sqlite3";
import { parseMentions } from "./task-board-mentions.js";

export type UnreadReason = "reply" | "mention" | "answer" | "review" | "blocked";
/** The reasons, strongest first (a card says the first one it has). */
export const UNREAD_REASONS: readonly UnreadReason[] = ["review", "blocked", "reply", "answer", "mention"];

export interface UnreadCard {
  /** The card's number (M-12). */
  id: string;
  /** How many things are new on it (comments, plus the hand-over to the person). */
  n: number;
  /** Why, strongest first, each once. */
  reasons: UnreadReason[];
  /** The comments that are new (their numbers), for the card's page to mark. */
  entries: number[];
  /** When the newest of them happened (ISO). */
  at: string;
  /** Who did the newest. */
  by: string;
}

/**
 * How far back a comment can still be news: older than this and nobody is reading for it any more, and a card nobody opens must not
 * keep every unread query (one per open page per `tasks` ping) walking its whole history. A card that is cancelled has nobody waiting
 * on it either. A finished card is not left out: an agent often answers as it finishes.
 */
export const UNREAD_WINDOW_DAYS = 30;

export interface Unread {
  /** The cards with something new, newest first. */
  cards: UnreadCard[];
  /** How many cards (the number the sidebar shows). */
  total: number;
}

/** A card that waits for the person, as the board knows it (TaskBoard.waitingFor). */
export interface WaitingCard { uuid: string; code: string; status: "review" | "blocked" }

interface Candidate { id: number; task_id: string; author: string; author_kind: string; text: string; at: string; parent_id: number | null }

/** The floor of a person: the newest comment and event numbers when they were first asked (written then, once). */
function floorOf(db: Database.Database, person: string, now: string): { entry: number; event: number } {
  const read = () => db.prepare("SELECT entry_floor AS entry, event_floor AS event FROM task_reads_floor WHERE person = ?").get(person) as { entry: number; event: number } | undefined;
  const had = read();
  if (had) return had;
  db.prepare(`INSERT OR IGNORE INTO task_reads_floor (person, entry_floor, event_floor, at)
    VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM task_entries), (SELECT COALESCE(MAX(id), 0) FROM task_events), ?)`).run(person, now);
  return read() ?? { entry: 0, event: 0 };
}

/** Whether `by` (a name and a kind) is the person: a person of that name (an instance of the same name is someone else). */
const isThem = (person: string, name: string, kind: string) => name === person && kind === "person";

export function unreadFor(db: Database.Database, person: string, waiting: readonly WaitingCard[], now: string): Unread {
  const floor = floorOf(db, person, now);
  const rows = db.prepare(`
    SELECT e.id, e.task_id, e.author, e.author_kind, e.text, e.at, e.parent_id
    FROM task_entries e
    LEFT JOIN task_card_reads r ON r.person = ? AND r.task_id = e.task_id
    WHERE e.kind = 'comment' AND e.deleted_at IS NULL AND e.id > ? AND e.id > COALESCE(r.seen_entry, 0)
      AND e.at >= ?
      AND NOT (e.author = ? AND e.author_kind = 'person')
      AND e.task_id IN (SELECT id FROM tasks WHERE status <> 'cancelled')
    ORDER BY e.id`).all(person, floor.entry, new Date(Date.parse(now) - UNREAD_WINDOW_DAYS * 86_400_000).toISOString(), person) as Candidate[];
  const parentOf = db.prepare("SELECT author, author_kind FROM task_entries WHERE id = ?");
  const myEarlier = db.prepare("SELECT id, wakes FROM task_entries WHERE task_id = ? AND author = ? AND author_kind = 'person' AND id < ? AND deleted_at IS NULL AND wakes IS NOT NULL ORDER BY id DESC");
  const answeredAlready = db.prepare("SELECT 1 FROM task_entries WHERE task_id = ? AND author = ? AND author_kind = ? AND kind = 'comment' AND deleted_at IS NULL AND id > ? AND id < ? LIMIT 1");
  const codeOf = db.prepare("SELECT code FROM tasks WHERE id = ?");

  const cards = new Map<string, UnreadCard & { uuid: string }>();
  const card = (uuid: string): (UnreadCard & { uuid: string }) | null => {
    let c = cards.get(uuid);
    if (!c) {
      const code = (codeOf.get(uuid) as { code: string | null } | undefined)?.code;
      if (!code) return null;
      c = { uuid, id: code, n: 0, reasons: [], entries: [], at: "", by: "" };
      cards.set(uuid, c);
    }
    return c;
  };
  const note = (uuid: string, reason: UnreadReason, at: string, by: string, entry?: number) => {
    const c = card(uuid);
    if (!c) return;
    c.n++;
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
    if (entry !== undefined) c.entries.push(entry);
    if (at >= c.at) { c.at = at; c.by = by; }
  };

  for (const e of rows) {
    // Under one of the person's own comments.
    if (e.parent_id !== null) {
      const parent = parentOf.get(e.parent_id) as { author: string; author_kind: string } | undefined;
      if (parent && isThem(person, parent.author, parent.author_kind)) { note(e.task_id, "reply", e.at, e.author, e.id); continue; }
    }
    // Naming them with `@` (a name the board's `@` rules read: not in code, not part of an address).
    if (parseMentions(e.text, [person]).names.includes(person)) { note(e.task_id, "mention", e.at, e.author, e.id); continue; }
    // The answer of the instance their comment woke: its first comment on the card after that one.
    if (e.author_kind !== "person") {
      for (const mine of myEarlier.all(e.task_id, person, e.id) as Array<{ id: number; wakes: string }>) {
        let list: Array<{ to?: unknown; skip?: unknown }> = [];
        try { const v = JSON.parse(mine.wakes) as unknown; if (Array.isArray(v)) list = v as typeof list; } catch { /* unreadable: no answer is known */ }
        if (!list.some((w) => w && w.to === e.author && !w.skip)) continue;
        if (!answeredAlready.get(e.task_id, e.author, e.author_kind, mine.id, e.id)) note(e.task_id, "answer", e.at, e.author, e.id);
        break;
      }
    }
  }

  // A card that is now the person's to confirm or answer, put there by someone else since they last looked at it.
  const seen = db.prepare("SELECT seen_event FROM task_card_reads WHERE person = ? AND task_id = ?");
  const lastMove = db.prepare("SELECT id, at, actor, actor_kind, data FROM task_events WHERE task_id = ? AND type = 'moved' ORDER BY id DESC LIMIT 1");
  for (const w of waiting) {
    const move = lastMove.get(w.uuid) as { id: number; at: string; actor: string; actor_kind: string; data: string } | undefined;
    if (!move) continue;
    let to: unknown;
    try { to = (JSON.parse(move.data) as { to?: unknown }).to; } catch { continue; }
    const beenSeen = (seen.get(person, w.uuid) as { seen_event: number } | undefined)?.seen_event ?? 0;
    if (to !== w.status || move.id <= floor.event || move.id <= beenSeen || isThem(person, move.actor, move.actor_kind)) continue;
    note(w.uuid, w.status, move.at, move.actor);
  }

  const out = [...cards.values()].map(({ uuid: _uuid, ...c }) => ({ ...c, reasons: UNREAD_REASONS.filter((r) => c.reasons.includes(r)) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { cards: out, total: out.length };
}

/** The person has looked at the card: everything on it so far is read (a mark only moves forward). */
export function markRead(db: Database.Database, person: string, uuid: string, now: string): void {
  floorOf(db, person, now);
  db.prepare(`INSERT INTO task_card_reads (person, task_id, seen_entry, seen_event, at)
    VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM task_entries WHERE task_id = ?), (SELECT COALESCE(MAX(id), 0) FROM task_events WHERE task_id = ?), ?)
    ON CONFLICT (person, task_id) DO UPDATE SET seen_entry = MAX(seen_entry, excluded.seen_entry), seen_event = MAX(seen_event, excluded.seen_event), at = excluded.at`)
    .run(person, uuid, uuid, uuid, now);
}
