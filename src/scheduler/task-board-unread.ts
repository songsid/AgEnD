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
 *
 * Who "the person" is: a reader is a name and, when the session has one, the person's stable key. The mark and the floor are kept
 * under the key (`key:…`; the name alone — `name:…` — only for a session with none), so two accounts that are both "web-user" do not
 * share what they have read; and a comment is the person's own words, or the parent of a reply to them, by the key it kept when it was
 * written (a comment with no key — written before keys, an instance's — by the name).
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
  /** When the oldest comment counted leaves the UNREAD_WINDOW_DAYS window, and the answer with it (ISO); none when no comment is counted. */
  until?: string;
}

/** A card that waits for the person, as the board knows it (TaskBoard.waitingFor). */
export interface WaitingCard { uuid: string; code: string; status: "review" | "blocked" }

/** Who is asking: the person's name and, when the session has one, their stable dashboard key. */
export interface Reader { name: string; key?: string }

interface Candidate { id: number; task_id: string; author: string; author_kind: string; author_key: string | null; text: string; at: string; parent_id: number | null }

/** What the person's marks are kept under: their key when they have one, else their name (a name alone never stands in for a key). */
export const markOf = (who: Reader): string => (who.key ? `key:${who.key}` : `name:${who.name}`);

/** The floor of a person: the newest comment and event numbers when they were first asked (written then, once). */
function floorOf(db: Database.Database, mark: string, now: string): { entry: number; event: number } {
  const read = () => db.prepare("SELECT entry_floor AS entry, event_floor AS event FROM task_reads_floor WHERE person = ?").get(mark) as { entry: number; event: number } | undefined;
  const had = read();
  if (had) return had;
  db.prepare(`INSERT OR IGNORE INTO task_reads_floor (person, entry_floor, event_floor, at)
    VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM task_entries), (SELECT COALESCE(MAX(id), 0) FROM task_events), ?)`).run(mark, now);
  return read() ?? { entry: 0, event: 0 };
}

/**
 * Whether the author of a row is the person: a person (an instance of the same name is someone else) and, for a row that kept its
 * writer's key, the same key — another account with the same name is someone else, and so is a session with no key; a row with no key
 * (written before keys) is the name's.
 */
const isThem = (who: Reader, name: string, kind: string, key: string | null | undefined): boolean =>
  kind === "person" && (key ? !!who.key && key === who.key : name === who.name);

/** How many times the comments were walked (unreadFor ran its scan) since the process started — for the tests of UnreadCache. */
let scans = 0;
export const unreadScans = (): number => scans;

export function unreadFor(db: Database.Database, person: Reader, waiting: readonly WaitingCard[], now: string): Unread {
  scans++;
  const mark = markOf(person);
  const floor = floorOf(db, mark, now);
  const since = new Date(Date.parse(now) - UNREAD_WINDOW_DAYS * 86_400_000).toISOString();
  // The window is in the query: the first comment inside it (found by idx_task_entries_at) starts the range of numbers read, so a poll
  // never walks what is older than it — a card nobody opens does not make every poll slower for ever.
  const first = (db.prepare("SELECT MIN(id) AS id FROM task_entries INDEXED BY idx_task_entries_at WHERE at >= ?").get(since) as { id: number | null }).id;
  const rows = first === null ? [] : (db.prepare(`
    SELECT e.id, e.task_id, e.author, e.author_kind, e.author_key, e.text, e.at, e.parent_id
    FROM task_entries e
    LEFT JOIN task_card_reads r ON r.person = ? AND r.task_id = e.task_id
    WHERE e.kind = 'comment' AND e.deleted_at IS NULL AND e.id >= ? AND e.id > ? AND e.id > COALESCE(r.seen_entry, 0)
      AND e.at >= ?
      AND e.task_id IN (SELECT id FROM tasks WHERE status <> 'cancelled')
    ORDER BY e.id`).all(mark, first, floor.entry, since) as Candidate[]).filter((e) => !isThem(person, e.author, e.author_kind, e.author_key));
  const parentOf = db.prepare("SELECT author, author_kind, author_key FROM task_entries WHERE id = ?");
  const myEarlier = db.prepare("SELECT id, wakes, author, author_key FROM task_entries WHERE task_id = ? AND author_kind = 'person' AND deleted_at IS NULL AND wakes IS NOT NULL ORDER BY id DESC");
  // The person's comments that woke someone, per card, newest first, each with whom it woke (not skipped): read once per card in a call, not
  // once per instance comment on it.
  const mineByCard = new Map<string, Array<{ id: number; woke: Set<string> }>>();
  const mineOn = (uuid: string) => {
    let list = mineByCard.get(uuid);
    if (!list) {
      list = [];
      for (const m of myEarlier.all(uuid) as Array<{ id: number; wakes: string; author: string; author_key: string | null }>) {
        if (!isThem(person, m.author, "person", m.author_key)) continue;
        let woke: Array<{ to?: unknown; skip?: unknown }> = [];
        try { const v = JSON.parse(m.wakes) as unknown; if (Array.isArray(v)) woke = v as typeof woke; } catch { /* unreadable: no answer is known */ }
        list.push({ id: Number(m.id), woke: new Set(woke.filter((w) => w && typeof w.to === "string" && !w.skip).map((w) => w.to as string)) });
      }
      mineByCard.set(uuid, list);
    }
    return list;
  };
  const answeredAlready = db.prepare("SELECT 1 FROM task_entries WHERE task_id = ? AND author = ? AND author_kind = ? AND kind = 'comment' AND deleted_at IS NULL AND id > ? AND id < ? LIMIT 1");
  const codeOf = db.prepare("SELECT code FROM tasks WHERE id = ?");

  const cards = new Map<string, UnreadCard & { uuid: string }>();
  let oldest = "";
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
    if (entry !== undefined) { c.entries.push(entry); if (oldest === "" || at < oldest) oldest = at; }
    if (at >= c.at) { c.at = at; c.by = by; }
  };

  for (const e of rows) {
    // Under one of the person's own comments.
    if (e.parent_id !== null) {
      const parent = parentOf.get(e.parent_id) as { author: string; author_kind: string; author_key: string | null } | undefined;
      if (parent && isThem(person, parent.author, parent.author_kind, parent.author_key)) { note(e.task_id, "reply", e.at, e.author, e.id); continue; }
    }
    // Naming them with `@` (a name the board's `@` rules read: not in code, not part of an address).
    if (parseMentions(e.text, [person.name]).names.includes(person.name)) { note(e.task_id, "mention", e.at, e.author, e.id); continue; }
    // The answer of the instance their comment woke: its first comment on the card after that one.
    if (e.author_kind !== "person") {
      for (const mine of mineOn(e.task_id)) {
        if (mine.id >= e.id || !mine.woke.has(e.author)) continue;
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
    const beenSeen = (seen.get(mark, w.uuid) as { seen_event: number } | undefined)?.seen_event ?? 0;
    // (a move's actor kept no key: the person's own move is the name's, as it is for a comment from before keys)
    if (to !== w.status || move.id <= floor.event || move.id <= beenSeen || isThem(person, move.actor, move.actor_kind, null)) continue;
    note(w.uuid, w.status, move.at, move.actor);
  }

  const out = [...cards.values()].map(({ uuid: _uuid, ...c }) => ({ ...c, reasons: UNREAD_REASONS.filter((r) => c.reasons.includes(r)) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { cards: out, total: out.length, ...(oldest ? { until: new Date(Date.parse(oldest) + UNREAD_WINDOW_DAYS * 86_400_000).toISOString() } : {}) };
}

/** The person has looked at the card: everything on it so far is read (a mark only moves forward). */
export function markRead(db: Database.Database, person: Reader, uuid: string, now: string): void {
  const mark = markOf(person);
  floorOf(db, mark, now);
  db.prepare(`INSERT INTO task_card_reads (person, task_id, seen_entry, seen_event, at)
    VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM task_entries WHERE task_id = ?), (SELECT COALESCE(MAX(id), 0) FROM task_events WHERE task_id = ?), ?)
    ON CONFLICT (person, task_id) DO UPDATE SET seen_entry = MAX(seen_entry, excluded.seen_entry), seen_event = MAX(seen_event, excluded.seen_event), at = excluded.at`)
    .run(mark, uuid, uuid, uuid, now);
}

/**
 * The person's unread, kept until something it is worked out from moves (the review of #4573: every open page asks on every `tasks` ping
 * and once a minute, and the walk is synchronous on the fleet's event loop). Kept per person — the mark and the name the walk reads, so one
 * person's answer is never another's — under a state the caller reads cheaply each time: the board's revision (every committed write: a
 * comment, an edit, a delete, a move, a card cancelled or swept with its marks), the newest comment and event numbers (a write the revision
 * did not see), the generation of the comments' wake records (handed over or dropped: no revision, and an answer counts only for a wake not
 * skipped) and the cards that wait for the person (they also follow the fleet: a dispatcher gone). Let go when the person opens a card
 * (`forget`), when the oldest comment it counts leaves the UNREAD_WINDOW_DAYS window, and after UNREAD_KEEP_MS whatever happens, so a
 * change outside all of these (a hand-edited database) is read within minutes. Which cards the viewer may see is not part of it: the
 * route leaves those out of each answer. Requests do not race: the walk is synchronous, so the second of two at once finds the first's answer.
 */
export const UNREAD_KEEP_MS = 5 * 60_000;

export class UnreadCache {
  private kept = new Map<string, { state: string; until: number; answer: Unread }>();

  /** The person's answer for `state`, worked out by `walk` only when what was kept is not for it (or has run out at `now`). */
  get(person: Reader, state: string, now: string, walk: () => Unread): Unread {
    const mark = markOf(person);
    const at = Date.parse(now);
    const had = this.kept.get(mark);
    if (had && had.state === `${person.name}\u0000${state}` && at < had.until) return had.answer;
    const answer = walk();
    // The first comment counted to leave the window ends what was kept (a hand-over to the person does not leave it).
    const until = Math.min(at + UNREAD_KEEP_MS, answer.until ? Date.parse(answer.until) : Infinity);
    this.kept.set(mark, { state: `${person.name}\u0000${state}`, until, answer });
    return answer;
  }

  /** The person opened a card: what was kept for them is read again. */
  forget(person: Reader): void { this.kept.delete(markOf(person)); }
}
