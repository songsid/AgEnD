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
import { createHash } from "node:crypto";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CURSOR_OPTION = /^([ \t]*)[❯›][ \t]*(\d{1,2})[.)][ \t]+(\S.*)$/;
const OPTION = /^([ \t]*)(?:[❯›][ \t]*)?(\d{1,2})[.)][ \t]+(\S.*)$/;
/**
 * The dialog's own top border: a plain rule (Claude's `─`/`▔`). Never a box row with corners (`╭─…╮`, `╰─…╯`): that is
 * Codex's session header above the transcript, not the top of a dialog (#2928 review).
 */
const BORDER = /^[ \t]*[─━═▔▁]{8,}[ \t]*$/;
/** A box's top or bottom row (Codex's session header): what is above or in it is never the dialog's words — reading stops. */
const BOX_EDGE = /^[ \t]*[╭╰┌└][─━═]{6,}[╮╯┐┘]?[ \t]*$/;
/** A separator inside the dialog (Claude's dashed rule around a command): skipped, not a boundary. */
const SEPARATOR = /^[ \t]*[╌┄┈\-]{8,}[ \t]*$/;
/** A box's side borders around a row (Codex): stripped. */
const SIDES = /^[ \t]*[│┃][ \t]?(.*?)[ \t]*[│┃]?[ \t]*$/;
/** Rows a dialog may have below its last option (a hint footer: "Esc to cancel · Tab to amend"). */
const FOOTER_ROWS = 3;
/** Refuse oversized captures rather than offering an approval for a truncated request. */
export const SELECTION_REQUEST_MAX = 128_000;
const SHELL_TITLE = /^[ \t]*(?:Bash|PowerShell) command[ \t]*$/;
const CODEX_COMMAND_TITLE = /^[ \t]*Would you like to run the following command\?[ \t]*$/;
/** Only a provider-owned whole countdown row is mutable; command arguments and option labels never are. */
const AUTO_DENY_ROW = /^[ \t]*⚠[ \t]+Claude Code will automatically (?:deny|block) this request in (?:\d+:\d\d|about \d+ (?:minute|second)s?)(?:, to avoid (?:blocking progress on|holding up) an unattended session)?[ \t]*$/;

/**
 * The numbered-choice dialog at the bottom of `pane`, as a question card titled `title` (the CLI's name), or null.
 * `rowWidth` is unused here (no typed answer); the card offers no Esc (`noSkip`) and is posted only on a web-only fleet.
 */
export function selectionCard(pane: string, title: string): RemoteQuestionCard | null {
  if (pane.length > SELECTION_REQUEST_MAX) return null;
  const text = pane.replace(ANSI, "").replace(/\r/g, "");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return null;
  const sourceRows = text.split("\n");
  const rows = sourceRows.map(r => SIDES.exec(r)?.[1] ?? r);
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
      options.push({ n: Number(m[2]), title: m[3]!.trimEnd(), recommended: false, description: null });
    } else if (options.length) {
      options[options.length - 1]!.title += ` ${rows[i]!.trim()}`;
    }
  }
  if (options.length < 2 || cursor === null || !options.every((o, i) => o.n === i + 1)) return null;

  // The dialog's words: up from the first option to its top border (Claude's plain rule — its words may hold a double blank
  // row, as the dangerous-rm dialog does), separators skipped; a dialog with no such border (Codex) ends at a double blank
  // row — never the transcript above it (#2928 review).
  let border = -1;
  for (let i = first - 1; i >= 0; i--) {
    if (BOX_EDGE.test(rows[i]!)) break;
    if (BORDER.test(rows[i]!)) { border = i; break; }
  }
  // Codex separates a command's explanation and its options by two blanks. Its explicit request header, rather than
  // that interior spacing, proves the start. A missing header must not turn a clipped command into a generic menu.
  const codexCommand = title === "Codex" && options.some(o => /^Yes, proceed\b/.test(o.title));
  let commandHeader = -1;
  if (codexCommand) {
    const headers = rows.slice(0, first).flatMap((row, index) => CODEX_COMMAND_TITLE.test(row) ? [index] : []);
    if (headers.length !== 1) return null;
    commandHeader = headers[0]!;
  }
  const rawBody: string[] = [];
  let bodyTextSeen = false;
  for (let i = first - 1, blanks = 0; i > border; i--) {
    const r = rows[i]!;
    if (r.trim() === "") { if (border < 0 && commandHeader < 0 && ++blanks >= 2 && bodyTextSeen) break; rawBody.push(r); continue; }
    blanks = 0;
    bodyTextSeen = true;
    if (BOX_EDGE.test(r)) break;
    rawBody.push(r);
    if (i === commandHeader) break;
  }
  rawBody.reverse();
  const shell = rawBody.some(r => SHELL_TITLE.test(r));
  if ((shell || title === "Claude Code" && rawBody.some(r => /^[ \t]*Do you want to proceed\?[ \t]*$/.test(r)))
    && (border < 0 || !SHELL_TITLE.test(rawBody.find(r => r.trim()) ?? ""))) return null;
  // A command can itself print dialog-looking rows. More than one possible native header is ambiguous: do not
  // recover a suffix after a command-owned rule and present it as the complete request.
  let shellHeaders = 0, previousFilled = -1;
  for (let i = 0; i < first; i++) {
    if (SHELL_TITLE.test(rows[i]!) && previousFilled >= 0 && BORDER.test(rows[previousFilled]!)) shellHeaders++;
    if (rows[i]!.trim()) previousFilled = i;
  }
  if (shell && shellHeaders !== 1) return null;

  // Keep every command row and option, including characters after the former 200/160-column limits. Preserve spaces
  // inside a command: indentation, quotes and doubled spaces can change what the person is authorizing.
  const commandStart = rawBody.findIndex(r => SEPARATOR.test(r));
  let commandEnd = -1;
  for (let i = rawBody.length - 1; i > commandStart; i--) {
    if (commandStart >= 0 && rawBody[i]!.trim() === rawBody[commandStart]!.trim()) { commandEnd = i; break; }
  }
  if (shell && (commandStart < 0 || commandEnd < 0)) return null;
  const codexCode = commandHeader < 0 ? -1 : rawBody.findIndex(r => /^[ \t]*\$[ \t]/.test(r));
  if (commandHeader >= 0 && codexCode < 0) return null;
  const bodyStart = first - rawBody.length;
  const codeRow = (index: number) => sourceRows[bodyStart + index]!.replace(/^[ \t]*[│┃][ \t]?/, "");
  const commandRows = shell || codexCode >= 0
    ? rawBody.map((_, index) => codeRow(index)).slice(shell ? commandStart + 1 : codexCode, shell ? commandEnd : undefined) : [];
  if (shell && commandRows.some(r => /^[ \t]*(?:…|\.\.\.)[ \t]*\+?\d+[ \t]+lines?\b.*(?:ctrl|expand)/i.test(r))) return null;
  const padding = commandRows
    .reduce((min, row) => row.trim() ? Math.min(min, indentOf(row)) : min, Infinity);
  const body: string[] = [];
  const identityBody: string[] = [];
  for (const [index, row] of rawBody.entries()) {
    const source = sourceRows[bodyStart + index]!;
    const inCommand = shell ? index > commandStart && index < commandEnd : codexCode >= 0 && index >= codexCode;
    if (shell ? index === commandStart || index === commandEnd : codexCode < 0 && SEPARATOR.test(row)) { identityBody.push(source); continue; }
    if (!(shell && index > commandEnd && AUTO_DENY_ROW.test(row))) identityBody.push(source);
    if (!row.trim() && !inCommand) continue;
    body.push(inCommand ? codeRow(index).slice(Number.isFinite(padding) ? padding : 0) : row.trim());
  }
  const question = body.join("\n");
  // Hash the complete request, never its presentation or a masked/clipped tail. Cursor movement is deliberately not
  // included. Only a known, separate native countdown row may tick without replacing the request.
  const optionRows = sourceRows.slice(first, last + 1).map((row, index) => CURSOR_OPTION.test(rows[first + index]!) ? row.replace(/[❯›]/, " ") : row);
  const request = [title, ...identityBody, optionRows];
  const identity = `selection:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
  return { kind: "question", identity, title, question, page: "options", options, freeText: false, cursor, typed: null, rowWidth: 0, noSkip: true, webOnly: true };
}
