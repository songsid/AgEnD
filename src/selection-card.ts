/**
 * #2910 D4: a CLI's own numbered-choice dialog (Claude Code's Bash or tool permission, its trust / Bypass screens it
 * did not recognise, "Background work is running", "Switch model?"; Codex's selections; any numbered prompt the
 * #1691 catch-all holds), read from the pane as a #2675 question card — so that on a web-only fleet the person answers it
 * from the dashboard: the card's own options as buttons, keyed in by remote-card-answer.ts on a verified cursor.
 *
 * Pure. Bottom-anchored like unrecognised-prompt.ts: the cursor (`❯`/`›`) is on a numbered option in a run of
 * consecutive options at the bottom of the screen (at most a short footer below), so a transcript quoting a dialog is
 * never one. The dialog's own words above the options (up to its top border) are its question — what a person needs to
 * decide (for a Bash permission: the command and its description). Esc is never offered: on some of these dialogs it is
 * not a harmless skip (Claude's trust screen exits the CLI), and the dialog's own options say every choice there is.
 */
import type { RemoteCardOption, RemoteQuestionCard } from "./backend/types.js";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CURSOR_OPTION = /^([ \t]*)[❯›][ \t]*(\d{1,2})[.)][ \t]+(\S.*)$/;
const OPTION = /^([ \t]*)(?:[❯›][ \t]*)?(\d{1,2})[.)][ \t]+(\S.*)$/;
/** The dialog's top border (Claude's `─`/`▔` rule, Codex's box). */
const BORDER = /^[ \t]*[─━═▔▁╭╰┌└]{2}[─━═▔▁╮╯┐┘ \t]{6,}$/;
/** A separator inside the dialog (Claude's dashed rule around a command): skipped, not a boundary. */
const SEPARATOR = /^[ \t]*[╌┄┈\-]{8,}[ \t]*$/;
/** A box's side borders around a row (Codex): stripped. */
const SIDES = /^[ \t]*[│┃][ \t]?(.*?)[ \t]*[│┃]?[ \t]*$/;
/** Rows a dialog may have below its last option (a hint footer: "Esc to cancel · Tab to amend"). */
const FOOTER_ROWS = 3;
/** How far above the first option the dialog's words are read. */
const BODY_ROWS = 14;
/** Rows of the dialog's words kept, and their length. */
export const SELECTION_BODY_LINES = 10;
export const SELECTION_LINE_MAX = 200;
/** An option's text, at most. */
const OPTION_MAX = 160;

function clean(raw: string, max = SELECTION_LINE_MAX): string {
  const text = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A countdown in the dialog's words ("auto-deny in 30s") is not what is asked: it never makes the card another card. */
const COUNTDOWN = /\b\d+\s*(?:s|sec|secs|seconds?)\b/gi;

/**
 * The numbered-choice dialog at the bottom of `pane`, as a question card titled `title` (the CLI's name), or null.
 * `rowWidth` is unused here (no typed answer); the card offers no Esc (`noSkip`) and is posted only on a web-only fleet.
 */
export function selectionCard(pane: string, title: string): RemoteQuestionCard | null {
  const rows = pane.replace(ANSI, "").replace(/\r/g, "").split("\n").map(r => r.trimEnd()).map(r => SIDES.exec(r)?.[1] ?? r);
  let lastFilled = rows.length - 1;
  while (lastFilled >= 0 && rows[lastFilled]!.trim() === "") lastFilled--;
  if (lastFilled < 0) return null;

  // The cursor row: the lowest one, within the bottom of the screen.
  let at = -1;
  for (let i = lastFilled, filled = 0; i >= 0 && filled < 24; i--) {
    if (rows[i]!.trim() === "") continue;
    filled++;
    if (CURSOR_OPTION.test(rows[i]!)) { at = i; break; }
  }
  if (at < 0) return null;

  // The run of options around it: numbered rows, each perhaps continued on deeper-indented rows (a wrapped option).
  const indentOf = (r: string) => (/^[ \t]*/.exec(r)![0].length);
  const optionIndent = indentOf(rows[at]!.replace(/[❯›]/, " "));
  const isOption = (r: string) => OPTION.test(r) && Math.abs(indentOf(r.replace(/[❯›]/, " ")) - optionIndent) <= 2;
  const isContinuation = (r: string) => r.trim() !== "" && !OPTION.test(r) && indentOf(r) > optionIndent;
  let first = at;
  for (let i = at - 1; i >= 0; i--) {
    if (isOption(rows[i]!)) { first = i; continue; }
    if (isContinuation(rows[i]!) && i > 0 && (isOption(rows[i - 1]!) || isContinuation(rows[i - 1]!))) continue;
    break;
  }
  let last = at;
  for (let i = at + 1; i < rows.length; i++) {
    if (isOption(rows[i]!) || (isContinuation(rows[i]!) && last === i - 1)) { last = i; continue; }
    break;
  }
  let below = 0;
  for (let i = last + 1; i <= lastFilled; i++) if (rows[i]!.trim() !== "") below++;
  if (below > FOOTER_ROWS) return null;

  const options: RemoteCardOption[] = [];
  let cursor: number | null = null;
  for (let i = first; i <= last; i++) {
    const m = OPTION.exec(rows[i]!);
    if (m && isOption(rows[i]!)) {
      if (CURSOR_OPTION.test(rows[i]!)) cursor = options.length;
      options.push({ n: Number(m[2]), title: m[3]!, recommended: false, description: null });
    } else if (options.length) {
      options[options.length - 1]!.title += ` ${rows[i]!.trim()}`;
    }
  }
  if (options.length < 2 || cursor === null || !options.every((o, i) => o.n === i + 1)) return null;
  for (const o of options) o.title = clean(o.title, OPTION_MAX);

  // The dialog's words: up from the first option to its top border (Claude), separators skipped; a dialog with no border
  // (Codex) ends at a double blank row — never the transcript above it.
  let border = -1;
  for (let i = first - 1; i >= 0 && first - i <= BODY_ROWS; i--) if (BORDER.test(rows[i]!)) { border = i; break; }
  const body: string[] = [];
  for (let i = first - 1, blanks = 0; i > border && first - i <= BODY_ROWS; i--) {
    const r = rows[i]!;
    if (r.trim() === "") { if (border < 0 && ++blanks >= 2 && body.length) break; continue; }
    blanks = 0;
    if (SEPARATOR.test(r)) continue;
    body.unshift(clean(r));
  }
  const words = body.slice(-SELECTION_BODY_LINES);
  const question = words.join("\n");
  const identity = ["selection", title, question.replace(COUNTDOWN, "#s"), ...options.map(o => `${o.n}. ${o.title.replace(COUNTDOWN, "#s")}`)].join("\n");
  return { kind: "question", identity, title, question, page: "options", options, freeText: false, cursor, typed: null, rowWidth: 0, noSkip: true, webOnly: true };
}
