/**
 * #1691: the shape of a prompt a CLI is waiting on, read from a pane — for prompts no backend table knows (a new CLI
 * version's dialog, #1690's "Switch model?"). Pure: the daemon decides when a shape counts (no known dialog, no idle
 * composer, unchanged for a minute) and never answers it.
 *
 * A shape is bottom-anchored: the prompt is the last thing on screen apart from a short footer, so an agent's reply
 * that merely contains a numbered list (or "[y/n]") above the CLI's own prompt rows is not one.
 */

export interface PromptShape {
  /** "numbered": a cursor glyph on a numbered option, with a neighbouring option; "yes-no": a [y/n]-style question. */
  kind: "numbered" | "yes-no";
  /** Numbered options seen (0 for yes-no). */
  options: number;
  /** The prompt's question/title line, sanitised and bounded (see questionLine); null when there is none. */
  question: string | null;
  /** The prompt's rows, from the question to the last option — its identity (the same block is the same prompt). */
  block: string;
}

/** Rows looked at, counted from the bottom (non-empty rows only). */
const BOTTOM_ROWS = 20;
/** Rows a prompt may have below its last option or question (a hint footer: "Enter to confirm · Esc to cancel"). */
const FOOTER_ROWS = 3;
/** How far above the first option the question is looked for. */
const QUESTION_ROWS = 8;
export const QUESTION_MAX = 80;

const CURSOR_OPTION = /^[ \t]*[❯›>][ \t]*(\d{1,2})[.)][ \t]+\S/;
const OPTION = /^[ \t]*(?:[❯›>][ \t]*)?(\d{1,2})[.)][ \t]+\S/;
const YES_NO = /[[(][ \t]*[yY][ \t]*\/[ \t]*[nN][ \t]*[\])][ \t]*[:?]?[ \t]*$/;
/** A rule or border row (box drawing, block elements, dashes): the top of a dialog. */
const RULE = /^[ \t]*[─━═╌┄▔▁_\-=]{8,}[ \t]*$/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** One short line for a notice: escapes and control characters out, whitespace collapsed, at most QUESTION_MAX. */
export function questionLine(raw: string): string {
  const text = raw.replace(ANSI, "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > QUESTION_MAX ? `${text.slice(0, QUESTION_MAX - 1)}…` : text;
}

/** The prompt the pane is showing at its bottom, or null. */
export function unrecognisedPromptShape(pane: string): PromptShape | null {
  const rows = pane.replace(ANSI, "").replace(/\r/g, "").split("\n").map(r => r.trimEnd());
  const filled: number[] = [];
  for (let i = rows.length - 1; i >= 0 && filled.length < BOTTOM_ROWS; i--) if (rows[i]!.trim() !== "") filled.unshift(i);
  if (filled.length === 0) return null;
  const after = (row: number) => filled.filter(i => i > row).length;

  // A cursor on a numbered option, with its neighbours: the contiguous run of option rows around it.
  for (let k = filled.length - 1; k >= 0; k--) {
    const at = filled[k]!;
    const cursor = CURSOR_OPTION.exec(rows[at]!);
    if (!cursor) continue;
    let first = at, last = at;
    while (first - 1 >= 0 && OPTION.test(rows[first - 1]!)) first--;
    while (last + 1 < rows.length && OPTION.test(rows[last + 1]!)) last++;
    const numbers = rows.slice(first, last + 1).map(r => Number(OPTION.exec(r)![1]));
    const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1);
    if (numbers.length < 2 || !consecutive || after(last) > FOOTER_ROWS) return null;
    // The question: the top of the dialog — the first row under a rule/border, else the topmost filled row — within
    // QUESTION_ROWS above the options.
    let top = -1;
    for (let i = first - 1; i >= 0 && first - i <= QUESTION_ROWS; i--) {
      if (RULE.test(rows[i]!)) break;
      if (rows[i]!.trim() !== "") top = i;
    }
    const question = top >= 0 ? questionLine(rows[top]!) : null;
    const block = rows.slice(top >= 0 ? top : first, last + 1).join("\n");
    return { kind: "numbered", options: numbers.length, question: question || null, block };
  }

  // A [y/n] question at the bottom.
  for (let k = filled.length - 1; k >= 0 && filled.length - 1 - k <= FOOTER_ROWS; k--) {
    const at = filled[k]!;
    if (!YES_NO.test(rows[at]!)) continue;
    return { kind: "yes-no", options: 0, question: questionLine(rows[at]!) || null, block: rows[at]!.trim() };
  }
  return null;
}
