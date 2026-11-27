/**
 * The task board: projects → main tasks (M-n) → sub tasks (S-n) on the fleet's `tasks` table, and the rules every
 * write goes through — who may move what, the reasons a move needs, dependencies, the person's confirmation gate and
 * optimistic versions — plus the comments, progress log and history each card keeps. Design:
 * docs/design/task-board.md (ported from taskhall, 任務會所).
 *
 * Storage is additive: new columns on `tasks` (nullable or with defaults) and new tables. A release without the board
 * still reads and writes the same rows — it ignores the new columns — and the startup backfill gives anything it
 * created a card number, a kind and a place in the order again (see migrate()).
 *
 * Who acts is an {@link Actor}: the signed-in person on the dashboard, an instance through its tools, or the board
 * itself (derived moves). Only a person confirms or rejects work waiting for review, clears "needs review", moves a
 * card to another project, or reopens a finished card; an instance moves its own cards along.
 */
import type { QuiescenceGate } from "../update-quiescence.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { parseMentions } from "./task-board-mentions.js";
import { TASK_FILE_LIMITS, TaskFileError, type StagedFile, type TaskFileStore } from "./task-files.js";

export const CARD_STATUSES = ["open", "claimed", "blocked", "review", "done", "cancelled"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
/** Statuses still on the board (not finished). */
export const LIVE_CARD_STATUSES: CardStatus[] = ["open", "claimed", "blocked", "review"];
export const CARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];
export const CARD_SIZES = ["S", "M", "L"] as const;
export type CardSize = (typeof CARD_SIZES)[number];
export type CardKind = "main" | "sub";

/** `script`: a dashboard request on the header token (the CLI, a script) — held to the rules an instance is held to. */
export interface Actor {
  kind: "person" | "instance" | "script" | "system";
  name: string;
  /**
   * A person's stable key from the dashboard (never shown), kept with each comment they write: two people who are both "web-user"
   * (neither set a name) are told apart by it, so one cannot edit the other's comment. Absent (an instance, a script, a caller that
   * has none, a comment written before it was kept): the name and the kind say who wrote it.
   */
  key?: string;
}
export const SYSTEM_ACTOR: Actor = { kind: "system", name: "system" };

/** Field limits in characters (code points). Small on purpose: an agent reads the whole card. */
export const CARD_LIMITS = {
  title: 100,
  goal: 300,
  scope: 600,
  acceptanceItems: 10,
  acceptanceText: 150,
  context: 1000,
  state: 500,
  stateLines: 5,
  blockedReason: 400,
  result: 1000,
  reason: 400,
  log: 300,
  comment: 4000,
  projectName: 60,
  projectDescription: 300,
  assignee: 128,
} as const;

/** How far back finished sub tasks and cancelled main tasks stay on the board. */
const BOARD_DAYS = 14;
/**
 * M-3668 (the user, 11-24): a finished main task — done or cancelled — leaves the dashboard's board this many days after it
 * finished (defaults.task_board.archive_after_days; 0 = never). A view rule only: nothing in the database changes, search
 * and its number still find it, and moving it to To do reopens it (its status, not its age, makes it archived).
 */
export const ARCHIVE_AFTER_DAYS = 3;
/** The archive age as fleet.yaml gives it: a whole number of days, 0–3650; anything else is the default. */
export function archiveAfterDays(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3650 ? v : ARCHIVE_AFTER_DAYS;
}
/** M-3668: how many finished main tasks a project's Done column counts as "this week". */
const WEEK_MS = 7 * 86_400_000;
const BATCH_MAX = 30;

/**
 * The loop guard for comments that wake (docs/design/task-board.md, "Comments and mentions"): instances (and scripts,
 * held to the same rules) can wake each other with a comment or an `@` mention, and a reply wakes its writer again.
 * Within AGENT_COMMENT_WINDOW_MS, and counting back to the last thing a person wrote on the card, the agents' comments
 * that woke someone make a chain of turns (a change of writer starts a new turn; one agent writing again is the same
 * turn, since nobody answered it). A comment wakes someone only while the chain is no longer than AGENT_COMMENT_CHAIN
 * turns: the rest are kept on the card and wake nobody until a person writes on it or the window passes. One agent
 * comment also wakes at most MAX_COMMENT_WAKES instances. A person's comment has neither limit.
 */
export const AGENT_COMMENT_CHAIN = 4;      // turns
export const AGENT_COMMENT_WINDOW_MS = 30 * 60_000;
export const MAX_COMMENT_WAKES = 5;
/** How many recipients one comment may name with `to` (the comment box's chip names one). */
export const MAX_RECIPIENTS = 5;

/**
 * Following a card (docs/design/task-board.md, "Following a card"): the instances that handed it out, watch it, or lead
 * its project hear how it moved on — finished, waiting for confirmation, sent back, blocked, or given to someone else.
 * The same loop guard as comments, read from the card's own events: the progress agents made on a card, back to the
 * last thing a person did to it and within AGENT_COMMENT_WINDOW_MS. Past AGENT_PROGRESS_CHAIN of them the next one is
 * kept on the card and tells no one until a person touches it or the window passes. A person's change has no limit.
 */
export const AGENT_PROGRESS_CHAIN = 6;
/** How many instances may watch one card. */
export const MAX_WATCHERS = 10;

/** Whom one comment may wake, settled when it is written (its notes go back to its writer) and read when the write ends. */
export interface CommentAudience {
  /** The instances its `@` marks (and its writer's recipient, when it is not the assignee) name (the board's own names), without its writer, those with the task board off, and the surplus. */
  mentions: string[];
  /** Whether the card's assignee may hear it as a comment (the fleet's switch on, an agent's chain not over its limit). */
  assignee: boolean;
  /** The comment it answers, for the notice to say so. */
  reply?: { id: number; author: string; text: string };
}

/** What the fleet tells the board for routing a comment; read at every comment, so a fleet.yaml edit applies to the next. */
export interface CommentRouting {
  /** The fleet's instance names (an `@name` is only ever one of them). */
  instances: () => Iterable<string>;
  /** `defaults.task_board.comment_wakes` (default on): whether comments and mentions wake at all. */
  enabled: () => boolean;
}

/** What the fleet tells the board for following a card; read at every write, so a fleet.yaml edit applies to the next. */
export interface ProgressRouting {
  /** `defaults.task_board.progress_wakes` (default on): whether followers hear a card's progress at all. */
  enabled: () => boolean;
  /** `defaults.task_board.leader`: the leader of the cards whose project has none of its own (null: none). */
  leader: () => string | null;
}

/**
 * A refusal. `code` is its kind (and the HTTP status the dashboard gets); `key` and `args`, when set, name the same
 * sentence for the dashboard to say in its own language (tasks.err.<key> with {0}, {1}… = args). Refusals only an
 * instance can meet keep English only: they reach the instance, which reads the message.
 */
export class TaskBoardError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "too_long" | "forbidden" | "conflict" | "blocked_by_deps" | "needs_review" | "one_at_a_time",
    message: string,
    readonly key?: string,
    readonly args: Array<string | number> = [],
  ) {
    super(message);
  }
}

/** A note after a write: English for the agents, a key and its values for the dashboard (tasks.note.<key>). */
export interface Note {
  text: string;
  key: string;
  args: Array<string | number>;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  archived: boolean;
  /**
   * #2352: the instance whose channel lists the project's cards that wait for the person (Needs you's Confirm / Send
   * back / Answer), when no instance dispatched them; null: General. Any name — the fleet checks it is an instance.
   */
  leadInstance: string | null;
  sort: number;
  createdAt: string;
}

export interface AcceptanceItem {
  text: string;
  done: boolean;
}

/**
 * Who handed a card out: the person who opened it on the dashboard, or the instance that opened it for another one (a
 * coordinator such as a lead). A blocked card's question goes to an instance dispatcher first (step 2's wakes); it may
 * answer it on the card and edit the card. Sub tasks take their main task's.
 */
export interface Dispatcher {
  kind: "person" | "instance";
  name: string;
}
/** What a write sets a dispatcher to: an instance by name, the person writing ({ kind: "person" }), or nobody. */
export type DispatcherInput = { kind: "instance"; name: string } | { kind: "person" } | null;

/** A row as the rules see it: `uuid` is the key, `code` (M-3, S-34) the number people and agents use. */
export interface Card {
  uuid: string;
  code: string;
  kind: CardKind;
  projectId: number | null;
  /** Sub tasks: the main task's uuid. */
  parent: string | null;
  title: string;
  status: CardStatus;
  assignee: string | null;
  dispatcher: Dispatcher | null;
  priority: CardPriority;
  size: CardSize | null;
  needsReview: boolean;
  /**
   * #2434: opened on the board (createCards), not the `task` tool's own plain task. Before #2434 a main task's default
   * "needs review" marked it; an agent's main task no longer waits for review, so the board says so on its own.
   */
  onBoard: boolean;
  /** uuids of the cards to finish first (what the fleet's `task` tool has always stored). */
  deps: string[];
  goal: string;
  scope: string;
  acceptance: AcceptanceItem[];
  context: string;
  state: string;
  blockedReason: string;
  result: string;
  sort: number;
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  doneAt: string | null;
  /** Highest entry id the assignee has acted after; later comments by others are new to it. */
  seenEntryId: number;
}

export interface Progress {
  total: number;
  open: number;
  claimed: number;
  blocked: number;
  review: number;
  done: number;
}

/** A project's numbers on Home and in its header (projectStats). */
export interface ProjectStats {
  mains: number;
  units: Progress;
  percent: number;
  waiting: number;
  blocked: number;
  lastActivity: string | null;
  /**
   * M-3668: finished main tasks archived (left out of the numbers above), main tasks done in the last 7 days, and how many
   * of those are archived already (the Done column shows the rest: "45 done this week · 8 archived").
   */
  archived: number;
  doneWeek: number;
  archivedWeek: number;
}

/** A card as the dashboard draws it: references by card number. */
export interface CardView {
  id: string;
  /** #2080: in review needing the person's confirmation, or blocked on a question theirs (waitsForPerson): Waiting for you. */
  waitsForPerson: boolean;
  /** #2080: the instance that confirms it in review (its dispatcher, else its assignee); null when the person does. */
  confirmer: string | null;
  uuid: string;
  kind: CardKind;
  projectId: number | null;
  parentId: string | null;
  title: string;
  status: CardStatus;
  assignee: string | null;
  dispatcher: Dispatcher | null;
  priority: CardPriority;
  size: CardSize | null;
  needsReview: boolean;
  dependsOn: string[];
  goal: string;
  scope: string;
  acceptance: AcceptanceItem[];
  context: string;
  state: string;
  blockedReason: string;
  result: string;
  sort: number;
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  doneAt: string | null;
  /** A main task's sub-task progress (total 0 when it has none); null for a sub task. */
  progress: Progress | null;
  unmetDeps: string[];
  commentCount: number;
  /** Files on the card (its attachments). */
  attachmentCount: number;
  /** Comments by others its assignee has not acted on yet. */
  newCommentCount: number;
  lastComment: { author: string; authorKind: Actor["kind"]; at: string } | null;
}

export type EntryKind = "log" | "comment" | "reject" | "approve";
/** One emoji on a comment and the people (and instances) who put it there, oldest first. */
export interface Reaction {
  emoji: string;
  by: Array<{ name: string; kind: Actor["kind"] }>;
  /** Added by the dashboard's read, for the viewer: whether this chip is theirs (by their key, not their name). */
  mine?: boolean;
}
export interface Entry {
  id: number;
  cardId: string;
  kind: EntryKind;
  author: string;
  authorKind: Actor["kind"];
  text: string;
  at: string;
  /**
   * The comment threads (docs/design/task-board.md, "Comment threads"). Each field is present only when it has a value,
   * so an entry nobody replied to, edited or reacted to reads exactly as it always did.
   * `parentId`: the comment this one answers (the one it was written under, not the thread's first).
   */
  parentId?: number;
  /** When the author last changed the words. */
  editedAt?: string;
  /** Deleted: the words are gone (`text` is empty) and the entry stays as a placeholder, so the thread under it holds. */
  deleted?: { at: string; by: string };
  /** A thread's first comment, resolved (folded away) by this name. */
  resolved?: { at: string; by: string };
  reactions?: Reaction[];
  /** Set by the dashboard's card read for the one it is read for: whether they wrote this comment (an edit is its author's). */
  mine?: boolean;
}

/**
 * A file on a card: linked to the comment its writer left with it (`entryId`), kept under the card in
 * `task-files/` (task-files.ts) and served only as a download (GET /ui/tasks/files/<id>). `kind` is what the bytes are
 * (a picture, or anything else); `name` is a label — never a path.
 */
export interface Attachment {
  id: string;
  cardId: string;
  entryId: number | null;
  name: string;
  mime: string;
  kind: "photo" | "document";
  size: number;
  author: string;
  authorKind: Actor["kind"];
  at: string;
}

export type CardEventType = "created" | "updated" | "moved" | "assigned" | "commented" | "logged" | "reordered";
/**
 * A change that is told to the page and, for an edit that adds an `@`, to the instance it names, but written to no
 * `task_events` row: an edit, a deletion, a reaction, a thread resolved. (A release without them prints an event type it
 * does not know as the line it is, so these leave no history line behind.)
 */
export type SignalType = "comment_edited" | "comment_deleted" | "comment_reacted" | "comment_resolved";
export interface CardEvent {
  id: number;
  at: string;
  actor: string;
  actorKind: Actor["kind"];
  cardId: string;
  type: CardEventType;
  data: Record<string, unknown>;
}

/**
 * Why an instance hears about one of its cards (step 2's wakes, task-board-waker.ts): someone else assigned it,
 * started it, sent it back, answered its blocked question, or finished the last card it waited for; it is blocked and
 * the instance handed it out (decide); it went to the person for confirmation and the instance handed it out, so it
 * tells them (to_confirm); a main task went to the person by itself before its owner wrapped it up (wrap_up); or
 * someone else cancelled it — a main task's cancel takes its unfinished sub tasks down with it, and their assignees
 * hear (cancelled). #2801: only a change of status or assignee is news, and only to the one instance that acts on it
 * next — a confirmation (the work is finished) wakes nobody; but for the answer to its blocked question that waits on
 * the card while its assignee is busy with another (#2303), which it acts on next (answer_kept).
 * A comment is news too, since comments and mentions wake (docs/design/task-board.md, "Comments and mentions"): the
 * card's assignee hears a comment someone else wrote on it (comment), and an instance a comment names with
 * `@<instance>` hears it whether or not the card is its own (mention).
 */
export type WakeReason = "assigned" | "start" | "sent_back" | "answered" | "answer_kept" | "ready" | "decide" | "to_confirm" | "confirm_own" | "wrap_up" | "cancelled" | "comment" | "mention" | "progress";

/**
 * How a card moved on, as a follower is told (WakeReason "progress"): finished, in review (waiting for its confirmer),
 * sent back from review, blocked, or handed to another assignee. These are the only changes a follower hears; starting
 * a card, a comment or a reorder is not progress.
 */
export type ProgressKind = "done" | "review" | "sent_back" | "blocked" | "reassigned";
/** Why an instance follows a card: it handed it out, it watches it, or it leads the card's project (or the board). */
export type FollowRole = "dispatcher" | "watcher" | "leader";
/** A progress wake's news: what happened, why the instance hears it, and (reassigned) who has the card now and had it. */
export interface ProgressNews {
  kind: ProgressKind;
  as: FollowRole;
  assignee?: string | null;
  from?: string | null;
}

/** One card's news for one instance from one committed write. Never sent to a page (it carries titles and text). */
export interface Wake {
  instance: string;
  uuid: string;
  code: string;
  title: string;
  /** The main task's number, for a sub task. */
  parent: string | null;
  reasons: WakeReason[];
  /** Who did each (the last one, when several did the same). */
  by: Partial<Record<WakeReason, string>>;
  /** The words that came with a reason: a send-back's, an answer's, a comment's, a question's, a confirmation note. */
  texts: Partial<Record<WakeReason, string>>;
  /** The reasons whose last writer was a person, not an instance. */
  byPerson?: Partial<Record<WakeReason, true>>;
  /** The comment a reason's words answer (its number, author and a short excerpt of its words): a reply says what it replies to. */
  replies?: Partial<Record<WakeReason, { id: number; author: string; text: string }>>;
  /**
   * The comment (its entry number) whose words a reason quotes, for a comment, a mention, an answer: the words are read from it again when
   * the notice goes out, so an edit or a deletion made meanwhile is what is told (wakeHolds), and a notice already queued is found by it (the
   * waker's key names these numbers).
   */
  entries?: Partial<Record<WakeReason, number>>;
  /**
   * Set by the waker, never the board: how many comments (or mentions) earlier than the one in `texts` it merged into
   * this wake while gathering — the notice quotes the last and says there are more.
   */
  earlier?: number;
  /** What a "progress" reason says (the latest, when several came while it gathered). */
  news?: ProgressNews;
  /**
   * The writers (instances, scripts; never a person) whose own words this wake carries by the board's routes for words —
   * a comment, an `@` mention, a follower's progress (WORD_REASONS). Each is held to the fleet's contact rules for the
   * recipient (setContactGate) when it writes and again when the notice goes out, and the recipient inherits its origin.
   */
  principals?: string[];
  /**
   * Set by the fleet as the write commits, never the board: each principal's contact origins at that moment (opaque
   * here; none when it has none), carried through the waker's gathering — every snapshot of every write merged into the
   * wake is kept — so the recipient inherits all the words came with, not what the writer has later.
   */
  origins?: Record<string, unknown[]>;
}

/** The reasons that carry a writer's own words to an instance by the board's routes, not by a handover of the card. */
export const WORD_REASONS: readonly WakeReason[] = ["comment", "mention", "progress"];

/** What one committed write changed, for live views: the card numbers touched (none for a project change). */
export interface BoardChange {
  /** The board's revision after this write (revision()). */
  rev: number;
  ids: string[];
  actors: string[];
  projects: boolean;
  /** Whom to wake about what (the fleet's waker); a page is sent the rest. */
  wakes: Wake[];
  /** #2801: the cards whose status or assignee this write changed (an older notice about them no longer stands). */
  changed: string[];
  /** The comments this write edited or deleted: a notice still waiting that quotes one no longer says what it says. */
  recalled?: Array<{ uuid: string; entry: number; deleted: boolean }>;
}

export interface CardDetail {
  card: CardView;
  parent: { id: string; title: string; status: CardStatus } | null;
  children: CardView[];
  comments: Entry[];
  logs: Entry[];
  history: CardEvent[];
  /** The files on this card, oldest first; each hangs under the comment `entryId` names. */
  attachments: Attachment[];
  /** The instances that watch this card (its own list: a sub task's main task's watchers follow it too). */
  watchers: string[];
  /** A sub task's: the watchers of its main task, which follow it too (read-only here; empty for any other card). */
  inheritedWatchers: string[];
  /** Who leads the card — its project's lead, else the board's leader — and which of the two it is; null: nobody. */
  leader: { name: string; via: "project" | "board" } | null;
  /** `defaults.task_board.progress_wakes`: false means no follower (a watcher, the leader…) hears the card's progress. */
  followsProgress: boolean;
}

export interface NewCard {
  /** Defaults to "sub" when a parent is given, else "main". */
  kind?: CardKind;
  /** Main tasks: a project id or name; none puts the card under "No project". */
  project?: string | number | null;
  /** Sub tasks: the main task's number, or "#n" for the n-th card of the same batch. */
  parent?: string | null;
  title: string;
  goal?: string;
  scope?: string;
  acceptance?: string[];
  context?: string;
  size?: CardSize | null;
  priority?: CardPriority;
  /** Card numbers, or "#n" for the n-th card of the same batch. */
  dependsOn?: string[];
  assignee?: string | null;
  /**
   * Who handed it out. By default: the main task's for a sub task; else the person opening it on the dashboard, or the
   * instance opening it for another one.
   */
  dispatcher?: DispatcherInput;
  /** Defaults to true for a main task and false for a sub task. */
  needsReview?: boolean;
}

export interface CardPatch {
  version?: number;
  title?: string;
  goal?: string;
  scope?: string;
  context?: string;
  state?: string;
  result?: string;
  blockedReason?: string;
  size?: CardSize | null;
  priority?: CardPriority;
  assignee?: string | null;
  dispatcher?: DispatcherInput;
  needsReview?: boolean;
  dependsOn?: string[];
  acceptance?: string[];
  addAcceptance?: string[];
  check?: number[];
  uncheck?: number[];
  /** Main tasks only, a person only: move to another project (null: no project); sub tasks follow. */
  projectId?: number | null;
  log?: string;
  comment?: string;
  /** Files the writer staged (TaskFileStore): linked to the comment this write leaves — a line naming them when it has no words. */
  attach?: string[];
  /** The comment this one answers (an entry of this card; not a deleted one). Only with `comment`. */
  replyTo?: number;
  /**
   * Whom this comment is for, chosen by the writer (the comment box's recipient chip): the instances it wakes, besides any
   * `@name` in its words. Given, the card's assignee hears it only if it is among them (`[]`: nobody is woken by the
   * recipient — "notify no agent"); absent, the old rule: the assignee and the `@names`. Only with `comment`.
   */
  to?: string[];
}

export interface MoveOptions {
  reason?: string;
  result?: string;
  comment?: string;
  version?: number;
  /** As CardPatch.attach: the files that go with the move's comment. */
  attach?: string[];
}

export interface MutationResult {
  card: Card;
  /** English, for the agents. */
  notes: string[];
  /** The same notes for the dashboard to say in its own language. */
  said: Note[];
}

export interface MyWork {
  /** Cards it works on itself: sub tasks, and main tasks without sub tasks. */
  doing: Card[];
  blocked: Card[];
  review: Card[];
  ready: Card[];
  /** Cards it could take but for their dependencies, with the card numbers they wait for. */
  waiting: Array<{ card: Card; waitsFor: string[] }>;
  newComments: Array<{ card: Card; entries: Entry[] }>;
  sentBack: Array<{ card: Card; entry: Entry }>;
  /** Main tasks it coordinates (they have sub tasks). */
  mains: Array<{ card: Card; progress: Progress }>;
}

/**
 * What a read leaves out: the comments, logs and send-backs of these authors (instances kept out of sight, over the
 * public link — #2304 review). Their entries are not counted, named as a card's last comment, or found by search.
 */
export interface ReadScope {
  leaveOutAuthors?: readonly string[];
}

export interface SearchHit {
  card: Card;
  /** Where the phrase was found, when not in the title. */
  match: { field: string; text: string } | null;
}

type Row = Record<string, unknown>;

const STATUS_ORDER = `CASE status WHEN 'claimed' THEN 0 WHEN 'blocked' THEN 1 WHEN 'review' THEN 2 WHEN 'open' THEN 3 WHEN 'done' THEN 4 ELSE 5 END`;
const PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;
// Keep the second whitespace run inside the hyphen branch: without a hyphen, adjacent runs backtrack quadratically.
const CODE_RE = /^\s*([MS])\s*(?:-\s*)?(\d+)\s*$/i;

const length = (s: string) => [...s].length;
const isFinished = (c: Card) => c.status === "done" || c.status === "cancelled";
const isPerson = (a: Actor) => a.kind === "person";

/** The field a too-long refusal names, for the dashboard's word for it. */
const FIELD_KEY: Record<string, string> = {
  "the title": "title", "the goal": "goal", "the scope": "scope", "the context": "context", "state": "state", "the result": "result",
  "the blocked reason": "blockedReason", "the reason": "reason", "the log line": "log", "the comment": "comment",
  "an acceptance item": "acceptance", "the description": "projectDescription", "the project's name": "projectName",
};

/** How many different emoji one comment may carry. */
export const MAX_REACTION_KINDS = 20;
/** Emoji, joiners, variation selectors, skin tones, keycaps and flags — and nothing else: a reaction is never markup. */
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200D\uFE0E\uFE0F\u20E3]|\p{Emoji_Modifier}|[0-9#*](?=\uFE0F?\u20E3))+$/u;
function checkEmoji(raw: string): string {
  const mark = typeof raw === "string" ? raw.trim() : "";
  if (!mark || length(mark) > 16 || !EMOJI_RE.test(mark) || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(mark)) {
    throw new TaskBoardError("invalid", "a reaction is one emoji", "reaction_invalid");
  }
  return mark;
}

function checkText(field: string, value: string, max: number): string {
  const v = value.trim();
  if (length(v) > max) throw new TaskBoardError("too_long", `${field} is too long: ${length(v)} characters, at most ${max}`, "too_long", [FIELD_KEY[field] ?? field, length(v), max]);
  return v;
}

function checkState(value: string): string {
  const v = checkText("state", value, CARD_LIMITS.state);
  const lines = v.split("\n").filter((l) => l.trim() !== "").length;
  if (lines > CARD_LIMITS.stateLines) {
    throw new TaskBoardError("too_long", `state is at most ${CARD_LIMITS.stateLines} lines (it has ${lines}): done / next / watch out; details go in the log`, "state_lines", [CARD_LIMITS.stateLines, lines]);
  }
  return v;
}

function checkAcceptance(items: string[], existing: AcceptanceItem[] = []): AcceptanceItem[] {
  return items.map((raw) => {
    const text = checkText("an acceptance item", raw, CARD_LIMITS.acceptanceText);
    if (!text) throw new TaskBoardError("invalid", "an acceptance item cannot be empty", "acceptance_empty");
    return { text, done: existing.find((e) => e.text === text)?.done ?? false };
  });
}

/** A dispatcher as written: an instance by name, the person writing it, or nobody (null, "", "none"). */
function toDispatcher(input: DispatcherInput, actor: Actor): Dispatcher | null {
  if (input === null) return null;
  if (input.kind === "person") {
    if (!isPerson(actor)) throw new TaskBoardError("forbidden", "only a person can name themselves the dispatcher");
    return { kind: "person", name: actor.name };
  }
  const name = normalizeAssignee(input.name);
  return name ? { kind: "instance", name } : null;
}
/**
 * A card an instance opened for itself and nobody handed out (its own review, its own notes): its own business, so it
 * neither counts toward nor is held to the cards-at-once limit (#2303's busy-fleet check: a reviewer opens one per
 * review and runs several). A sub task it splits off a card handed to it takes that card's dispatcher, so it counts.
 */
const openedForItself = (c: Card) => c.assignee !== null && c.createdBy === c.assignee && c.dispatcher === null;
const isDispatcher = (card: Card, actor: Actor) => card.dispatcher?.kind === "instance" && !isPerson(actor) && card.dispatcher.name === actor.name;
/**
 * #2434: who confirms a card in review. The person confirms the cards they handed out (#2426's rule for a blocked card,
 * for review too); an agent's card is the agents' own business: its instance dispatcher confirms it, and one nobody
 * handed out its assignee (or the instance that opened it). A person may still confirm any card.
 */
export const personConfirms = (card: Pick<Card, "dispatcher">) => card.dispatcher?.kind === "person";
function confirms(card: Card, actor: Actor): boolean {
  if (isPerson(actor)) return true;
  if (personConfirms(card)) return false;
  if (card.dispatcher?.kind === "instance") return card.dispatcher.name === actor.name;
  return card.assignee === actor.name || (card.assignee === null && card.createdBy === actor.name);
}
/** Who that is, in words (an error, the card's text). */
export function confirmerOf(card: Pick<Card, "dispatcher" | "assignee">): string {
  if (card.dispatcher?.kind === "person") return "the person";
  if (card.dispatcher?.kind === "instance") return card.dispatcher.name;
  return card.assignee ?? "its assignee";
}
/**
 * #2080: the instance that confirms a card in review (`confirms`' rule), or null when it is the person's — handed out by
 * them, or by an instance deleted since (`gone`), or nobody's at all.
 */
export function confirmingInstance(card: Pick<Card, "dispatcher" | "assignee" | "createdBy">, gone?: GoneDispatcher): string | null {
  if (personConfirms(card) || orphaned(card, gone)) return null;
  if (card.dispatcher?.kind === "instance") return card.dispatcher.name;
  return card.assignee ?? (card.createdBy || null);
}

function normalizeAssignee(raw: string | null | undefined): string | null {
  const v = raw?.trim() ?? "";
  if (v === "" || v.toLowerCase() === "none") return null;
  if (length(v) > CARD_LIMITS.assignee) throw new TaskBoardError("invalid", "the assignee's name is too long");
  return v;
}

/** "m3", "M - 3" → "M-3"; null when it is not a card number. */
export function cardCode(raw: string): string | null {
  const m = CODE_RE.exec(raw);
  return m ? `${m[1]!.toUpperCase()}-${Number(m[2])}` : null;
}

/**
 * An instance dispatcher that is no longer in the fleet (deleted): `gone(name)`, asked of the fleet. Its cards have no one
 * left to answer or confirm them but the person. Unknown (no `gone`): every dispatcher is there.
 */
export type GoneDispatcher = (name: string) => boolean;
const orphaned = (card: Pick<Card, "dispatcher">, gone?: GoneDispatcher) => !!gone && card.dispatcher?.kind === "instance" && gone(card.dispatcher.name);

/**
 * #2425: whether a card waits for the person — in review needing their confirmation, or blocked on a question the person
 * owns; both only when they handed it out (#2434: an agent's card in review is its dispatcher's to confirm), or when the
 * instance that handed it out was deleted since (`gone`: nobody else is left to answer it). The one rule for
 * waitingForPerson's query, Needs you and a button's route.
 */
export function waitsForPerson(card: Pick<Card, "status" | "needsReview" | "dispatcher">, gone?: GoneDispatcher): boolean {
  return (personConfirms(card) || orphaned(card, gone)) && ((card.status === "review" && card.needsReview) || card.status === "blocked");
}

export function requiresReview(card: Pick<Card, "needsReview">): boolean {
  return card.needsReview;
}

/**
 * What a finished card still lacks for the person's confirmation: unchecked acceptance items, no result. A main task
 * goes to review by itself when its last sub task is done (often a reviewer's), before its owner wrapped it up.
 */
export function wrapUpGap(card: Pick<Card, "acceptance" | "result">): { unchecked: number; noResult: boolean } | null {
  const unchecked = card.acceptance.filter((a) => !a.done).length;
  const noResult = !card.result.trim();
  return unchecked || noResult ? { unchecked, noResult } : null;
}

function parseJsonArray<T>(raw: unknown, fallback: T[]): T[] {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toCard(r: Row): Card {
  return {
    uuid: r.id as string,
    code: (r.code as string | null) ?? "",
    kind: r.kind === "sub" ? "sub" : "main",
    projectId: r.project_id === null || r.project_id === undefined ? null : Number(r.project_id),
    parent: (r.parent_id as string | null) ?? null,
    title: r.title as string,
    status: r.status as CardStatus,
    assignee: (r.assignee as string | null) ?? null,
    dispatcher: r.dispatcher ? { kind: r.dispatcher_kind === "person" ? "person" : "instance", name: r.dispatcher as string } : null,
    priority: (r.priority as CardPriority) ?? "normal",
    size: (r.size as CardSize | null) ?? null,
    needsReview: Number(r.needs_review) === 1,
    onBoard: Number(r.on_board) === 1,
    deps: parseJsonArray<string>(r.depends_on, []).filter((d): d is string => typeof d === "string"),
    goal: (r.description as string | null) ?? "",
    scope: (r.scope as string | null) ?? "",
    acceptance: parseJsonArray<AcceptanceItem>(r.acceptance, []),
    context: (r.context as string | null) ?? "",
    state: (r.state as string | null) ?? "",
    blockedReason: (r.blocked_reason as string | null) ?? "",
    result: (r.result as string | null) ?? "",
    sort: Number(r.sort ?? 0),
    createdBy: r.created_by as string,
    version: Number(r.version ?? 1),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    submittedAt: (r.submitted_at as string | null) ?? null,
    doneAt: (r.done_at as string | null) ?? null,
    seenEntryId: Number(r.seen_entry_id ?? 0),
  };
}

/**
 * #2352: a lead is a name, or none ("" and null alike). Whether it is one of the fleet's instances is the fleet's to
 * check (the board keeps names, as for an assignee); a lead no longer in fleet.yaml reads as none.
 */
function checkLeadInstance(raw: string | null): string | null {
  const name = (raw ?? "").trim();
  if (!name) return null;
  // eslint-disable-next-line no-control-regex
  if (name.length > 256 || /[\s\u0000-\u001f\u007f]/.test(name)) throw new TaskBoardError("invalid", "a lead is an instance's name", "lead_not_instance");
  return name;
}

function toProject(r: Row): Project {
  return {
    id: Number(r.id),
    name: r.name as string,
    description: r.description as string,
    archived: Number(r.archived) === 1,
    leadInstance: typeof r.lead_instance === "string" && r.lead_instance ? r.lead_instance : null,
    sort: Number(r.sort),
    createdAt: r.created_at as string,
  };
}

export class TaskBoard {
  private listeners: Array<(change: BoardChange) => void> = [];
  private cardLimit: (name: string) => number = () => 1;
  private boardOff: (name: string) => boolean = () => false;
  private routing: CommentRouting = { instances: () => [], enabled: () => true };
  private following: ProgressRouting = { enabled: () => true, leader: () => null };
  private contactGate: (source: string, target: string) => boolean = () => true;
  private pending: Array<{ code: string; uuid: string; actor: Actor; type: CardEventType | SignalType; data: Record<string, unknown>; audience?: CommentAudience }> = [];
  private projectsChanged = false;
  private notes: Note[] = [];
  /** The notes of the last write, until a caller of the `task` tool's old actions takes them (takeNotes). */
  private lastNotes: string[] = [];
  private codes = new Map<string, string>();
  /** Where files on cards live (task-files.ts); none: this process cannot take attachments (a bare board in a test, the CLI). */
  private fileStore: TaskFileStore | null = null;
  /** What undoes this write's file moves, when the write fails after them. */
  private undo: Array<() => void> = [];
  /** S-244: while the barrier flag is up, an open card is not claimed. Unset: today's claim. */
  private quiescence: QuiescenceGate | null = null;
  setQuiescence(gate: QuiescenceGate | null): void { this.quiescence = gate; }

  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  /** The store for files on cards (the fleet's scheduler sets it); null takes attachments away. */
  setFiles(store: TaskFileStore | null): void { this.fileStore = store; }
  files(): TaskFileStore | null { return this.fileStore; }

  /** Called with what each committed write changed. Returns an unsubscribe function. */
  onChange(listener: (change: BoardChange) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  // ── Schema ──────────────────────────────────────────────

  /**
   * Adds the board's columns and tables if missing, then backfills rows that have no card number yet (every task from
   * before the board, and any a release without the board created since), drops comments and history whose task is
   * gone, and lets main tasks catch up with their sub tasks. Safe to run on every open.
   */
  migrate(): void {
    const cols = new Set((this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name));
    const add = (name: string, decl: string) => {
      if (cols.has(name)) return;
      // The CLI and the fleet can open the file at the same moment: the other one adding it first is fine.
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${decl}`); } catch (err) { if (!/duplicate column/i.test(String(err))) throw err; }
    };
    add("code", "TEXT");
    add("kind", "TEXT");
    add("project_id", "INTEGER");
    add("parent_id", "TEXT");
    add("scope", "TEXT NOT NULL DEFAULT ''");
    add("acceptance", "TEXT NOT NULL DEFAULT '[]'");
    add("context", "TEXT NOT NULL DEFAULT ''");
    add("state", "TEXT NOT NULL DEFAULT ''");
    add("blocked_reason", "TEXT NOT NULL DEFAULT ''");
    add("size", "TEXT");
    add("needs_review", "INTEGER NOT NULL DEFAULT 0");
    add("version", "INTEGER NOT NULL DEFAULT 1");
    add("sort", "REAL");
    add("started_at", "TEXT");
    add("submitted_at", "TEXT");
    add("done_at", "TEXT");
    add("seen_entry_id", "INTEGER NOT NULL DEFAULT 0");
    add("dispatcher", "TEXT");
    add("dispatcher_kind", "TEXT");
    add("on_board", "INTEGER NOT NULL DEFAULT 0");                      // #2434; a row before it: its needs_review says so
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_code ON tasks(code);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE TABLE IF NOT EXISTS task_projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        archived    INTEGER NOT NULL DEFAULT 0,
        sort        REAL NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        author      TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        text        TEXT NOT NULL,
        at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_entries_task ON task_entries(task_id, id);
      CREATE TABLE IF NOT EXISTS task_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          TEXT NOT NULL,
        actor       TEXT NOT NULL,
        actor_kind  TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        type        TEXT NOT NULL,
        data        TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
      CREATE TABLE IF NOT EXISTS task_counters (prefix TEXT PRIMARY KEY, next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_watchers (
        task_id     TEXT NOT NULL,
        instance    TEXT NOT NULL,
        added_by    TEXT NOT NULL,
        at          TEXT NOT NULL,
        PRIMARY KEY (task_id, instance)
      );
      CREATE TABLE IF NOT EXISTS task_attachments (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
        entry_id    INTEGER,
        name        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        sha256      TEXT NOT NULL,
        author      TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id, at);
    `);
    // Comment threads (docs/design/task-board.md, "Comment threads"): columns added to the comments in place, and a table of
    // reactions. A release without them neither reads nor writes these; they are NULL on every older row.
    const entryCols = new Set((this.db.prepare("PRAGMA table_info(task_entries)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, decl] of [["parent_id", "INTEGER"], ["edited_at", "TEXT"], ["deleted_at", "TEXT"], ["deleted_by", "TEXT"], ["resolved_at", "TEXT"], ["resolved_by", "TEXT"], ["notify", "TEXT"], ["author_key", "TEXT"]] as const) {
      if (entryCols.has(name)) continue;
      try { this.db.exec(`ALTER TABLE task_entries ADD COLUMN ${name} ${decl}`); } catch (err) { if (!/duplicate column/i.test(String(err))) throw err; }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_entries_parent ON task_entries(parent_id);
      CREATE TABLE IF NOT EXISTS task_entry_reactions (
        entry_id    INTEGER NOT NULL,
        emoji       TEXT NOT NULL,
        by          TEXT NOT NULL,
        by_kind     TEXT NOT NULL,
        who         TEXT NOT NULL,
        at          TEXT NOT NULL,
        PRIMARY KEY (entry_id, emoji, who, by_kind)
      );
    `);
    // #2352: a project's lead instance, added in place (null: its waiting cards' buttons stay in General).
    const projectCols = new Set((this.db.prepare("PRAGMA table_info(task_projects)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!projectCols.has("lead_instance")) {
      try { this.db.exec("ALTER TABLE task_projects ADD COLUMN lead_instance TEXT"); } catch (err) { if (!/duplicate column/i.test(String(err))) throw err; }
    }
    // Every open (the CLI opens this file for each command) only reads: the write lock is taken only when a counter
    // is missing or a row needs a number. (CREATE … IF NOT EXISTS of what exists takes no lock; an INSERT does.)
    if ((this.db.prepare("SELECT COUNT(*) AS n FROM task_counters WHERE prefix IN ('M', 'S', 'R')").get() as { n: number }).n < 3) {
      this.db.exec("INSERT OR IGNORE INTO task_counters (prefix, next) VALUES ('M', 1), ('S', 1), ('R', 0)");
    }
    if (this.db.prepare("SELECT 1 FROM tasks WHERE code IS NULL OR sort IS NULL LIMIT 1").get()) {
      this.tx(() => {
        const rows = this.db.prepare("SELECT id, status, updated_at FROM tasks WHERE code IS NULL ORDER BY created_at, rowid").all() as Row[];
        const fill = this.db.prepare("UPDATE tasks SET code = ?, kind = 'main', sort = COALESCE(sort, ?), done_at = COALESCE(done_at, ?) WHERE id = ?");
        for (const r of rows) fill.run(this.nextCode("M"), this.nextSort(), r.status === "done" ? r.updated_at : null, r.id);
        this.db.exec("UPDATE tasks SET sort = rowid WHERE sort IS NULL");
        if (rows.length) { this.projectsChanged = true; }
      });
    }
    this.reconcile();
  }

  /**
   * Main tasks whose sub tasks moved while nothing derived them (under a release without the board). Read first; the
   * write lock only when one is out of step.
   */
  reconcile(): void {
    const rows = this.db.prepare("SELECT DISTINCT p.* FROM tasks p JOIN tasks c ON c.parent_id = p.id WHERE p.kind = 'main' AND p.status NOT IN ('cancelled', 'blocked')").all() as Row[];
    const behind = rows.map(toCard).filter((main) => this.derivedStatus(main) !== main.status);
    if (!behind.length) return;
    this.tx(() => { for (const main of behind) { const fresh = this.byUuid(main.uuid); if (fresh) this.deriveMain(fresh, SYSTEM_ACTOR); } });
  }

  /** The board's revision: it moves with every committed change, so a page reads the board again only when it moved. */
  revision(): number {
    return Number((this.db.prepare("SELECT next FROM task_counters WHERE prefix = 'R'").get() as { next: number } | undefined)?.next ?? 0);
  }

  // ── Projects ────────────────────────────────────────────

  listProjects(includeArchived = false): Project[] {
    const rows = this.db.prepare(`SELECT * FROM task_projects ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY archived, sort, id`).all() as Row[];
    return rows.map(toProject);
  }

  /** By id, or by name (case-insensitive). */
  getProject(ref: string | number): Project {
    const text = String(ref).trim();
    const row = /^\d+$/.test(text)
      ? this.db.prepare("SELECT * FROM task_projects WHERE id = ?").get(Number(text)) as Row | undefined
      : this.db.prepare("SELECT * FROM task_projects WHERE name = ?").get(text) as Row | undefined;
    if (!row) {
      const names = this.listProjects().map((p) => p.name);
      throw new TaskBoardError("not_found", `no project "${text}"${names.length ? ` (projects: ${names.join(", ")})` : ""}`, "project_not_found", [text]);
    }
    return toProject(row);
  }

  /**
   * A person or an instance creates a project (#3195, the user's decision 9af8d799: agents organize the board). Its
   * lead, and every later change to it (name, description, archiving: updateProject), stay a person's.
   */
  createProject(actor: Actor, input: { name: string; description?: string; leadInstance?: string | null }): Project {
    if (!isPerson(actor) && input.leadInstance) this.personOnly(actor, "set a project's lead");
    return this.tx(() => {
      const name = this.checkProjectName(input.name, null);
      const description = checkText("the description", input.description ?? "", CARD_LIMITS.projectDescription);
      const { s } = this.db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM task_projects").get() as { s: number };
      const lead = checkLeadInstance(input.leadInstance ?? null);
      const row = this.db.prepare("INSERT INTO task_projects (name, description, sort, created_at, lead_instance) VALUES (?, ?, ?, ?, ?) RETURNING *")
        .get(name, description, s, this.nowIso(), lead) as Row;
      this.projectsChanged = true;
      return toProject(row);
    });
  }

  updateProject(actor: Actor, id: number, patch: { name?: string; description?: string; archived?: boolean; leadInstance?: string | null }): Project {
    this.personOnly(actor, "change a project");
    return this.tx(() => {
      const project = this.getProject(id);
      if (patch.name !== undefined) project.name = this.checkProjectName(patch.name, project.id);
      if (patch.description !== undefined) project.description = checkText("the description", patch.description, CARD_LIMITS.projectDescription);
      if (patch.archived !== undefined) project.archived = patch.archived;
      if (patch.leadInstance !== undefined) project.leadInstance = checkLeadInstance(patch.leadInstance);
      this.db.prepare("UPDATE task_projects SET name = ?, description = ?, archived = ?, lead_instance = ? WHERE id = ?")
        .run(project.name, project.description, project.archived ? 1 : 0, project.leadInstance, project.id);
      this.projectsChanged = true;
      return project;
    });
  }

  private checkProjectName(raw: string, selfId: number | null): string {
    const name = checkText("the project's name", raw, CARD_LIMITS.projectName);
    if (!name) throw new TaskBoardError("invalid", "a project needs a name", "project_name_empty");
    if (/^\d+$/.test(name)) throw new TaskBoardError("invalid", "a project's name cannot be only digits", "project_name_digits");
    const clash = this.db.prepare("SELECT id FROM task_projects WHERE name = ?").get(name) as Row | undefined;
    if (clash && Number(clash.id) !== selfId) throw new TaskBoardError("invalid", `there is already a project named "${name}"`, "project_name_taken", [name]);
    return name;
  }

  /** A new main task's project: the one asked for (not archived), or none. */
  private projectForMain(ref: string | number | null | undefined): number | null {
    if (ref === undefined || ref === null || String(ref).trim() === "") return null;
    const project = this.getProject(ref);
    if (project.archived) throw new TaskBoardError("invalid", `project "${project.name}" is archived; it takes no new main tasks`, "project_archived", [project.name]);
    return project.id;
  }

  // ── Reading ─────────────────────────────────────────────

  /** #2801: when the card's status or assignee last changed (ISO), or null — a notice older than that is stale. */
  lastChangeAt(uuid: string): string | null {
    const r = this.db.prepare("SELECT MAX(at) AS at FROM task_events WHERE task_id = ? AND type IN ('created', 'moved', 'assigned')").get(uuid) as { at: string | null } | undefined;
    return r?.at ?? null;
  }

  /** A card by number (M-3), uuid, or a unique uuid prefix of at least 8 hex digits. */
  findCard(ref: string): Card | undefined {
    const text = (ref ?? "").trim();
    if (!text) return undefined;
    const code = cardCode(text);
    if (code) {
      const r = this.db.prepare("SELECT * FROM tasks WHERE code = ?").get(code) as Row | undefined;
      return r ? toCard(r) : undefined;
    }
    const exact = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(text) as Row | undefined;
    if (exact) return toCard(exact);
    if (!/^[0-9a-f]{8,}$/i.test(text)) return undefined;
    const rows = this.db.prepare("SELECT * FROM tasks WHERE id LIKE ? || '%' LIMIT 2").all(text.toLowerCase()) as Row[];
    return rows.length === 1 ? toCard(rows[0]!) : undefined;
  }

  getCard(ref: string): Card {
    const card = this.findCard(ref);
    if (!card) throw new TaskBoardError("not_found", `no card ${cardCode(ref) ?? `"${ref}"`}`, "card_not_found", [cardCode(ref) ?? ref]);
    return card;
  }

  private byUuid(uuid: string): Card | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(uuid) as Row | undefined;
    return r ? toCard(r) : undefined;
  }

  /** A uuid's card number, for views and messages ("?" for one that is gone). */
  codeOf(uuid: string): string {
    const known = this.codes.get(uuid);
    if (known) return known;
    const r = this.db.prepare("SELECT code FROM tasks WHERE id = ?").get(uuid) as { code: string | null } | undefined;
    const code = r?.code ?? uuid.slice(0, 8);
    if (r?.code) this.codes.set(uuid, r.code);
    return code;
  }

  children(uuid: string): Card[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort").all(uuid) as Row[]).map(toCard);
  }

  /** Sub tasks that still count (not cancelled). A main task with none is worked on directly. */
  activeSubs(uuid: string): Card[] {
    return this.children(uuid).filter((k) => k.status !== "cancelled");
  }

  progress(card: Card): Progress {
    const p: Progress = { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 };
    for (const k of this.activeSubs(card.uuid)) {
      p.total++;
      if (k.status !== "cancelled") p[k.status]++;
    }
    return p;
  }

  /**
   * Dependencies that are not done (a cancelled one still holds its dependents, as the fleet's `task` tool always
   * had it). A sub task also waits for its main task's. A dependency that no longer exists does not hold anything.
   */
  unmetDeps(card: Card): Card[] {
    const own = card.deps.map((id) => this.byUuid(id)).filter((c): c is Card => !!c && c.status !== "done");
    const main = card.parent ? this.byUuid(card.parent) : undefined;
    if (!main) return own;
    return [...own, ...this.unmetDeps(main).filter((c) => !own.some((o) => o.uuid === c.uuid))];
  }

  /**
   * What the board shows: live cards, and finished ones from the last `days` — done or cancelled main tasks, done sub
   * tasks — or every done main task with `allDone` (the Done column's "All"). Older finished work stays in the
   * database and in the projects' numbers (projectStats), not in every board read.
   */
  boardCards(days = BOARD_DAYS, allDone = false, archiveDays = 0): Card[] {
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    if (archiveDays > 0) {
      // M-3668: finished main tasks until they are archived (`allDone` no longer reads past it: the Archive list does).
      // #4428 review: an archived main task's sub tasks go with it (isArchived), even one done more recently.
      const kept = new Date(this.now().getTime() - archiveDays * 86_400_000).toISOString();
      return (this.db.prepare(
        `SELECT * FROM tasks WHERE
           (kind = 'main' AND (status NOT IN ('done', 'cancelled') OR COALESCE(done_at, updated_at) >= ?))
           OR (kind = 'sub' AND status != 'cancelled' AND (status != 'done' OR COALESCE(done_at, updated_at) >= ?)
               AND NOT EXISTS (SELECT 1 FROM tasks m WHERE m.id = tasks.parent_id AND m.status IN ('done', 'cancelled') AND COALESCE(m.done_at, m.updated_at) < ?))
         ORDER BY sort`,
      ).all(kept, since, kept) as Row[]).map(toCard);
    }
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE
         (kind = 'main' AND (status NOT IN ('done', 'cancelled') OR (status = 'done' AND (? OR COALESCE(done_at, updated_at) >= ?)) OR (status = 'cancelled' AND updated_at >= ?)))
         OR (kind = 'sub' AND status != 'cancelled' AND (status != 'done' OR COALESCE(done_at, updated_at) >= ?))
       ORDER BY sort`,
    ).all(allDone ? 1 : 0, since, since, since) as Row[];
    return rows.map(toCard);
  }

  /**
   * #4428 review: ` AND …` leaving out the cards that name one of `names` (assigned to, created by or handed out by one:
   * the public link's hiding, web-api boardHiding), with its values; empty when none.
   */
  private unseen(names: readonly string[] = []): { sql: string; args: string[] } {
    const out = [...new Set(names)];
    if (!out.length) return { sql: "", args: [] };
    const marks = out.map(() => "?").join(", ");
    return { sql: ` AND (assignee IS NULL OR assignee NOT IN (${marks})) AND created_by NOT IN (${marks}) AND (dispatcher IS NULL OR dispatcher NOT IN (${marks}))`,
      args: [...out, ...out, ...out] };
  }

  /**
   * #4428 review: what time alone changes in a board read and its numbers — how many finished cards have passed each
   * of its lines (archived, out of this week's count, out of the recent window) — with the archive age. A card passes a
   * line without a write (the revision stays), so a page's "same revision" read is answered `unchanged` only when this
   * matches too. One counting pass, no rows. `leaveOut`: as projectStats (the public link's hidden instances' cards never
   * move it).
   */
  boardEpoch(archiveDays = 0, days = BOARD_DAYS, leaveOut: readonly string[] = []): string {
    const nowMs = this.now().getTime();
    const at = (ms: number) => new Date(nowMs - ms).toISOString();
    const kept = archiveDays > 0 ? at(archiveDays * 86_400_000) : "", week = at(WEEK_MS), since = at(days * 86_400_000), hide = this.unseen(leaveOut);
    const r = this.db.prepare(
      `SELECT
         COALESCE(SUM(kind = 'main' AND status IN ('done', 'cancelled') AND COALESCE(done_at, updated_at) < ?), 0) AS archived,
         COALESCE(SUM(kind = 'main' AND status = 'done' AND COALESCE(done_at, updated_at) < ?), 0) AS week,
         COALESCE(SUM(status IN ('done', 'cancelled') AND (CASE WHEN kind = 'main' AND status = 'cancelled' THEN updated_at ELSE COALESCE(done_at, updated_at) END) < ?), 0) AS old
       FROM tasks WHERE 1${hide.sql}`,
    ).get(kept, week, since, ...hide.args) as { archived: number; week: number; old: number };
    return `${archiveDays}:${r.archived}:${r.week}:${r.old}`;
  }

  /**
   * Each project's numbers (by id; "none" for No project) over all its cards, finished ones included: main tasks,
   * work units (a main task's sub tasks, or one unit for a main task without them; a done main task counts all its
   * units done), cards waiting for the person and blocked, and the last change. One pass over the table. #2080: waiting
   * counts only the cards in review the person confirms (waitsForPerson, `gone` as for Needs you), never an agent's.
   * #4428 review: `leaveOut` names (the public link's hidden instances) — their cards, and a hidden main task's sub tasks,
   * count nowhere, as the board read leaves them out.
   */
  projectStats(gone?: GoneDispatcher, archiveDays = 0, leaveOut: readonly string[] = []): Record<string, ProjectStats> {
    const all = this.db.prepare("SELECT id, kind, status, project_id, parent_id, updated_at, done_at, needs_review, dispatcher, dispatcher_kind, assignee, created_by FROM tasks").all() as Row[];
    const unseenNames = new Set(leaveOut);
    const names = (r: Row) => [r.assignee, r.created_by, r.dispatcher].some((n) => typeof n === "string" && unseenNames.has(n));
    const hiddenMains = unseenNames.size ? new Set(all.filter((r) => r.kind === "main" && names(r)).map((r) => r.id as string)) : new Set<string>();
    const rows = unseenNames.size ? all.filter((r) => !names(r) && !(r.kind === "sub" && hiddenMains.has(r.parent_id as string))) : all;
    const nowMs = this.now().getTime(), kept = archiveDays > 0 ? new Date(nowMs - archiveDays * 86_400_000).toISOString() : null;
    const week = new Date(nowMs - WEEK_MS).toISOString();
    const finished = (r: Row) => ((r.done_at as string | null) ?? (r.updated_at as string));
    // M-3668: an archived main task (and its sub tasks) is left out of every number but `archived`.
    const archivedMains = new Set(kept ? rows.filter((r) => r.kind === "main" && (r.status === "done" || r.status === "cancelled") && finished(r) < kept).map((r) => r.id as string) : []);
    const subs = new Map<string, Progress>();
    for (const r of rows) {
      if (r.kind !== "sub" || !r.parent_id || r.status === "cancelled" || archivedMains.has(r.parent_id as string)) continue;
      const p = subs.get(r.parent_id as string) ?? { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 };
      p.total++;
      p[r.status as Exclude<CardStatus, "cancelled">]++;
      subs.set(r.parent_id as string, p);
    }
    const out: Record<string, ProjectStats> = {};
    for (const r of rows) {
      const key = r.project_id === null || r.project_id === undefined ? "none" : String(r.project_id);
      const st = out[key] ??= { mains: 0, units: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, percent: 0, waiting: 0, blocked: 0, lastActivity: null, archived: 0, doneWeek: 0, archivedWeek: 0 };
      if (!st.lastActivity || (r.updated_at as string) > st.lastActivity) st.lastActivity = r.updated_at as string;
      const status = r.status as CardStatus;
      if (r.kind === "main" && status === "done" && finished(r) >= week) { st.doneWeek++; if (archivedMains.has(r.id as string)) st.archivedWeek++; }
      if (archivedMains.has(r.id as string)) { st.archived++; continue; }
      if (r.kind === "sub" && archivedMains.has(r.parent_id as string)) continue;
      if (status === "cancelled") continue;
      if (status === "review" && waitsForPerson({ status, needsReview: Number(r.needs_review) === 1,
        dispatcher: r.dispatcher ? { kind: r.dispatcher_kind === "person" ? "person" : "instance", name: r.dispatcher as string } : null }, gone)) st.waiting++;
      if (status === "blocked") st.blocked++;
      if (r.kind === "sub") continue;
      st.mains++;
      const p = subs.get(r.id as string);
      if (status === "done") { const n = p?.total || 1; st.units.total += n; st.units.done += n; }
      else if (p?.total) for (const k of ["total", "open", "claimed", "blocked", "review", "done"] as const) st.units[k] += p[k];
      else { st.units.total++; st.units[status]++; }
    }
    for (const st of Object.values(out)) st.percent = st.units.total ? Math.round((st.units.done / st.units.total) * 100) : 0;
    return out;
  }

  /** M-3668: whether the dashboard has archived this card (a sub task goes with its main task). */
  isArchived(card: Card, archiveDays: number): boolean {
    if (archiveDays <= 0) return false;
    const main = card.kind === "sub" && card.parent ? this.byUuid(card.parent) : card;
    if (!main || main.kind !== "main" || (main.status !== "done" && main.status !== "cancelled")) return false;
    return (main.doneAt ?? main.updatedAt) < new Date(this.now().getTime() - archiveDays * 86_400_000).toISOString();
  }

  /**
   * M-3668: a project's archived main tasks (`project` null: No project), the most recently finished first, a page at a
   * time (`before`: the last one's cursor), and who they were assigned to (the list's filter, `assignee`).
   * `leaveOut`: names whose cards the reader may not see (assigned to, created by or handed out by one) — left out
   * before the page, its cursor, the total and the assignees are worked out, so none of them tells of such a card.
   */
  archiveList(project: number | null, archiveDays: number, opts: { before?: string | null; limit?: number; assignee?: string | null; leaveOut?: readonly string[] } = {}):
    { cards: Card[]; next: string | null; total: number; assignees: string[] } {
    if (archiveDays <= 0) return { cards: [], next: null, total: 0, assignees: [] };
    const kept = new Date(this.now().getTime() - archiveDays * 86_400_000).toISOString();
    const hide = this.unseen(opts.leaveOut);
    const where = `kind = 'main' AND status IN ('done', 'cancelled') AND COALESCE(done_at, updated_at) < ? AND ${project === null ? "project_id IS NULL" : "project_id = ?"}${hide.sql}`;
    const base: unknown[] = [kept, ...(project === null ? [] : [project]), ...hide.args];
    const assignees = (this.db.prepare(`SELECT DISTINCT assignee FROM tasks WHERE ${where} AND assignee IS NOT NULL ORDER BY assignee`).all(...base) as { assignee: string }[]).map((r) => r.assignee);
    const who = opts.assignee ? " AND assignee = ?" : "", whoArgs = opts.assignee ? [opts.assignee] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}${who}`).get(...base, ...whoArgs) as { n: number }).n;
    const cursor = typeof opts.before === "string" ? /^(.+)\|([^|]+)$/.exec(opts.before) : null;
    const after = cursor ? " AND (COALESCE(done_at, updated_at) < ? OR (COALESCE(done_at, updated_at) = ? AND id < ?))" : "";
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${where}${who}${after} ORDER BY COALESCE(done_at, updated_at) DESC, id DESC LIMIT ?`)
      .all(...base, ...whoArgs, ...(cursor ? [cursor[1], cursor[1], cursor[2]] : []), limit + 1) as Row[];
    const cards = rows.slice(0, limit).map(toCard);
    const last = cards[cards.length - 1];
    return { cards, next: rows.length > limit && last ? `${last.doneAt ?? last.updatedAt}|${last.uuid}` : null, total, assignees };
  }

  view(card: Card, scope: ReadScope = {}, gone?: GoneDispatcher): CardView {
    return this.views([card], scope, gone)[0]!;
  }

  /** ` AND <column> NOT IN (…)` for a scope's left-out authors, with its values (empty when none). */
  private notBy(scope: ReadScope, column: string): { sql: string; args: string[] } {
    const names = scope.leaveOutAuthors ?? [];
    return names.length ? { sql: ` AND ${column} NOT IN (${names.map(() => "?").join(", ")})`, args: [...names] } : { sql: "", args: [] };
  }

  /**
   * Many cards as the dashboard draws them, from one read of what they need — every task's number, status,
   * dependencies and parent, sub-task counts, comment counts, the last comment and the unseen ones — instead of a few
   * queries per card: a board read stays a handful of statements however many cards it has (it runs on the fleet's
   * event loop). Same answers as progress(), unmetDeps() and newComments() card by card.
   */
  views(cards: Card[], scope: ReadScope = {}, gone?: GoneDispatcher): CardView[] {
    if (!cards.length) return [];
    type Light = { code: string; status: CardStatus; deps: string[]; parent: string | null };
    const all = new Map<string, Light>();
    const progress = new Map<string, Progress>();
    for (const r of this.db.prepare("SELECT id, code, status, depends_on, parent_id FROM tasks").all() as Row[]) {
      const light: Light = { code: (r.code as string | null) ?? (r.id as string).slice(0, 8), status: r.status as CardStatus, deps: parseJsonArray<string>(r.depends_on, []), parent: (r.parent_id as string | null) ?? null };
      all.set(r.id as string, light);
      if (light.parent && light.status !== "cancelled") {
        const p = progress.get(light.parent) ?? { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 };
        p.total++;
        p[light.status]++;
        progress.set(light.parent, p);
      }
    }
    const by = this.notBy(scope, "author"), eBy = this.notBy(scope, "e.author");
    const comments = new Map((this.db.prepare(
      `SELECT e.task_id AS task_id, n.n AS n, e.author AS author, e.author_kind AS author_kind, e.at AS at FROM task_entries e
       JOIN (SELECT task_id, COUNT(*) AS n, MAX(id) AS last FROM task_entries WHERE kind IN ('comment', 'reject', 'approve') AND deleted_at IS NULL${by.sql} GROUP BY task_id) n ON e.id = n.last`,
    ).all(...by.args) as Array<{ task_id: string; n: number; author: string; author_kind: Actor["kind"]; at: string }>).map((r) => [r.task_id, r]));
    const files = new Map((this.db.prepare(`SELECT task_id, COUNT(*) AS n FROM task_attachments WHERE 1 = 1${by.sql} GROUP BY task_id`)
      .all(...by.args) as Array<{ task_id: string; n: number }>).map((r) => [r.task_id, r.n]));
    const unseen = new Map((this.db.prepare(
      `SELECT t.id AS id, COUNT(e.id) AS n FROM tasks t JOIN task_entries e
         ON e.task_id = t.id AND e.id > t.seen_entry_id AND e.kind IN ('comment', 'reject') AND e.deleted_at IS NULL AND e.author IS NOT t.assignee${eBy.sql}
       GROUP BY t.id`,
    ).all(...eBy.args) as Array<{ id: string; n: number }>).map((r) => [r.id, r.n]));
    const code = (uuid: string) => all.get(uuid)?.code ?? uuid.slice(0, 8);
    /** unmetDeps(), on the light rows: own dependencies not done, then the main task's, each once. */
    const unmet = (deps: string[], parent: string | null, seen = new Set<string>()): string[] => {
      const out: string[] = [];
      for (const d of deps) { const dep = all.get(d); if (dep && dep.status !== "done" && !seen.has(d)) { seen.add(d); out.push(dep.code); } }
      const main = parent ? all.get(parent) : undefined;
      return main ? [...out, ...unmet(main.deps, main.parent, seen)] : out;
    };
    return cards.map((card) => {
      const c = comments.get(card.uuid);
      return {
        id: card.code,
        waitsForPerson: waitsForPerson(card, gone),
        confirmer: confirmingInstance(card, gone),
        uuid: card.uuid,
        kind: card.kind,
        projectId: card.projectId,
        parentId: card.parent ? code(card.parent) : null,
        title: card.title,
        status: card.status,
        assignee: card.assignee,
        dispatcher: card.dispatcher,
        priority: card.priority,
        size: card.size,
        needsReview: card.needsReview,
        dependsOn: card.deps.filter((d) => all.has(d)).map(code),     // a missing one holds nothing, and could not be named
        goal: card.goal,
        scope: card.scope,
        acceptance: card.acceptance,
        context: card.context,
        state: card.state,
        blockedReason: card.blockedReason,
        result: card.result,
        sort: card.sort,
        createdBy: card.createdBy,
        version: card.version,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        startedAt: card.startedAt,
        submittedAt: card.submittedAt,
        doneAt: card.doneAt,
        progress: card.kind === "main" ? progress.get(card.uuid) ?? { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 } : null,
        unmetDeps: unmet(card.deps, card.parent),
        commentCount: c?.n ?? 0,
        attachmentCount: files.get(card.uuid) ?? 0,
        newCommentCount: unseen.get(card.uuid) ?? 0,
        lastComment: c ? { author: c.author, authorKind: c.author_kind, at: c.at } : null,
      };
    });
  }

  detail(ref: string, scope: ReadScope = {}, gone?: GoneDispatcher): CardDetail {
    const card = this.getCard(ref);
    const parent = card.parent ? this.byUuid(card.parent) : undefined;
    return {
      card: this.view(card, scope, gone),
      parent: parent ? { id: parent.code, title: parent.title, status: parent.status } : null,
      children: this.views(this.children(card.uuid), scope, gone),
      comments: this.entries(card.uuid, ["comment", "reject", "approve"], 200),
      logs: this.entries(card.uuid, ["log"], 200),
      history: this.events(card.uuid, 200).filter((e) => e.type !== "reordered"),
      attachments: this.attachments(card.uuid, scope),
      watchers: this.watchersOf(card.uuid),
      inheritedWatchers: card.parent ? this.watchersOf(card.parent) : [],
      leader: this.leaderOf(card),
      followsProgress: this.following.enabled(),
    };
  }

  /**
   * #2757 review: the instance dispatchers on the board that `gone` says are gone, as one string — what a cached read
   * that names waitsForPerson / confirmer must also be keyed by (a dispatcher deleted changes them, the revision not).
   */
  goneDispatchers(gone?: GoneDispatcher): string {
    if (!gone) return "";
    const rows = this.db.prepare("SELECT DISTINCT dispatcher FROM tasks WHERE dispatcher IS NOT NULL AND (dispatcher_kind IS NULL OR dispatcher_kind != 'person')").all() as Row[];
    return rows.map((r) => r.dispatcher as string).filter((n) => gone(n)).sort().join("\u0000");
  }

  /** The latest `limit` entries of a card, oldest first. */
  entries(uuid: string, kinds: EntryKind[], limit = 20): Entry[] {
    const rows = this.db.prepare(`SELECT * FROM task_entries WHERE task_id = ? AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY id DESC LIMIT ?`)
      .all(uuid, ...kinds, limit) as Row[];
    return this.withReactions(rows.map((r) => this.toEntry(r)).reverse());
  }

  /** The entries with the reactions on each (oldest first), in one read. */
  private withReactions(entries: Entry[]): Entry[] {
    const comments = entries.filter((e) => e.kind === "comment" && !e.deleted);
    if (!comments.length) return entries;
    const marks = comments.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT entry_id, emoji, by, by_kind FROM task_entry_reactions WHERE entry_id IN (${marks}) ORDER BY at, rowid`)
      .all(...comments.map((e) => e.id)) as Array<{ entry_id: number; emoji: string; by: string; by_kind: Actor["kind"] }>;
    if (!rows.length) return entries;
    const byEntry = new Map<number, Reaction[]>();
    for (const r of rows) {
      const list = byEntry.get(r.entry_id) ?? [];
      let one = list.find((x) => x.emoji === r.emoji);
      if (!one) { one = { emoji: r.emoji, by: [] }; list.push(one); }
      one.by.push({ name: r.by, kind: r.by_kind });
      byEntry.set(r.entry_id, list);
    }
    return entries.map((e) => (byEntry.has(e.id) ? { ...e, reactions: byEntry.get(e.id)! } : e));
  }

  /** Comments and rejections by others that the assignee has not acted on yet. */
  newComments(card: Card): Entry[] {
    const rows = this.db.prepare("SELECT * FROM task_entries WHERE task_id = ? AND id > ? AND kind IN ('comment', 'reject') AND author IS NOT ? AND deleted_at IS NULL ORDER BY id")
      .all(card.uuid, card.seenEntryId, card.assignee) as Row[];
    return rows.map((r) => this.toEntry(r));
  }

  events(uuid: string, limit = 20): CardEvent[] {
    const rows = this.db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(uuid, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      at: r.at as string,
      actor: r.actor as string,
      actorKind: r.actor_kind as Actor["kind"],
      cardId: this.codeOf(r.task_id as string),
      type: r.type as CardEventType,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
    })).reverse();
  }

  private toEntry(r: Row): Entry {
    const deleted = typeof r.deleted_at === "string" ? { at: r.deleted_at, by: (r.deleted_by as string | null) ?? "" } : null;
    return {
      id: Number(r.id),
      cardId: this.codeOf(r.task_id as string),
      kind: r.kind as EntryKind,
      author: r.author as string,
      authorKind: r.author_kind as Actor["kind"],
      text: deleted ? "" : (r.text as string),
      at: r.at as string,
      ...(r.parent_id !== null && r.parent_id !== undefined ? { parentId: Number(r.parent_id) } : {}),
      ...(typeof r.edited_at === "string" && !deleted ? { editedAt: r.edited_at } : {}),
      ...(deleted ? { deleted } : {}),
      ...(typeof r.resolved_at === "string" ? { resolved: { at: r.resolved_at, by: (r.resolved_by as string | null) ?? "" } } : {}),
    };
  }

  /**
   * Cards matching a phrase in their number, title, text fields, checklist or comments; live cards first, newest
   * first. `match` says where it matched when it is not the title.
   */
  search(query: string, limit = 20, scope: ReadScope = {}): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const max = Math.min(Math.max(limit, 1), 50);
    const hits: SearchHit[] = [];
    if (cardCode(q)) {
      const exact = this.findCard(q);
      if (exact) hits.push({ card: exact, match: null });
    }
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // Named, as the rest of this statement: the left-out authors are :a0, :a1, …
    const names = scope.leaveOutAuthors ?? [];
    const notBy = { sql: names.length ? ` AND e.author NOT IN (${names.map((_, i) => `:a${i}`).join(", ")})` : "", params: Object.fromEntries(names.map((n, i) => [`a${i}`, n])) };
    const text = ["title", "description", "scope", "context", "state", "result", "blocked_reason"].map((f) => `t.${f} LIKE :q ESCAPE '\\'`).join(" OR ");
    const rows = this.db.prepare(
      `SELECT * FROM tasks t
       WHERE ${text}
         OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(t.acceptance) THEN t.acceptance ELSE '[]' END) j WHERE json_extract(j.value, '$.text') LIKE :q ESCAPE '\\')
         OR EXISTS (SELECT 1 FROM task_entries e WHERE e.task_id = t.id AND e.text LIKE :q ESCAPE '\\'${notBy.sql})
       ORDER BY CASE WHEN t.status IN ('done', 'cancelled') THEN 1 ELSE 0 END, t.updated_at DESC
       LIMIT :max`,
    ).all({ q: like, max, ...notBy.params }) as Row[];
    for (const card of rows.map(toCard)) {
      if (!hits.some((h) => h.card.uuid === card.uuid)) hits.push({ card, match: this.matchOf(card, q, like, notBy) });
    }
    return hits.slice(0, max);
  }

  /**
   * The cards offered while a card number is typed in a chat (what follows the `#`, "" for nothing yet): those
   * whose number starts with it ("m1", "M-1", "12" → M-1, M-12, S-12…; the exact number first), then those whose title
   * holds it; with nothing typed, the latest changes. Live cards before finished ones in each part. `keep` leaves a card out
   * (the public link's hidden instances) before the limit is applied.
   */
  suggest(query: string, limit = 8, keep?: (card: Card) => boolean): Card[] {
    const q = query.replace(/^#/, "").trim();
    const max = Math.min(Math.max(Math.floor(limit) || 1, 1), 50);
    const escape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
    const order = "CASE WHEN status IN ('done', 'cancelled') THEN 1 ELSE 0 END, updated_at DESC";
    const out: Card[] = [];
    const add = (rows: Row[]) => {
      for (const card of rows.map(toCard)) if (!out.some((c) => c.uuid === card.uuid) && (!keep || keep(card))) out.push(card);
    };
    if (!q) {
      add(this.db.prepare(`SELECT * FROM tasks ORDER BY ${order} LIMIT 200`).all() as Row[]);
      return out.slice(0, max);
    }
    const num = /^([MmSs])?\s*-?\s*(\d*)$/.exec(q);
    if (num && (num[1] || num[2])) {
      const letters = num[1] ? [num[1].toUpperCase()] : ["M", "S"];
      const exact = num[2] ? cardCode(`${letters[0]}-${num[2]}`) : null;
      add(this.db.prepare(
        `SELECT * FROM tasks WHERE ${letters.map(() => "code LIKE ? ESCAPE '\\'").join(" OR ")}
         ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END, ${order} LIMIT 200`,
      ).all(...letters.map((l) => `${l}-${escape(num[2] ?? "")}%`), exact ?? "") as Row[]);
    }
    add(this.db.prepare(`SELECT * FROM tasks WHERE title LIKE ? ESCAPE '\\' ORDER BY ${order} LIMIT 200`).all(`%${escape(q)}%`) as Row[]);
    return out.slice(0, max);
  }

  private matchOf(card: Card, q: string, like: string, notBy: { sql: string; params: Record<string, string> } = { sql: "", params: {} }): SearchHit["match"] {
    const needle = q.toLowerCase();
    if (card.title.toLowerCase().includes(needle)) return null;
    const snippet = (value: string) => {
      const i = value.toLowerCase().indexOf(needle);
      const start = Math.max(0, i - 20);
      const end = Math.min(value.length, i + q.length + 30);
      return `${start > 0 ? "…" : ""}${value.slice(start, end).replace(/\s+/g, " ")}${end < value.length ? "…" : ""}`;
    };
    for (const key of ["goal", "scope", "context", "state", "result", "blockedReason"] as const) {
      if (card[key].toLowerCase().includes(needle)) return { field: key, text: snippet(card[key]) };
    }
    const item = card.acceptance.find((a) => a.text.toLowerCase().includes(needle));
    if (item) return { field: "acceptance", text: snippet(item.text) };
    const entry = this.db.prepare(`SELECT kind, text FROM task_entries e WHERE task_id = :id AND text LIKE :q ESCAPE '\\'${notBy.sql} ORDER BY id DESC LIMIT 1`)
      .get({ id: card.uuid, q: like, ...notBy.params }) as { kind: EntryKind; text: string } | undefined;
    if (entry) return { field: entry.kind === "log" ? "log" : "comment", text: snippet(entry.text) };
    return null;
  }

  /**
   * Cards by project (an id or name; null: No project), main task (its sub tasks), assignee and status (live ones by
   * default), main tasks first, then by status and priority; at most `limit` (default 50), with how many matched.
   */
  listCards(filter: { project?: string | number | null; parent?: string; assignee?: string; status?: CardStatus[]; limit?: number; after?: string }): { cards: Card[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.project !== undefined) {
      if (filter.project === null) where.push("project_id IS NULL");
      else { where.push("project_id = ?"); params.push(this.getProject(filter.project).id); }
    }
    if (filter.parent) { where.push("parent_id = ?"); params.push(this.getCard(filter.parent).uuid); }
    if (filter.assignee) { where.push("assignee = ?"); params.push(filter.assignee); }
    const statuses = filter.status?.length ? filter.status : LIVE_CARD_STATUSES;
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
    const from = `FROM tasks WHERE ${where.join(" AND ")}`;
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number };
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const order = `CASE kind WHEN 'main' THEN 0 ELSE 1 END, ${STATUS_ORDER}, ${PRIORITY_ORDER}, sort, id`;
    let offset = 0;
    if (filter.after !== undefined) {
      const ids = this.db.prepare(`SELECT id ${from} ORDER BY ${order}`).all(...params) as { id: string }[];
      const index = ids.findIndex(r => r.id === filter.after);
      if (index < 0) throw new TaskBoardError("invalid", "cursor is invalid for this list; restart with the same filters");
      offset = index + 1;
    }
    const rows = this.db.prepare(`SELECT * ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
    return { cards: rows.map(toCard), total: n };
  }

  /**
   * On the board's terms: opened on it (#2434), in a project, a sub task, one with sub tasks, or one that waits for
   * review (every main task opened on the board before #2434 did).
   */
  isOnBoard(card: Card): boolean {
    return card.onBoard || card.projectId !== null || card.kind === "sub" || card.needsReview || this.activeSubs(card.uuid).length > 0;
  }

  /**
   * An instance's work, for `task mine`: what it is doing, what is blocked or waits for the person, what it can start
   * (its own open cards, and the unassigned sub tasks of main tasks it coordinates, dependencies done) and what waits
   * on dependencies; comments it has not seen and work sent back; the main tasks it coordinates and how far along.
   */
  /** Who holds a live card (open, in progress, blocked, waiting for the person): the instances, and any other name. */
  liveAssignees(): string[] {
    return (this.db.prepare("SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL AND status IN ('open', 'claimed', 'blocked', 'review') ORDER BY assignee").all() as Row[])
      .map((r) => r.assignee as string);
  }

  myWork(name: string): MyWork {
    const mine = (this.db.prepare(`SELECT * FROM tasks WHERE assignee = ? AND status IN ('open', 'claimed', 'blocked', 'review') ORDER BY ${STATUS_ORDER}, ${PRIORITY_ORDER}, sort`)
      .all(name) as Row[]).map(toCard);
    const coordinating = mine.filter((c) => c.kind === "main" && this.activeSubs(c.uuid).length > 0);
    const work = mine.filter((c) => !coordinating.includes(c));
    const unassigned = coordinating.length
      ? (this.db.prepare(`SELECT * FROM tasks WHERE assignee IS NULL AND status = 'open' AND parent_id IN (${coordinating.map(() => "?").join(", ")}) ORDER BY ${PRIORITY_ORDER}, sort`)
        .all(...coordinating.map((c) => c.uuid)) as Row[]).map(toCard)
      : [];
    const candidates = [...work.filter((c) => c.status === "open"), ...unassigned];
    const unmet = candidates.map((card) => ({ card, waitsFor: this.unmetDeps(card).map((d) => d.code) }));
    const newComments: MyWork["newComments"] = [];
    const sentBack: MyWork["sentBack"] = [];
    for (const card of mine) {
      const fresh = this.newComments(card);
      const reject = [...fresh].reverse().find((e) => e.kind === "reject");
      if (reject) sentBack.push({ card, entry: reject });
      const comments = fresh.filter((e) => e.kind === "comment");
      if (comments.length) newComments.push({ card, entries: comments });
    }
    return {
      doing: work.filter((c) => c.status === "claimed"),
      blocked: work.filter((c) => c.status === "blocked"),
      review: work.filter((c) => c.status === "review"),
      ready: unmet.filter((x) => !x.waitsFor.length).map((x) => x.card),
      waiting: unmet.filter((x) => x.waitsFor.length),
      newComments,
      sentBack,
      mains: coordinating.map((card) => ({ card, progress: this.progress(card) })),
    };
  }

  /** #2434: whether `actor` confirms `card` (finishes it from review): the person their cards, an agent's its dispatcher. */
  confirms(card: Card, actor: Actor): boolean { return confirms(card, actor); }

  /** #2434: the cards an instance handed out that wait in review for its confirmation (its `task mine`). */
  toConfirm(name: string): Card[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status = 'review' AND needs_review = 1 AND (dispatcher_kind IS NULL OR dispatcher_kind != 'person') AND dispatcher = ? AND (assignee IS NULL OR assignee != ?) ORDER BY updated_at")
      .all(name, name) as Row[]).map(toCard);
  }

  /**
   * What waits for the person (step 3: Needs you, and the daily summary): cards in review that need their confirmation,
   * and blocked cards whose question is theirs to answer — oldest first, each with when it started waiting (its last
   * move to that status).
   *
   * A blocked card asks the person only when the person handed it out (dispatcher kind "person"). One an instance handed
   * out is that instance's to decide (step 2's wakes: its question goes there, not here). One with no dispatcher is an
   * instance's own "I'm waiting" — every card the `task` tool kept before the board, an agent's card for itself, a
   * reviewer's "waiting on the author" — and is no question to the person: 2.3.0-beta.24 listed 28 such cards, weeks
   * old, as "stuck, asking you" (#2425). Nothing is changed on the cards; they stay on the board as they are. One an
   * instance handed out that was deleted since (`gone`) has nobody else to answer or confirm it: it falls back to the
   * person.
   */
  waitingForPerson(gone?: GoneDispatcher): Array<{ card: Card; since: string }> {
    const waiting = "((status = 'review' AND needs_review = 1) OR status = 'blocked')";
    const rows = [
      ...(this.db.prepare(`SELECT * FROM tasks WHERE dispatcher_kind = 'person' AND ${waiting}`).all() as Row[]).map(toCard),
      ...(gone ? (this.db.prepare(`SELECT * FROM tasks WHERE dispatcher IS NOT NULL AND (dispatcher_kind IS NULL OR dispatcher_kind != 'person') AND ${waiting}`).all() as Row[])
        .map(toCard).filter((card) => orphaned(card, gone)) : []),
    ];
    const moved = this.db.prepare("SELECT at FROM task_events WHERE task_id = ? AND type = 'moved' AND json_extract(data, '$.to') = ? ORDER BY id DESC LIMIT 1");
    return rows.map((card) => {
      const at = (moved.get(card.uuid, card.status) as { at: string } | undefined)?.at;
      // Never updatedAt (#2425): a card edited every minute (a note, a heartbeat) would get a new `since` — and so a new
      // Needs-you item id, posted again at the bottom as if it were new, once a minute.
      return { card, since: at ?? card.submittedAt ?? card.createdAt };
    }).sort((a, b) => a.since.localeCompare(b.since));
  }

  /** Cards by their numbers, in one read (the ones that exist; #2341 review: the cards a summary line named). */
  cardsByCode(codes: string[]): Card[] {
    const out: Card[] = [];
    for (let i = 0; i < codes.length; i += 500) {
      const chunk = codes.slice(i, i + 500);
      out.push(...(this.db.prepare(`SELECT * FROM tasks WHERE code IN (${chunk.map(() => "?").join(", ")})`).all(...chunk) as Row[]).map(toCard));
    }
    return out;
  }

  /**
   * myWork() for many names in one read (the dashboard's Instances list, GET /ui/tasks/work): the live cards, every
   * card's light row (sub tasks, dependencies) and the live cards' unseen entries, each read once — three statements
   * however many names and cards (#2316 review: N myWork() calls cost tens of ms on the fleet's event loop). Same
   * answers as myWork() name by name; tests/task-board-work-2316.test.ts pins both.
   */
  workOf(names: string[]): Map<string, MyWork> {
    const out = new Map<string, MyWork>();
    if (!names.length) return out;
    const live = (this.db.prepare(`SELECT * FROM tasks WHERE status IN ('open', 'claimed', 'blocked', 'review') ORDER BY ${STATUS_ORDER}, ${PRIORITY_ORDER}, sort`).all() as Row[]).map(toCard);
    type Light = { code: string; status: CardStatus; deps: string[]; parent: string | null };
    const all = new Map<string, Light>();
    const subs = new Map<string, Progress>();
    for (const r of this.db.prepare("SELECT id, code, status, depends_on, parent_id FROM tasks").all() as Row[]) {
      const light: Light = { code: (r.code as string | null) ?? (r.id as string).slice(0, 8), status: r.status as CardStatus, deps: parseJsonArray<string>(r.depends_on, []), parent: (r.parent_id as string | null) ?? null };
      all.set(r.id as string, light);
      if (light.parent && light.status !== "cancelled") {
        const p = subs.get(light.parent) ?? { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 };
        p.total++;
        p[light.status]++;
        subs.set(light.parent, p);
      }
    }
    // Unseen entries of the live cards: comments and rejections by anyone but the card's assignee, after what it saw.
    const fresh = new Map<string, Entry[]>();
    for (const r of this.db.prepare(
      `SELECT e.* FROM task_entries e JOIN tasks t ON e.task_id = t.id
       WHERE t.status IN ('open', 'claimed', 'blocked', 'review') AND e.id > t.seen_entry_id AND e.kind IN ('comment', 'reject') AND e.deleted_at IS NULL AND e.author IS NOT t.assignee ORDER BY e.id`,
    ).all() as Row[]) {
      const list = fresh.get(r.task_id as string) ?? [];
      list.push({ id: Number(r.id), cardId: all.get(r.task_id as string)?.code ?? (r.task_id as string).slice(0, 8), kind: r.kind as EntryKind, author: r.author as string,
        authorKind: r.author_kind as Actor["kind"], text: r.text as string, at: r.at as string });
      fresh.set(r.task_id as string, list);
    }
    /** unmetDeps(), on the light rows: own dependencies that exist and are not done, then the main task's not yet named. */
    const unmet = (deps: string[], parent: string | null): string[] => {
      const own = deps.filter((d) => { const dep = all.get(d); return !!dep && dep.status !== "done"; });
      const main = parent ? all.get(parent) : undefined;
      return main ? [...own, ...unmet(main.deps, main.parent).filter((d) => !own.includes(d))] : own;
    };
    const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2 };
    const byPriority = (a: Card, b: Card) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || a.sort - b.sort;
    const openUnassigned = live.filter((c) => c.assignee === null && c.status === "open");
    for (const name of new Set(names)) {
      const mine = live.filter((c) => c.assignee === name);
      const coordinating = mine.filter((c) => c.kind === "main" && (subs.get(c.uuid)?.total ?? 0) > 0);
      const work = mine.filter((c) => !coordinating.includes(c));
      const theirs = new Set(coordinating.map((c) => c.uuid));
      const unassigned = coordinating.length ? openUnassigned.filter((c) => c.parent !== null && theirs.has(c.parent)).sort(byPriority) : [];
      const candidates = [...work.filter((c) => c.status === "open"), ...unassigned].map((card) => ({ card, waitsFor: unmet(card.deps, card.parent).map((d) => all.get(d)!.code) }));
      const newComments: MyWork["newComments"] = [];
      const sentBack: MyWork["sentBack"] = [];
      for (const card of mine) {
        const entries = fresh.get(card.uuid) ?? [];
        const reject = [...entries].reverse().find((e) => e.kind === "reject");
        if (reject) sentBack.push({ card, entry: reject });
        const comments = entries.filter((e) => e.kind === "comment");
        if (comments.length) newComments.push({ card, entries: comments });
      }
      out.set(name, {
        doing: work.filter((c) => c.status === "claimed"),
        blocked: work.filter((c) => c.status === "blocked"),
        review: work.filter((c) => c.status === "review"),
        ready: candidates.filter((x) => !x.waitsFor.length).map((x) => x.card),
        waiting: candidates.filter((x) => x.waitsFor.length),
        newComments,
        sentBack,
        mains: coordinating.map((card) => ({ card, progress: { ...(subs.get(card.uuid) as Progress) } })),
      });
    }
    return out;
  }

  // ── Writing: the board ──────────────────────────────────

  createCards(actor: Actor, input: { project?: string | number | null; parent?: string | null; cards: NewCard[] }): { cards: Card[]; notes: string[]; said: Note[] } {
    if (input.cards.length === 0) throw new TaskBoardError("invalid", "no cards to create");
    if (input.cards.length > BATCH_MAX) throw new TaskBoardError("invalid", `at most ${BATCH_MAX} cards at a time`);
    return this.tx(() => {
      const created: Card[] = [];
      const mains = new Set<string>();
      input.cards.forEach((spec, i) => {
        const which = input.cards.length > 1 ? `card ${i + 1}: ` : "";
        try {
          const parentRef = spec.parent !== undefined ? spec.parent : (input.parent ?? null);
          const kind: CardKind = spec.kind ?? (parentRef ? "sub" : "main");
          let parent: Card | null = null;
          let projectId: number | null;
          if (kind === "main") {
            if (parentRef) throw new TaskBoardError("invalid", "a main task has no parent; for a sub task use kind \"sub\"");
            projectId = this.projectForMain(spec.project !== undefined ? spec.project : input.project);
          } else {
            if (!parentRef) throw new TaskBoardError("invalid", "a sub task needs its main task (parent)");
            parent = this.resolveParent(this.resolveRef(parentRef, created), actor);
            projectId = parent.projectId;
          }
          const title = checkText("the title", spec.title ?? "", CARD_LIMITS.title);
          if (!title) throw new TaskBoardError("invalid", "a card needs a title", "title_empty");
          if (kind === "sub" && spec.scope) throw new TaskBoardError("invalid", "scope is for main tasks only", "scope_main_only");
          const acceptance = checkAcceptance(spec.acceptance ?? []);
          if (acceptance.length > CARD_LIMITS.acceptanceItems) throw new TaskBoardError("too_long", `at most ${CARD_LIMITS.acceptanceItems} acceptance items`, "acceptance_max", [CARD_LIMITS.acceptanceItems]);
          const now = this.nowIso();
          const assignee = spec.assignee !== undefined ? normalizeAssignee(spec.assignee) : isPerson(actor) ? null : actor.name;
          this.checkAssignable(assignee);
          const opener: Dispatcher | null = isPerson(actor) ? { kind: "person", name: actor.name }
            : actor.kind === "instance" && assignee && assignee !== actor.name ? { kind: "instance", name: actor.name } : null;
          const dispatcher = spec.dispatcher !== undefined ? toDispatcher(spec.dispatcher, actor) : (parent?.dispatcher ?? opener);
          // #2434: a main task waits for the person's confirmation when the person handed it out; an agent's needs none
          // unless it asks for one (its dispatcher then confirms it).
          const needsReview = spec.needsReview ?? (kind === "main" && dispatcher?.kind === "person");
          const card: Card = {
            uuid: randomUUID(),
            code: this.nextCode(kind === "main" ? "M" : "S"),
            kind,
            projectId,
            parent: parent?.uuid ?? null,
            title,
            status: "open",
            assignee,
            dispatcher,
            priority: spec.priority ?? "normal",
            size: spec.size ?? null,
            needsReview,
            onBoard: true,
            deps: this.checkDeps({ uuid: null, kind, parent: parent?.uuid ?? null }, (spec.dependsOn ?? []).map((d) => this.resolveRef(d, created))),
            goal: checkText("the goal", spec.goal ?? "", CARD_LIMITS.goal),
            scope: checkText("the scope", spec.scope ?? "", CARD_LIMITS.scope),
            acceptance,
            context: checkText("the context", spec.context ?? "", CARD_LIMITS.context),
            state: "",
            blockedReason: "",
            result: "",
            sort: this.nextSort(),
            createdBy: actor.name,
            version: 1,
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            submittedAt: null,
            doneAt: null,
            seenEntryId: 0,
          };
          this.insert(card);
          this.codes.set(card.uuid, card.code);
          this.event(actor, card, "created", { kind, project: projectId, parent: parent?.code ?? null, title, assignee: card.assignee, ...(card.dispatcher ? { dispatcher: card.dispatcher.name } : {}) });
          created.push(card);
          if (card.parent) mains.add(card.parent);
        } catch (err) {
          if (err instanceof TaskBoardError) throw new TaskBoardError(err.code, `${which}${err.message}`, err.key, err.args);
          throw err;
        }
      });
      for (const card of created) this.assertNoCycle(card.uuid);
      for (const uuid of mains) this.deriveMain(this.byUuid(uuid)!, actor);
      return { cards: created, ...this.spoken() };
    });
  }

  updateCard(actor: Actor, ref: string, patch: CardPatch): MutationResult {
    return this.tx(() => {
      const card = this.getCard(ref);
      this.checkVersion(card, patch.version);
      const ai = !isPerson(actor);
      const editsContent = (["title", "goal", "scope", "context", "state", "result", "blockedReason", "size", "priority", "needsReview", "dependsOn", "acceptance", "addAcceptance", "check", "uncheck", "dispatcher"] as const)
        .some((k) => patch[k] !== undefined);
      if (ai && editsContent && !this.canEdit(card, actor)) {
        throw new TaskBoardError("forbidden", `${card.code} belongs to ${card.assignee}; you can only comment on it`);
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set = <K extends keyof Card>(key: K, value: Card[K], shown: string = key, show?: (v: Card[K]) => unknown) => {
        if (JSON.stringify(card[key]) !== JSON.stringify(value)) {
          changes[shown] = { from: show ? show(card[key]) : card[key], to: show ? show(value) : value };
          card[key] = value;
        }
      };

      if (patch.title !== undefined) {
        const title = checkText("the title", patch.title, CARD_LIMITS.title);
        if (!title) throw new TaskBoardError("invalid", "the title cannot be empty", "title_empty");
        set("title", title);
      }
      if (patch.goal !== undefined) set("goal", checkText("the goal", patch.goal, CARD_LIMITS.goal));
      if (patch.scope !== undefined) {
        if (card.kind !== "main") throw new TaskBoardError("invalid", "scope is for main tasks only", "scope_main_only");
        set("scope", checkText("the scope", patch.scope, CARD_LIMITS.scope));
      }
      if (patch.context !== undefined) set("context", checkText("the context", patch.context, CARD_LIMITS.context));
      if (patch.state !== undefined) set("state", checkState(patch.state));
      if (patch.result !== undefined) set("result", checkText("the result", patch.result, CARD_LIMITS.result));
      if (patch.blockedReason !== undefined) {
        if (card.status !== "blocked") throw new TaskBoardError("invalid", "only a blocked card has a blocked reason", "blocked_reason_not_blocked");
        const reason = checkText("the blocked reason", patch.blockedReason, CARD_LIMITS.blockedReason);
        if (!reason) throw new TaskBoardError("invalid", "the blocked reason cannot be empty", "block_reason");
        set("blockedReason", reason);
      }
      if (patch.size !== undefined) set("size", patch.size);
      if (patch.priority !== undefined) set("priority", patch.priority);
      if (patch.dispatcher !== undefined) {
        const next = toDispatcher(patch.dispatcher, actor);
        // #2434: the person's card stays theirs — an instance re-dispatching it would take it out of their confirmation.
        const moved = JSON.stringify(next) !== JSON.stringify(card.dispatcher);
        if (ai && personConfirms(card) && moved) {
          throw new TaskBoardError("forbidden", `${card.code} was handed out by the person; only they hand it to someone else`);
        }
        // #2436 review: nor an agent's card that waits for its dispatcher's confirmation — dropping or replacing the
        // dispatcher would let its assignee confirm it itself. Only that dispatcher (or a person) hands it on.
        if (ai && moved && card.needsReview && card.dispatcher?.kind === "instance" && card.dispatcher.name !== actor.name) {
          throw new TaskBoardError("forbidden", `${card.code} waits for ${card.dispatcher.name}'s confirmation; only they hand it to someone else`);
        }
        set("dispatcher", next, "dispatcher", (d) => d?.name ?? null);
      }
      if (patch.needsReview !== undefined) {
        if (ai && card.needsReview && !patch.needsReview && !confirms(card, actor)) {
          throw new TaskBoardError("forbidden", personConfirms(card) ? "only a person can clear \"needs review\"" : `only ${confirmerOf(card)} can clear "needs review" on ${card.code}`);
        }
        set("needsReview", patch.needsReview);
      }
      if (patch.dependsOn !== undefined) {
        const next = this.checkDeps(card, patch.dependsOn);
        if (ai && card.createdBy !== actor.name) {
          const dropped = card.deps.filter((d) => !next.includes(d)).map((d) => this.byUuid(d)).filter((c): c is Card => !!c && c.status !== "done");
          if (dropped.length) {
            throw new TaskBoardError("forbidden", `you cannot drop dependencies that are not done (${dropped.map((c) => c.code).join(", ")}); ask whoever opened the card, or the person`);
          }
        }
        set("deps", next, "dependsOn", (v) => v.map((d) => this.codeOf(d)));
      }
      if (patch.projectId !== undefined && patch.projectId !== card.projectId) {
        if (card.kind !== "main") throw new TaskBoardError("invalid", "a sub task follows its main task's project; move the main task", "sub_project");
        // #3195 (9af8d799): an instance moves a main task between projects when it may edit that card; a person always.
        if (ai && !this.canEdit(card, actor)) throw new TaskBoardError("forbidden", `${card.code} belongs to ${card.assignee}; only its assignee, its creator, its dispatcher or a person can move it to another project`);
        const projectId = this.projectForMain(patch.projectId);
        set("projectId", projectId);
        this.db.prepare("UPDATE tasks SET project_id = ? WHERE parent_id = ?").run(projectId, card.uuid);
      }

      if (patch.acceptance !== undefined || patch.addAcceptance !== undefined || patch.check !== undefined || patch.uncheck !== undefined) {
        let acceptance = patch.acceptance !== undefined ? checkAcceptance(patch.acceptance, card.acceptance) : card.acceptance.map((a) => ({ ...a }));
        if (patch.addAcceptance) acceptance = [...acceptance, ...checkAcceptance(patch.addAcceptance)];
        if (acceptance.length > CARD_LIMITS.acceptanceItems) throw new TaskBoardError("too_long", `at most ${CARD_LIMITS.acceptanceItems} acceptance items`, "acceptance_max", [CARD_LIMITS.acceptanceItems]);
        const mark = (indexes: number[] | undefined, done: boolean) => {
          for (const n of indexes ?? []) {
            if (!Number.isInteger(n) || n < 1 || n > acceptance.length) throw new TaskBoardError("invalid", `there is no acceptance item ${n} (there are ${acceptance.length})`, "acceptance_no_item", [n, acceptance.length]);
            acceptance[n - 1]!.done = done;
          }
        };
        mark(patch.check, true);
        mark(patch.uncheck, false);
        set("acceptance", acceptance);
      }

      let touched = Object.keys(changes).length > 0;
      if (patch.assignee !== undefined) {
        const next = normalizeAssignee(patch.assignee);
        if (next !== card.assignee) {
          if (ai && !(card.assignee === null || card.assignee === actor.name || card.createdBy === actor.name)) {
            throw new TaskBoardError("forbidden", `${card.code} belongs to ${card.assignee}; you cannot reassign it`);
          }
          this.assign(card, next, actor);
          touched = true;
        }
      }
      if (patch.log !== undefined) {
        const text = checkText("the log line", patch.log.replace(/\s*\n\s*/g, " "), CARD_LIMITS.log);
        if (text) {
          this.entry(card, "log", actor, text);
          this.event(actor, card, "logged", { text });
          touched = true;
        }
      }
      if ((patch.replyTo !== undefined || patch.to !== undefined) && patch.comment === undefined && !patch.attach?.length) {
        throw new TaskBoardError("invalid", "replyTo and to go with a comment", "reply_needs_comment");
      }
      if (patch.comment !== undefined || patch.attach?.length) {
        if (this.writeComment(card, actor, patch.comment ?? "", patch.attach, false, { replyTo: patch.replyTo, to: patch.to })) touched = true;
      }

      if (!touched) return { card, notes: ["no change"], said: [] };
      card.version++;
      card.updatedAt = this.nowIso();
      this.surfaceComments(card, actor);
      this.markSeen(card, actor);
      this.save(card);
      if (changes.dependsOn) this.assertNoCycle(card.uuid);
      if (Object.keys(changes).length) this.event(actor, card, "updated", { changes });
      if (changes.acceptance && card.status === "claimed" && card.acceptance.every((a) => a.done)) {
        this.say("acceptance_all", [card.code, requiresReview(card) ? "review" : "done"], `every acceptance item is checked: ${card.code} can move to ${requiresReview(card) ? "review" : "done"}`);
      }
      return { card, ...this.spoken() };
    });
  }

  moveCard(actor: Actor, ref: string, to: CardStatus, options: MoveOptions = {}): MutationResult & { from: CardStatus } {
    return this.tx(() => {
      const card = this.getCard(ref);
      this.checkVersion(card, options.version);
      const from = card.status;
      if (from === to) throw new TaskBoardError("invalid", `${card.code} is already ${to}`, "already", [card.code, to]);
      const reason = checkText("the reason", options.reason ?? "", CARD_LIMITS.reason);
      if (options.result !== undefined) {
        const result = checkText("the result", options.result, CARD_LIMITS.result);
        if (result !== card.result) {
          this.event(actor, card, "updated", { changes: { result: { from: card.result, to: result } } });
          card.result = result;
        }
      }

      // Back from blocked a reason has nothing else to be: it is the answer, a comment its assignee reads.
      const comment = options.comment ?? (from === "blocked" && to === "claimed" && reason ? reason : undefined);
      const derived = card.kind === "main" && this.activeSubs(card.uuid).length > 0;
      // A dispatcher's answer does not start work its assignee has no room for (#2303 review): the answer is kept on the
      // card as a comment the assignee reads, and the card waits, blocked, until the assignee resumes it.
      if (from === "blocked" && to === "claimed" && !derived && card.assignee && card.assignee !== actor.name && isDispatcher(card, actor) && this.isOnBoard(card)) {
        this.checkAnswer(card, comment);
        const busy = this.busyWith(card, card.assignee);
        if (busy.length) {
          // #2801 review: the one comment that is news — the answer its assignee waits for (`kept`).
          this.writeComment(card, actor, comment!, options.attach, true);
          card.version++;
          card.updatedAt = this.nowIso();
          this.save(card);
          const codes = busy.map((c) => c.code).join(", ");
          this.say("answer_kept", [card.assignee, codes, card.code], `${card.assignee} is working on ${codes}: your answer is on ${card.code} as a comment, and it stays blocked until ${card.assignee} resumes it`);
          return { card, from, ...this.spoken() };
        }
      }
      if (derived) this.checkDerivedMove(card, actor, to, reason, { comment });
      else this.checkManualMove(card, actor, to, reason, { comment });

      this.applyMove(card, actor, this.ownReview(card, actor, to, reason), reason, comment, options.attach);
      return { card, from, ...this.spoken() };
    });
  }

  /**
   * Place a card between two neighbours of its column (`after` comes right before it, `before` right after it).
   * Order is presentation only, so the version does not change.
   */
  reorder(actor: Actor, ref: string, after: string | null, before: string | null): Card {
    return this.tx(() => {
      const card = this.getCard(ref);
      const a = after ? this.getCard(after).sort : null;
      const b = before ? this.getCard(before).sort : null;
      let sort: number;
      if (a !== null && b !== null) {
        // Halving the gap again and again runs out of numbers: spread every card out again first.
        if (Math.abs(b - a) < 1e-6) { this.renumber(); return this.reorder(actor, ref, after, before); }
        sort = (a + b) / 2;
      } else if (a !== null) sort = a + 1;
      else if (b !== null) sort = b - 1;
      else return card;
      if (sort === card.sort) return card;
      card.sort = sort;
      this.save(card);
      this.event(actor, card, "reordered", {});
      return card;
    });
  }

  // ── Comment threads (docs/design/task-board.md, "Comment threads") ──

  /** One comment of a card, as stored; refused when the card has none by that number. */
  private commentRow(card: Card, id: number): Row {
    const row = this.db.prepare("SELECT * FROM task_entries WHERE id = ? AND task_id = ? AND kind = 'comment'").get(id, card.uuid) as Row | undefined;
    if (!row) throw new TaskBoardError("not_found", `${card.code} has no comment c${id}`, "comment_not_found", [card.code, `c${id}`]);
    return row;
  }

  /** The comment as a read gives it, with its reactions. */
  private commentOf(card: Card, id: number): Entry {
    return this.withReactions([this.toEntry(this.commentRow(card, id))])[0]!;
  }

  /**
   * Who wrote a comment: the same kind (a person, an instance or a script) and, for a comment that kept its writer's key, the same key —
   * whatever name each uses now (a person who renamed themselves is still the author; two people with one name are not each other, and a
   * session with no key is not a keyed comment's author). Only a comment with no key (one written before keys were kept, an instance's, a
   * script's) falls back to the name, and then to its original author's kind and name alone: it cannot tell two same-named sessions apart.
   */
  private wroteComment(row: Row, actor: Actor): boolean {
    if (row.author_kind !== actor.kind) return false;
    if (typeof row.author_key === "string" && row.author_key) return !!actor.key && row.author_key === actor.key;
    return row.author === actor.name;
  }

  /** Who a reaction is by, as stored: a person's key when the session has one, else the name — the name alone never stands in for a key. */
  private reactor(actor: Actor): string {
    return actor.kind === "person" && actor.key ? `key:${actor.key}` : `name:${actor.name}`;
  }

  /** The reactions `actor` made on a card's comments, as `<comment number>|<emoji>` (the dashboard marks those chips the viewer's). */
  reactedBy(ref: string, actor: Actor): Set<string> {
    const card = this.getCard(ref);
    const rows = this.db.prepare(`SELECT r.entry_id AS id, r.emoji AS emoji FROM task_entry_reactions r JOIN task_entries e ON e.id = r.entry_id WHERE e.task_id = ? AND r.who = ? AND r.by_kind = ?`)
      .all(card.uuid, this.reactor(actor), actor.kind) as Array<{ id: number; emoji: string }>;
    return new Set(rows.map((r) => `${r.id}|${r.emoji}`));
  }

  /** The numbers of the comments on a card that `actor` wrote (the dashboard marks them `mine`: those are theirs to edit). */
  commentsWrittenBy(ref: string, actor: Actor): Set<number> {
    const card = this.getCard(ref);
    const rows = this.db.prepare("SELECT * FROM task_entries WHERE task_id = ? AND kind = 'comment' AND deleted_at IS NULL").all(card.uuid) as Row[];
    return new Set(rows.filter((r) => this.wroteComment(r, actor)).map((r) => Number(r.id)));
  }

  /**
   * The history's "commented" event keeps the comment's words (`data.text`); when the comment changes or goes, so does that
   * copy. An event written since the thread work names its entry. An older one (it names none) is the comment's own when it was
   * written at the same time by the same author with the same words: of those, the one closest in time to the comment — exactly
   * one, so deleting one "ok" never blanks the card's other "ok" lines.
   */
  private rewriteCommentEvents(card: Card, row: Row, to: string): void {
    const events = this.db.prepare("SELECT id, at, actor, actor_kind, data FROM task_events WHERE task_id = ? AND type = 'commented'").all(card.uuid) as Array<{ id: number; at: string; actor: string; actor_kind: string; data: string }>;
    const update = this.db.prepare("UPDATE task_events SET data = ? WHERE id = ?");
    const wrote = Date.parse(String(row.at));
    let legacy: { id: number; data: Record<string, unknown>; gap: number } | null = null;
    for (const e of events) {
      let data: Record<string, unknown>;
      try { data = JSON.parse(e.data) as Record<string, unknown>; } catch { continue; }
      if (data.entry !== undefined) { if (data.entry === Number(row.id)) update.run(JSON.stringify({ ...data, text: to }), e.id); continue; }
      if (e.actor !== row.author || e.actor_kind !== row.author_kind || data.text !== row.text) continue;
      const gap = Math.abs((Date.parse(e.at) || 0) - (Number.isFinite(wrote) ? wrote : 0));
      if (!legacy || gap < legacy.gap || (gap === legacy.gap && e.id < legacy.id)) legacy = { id: e.id, data, gap };
    }
    if (legacy) update.run(JSON.stringify({ ...legacy.data, text: to }), legacy.id);
  }

  /**
   * The author changes a comment's words (a person or an instance alike; never someone else's). Nothing is woken for it —
   * except the instances the new words `@`-name that the old ones did not, and only those (docs/design/task-board.md, "Comment
   * threads"). Marked edited; the card's version does not move (a comment never held a version).
   */
  editComment(actor: Actor, ref: string, id: number, raw: string): MutationResult & { entry: Entry } {
    return this.tx(() => {
      const card = this.getCard(ref);
      const row = this.commentRow(card, id);
      if (typeof row.deleted_at === "string") throw new TaskBoardError("invalid", `comment c${id} on ${card.code} was deleted`, "comment_deleted", [`c${id}`]);
      if (!this.wroteComment(row, actor)) throw new TaskBoardError("forbidden", `only its author can edit comment c${id} on ${card.code}`, "comment_not_yours", [`c${id}`]);
      const text = checkText("the comment", raw, CARD_LIMITS.comment);
      if (!text) throw new TaskBoardError("invalid", "the comment cannot be empty", "comment_empty");
      if (text === row.text) return { card, notes: ["no change"], said: [], entry: this.commentOf(card, id) };
      const names = [...this.routing.instances()];
      const before = new Set(parseMentions(row.text as string, names).names);
      const added = parseMentions(text, names).names.filter((n) => !before.has(n));
      // What the comment named stays counted: the stored `@` names (those of its words as written, for a row from before they were
      // stored) and, added, the names the new words bring — so taking an `@` out does not take its turn out of the loop guard.
      const kept = this.storedNotify(row, names);
      const notify = { ...kept, at: [...new Set([...kept.at, ...added])] };
      this.db.prepare("UPDATE task_entries SET text = ?, edited_at = ?, notify = ? WHERE id = ?").run(text, this.nowIso(), JSON.stringify(notify), id);
      this.rewriteCommentEvents(card, row, text);
      this.signal(actor, card, "comment_edited", { entry: id, text }, added.length ? this.routeComment(actor, card, text, false, { only: added }) : undefined);
      return { card, ...this.spoken(), entry: this.commentOf(card, id) };
    });
  }

  /**
   * Deletes a comment: its author, or a person (an administrator's dashboard session). The words, the reactions and the files
   * that came with it go; the entry stays as a placeholder, so the replies under it still hang from something. Wakes nobody.
   */
  deleteComment(actor: Actor, ref: string, id: number): MutationResult & { entry: Entry } {
    const removed: Array<{ uuid: string; file: string }> = [];
    const result = this.tx(() => {
      const card = this.getCard(ref);
      const row = this.commentRow(card, id);
      if (typeof row.deleted_at === "string") return { card, notes: ["no change"], said: [], entry: this.commentOf(card, id) };
      if (!this.wroteComment(row, actor) && !isPerson(actor)) throw new TaskBoardError("forbidden", `only its author or a person can delete comment c${id} on ${card.code}`, "comment_delete_forbidden", [`c${id}`]);
      this.rewriteCommentEvents(card, row, "");
      this.db.prepare("UPDATE task_entries SET text = '', deleted_at = ?, deleted_by = ? WHERE id = ?").run(this.nowIso(), actor.name, id);
      this.db.prepare("DELETE FROM task_entry_reactions WHERE entry_id = ?").run(id);
      for (const f of this.db.prepare("SELECT id FROM task_attachments WHERE entry_id = ?").all(id) as Array<{ id: string }>) removed.push({ uuid: card.uuid, file: f.id });
      this.db.prepare("DELETE FROM task_attachments WHERE entry_id = ?").run(id);
      this.signal(actor, card, "comment_deleted", { entry: id });
      return { card, ...this.spoken(), entry: this.commentOf(card, id) };
    });
    // The rows are gone for good; the files follow (one that cannot be removed now is swept as an orphan later).
    const store = this.fileStore;
    if (store) for (const f of removed) { try { store.removeFile(f.uuid, f.file); } catch { /* swept later */ } }
    return result;
  }

  /** Puts an emoji on a comment, or takes the actor's back (`on: false`). Anyone who may read the card may react; nobody is woken. */
  react(actor: Actor, ref: string, id: number, emoji: string, on: boolean): MutationResult & { entry: Entry } {
    return this.tx(() => {
      const card = this.getCard(ref);
      const row = this.commentRow(card, id);
      if (typeof row.deleted_at === "string") throw new TaskBoardError("invalid", `comment c${id} on ${card.code} was deleted`, "comment_deleted", [`c${id}`]);
      const mark = checkEmoji(emoji);
      let changed = false;
      if (on) {
        const kinds = this.db.prepare("SELECT COUNT(DISTINCT emoji) AS n, MAX(emoji = ?) AS has FROM task_entry_reactions WHERE entry_id = ?").get(mark, id) as { n: number; has: number | null };
        if (!kinds.has && kinds.n >= MAX_REACTION_KINDS) throw new TaskBoardError("too_long", `comment c${id} already has ${MAX_REACTION_KINDS} different reactions`, "reaction_limit", [`c${id}`, MAX_REACTION_KINDS]);
        changed = this.db.prepare("INSERT OR IGNORE INTO task_entry_reactions (entry_id, emoji, by, by_kind, who, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, mark, actor.name, actor.kind, this.reactor(actor), this.nowIso()).changes > 0;
      } else {
        changed = this.db.prepare("DELETE FROM task_entry_reactions WHERE entry_id = ? AND emoji = ? AND who = ? AND by_kind = ?").run(id, mark, this.reactor(actor), actor.kind).changes > 0;
      }
      if (changed) this.signal(actor, card, "comment_reacted", { entry: id, emoji: mark, on });
      return { card, notes: changed ? [] : ["no change"], said: [], entry: this.commentOf(card, id) };
    });
  }

  /** Folds a thread away (`resolved`) or opens it again. Only a thread's first comment is resolved; anyone who may comment may. Wakes nobody. */
  resolveThread(actor: Actor, ref: string, id: number, resolved: boolean): MutationResult & { entry: Entry } {
    return this.tx(() => {
      const card = this.getCard(ref);
      const row = this.commentRow(card, id);
      if (typeof row.deleted_at === "string") throw new TaskBoardError("invalid", `comment c${id} on ${card.code} was deleted`, "comment_deleted", [`c${id}`]);
      if (row.parent_id !== null && row.parent_id !== undefined) throw new TaskBoardError("invalid", `c${id} is a reply: resolve the thread by its first comment`, "resolve_root_only", [`c${id}`]);
      if ((typeof row.resolved_at === "string") === resolved) return { card, notes: ["no change"], said: [], entry: this.commentOf(card, id) };
      if (resolved) this.db.prepare("UPDATE task_entries SET resolved_at = ?, resolved_by = ? WHERE id = ?").run(this.nowIso(), actor.name, id);
      else this.db.prepare("UPDATE task_entries SET resolved_at = NULL, resolved_by = NULL WHERE id = ?").run(id);
      this.signal(actor, card, "comment_resolved", { entry: id, resolved });
      return { card, notes: [], said: [], entry: this.commentOf(card, id) };
    });
  }

  /** A comment's stored recipients, `at` read from its words when the row has none stored (written before they were). */
  private storedNotify(row: Row, names: readonly string[]): { to: string[]; assignee: boolean; at: string[] } {
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    let n: { to?: unknown; assignee?: unknown; at?: unknown } = {};
    if (typeof row.notify === "string") { try { n = JSON.parse(row.notify) as typeof n; } catch { n = {}; } }
    return { to: strs(n.to), assignee: n.assignee !== false, at: Array.isArray(n.at) ? strs(n.at) : parseMentions(String(row.text ?? ""), names).names };
  }

  /** A change to a comment the page and the revision hear of, with no history line of its own (SignalType). */
  private signal(actor: Actor, card: Card, type: SignalType, data: Record<string, unknown>, audience?: CommentAudience): void {
    this.pending.push({ code: card.code, uuid: card.uuid, actor, type, data, ...(audience ? { audience } : {}) });
  }

  // ── Writing: the fleet's `task` tool (and the old /ui/tasks routes) ──

  /**
   * A task as the `task` tool has always opened it: a main task under no project, assigned only when asked, with no
   * review gate unless a person later sets one. Dependencies are stored as given (ids are not checked).
   */
  legacyCreate(actor: Actor, params: { title: string; description?: string; priority?: CardPriority; assignee?: string; depends_on?: string[] }): Card {
    return this.tx(() => {
      this.checkAssignable(params.assignee ?? null);
      const now = this.nowIso();
      const card: Card = {
        uuid: randomUUID(), code: this.nextCode("M"), kind: "main", projectId: null, parent: null, title: params.title, status: "open",
        assignee: params.assignee ?? null, priority: params.priority ?? "normal", size: null, needsReview: false, onBoard: false,
        // Opened for another instance: the opener handed it out (its blocked question goes to it).
        dispatcher: actor.kind === "instance" && params.assignee && params.assignee !== actor.name ? { kind: "instance", name: actor.name } : null,
        deps: this.checkDeps({ uuid: null, kind: "main", parent: null }, params.depends_on ?? []),
        goal: params.description ?? "", scope: "", acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: this.nextSort(),
        createdBy: actor.name, version: 1, createdAt: now, updatedAt: now, startedAt: null, submittedAt: null, doneAt: null, seenEntryId: 0,
      };
      this.insert(card);
      this.codes.set(card.uuid, card.code);
      this.event(actor, card, "created", { kind: "main", project: null, parent: null, title: card.title, assignee: card.assignee });
      return card;
    });
  }

  /**
   * Whether the board's rules hold for the `task` tool on this card: it is in a project, is a sub task, has sub tasks,
   * or waits for the person. The tool's own tasks outside all of that keep the tool's old leniency (anyone may move
   * them), and a person is never held to an instance's rules.
   */
  private heldToBoardRules(card: Card, actor: Actor): boolean {
    return !isPerson(actor) && this.isOnBoard(card);
  }

  /**
   * `task claim`: an open task, every dependency done (a missing one counts as done). On the board, an instance claims
   * as it would there: an unassigned card or its own, its main task's dependencies done too.
   */
  legacyClaim(actor: Actor, uuid: string, assignee: string): Card {
    return this.tx(() => {
      const card = this.byUuid(uuid);
      if (!card) throw new Error(`Task "${uuid}" not found`);
      if (card.status !== "open") throw new Error(`Task "${uuid}" is ${card.status}, cannot claim`);
      if (card.kind === "main" && this.activeSubs(card.uuid).length) throw new Error(`Task "${card.code}" has sub tasks; claim one of them instead`);
      if (this.heldToBoardRules(card, actor)) {
        if (assignee !== actor.name) throw new TaskBoardError("forbidden", `an instance claims ${card.code} for itself, not for ${assignee}`);
        this.checkManualMove(card, actor, "claimed", "");
      } else {
        for (const depId of card.deps) {
          const dep = this.byUuid(depId);
          if (dep && dep.status !== "done") throw new Error(`Task "${uuid}" is blocked by "${depId}" (status: ${dep.status})`);
        }
        if (assignee !== card.assignee) this.assign(card, assignee, actor);
      }
      this.applyMove(card, actor, "claimed", "");
      return card;
    });
  }

  /**
   * `task done`: from open or claimed. A card that needs confirmation goes to review instead, so no instance finishes
   * one it does not confirm alone; the one who confirms it finishes it, from review too (#2434). On the board, an instance finishes as it would there: its own card, with a result
   * (an open one is claimed first, under the same rules).
   */
  legacyComplete(actor: Actor, uuid: string, result?: string): Card {
    return this.tx(() => {
      const card = this.byUuid(uuid);
      if (!card) throw new Error(`Task "${uuid}" not found`);
      // #2434: a card in review is finished by whoever confirms it (an agent's card: its dispatcher).
      const confirming = card.status === "review" && confirms(card, actor);
      if (card.status !== "claimed" && card.status !== "open" && !confirming) {
        throw new Error(`Task "${uuid}" is ${card.status}, cannot complete (must be open or claimed${card.status === "review" ? `; it waits for ${confirmerOf(card)}'s confirmation` : ""})`);
      }
      const open = this.children(card.uuid).filter((k) => !isFinished(k));
      if (open.length) throw new Error(`Task "${card.code}" still has unfinished sub tasks: ${open.map((k) => k.code).join(", ")}`);
      if (result !== undefined && result !== card.result) {
        this.event(actor, card, "updated", { changes: { result: { from: card.result, to: result } } });
        card.result = result;
      }
      const to: CardStatus = requiresReview(card) && !confirms(card, actor) ? "review" : "done";
      if (this.heldToBoardRules(card, actor)) {
        if (card.status === "open") {
          this.checkManualMove(card, actor, "claimed", "", { finishing: true });
          this.applyMove(card, actor, "claimed", "");
        }
        this.checkManualMove(card, actor, to, "");
      }
      this.applyMove(card, actor, to, "");
      return card;
    });
  }

  /**
   * `task update`: status, assignee, result, priority. The review gate holds for everyone but a person: "done" on a
   * card that needs confirmation becomes "review", and only a person takes a card out of review to done. On the
   * board, an instance is held to the board's rules for each change (its own cards; moves as on the board).
   */
  legacyUpdate(actor: Actor, uuid: string, params: { status?: CardStatus; assignee?: string; result?: string; priority?: CardPriority }): Card {
    return this.tx(() => {
      const card = this.byUuid(uuid);
      if (!card) throw new Error(`Task "${uuid}" not found`);
      const held = this.heldToBoardRules(card, actor);
      const derived = card.kind === "main" && this.activeSubs(card.uuid).length > 0;
      if (held && (params.result !== undefined || params.priority !== undefined) && !this.canEdit(card, actor)) {
        throw new TaskBoardError("forbidden", `${card.code} belongs to ${card.assignee}; you can only comment on it`);
      }
      let touched = false;
      if (params.result !== undefined && params.result !== card.result) {
        this.event(actor, card, "updated", { changes: { result: { from: card.result, to: params.result } } });
        card.result = params.result;
        touched = true;
      }
      if (params.priority !== undefined && params.priority !== card.priority) {
        this.event(actor, card, "updated", { changes: { priority: { from: card.priority, to: params.priority } } });
        card.priority = params.priority;
        touched = true;
      }
      if (params.assignee !== undefined && params.assignee !== card.assignee) {
        if (held && !(card.assignee === null || card.assignee === actor.name || card.createdBy === actor.name)) {
          throw new TaskBoardError("forbidden", `${card.code} belongs to ${card.assignee}; you cannot reassign it`);
        }
        this.assign(card, params.assignee, actor);
        touched = true;
      }
      if (params.status !== undefined && params.status !== card.status) {
        let to = params.status;
        if (!isPerson(actor)) {
          if (derived && !held) throw new Error(`Task "${card.code}" has sub tasks; its status follows them`);
          if (derived) this.checkDerivedMove(card, actor, to, "");
          else {
            if (card.status === "review" && to === "done" && !confirms(card, actor)) throw new Error(`Task "${card.code}" is waiting for ${confirmerOf(card)}'s confirmation`);
            if (to === "done" && card.status !== "review" && requiresReview(card) && !confirms(card, actor)) to = "review";
            if (held && to !== card.status) this.checkManualMove(card, actor, to, "");
          }
          // #2757 review: a derived main task too; a card off the board (not held) keeps the tool's old, unchecked finish.
          to = this.ownReview(card, actor, to, "", held);
        }
        if (to !== card.status) {
          this.applyMove(card, actor, to, "");
          return card;
        }
      }
      if (touched) {
        card.version++;
        card.updatedAt = this.nowIso();
        // As on the board: its assignee's write hands over the comments it had not seen, then they count as seen.
        this.surfaceComments(card, actor);
        this.markSeen(card, actor);
        this.save(card);
      }
      return card;
    });
  }

  // ── Rules ───────────────────────────────────────────────

  /**
   * #2080: review for an instance's own confirmation is done. An instance moving a card to review that it confirms itself
   * (nobody else handed it out, or it handed it to itself) would wait for nobody but itself — and sat there unnoticed,
   * in the person's Waiting for you too: it finishes instead (the checks for review are the ones for done). A person's
   * move, and a card someone else confirms, stay as asked.
   */
  private ownReview(card: Card, actor: Actor, to: CardStatus, reason = "", check = true): CardStatus {
    if (to !== "review" || isPerson(actor) || card.status === "review" || !confirms(card, actor)) return to;
    // #2757 review: finished as done is, whichever way it came (a derived main task's review checks less).
    if (check) this.checkFinish(card, true, reason);
    this.say("own_review", [card.code], `${card.code} waits for nobody else's confirmation (you confirm it): done, not review`);
    return "done";
  }

  /**
   * Cards moved by hand: sub tasks, and main tasks that have no sub tasks. `comment` is the move's own comment (a
   * dispatcher's answer); `finishing`: a claim on the way to done (the `task` tool's done of an open card).
   */
  private checkManualMove(card: Card, actor: Actor, to: CardStatus, reason: string, opts: { comment?: string; finishing?: boolean } = {}): void {
    const ai = !isPerson(actor);
    const from = card.status;
    const own = card.assignee === actor.name;
    const startsWork = ai && !opts.finishing && this.isOnBoard(card);
    if (card.kind === "sub" && to !== "cancelled") {
      const main = card.parent ? this.byUuid(card.parent) : undefined;
      if (main?.status === "cancelled") throw new TaskBoardError("invalid", `main task ${main.code} is cancelled; restore it first to keep working on this`, "main_cancelled", [main.code]);
    }
    const notOwner = () => new TaskBoardError("forbidden", `${card.code} belongs to ${card.assignee ?? "nobody"}; you cannot move it`);

    switch (to) {
      case "claimed": {
        if (from === "open") {
          const unmet = this.unmetDeps(card);
          if (ai) {
            if (card.assignee && !own) throw new TaskBoardError("forbidden", `${card.code} is assigned to ${card.assignee}; you cannot take it`);
            if (unmet.length) {
              throw new TaskBoardError("blocked_by_deps", `${card.code} waits for ${unmet.map((c) => `${c.code} (${c.status})`).join(", ")}; do those first or take another card`);
            }
            if (startsWork) this.checkOneAtATime(card, actor);
            if (!card.assignee) this.assign(card, actor.name, actor);
          } else if (unmet.length) {
            this.say("deps_unmet", [unmet.map((c) => c.code).join(", ")], `note: ${unmet.map((c) => c.code).join(", ")} ${unmet.length === 1 ? "is" : "are"} not done yet`);
          }
        } else if (from === "blocked") {
          if (ai && !own) {
            if (!isDispatcher(card, actor)) throw notOwner();
            this.checkAnswer(card, opts.comment);
          } else if (startsWork) this.checkOneAtATime(card, actor);
        } else if (from === "review") {
          if (ai && !own && confirms(card, actor)) {
            // #2434: an agent's card sent back by the instance that confirms it, as the person sends theirs back.
            if (!reason) throw new TaskBoardError("invalid", "sending work back needs a reason", "sendback_reason");
            this.entry(card, "reject", actor, reason);
          } else if (ai) {
            if (!own) throw notOwner();
            if (startsWork) this.checkOneAtATime(card, actor);
            // Out of the person's queue: they read why.
            if (!reason) throw new TaskBoardError("invalid", "taking a card back from review needs a reason (the person reads it)");
            this.entry(card, "comment", actor, `withdrawn from review: ${reason}`);
          } else {
            if (!reason) throw new TaskBoardError("invalid", "sending work back needs a reason", "sendback_reason");
            this.entry(card, "reject", actor, reason);
          }
        } else if (ai) {
          throw new TaskBoardError("forbidden", `an instance cannot reopen a ${from} card; open a new one if needed`);
        }
        return;
      }
      case "blocked": {
        if (ai) {
          if (from !== "claimed") throw new TaskBoardError("invalid", `only a card in progress can be blocked (${card.code} is ${from})`);
          if (!own) throw notOwner();
        }
        if (!reason) throw new TaskBoardError("invalid", "blocking needs a reason: who has to answer what", "block_reason");
        return;
      }
      case "review": {
        if (ai) {
          if (from !== "claimed") throw new TaskBoardError("invalid", `only a card in progress can go to review (${card.code} is ${from})`);
          if (!own) throw notOwner();
        }
        this.checkFinish(card, ai, reason);
        return;
      }
      case "done": {
        if (ai) {
          if (from === "review") {
            if (!confirms(card, actor)) {
              throw new TaskBoardError("forbidden", personConfirms(card) ? `${card.code} is waiting for the person's confirmation: only they finish it`
                : `${card.code} is waiting for ${confirmerOf(card)}'s confirmation: only they finish it`);
            }
            if (reason) this.entry(card, "approve", actor, reason);
          } else {
            if (from !== "claimed") throw new TaskBoardError("invalid", `only a card in progress can be done (${card.code} is ${from})`);
            if (!own) throw notOwner();
            if (requiresReview(card) && !confirms(card, actor)) {
              throw new TaskBoardError("needs_review", personConfirms(card) ? `${card.code} needs the person's confirmation; move it to review`
                : `${card.code} needs ${confirmerOf(card)}'s confirmation; move it to review`);
            }
          }
        } else if (from === "review" && reason) {
          this.entry(card, "approve", actor, reason);
        }
        this.checkFinish(card, ai, reason);
        return;
      }
      case "open": {
        if (ai) {
          if (from !== "claimed" && from !== "blocked") throw new TaskBoardError("invalid", "only a card in progress or blocked can go back to open");
          if (!own) throw notOwner();
          this.assign(card, null, actor);
        } else if (from === "review") {
          // Sending back from review is a rejection either way, so the assignee hears why.
          if (!reason) throw new TaskBoardError("invalid", "sending work back needs a reason", "sendback_reason");
          this.entry(card, "reject", actor, reason);
        }
        return;
      }
      case "cancelled": {
        if (ai) {
          if (card.createdBy !== actor.name) throw new TaskBoardError("forbidden", "an instance can cancel only the cards it opened");
          if (!reason) throw new TaskBoardError("invalid", "cancelling needs a reason");
        }
        return;
      }
    }
  }

  /**
   * A main task with sub tasks follows them. By hand: block and unblock it, resubmit it after a rejection (its owner),
   * and for a person approve, reject, reopen, cancel and restore it.
   */
  private checkDerivedMove(card: Card, actor: Actor, to: CardStatus, reason: string, opts: { comment?: string } = {}): void {
    const ai = !isPerson(actor);
    const from = card.status;
    const own = card.assignee === actor.name;
    const notOwner = () => new TaskBoardError("forbidden", `${card.code} belongs to ${card.assignee ?? "nobody"}`);
    if (to === "cancelled") {
      if (ai && card.createdBy !== actor.name) throw new TaskBoardError("forbidden", "an instance can cancel only the main tasks it opened");
      if (ai && !reason) throw new TaskBoardError("invalid", "cancelling needs a reason");
      return;
    }
    if (to === "blocked") {
      // Only live work can be blocked; otherwise blocking then unblocking would reopen a finished main task.
      if (ai ? from !== "claimed" : isFinished(card)) throw new TaskBoardError("invalid", `${card.code} is ${from}; it cannot be blocked`, "cannot_block", [card.code, from]);
      if (ai && !own) throw notOwner();
      if (!reason) throw new TaskBoardError("invalid", "blocking needs a reason: who has to answer what", "block_reason");
      return;
    }
    if (from === "blocked" && to === "claimed") {
      if (ai && !own) {
        if (!isDispatcher(card, actor)) throw notOwner();
        this.checkAnswer(card, opts.comment);
      }
      return;
    }
    if (ai) {
      // #2080: a main task in review by itself (its sub tasks done) is finished by the instance that confirms it.
      if (from === "review" && to === "done" && confirms(card, actor)) {
        if (reason) this.entry(card, "approve", actor, reason);
        this.checkFinish(card, ai, reason);
        return;
      }
      if (from === "claimed" && to === "review") {
        if (!own) throw notOwner();
        if (!this.activeSubs(card.uuid).every((k) => k.status === "done")) {
          throw new TaskBoardError("invalid", `${card.code} has unfinished sub tasks; it goes to review by itself when they are all done`);
        }
        if (!card.result) throw new TaskBoardError("invalid", "resubmitting needs a result: what changed and how it was checked");
        return;
      }
      throw new TaskBoardError("forbidden", `${card.code} has sub tasks; its status follows them — move its sub tasks along`);
    }
    if (from === "review" && to === "done") {
      if (reason) this.entry(card, "approve", actor, reason);
      this.checkFinish(card, ai, reason);
      return;
    }
    if (from === "review" && to === "claimed") {
      if (!reason) throw new TaskBoardError("invalid", "sending work back needs a reason", "sendback_reason");
      this.entry(card, "reject", actor, reason);
      return;
    }
    if ((from === "done" && to === "claimed") || (from === "cancelled" && to === "open")) return;
    throw new TaskBoardError("invalid", `${card.code} has sub tasks; its status follows them — you can confirm it, send it back, block it or cancel it`, "derived_move", [card.code]);
  }

  /** What leaving "in progress" as finished (review or done) needs. */
  private checkFinish(card: Card, ai: boolean, reason: string): void {
    const open = this.children(card.uuid).filter((k) => !isFinished(k));
    if (open.length) throw new TaskBoardError("invalid", `${card.code} still has unfinished sub tasks: ${open.map((k) => k.code).join(", ")}`, "unfinished_subs", [card.code, open.map((k) => k.code).join(", ")]);
    if (!ai) return;
    if (!card.result) throw new TaskBoardError("invalid", "finishing needs a result: which files changed and how it was checked");
    const unchecked = card.acceptance.map((a, i) => ({ ...a, n: i + 1 })).filter((a) => !a.done);
    if (unchecked.length && !reason) {
      throw new TaskBoardError("invalid", `${unchecked.length} acceptance item(s) unchecked (${unchecked.map((a) => a.n).join(", ")}); check them, or say why in the reason`);
    }
  }

  private canEdit(card: Card, actor: Actor): boolean {
    return card.assignee === null || card.assignee === actor.name || card.createdBy === actor.name || isDispatcher(card, actor);
  }

  /** Its dispatcher answering a blocked card says what was decided: the assignee reads it. */
  private checkAnswer(card: Card, comment: string | undefined): void {
    if (!comment?.trim()) throw new TaskBoardError("invalid", `answering ${card.code}'s blocked question takes the decision as a comment`);
  }

  /**
   * An instance works on one card of the board at a time — or as many as its `board_cards_at_once` allows: starting
   * another (claiming, resuming a blocked one, taking one back from review) at its limit is refused. Blocked cards,
   * main tasks that follow their sub tasks and cards it opened for itself do not count; the `task` tool's own tasks and
   * cards it opened for itself are not limited, nor is a person.
   */
  private checkOneAtATime(card: Card, actor: Actor): void {
    if (openedForItself(card)) return;
    const busy = this.busyWith(card, actor.name);
    if (!busy.length) return;
    const list = busy.map((c) => `${c.code} "${c.title.length > 30 ? `${c.title.slice(0, 30)}…` : c.title}"`).join(", ");
    const limit = this.limitOf(actor.name);
    throw new TaskBoardError("one_at_a_time", limit === 1
      ? `you already have ${list} in progress. One card at a time: finish it first; if you cannot go on, move it to blocked with a reason, then start ${card.code}`
      : `you already have ${list} in progress: at most ${limit} cards at a time. Finish one first; if you cannot go on, move one to blocked with a reason, then start ${card.code}`);
  }

  /** The cards that keep `name` from starting `card` now: those it has in progress, once they reach its limit. */
  private busyWith(card: Card, name: string): Card[] {
    const counted = this.inProgress(name).filter((c) => c.uuid !== card.uuid && !openedForItself(c));
    return counted.length >= this.limitOf(name) ? counted : [];
  }

  /** The fleet's `board_cards_at_once` for an instance: a whole number of at least 1, else 1. */
  private limitOf(name: string): number {
    const n = this.cardLimit(name);
    return Number.isInteger(n) && n >= 1 ? n : 1;
  }

  /** For `mine`: the cards that count toward an instance's limit, when there are more than it allows (a person moved them). */
  overLimit(name: string): { count: number; limit: number } | null {
    const count = this.inProgress(name).filter((c) => !openedForItself(c)).length;
    const limit = this.limitOf(name);
    return count > limit ? { count, limit } : null;
  }

  /** How many handed-out cards each instance may have in progress (the fleet reads its config; default 1). */
  setCardLimit(limit: (name: string) => number): void {
    this.cardLimit = limit;
  }

  /**
   * Which names are fleet instances with the task board switched off (`dashboard.task_board: false`; the fleet reads its
   * config at each write). Such an instance has no `task` tool, so it never sees a card handed to it: nobody — the
   * person or an agent — makes it a card's assignee. Cards it had before keep it; nothing else is refused.
   */
  setBoardOff(off: (name: string) => boolean): void {
    this.boardOff = off;
  }

  /** The fleet's instance names and its comment-wakes switch, for routing a comment to the instances it concerns. */
  setCommentRouting(routing: CommentRouting): void {
    this.routing = routing;
  }

  /**
   * The fleet's follow-the-card settings: whether followers hear progress at all, and the board's default leader (the
   * leader of the cards whose project has no lead of its own). Read at every write.
   */
  setProgressRouting(routing: ProgressRouting): void {
    this.following = routing;
  }

  /**
   * The fleet's contact rules for an agent's words reaching another instance by the board (a comment, an `@` mention,
   * a follower's progress): false while `source` may not reach `target` without a contact approval (M-3160 / M-3384:
   * an unknown or non-administrator origin, a restricted room). What it refuses wakes nobody and its writer is told to
   * ask through send_to_instance, where the approval is. A person's words are not held to it. Read at every write.
   */
  setContactGate(gate: (source: string, target: string) => boolean): void {
    this.contactGate = gate;
  }

  /** Whether `actor`'s words may reach `target` (a person's always may: the gate is for an agent's conversation). */
  private mayReach(actor: Actor, target: string): boolean {
    if (actor.kind === "person" || actor.kind === "system") return true;
    try { return this.contactGate(actor.name, target); } catch { return false; }
  }

  /** Refuses `name` as the new assignee of a card or task when it is an instance with the task board switched off. */
  private checkAssignable(name: string | null, current: string | null = null): void {
    if (name === null || name === current || !this.boardOff(name)) return;
    throw new TaskBoardError("forbidden", `${name} has the task board switched off (dashboard.task_board: false): it cannot read or move cards. `
      + `Switch the task board on for ${name} first, or hand it the work another way (delegate_task)`, "assignee_board_off", [name]);
  }

  /** The board cards an instance works on itself right now (main tasks that follow their sub tasks aside). */
  inProgress(name: string): Card[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE assignee = ? AND status = 'claimed' ORDER BY sort").all(name) as Row[]).map(toCard)
      .filter((c) => this.isOnBoard(c) && !(c.kind === "main" && this.activeSubs(c.uuid).length));
  }

  private personOnly(actor: Actor, what: string): void {
    if (!isPerson(actor)) throw new TaskBoardError("forbidden", `only a person can ${what}`);
  }

  // ── Derived state ───────────────────────────────────────

  /** Status bookkeeping shared by every move, then what the move sets off. */
  private applyMove(card: Card, actor: Actor, to: CardStatus, reason: string, comment?: string, attach?: string[]): void {
    const from = card.status;
    if (from === "open" && to === "claimed" && this.quiescence?.holdTaskClaim()) {
      throw new TaskBoardError("conflict", "an update is in progress; this claim waits until it finishes");
    }
    const now = this.nowIso();
    card.status = to;
    if (to === "claimed" && !card.startedAt) card.startedAt = now;
    if (to === "review") card.submittedAt = now;
    card.doneAt = to === "done" ? now : null;
    card.blockedReason = to === "blocked" ? reason : "";
    if (comment?.trim() || attach?.length) this.writeComment(card, actor, comment ?? "", attach);
    card.version++;
    card.updatedAt = now;
    this.surfaceComments(card, actor);
    this.markSeen(card, actor);
    this.save(card);
    this.event(actor, card, "moved", reason ? { from, to, reason } : { from, to });

    if (to === "cancelled") this.cancelSubs(card, actor);
    if (card.kind === "main" && from === "cancelled") this.restoreSubs(card, actor);
    if (card.kind === "main" && (from === "cancelled" || from === "blocked")) this.deriveMain(card, actor);
    if (card.parent) { const main = this.byUuid(card.parent); if (main) this.deriveMain(main, actor); }
    if (to === "done") this.noteUnblocked(card);
  }

  /**
   * A main task with sub tasks follows them: open until something starts, in progress while they run, and when they
   * are all done, review (or done, for one that needs no confirmation). Only whoever confirms it (#2434) moves it
   * from review to done. A blocked or cancelled main task is left alone, and so is one without sub tasks (it is moved by hand).
   */
  /** What a main task's sub tasks make its status (its own, when it is blocked, cancelled or has none). */
  private derivedStatus(main: Card): CardStatus {
    if (main.status === "cancelled" || main.status === "blocked") return main.status;
    const subs = this.activeSubs(main.uuid);
    if (!subs.length) return main.status;
    const allDone = subs.every((k) => k.status === "done");
    const started = main.startedAt !== null || subs.some((k) => k.status !== "open");
    const finished: CardStatus = requiresReview(main) ? "review" : "done";
    if (main.status === "done" || main.status === "review") return allDone ? main.status : started ? "claimed" : "open";
    return allDone ? finished : started ? "claimed" : "open";
  }

  private deriveMain(main: Card, actor: Actor): void {
    const next = this.derivedStatus(main);
    if (next === main.status) return;
    const from = main.status;
    const now = this.nowIso();
    main.status = next;
    if (next === "claimed" && !main.startedAt) main.startedAt = now;
    if (next === "review") main.submittedAt = now;
    main.doneAt = next === "done" ? now : null;
    main.version++;
    main.updatedAt = now;
    this.save(main);
    this.event(actor, main, "moved", { from, to: next, auto: true });
    if (next === "review") this.say("review_waiting", [main.code, main.title], `${main.code} "${main.title}": every sub task is done; it is waiting for ${confirmerOf(main)}'s confirmation`);
    else if (from === "done" || from === "review") this.say("back_to", [main.code, next], `${main.code} has unfinished sub tasks again; it is back to ${next}`);
    if (next === "done") this.noteUnblocked(main);
  }

  /** Cancelling a main task cancels its unfinished sub tasks (the event remembers where each was). */
  private cancelSubs(card: Card, actor: Actor): void {
    for (const sub of this.children(card.uuid)) {
      if (isFinished(sub)) continue;
      const from = sub.status;
      sub.status = "cancelled";
      sub.version++;
      sub.updatedAt = this.nowIso();
      this.save(sub);
      this.event(actor, sub, "moved", { from, to: "cancelled", auto: true, cascade: card.code });
    }
  }

  /** Restoring a main task brings back the sub tasks its cancellation took down, where they were. */
  private restoreSubs(main: Card, actor: Actor): void {
    for (const sub of this.children(main.uuid)) {
      if (sub.status !== "cancelled") continue;
      const last = this.db.prepare("SELECT data FROM task_events WHERE task_id = ? AND type = 'moved' ORDER BY id DESC LIMIT 1").get(sub.uuid) as { data: string } | undefined;
      const data = last ? JSON.parse(last.data) as { from?: CardStatus; cascade?: string } : {};
      if (data.cascade !== main.code || !data.from) continue;
      sub.status = data.from;
      sub.version++;
      sub.updatedAt = this.nowIso();
      this.save(sub);
      this.event(actor, sub, "moved", { from: "cancelled", to: data.from, auto: true, restored: main.code });
    }
  }

  /** `card` is done: the open cards that waited for it and wait for nothing else now can start. */
  private noteUnblocked(card: Card): void {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'open' AND depends_on LIKE ?").all(`%"${card.uuid}"%`) as Row[];
    for (const dependent of rows.map(toCard)) {
      if (this.unmetDeps(dependent).length === 0) this.say("deps_done", [dependent.code], `${dependent.code}'s dependencies are all done; it can start`);
    }
  }

  /** Every card's place again 1, 2, 3… in the same order (reorder() calls it when two neighbours touch). */
  private renumber(): void {
    const rows = this.db.prepare("SELECT id FROM tasks ORDER BY sort, rowid").all() as Array<{ id: string }>;
    const set = this.db.prepare("UPDATE tasks SET sort = ? WHERE id = ?");
    rows.forEach((r, i) => set.run(i + 1, r.id));
  }

  /** Several of the board's writes as one: all of them or none (the `task` tool's update with fields and a status). */
  atomically<T>(fn: () => T): T {
    return this.tx(fn);
  }

  /** This write's notes so far, both ways. */
  private spoken(): { notes: string[]; said: Note[] } {
    return { notes: this.notes.map((n) => n.text), said: [...this.notes] };
  }

  /** A note of this write: English for agents, its key and values for the dashboard. */
  private say(key: string, args: Array<string | number>, text: string): void {
    this.notes.push({ text, key, args });
  }

  /** The last write's notes (English), once: the `task` tool's old actions return them with their answer. */
  takeNotes(): string[] {
    const notes = this.lastNotes;
    this.lastNotes = [];
    return notes;
  }

  // ── Following a card ────────────────────────────────────

  /** The instances that watch exactly this card (not its main task's), in the order they began. */
  watchersOf(uuid: string): string[] {
    return (this.db.prepare("SELECT instance FROM task_watchers WHERE task_id = ? ORDER BY at, rowid").all(uuid) as Array<{ instance: string }>).map((r) => r.instance);
  }

  /**
   * Starts and stops instances watching a card (`add`, `remove`: instance names), in one write. A watcher hears the
   * card's progress (settleWakes) — and, on a main task, its sub tasks' too. A person changes anyone's; an instance
   * watches or stops watching itself on any board card, and changes another's only on a card it may edit (its
   * assignee, creator or dispatcher, or an unassigned one). Names must be fleet instances with the task board on (one
   * that has since left the fleet can still be removed). Not a change of the card's content: no new version, so a page
   * editing the card meanwhile is not told it conflicts; the board's revision moves and the card's log says who.
   */
  setWatchers(actor: Actor, ref: string, change: { add?: readonly string[]; remove?: readonly string[] }): { card: Card; watchers: string[]; notes: string[]; said: Note[] } {
    return this.tx(() => {
      const card = this.getCard(ref);
      if (!this.isOnBoard(card)) throw new TaskBoardError("invalid", `${card.code} is one of the \`task\` tool's own tasks: only cards on the board can be watched`, "watch_not_board", [card.code]);
      const names = (list: readonly string[] | undefined) => [...new Set((list ?? []).map((n) => normalizeAssignee(n)).filter((n): n is string => n !== null))];
      const add = names(change.add), remove = names(change.remove).filter((n) => !add.includes(n));
      const ai = !isPerson(actor);
      const others = [...add, ...remove].filter((n) => n !== actor.name);
      if (ai && others.length && !this.canEdit(card, actor)) {
        throw new TaskBoardError("forbidden", `${card.code} belongs to ${card.assignee}; you can only watch or stop watching it yourself`, "watch_others_forbidden", [card.code, card.assignee ?? ""]);
      }
      const known = new Set(this.routing.instances());
      const have = new Set(this.watchersOf(card.uuid));
      for (const n of add) {
        if (!known.has(n)) throw new TaskBoardError("invalid", `"${n.slice(0, 64)}" is not one of the fleet's instances`, "watcher_unknown", [n.slice(0, 64)]);
        if (!have.has(n) && this.boardOff(n)) throw new TaskBoardError("forbidden", `${n} has the task board switched off (dashboard.task_board: false): it cannot read or move cards, so a notice would reach nothing it can act on`, "watcher_board_off", [n]);
      }
      const added = add.filter((n) => !have.has(n)), removed = remove.filter((n) => have.has(n));
      if (have.size + added.length - removed.length > MAX_WATCHERS) {
        throw new TaskBoardError("invalid", `${card.code} can have at most ${MAX_WATCHERS} watchers`, "watchers_max", [card.code, MAX_WATCHERS]);
      }
      if (added.length || removed.length) {
        const insert = this.db.prepare("INSERT OR IGNORE INTO task_watchers (task_id, instance, added_by, at) VALUES (?, ?, ?, ?)");
        for (const n of added) insert.run(card.uuid, n, actor.name, this.nowIso());
        for (const n of removed) this.db.prepare("DELETE FROM task_watchers WHERE task_id = ? AND instance = ?").run(card.uuid, n);
        // History only — no log entry: an entry's text is shown and searched as any reader's, and a hidden instance's name
        // in it would reach a read-only viewer over the public link. The event carries the names as values (`watchers`),
        // which the link's reads check one by one, and drop the whole event for; the page says `text` as a log line.
        const text = `watchers: ${[...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`)].join(", ")}`;
        this.event(actor, card, "logged", { text, watchers: { added, removed } });
      } else this.say("no_change", [], "no change");
      return { card, watchers: this.watchersOf(card.uuid), ...this.spoken() };
    });
  }

  /** The instances that follow a card, each with its reason: see {@link FollowRole}. */
  followersOf(card: Card): Map<string, FollowRole> {
    const out = new Map<string, FollowRole>();
    if (!this.isOnBoard(card)) return out;
    const fleet = new Set(this.routing.instances());
    // Its assignee has the card's own news already; one that cannot read it (task board off) is sent nothing.
    const put = (name: string | null | undefined, role: FollowRole) => {
      if (name && !out.has(name) && name !== card.assignee && fleet.has(name) && !this.boardOff(name)) out.set(name, role);
    };
    if (card.dispatcher?.kind === "instance") put(card.dispatcher.name, "dispatcher");
    for (const n of card.parent ? [...this.watchersOf(card.uuid), ...this.watchersOf(card.parent)] : this.watchersOf(card.uuid)) put(n, "watcher");
    put(this.leaderOf(card)?.name, "leader");
    return out;
  }

  /**
   * Who leads a card, and through what: the lead of its project (`project`), else the board's leader
   * (`defaults.task_board.leader`, `board`; it also leads the cards in no project). Null: nobody leads it, or it is not
   * on the board. Whether the leader is also told is {@link followersOf}'s question (not its own assignee, in the fleet,
   * task board on).
   */
  leaderOf(card: Card): { name: string; via: "project" | "board" } | null {
    if (!this.isOnBoard(card)) return null;
    const projectLead = card.projectId === null ? null
      : (this.db.prepare("SELECT lead_instance FROM task_projects WHERE id = ?").get(card.projectId) as { lead_instance: string | null } | undefined)?.lead_instance ?? null;
    if (projectLead) return { name: projectLead, via: "project" };
    const board = this.following.leader();
    return board ? { name: board, via: "board" } : null;
  }

  /**
   * How an event moved a card on, for its followers; null when it is not progress. Pure on the event's type and data, so
   * the loop guard reads the same thing back from the stored events.
   */
  private progressOf(type: string, d: { from?: unknown; to?: unknown }): { kind: ProgressKind; assignee?: string | null; from?: string | null } | null {
    if (type === "assigned") {
      const to = typeof d.to === "string" ? d.to : null, from = typeof d.from === "string" ? d.from : null;
      return to !== from ? { kind: "reassigned", assignee: to, from } : null;
    }
    if (type !== "moved") return null;
    if (d.to === "done") return { kind: "done" };
    if (d.to === "review") return { kind: "review" };
    if (d.to === "blocked") return { kind: "blocked" };
    if (d.from === "review" && (d.to === "claimed" || d.to === "open")) return { kind: "sent_back" };
    return null;
  }

  /** Whether a progress news still describes the card (the wake goes out seconds later, and the card may have moved on). */
  private progressStands(card: Card, news: ProgressNews): boolean {
    switch (news.kind) {
      case "done": return card.status === "done";
      case "review": return card.status === "review";
      case "blocked": return card.status === "blocked";
      case "sent_back": return card.status === "claimed" || card.status === "open";
      case "reassigned": return card.assignee === (news.assignee ?? null);
    }
  }

  /**
   * How many progress changes agents (anything but a person) have made on the card, within AGENT_COMMENT_WINDOW_MS and
   * back to the last event a person caused: the loop guard for followers, read from the card's own events — the write
   * being settled is already among them. A person's comment, move, edit or watch resets it.
   */
  private agentProgressRun(card: Card): number {
    const since = new Date(this.now().getTime() - AGENT_COMMENT_WINDOW_MS).toISOString();
    // Only the rows that count or reset: an agent's log lines and comments, however many, cannot push progress changes out
    // of the window. A person's event of any kind stops the count at once, so what is read is a handful of rows.
    const rows = this.db.prepare("SELECT actor_kind, type, data FROM task_events WHERE task_id = ? AND at >= ? AND (actor_kind = 'person' OR type IN ('moved', 'assigned')) ORDER BY id DESC LIMIT 200")
      .all(card.uuid, since) as Array<{ actor_kind: string; type: string; data: string }>;
    let run = 0;
    for (const r of rows) {
      if (r.actor_kind === "person") break;
      if (this.progressOf(r.type, parseJsonObject(r.data))) run++;
    }
    return run;
  }

  // ── Wakes ───────────────────────────────────────────────

  /**
   * Whom this write wakes, read from its events once it is all written (still inside it): an instance hears only about
   * what someone else did to a card that is its own — or that it handed out (a blocked question, a confirmation). The
   * board's own catch-up wakes nobody, except that a card finishing — by hand or by itself — readies the cards that
   * waited only for it. wakeHolds() then drops what no longer stands.
   */
  private settleWakes(events: TaskBoard["pending"]): Wake[] {
    const out = new Map<string, Wake>();
    const add = (card: Card, instance: string | null | undefined, reason: WakeReason, by: Actor, text?: string, news?: ProgressNews, reply?: { id: number; author: string; text: string }, entry?: number) => {
      // Never its own write — but a person's `@name` is not the instance of that name's own write.
      if (!instance || (instance === by.name && !(reason === "mention" && isPerson(by)))) return;
      const key = `${instance}\u0000${card.uuid}`;
      const w = out.get(key) ?? { instance, uuid: card.uuid, code: card.code, title: card.title, parent: card.parent ? this.codeOf(card.parent) : null, reasons: [], by: {}, texts: {} };
      if (!w.reasons.includes(reason)) w.reasons.push(reason);
      // A later progress replaces the earlier one whole: its words are its own, never the earlier change's.
      if (news && !text) delete w.texts[reason];
      if (text) {
        w.texts[reason] = text;
        // The words answer a comment: the notice says which. A later comment that answers none drops the earlier one's.
        if (reply) (w.replies ??= {})[reason] = reply; else if (w.replies) delete w.replies[reason];
        if (entry !== undefined) (w.entries ??= {})[reason] = entry; else if (w.entries) delete w.entries[reason];
      }
      if (news) w.news = news;
      w.by[reason] = by.name;
      if (isPerson(by)) (w.byPerson ??= {})[reason] = true; else if (w.byPerson) delete w.byPerson[reason];
      if (WORD_REASONS.includes(reason) && !isPerson(by) && by.kind !== "system" && !(w.principals ??= []).includes(by.name)) w.principals.push(by.name);
      out.set(key, w);
    };
    // The answer to a blocked question is the comment that came with it (#2801: a comment alone wakes nobody).
    const comments = new Map<string, { text: string; entry?: number }>();
    const entryOf = (e: TaskBoard["pending"][number]) => (typeof e.data.entry === "number" ? e.data.entry : undefined);
    for (const e of events) if (e.type === "commented") comments.set(e.uuid, { text: String(e.data.text ?? ""), entry: entryOf(e) });
    for (const e of events) {
      const card = e.type === "commented" && e.data.kept === true ? this.byUuid(e.uuid) : undefined;
      if (card) add(card, card.assignee, "answer_kept", e.actor, String(e.data.text ?? ""), undefined, undefined, entryOf(e));
    }
    for (const e of events) {
      const card = this.byUuid(e.uuid);
      if (!card) continue;
      const d = e.data as { from?: CardStatus; to?: CardStatus; auto?: boolean; reason?: string; assignee?: string | null; text?: string; cascade?: string };
      const dispatcherOf = () => (card.dispatcher?.kind === "instance" && card.dispatcher.name !== card.assignee ? card.dispatcher.name : null);
      // The `task` tool's own tasks are handed over with a message of their own (delegate_task): no notice besides.
      if (e.type === "created") { if (this.isOnBoard(card)) add(card, d.assignee ?? null, "assigned", e.actor); }
      else if (e.type === "assigned") { if (this.isOnBoard(card)) add(card, (d.to as string | null) ?? null, "assigned", e.actor); }
      else if (e.type === "moved") {
        if (d.to === "done") this.wakeReady(card, e.actor, add);
        if (d.to === "cancelled") {
          // Taken down with its main task: why the main task was cancelled.
          const main = d.cascade ? events.find((x) => x.code === d.cascade && x.type === "moved" && x.data.to === "cancelled") : undefined;
          const why = d.cascade ? `with its main task ${d.cascade}${main?.data.reason ? `: ${String(main.data.reason)}` : ""}` : d.reason;
          add(card, card.assignee, "cancelled", e.actor, why);
          continue;
        }
        // An agent's card waits for its instance dispatcher to confirm it (#2434: its own to confirm, nobody to ask). A
        // person's card has no instance dispatcher, so no notice: the person has it in Needs you.
        const toConfirm = d.to === "review" && !isPerson(e.actor) && requiresReview(card) ? dispatcherOf() : null;
        if (toConfirm) add(card, toConfirm, "to_confirm", e.actor);
        // #2080: a card its own assignee confirms, in review by itself (its sub tasks done) or by someone else's move:
        // nobody else will confirm it, so its assignee is told it is theirs.
        if (d.to === "review" && card.assignee && confirmingInstance(card) === card.assignee) add(card, card.assignee, "confirm_own", e.actor);
        if (d.auto) {
          // #2801: one change, one instance — the dispatcher's confirmation already says what it lacks.
          if (d.to === "review" && card.kind === "main" && wrapUpGap(card) && !toConfirm) add(card, card.assignee, "wrap_up", e.actor);
          continue;
        }
        if (d.from === "open" && d.to === "claimed") add(card, card.assignee, "start", e.actor);
        else if (d.from === "blocked" && d.to === "claimed") add(card, card.assignee, "answered", e.actor, comments.get(card.uuid)?.text, undefined, undefined, comments.get(card.uuid)?.entry);
        else if (d.from === "review" && (d.to === "claimed" || d.to === "open")) add(card, card.assignee, "sent_back", e.actor, d.reason);
        if (d.to === "blocked" && !isPerson(e.actor)) add(card, dispatcherOf(), "decide", e.actor, d.reason);
      }
    }
    // Comments and mentions: the assignee hears a comment someone else wrote, an instance it names hears it. An answer
    // to a blocked question already says its words (answered, answer_kept), and a mention says it all to the assignee.
    // An edit counts as the comment it changed, for the instances its new words name (and only those: `audience.assignee` is false).
    for (const e of events) {
      if ((e.type !== "commented" && e.type !== "comment_edited") || !e.audience) continue;
      const card = this.byUuid(e.uuid);
      if (!card) continue;
      const text = String(e.data.text ?? "");
      const entry = entryOf(e);
      for (const name of e.audience.mentions) add(card, name, "mention", e.actor, text, undefined, e.audience.reply, entry);
      const held = card.assignee ? out.get(`${card.assignee}\u0000${card.uuid}`) : undefined;
      if (e.audience.assignee && card.assignee && !e.audience.mentions.includes(card.assignee) && !held?.reasons.some((r) => r === "answered" || r === "answer_kept")) {
        add(card, card.assignee, "comment", e.actor, text, undefined, e.audience.reply, entry);
      }
    }
    this.settleProgress(events, add);
    const wakes = [...out.values()].map((w) => this.wakeHolds(w)).filter((w): w is Wake => w !== null);
    // Said to the writer, so an agent knows the followers are told and need no message of its own.
    const told = wakes.filter((w) => w.reasons.includes("progress") && w.news).map((w) => `${w.instance} (${w.news!.as})`);
    if (told.length) this.say("progress_wakes", [told.join(", ")], `how this changed the card is told to ${told.join(", ")} as a [Task board] notice: no need to message them about it`);
    return wakes;
  }

  /**
   * Followers: the instances that handed a card out, watch it or lead its project hear it was finished, went to
   * review, was sent back, was blocked or got another assignee (docs/design/task-board.md, "Following a card"). The
   * board's own catch-up (actor system) tells nobody; an agent's change is held to the loop guard.
   */
  private settleProgress(events: TaskBoard["pending"], add: (card: Card, instance: string, reason: WakeReason, by: Actor, text?: string, news?: ProgressNews) => void): void {
    if (!this.following.enabled()) return;
    const runs = new Map<string, number>();
    const stopped = new Set<string>();
    const held: string[] = [];
    for (const e of events) {
      if (e.actor.kind === "system") continue;
      const found = this.progressOf(e.type, e.data as { from?: unknown; to?: unknown });
      const card = found ? this.byUuid(e.uuid) : undefined;
      if (!found || !card) continue;
      const followers = this.followersOf(card);
      if (!followers.size) continue;
      if (e.actor.kind !== "person") {
        const run = runs.get(card.uuid) ?? this.agentProgressRun(card);
        runs.set(card.uuid, run);
        if (run > AGENT_PROGRESS_CHAIN) {
          if (!stopped.has(card.uuid)) this.say("progress_chain", [card.code, run], `nobody was told how ${card.code} changed: agents have changed it ${run} times in a row (a loop guard). It is kept on the card; `
            + `followers hear again once a person touches it, or when these are ${AGENT_COMMENT_WINDOW_MS / 60_000} minutes old`);
          stopped.add(card.uuid);
          continue;
        }
      }
      const d = e.data as { reason?: unknown };
      const words = found.kind === "done" || found.kind === "review" ? card.result || (typeof d.reason === "string" ? d.reason : "")
        : found.kind === "blocked" ? card.blockedReason || (typeof d.reason === "string" ? d.reason : "")
        : found.kind === "sent_back" ? (typeof d.reason === "string" ? d.reason : "") : "";
      for (const [name, as] of followers) {
        if (!this.mayReach(e.actor, name)) { if (!held.includes(name)) held.push(name); continue; }
        add(card, name, "progress", e.actor, words || undefined, { ...found, as });
      }
    }
    if (held.length) this.say("progress_contact_held", [held.join(", ")], `${held.join(", ")} not told how the card changed: this conversation may not reach another instance on its own `
      + `(its origin is unknown or not an administrator's, or a Hub contact restriction is on). The change is on the card; to tell them, use send_to_instance, which asks for the approval where one can be given`);
  }

  /** A finished card readies the open cards that waited only for it (a sub task also waits for its main task's). */
  private wakeReady(done: Card, by: Actor, add: (card: Card, instance: string | null, reason: WakeReason, by: Actor) => void): void {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'open' AND assignee IS NOT NULL AND (depends_on LIKE ? OR parent_id IN (SELECT id FROM tasks WHERE depends_on LIKE ?))")
      .all(`%"${done.uuid}"%`, `%"${done.uuid}"%`) as Row[];
    for (const card of rows.map(toCard)) if (!this.unmetDeps(card).length) add(card, card.assignee, "ready", by);
  }

  /**
   * What of a wake still stands now (at the end of its write, and again when the fleet sends it): a finished card is
   * news only as a cancel; a card that is no longer the instance's is not; a question only while the card is blocked
   * and the instance still handed it out; a wrap-up only while it waits unfinished; and an assignment only once the
   * card can start (its "ready" wakes it then). What asks the instance to act holds only while it still can (#2303
   * review): "ready" while the card is open with nothing left to wait for, "start" and "answered" while it is in
   * progress, "sent back" while it is back with the instance. null when nothing is left.
   */
  wakeHolds(wake: Wake): Wake | null {
    const card = this.byUuid(wake.uuid);
    if (!card) return null;
    const handedOut = card.dispatcher?.kind === "instance" && card.dispatcher.name === wake.instance;
    const own = card.assignee === wake.instance;
    const waiting = this.unmetDeps(card).length > 0;
    // The words a reason quotes are the comment's as it stands now (an edit made since is what is told), and a comment that was deleted is not told.
    const quoted = (id: number | undefined): { text: string; gone: boolean } | null => {
      if (id === undefined) return null;
      const row = this.db.prepare("SELECT text, deleted_at FROM task_entries WHERE id = ?").get(id) as { text: string; deleted_at: string | null } | undefined;
      return !row || row.deleted_at ? { text: "", gone: true } : { text: row.text, gone: false };
    };
    let reasons = wake.reasons.filter((r) => {
      if ((r === "comment" || r === "mention") && quoted(wake.entries?.[r])?.gone) return false;
      if (r === "cancelled") return card.status === "cancelled" && own;
      // A mention was asked for by name: it holds whatever state the card is in, finished too.
      if (r === "mention") return true;
      // A follower is told how the card moved on while it still stands there (finished too), and while it still follows it.
      if (r === "progress") return !!wake.news && this.followersOf(card).has(wake.instance) && this.progressStands(card, wake.news);
      if (isFinished(card)) return false;
      if (r === "decide") return handedOut && card.status === "blocked";
      // #2341 review: and still waiting for the person — its confirmation not switched off during the gather.
      if (r === "to_confirm") return handedOut && card.status === "review" && requiresReview(card);
      if (!own) return false;
      // A card still waiting on what it depends on is read when it can start (as for an assignment, "assigned" above);
      // and a comment its assignee has already read — its own write since — is not told to it.
      if (r === "comment") return (card.status !== "open" || !waiting) && this.newComments(card).some((e) => e.kind === "comment");
      if (r === "confirm_own") return card.status === "review" && confirmingInstance(card) === wake.instance;
      if (r === "wrap_up") return card.status === "review" && wrapUpGap(card) !== null;
      if (r === "assigned") return !waiting;
      if (r === "ready") return card.status === "open" && !waiting;
      if (r === "start" || r === "answered") return card.status === "claimed";
      if (r === "answer_kept") return card.status === "blocked";
      if (r === "sent_back") return card.status === "claimed" || card.status === "open";
      return true;
    });
    // One piece of news says it all: a send-back outweighs the rest.
    if (reasons.includes("sent_back")) reasons = reasons.filter((r) => r !== "start");
    if (reasons.includes("assigned")) reasons = reasons.filter((r) => r !== "start" && r !== "ready");
    if (reasons.includes("mention")) reasons = reasons.filter((r) => r !== "comment");
    // The dispatcher's own, actionable news (a question to answer, a card to confirm) says what progress would.
    if (reasons.includes("decide") || reasons.includes("to_confirm")) reasons = reasons.filter((r) => r !== "progress");
    if (reasons.includes("cancelled")) reasons = ["cancelled"];
    if (!reasons.length) return null;
    const keep = <T>(o: Partial<Record<WakeReason, T>>) => Object.fromEntries(Object.entries(o).filter(([r]) => reasons.includes(r as WakeReason))) as Partial<Record<WakeReason, T>>;
    const held: Wake = { ...wake, title: card.title, reasons, texts: keep(wake.texts), by: keep(wake.by) };
    if (wake.replies) { const replies = keep(wake.replies); if (Object.keys(replies).length) held.replies = replies; else delete held.replies; }
    if (wake.entries) {
      const entries = keep(wake.entries);
      if (Object.keys(entries).length) held.entries = entries; else delete held.entries;
      for (const r of Object.keys(entries) as WakeReason[]) {
        const now = quoted(entries[r]);
        if (!now) continue;
        if (now.gone) delete held.texts[r]; else held.texts[r] = now.text;
      }
    }
    // What a reply quotes of the comment it answers is that comment's words now; one that has since been deleted is not quoted.
    if (held.replies) {
      for (const r of Object.keys(held.replies) as WakeReason[]) {
        const to = held.replies[r]!, now = quoted(to.id);
        if (now?.gone) delete held.replies[r]; else if (now && now.text !== to.text) held.replies[r] = { ...to, text: now.text };
      }
      if (!Object.keys(held.replies).length) delete held.replies;
    }
    if (!reasons.includes("progress")) delete held.news;
    if (!reasons.some((r) => WORD_REASONS.includes(r))) { delete held.principals; delete held.origins; }
    return held;
  }

  // ── Helpers ─────────────────────────────────────────────

  /**
   * One write, all or nothing (BEGIN IMMEDIATE: the CLI and the fleet share this file). Listeners hear about it after
   * it commits; a nested call joins the outer write.
   */
  private tx<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    this.pending = [];
    this.projectsChanged = false;
    this.notes = [];
    this.undo = [];
    try {
      let wakes: Wake[] = [];
      const result = this.db.transaction(() => {
        const r = fn();
        if (this.pending.length || this.projectsChanged) this.db.prepare("UPDATE task_counters SET next = next + 1 WHERE prefix = 'R'").run();
        const spokenBefore = this.notes.length;
        wakes = this.settleWakes(this.pending);
        // What settling the wakes said (who is told, a loop guard) reaches the writer's answer like the notes of the write itself.
        const late = this.notes.slice(spokenBefore);
        const answer = r as { notes?: unknown; said?: unknown } | null;
        if (late.length && answer && typeof answer === "object" && Array.isArray(answer.notes) && Array.isArray(answer.said)) {
          for (const n of late) { answer.notes.push(n.text); answer.said.push(n); }
        }
        return r;
      }).immediate();
      // Committed: the rows are there for good, so what undoes the file moves is forgotten — a failure from here on (a listener's
      // work, reading the revision) must not move files back from under rows that stay.
      this.undo = [];
      this.lastNotes = this.notes.map((n) => n.text);
      const touched = this.pending;
      const projects = this.projectsChanged;
      if (touched.length || projects) {
        const changed = [...new Set(touched.filter((e) => e.type === "moved" || e.type === "assigned").map((e) => e.uuid))];
        const recalled = touched.filter((e) => (e.type === "comment_edited" || e.type === "comment_deleted") && typeof e.data.entry === "number")
          .map((e) => ({ uuid: e.uuid, entry: e.data.entry as number, deleted: e.type === "comment_deleted" }));
        const change: BoardChange = { rev: this.revision(), ids: [...new Set(touched.map((e) => e.code))], actors: [...new Set(touched.map((e) => e.actor.name))], projects, wakes, changed, ...(recalled.length ? { recalled } : {}) };
        for (const listener of this.listeners) {
          try { listener(change); } catch { /* a listener must not break a write that already committed */ }
        }
      }
      return result;
    } catch (err) {
      // The write failed BEFORE it committed, after it moved files under a card: the rows are rolled back, so the files go back to staging.
      for (const back of this.undo.reverse()) { try { back(); } catch { /* the sweep removes it */ } }
      throw err;
    } finally {
      this.pending = [];
      this.projectsChanged = false;
      this.undo = [];
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private nextCode(prefix: "M" | "S"): string {
    const r = this.db.prepare("UPDATE task_counters SET next = next + 1 WHERE prefix = ? RETURNING next - 1 AS n").get(prefix) as { n: number };
    return `${prefix}-${r.n}`;
  }

  private nextSort(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM tasks").get() as { s: number }).s;
  }

  /** A card number, uuid, or "#n" for the n-th card of the same batch → that card's uuid. */
  private resolveRef(ref: string, batch: Card[]): string {
    const m = /^\s*#(\d+)\s*$/.exec(ref);
    if (!m) return this.getCard(ref).uuid;
    const n = Number(m[1]);
    if (n < 1 || n > batch.length) throw new TaskBoardError("invalid", `"#${n}" can only point at an earlier card of the same batch`);
    return batch[n - 1]!.uuid;
  }

  /** A sub task's parent: a main task that is not cancelled. */
  private resolveParent(uuid: string, actor: Actor): Card {
    const parent = this.byUuid(uuid)!;
    if (parent.kind !== "main") throw new TaskBoardError("invalid", `${parent.code} is a sub task; sub tasks are not split further — add more sub tasks to the main task`, "parent_is_sub", [parent.code]);
    if (parent.status === "cancelled") throw new TaskBoardError("invalid", `${parent.code} is cancelled; it takes no new sub tasks`, "parent_cancelled", [parent.code]);
    // A new sub task reopens a finished main task, and only a person reopens finished work.
    if (parent.status === "done" && !isPerson(actor)) throw new TaskBoardError("forbidden", `${parent.code} is done; ask the person to reopen it before adding to it`);
    return parent;
  }

  /** Valid, unique dependency uuids. Cycles are checked once the change is written (assertNoCycle). */
  private checkDeps(card: { uuid: string | null; kind: CardKind; parent: string | null }, refs: string[]): string[] {
    const out: string[] = [];
    for (const ref of refs) {
      const dep = this.byUuid(ref) ?? this.getCard(ref);
      if (dep.uuid === card.uuid) throw new TaskBoardError("invalid", "a card cannot depend on itself", "dep_self");
      if (card.kind === "sub" && dep.uuid === card.parent) throw new TaskBoardError("invalid", `a sub task cannot depend on its own main task ${dep.code} (the main task already waits for it)`, "dep_own_main", [dep.code]);
      if (card.kind === "main" && card.uuid && dep.parent === card.uuid) throw new TaskBoardError("invalid", `a main task cannot depend on its own sub task ${dep.code} (it already waits for it)`, "dep_own_sub", [dep.code]);
      if (!out.includes(dep.uuid)) out.push(dep.uuid);
    }
    return out;
  }

  /** What a card waits on: its dependencies; a sub task also its main task's; a main task its sub tasks. */
  private waitsOn(uuid: string): string[] {
    const card = this.byUuid(uuid);
    if (!card) return [];
    const out = [...card.deps];
    if (card.kind === "sub" && card.parent) out.push(...(this.byUuid(card.parent)?.deps ?? []));
    if (card.kind === "main") out.push(...this.activeSubs(card.uuid).map((k) => k.uuid));
    return out;
  }

  /** Refuse a dependency loop reachable from `start`, counting the implicit main/sub waits. */
  private assertNoCycle(start: string): void {
    const state = new Map<string, "visiting" | "done">();
    const visit = (uuid: string, path: string[]) => {
      if (state.get(uuid) === "done") return;
      if (state.get(uuid) === "visiting") {
        const loop = [...path.slice(path.indexOf(uuid)), uuid].map((u) => this.codeOf(u)).join(" → ");
        throw new TaskBoardError("invalid", `these dependencies would wait on each other forever: ${loop}`, "dep_cycle", [loop]);
      }
      state.set(uuid, "visiting");
      for (const next of this.waitsOn(uuid)) visit(next, [...path, uuid]);
      state.set(uuid, "done");
    };
    visit(start, []);
  }

  private checkVersion(card: Card, version: number | undefined): void {
    if (version === undefined || version === card.version) return;
    const last = this.db.prepare("SELECT actor FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(card.uuid) as { actor: string } | undefined;
    throw new TaskBoardError("conflict", `${card.code} changed meanwhile (you have v${version}, it is v${card.version}, last changed by ${last?.actor ?? "someone else"}); read it again first`, "conflict", [card.code, last?.actor ?? "?"]);
  }

  private assign(card: Card, assignee: string | null, actor: Actor): void {
    const from = card.assignee;
    this.checkAssignable(assignee, from);
    card.assignee = assignee;
    card.seenEntryId = 0;
    this.event(actor, card, "assigned", { from, to: assignee });
  }

  /**
   * A comment written, with the files that came with it: its entry, the files linked to it, and the
   * "commented" event. A write that brings files and no words leaves a line naming them (`📎 name, name`), which an
   * older release shows as the comment it is. False when there is nothing to write (no words, no files).
   */
  private writeComment(card: Card, actor: Actor, raw: string, attach: readonly string[] | undefined, kept = false, opts: { replyTo?: number; to?: readonly string[] } = {}): boolean {
    // What it answers is checked first: a reply to a comment that is not there writes nothing.
    const reply = opts.replyTo !== undefined ? this.replyTarget(card, opts.replyTo) : null;
    const files = attach?.length ? this.stagedFiles(card, actor, attach) : [];
    const words = checkText("the comment", raw, CARD_LIMITS.comment);
    const text = words || (files.length ? checkText("the comment", `📎 ${files.map((f) => f.name).join(", ")}`, CARD_LIMITS.comment) : "");
    if (!text) return false;
    // The `@` names are stored with the comment as it was written (the loop guard reads them back, not the words, which an edit or a
    // deletion changes): so is whom it was addressed to.
    const notify = this.notifyOf(actor, reply, opts.to, parseMentions(text, [...this.routing.instances()]).names);
    const entryId = this.entry(card, "comment", actor, text, { parentId: reply?.id ?? null, notify });
    this.linkFiles(card, actor, entryId, files);
    this.commented(actor, card, text, kept, files.length, { entry: entryId, reply, notify });
    return true;
  }

  /** The comment a reply answers: one of this card's comments that has not been deleted. */
  private replyTarget(card: Card, id: number): Entry {
    const row = this.db.prepare("SELECT * FROM task_entries WHERE id = ? AND task_id = ? AND kind = 'comment'").get(id, card.uuid) as Row | undefined;
    if (!row) throw new TaskBoardError("not_found", `${card.code} has no comment c${id} to reply to`, "comment_not_found", [card.code, `c${id}`]);
    const entry = this.toEntry(row);
    if (entry.deleted) throw new TaskBoardError("invalid", `comment c${id} on ${card.code} was deleted; reply to the comment above it`, "comment_deleted", [`c${id}`]);
    return entry;
  }

  /**
   * Whom a comment woke, or was meant to, as it is stored with it (`notify`, read back by the loop guard): `at`, the instances its
   * words `@`-named when it was written, and `to`, the recipients its writer chose (else — a reply that chose none — the author of
   * the comment it answers when that is an instance). `assignee: false` is a chosen recipient list: the card's assignee hears the
   * comment only if it is on it. They are kept apart from the words because the words change: an edit that takes an `@` out, or a
   * deletion, must not take its turn out of the agents' count. A row from before this (no `notify`, or one with no `at`) is read from
   * its words, as it always was.
   */
  private notifyOf(actor: Actor, reply: Entry | null, to: readonly string[] | undefined, at: readonly string[]): { to: string[]; assignee: boolean; at: string[] } {
    const chosen = to !== undefined;
    const names = [...(to ?? [])];
    if (!chosen && reply && reply.authorKind === "instance") names.push(reply.author);
    const direct = [...new Set(names.map((n) => n.trim()).filter(Boolean))].filter((n) => isPerson(actor) || n !== actor.name);
    return { to: direct.slice(0, MAX_RECIPIENTS), assignee: !chosen, at: [...at] };
  }

  /** The files `actor` staged, checked against this card's limits (nothing is moved yet). */
  private stagedFiles(card: Card, actor: Actor, ids: readonly string[]): StagedFile[] {
    const store = this.fileStore;
    if (!store) throw new TaskBoardError("invalid", "attachments are not available here (the fleet's scheduler holds the card files)");
    let files: StagedFile[];
    try { files = store.adopt(actor.name, ids); } catch (err) {
      if (err instanceof TaskFileError) throw new TaskBoardError("invalid", err.message);
      throw err;
    }
    const held = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM task_attachments WHERE task_id = ?").get(card.uuid) as { n: number; bytes: number };
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (held.n + files.length > TASK_FILE_LIMITS.files) {
      throw new TaskBoardError("too_long", `${card.code} holds ${held.n} files; at most ${TASK_FILE_LIMITS.files} on a card`);
    }
    if (held.bytes + bytes > TASK_FILE_LIMITS.cardBytes) {
      throw new TaskBoardError("too_long", `the files on ${card.code} would be ${Math.ceil((held.bytes + bytes) / (1024 * 1024))} MiB; at most ${Math.floor(TASK_FILE_LIMITS.cardBytes / (1024 * 1024))} MiB on a card`);
    }
    return files;
  }

  /** The staged files, now the card's: a row each, hung under `entryId`, and the file moved under the card. */
  private linkFiles(card: Card, actor: Actor, entryId: number, files: readonly StagedFile[]): void {
    if (!files.length) return;
    const store = this.fileStore!;
    const insert = this.db.prepare("INSERT INTO task_attachments (id, task_id, entry_id, name, mime, kind, size, sha256, author, author_kind, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const f of files) {
      insert.run(f.id, card.uuid, entryId, f.name, f.mime, f.kind, f.size, f.sha256, actor.name, actor.kind, this.nowIso());
      try { this.undo.push(store.commit(card.uuid, f)); } catch (err) {
        if (err instanceof TaskFileError) throw new TaskBoardError("invalid", err.message);
        throw new TaskBoardError("invalid", `the file ${f.name} could not be stored on ${card.code}`);
      }
    }
  }

  /** The files on a card, oldest first; a scope leaves out the ones its left-out authors wrote. */
  attachments(uuid: string, scope: ReadScope = {}): Attachment[] {
    const by = this.notBy(scope, "author");
    const rows = this.db.prepare(`SELECT * FROM task_attachments WHERE task_id = ?${by.sql} ORDER BY at, rowid`).all(uuid, ...by.args) as Row[];
    return rows.map((r) => this.toAttachment(r));
  }

  /** One file by its id, with the card it is on; undefined when there is none. */
  attachment(id: string): { file: Attachment; card: Card } | undefined {
    const r = this.db.prepare("SELECT * FROM task_attachments WHERE id = ?").get(id) as Row | undefined;
    const card = r ? this.byUuid(r.task_id as string) : undefined;
    return r && card ? { file: this.toAttachment(r), card } : undefined;
  }

  private toAttachment(r: Row): Attachment {
    return {
      id: r.id as string, cardId: this.codeOf(r.task_id as string), entryId: r.entry_id === null ? null : Number(r.entry_id), name: r.name as string,
      mime: r.mime as string, kind: r.kind === "photo" ? "photo" : "document", size: Number(r.size), author: r.author as string,
      authorKind: r.author_kind as Actor["kind"], at: r.at as string,
    };
  }

  /**
   * Any write by the assignee counts as having seen the comments so far, so the unseen ones go in its reply first;
   * otherwise a comment posted mid-task would be acknowledged without being read.
   */
  private surfaceComments(card: Card, actor: Actor): void {
    if (card.assignee !== actor.name) return;
    for (const e of this.newComments(card)) {
      const chars = [...e.text];
      const text = chars.length > 500 ? `${chars.slice(0, 500).join("")}… (read the whole card for the rest)` : e.text;
      this.say(e.kind === "reject" ? "sent_back" : "new_comment", [e.author, text], `${e.kind === "reject" ? "sent back" : "new comment"} (${e.author}): ${text}`);
    }
  }

  private markSeen(card: Card, actor: Actor): void {
    if (card.assignee !== actor.name) return;
    card.seenEntryId = (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM task_entries WHERE task_id = ?").get(card.uuid) as { m: number }).m;
  }

  private entry(card: Card, kind: EntryKind, actor: Actor, text: string, extra: { parentId?: number | null; notify?: { to: string[]; assignee: boolean; at: string[] } | null } = {}): number {
    const r = this.db.prepare("INSERT INTO task_entries (task_id, kind, author, author_kind, text, at, parent_id, notify, author_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(card.uuid, kind, actor.name, actor.kind, text, this.nowIso(), extra.parentId ?? null, extra.notify ? JSON.stringify(extra.notify) : null, actor.kind === "person" && actor.key ? actor.key : null);
    return Number(r.lastInsertRowid);
  }

  /**
   * A comment written (its entry is already on the card): the "commented" event, and whom the comment concerns, which
   * settleWakes reads when the write ends. `kept` is a dispatcher's answer a busy assignee finds on the card (#2303).
   */
  private commented(actor: Actor, card: Card, text: string, kept = false, files = 0, more: { entry?: number; reply?: Entry | null; notify?: { to: string[]; assignee: boolean; at: string[] } | null } = {}): void {
    this.event(actor, card, "commented", { text, ...(more.entry !== undefined ? { entry: more.entry } : {}), ...(kept ? { kept: true } : {}), ...(files ? { files } : {}) });
    this.pending[this.pending.length - 1]!.audience = this.routeComment(actor, card, text, kept, { notify: more.notify ?? null, reply: more.reply ?? null });
  }

  /**
   * Whom a comment wakes (docs/design/task-board.md, "Comments and mentions"): the card's assignee, when someone else
   * wrote it, and each instance it names with `@<instance>` (not its writer; one wake per instance however often it is
   * named). What cannot be woken is said in the writer's notes, never refused: a name that is no instance is ignored,
   * and so is one with the task board off (it has no `task` tool to act on a notice with). An agent's comment is held
   * to the loop guard (AGENT_COMMENT_CHAIN, MAX_COMMENT_WAKES). A card that is not on the board (the `task` tool's own
   * task) wakes nobody by a comment, as it wakes nobody by an assignment.
   */
  private routeComment(author: Actor, card: Card, text: string, kept: boolean,
    opts: { notify?: { to: string[]; assignee: boolean; at?: string[] } | null; reply?: Entry | null; only?: readonly string[] } = {}): CommentAudience {
    const none: CommentAudience = { mentions: [], assignee: false };
    if (author.kind === "system" || !this.routing.enabled() || !this.isOnBoard(card)) return none;
    const names = [...this.routing.instances()];
    const parsed = parseMentions(text, names);
    const agent = author.kind !== "person";
    // An edit wakes only the instances its new words name that the old ones did not (`only`); a comment its writer
    // addressed (`notify.to`) wakes those too. The card's assignee hears a comment by the old rule — unless its writer
    // chose the recipients, when it hears it only if it is among them (and then as the card's assignee, as always).
    const editing = opts.only !== undefined;
    const notify = editing ? null : opts.notify ?? null;
    const chosen = (notify?.to ?? []).filter((n) => names.includes(n));
    const unknownChosen = (notify?.to ?? []).filter((n) => !names.includes(n));
    const toAssignee = card.assignee !== null && chosen.includes(card.assignee);
    // A comment to the assignee is the old rule's comment (it is told only while it can act on it). One the writer chose it for
    // is asked for by name, as an `@` is: on a finished card, or one still waiting on what it depends on, where the old rule
    // tells nobody, it goes as a mention — what the recipient chip says is what happens.
    const asMention = toAssignee && (isFinished(card) || (card.status === "open" && this.unmetDeps(card).length > 0));
    const hearsAsAssignee = !editing && (notify === null || notify.assignee || (toAssignee && !asMention));
    const written = parsed.names.filter((n) => !editing || opts.only!.includes(n));
    // Only an instance (or a script) is itself: a person whose name is an instance's name is someone else, and a mention
    // of that instance is for it (the board's names are one string, but an `@name` always means the instance).
    let mentions = [...new Set([...chosen.filter((n) => n !== card.assignee || asMention), ...written])].filter((n) => (agent ? n !== author.name : true));
    for (const n of mentions.filter((m) => this.boardOff(m))) {
      this.say("mention_off", [n], `@${n} has the task board switched off, so it was not woken: it cannot read the card`);
    }
    mentions = mentions.filter((n) => !this.boardOff(n));
    let asAssignee = hearsAsAssignee && !kept && card.assignee !== null && card.assignee !== author.name && names.includes(card.assignee) && !this.boardOff(card.assignee) && !mentions.includes(card.assignee);
    // An agent's words reach another instance only as its contact rules allow (M-3160 / M-3384), per recipient.
    // The assignee is asked whatever the board knows of it: settleWakes adds it to any comment that leaves it out.
    const held = agent ? mentions.filter((n) => !this.mayReach(author, n)) : [];
    const assigneeHeld = agent && hearsAsAssignee && !kept && card.assignee !== null && card.assignee !== author.name && !this.mayReach(author, card.assignee);
    if (assigneeHeld) { if (!held.includes(card.assignee!)) held.push(card.assignee!); asAssignee = false; }
    if (held.length) {
      mentions = mentions.filter((n) => !held.includes(n));
      this.say("contact_held", [held.join(", ")], `${held.join(", ")} not woken by this comment: this conversation may not reach another instance on its own `
        + `(its origin is unknown or not an administrator's, or a Hub contact restriction is on). The comment is kept on the card; to reach them, use send_to_instance, which asks for the approval where one can be given`);
    }
    const unknown = [...(editing ? [] : parsed.unknown.map((w) => `@${w}`)), ...unknownChosen.map((n) => `@${n}`)];
    if (unknown.length) {
      this.say("mention_unknown", [unknown.join(", ")], `${unknown.join(", ")}: no such instance, nobody was woken for it`);
    }
    const run = agent && (mentions.length || asAssignee) ? this.agentCommentRun(card, names) : 0;
    if (run > AGENT_COMMENT_CHAIN) {
      this.say("comment_chain", [card.code, run], `nobody was woken by this comment: it is turn ${run} of agents answering each other on ${card.code} (a loop guard). It is kept on the card; `
        + `comments wake again once a person writes on it, or when these are ${AGENT_COMMENT_WINDOW_MS / 60_000} minutes old`);
      return none;
    }
    // The limit is for everyone the comment wakes, counted once each: the card's assignee, when it hears the comment —
    // named or not, wherever its name is in the text (settleWakes adds it to a comment that does not name it), and also
    // when the comment is a dispatcher's answer kept for a busy assignee (its baseline `answer_kept` notice, #2303, which
    // no gate holds) — takes one place, and the instances named besides it share the rest in the order written (#4367
    // review). It is counted whenever settleWakes would add it, so the board's own wakes never pass the limit.
    const assigneeWakes = card.assignee !== null && card.assignee !== author.name && (kept || (hearsAsAssignee && !assigneeHeld));
    const others = mentions.filter((n) => !(assigneeWakes && n === card.assignee));
    const room = MAX_COMMENT_WAKES - (assigneeWakes ? 1 : 0);
    if (agent && others.length > room) {
      this.say("mention_cap", [room], `only the first ${room} instances you mentioned were woken (an agent's comment wakes at most ${MAX_COMMENT_WAKES}, the card's assignee included)`);
      const kept = new Set(others.slice(0, room));
      mentions = mentions.filter((n) => kept.has(n) || (assigneeWakes && n === card.assignee));
    }
    const addressed = (n: string) => chosen.includes(n) && !written.includes(n);
    const heard = [...mentions.map((n) => `${n} (${addressed(n) ? "addressed" : "mentioned"})`), ...(asAssignee ? [`${card.assignee} (assignee)`] : [])];
    if (heard.length) this.say("comment_wakes", [heard.join(", ")], `this comment is told to ${heard.join(", ")} as a [Task board] notice: no need to message them about it`);
    const reply = opts.reply ? { id: opts.reply.id, author: opts.reply.author, text: [...opts.reply.text.replace(/\s+/g, " ").trim()].slice(0, 160).join("") } : undefined;
    return { mentions, assignee: hearsAsAssignee && !kept && !assigneeHeld, ...(reply ? { reply } : {}) };
  }

  /**
   * How many turns the agents' talk on the card has had, within AGENT_COMMENT_WINDOW_MS, back to the last thing a person
   * wrote on it (their comment, send-back or confirmation): the comments by agents (anything but a person) that woke
   * someone, a change of writer counting as the next turn. The newest is counted. What woke someone is read again from
   * the comment as it was written: it names an instance other than its writer, or the card's assignee *at that time* was
   * an instance other than its writer — read from the card's own assignment events (`assigned`: from, to), never from
   * today's assignee, so handing the card to one of the two talking does not turn the other's comments into notes to
   * itself and lift the guard. An agent's note to itself on its own card wakes nobody: it is no turn of a loop, so it
   * neither counts nor breaks the chain; and one agent writing twice in a row is one turn, as nobody has answered it.
   */
  private agentCommentRun(card: Card, names: readonly string[]): number {
    const since = new Date(this.now().getTime() - AGENT_COMMENT_WINDOW_MS).toISOString();
    // Assignments since the window began, oldest first: the first one after a comment says who had the card before it.
    const handovers = (this.db.prepare("SELECT at, data FROM task_events WHERE task_id = ? AND type = 'assigned' AND at >= ? ORDER BY id").all(card.uuid, since) as Array<{ at: string; data: string }>)
      .map((e) => { try { return { at: e.at, from: (JSON.parse(e.data) as { from?: unknown }).from }; } catch { return { at: e.at, from: undefined }; } });
    // Every entry of the window is read, newest first, until a person's: a fixed page could be filled by notes that wake
    // nobody and leave the turns before them unread, so that the next comment reads as turn 1 (#4367 review). The window
    // bounds it; a person's entry ends it early.
    // (Read last: nothing else may run on the connection while it is read.)
    const rows = this.db.prepare("SELECT kind, author, author_kind, text, at, notify FROM task_entries WHERE task_id = ? AND kind IN ('comment', 'reject', 'approve') AND at >= ? ORDER BY id DESC")
      .iterate(card.uuid, since) as IterableIterator<{ kind: EntryKind; author: string; author_kind: string; text: string; at: string; notify: string | null }>;
    const assigneeAt = (at: string): string | null => {
      const next = handovers.find((h) => h.at > at);
      if (!next) return card.assignee;
      return typeof next.from === "string" ? next.from : null;
    };
    const assigneeHears = (by: string, at: string) => { const a = assigneeAt(at); return a !== null && a !== by && names.includes(a); };
    // A comment its writer addressed (the recipients stored with it, a reply's author among them) woke those instances without an
    // `@`: they count as the mentions do — and the assignee hears it only when the writer left that rule on (`assignee`).
    // `at`: the `@` names stored when it was written (null: a row from before they were stored — its words say). An edit or a deletion
    // changes the words, never what was stored, so neither takes a turn out of the count.
    const notified = (raw: string | null): { to: string[]; assignee: boolean; at: string[] | null } => {
      const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      if (!raw) return { to: [], assignee: true, at: null };
      try { const n = JSON.parse(raw) as { to?: unknown; assignee?: unknown; at?: unknown }; return { to: strs(n.to), assignee: n.assignee !== false, at: Array.isArray(n.at) ? strs(n.at) : null }; } catch { return { to: [], assignee: true, at: null }; }
    };
    let turns = 0;
    let writer: string | null = null;
    for (const r of rows) {
      if (r.author_kind === "person") break;
      if (r.kind !== "comment") continue;
      const n = notified(r.notify);
      // The assignee a writer addressed by `to` is among `to`, so it counts there; the old rule (`assignee`) counts it as it did.
      const named = n.at ?? parseMentions(r.text, names).names;
      if (!(named.some((m) => m !== r.author && names.includes(m)) || n.to.some((m) => m !== r.author && names.includes(m)) || (n.assignee && assigneeHears(r.author, r.at)))) continue;
      if (r.author !== writer) { turns++; writer = r.author; }
    }
    return turns;
  }

  private event(actor: Actor, card: Card, type: CardEventType, data: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO task_events (at, actor, actor_kind, task_id, type, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.nowIso(), actor.name, actor.kind, card.uuid, type, JSON.stringify(data));
    this.pending.push({ code: card.code, uuid: card.uuid, actor, type, data });
  }

  private insert(card: Card): void {
    this.db.prepare(
      `INSERT INTO tasks (id, code, kind, project_id, parent_id, title, description, status, priority, assignee, dispatcher, dispatcher_kind, created_by, depends_on, result,
        scope, acceptance, context, state, blocked_reason, size, needs_review, version, sort, created_at, updated_at, started_at, submitted_at, done_at, seen_entry_id, on_board)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      card.uuid, card.code, card.kind, card.projectId, card.parent, card.title, card.goal === "" ? null : card.goal, card.status, card.priority,
      card.assignee, card.dispatcher?.name ?? null, card.dispatcher?.kind ?? null, card.createdBy, card.deps.length ? JSON.stringify(card.deps) : null, card.result === "" ? null : card.result,
      card.scope, JSON.stringify(card.acceptance), card.context, card.state, card.blockedReason, card.size, card.needsReview ? 1 : 0,
      card.version, card.sort, card.createdAt, card.updatedAt, card.startedAt, card.submittedAt, card.doneAt, card.seenEntryId, card.onBoard ? 1 : 0,
    );
  }

  /** Empty text is stored as NULL in the columns the `task` tool has always had (description, result, depends_on). */
  private save(card: Card): void {
    this.db.prepare(
      `UPDATE tasks SET project_id = ?, title = ?, description = ?, status = ?, priority = ?, assignee = ?, dispatcher = ?, dispatcher_kind = ?,
        depends_on = ?, result = ?, scope = ?, acceptance = ?, context = ?, state = ?, blocked_reason = ?, size = ?, needs_review = ?, version = ?,
        sort = ?, updated_at = ?, started_at = ?, submitted_at = ?, done_at = ?, seen_entry_id = ?
       WHERE id = ?`,
    ).run(
      card.projectId, card.title, card.goal === "" ? null : card.goal, card.status, card.priority, card.assignee,
      card.dispatcher?.name ?? null, card.dispatcher?.kind ?? null,
      card.deps.length ? JSON.stringify(card.deps) : null, card.result === "" ? null : card.result,
      card.scope, JSON.stringify(card.acceptance), card.context, card.state, card.blockedReason, card.size, card.needsReview ? 1 : 0,
      card.version, card.sort, card.updatedAt, card.startedAt, card.submittedAt, card.doneAt, card.seenEntryId, card.uuid,
    );
  }
}
