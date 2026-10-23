import { EFFORT_CAPABILITIES } from "./effort-metadata.js";
import { join, resolve } from "node:path";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, chmodSync, lstatSync, readlinkSync, symlinkSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type InputDraft, type ModelOption, type RuntimeDialog, type StartupDialog, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

/** Session ids are UUIDs (e.g. "01a0c784-fb91-…"); guard before shell interpolation. */
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,}$/;

/**
 * Enough of a session log to reach the `route_facts` record that names the
 * working directory. Measured on a live session: `"cwd"` landed at byte 3899 of
 * a 450KB log, at sequence 4. 65,536 decoded characters is ~16x that headroom
 * and keeps the scan cheap even with dozens of sessions on disk.
 */
const SESSION_HEAD_CHARS = 65_536;

/** Read the workspace a session was started in, without reading the whole log. */
export function museSessionCwd(head: string): string | null {
  return head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1") ?? null;
}

/**
 * Bounded head read: the first `maxChars` UTF-16 code units of a file,
 * decoded as UTF-8, without reading the whole file (#1228: session logs grow
 * past hundreds of KB while discovery only needs the `route_facts` head).
 * The bound is decoded characters, not bytes — exactly what the old
 * readFileSync-then-slice produced, so a log whose head is mostly multibyte
 * text stays discoverable. Bytes are pulled in 64KB chunks and decoded with a
 * streaming decoder (a character split across a chunk boundary still decodes
 * intact); the byte budget is bounded by ~64KB per 16K ASCII chars and at most
 * ~320KB for a head of pure 4-byte characters. Returns null when the file
 * cannot be opened or read. Synchronous blocking I/O like the other store
 * readers — never on the fleet event loop.
 */
export function readFileHeadSync(filePath: string, maxChars: number): string | null {
  if (!(maxChars >= 1)) return "";
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    // ignoreBOM: the old Buffer.toString kept a leading U+FEFF, so the
    // equivalence with full-read-then-slice holds for BOM files too (#1281).
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const chunk = Buffer.alloc(65_536);
    let head = "";
    for (;;) {
      if (head.length >= maxChars) break;
      let nread: number;
      try {
        nread = readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        return null;
      }
      if (nread <= 0) {
        head += decoder.decode(); // EOF: flush any buffered partial character
        break;
      }
      head += decoder.decode(chunk.subarray(0, nread), { stream: true });
    }
    return head.slice(0, maxChars);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

const MUSE_SEPARATOR = /^─{10,}\s*$/;
/**
 * The status bar's own grammar, not merely "some indented text": the model id
 * first, then at least one more ` · `-joined field
 * (`  muse-spark-1.3-contributor · high · ~/cwd · Launch overrides`). A chooser
 * drawn under the box (`  1 Allow`) or any other indented row cannot pass for it.
 */
function isMuseStatusBar(row: string): boolean {
  // Split at literal separators before checking fields: repeated regex fields
  // let adjacent whitespace be repartitioned exponentially on malformed tails.
  const fields = row.split("·");
  if (fields.length < 2 || !/^\s{1,4}\S+\s+$/.test(fields[0]!)) return false;
  return fields.slice(1).every((field, index) => /^\s+\S/.test(field)
    && (index === fields.length - 2 || /\s$/.test(field)));
}
/**
 * Menu chrome muse draws for its dialogs and pickers. The picker chrome is muse
 * 1.4.0's list component, captured live on its login menu (2026-09-28):
 *   Log in with browser · Enter to choose     (the selected row)
 *   Set an API key
 *   ↓↑ to select · Esc to quit                (the hint row)
 */
const MUSE_DIALOG_CHROME = /Allow this (?:tool|command)|Approve this (?:tool|command)|^\s*[>❯]?\s*1\s+(?:Allow|Approve|Trust)\b|Use Up\/Down|Esc (?:quits|to cancel)|↓↑ to select|·\s*Enter to choose\b/i;
/** The status bar is one row; a long cwd in a narrow pane wraps it onto a few more. */
const MUSE_MAX_STATUS_ROWS = 4;
/**
 * #1717: extended bottom-region depth, but ONLY for a terminals-panel-headed
 * block (header + running tasks + bar). A long wrapped bar still fails closed
 * past MUSE_MAX_STATUS_ROWS (#958): the extension below accepts a deeper
 * separator only when the row right after it is the panel header.
 */
const MUSE_MAX_PANEL_DEPTH = 8;
/**
 * #1717: while a background task runs, muse draws a terminals panel between
 * the input box's bottom separator and the status bar (live 1.4.6,
 * tests/fixtures/muse-1.4.6/prod-background-work.pane.txt):
 *   main · ↓ to select
 *   └ ◆ Wait in the background  running   11s
 * The header ends in `↓ to select` — note the single arrow, which is NOT the
 * dialog chrome's `↓↑ to select`. The timer redraws every second, which is
 * exactly the periodic-redraw case. The composer above stays free, so the
 * panel must not fail the idle proof — but only this shape passes: anything
 * else under the separator still fails closed.
 */
const MUSE_TERMINALS_HEADER = /^.+· ↓ to select\s*$/;
const MUSE_TERMINAL_TASK_ROW = /^[└├]\s+.*\brunning\b\s+(?:\d+(?:\.\d+)?[hms]\s*)+\s*$/;
/** The working line's timer: `◇ Thinking (2s · esc to interrupt)`. */
const MUSE_BUSY = /\(\s*(?:\d+(?:\.\d+)?[hms]\s*)+·\s*esc to interrupt\s*\)/;
const MUSE_MAX_INPUT_ROWS = 200;

/** SGR only. `tmux capture-pane -e` keeps these; production `-p` does not. */
function stripSgr(s: string): string {
  return s.replace(/\x1b\[[0-9;:]*m/g, "");
}

/**
 * Muse 1.4.12 empty-composer rotating hints, copied from the 1.4.12-R6909.1
 * binary catalog (offset 8596268). A prefix, a suffix, or extra characters is
 * typed input (#2520).
 */
const MUSE_EMPTY_COMPOSER_HINTS: ReadonlySet<string> = new Set([
  "Type @ to search and insert workspace file paths",
  "Start a message with ! to run a shell command yourself",
  "Paste an image with Ctrl+V — file paths and URLs work too",
  "Press Alt+V to dictate instead of typing",
  "Tab queues or steers while a run is active",
  "Press ? on an empty composer to see keyboard shortcuts",
  "Press Ctrl+O to expand collapsed tool output",
]);

export type MusePlaceholderDebugRec = { text: string; sgr: string };
export type MusePlaceholderDebug = {
  log: (rec: MusePlaceholderDebugRec) => void;
  logged: Set<string>;
};

function logFaintPlaceholderOnce(debug: MusePlaceholderDebug | undefined, text: string, sgr: string): void {
  if (!debug) return;
  const key = `${text}\0${sgr}`;
  if (debug.logged.has(key)) return;
  debug.logged.add(key);
  try {
    debug.log({ text, sgr });
  } catch { /* Detector must not throw. */ }
}

/** Visible characters of `raw` paired with whether SGR 2 (faint) is on. */
function faintMap(raw: string): Array<{ ch: string; faint: boolean }> {
  const out: Array<{ ch: string; faint: boolean }> = [];
  let faint = false;
  const re = /\x1b\[([0-9;:]*)m/g;
  let last = 0;
  for (const m of raw.matchAll(re)) {
    for (const ch of raw.slice(last, m.index)) out.push({ ch, faint });
    const parts = m[1]!.split(";");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const c = part === "" ? 0 : Number(part.split(":")[0]);
      if (c === 0 || c === 22) faint = false;
      else if (c === 2) faint = true;
      else if ((c === 38 || c === 48 || c === 58) && !part.includes(":")) {
        // 38;2;r;g;b (truecolour) must not be read as faint (SGR 2).
        if (parts[i + 1] === "5") i += 2;
        else if (parts[i + 1] === "2") i += 4;
      }
    }
    last = m.index! + m[0].length;
  }
  for (const ch of raw.slice(last)) out.push({ ch, faint });
  return out;
}

/**
 * True when the live box's visible text (after `❯` / two-space continuation)
 * is entirely faint. An empty box is not faint — it is already empty. Without
 * SGR (production `capture-pane -p`) this is always false.
 */
function museComposerTextAllFaint(rawBoxRows: readonly string[]): boolean {
  const chars: Array<{ ch: string; faint: boolean }> = [];
  for (let i = 0; i < rawBoxRows.length; i++) {
    const mapped = faintMap(rawBoxRows[i]!);
    let j = 0;
    if (i === 0) {
      while (j < mapped.length && mapped[j]!.ch !== "❯") j++;
      if (j < mapped.length) j++;
      if (j < mapped.length && mapped[j]!.ch === " ") j++;
    } else {
      while (j < 2 && j < mapped.length && mapped[j]!.ch === " ") j++;
    }
    chars.push(...mapped.slice(j));
  }
  const significant = chars.filter(c => c.ch.trim() !== "");
  return significant.length > 0 && significant.every(c => c.faint);
}

function museComposerIsPlaceholder(
  textRows: readonly string[],
  rawBoxRows: readonly string[],
  width: number,
  debug?: MusePlaceholderDebug,
): boolean {
  if (textRows.length === 0 || textRows.every(r => r === "")) return false;
  let catalog = false;
  for (const hint of MUSE_EMPTY_COMPOSER_HINTS) {
    if (museDraftShows(textRows, width, hint)) {
      catalog = true;
      break;
    }
  }
  const faint = museComposerTextAllFaint(rawBoxRows);
  if (faint) {
    logFaintPlaceholderOnce(debug, textRows.join("\n"), rawBoxRows.join("\n"));
    return true;
  }
  return catalog;
}

/**
 * True when every row after the bottom separator is muse's status bar: its
 * first row in the bar's grammar, the rest a wrapped continuation of it. A
 * picker, a dialog, a busy line or a second separator there means the box above
 * is not the live input (#829 review: a chooser under an old box).
 *
 * #1717: a terminals panel may sit between the separator and the bar (a
 * `· ↓ to select` header plus `running` task rows). It is stripped first and
 * each of its rows must match the panel grammar — a header with no task row,
 * or any other shape, still fails closed.
 */
function museStatusFooter(rows: readonly string[], bottomSeparator: number, busy: RegExp): boolean {
  let status = rows.slice(bottomSeparator + 1);
  if (status.length === 0) return false;
  if (MUSE_TERMINALS_HEADER.test(status[0])) {
    let end = 1;
    while (end < status.length && MUSE_TERMINAL_TASK_ROW.test(status[end])) end++;
    if (end === 1) return false;
    const panel = status.slice(0, end);
    if (!panel.every(row => !MUSE_SEPARATOR.test(row.trim()) && !busy.test(row) && !MUSE_DIALOG_CHROME.test(row))) return false;
    status = status.slice(end);
    if (status.length === 0) return false;
  }
  if (!isMuseStatusBar(status[0]!)) return false;
  if (!status.every(row => /^\s+\S/.test(row) && !MUSE_SEPARATOR.test(row.trim()) && !busy.test(row) && !MUSE_DIALOG_CHROME.test(row))) return false;
  // A wrapped cwd continues as path text; a numbered option list or a
  // selection cursor under the bar is a picker, not the bar.
  return !status.slice(1).some(row => /^\s*[>❯›]?\s*\d+[.)]?\s+\S/.test(row) || /^\s*[>›]/.test(row));
}

/**
 * The structural core of the idle proof, shared with the quit-menu matcher
 * (#1730 P2-1): true when the CURRENT screen — anchored to the bottom
 * separator — shows the live, empty input box. A transcript quoting an older
 * screen above never satisfies it.
 */
function museFreeComposerLayout(rows: readonly string[], busyPattern: RegExp): boolean {
  // The approval prompt is auto-answered rather than input-blocking, so the
  // idle proof itself must refuse a frame that shows dialog chrome.
  const dialogChrome = MUSE_DIALOG_CHROME;
  const stripped = rows.map(stripSgr);
  // Everything after the bottom separator must be the status bar (#1717:
  // optionally a terminals panel first).
  const bottomSeparator = museBottomSeparator(stripped);
  if (bottomSeparator < 2) return false;
  if (!museStatusFooter(stripped, bottomSeparator, busyPattern)) return false;
  // Directly above it, the EMPTY live prompt. A 1.4.12 empty-composer hint
  // is empty (#2520); any other `❯` text is a draft and never proves idle.
  const draft = museInputBox(rows.join("\n"), busyPattern);
  if (draft === null || draft.rows.length > 0) return false;
  let prompt = -1;
  for (let i = bottomSeparator - 1; i >= 1; i--) {
    if (MUSE_SEPARATOR.test(stripped[i]!)) break;
    if (/^❯(?:\s|$)/.test(stripped[i]!)) { prompt = i; break; }
  }
  if (prompt < 1) return false;
  const topSeparator = prompt - 1;
  if (!MUSE_SEPARATOR.test(stripped[topSeparator]!)) return false;
  // No busy indicator and no dialog just above the input box. The working
  // line (`◇ Thinking (2s · esc to interrupt)`) sits immediately above the
  // top separator; check 8 rows up to be safe.
  const above = stripped.slice(Math.max(0, topSeparator - 8), topSeparator);
  if (above.some(r => busyPattern.test(r) || dialogChrome.test(r))) return false;
  // Arrow-key pickers (`/model`) are refused by their component chrome
  // above, not by guessing from answer text that happens to list model ids.
  // A `›` selection cursor is refused too; `❯` is not a cursor here — muse
  // echoes submitted messages with it.
  return !above.some(r => /^\s*›\s+\S/.test(r));
}

/**
 * Nearest bottom separator, with the #1717 panel extension: the plain search
 * stays capped at MUSE_MAX_STATUS_ROWS (a 5-row wrapped bar still fails
 * closed, #958); a deeper separator is accepted only when the row right
 * after it is the terminals-panel header. Nearest-first, so a stale
 * separator in scrollback can never win over the live one.
 */
function museBottomSeparator(rows: readonly string[]): number {
  for (let i = rows.length - 2; i >= Math.max(0, rows.length - 1 - MUSE_MAX_STATUS_ROWS); i--) {
    if (MUSE_SEPARATOR.test(rows[i])) return i;
  }
  for (let i = Math.max(0, rows.length - 1 - MUSE_MAX_STATUS_ROWS) - 1; i >= Math.max(0, rows.length - 1 - MUSE_MAX_PANEL_DEPTH); i--) {
    if (MUSE_SEPARATOR.test(rows[i])) {
      return MUSE_TERMINALS_HEADER.test(rows[i + 1] ?? "") ? i : -1;
    }
  }
  return -1;
}

/**
 * #1717: true when the pane shows muse's terminals panel with at least one
 * running task — the "local work still active" state. Anchored to the last
 * separator, where the live panel sits under the input box: a transcript
 * quoting an old panel above a separator never counts. The idle proof checks
 * the same shape positionally via museStatusFooter; this boolean feeds the
 * pause gate below.
 */
export function museBackgroundWorkActive(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  let sep = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (MUSE_SEPARATOR.test(rows[i])) { sep = i; break; }
  }
  if (sep < 0) return false;
  const after = rows.slice(sep + 1);
  return after.length > 1 && MUSE_TERMINALS_HEADER.test(after[0]) && MUSE_TERMINAL_TASK_ROW.test(after[1]);
}

/**
 * The rows of muse's live input box, or null when the bottom of the pane is not
 * muse's layout (#829). The box is the LAST thing above the status bar:
 *
 *   ─────────────────────────────            separator
 *   ❯ [user:… ] first row of the text        `❯ ` then the text
 *     second row                             continuation rows, two-space indent
 *   ─────────────────────────────            separator
 *     model · effort · cwd · …               status bar (a long cwd may wrap)
 *
 * Captured live on muse 1.4.2 (tests/fixtures/muse-input-829/). A `❯` row above
 * an echoed turn in the transcript is never read: the box must end at the
 * separator directly above the status bar. Muse 1.4.12 may paint a faint
 * rotating hint in an empty box (#2520); that is empty, not a draft.
 */
export function museInputBox(pane: string, busy: RegExp = MUSE_BUSY, debug?: MusePlaceholderDebug): InputDraft | null {
  const rawRows = pane.replace(/\r/g, "").split("\n");
  while (rawRows.length && !stripSgr(rawRows[rawRows.length - 1]!).trim()) rawRows.pop();
  const rows = rawRows.map(stripSgr);
  const bottom = museBottomSeparator(rows);
  if (bottom < 2 || !museStatusFooter(rows, bottom, busy)) return null;
  for (let top = bottom - 1, n = 0; top >= 1 && n < MUSE_MAX_INPUT_ROWS; top--, n++) {
    const row = rows[top];
    if (MUSE_SEPARATOR.test(row)) return null;
    if (/^❯(?:\s|$)/.test(row)) {
      if (!MUSE_SEPARATOR.test(rows[top - 1]!)) return null;
      const box = rows.slice(top, bottom);
      const rawBox = rawRows.slice(top, bottom);
      if (!box.slice(1).every(r => r === "" || /^ {2}/.test(r))) return null;
      // Only the ASCII spaces muse pads rows with are dropped; any other
      // character on screen, Unicode spaces included, is part of the draft.
      const text = [box[0]!.replace(/^❯ ?/, "").replace(/ +$/, ""), ...box.slice(1).map(r => r.slice(2).replace(/ +$/, ""))];
      // The separators span the pane: that is the width the box was wrapped to.
      const width = rows[bottom]!.trimEnd().length;
      if (text.every(r => r === "") || museComposerIsPlaceholder(text, rawBox, width, debug)) return { rows: [], width };
      return { rows: text, width };
    }
  }
  return null;
}

/**
 * True only when `rows` are exactly how muse 1.4.2 draws `text` in a box
 * `width` columns wide (#829 review). Captured live at 80 columns
 * (tests/fixtures/muse-input-829/wrap-*):
 *  - a hard newline starts a new row; an empty line is an empty row;
 *  - a line too long for the row wraps at a space — every space at the break
 *    is dropped — when the next word does not fit in `width - 4` columns;
 *  - a word longer than that is cut at exactly `width - 3` columns;
 *  - trailing ASCII spaces are not drawn (any other trailing character is).
 * Whitespace is never compared loosely: `/tmp/foo bar` is not `/tmp/foobar`.
 * A wrap is only judged for printable ASCII, whose width is its length;
 * anything else must fit on one row as is. A collapsed `[Pasted Content N
 * chars]` hides its content, so it never matches.
 */
export function museDraftShows(rows: readonly string[], width: number, text: string): boolean {
  const full = width - 3;
  let i = 0;
  for (const line of text.replace(/\r/g, "").split("\n").map(l => l.replace(/ +$/, ""))) {
    let rest = line;
    for (;;) {
      const row = rows[i];
      if (row === undefined) return false;
      i++;
      if (rest === "") {
        if (row !== "") return false;
        break;
      }
      if (row === "" || !rest.startsWith(row)) return false;
      rest = rest.slice(row.length);
      if (rest === "") break;
      // The line continues on the next row: muse must have wrapped it here.
      if (!/^[\x20-\x7e]*$/.test(row + rest)) return false;
      const gap = /^ */.exec(rest)![0].length;
      if (gap > 0) {
        const word = rest.slice(gap).split(" ")[0];
        if (word === "" || row.length + gap + word.length <= full - 1) return false;
        rest = rest.slice(gap);
      } else if (row.length !== full) {
        return false;
      }
    }
  }
  return i === rows.length;
}

/**
 * muse's logged-out menu (1.4.3): the two choices, then the key hint, as the last rows of the pane, with any cursor
 * glyph allowed in front of a choice.
 */
export function museLoginScreenActive(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n").map(row => row.replace(/\s+$/, "")).filter(row => row.trim() !== "");
  if (rows.length < 3) return false;
  const [browser, apiKey, hint] = rows.slice(-3) as [string, string, string];
  const choice = (row: string, label: string) => new RegExp(`^[ \\t]*(?:[❯›>▸][ \\t]*)?${label}\\b`).test(row);
  return choice(browser, "Log in with browser") && choice(apiKey, "Set an API key") && /to select\b.*\bEsc to quit$/.test(hint);
}

/**
 * The logged-out menu as a dialog (#1328): 1.4.3 paints "Log in with browser · Enter to choose" / "Set an API key" /
 * "↓↑ to select · Esc to quit". The older login wording matches none of it, and the ready pattern (`Muse Code \d`)
 * matched the header, so a logged-out muse passed as ready. Held — a human has to log in — with deliveries blocked,
 * in the startup scan and at runtime; the parked-dialog report tells them. Bottom-anchored (museLoginScreenActive).
 */
const MUSE_LOGIN_MENU: RuntimeDialog = {
  pattern: /Log in with browser|Set an API key/,
  isActive: museLoginScreenActive,
  keys: [],
  holdOnly: true,
  blocksDelivery: true,
  inputBlocked: true,
  description: "Muse login menu — waiting for a human to log in (never answered)",
};

/**
 * #1716: `/quit` while a background task runs is answered with a confirmation
 * instead of an exit (live 1.4.6,
 * tests/fixtures/muse-1.4.6/prod-quit-with-local-work.pane.txt):
 *   ❯
 *     Local work is still active
 *     The following will stop when you exit:
 *     background task · tool.bash
 *     ❯ 1. Exit anyway
 *       2. Stay
 *     Enter to confirm · Esc to cancel
 *   ──────────
 *   main · ↓ to select
 *   └ ◇ Wait in the background  running   15s
 *     mock-model · high · ~/work · Launch overrides
 * Unlike Claude's prompt this menu is NOT bottom-anchored — the terminals
 * panel sits under it — so the match is anchored to the hint row instead:
 * the header must be within 12 rows above it with both options in between.
 * Enter would take the selected option ("Exit anyway"), so like #1217 this is
 * recognised whole and never answered here: the stop flow cancels it.
 */
/**
 * #1715: with `skip_permissions: false` muse asks before running a command
 * needing approval (live 1.4.6,
 * tests/fixtures/muse-1.4.6/approval-escalated.pane.txt and
 * approval-untrusted-staged.pane.txt):
 *   Would you like to run the following command?
 *     $ echo perm-check
 *   › 1. Yes, proceed (y)
 *     2. No, and tell Muse Code what to do differently (esc)
 *   Change approval defaults in /permissions
 * `--approval-mode untrusted` (new in 1.4.6) stages the command first
 * (`Stage 1/1`, `Current argv: [...]`) and offers three options (allow once /
 * always allow in this workspace / abort). 1.4.4 shows the same prompt with a
 * `›` marker and no footer line. Enter would take the preselected allow
 * option, so like #1716 this is recognised whole and never answered here.
 * 1.4.7 draws the selection cursor as `⟩` on this prompt and on the #1716
 * quit menu (tests/fixtures/muse-1.4.7); the other rows of those blocks are
 * unchanged.
 */
export const MUSE_APPROVAL_PROMPT = /^[ \t]*Would you like to run the following command\?[ \t]*$/m;
const MUSE_APPROVAL_STAGE = /^[ \t]*Stage \d+\/\d+[ \t]*$/;
const MUSE_APPROVAL_ARGV = /^[ \t]*Current argv: \[.*\][ \t]*$/;
const MUSE_APPROVAL_OPT = /^[ \t]*[❯›⟩]?[ \t]*\d\.[ \t]+/;
const MUSE_APPROVAL_FOOTER = /^[ \t]*Change approval defaults in \/permissions[ \t]*$/;
/**
 * #1715: which request the approval prompt is showing — its `$ command` row.
 * Stable across the `Calling tools (Ns)` timer redraws, so the episode can
 * confirm; a whole-pane hash never would. Derived from the SAME selected
 * block as the predicate (#1715 r2): a scrollback quote's command must never
 * become the current request's identity.
 */
export function museApprovalRequestIdentity(pane: string): string | null {
  const s = museApprovalScreen(pane);
  if (s === null) return null;
  return museApprovalBlock(s.screen, s.top, s.bottom)?.command ?? null;
}
/**
 * #1715 r2: the selected live approval block — its header row index and `$`
 * command text. Headers are tried newest-first inside the live input block so
 * a scrollback quote never shadows the current prompt, and the identity comes
 * from the SAME block the predicate accepts (never a separate global search).
 */
function museApprovalBlock(screen: string[], top: number, bottom: number): { head: number; command: string } | null {
  const window: Array<{ row: string; index: number }> = [];
  for (let i = bottom - 1; i > top; i--) {
    if (screen[i].trim()) window.unshift({ row: screen[i], index: i });
  }
  for (let h = window.length - 1; h >= 0; h--) {
    if (!MUSE_APPROVAL_PROMPT.test(window[h].row)) continue;
    let k = h + 1;
    const commandRow = k < window.length ? window[k].row : "";
    const command = /^[ \t]*\$ (.+?)[ \t]*$/.exec(commandRow)?.[1]?.trim();
    if (!command) continue;
    k++;
    if (k < window.length && MUSE_APPROVAL_STAGE.test(window[k].row)) k++;
    if (k < window.length && MUSE_APPROVAL_ARGV.test(window[k].row)) k++;
    const last = window[window.length - 1]?.row;
    const options = (last !== undefined && MUSE_APPROVAL_FOOTER.test(last) ? window.slice(k, -1) : window.slice(k))
      .map(entry => entry.row);
    if (options.length !== 2 && options.length !== 3) continue;
    if (!options.every(row => MUSE_APPROVAL_OPT.test(row))) continue;
    const first = (options[0] ?? "").replace(/^[ \t]*[❯›⟩]?[ \t]*/, "");
    const second = options[1] ?? "";
    if (options.length === 2) {
      if (!/^1\. Yes, proceed \(y\)[ \t]*$/.test(first)) continue;
      if (!/^[ \t]*[❯›⟩]?[ \t]*2\. No, and tell Muse Code what to do differently \(esc\)[ \t]*$/.test(second)) continue;
    } else {
      if (!/^1\. Allow this stage once \(y\)[ \t]*$/.test(first)) continue;
      if (!/^[ \t]*[❯›⟩]?[ \t]*2\. Always allow in this workspace: .+ \(p\)[ \t]*$/.test(second)) continue;
      if (!/^[ \t]*[❯›⟩]?[ \t]*3\. Abort the entire command \(esc\)[ \t]*$/.test(options[2] ?? "")) continue;
    }
    return { head: window[h].index, command };
  }
  return null;
}

function museApprovalScreen(pane: string): { screen: string[]; top: number; bottom: number } | null {
  const screen = pane.replace(/\r/g, "").split("\n");
  while (screen.length && !screen[screen.length - 1].trim()) screen.pop();
  const bottom = museBottomSeparator(screen);
  if (bottom < 0) return null;
  // Same ownership as the quit menu (#1730 P2-1): the prompt must live in the
  // current input block, and a free composer means any prompt text is history.
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (MUSE_SEPARATOR.test(screen[i])) { top = i; break; }
  }
  if (museFreeComposerLayout(screen, MUSE_BUSY)) return null;
  // #1715 r3: any readable composer means prompt text is a quote, not the
  // live block — the live approval panes carry no ❯ composer row at all
  // (inputDraft null), while a quoting draft does, even one starting with a
  // blank first row. A null draft (no readable box) carries nothing to judge,
  // so it still proceeds.
  if (museInputBox(pane, MUSE_BUSY) !== null) return null;
  return { screen, top, bottom };
}

export function museApprovalPromptActive(pane: string): boolean {
  const s = museApprovalScreen(pane);
  return s !== null && museApprovalBlock(s.screen, s.top, s.bottom) !== null;
}

export const MUSE_LOCAL_WORK_QUIT = /^[ \t]*Local work is still active[ \t]*$/m;
const MUSE_QUIT_HINT = /^[ \t]*Enter to confirm · Esc to cancel[ \t]*$/;
const MUSE_QUIT_OPT_1 = /^[ \t]*[❯›⟩]?[ \t]*1\.[ \t]+Exit anyway[ \t]*$/m;
const MUSE_QUIT_OPT_2 = /^[ \t]*[❯›⟩]?[ \t]*2\.[ \t]+Stay[ \t]*$/m;
export function museLocalWorkQuitActive(pane: string): boolean {
  const screen = pane.replace(/\r/g, "").split("\n");
  while (screen.length && !screen[screen.length - 1].trim()) screen.pop();
  const bottom = museBottomSeparator(screen);
  if (bottom < 0) return false;
  // #1730 P2-1 (refined): the menu must belong to the CURRENT input block —
  // between the bottom separator and the nearest separator above it. Menu
  // text quoted in an older screen is history even when the current composer
  // is busy with a draft, not just when it is free.
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (MUSE_SEPARATOR.test(screen[i])) { top = i; break; }
  }
  // A free composer on the current screen means any menu text is history.
  if (museFreeComposerLayout(screen, MUSE_BUSY)) return false;
  // #1730 P2-1 r3: a populated ❯ line means any menu text is a quote, not the
  // live chrome. The menu only ever answers a submitted /quit, which clears
  // the box — the live capture's ❯ row is empty with the menu as chrome under
  // it — while every quoting draft (r2's "cancel me", r3a's hint-carrying
  // draft, r3b's menu-quoting draft) holds text on the ❯ line itself. A null
  // draft (no readable box) carries nothing to judge, so it still proceeds.
  // Residual: an empty ❯ followed by a verbatim menu paste is byte-identical
  // to the live chrome and cannot be separated here.
  const draft = museInputBox(pane, MUSE_BUSY);
  if (draft !== null && draft.rows.length > 0 && draft.rows[0].trim() !== "") return false;
  // Candidates newest-first, so a stale quote above never shadows the live
  // block below (or passes as live itself).
  for (let h = screen.length - 1; h >= 0; h--) {
    if (!MUSE_QUIT_HINT.test(screen[h])) continue;
    if (!(h > top && h < bottom)) continue;
    // The block above, skipping padding blanks (the same 12-non-blank
    // window as before — the live menu fits in 9), with screen indices so the
    // WHOLE block is fenced to the live input box, not just the hint: the
    // backward scan must not borrow the header or options from above top.
    const window: Array<{ row: string; index: number }> = [];
    for (let i = h - 1; i >= 0 && window.length < 12; i--) {
      if (screen[i].trim()) window.unshift({ row: screen[i], index: i });
    }
    if (window.length < 4) continue;
    // #1730 P2-1 r4: headers newest-first, eligible only — a scrollback header
    // above top must not shadow the live header inside the box. The first
    // (oldest) match can sit above top while the current menu is intact below.
    for (let head = window.length - 1; head >= 0; head--) {
      if (!MUSE_LOCAL_WORK_QUIT.test(window[head].row)) continue;
      if (window[head].index <= top) continue;
      const block = window.slice(head).map(entry => entry.row).join("\n");
      if (!MUSE_QUIT_OPT_1.test(block) || !MUSE_QUIT_OPT_2.test(block)) continue;
      return true;
    }
  }
  return false;
}

/**
 * #1796: the fallback `/model` set, used only when muse's on-disk provider
 * catalog is missing or unreadable. It mirrors what the 1.4.7 picker shows
 * (visible rows only — no `-contributor` ids); the live catalog remains the
 * source of truth whenever it can be read.
 */
const MUSE_MODEL_FALLBACK: readonly ModelOption[] = [
  { id: "muse-wonder-1.0", label: "muse-wonder-1.0" },
  { id: "muse-spark-1.3", label: "muse-spark-1.3" },
  { id: "muse-spark-1.2", label: "muse-spark-1.2" },
];

/**
 * #1796: read the provider catalog muse caches on disk
 * (`<state>/model-catalog/<provider>__<profile>.json`). Bounded (at most 16
 * files, 256 KiB each) and best-effort — anything unexpected yields the
 * fallback. Listed rows only: `visibility: "visible"` is what the 1.4.7
 * picker shows (the `-contributor` siblings and the image model are hidden),
 * and a null `context_limit` additionally marks a non-chat model. File order
 * is kept and ids deduped.
 *
 * `stateDir` is injectable for tests; production passes nothing and reads the
 * host state dir (the fleet never isolates XDG_DATA_HOME, mirroring the
 * session lookup).
 */
export function readMuseModelCatalog(stateDir?: string): ModelOption[] {
  // Root resolution mirrors the binary, not XDG_STATE_HOME: 1.4.7 builds its
  // state dir as `$XDG_DATA_HOME/muse` or `$HOME/.local/share/muse`
  // (MUSE_SESSIONS uses the same root).
  const base = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "muse")
    : join(homedir(), ".local", "share", "muse");
  const dir = join(stateDir ?? base, "model-catalog");
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort().slice(0, 16);
    if (files.length === 0) return [...MUSE_MODEL_FALLBACK];
    const seen = new Set<string>();
    const out: ModelOption[] = [];
    for (const file of files) {
      const path = join(dir, file);
      try {
        if (statSync(path).size > 262_144) continue;
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        const rows = (parsed as { rows?: unknown }).rows;
        if (!Array.isArray(rows)) continue;
        for (const row of rows.slice(0, 256)) {
          const r = row as { model_id?: unknown; display_label?: unknown; context_limit?: unknown; visibility?: unknown };
          if (typeof r.model_id !== "string" || r.model_id === "" || r.visibility !== "visible") continue;
          // A `-contributor` suffix is a legacy spelling of contributor mode,
          // not a model — excluded even if some profile ever marks it visible.
          if (r.model_id.endsWith("-contributor")) continue;
          if (r.context_limit == null) continue;
          if (seen.has(r.model_id)) continue;
          seen.add(r.model_id);
          out.push({ id: r.model_id, label: typeof r.display_label === "string" && r.display_label !== "" ? r.display_label : r.model_id });
        }
      } catch { /* one bad file never hides the rest */ }
    }
    return out.length > 0 ? out : [...MUSE_MODEL_FALLBACK];
  } catch {
    return [...MUSE_MODEL_FALLBACK];
  }
}

/**
 * Meta Muse Code — the `muse` CLI (v1.3.0 verified).
 *
 * Everything below was confirmed against live sessions on 2026-09-22 rather
 * than read out of `--help`, because the two disagree in the places that
 * matter. Three findings shaped this file:
 *
 *   1. The input prompt `❯` stays on screen the entire time muse works, so the
 *      ready pattern alone can never say "idle" — hence getBusyPattern().
 *   2. Ctrl+C is QUIT (twice), not cancel. The TUI's own hint is "esc to
 *      interrupt", and Escape is what stops a run. Wiring C-c to cancel would
 *      have left every instance one stray keypress from death.
 *   3. `--disable-approval` alone still stops at a workspace-trust dialog. It
 *      needs `--trust-workspace` beside it to reach the prompt unattended.
 */
export class MuseBackend implements CliBackend {
  /**
   * #1510: the reply-completion guard covers muse, its turn end read from the session log (run `started` /
   * `terminal`, recorded on 1.4.4 in tests/fixtures/reply-guard-1510): between a run and the run a mid-run message
   * starts, the pane shows one idle frame — the log does not.
   */
  readonly replyCompletionGuard = true;
  readonly turnEndFromTranscript = true;
  readonly binaryName = "muse";
  private binaryPath: string;
  private readonly sharedXdgConfigHome: string;
  // Cached from buildCommand/writeConfig so getSessionId() (which takes no
  // args) can match sessions against this instance's workspace.
  private workingDirectory?: string;
  /** Owner-bound faint-placeholder debug; constructing another MuseBackend must not replace this. */
  private placeholderDebug?: MusePlaceholderDebug;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("muse");
    this.sharedXdgConfigHome = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"));
  }

  buildCommand(config: CliBackendConfig): string {
    this.workingDirectory = config.workingDirectory;

    // `muse` on PATH is a launcher script that checks for a new release, may
    // replace the binary underneath us, and records an update notice that the
    // next start prints. A fleet agent can run for days; an update arriving
    // mid-run would repaint the pane and swap the CLI. One year in seconds
    // keeps the check quiet while staying inside the launcher's own numeric
    // guard (a non-numeric value also disables it, but undocumented).
    // Muse has one user-level settings.json and loads every MCP server in it.
    // Point only this Muse process at its instance-scoped copy; otherwise two
    // fleet instances both see both socket-bearing MCP tools.
    let cmd = `XDG_CONFIG_HOME=${shellQuote(this.isolatedXdgConfigHome())} MUSE_UPDATE_INTERVAL_SECONDS=31536000 ${this.binaryPath}`;

    // The daemon may prepare a localhost-only usage relay before spawning Muse.
    // If relay preparation fails this remains unset and Muse connects directly;
    // usage must never become a prerequisite for a working conversation.
    if (config.museBaseUrl) cmd += ` --base-url ${shellQuote(config.museBaseUrl)}`;

    // Verified: `--disable-approval` on its own leaves the session parked on
    // "Do you trust this workspace?" forever. Trust is a separate axis, so both
    // flags are needed to reach the prompt unattended.
    //
    // NOT `--yolo`: that disables approval, trust AND the OS sandbox. The
    // sandbox was measured to permit what an agent actually needs — writes in
    // the workspace and to the temp dir, and outbound network through the proxy
    // (curl to example.com returned 200) — so there is nothing to buy by
    // switching it off, and a sandboxed shell is worth keeping.
    if (config.skipPermissions !== false) cmd += " --disable-approval --trust-workspace";

    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("muse", model);
      cmd += ` --model ${shellQuote(model)}`;
    }
    // muse accepts none|minimal|low|medium|high|xhigh|max|ultra; AgEnD's levels
    // are a subset, so whatever the fleet holds is passed through unchanged.
    if (config.effort) cmd += ` --reasoning-effort ${shellQuote(config.effort)}`;

    // Resume is a SUBCOMMAND, and root options may sit on either side of it
    // (stated in `muse resume --help`, and verified: root flags + `resume <id>`
    // launched into the prior conversation with the model flag applied).
    // `resume --last` is workspace-scoped and would silently adopt a session the
    // user started by hand in the same directory, so we resume the id we
    // persisted and nothing else.
    if (!config.skipResume) {
      const sid = this.storedSessionId();
      if (sid) cmd += ` resume ${sid}`;
    }
    return cmd;
  }

  /** The daemon's persisted session id (written from getSessionId()), for resume. */
  private storedSessionId(): string | null {
    try {
      const sid = readFileSync(join(this.instanceDir, "session-id"), "utf-8").trim();
      return SESSION_ID_RE.test(sid) ? sid : null;
    } catch { return null; }
  }

  /**
   * Per-instance MCP key. Keep tool names stable across the shared-settings
   * migration; a non-ASCII instance name becomes an ASCII slug plus a hash.
   */
  private mcpKey(mcpName: string, instanceName: string): string {
    const ascii = instanceName.replace(/[^\x20-\x7E]/g, "");
    if (ascii === instanceName) return `agend-${mcpName}-${instanceName}`;
    const slug = ascii.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const hash = createHash("md5").update(instanceName).digest("hex").slice(0, 8);
    return slug ? `agend-${mcpName}-${slug}-${hash}` : `agend-${mcpName}-${hash}`;
  }

  private isolatedXdgConfigHome(): string {
    return join(this.instanceDir, "muse-xdg");
  }

  /** Muse's per-process settings location after buildCommand sets XDG_CONFIG_HOME. */
  private settingsPath(): string {
    return join(this.isolatedXdgConfigHome(), "muse", "settings.json");
  }

  private sharedSettingsPath(): string {
    return join(this.sharedXdgConfigHome, "muse", "settings.json");
  }

  private mirrorSharedConfigEntries(sourceDir: string, isolatedDir: string, excluded: Set<string>): void {
    for (const name of readdirSync(sourceDir)) {
      if (excluded.has(name)) continue;
      const link = join(isolatedDir, name);
      try {
        lstatSync(link);
        continue; // Keep any per-instance file Muse already created.
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      symlinkSync(join(sourceDir, name), link);
    }
  }

  /** Preserve the user's login while keeping Muse's MCP settings per instance. */
  private linkSharedAuth(): void {
    const sharedMuseDir = join(this.sharedXdgConfigHome, "muse");
    const isolatedXdgHome = this.isolatedXdgConfigHome();
    const isolatedMuseDir = join(isolatedXdgHome, "muse");
    mkdirSync(sharedMuseDir, { recursive: true, mode: 0o700 });
    mkdirSync(isolatedXdgHome, { recursive: true, mode: 0o700 });
    mkdirSync(isolatedMuseDir, { recursive: true, mode: 0o700 });
    chmodSync(isolatedXdgHome, 0o700);
    chmodSync(isolatedMuseDir, 0o700);
    // XDG_CONFIG_HOME also affects tools run by Muse. Mirror unrelated XDG and
    // Muse config entries, while owning only settings.json in this instance.
    this.mirrorSharedConfigEntries(this.sharedXdgConfigHome, isolatedXdgHome, new Set(["muse"]));
    this.mirrorSharedConfigEntries(sharedMuseDir, isolatedMuseDir, new Set(["settings.json", "auth.json", ".auth.json.lock"]));
    // Muse uses a lock beside auth.json. Both symlinks must point at the same
    // shared files so login/refresh from two instances remains serialized.
    for (const name of ["auth.json", ".auth.json.lock"]) {
      const target = join(sharedMuseDir, name);
      const link = join(isolatedMuseDir, name);
      try {
        const st = lstatSync(link);
        if (st.isSymbolicLink() && readlinkSync(link) === target) continue;
        throw new Error(`Muse auth path is already occupied: ${link}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      symlinkSync(target, link);
    }
  }

  writeConfig(config: CliBackendConfig): void {
    this.workingDirectory = config.workingDirectory;

    // Muse reads every MCP entry in its single XDG settings.json; namespacing
    // keys inside a shared file still exposes all sibling instances' tools to
    // every Muse process. Copy the user's ordinary settings into this instance's
    // XDG home, excluding all AgEnD MCP entries, then add only this socket.
    this.linkSharedAuth();
    const settingsPath = this.settingsPath();
    let root: Record<string, unknown> = {};
    try { root = JSON.parse(readFileSync(this.sharedSettingsPath(), "utf-8")); } catch { /* new file */ }
    if (typeof root.schema_version !== "number") root.schema_version = 1;

    const servers = { ...((root.mcpServers ?? {}) as Record<string, unknown>) };
    for (const key of Object.keys(servers)) {
      if (key === "agend" || key.startsWith("agend-")) delete servers[key];
    }

    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };

      // Same wrapper as grok/kiro. Two jobs: export the env explicitly rather
      // than trusting the CLI to forward the entry's `env` block, and wait for
      // the IPC socket to exist — a server that starts first would fail to
      // connect and every fleet tool (reply/react/…) would be dead for the run.
      const wrapperPath = join(this.instanceDir, `mcp-wrapper-${name}.sh`);
      const envExports = Object.entries(allEnv)
        .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
        .join("\n");
      // 0o700: the wrapper inlines sensitive env (tokens, socket paths).
      writeFileSync(
        wrapperPath,
        `#!/bin/bash\n${envExports}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${[entry.command, ...entry.args].map(shellQuote).join(" ")}\n`,
        { mode: 0o700 },
      );
      chmodSync(wrapperPath, 0o700);

      // Entry shape per muse's own documentation: type/command/args/env/mode.
      // "optional" so a server that fails to start degrades the session instead
      // of stopping it.
      servers[this.mcpKey(name, config.instanceName)] = {
        type: "stdio",
        command: wrapperPath,
        args: [],
        mode: "optional",
      };
    }
    root.mcpServers = servers;
    const temporaryPath = `${settingsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(root, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temporaryPath, settingsPath);
      chmodSync(settingsPath, 0o600);
    } finally {
      try { unlinkSync(temporaryPath); } catch { /* renamed or write failed */ }
    }

    // `muse init` scaffolds AGENTS.md and the binary reads it as project rules,
    // the same convention as codex and grok. Additive + idempotent via marker.
    if (config.instructions) {
      try {
        appendWithMarker(join(config.workingDirectory, "AGENTS.md"), config.instanceName, config.instructions);
      } catch { /* best effort */ }
    }
  }

  requiresDeliveryEnterRetry(): boolean {
    // Measured, not inferred. An Enter that arrives in the same keystroke burst
    // as the text is taken as a NEWLINE: `tmux send-keys "probe N" Enter`
    // failed to submit three times out of three, and the drafts stacked up in
    // the input box —
    //
    //   ❯ probe 1
    //     probe 2
    //     probe 3
    //
    // The damage is not a lost message but a merged one: the next Enter submits
    // the whole draft as a single turn. The daemon's waitForPasteSettle already
    // opens the gap muse needs (a paste followed by Enter a second later
    // submitted every time, including mid-turn), so this is insurance against
    // the case where the settle wait is blind and falls back to a fixed delay.
    //
    // Safe on every delivery, both preconditions verified live: a bare Enter is
    // a no-op at an empty idle prompt, and a no-op mid-turn with empty input.
    return true;
  }

  getReadyPattern(): RegExp {
    // The ready screen carries the `Muse Code <version>` header and an empty
    // `❯` input row. Both survive scrollback, which is fine — this pattern only
    // has to say "the TUI is up"; getBusyPattern() is what says "not now".
    return /❯|Muse Code \d/m;
  }

  /**
   * The working line, which is on screen only while muse is generating.
   *
   * Required for the same reason grok and claude-code needed one: the input box
   * (and therefore `❯`) stays visible the whole time muse works, so the ready
   * pattern is effectively constant-true and the instance would never be seen
   * as busy — no hang detection, and a frozen CLI reported as idle.
   *
   * Sampled from a live run. The phase word changes (`Thinking`, `Working`,
   * `Double checking`) and the leading glyph cycles (◇ ◆ ◈), so neither is the
   * anchor. What every working frame has, and no idle frame does, is the
   * interrupt hint muse prints beside the elapsed timer:
   *
   *   ◇ Thinking (2s · esc to interrupt)
   *   ◆ Double checking (4s · esc to interrupt)
   *   ◈ Calling tools (1m 31s · esc to interrupt)
   *
   * The timer grows units: past a minute it reads `1m 31s` (#1045). Matching
   * seconds only let every turn longer than a minute read as not busy — 87
   * of the 196 working rows in a real muse log — so the idle proof passed
   * mid-turn and idle-edge actions (a deferred pause's `/quit`, #1042) fired.
   *
   * Anchoring on the glyph would be wrong in a way that matters: completed
   * output lines start with `◆ ` too (`◆ Panes split the dark screen`), so a
   * glyph-anchored pattern would pin a finished instance in `working` forever.
   */
  getBusyPattern(): RegExp {
    return MUSE_BUSY;
  }

  /**
   * Structural proof that muse's TUI is parked at its idle input prompt.
   *
   * Muse's status bar (`model · effort · cwd · ...`) redraws periodically even
   * when the session is fully idle. Without this method `canProvePeriodicIdle`
   * stays false in the daemon, so every status-bar repaint triggers a plain
   * `recordOutput()` call, resetting the silence debounce and leaving the
   * instance stuck in `working` forever (no auto-pause, cancel never retires,
   * delegate_task times out on the readiness gate).
   *
   * The idle layout, last four non-blank rows:
   *   ─────────────────────────────  (separator)
   *   ❯                             (empty input box — no user text after it)
   *   ─────────────────────────────  (separator)
   *     model · effort · cwd        (status bar)
   *
   * Muse draws inline, so until the transcript fills the window tmux pads the
   * capture with blank rows BELOW the status bar (live muse 1.4.0 at 120x36,
   * 2026-09-28: six of them). Counting those as "bottom rows" pushed the prompt
   * out of the old fixed 8-row window, so a freshly restarted, idle muse could
   * never prove it was idle and stayed `working` until the transcript grew
   * (#958). The proof is therefore anchored to the last non-blank rows: the
   * live input box must END the capture, which also means a `❯ / ───` pair
   * sitting in scrollback can never qualify.
   *
   * Per the CliBackend contract, this method must be a strong structural proof:
   * false positives can retire Cancel and admit a new delivery into a busy CLI.
   * A working pane shows `◇ Thinking (2s · esc to interrupt)` in the rows
   * immediately above the top separator; checking those rows with getBusyPattern()
   * returns false for working panes, matching the codex implementation's approach.
   *
   * Note: `canProvePeriodicIdle` in the daemon is set by the *presence* of this
   * method (`!!this.backend?.isPeriodicRedrawIdlePane`), not its return value —
   * so returning false for working panes only resets the confirmation count and
   * keeps it working; it does not disable the periodic-idle path.
   */
  isPeriodicRedrawIdlePane(pane: string): boolean {
    const rows = pane.replace(/\r/g, "").split("\n");
    while (rows.length && !stripSgr(rows[rows.length - 1]!).trim()) rows.pop();
    return museFreeComposerLayout(rows, this.getBusyPattern());
  }

  getErrorPatterns(): ErrorPattern[] {
    // NOTE: an Escape-interrupted run prints "interrupting run" in the status
    // bar. That is normal user-initiated behaviour, not an error — nothing here
    // matches it, and nothing that does should be added.
    return [
      { pattern: /rate.?limit|too many requests|\b429\b/i, type: "rate_limit", action: "failover", message: "Muse rate limit reached" },
      // Muse's own sign-in failures, and only as muse prints them (#1042). The
      // scan reads the whole pane, transcript included, so a fragment such as
      // `401`, "unauthorized", "Not logged in" or "run `muse login`" also
      // matches a diff row (muse numbers them: editing line 401 paused the
      // instance and /quit it mid-task) or the conversation. Muse has no
      // token-free auth check to overrule a false hit. So: whole muse
      // sentences (1.4.1 binary; the API-key one observed live), on a row that
      // is not one of the transcript's own: ❯ user, ◆ assistant, or a numbered
      // diff row (`401 +`, `582 -`, `25  ` context) — an edit to a file that
      // holds these sentences, this one included, shows them there.
      {
        pattern: new RegExp("^(?![ \\t]*(?:[❯◆]|\\d+ [+\\- ]))[^\\n]*(?:"
          + "still unauthorized after a token refresh; run `muse login` again"
          + "|your saved login is no longer valid\\. Log in again or use a different account"
          + "|your API key from META_API_KEY was rejected"
          + "|Not logged in\\. Run \\S+(?: \\S+)? again to log in"
          + "|Not logged in\\W+run /login to get started"
          + ")", "m"),
        type: "auth_error", action: "pause", message: "Muse authentication error",
      },
      { pattern: /quota|usage limit|out of credits/i, type: "quota", action: "notify", message: "Muse quota exhausted" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      // Workspace trust. `--trust-workspace` normally prevents this from ever
      // appearing; it is still handled because an instance configured with
      // skip_permissions: false gets neither flag and would otherwise hang
      // here forever. Verified layout: a two-row menu, option 1 preselected,
      // "Use Up/Down or 1/2, then Enter."
      {
        pattern: /Do you trust this workspace\?/,
        keys: ["1", "Enter"],
        description: "Muse workspace trust — choose 'Trust and continue'",
      },
      // Login is BLOCKING and cannot be auto-dismissed — the user has to
      // complete it. Empty keys mean the daemon sends nothing but keeps
      // treating the screen as not-ready, so a login page is never mistaken
      // for the idle prompt.
      {
        pattern: /muse login|Log in to (Meta|continue)|device code/i,
        keys: [],
        description: "Muse login — wait for the user to authenticate (no auto-dismiss)",
      },
      MUSE_LOGIN_MENU,
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      MUSE_LOGIN_MENU,
      // Net for a tool-approval prompt arriving despite --disable-approval (an
      // enterprise policy can pin approval on). Muse's menus are numbered with
      // the first option preselected, same shape as the trust dialog.
      {
        pattern: /Allow this (tool|command)|Approve this (tool|command)|1\s+(Allow|Approve)/i,
        keys: ["1", "Enter"],
        description: "Muse tool approval — allow",
      },
      {
        // #1715: never answered here. Enter would take the preselected allow
        // option, so the human must choose. The prompt replaces the input
        // box (no draft to clear, unlike #829); deliveries simply hold.
        pattern: MUSE_APPROVAL_PROMPT,
        isActive: museApprovalPromptActive,
        requestIdentity: museApprovalRequestIdentity,
        interactionKind: "permission",
        keys: [],
        holdOnly: true,
        blocksDelivery: true,
        inputBlocked: true,
        description: "Muse approval prompt — waiting for a human choice, never auto-approving",
      },
      {
        // #1716: never answered here. A delivery's Enter would pick
        // "Exit anyway"; the stop flow cancels it (Escape, then SIGTERM).
        pattern: MUSE_LOCAL_WORK_QUIT,
        isActive: museLocalWorkQuitActive,
        keys: [],
        holdOnly: true,
        blocksDelivery: true,
        inputBlocked: true,
        description: "Muse \"Local work is still active\" quit menu — holding, never answering with Enter",
      },
    ];
  }

  getContextUsage(): number | null {
    // Muse reports context only inside `/status` ("98% left · 23.8K used /
    // 1008K"), not on the persistent status bar, so there is nothing a passive
    // reader can see between turns. Returning a stale or invented number would
    // be worse than none.
    return null;
  }

  // Muse usage is collected by the daemon-owned localhost relay in
  // muse-usage-relay.ts.  Keeping this backend free of direct Meta requests is
  // deliberate: the relay observes only response.subscription_usage frames and
  // the model conversation remains byte-for-byte transparent.

  getSessionId(): string | null {
    // Sessions live at ~/.local/share/muse/sessions/<YYYY>/<MM>/<DD>/<uuid>/,
    // filed by date rather than by workspace, so the workspace has to be read
    // out of each session's own log (`route_facts` names the cwd near the top).
    // Returns the most recently ACTIVE session started in this instance's
    // directory, which is what the daemon persists for resume.
    if (!this.workingDirectory) return null;
    try {
      const root = join(homedir(), ".local", "share", "muse", "sessions");
      let newestId: string | null = null;
      let newestMtime = -1;
      for (const sessionDir of museSessionDirs(root)) {
        const name = sessionDir.slice(sessionDir.lastIndexOf("/") + 1);
        if (!SESSION_ID_RE.test(name)) continue;
        const head = readFileHeadSync(join(sessionDir, "session.jsonl"), SESSION_HEAD_CHARS);
        if (head === null) continue;
        if (museSessionCwd(head) !== this.workingDirectory) continue;
        // Activity = latest inner-file mtime. The directory's own mtime does not
        // move when a log is appended, and is misleadingly recent for a session
        // that was only just created — it must not outrank a resumed older
        // session whose log was written to seconds ago.
        let activity = -1;
        try {
          for (const f of readdirSync(sessionDir)) {
            try { const m = statSync(join(sessionDir, f)).mtimeMs; if (m > activity) activity = m; } catch { /* skip */ }
          }
        } catch { /* unreadable */ }
        if (activity > newestMtime) { newestMtime = activity; newestId = name; }
      }
      return newestId;
    } catch { return null; }
  }

  // `/quit` is muse's own "quit when idle". The key chord is Ctrl+C pressed
  // TWICE ("Press Ctrl-C again to quit") — kept as the fallback, with the count
  // the TUI actually requires.
  getQuitCommand(): string | null { return "/quit"; }
  getQuitKey(): string { return "C-c"; }
  getQuitKeyPresses(): number { return 2; }

  /** #1716: `/quit` with a background task running stops at the "Local work is still active" menu. */
  quitBlockedByDialog(pane: string): boolean {
    return museLocalWorkQuitActive(pane);
  }

  /**
   * #1717: the terminals panel with a `running` task — the pause flow defers
   * an idle pause while this holds, so an AgEnD-initiated silent pause never
   * kills the user's running background work. Explicit stop/restart still
   * proceed via quitBlockedByDialog above.
   */
  backgroundWorkRunning(pane: string): boolean {
    return museBackgroundWorkActive(pane);
  }

  getCompactCommand(): string { return "/compact"; }
  getClearCommand(): string | null { return "/clear"; }

  /**
   * Escape, not Ctrl+C. Verified both ways on a live session: Escape mid-run
   * stops the run, removes the interrupted turn from the transcript and puts
   * that prompt's text back into the input box (muse 1.4.2, 2026-10-05: in the
   * same frame the busy line goes away), while Ctrl+C armed the quit
   * confirmation ("Press Ctrl-C again to quit"). Cancelling with C-c would
   * leave every instance one stray keypress from exiting. The restored text is
   * cleared before the next delivery (#829): see inputDraft.
   */
  getCancelKey(): string { return "Escape"; }

  /**
   * #1217: muse 1.4.2 on `resume <id>` for a session it does not have (verified
   * live on a private socket): `retained session not found: session <id> has
   * no saved log`, then exit 1.
   */
  resumeMissingPattern(): RegExp {
    return /retained session not found: session \S+ has no saved log/;
  }

  /**
   * Production wires the daemon logger; tests inject a spy. Passing nothing
   * clears this backend's hook. "Once" is per unique (text, sgr) on this
   * backend so pane polls do not flood, and another Muse instance cannot
   * steal the logger or reset the once-set.
   */
  setPlaceholderDebug(log?: (rec: MusePlaceholderDebugRec) => void): void {
    if (!log) {
      this.placeholderDebug = undefined;
      return;
    }
    this.placeholderDebug = { log, logged: this.placeholderDebug?.logged ?? new Set() };
  }

  /** The live input box (#829): no rows when empty, null when the bottom of the screen is not muse's layout. */
  inputDraft(pane: string): InputDraft | null {
    return museInputBox(pane, this.getBusyPattern(), this.placeholderDebug);
  }

  inputDraftShows(draft: InputDraft, text: string): boolean {
    return museDraftShows(draft.rows, draft.width, text);
  }

  /**
   * One line per round, from either end (live, muse 1.4.2 keymap: ctrl+u is
   * delete-start, ctrl+k delete-end): the cursor's line is emptied — all of
   * its rows when it wraps — then joined to the line before it (Backspace) or
   * pulls up the line after it (Delete). Verified on a live four-line draft
   * with the cursor at its end and at its start, on wrapped lines, and on a
   * collapsed `[Pasted Content N chars]` row; extra rounds on an empty box
   * change nothing. Never C-c: that arms muse's quit.
   */
  getClearInputKeys(): readonly string[] { return ["C-u", "C-k", "BSpace", "DC"]; }

  // `/effort` is in the TUI command list, so a level change needs no restart.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return EFFORT_CAPABILITIES["muse"].strategy; }
  // muse also accepts none|minimal|ultra, which AgEnD has no level for; the
  // canonical five map straight through.
  getEffortLevels(): string[] { return [...EFFORT_CAPABILITIES["muse"].levels]; }

  // `/model` opens an arrow-key picker, not a one-shot command → restart.
  getModelSwitchStrategy(): "runtime" | "restart" { return "restart"; }

  async listModels(): Promise<ModelOption[]> {
    // muse has no models subcommand (the command table is: resume, exec,
    // config, export, trace, skills, plugins, sandbox, schema, serve,
    // session-message, mcp, auth, login, logout, init). The live `/model`
    // picker reads the provider catalog muse caches on disk (#1796), so this
    // reads the same files — bounded and best-effort, falling back to the
    // last known set when the cache is missing or unreadable.
    return readMuseModelCatalog();
  }

  async probeCLIEnv() {
    const { probeCliVersion } = await import("./types.js");
    // The selected model is the one thing muse persists where we can read it.
    let currentModel: string | undefined;
    try {
      const settings = JSON.parse(readFileSync(
        existsSync(this.settingsPath()) ? this.settingsPath() : this.sharedSettingsPath(),
        "utf-8",
      ));
      if (typeof settings.model === "string") currentModel = settings.model;
    } catch { /* best effort */ }
    return {
      version: probeCliVersion(this.binaryPath, {
        ...process.env,
        // The launcher checks for and may install updates on startup. A
        // diagnostic version probe should not trigger that updater.
        MUSE_UPDATE_INTERVAL_SECONDS: "31536000",
      }),
      models: await this.listModels(),
      currentModel,
    };
  }

  cleanup(config: CliBackendConfig): void {
    try {
      const settingsPath = this.settingsPath();
      const root = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (root.mcpServers) {
        for (const name of Object.keys(config.mcpServers)) {
          delete root.mcpServers[this.mcpKey(name, config.instanceName)];
        }
        writeFileSync(settingsPath, JSON.stringify(root, null, 2), { mode: 0o600 });
        chmodSync(settingsPath, 0o600);
      }
    } catch { /* best effort */ }

    try {
      removeMarker(join(config.workingDirectory, "AGENTS.md"), config.instanceName);
    } catch { /* best effort */ }
  }
}

/** Every `<year>/<month>/<day>/<uuid>` directory under the session store. */
export function museSessionDirs(root: string): string[] {
  const out: string[] = [];
  const children = (dir: string): string[] => {
    try { return readdirSync(dir); } catch { return []; }
  };
  for (const year of children(root)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of children(join(root, year))) {
      for (const day of children(join(root, year, month))) {
        for (const session of children(join(root, year, month, day))) {
          out.push(join(root, year, month, day, session));
        }
      }
    }
  }
  return out;
}
