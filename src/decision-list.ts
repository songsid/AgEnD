/**
 * #2152: what `list_decisions` answers. The fleet's decisions are long (82 of them were 126 KB, ≈31k–42k tokens in one
 * call) and every instance lists them after a restart, so by default it answers titles — id, title, scope, date, tags —
 * and full text is asked for with `detail:true` (one id or all records). One function for both entry
 * paths (the MCP tool through the daemon, and the agent endpoint's `decision-*` ops).
 */
import { listOptions, pageRows, type ListOptions } from "./agent-list-output.js";
import type { Decision } from "./scheduler/types.js";

export interface DecisionTitle {
  id: string;
  title: string;
  scope: Decision["scope"];
  /** A team decision's team. */
  team?: string;
  /** The day it was last changed (YYYY-MM-DD). */
  date: string;
  tags?: string[];
  status?: Decision["status"];
}

export const DECISION_TITLES_HINT = "Titles only. Follow next_cursor with the same filters for all pages. Use { id, detail: true } for the full rule; detail: true lists all full records (legacy full: true also works).";

/** One decision by id (exact, or a unique prefix of at least 6 characters); null when none or more than one match. */
function byId(all: readonly Decision[], id: string): Decision | null {
  const exact = all.find(d => d.id === id);
  if (exact) return exact;
  if (id.length < 6) return null;
  const hits = all.filter(d => d.id.startsWith(id));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * The answer: compact `{ decision }` for an id, full records for detail/full, else paged titles. `all` is the list as the store
 * returns it (already filtered by scope, archive and tags).
 */
export function decisionListAnswer(all: readonly Decision[], opts: ListOptions & { id?: unknown; full?: unknown } = {}): unknown {
  listOptions(opts);
  if (typeof opts.id === "string" && opts.id.trim()) {
    if (opts.limit !== undefined || opts.cursor !== undefined) throw new Error("A single decision does not take limit or cursor");
    const d = byId(all, opts.id.trim());
    return d ? { decision: opts.detail === true || opts.full === true ? d : title(d) } : { error: `No decision '${opts.id.trim()}' among these (an id, or a unique prefix of 6 or more characters).` };
  }
  if (opts.full === true || opts.detail === true) return all;
  const { rows, ...more } = pageRows(all, opts);
  return { decisions: rows.map(title), ...more, hint: DECISION_TITLES_HINT };
}
function title(d: Decision): DecisionTitle {
  return {
    id: d.id, title: d.title, scope: d.scope, ...(d.team ? { team: d.team } : {}),
    date: (d.updated_at || d.created_at || "").slice(0, 10),
    ...(d.tags?.length ? { tags: d.tags } : {}),
    ...(d.status && d.status !== "active" ? { status: d.status } : {}),
  };
}
