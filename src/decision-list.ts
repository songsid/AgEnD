/**
 * #2152: what `list_decisions` answers. The fleet's decisions are long (82 of them were 126 KB, ≈31k–42k tokens in one
 * call) and every instance lists them after a restart, so by default it answers titles — id, title, scope, date, tags —
 * and the full text is asked for: one decision by `id`, or all of them with `full: true`. One function for both entry
 * paths (the MCP tool through the daemon, and the agent endpoint's `decision-*` ops).
 */
import type { Decision } from "./scheduler/types.js";

export interface DecisionTitle {
  id: string;
  title: string;
  scope: Decision["scope"];
  /** The day it was last changed (YYYY-MM-DD). */
  date: string;
  tags?: string[];
  status?: Decision["status"];
}

export const DECISION_TITLES_HINT = "Titles only. Call list_decisions with { id } for one decision's full text, or { full: true } for every one.";

/** One decision by id (exact, or a unique prefix of at least 6 characters); null when none or more than one match. */
function byId(all: readonly Decision[], id: string): Decision | null {
  const exact = all.find(d => d.id === id);
  if (exact) return exact;
  if (id.length < 6) return null;
  const hits = all.filter(d => d.id.startsWith(id));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * The answer: `{ decision }` for an id, the full records for `full`, else the titles. `all` is the list as the store
 * returns it (already filtered by scope, archive and tags).
 */
export function decisionListAnswer(all: readonly Decision[], opts: { id?: unknown; full?: unknown } = {}): unknown {
  if (typeof opts.id === "string" && opts.id.trim()) {
    const d = byId(all, opts.id.trim());
    return d ? { decision: d } : { error: `No decision '${opts.id.trim()}' among these (an id, or a unique prefix of 6 or more characters).` };
  }
  if (opts.full === true) return all;
  const titles: DecisionTitle[] = all.map(d => ({
    id: d.id, title: d.title, scope: d.scope, date: (d.updated_at || d.created_at || "").slice(0, 10),
    ...(d.tags?.length ? { tags: d.tags } : {}),
    ...(d.status && d.status !== "active" ? { status: d.status } : {}),
  }));
  return { decisions: titles, hint: DECISION_TITLES_HINT };
}
