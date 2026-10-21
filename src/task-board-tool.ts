/**
 * The `task` tool's board actions (step 2, docs/design/task-board.md), for both of the tool's doors — the MCP tool
 * over IPC (FleetManager.handleTaskCrud) and `agend-agent task` over HTTP (handleTaskCrudHttp):
 *
 * - `mine` — the caller's work; `projects` — the board's projects;
 * - `move` — a card to another status, with the reason, result or comment the move needs;
 * - `create` or `update` naming a board field (a project, a parent, a checklist, state, a log line, a comment…);
 * - `get` of a card on the board — the card as text, with the comments new to its assignee.
 *
 * Everything else is the tool's own and is answered as before (undefined here). The caller is the instance the tool
 * belongs to; the board's rules (scheduler/task-board.ts) decide what it may do. Answers are plain text.
 */
import type { SchedulerDb } from "./scheduler/db.js";
import { CARD_PRIORITIES, CARD_SIZES, CARD_STATUSES, TaskBoardError, type Actor, type CardPatch, type CardPriority, type CardSize, type CardStatus, type NewCard } from "./scheduler/task-board.js";
import { cardLine, cardText, myWorkText, projectsText, writeText } from "./scheduler/task-board-text.js";

/** A `create` naming one of these opens a board card; without them it is the tool's plain task. */
const BOARD_CREATE = ["project", "parent", "scope", "acceptance", "context", "needs_review", "size"] as const;
/** An `update` naming one of these edits the card on the board's terms; without them it is the tool's plain update. */
const BOARD_UPDATE = ["title", "description", "scope", "context", "state", "acceptance", "check", "uncheck", "log", "comment", "needs_review", "size", "depends_on", "version"] as const;
/** Words agents bring from other boards. */
const STATUS_ALIAS: Record<string, CardStatus> = { todo: "open", "to do": "open", doing: "claimed", in_progress: "claimed", "in progress": "claimed", waiting: "review" };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
const nums = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const has = (args: Record<string, unknown>, keys: readonly string[]) => keys.some((k) => args[k] !== undefined && args[k] !== null);

function status(v: unknown, param = "to"): CardStatus {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  const known = (CARD_STATUSES as readonly string[]).includes(s) ? (s as CardStatus) : STATUS_ALIAS[s];
  if (!known) throw new TaskBoardError("invalid", `"${param}" is one of ${CARD_STATUSES.join(", ")}`);
  return known;
}
const priority = (v: unknown): CardPriority | undefined => ((CARD_PRIORITIES as readonly unknown[]).includes(v) ? (v as CardPriority) : undefined);
const size = (v: unknown): CardSize | null | undefined => (v === null || v === "" ? null : (CARD_SIZES as readonly unknown[]).includes(v) ? (v as CardSize) : undefined);
function need(v: unknown, what: string): string {
  const s = str(v)?.trim();
  if (!s) throw new TaskBoardError("invalid", `${what} is required`);
  return s;
}

export function boardToolAction(db: SchedulerDb, instance: string, args: Record<string, unknown>): string | undefined {
  const board = db.board;
  const actor: Actor = { kind: "instance", name: instance };
  switch (args.action) {
    case "mine":
      return myWorkText(board, instance, board.myWork(instance));
    case "projects":
      return projectsText(board.listProjects(true), board.projectStats());
    case "move": {
      const id = need(args.id, "id");
      let to = status(args.to ?? args.status);
      // As the tool's `done`: finishing a card that waits for the person's confirmation hands it to them (review).
      if (to === "done") { const held = board.findCard(id); if (held?.needsReview && held.status !== "review") to = "review"; }
      const { card, from, notes } = board.moveCard(actor, id, to, {
        reason: str(args.reason), result: str(args.result), comment: str(args.comment), version: int(args.version),
      });
      return writeText(card, notes, from);
    }
    case "create": {
      if (!has(args, BOARD_CREATE)) return undefined;
      const spec: NewCard = {
        title: need(args.title, "title"),
        goal: str(args.description),
        scope: str(args.scope),
        context: str(args.context),
        acceptance: strs(args.acceptance),
        priority: priority(args.priority),
        size: size(args.size) ?? undefined,
        dependsOn: strs(args.depends_on),
        needsReview: bool(args.needs_review),
        ...(str(args.parent) ? { parent: str(args.parent) } : { project: str(args.project) ?? (typeof args.project === "number" ? args.project : undefined) }),
        ...(args.assignee !== undefined ? { assignee: str(args.assignee) ?? null } : {}),
      };
      const { cards, notes } = board.createCards(actor, { cards: [spec] });
      return writeText(cards[0]!, notes);
    }
    case "update": {
      if (!has(args, BOARD_UPDATE)) return undefined;
      const patch: CardPatch = {
        version: int(args.version),
        title: str(args.title),
        goal: str(args.description),
        scope: str(args.scope),
        context: str(args.context),
        state: str(args.state),
        result: str(args.result),
        acceptance: strs(args.acceptance),
        check: nums(args.check),
        uncheck: nums(args.uncheck),
        log: str(args.log),
        comment: str(args.comment),
        needsReview: bool(args.needs_review),
        size: size(args.size),
        priority: priority(args.priority),
        dependsOn: strs(args.depends_on),
        ...(args.assignee !== undefined ? { assignee: str(args.assignee) ?? null } : {}),
      };
      if (args.status === undefined) {
        const { card, notes } = board.updateCard(actor, need(args.id, "id"), patch);
        return writeText(card, notes);
      }
      // A status given with the fields: the fields, then the move as the tool's plain update makes it (the board's
      // rules, the gate) — one write, so a refused move keeps the fields unchanged too.
      const to = status(args.status, "status");
      const { card, from } = board.atomically(() => {
        const { card: edited } = board.updateCard(actor, need(args.id, "id"), patch);
        if (to !== edited.status) db.updateTask(edited.uuid, { status: to }, actor);
        return { card: board.getCard(edited.uuid), from: edited.status };
      });
      return writeText(card, board.takeNotes(), from);
    }
    case "list": {
      if (!has(args, ["project", "parent"])) return undefined;
      const filterStatus = args.filter_status === undefined ? undefined : (Array.isArray(args.filter_status) ? args.filter_status : [args.filter_status]).map((v) => status(v, "filter_status"));
      const project = args.project === "" || args.project === "none" ? null : (str(args.project) ?? (typeof args.project === "number" ? args.project : undefined));
      const { cards, total } = board.listCards({ project, parent: str(args.parent), assignee: str(args.filter_assignee) || undefined, status: filterStatus });
      if (!cards.length) return "No cards match.";
      return [...cards.map((c) => cardLine(c)), ...(total > cards.length ? [`… ${total - cards.length} more: narrow with filter_status or filter_assignee`] : [])].join("\n");
    }
    case "get": {
      const card = board.findCard(need(args.id, "id"));
      return card && board.isOnBoard(card) ? cardText(board, card) : undefined;
    }
    default:
      return undefined;
  }
}

/** The activity log's line for a board action that changed work (as `created task:` / `claimed:` / `completed:` for plain tasks). */
export function boardActivity(args: Record<string, unknown>): string | null {
  const id = typeof args.id === "string" ? args.id : "";
  if (args.action === "create" && has(args, BOARD_CREATE) && typeof args.title === "string") return `created task: ${args.title}`;
  if (args.action !== "move") return null;
  const to = typeof args.to === "string" ? args.to : typeof args.status === "string" ? args.status : "";
  return { claimed: `claimed: ${id}`, done: `completed: ${id}`, review: `submitted for review: ${id}`, blocked: `blocked: ${id}`, cancelled: `cancelled: ${id}`, open: `put back: ${id}` }[STATUS_ALIAS[to] ?? to] ?? null;
}
