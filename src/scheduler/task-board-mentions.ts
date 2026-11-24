/**
 * Reading `@<instance name>` out of a task board comment (docs/design/task-board.md, "Comments and mentions"). Pure
 * text in, names out — the board decides whom a mention wakes. The dashboard's comment box only inserts this plain
 * text, so any writer (a person, an agent through the `task` tool, a script) uses the same format.
 *
 * What counts as a mention of an instance named `lead`:
 * - `@lead` where the `@` starts the text or follows anything but a letter, digit, `_`, `-`, `.`, `@`, `/` or `\`
 *   (so `me@lead`, `a/@lead` and `@@lead` are not); a space, a bracket, a quote, `,` `:` `;` `!` `?` and CJK text in
 *   front are all fine ("(@lead)", "請@lead看一下").
 * - after the name comes the end of the text, or anything that cannot continue a name: a letter, digit, `_` or `-`
 *   continues it (`@lead-2` is not `lead`; it is `lead-2` if that is an instance), and so does `.` when a name
 *   character follows it (`@lead.v2`), while a sentence's closing `.` does not (`@lead.` is `lead`). CJK text after
 *   the name ends it: "@lead請看" is `lead`.
 * - case does not matter: `@Lead` is `lead`. When two instances differ only by case, the exact case wins; a mention
 *   that fits several of them equally well names none (it cannot be told which was meant).
 * - the longest name wins: with `dev` and `dev-a` both instances, `@dev-a` is `dev-a`.
 * - not inside code: text between backticks (inline, or a fenced block) is never scanned, so `@lead` in code quotes
 *   a name without waking it.
 * - one name once, however many times a comment says it. A comment's own writer is left for the caller to drop.
 */

/** What a comment's `@` marks name. `unknown` are well-formed `@word`s that are no instance (for a hint, never a wake). */
export interface Mentions {
  /** The instances named, as the board's own names for them, in the order they first appear. */
  names: string[];
  /** `@word`s that name no instance, as written (without the `@`), at most {@link MAX_UNKNOWN}. */
  unknown: string[];
}

export const MAX_UNKNOWN = 3;
/** How much of an unknown `@word` is kept for the hint. */
const MAX_UNKNOWN_WORD = 64;

/** Characters that run a name on (ASCII only: CJK text beside a mention ends it). */
const NAME_CHAR = /[A-Za-z0-9_-]/;
/** Characters before an `@` that make it part of something else: an address, a path, a handle of another service. */
const NOT_BEFORE = /[A-Za-z0-9_.@/\\-]/;

/** The text with fenced blocks and inline code replaced by spaces, so a name in code is never read. */
export function withoutCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

/** Whether a name ends at `at` in `text` (the character there, if any, does not carry it on). */
function endsAt(text: string, at: number): boolean {
  const c = text[at];
  if (c === undefined) return true;
  if (NAME_CHAR.test(c)) return false;
  if (c === "." && at + 1 < text.length && NAME_CHAR.test(text[at + 1]!)) return false;
  return true;
}

/** The well-formed word after an `@` that is no instance (`lead`, `dev-a`, `v1.2`): the same character rules as a name. */
function wordAt(text: string, at: number): string {
  let end = at;
  while (end < text.length) {
    const c = text[end]!;
    if (NAME_CHAR.test(c) || (c === "." && end + 1 < text.length && NAME_CHAR.test(text[end + 1]!))) end++;
    else break;
  }
  return text.slice(at, end);
}

/** The instances `text` mentions, among `instances` (the fleet's instance names), and the `@word`s that are none. */
export function parseMentions(text: string, instances: Iterable<string>): Mentions {
  const known = [...new Set(instances)].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  const lengths = [...new Set(known.map((n) => n.length))];     // longest first
  // Only as far after an `@` as a name (and one or two characters past it) or a hinted word can reach: a comment of
  // thousands of `@` costs no more per `@` than a short one.
  const reach = Math.max(lengths[0] ?? 0, MAX_UNKNOWN_WORD) + 2;
  const out: Mentions = { names: [], unknown: [] };
  if (!known.length && !text.includes("@")) return out;
  const scan = withoutCode(text);
  for (let i = scan.indexOf("@"); i >= 0; i = scan.indexOf("@", i + 1)) {
    if (i > 0 && NOT_BEFORE.test(scan[i - 1]!)) continue;
    const rest = scan.slice(i + 1, i + 1 + reach);
    const lower = rest.toLowerCase();
    // The longest names first: the first length that fits decides; several equally long ones fit only by case.
    let chosen: string | null | undefined;
    for (const len of lengths) {
      const fits = known.filter((n) => n.length === len && lower.startsWith(n.toLowerCase()) && endsAt(rest, n.length));
      if (!fits.length) continue;
      const exact = fits.filter((n) => rest.startsWith(n));
      chosen = exact.length === 1 ? exact[0] : fits.length === 1 ? fits[0] : null;
      break;
    }
    if (chosen) { if (!out.names.includes(chosen)) out.names.push(chosen); continue; }
    if (chosen === null) continue;        // ambiguous by case: names none, and is no "unknown" word either
    const word = wordAt(rest, 0).slice(0, MAX_UNKNOWN_WORD);
    if (word && !out.unknown.includes(word) && out.unknown.length < MAX_UNKNOWN) out.unknown.push(word);
  }
  return out;
}
