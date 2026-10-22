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
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

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
const BATCH_MAX = 30;

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
}

/** A card as the dashboard draws it: references by card number. */
export interface CardView {
  id: string;
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
  /** Comments by others its assignee has not acted on yet. */
  newCommentCount: number;
  lastComment: { author: string; authorKind: Actor["kind"]; at: string } | null;
}

export type EntryKind = "log" | "comment" | "reject" | "approve";
export interface Entry {
  id: number;
  cardId: string;
  kind: EntryKind;
  author: string;
  authorKind: Actor["kind"];
  text: string;
  at: string;
}

export type CardEventType = "created" | "updated" | "moved" | "assigned" | "commented" | "logged" | "reordered";
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
 * started it, sent it back, answered its blocked question, commented, or finished the last card it waited for; the
 * person confirmed it (its assignee and its dispatcher hear); it is blocked and the instance handed it out (decide);
 * it went to the person for confirmation and the instance handed it out, so it tells them (to_confirm);
 * a main task went to the person by itself before its owner wrapped it up (wrap_up); or someone else cancelled it — a
 * main task's cancel takes its unfinished sub tasks down with it, and their assignees hear (cancelled).
 */
export type WakeReason = "assigned" | "start" | "sent_back" | "answered" | "comment" | "ready" | "decide" | "to_confirm" | "approved" | "wrap_up" | "cancelled";

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
}

/** What one committed write changed, for live views: the card numbers touched (none for a project change). */
export interface BoardChange {
  /** The board's revision after this write (revision()). */
  rev: number;
  ids: string[];
  actors: string[];
  projects: boolean;
  /** Whom to wake about what (the fleet's waker); a page is sent the rest. */
  wakes: Wake[];
}

export interface CardDetail {
  card: CardView;
  parent: { id: string; title: string; status: CardStatus } | null;
  children: CardView[];
  comments: Entry[];
  logs: Entry[];
  history: CardEvent[];
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
}

export interface MoveOptions {
  reason?: string;
  result?: string;
  comment?: string;
  version?: number;
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

/** A card waits for the person's confirmation when it is finished. */
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
  private pending: Array<{ code: string; uuid: string; actor: Actor; type: CardEventType; data: Record<string, unknown> }> = [];
  private projectsChanged = false;
  private notes: Note[] = [];
  /** The notes of the last write, until a caller of the `task` tool's old actions takes them (takeNotes). */
  private lastNotes: string[] = [];
  private codes = new Map<string, string>();

  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

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

  createProject(actor: Actor, input: { name: string; description?: string; leadInstance?: string | null }): Project {
    this.personOnly(actor, "create a project");
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
  boardCards(days = BOARD_DAYS, allDone = false): Card[] {
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE
         (kind = 'main' AND (status NOT IN ('done', 'cancelled') OR (status = 'done' AND (? OR COALESCE(done_at, updated_at) >= ?)) OR (status = 'cancelled' AND updated_at >= ?)))
         OR (kind = 'sub' AND status != 'cancelled' AND (status != 'done' OR COALESCE(done_at, updated_at) >= ?))
       ORDER BY sort`,
    ).all(allDone ? 1 : 0, since, since, since) as Row[];
    return rows.map(toCard);
  }

  /**
   * Each project's numbers (by id; "none" for No project) over all its cards, finished ones included: main tasks,
   * work units (a main task's sub tasks, or one unit for a main task without them; a done main task counts all its
   * units done), cards waiting for the person and blocked, and the last change. One pass over the table.
   */
  projectStats(): Record<string, ProjectStats> {
    const rows = this.db.prepare("SELECT id, kind, status, project_id, parent_id, updated_at FROM tasks").all() as Row[];
    const subs = new Map<string, Progress>();
    for (const r of rows) {
      if (r.kind !== "sub" || !r.parent_id || r.status === "cancelled") continue;
      const p = subs.get(r.parent_id as string) ?? { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 };
      p.total++;
      p[r.status as Exclude<CardStatus, "cancelled">]++;
      subs.set(r.parent_id as string, p);
    }
    const out: Record<string, ProjectStats> = {};
    for (const r of rows) {
      const key = r.project_id === null || r.project_id === undefined ? "none" : String(r.project_id);
      const st = out[key] ??= { mains: 0, units: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, percent: 0, waiting: 0, blocked: 0, lastActivity: null };
      if (!st.lastActivity || (r.updated_at as string) > st.lastActivity) st.lastActivity = r.updated_at as string;
      const status = r.status as CardStatus;
      if (status === "cancelled") continue;
      if (status === "review") st.waiting++;
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

  view(card: Card, scope: ReadScope = {}): CardView {
    return this.views([card], scope)[0]!;
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
  views(cards: Card[], scope: ReadScope = {}): CardView[] {
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
       JOIN (SELECT task_id, COUNT(*) AS n, MAX(id) AS last FROM task_entries WHERE kind IN ('comment', 'reject', 'approve')${by.sql} GROUP BY task_id) n ON e.id = n.last`,
    ).all(...by.args) as Array<{ task_id: string; n: number; author: string; author_kind: Actor["kind"]; at: string }>).map((r) => [r.task_id, r]));
    const unseen = new Map((this.db.prepare(
      `SELECT t.id AS id, COUNT(e.id) AS n FROM tasks t JOIN task_entries e
         ON e.task_id = t.id AND e.id > t.seen_entry_id AND e.kind IN ('comment', 'reject') AND e.author IS NOT t.assignee${eBy.sql}
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
        newCommentCount: unseen.get(card.uuid) ?? 0,
        lastComment: c ? { author: c.author, authorKind: c.author_kind, at: c.at } : null,
      };
    });
  }

  detail(ref: string, scope: ReadScope = {}): CardDetail {
    const card = this.getCard(ref);
    const parent = card.parent ? this.byUuid(card.parent) : undefined;
    return {
      card: this.view(card, scope),
      parent: parent ? { id: parent.code, title: parent.title, status: parent.status } : null,
      children: this.views(this.children(card.uuid), scope),
      comments: this.entries(card.uuid, ["comment", "reject", "approve"], 200),
      logs: this.entries(card.uuid, ["log"], 200),
      history: this.events(card.uuid, 200).filter((e) => e.type !== "reordered"),
    };
  }

  /** The latest `limit` entries of a card, oldest first. */
  entries(uuid: string, kinds: EntryKind[], limit = 20): Entry[] {
    const rows = this.db.prepare(`SELECT * FROM task_entries WHERE task_id = ? AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY id DESC LIMIT ?`)
      .all(uuid, ...kinds, limit) as Row[];
    return rows.map((r) => this.toEntry(r)).reverse();
  }

  /** Comments and rejections by others that the assignee has not acted on yet. */
  newComments(card: Card): Entry[] {
    const rows = this.db.prepare("SELECT * FROM task_entries WHERE task_id = ? AND id > ? AND kind IN ('comment', 'reject') AND author IS NOT ? ORDER BY id")
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
    return {
      id: Number(r.id),
      cardId: this.codeOf(r.task_id as string),
      kind: r.kind as EntryKind,
      author: r.author as string,
      authorKind: r.author_kind as Actor["kind"],
      text: r.text as string,
      at: r.at as string,
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
  listCards(filter: { project?: string | number | null; parent?: string; assignee?: string; status?: CardStatus[]; limit?: number }): { cards: Card[]; total: number } {
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
    const rows = this.db.prepare(`SELECT * ${from} ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END, ${STATUS_ORDER}, ${PRIORITY_ORDER}, sort LIMIT ?`).all(...params, limit) as Row[];
    return { cards: rows.map(toCard), total: n };
  }

  /** On the board's terms: in a project, a sub task, one with sub tasks, or one that waits for the person. */
  isOnBoard(card: Card): boolean {
    return card.projectId !== null || card.kind === "sub" || card.needsReview || this.activeSubs(card.uuid).length > 0;
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

  /**
   * What waits for the person (step 3: Needs you): cards in review that need their confirmation, and blocked cards —
   * oldest first, each with when it started waiting (its last move to that status).
   */
  waitingForPerson(): Array<{ card: Card; since: string }> {
    const rows = (this.db.prepare("SELECT * FROM tasks WHERE (status = 'review' AND needs_review = 1) OR status = 'blocked' ORDER BY updated_at").all() as Row[]).map(toCard);
    const moved = this.db.prepare("SELECT at FROM task_events WHERE task_id = ? AND type = 'moved' AND json_extract(data, '$.to') = ? ORDER BY id DESC LIMIT 1");
    return rows.map((card) => {
      const at = (moved.get(card.uuid, card.status) as { at: string } | undefined)?.at;
      return { card, since: at ?? card.submittedAt ?? card.updatedAt };
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
       WHERE t.status IN ('open', 'claimed', 'blocked', 'review') AND e.id > t.seen_entry_id AND e.kind IN ('comment', 'reject') AND e.author IS NOT t.assignee ORDER BY e.id`,
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

  /**
   * Step 3, the daily summary (task-board-summary.ts): what waits for the person now, what got done and what was
   * opened in [since, until) (not cancelled), and every live main task's project and assignee.
   */
  summaryRead(since: string, until: string): { waiting: Card[]; done: Card[]; created: Card[]; mains: Array<{ projectId: number | null; assignee: string | null }> } {
    const between = (sql: string) => (this.db.prepare(sql).all(since, until) as Row[]).map(toCard);
    return {
      waiting: this.waitingForPerson().map((w) => w.card),
      done: between("SELECT * FROM tasks WHERE status = 'done' AND done_at >= ? AND done_at < ? ORDER BY sort"),
      created: between("SELECT * FROM tasks WHERE status != 'cancelled' AND created_at >= ? AND created_at < ? ORDER BY sort"),
      mains: (this.db.prepare("SELECT project_id, assignee FROM tasks WHERE kind = 'main' AND status != 'cancelled'").all() as Row[])
        .map((r) => ({ projectId: (r.project_id as number | null) ?? null, assignee: (r.assignee as string | null) ?? null })),
    };
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
          const needsReview = spec.needsReview ?? kind === "main";
          if (!needsReview && kind === "main" && !isPerson(actor)) throw new TaskBoardError("forbidden", "only a person can open a main task that skips their confirmation");
          const now = this.nowIso();
          const assignee = spec.assignee !== undefined ? normalizeAssignee(spec.assignee) : isPerson(actor) ? null : actor.name;
          const opener: Dispatcher | null = isPerson(actor) ? { kind: "person", name: actor.name }
            : actor.kind === "instance" && assignee && assignee !== actor.name ? { kind: "instance", name: actor.name } : null;
          const card: Card = {
            uuid: randomUUID(),
            code: this.nextCode(kind === "main" ? "M" : "S"),
            kind,
            projectId,
            parent: parent?.uuid ?? null,
            title,
            status: "open",
            assignee,
            dispatcher: spec.dispatcher !== undefined ? toDispatcher(spec.dispatcher, actor) : (parent?.dispatcher ?? opener),
            priority: spec.priority ?? "normal",
            size: spec.size ?? null,
            needsReview,
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
      if (patch.dispatcher !== undefined) set("dispatcher", toDispatcher(patch.dispatcher, actor), "dispatcher", (d) => d?.name ?? null);
      if (patch.needsReview !== undefined) {
        if (ai && card.needsReview && !patch.needsReview) throw new TaskBoardError("forbidden", "only a person can clear \"needs review\"");
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
        if (ai) throw new TaskBoardError("forbidden", "only a person can move a main task to another project");
        if (card.kind !== "main") throw new TaskBoardError("invalid", "a sub task follows its main task's project; move the main task", "sub_project");
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
      if (patch.comment !== undefined) {
        const text = checkText("the comment", patch.comment, CARD_LIMITS.comment);
        if (text) {
          this.entry(card, "comment", actor, text);
          this.event(actor, card, "commented", { text });
          touched = true;
        }
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
          const text = checkText("the comment", comment!, CARD_LIMITS.comment);
          this.entry(card, "comment", actor, text);
          this.event(actor, card, "commented", { text });
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

      this.applyMove(card, actor, to, reason, comment);
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

  // ── Writing: the fleet's `task` tool (and the old /ui/tasks routes) ──

  /**
   * A task as the `task` tool has always opened it: a main task under no project, assigned only when asked, with no
   * review gate unless a person later sets one. Dependencies are stored as given (ids are not checked).
   */
  legacyCreate(actor: Actor, params: { title: string; description?: string; priority?: CardPriority; assignee?: string; depends_on?: string[] }): Card {
    return this.tx(() => {
      const now = this.nowIso();
      const card: Card = {
        uuid: randomUUID(), code: this.nextCode("M"), kind: "main", projectId: null, parent: null, title: params.title, status: "open",
        assignee: params.assignee ?? null, priority: params.priority ?? "normal", size: null, needsReview: false,
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
   * `task done`: from open or claimed. A card that needs the person's confirmation goes to review instead, so no
   * instance can finish one alone. On the board, an instance finishes as it would there: its own card, with a result
   * (an open one is claimed first, under the same rules).
   */
  legacyComplete(actor: Actor, uuid: string, result?: string): Card {
    return this.tx(() => {
      const card = this.byUuid(uuid);
      if (!card) throw new Error(`Task "${uuid}" not found`);
      if (card.status !== "claimed" && card.status !== "open") {
        throw new Error(`Task "${uuid}" is ${card.status}, cannot complete (must be open or claimed)`);
      }
      const open = this.children(card.uuid).filter((k) => !isFinished(k));
      if (open.length) throw new Error(`Task "${card.code}" still has unfinished sub tasks: ${open.map((k) => k.code).join(", ")}`);
      if (result !== undefined && result !== card.result) {
        this.event(actor, card, "updated", { changes: { result: { from: card.result, to: result } } });
        card.result = result;
      }
      const to: CardStatus = requiresReview(card) && !isPerson(actor) ? "review" : "done";
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
            if (card.status === "review" && to === "done") throw new Error(`Task "${card.code}" is waiting for the person's confirmation`);
            if (to === "done" && requiresReview(card)) to = "review";
            if (held && to !== card.status) this.checkManualMove(card, actor, to, "");
          }
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
          if (ai) {
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
          if (from === "review") throw new TaskBoardError("forbidden", `${card.code} is waiting for the person's confirmation: only they finish it`);
          if (from !== "claimed") throw new TaskBoardError("invalid", `only a card in progress can be done (${card.code} is ${from})`);
          if (!own) throw notOwner();
          if (requiresReview(card)) throw new TaskBoardError("needs_review", `${card.code} needs the person's confirmation; move it to review`);
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
  private applyMove(card: Card, actor: Actor, to: CardStatus, reason: string, comment?: string): void {
    const from = card.status;
    const now = this.nowIso();
    card.status = to;
    if (to === "claimed" && !card.startedAt) card.startedAt = now;
    if (to === "review") card.submittedAt = now;
    card.doneAt = to === "done" ? now : null;
    card.blockedReason = to === "blocked" ? reason : "";
    if (comment?.trim()) {
      const text = checkText("the comment", comment, CARD_LIMITS.comment);
      this.entry(card, "comment", actor, text);
      this.event(actor, card, "commented", { text });
    }
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
   * are all done, review (or done, for one that skips the person's confirmation). Only a person moves it from review
   * to done. A blocked or cancelled main task is left alone, and so is one without sub tasks (it is moved by hand).
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
    if (next === "review") this.say("review_waiting", [main.code, main.title], `${main.code} "${main.title}": every sub task is done; it is waiting for the person's confirmation`);
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

  // ── Wakes ───────────────────────────────────────────────

  /**
   * Whom this write wakes, read from its events once it is all written (still inside it): an instance hears only about
   * what someone else did to a card that is its own — or that it handed out (a blocked question, a confirmation). The
   * board's own catch-up wakes nobody, except that a card finishing — by hand or by itself — readies the cards that
   * waited only for it. wakeHolds() then drops what no longer stands.
   */
  private settleWakes(events: TaskBoard["pending"]): Wake[] {
    const out = new Map<string, Wake>();
    const add = (card: Card, instance: string | null | undefined, reason: WakeReason, by: Actor, text?: string) => {
      if (!instance || instance === by.name) return;
      const key = `${instance}\u0000${card.uuid}`;
      const w = out.get(key) ?? { instance, uuid: card.uuid, code: card.code, title: card.title, parent: card.parent ? this.codeOf(card.parent) : null, reasons: [], by: {}, texts: {} };
      if (!w.reasons.includes(reason)) w.reasons.push(reason);
      if (text) w.texts[reason] = text;
      w.by[reason] = by.name;
      out.set(key, w);
    };
    const comments = new Map<string, string>();
    for (const e of events) if (e.type === "commented") comments.set(e.uuid, String(e.data.text ?? ""));
    for (const e of events) {
      const card = this.byUuid(e.uuid);
      if (!card) continue;
      const d = e.data as { from?: CardStatus; to?: CardStatus; auto?: boolean; reason?: string; assignee?: string | null; text?: string; cascade?: string };
      const dispatcherOf = () => (card.dispatcher?.kind === "instance" && card.dispatcher.name !== card.assignee ? card.dispatcher.name : null);
      // The `task` tool's own tasks are handed over with a message of their own (delegate_task): no notice besides.
      if (e.type === "created") { if (this.isOnBoard(card)) add(card, d.assignee ?? null, "assigned", e.actor); }
      else if (e.type === "assigned") { if (this.isOnBoard(card)) add(card, (d.to as string | null) ?? null, "assigned", e.actor); }
      else if (e.type === "commented") add(card, card.assignee, "comment", e.actor, d.text);
      else if (e.type === "moved") {
        if (d.to === "done") this.wakeReady(card, e.actor, add);
        if (d.to === "cancelled") {
          // Taken down with its main task: why the main task was cancelled.
          const main = d.cascade ? events.find((x) => x.code === d.cascade && x.type === "moved" && x.data.to === "cancelled") : undefined;
          const why = d.cascade ? `with its main task ${d.cascade}${main?.data.reason ? `: ${String(main.data.reason)}` : ""}` : d.reason;
          add(card, card.assignee, "cancelled", e.actor, why);
          continue;
        }
        // Its dispatcher tells the person it waits for them (not the board).
        if (d.to === "review" && !isPerson(e.actor) && requiresReview(card)) add(card, dispatcherOf(), "to_confirm", e.actor);
        if (d.auto) {
          if (d.to === "review" && card.kind === "main" && wrapUpGap(card)) add(card, card.assignee, "wrap_up", e.actor);
          continue;
        }
        if (d.from === "open" && d.to === "claimed") add(card, card.assignee, "start", e.actor);
        else if (d.from === "blocked" && d.to === "claimed") add(card, card.assignee, "answered", e.actor, comments.get(card.uuid));
        else if (d.from === "review" && (d.to === "claimed" || d.to === "open") && isPerson(e.actor)) add(card, card.assignee, "sent_back", e.actor, d.reason);
        else if (d.from === "review" && d.to === "done" && isPerson(e.actor)) {
          add(card, card.assignee, "approved", e.actor, d.reason);
          add(card, dispatcherOf(), "approved", e.actor, d.reason);
        }
        if (d.to === "blocked" && !isPerson(e.actor)) add(card, dispatcherOf(), "decide", e.actor, d.reason);
      }
    }
    return [...out.values()].map((w) => this.wakeHolds(w)).filter((w): w is Wake => w !== null);
  }

  /** A finished card readies the open cards that waited only for it (a sub task also waits for its main task's). */
  private wakeReady(done: Card, by: Actor, add: (card: Card, instance: string | null, reason: WakeReason, by: Actor) => void): void {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'open' AND assignee IS NOT NULL AND (depends_on LIKE ? OR parent_id IN (SELECT id FROM tasks WHERE depends_on LIKE ?))")
      .all(`%"${done.uuid}"%`, `%"${done.uuid}"%`) as Row[];
    for (const card of rows.map(toCard)) if (!this.unmetDeps(card).length) add(card, card.assignee, "ready", by);
  }

  /**
   * What of a wake still stands now (at the end of its write, and again when the fleet sends it): a finished card is
   * news only as a confirmation; a card that is no longer the instance's is not; a question only while the card is
   * blocked and the instance still handed it out; a wrap-up only while it waits unfinished; and an assignment or a
   * comment only once the card can start (its "ready" wakes it then). What asks the instance to act holds only while
   * it still can (#2303 review): "ready" while the card is open with nothing left to wait for, "start" and "answered"
   * while it is in progress, "sent back" while it is back with the instance; a comment only while its assignee has not
   * read it (its own write since showed it, as the `task` tool's answer). null when nothing is left.
   */
  wakeHolds(wake: Wake): Wake | null {
    const card = this.byUuid(wake.uuid);
    if (!card) return null;
    const handedOut = card.dispatcher?.kind === "instance" && card.dispatcher.name === wake.instance;
    const own = card.assignee === wake.instance;
    const waiting = this.unmetDeps(card).length > 0;
    let reasons = wake.reasons.filter((r) => {
      if (r === "approved") return card.status === "done" && (own || handedOut);
      if (r === "cancelled") return card.status === "cancelled" && own;
      if (isFinished(card)) return false;
      if (r === "decide") return handedOut && card.status === "blocked";
      // #2341 review: and still waiting for the person — its confirmation not switched off during the gather.
      if (r === "to_confirm") return handedOut && card.status === "review" && requiresReview(card);
      if (!own) return false;
      if (r === "wrap_up") return card.status === "review" && wrapUpGap(card) !== null;
      if (r === "assigned") return !waiting;
      if (r === "comment") return !waiting && this.newComments(card).length > 0;
      if (r === "ready") return card.status === "open" && !waiting;
      if (r === "start" || r === "answered") return card.status === "claimed";
      if (r === "sent_back") return card.status === "claimed" || card.status === "open";
      return true;
    });
    // One piece of news says it all: the answer is the comment, a send-back outweighs the rest.
    if (reasons.includes("answered")) reasons = reasons.filter((r) => r !== "comment");
    if (reasons.includes("sent_back")) reasons = reasons.filter((r) => r !== "comment" && r !== "start");
    if (reasons.includes("assigned")) reasons = reasons.filter((r) => r !== "start" && r !== "ready");
    if (reasons.includes("cancelled")) reasons = ["cancelled"];
    if (!reasons.length) return null;
    const keep = <T>(o: Partial<Record<WakeReason, T>>) => Object.fromEntries(Object.entries(o).filter(([r]) => reasons.includes(r as WakeReason))) as Partial<Record<WakeReason, T>>;
    return { ...wake, title: card.title, reasons, texts: keep(wake.texts), by: keep(wake.by) };
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
    try {
      let wakes: Wake[] = [];
      const result = this.db.transaction(() => {
        const r = fn();
        if (this.pending.length || this.projectsChanged) this.db.prepare("UPDATE task_counters SET next = next + 1 WHERE prefix = 'R'").run();
        wakes = this.settleWakes(this.pending);
        return r;
      }).immediate();
      this.lastNotes = this.notes.map((n) => n.text);
      const touched = this.pending;
      const projects = this.projectsChanged;
      if (touched.length || projects) {
        const change: BoardChange = { rev: this.revision(), ids: [...new Set(touched.map((e) => e.code))], actors: [...new Set(touched.map((e) => e.actor.name))], projects, wakes };
        for (const listener of this.listeners) {
          try { listener(change); } catch { /* a listener must not break a write that already committed */ }
        }
      }
      return result;
    } finally {
      this.pending = [];
      this.projectsChanged = false;
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
    card.assignee = assignee;
    card.seenEntryId = 0;
    this.event(actor, card, "assigned", { from, to: assignee });
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

  private entry(card: Card, kind: EntryKind, actor: Actor, text: string): void {
    this.db.prepare("INSERT INTO task_entries (task_id, kind, author, author_kind, text, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(card.uuid, kind, actor.name, actor.kind, text, this.nowIso());
  }

  private event(actor: Actor, card: Card, type: CardEventType, data: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO task_events (at, actor, actor_kind, task_id, type, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.nowIso(), actor.name, actor.kind, card.uuid, type, JSON.stringify(data));
    this.pending.push({ code: card.code, uuid: card.uuid, actor, type, data });
  }

  private insert(card: Card): void {
    this.db.prepare(
      `INSERT INTO tasks (id, code, kind, project_id, parent_id, title, description, status, priority, assignee, dispatcher, dispatcher_kind, created_by, depends_on, result,
        scope, acceptance, context, state, blocked_reason, size, needs_review, version, sort, created_at, updated_at, started_at, submitted_at, done_at, seen_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      card.uuid, card.code, card.kind, card.projectId, card.parent, card.title, card.goal === "" ? null : card.goal, card.status, card.priority,
      card.assignee, card.dispatcher?.name ?? null, card.dispatcher?.kind ?? null, card.createdBy, card.deps.length ? JSON.stringify(card.deps) : null, card.result === "" ? null : card.result,
      card.scope, JSON.stringify(card.acceptance), card.context, card.state, card.blockedReason, card.size, card.needsReview ? 1 : 0,
      card.version, card.sort, card.createdAt, card.updatedAt, card.startedAt, card.submittedAt, card.doneAt, card.seenEntryId,
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
