/**
 * Claude history in the View (the user, hmsg-a8947a2c / hmsg-b4c7ccdf; leader cid-claude-history-build). Claude Code
 * draws on the alternate screen, so tmux keeps nothing above it: the View shows the conversation's earlier part from the
 * instance's own transcript instead, drawn like Claude's own Ctrl+O view above the live screen (view-history.js).
 *
 * Read with the Log's reader (LogService.readBack: ClaudeStepParser, masked and cut) — the instance's own transcript,
 * only when the person scrolls up in its View, a page at a time:
 * - `GET /api/pane/<name>?transcript=1` — the newest VIEW_HISTORY_PAGE steps; `&before=<n>&key=<k>` — the page before
 *   that offset of that transcript;
 * - `?transcript=1&step=<id>&end=<n>&key=<k>` — one step whole (a folded one, clicked): the page it came in is read
 *   again (its range ends at `end`; step ids depend on the bytes, not on the range) and the step answered unfolded.
 * Access is the View's own (view-api.ts answers it on the pane's route, behind the pane's gate). Claude only: any other
 * backend answers `supported: false` (Codex keeps tmux's scrollback). Thinking never shows (the parser has none); a
 * turn's end and the fleet's state lines are left out.
 *
 * Folding happens here, so a page stays small: a long tool result or error keeps its first lines and says how many
 * more there are; an edit's diff its first rows. Prompts and replies come whole (the parser already bounds them).
 */
import type { LogStep } from "./log-steps.js";
import type { ReadBack } from "./log-service.js";

export const VIEW_HISTORY_PAGE = 100;
/** A result over `lines` lines keeps `keep`; a diff over `diffRows` rows keeps `diffKeep`; kept text at most `chars`. */
export const VIEW_FOLD = { lines: 5, keep: 3, diffRows: 10, diffKeep: 6, chars: 600 } as const;

export interface ViewStep {
  id: string;
  kind: "user" | "assistant" | "tool" | "error";
  /** tool: the CLI's tool name (the page shows Claude's word for it). */
  tool?: string;
  /** tool: what it acts on (a path, a command, a pattern). */
  subject?: string;
  status?: "running" | "done" | "failed" | "interrupted";
  body?: string;
  /** An edit's change as removed / added lines, hunk by hunk (instead of its result's sentence). */
  diff?: Array<{ del: string[]; add: string[] }>;
  /** Folded: how many more lines (or diff rows) the whole step has. */
  more?: number;
  /** Characters the transcript reader itself cut (they are not in the whole step either). */
  cut?: number;
}

export type ViewHistoryAnswer =
  | { view_history: 1; supported: false; reason: string }
  | { view_history: 1; supported: true; key: string; steps: ViewStep[]; before: number | null; end: number; reset?: boolean }
  | { view_history: 1; supported: true; key: string; step: ViewStep | null };

export interface ViewHistoryQuery { before?: number; key?: string; step?: string; end?: number }

/** Reads an instance's steps backwards (LogService.readBack). */
export type ReadBackFn = (name: string, q: { end?: number; key?: string; limit: number }) => Promise<ReadBack | null>;

/** The query's own parts from a URL's search params (anything malformed is left out: the newest page). */
export function viewHistoryQuery(params: URLSearchParams): ViewHistoryQuery {
  const offset = (v: string | null) => (v !== null && /^\d{1,15}$/.test(v) ? Number(v) : undefined);
  const q: ViewHistoryQuery = {};
  const before = offset(params.get("before")), end = offset(params.get("end"));
  const key = params.get("key"), step = params.get("step");
  if (before !== undefined) q.before = before;
  if (end !== undefined) q.end = end;
  if (key && /^\d{1,20}-\d{1,20}$/.test(key)) q.key = key;
  if (step && step.length <= 200 && /^[\w.:-]+$/.test(step)) q.step = step;
  return q;
}

/** Null: no such instance. */
export async function viewHistory(read: ReadBackFn, name: string, q: ViewHistoryQuery): Promise<ViewHistoryAnswer | null> {
  if (q.step !== undefined) {
    if (q.end === undefined) return { view_history: 1, supported: false, reason: "bad_request" };
    const back = await read(name, { end: q.end, ...(q.key !== undefined ? { key: q.key } : {}), limit: VIEW_HISTORY_PAGE });
    if (!back) return null;
    if (back.format !== "claude" || back.steps === undefined) return { view_history: 1, supported: false, reason: back.reason ?? "unsupported" };
    // Another transcript now (a new session), or past its end: the step is not there to give whole.
    if (back.reset) return { view_history: 1, supported: true, key: back.key, step: null };
    const found = back.steps.find((s) => s.id === q.step);
    return { view_history: 1, supported: true, key: back.key, step: found ? viewStep(found, false) : null };
  }
  const back = await read(name, { ...(q.before !== undefined ? { end: q.before } : {}), ...(q.key !== undefined ? { key: q.key } : {}), limit: VIEW_HISTORY_PAGE });
  if (!back) return null;
  if (back.format !== "claude" || back.steps === undefined) return { view_history: 1, supported: false, reason: back.reason ?? "unsupported" };
  const steps = back.steps.map((s) => viewStep(s, true)).filter((s): s is ViewStep => s !== null);
  return { view_history: 1, supported: true, key: back.key, steps, before: back.before, end: back.end, ...(back.reset ? { reset: true } : {}) };
}

/** A Log step as the View draws it (null: not drawn); `fold`: long results and diffs keep their start. */
export function viewStep(s: LogStep, fold: boolean): ViewStep | null {
  if (s.kind === "user" || s.kind === "assistant") {
    if (!s.body) return null;
    return { id: s.id, kind: s.kind, body: s.body, ...(s.bodyCut ? { cut: s.bodyCut } : {}) };
  }
  if (s.kind === "error") return { id: s.id, kind: "error", ...folded(s.body ?? s.note ?? "", fold), ...(s.bodyCut ? { cut: s.bodyCut } : {}) };
  if (s.kind !== "tool") return null;
  const step: ViewStep = { id: s.id, kind: "tool", tool: s.tool ?? "", ...(s.subject ? { subject: s.subject } : {}), ...(s.status ? { status: s.status } : {}) };
  const diff = s.status !== "failed" ? diffOf(s.tool ?? "", s.input) : null;
  if (diff) {
    const rows = diff.reduce((n, h) => n + h.del.length + h.add.length, 0);
    if (!fold || rows <= VIEW_FOLD.diffRows) return { ...step, diff };
    let left: number = VIEW_FOLD.diffKeep;
    const kept: Array<{ del: string[]; add: string[] }> = [];
    for (const h of diff) {
      if (left <= 0) break;
      const del = h.del.slice(0, left); left -= del.length;
      const add = h.add.slice(0, Math.max(0, left)); left -= add.length;
      kept.push({ del, add });
    }
    return { ...step, diff: kept, more: rows - VIEW_FOLD.diffKeep };
  }
  const body = clean(s.body ?? "");
  return { ...step, ...(body ? folded(body, fold) : {}), ...(s.bodyCut ? { cut: s.bodyCut } : {}) };
}

/** A tool's error comes wrapped (`<tool_use_error>…</tool_use_error>`): the page shows its words. */
function clean(text: string): string { return text.replace(/^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/, "$1").replace(/\n+$/, ""); }

function folded(text: string, fold: boolean): { body: string; more?: number } {
  const lines = text.split("\n");
  if (!fold) return { body: text };
  let keep = lines.length > VIEW_FOLD.lines ? lines.slice(0, VIEW_FOLD.keep) : lines;
  let more = lines.length - keep.length;
  let body = keep.join("\n");
  if (body.length > VIEW_FOLD.chars) {
    body = body.slice(0, VIEW_FOLD.chars);
    keep = body.split("\n");
    more = Math.max(1, lines.length - keep.length + 1);
  }
  return { body, ...(more > 0 ? { more } : {}) };
}

/** An edit's change from its arguments (Edit, MultiEdit, Write), or null — also when the arguments were cut. */
function diffOf(tool: string, input: string | undefined): Array<{ del: string[]; add: string[] }> | null {
  if (!input || !["Edit", "MultiEdit", "Write"].includes(tool)) return null;
  let args: Record<string, unknown>;
  try { args = JSON.parse(input) as Record<string, unknown>; } catch { return null; }
  const lines = (v: unknown) => (typeof v === "string" && v !== "" ? v.replace(/\n$/, "").split("\n") : []);
  if (tool === "Write") return typeof args.content === "string" ? [{ del: [], add: lines(args.content) }] : null;
  const edits = tool === "MultiEdit" ? (Array.isArray(args.edits) ? args.edits : null) : [args];
  if (!edits) return null;
  const hunks = edits
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({ del: lines(e.old_string), add: lines(e.new_string) }))
    .filter((h) => h.del.length || h.add.length);
  return hunks.length ? hunks : null;
}
