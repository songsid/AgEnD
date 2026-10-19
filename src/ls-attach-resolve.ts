/**
 * Pure resolution logic for `agend attach` — no I/O, no process.exit.
 * Exported so tests can cover CJK display names, row numbers, ambiguity,
 * and fuzzy suggestions without spawning a process.
 */

export interface Candidate {
  /** 1-based row number as shown in `agend ls`. */
  idx: number;
  realName: string;
  /** The display label `agend ls` shows (display_name or shortened real name). */
  displayLabel: string;
  teams: string[];
  status: "running" | "paused" | "stopped" | "crashed";
}

export type ResolveResult =
  | { kind: "exact"; candidate: Candidate }
  | { kind: "ambiguous"; candidates: Candidate[]; reason: string }
  | { kind: "none"; suggestions: Candidate[] };

/**
 * Resolve a query string against an ordered candidate list.
 *
 * Resolution order:
 *  1. Integer string → 1-based row number from `agend ls`.
 *  2. Exact real name (case-insensitive).
 *  3. Exact display label (case-insensitive).
 *  4. Unique substring of display label (case-insensitive).
 *  5. Unique prefix of real name (case-insensitive).
 *  6. Unique substring of real name (case-insensitive).
 *  7. Ambiguous → returns `{ kind: "ambiguous", candidates }`.
 *  8. No match → returns `{ kind: "none", suggestions: top-5 fuzzy }`.
 */
export function resolveCandidate(query: string, candidates: Candidate[]): ResolveResult {
  const q = query.trim().toLowerCase();

  // 1. Row number
  if (/^\d+$/.test(q)) {
    const idx = parseInt(q, 10);
    const found = candidates.find(c => c.idx === idx);
    if (found) return { kind: "exact", candidate: found };
    return { kind: "none", suggestions: fuzzyTopN(q, candidates) };
  }

  // 2. Exact real name
  const exactReal = candidates.find(c => c.realName.toLowerCase() === q);
  if (exactReal) return { kind: "exact", candidate: exactReal };

  // 3. Exact display label
  const exactDisp = candidates.filter(c => c.displayLabel.toLowerCase() === q);
  if (exactDisp.length === 1) return { kind: "exact", candidate: exactDisp[0]! };
  if (exactDisp.length > 1) return { kind: "ambiguous", candidates: exactDisp, reason: "exact display name match" };

  // 4. Unique substring of display label
  const subDisp = candidates.filter(c => c.displayLabel.toLowerCase().includes(q));
  if (subDisp.length === 1) return { kind: "exact", candidate: subDisp[0]! };
  if (subDisp.length > 1) return { kind: "ambiguous", candidates: subDisp, reason: `display name contains "${query}"` };

  // 5. Unique prefix of real name
  const prefixReal = candidates.filter(c => c.realName.toLowerCase().startsWith(q));
  if (prefixReal.length === 1) return { kind: "exact", candidate: prefixReal[0]! };
  if (prefixReal.length > 1) return { kind: "ambiguous", candidates: prefixReal, reason: `name starts with "${query}"` };

  // 6. Unique substring of real name
  const subReal = candidates.filter(c => c.realName.toLowerCase().includes(q));
  if (subReal.length === 1) return { kind: "exact", candidate: subReal[0]! };
  if (subReal.length > 1) return { kind: "ambiguous", candidates: subReal, reason: `name contains "${query}"` };

  // 7. No match — fuzzy suggestions
  return { kind: "none", suggestions: fuzzyTopN(q, candidates) };
}

/** Top-N candidates by longest common subsequence score. */
function fuzzyTopN(q: string, candidates: Candidate[], n = 5): Candidate[] {
  const scored = candidates.map(c => ({
    c,
    score: Math.max(
      lcsLength(q, c.realName.toLowerCase()),
      lcsLength(q, c.displayLabel.toLowerCase()),
    ),
  }));
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(s => s.c);
}

/** Greedy longest common subsequence length. */
function lcsLength(a: string, b: string): number {
  let ai = 0, bi = 0, count = 0;
  while (ai < a.length && bi < b.length) {
    if (a[ai] === b[bi]) { count++; ai++; bi++; }
    else bi++;
  }
  return count;
}
