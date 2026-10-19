/**
 * Pure resolution logic for `agend attach` — no I/O, no process.exit.
 * Exported so tests can cover CJK display names, row numbers, ambiguity,
 * and fuzzy suggestions without spawning a process.
 */

export interface Candidate {
  /** 1-based global row number as shown in `agend ls` — stable across filters. */
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
 *  0. `#N` prefix → unambiguous row token: always means row N, bypasses
 *     exact-name lookup. Use this form in the picker to avoid collision
 *     between digit-string real names and row numbers.
 *  1. Exact real name (case-insensitive) — wins over bare integer strings,
 *     so a numeric instance name like "2" resolves by name before row 2.
 *  2. Bare integer string → 1-based global row number (no `#` prefix,
 *     and only when no exact real name matched).
 *  3. Exact display label (case-insensitive).
 *  4. Unique substring of display label (case-insensitive).
 *  5. Unique prefix of real name (case-insensitive).
 *  6. Unique substring of real name (case-insensitive).
 *  7. Ambiguous → returns `{ kind: "ambiguous", candidates }`.
 *  8. No match → returns `{ kind: "none", suggestions: top-5 fuzzy }`.
 */
export function resolveCandidate(query: string, candidates: Candidate[]): ResolveResult {
  const q = query.trim().toLowerCase();

  // 0. Unambiguous row token: #N always means row N, regardless of real names.
  if (q.startsWith("#")) {
    const after = q.slice(1);
    if (/^\d+$/.test(after)) {
      const idx = parseInt(after, 10);
      const found = candidates.find(c => c.idx === idx);
      if (found) return { kind: "exact", candidate: found };
      return { kind: "none", suggestions: fuzzyTopN(after, candidates) };
    }
    // #<non-digit> falls through to normal resolution without the # prefix.
  }

  // 1. Exact real name ALWAYS wins — must come before integer check so that
  //    a numeric instance name like "2" is not consumed as a row number.
  const exactReal = candidates.find(c => c.realName.toLowerCase() === q);
  if (exactReal) return { kind: "exact", candidate: exactReal };

  // 2. Row number — only when query is all digits AND no exact real name matched.
  if (/^\d+$/.test(q)) {
    const idx = parseInt(q, 10);
    const found = candidates.find(c => c.idx === idx);
    if (found) return { kind: "exact", candidate: found };
    return { kind: "none", suggestions: fuzzyTopN(q, candidates) };
  }

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

/** Top-N candidates by character-bag overlap score.
 * charOverlapScore counts characters shared between the two strings (respecting
 * multiplicity). Unlike a greedy subsequence approach, a single leading-char
 * typo does not drop the score to zero. */
function fuzzyTopN(q: string, candidates: Candidate[], n = 5): Candidate[] {
  const scored = candidates.map(c => ({
    c,
    score: Math.max(
      charOverlapScore(q, c.realName.toLowerCase()),
      charOverlapScore(q, c.displayLabel.toLowerCase()),
    ),
  }));
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(s => s.c);
}

/** Character-bag overlap: number of chars in `a` that also appear in `b`
 * (counting multiplicity). Tolerant of leading-char typos. */
function charOverlapScore(a: string, b: string): number {
  const freq = new Map<string, number>();
  for (const c of b) freq.set(c, (freq.get(c) ?? 0) + 1);
  let score = 0;
  for (const c of a) {
    const n = freq.get(c) ?? 0;
    if (n > 0) { score++; freq.set(c, n - 1); }
  }
  return score;
}

// ── Filter helpers for ls — extracted so tests can cover the filter path ──────

export interface LsRow {
  globalIdx: number;
  realName: string;
  displayLabel: string;
  status: string;
  teams: string[];
  backend: string;
}

/**
 * Apply ls CLI filters to a row array that already carries stable globalIdx
 * values. The global indices are NOT renumbered after filtering, so `attach N`
 * always selects the same instance regardless of which filters ls used.
 */
export function applyLsFilters(
  rows: LsRow[],
  opts: { running?: boolean; team?: string; backend?: string },
): LsRow[] {
  let result = rows;
  if (opts.running) result = result.filter(r => r.status === "running");
  if (opts.team) {
    const t = opts.team.toLowerCase();
    result = result.filter(r => r.teams.some(team => team.toLowerCase() === t));
  }
  if (opts.backend) result = result.filter(r => r.backend === opts.backend);
  return result;
}

/** Return the global idx to use as the picker default (first displayed row). */
export function pickerDefaultIdx(displayedCandidates: Pick<Candidate, "idx">[]): number {
  return displayedCandidates[0]?.idx ?? 1;
}

/**
 * Validate that `--names-only` (shell completion fast path) is not combined
 * with filters. Returns an error string to print, or null if OK.
 * Pure so the CLI dispatch path can be tested without spawning a subprocess.
 */
export function validateNamesOnlyFilters(opts: {
  namesOnly?: boolean;
  running?: boolean;
  team?: string;
  backend?: string;
}): string | null {
  if (!opts.namesOnly) return null;
  const active = (
    [opts.running && "--running", opts.team && "--team", opts.backend && "--backend"] as Array<string | false>
  ).filter(Boolean) as string[];
  if (active.length === 0) return null;
  return `--names-only is for shell completion and cannot be combined with ${active.join(", ")}. Use --json to filter names programmatically.`;
}
