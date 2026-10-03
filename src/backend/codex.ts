import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type InputUnavailableTransient, type McpServerEntry, type ModelOption, type RuntimeDialog, type StartupDialog, probeCliVersion, resolveBinary, shellQuote, validateModel, validateProvider, warnIfModelMismatch } from "./types.js";
import {
  credentialHomeSpec,
  credentialProfileHome,
  prepareCredentialProfileHome,
  resolveCredentialProfile,
} from "./credential-profile.js";
import { getAgendHome } from "../paths.js";
import { CODEX_MODELS_CACHE_MAX_BYTES, codexShortHomeFor, readCodexEffortLevels } from "./codex-metadata.js";
import { EFFORT_CAPABILITIES } from "./effort-metadata.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";
import { type CodexResumePlan, codexSiblingState, findExactCwdCodexSession, planCodexResume, newestMissedCwdRollout } from "./codex-session-lookup.js";
import { t } from "../locale.js";
import { parse as parseToml } from "smol-toml";

const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/;

/**
 * Whether a pane row is Codex's context footer. Kept when #913 was reverted:
 * #913 introduced it, but #914's pane/ready detection is built on it, and it
 * is pane parsing, not session handling.
 */
/** A status-line Context item, whole (`Context 46% left`) or truncated by a narrow pane (`Context 4…`, `Context …`). */
const CODEX_CONTEXT_ITEM = String.raw`Context[ \t]+(?:\d+%[ \t]+(?:left|used)|\d+…|…)`;
const CODEX_CONTEXT_STATUS_ITEMS = new Set(["context-remaining", "context-used", "context-usage"]);

function isCodexContextFooter(row: string): boolean {
  const context = String.raw`Context\s+\d+%\s+(?:left|used)`;
  const legacy = new RegExp(String.raw`^\s*${context}(?:\s+⚠\s+\d+\s+warnings?\b[^\r\n]*)?(?:\s+·\s+\S[^\r\n]*)?\s*$`, "i");
  if (legacy.test(row)) return true;
  // A narrow Codex 0.156 pane may truncate the context item after the
  // authoritative first `session-id` item. Keep structural readiness while
  // /ctx honestly reports context unavailable from a truncated percentage.
  // A Context item that is NOT first (#978) is recognised by
  // CodexBackend.isConfiguredContextFooter(), against the configured items.
  return /^\s*[0-9a-f-]{36}\s+·\s+Context\b[^\r\n]*$/i.test(row);
}

const AGEND_MCP_CLEANUP_LOCK = ".agend-mcp-cleanup.lock";
const AGEND_MCP_CLEANUP_LOCK_STALE_MS = 30_000;
const SQLITE_SIDECAR_RE = /-(?:wal|shm|journal)$/;

/**
 * Remove AgEnD-owned MCP tables from a Codex TOML config without touching
 * unrelated user settings or third-party MCP servers. Track TOML multiline
 * strings so a line such as `[heading]` inside AGEND_DECISIONS cannot be
 * mistaken for the start of another table.
 */
function stripAgendMcpTables(content: string): string {
  const lines = content.split(/(?<=\n)/);
  let skipping = false;
  let multiline: `"""` | `'''` | null = null;
  let removed = false;
  const kept: string[] = [];

  for (const line of lines) {
    if (!multiline) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/);
      if (header) {
        const path = header[1].trim();
        skipping = /^mcp_servers\.(?:"|')?agend(?:-|(?=["'.]|$))/i.test(path);
        if (skipping) removed = true;
      }
    }

    if (!skipping) kept.push(line);

    // TOML multiline basic/literal strings may contain table-looking lines.
    // Count unescaped delimiters and toggle only on an odd number.
    for (const delimiter of ['"""', "'''"] as const) {
      if (multiline && multiline !== delimiter) continue;
      let count = 0;
      let pos = 0;
      while ((pos = line.indexOf(delimiter, pos)) !== -1) {
        if (delimiter === "'''" || pos === 0 || line[pos - 1] !== "\\") count++;
        pos += delimiter.length;
      }
      if (count % 2 === 1) multiline = multiline === delimiter ? null : delimiter;
    }
  }

  // Avoid rewriting a clean user config merely to normalize whitespace.
  return removed ? kept.join("") : content;
}

function tomlString(value: string): string {
  // JSON strings are valid TOML basic strings for the values AgEnD emits.
  return JSON.stringify(value);
}

/** Codex 0.156 trusts a linked worktree's common repository root, not its CWD. */
function codexTrustPaths(workingDirectory: string): { cwd: string; root: string } {
  const cwd = realpathSync(resolve(workingDirectory));
  try {
    const commonDir = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf-8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const canonicalCommonDir = realpathSync(commonDir);
    if (basename(canonicalCommonDir) === ".git") return { cwd, root: dirname(canonicalCommonDir) };
    // Submodules keep their common dir in another repository's .git/modules.
    const topLevel = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { cwd, root: realpathSync(topLevel) };
  } catch {
    // A non-Git folder is its own Codex trust root.
    return { cwd, root: cwd };
  }
}

function tomlTable(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
    ? value as Record<string, unknown> : null;
}

/**
 * Set one boolean inside a TOML table while leaving unrelated config text
 * intact. Existing tables keep their layout; when the table isn't declared,
 * use the equivalent dotted key in the root table. Table headers embedded in
 * multiline strings are ignored.
 */
function setTomlTableBoolean(content: string, table: string, key: string): string {
  const lines = content.split(/(?<=\n)/);
  let multiline: `"""` | `'''` | null = null;
  const headers: Array<{ index: number; name: string; isArray: boolean }> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!multiline) {
      const header = line.match(/^\s*(?:\[([^\[\]]+)\]|\[\[([^\[\]]+)\]\])\s*(?:#.*)?(?:\r?\n)?$/);
      if (header) headers.push({ index, name: (header[1] ?? header[2]).trim(), isArray: header[2] !== undefined });
    }
    for (const delimiter of ['"""', "'''"] as const) {
      if (multiline && multiline !== delimiter) continue;
      let count = 0;
      let pos = 0;
      while ((pos = line.indexOf(delimiter, pos)) !== -1) {
        if (delimiter === "'''" || pos === 0 || line[pos - 1] !== "\\") count++;
        pos += delimiter.length;
      }
      if (count % 2 === 1) multiline = multiline === delimiter ? null : delimiter;
    }
  }

  const assignment = new RegExp(`^(\\s*${key}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)(\\r?\\n?)$`);
  const tableIndex = headers.findIndex(header => header.name === table && !header.isArray);
  if (tableIndex >= 0) {
    const start = headers[tableIndex].index + 1;
    const end = headers[tableIndex + 1]?.index ?? lines.length;
    for (let index = start; index < end; index++) {
      const existing = lines[index].match(assignment);
      if (existing) {
        lines[index] = `${existing[1]}true${existing[2]}${existing[3]}`;
        return lines.join("");
      }
    }
    if (end > 0 && !lines[end - 1].endsWith("\n")) lines[end - 1] += "\n";
    lines.splice(end, 0, `${key} = true\n`);
    return lines.join("");
  }

  // Inline tables cannot be extended with dotted keys, so update the simple
  // root-level `notice = { ... }` form in place when it is present.
  const rootEnd = headers[0]?.index ?? lines.length;
  const dottedAssignment = new RegExp(`^(\\s*${table}\\s*\\.\\s*${key}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)(\\r?\\n?)$`);
  for (let index = 0; index < rootEnd; index++) {
    const existing = lines[index].match(dottedAssignment);
    if (existing) {
      lines[index] = `${existing[1]}true${existing[2]}${existing[3]}`;
      return lines.join("");
    }
    const inline = lines[index].match(new RegExp(`^(\\s*${table}\\s*=\\s*\\{)(.*)(\\})(\\s*(?:#.*)?)(\\r?\\n?)$`));
    if (inline) {
      const option = new RegExp(`(${key}\\s*=\\s*)(?:true|false)`);
      const body = option.test(inline[2])
        ? inline[2].replace(option, "$1true")
        : `${inline[2].trim().length > 0 ? `${inline[2]}, ` : inline[2]}${key} = true`;
      lines[index] = `${inline[1]}${body}${inline[3]}${inline[4]}${inline[5]}`;
      return lines.join("");
    }
  }

  // A dotted assignment is valid in the root table and can extend an implicit
  // parent table created by `[notice.child]` without duplicating `[notice]`.
  const line = `${table}.${key} = true\n`;
  if (rootEnd === 0) lines.unshift(line);
  else if (lines[rootEnd - 1].endsWith("\n")) lines.splice(rootEnd, 0, line);
  else {
    lines[rootEnd - 1] += "\n";
    lines.splice(rootEnd, 0, line);
  }
  return lines.join("");
}

const CODEX_CONTEXT_STATUS_ITEM_RE = /^context-(?:remaining|usage|used)$/;

/** The TUI's effective status_line items: null when unset, "invalid" when unusable. */
function effectiveTuiStatusLine(content: string): string[] | null | "invalid" {
  try {
    const items = tomlTable(tomlTable(parseToml(content))?.tui)?.status_line;
    if (items === undefined) return null;
    return Array.isArray(items) && items.every(item => typeof item === "string") ? items as string[] : "invalid";
  } catch {
    return "invalid";
  }
}

function projectTrustTable(config: unknown, root: string): Record<string, unknown> | null {
  const projects = tomlTable(tomlTable(config)?.projects);
  return projects ? tomlTable(projects[root]) : null;
}

function effectiveProjectTrust(content: string, root: string): unknown {
  return projectTrustTable(parseToml(content), root)?.trust_level;
}

/** Change only the private project's trust value; parse before and after editing. */
function setProjectTrusted(content: string, root: string): string {
  const section = `[projects.${tomlString(root)}]`;
  const parsed = parseToml(content);
  if (projectTrustTable(parsed, root)?.trust_level === "trusted") return content;
  const lines = content.split("\n");
  const tableRows: number[] = [];
  let multiline: `"""` | `'''` | null = null;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (!multiline && /^\s*\[.*\]\s*(?:#.*)?$/.test(line)) tableRows.push(row);
    // A multiline config value can quote an entire pane/config. Treat a
    // project-looking row inside it as data, never as effective TOML.
    for (const delimiter of ['"""', "'''"] as const) {
      if (multiline && multiline !== delimiter) continue;
      let count = 0;
      let pos = 0;
      while ((pos = line.indexOf(delimiter, pos)) !== -1) {
        if (delimiter === "'''" || pos === 0 || line[pos - 1] !== "\\") count++;
        pos += delimiter.length;
      }
      if (count % 2 === 1) multiline = multiline === delimiter ? null : delimiter;
    }
  }
  const headers = tableRows.filter(row => {
    // TOML permits whitespace around dots and quoted/literal table keys.
    // Parse each real header instead of comparing its raw spelling.
    try {
      return projectTrustTable(parseToml(`${lines[row]}\n__agend_trust_probe__ = true\n`), root)?.__agend_trust_probe__ === true;
    } catch { return false; }
  });
  if (headers.length > 1) throw new Error("Duplicate Codex trust project table");
  if (headers.length === 0 && projectTrustTable(parsed, root)) {
    throw new Error("Cannot safely edit Codex trust project table");
  }

  let updated: string;
  if (headers.length === 0) {
    updated = `${content.trimEnd()}\n\n${section}\ntrust_level = "trusted"\n`;
  } else {
    const header = headers[0];
    const end = tableRows.find(row => row > header) ?? lines.length;
    const trustRows: number[] = [];
    for (let row = header + 1; row < end; row++) {
      if (/^\s*(?:trust_level|"trust_level"|'trust_level')\s*=/.test(lines[row])) trustRows.push(row);
    }
    if (trustRows.length > 1) throw new Error("Duplicate Codex trust_level key");
    if (trustRows.length === 1) lines[trustRows[0]] = 'trust_level = "trusted"';
    else lines.splice(header + 1, 0, 'trust_level = "trusted"');
    updated = lines.join("\n");
  }

  // Candidate validation is before atomic write. A spelling the narrow text
  // editor cannot handle must fail closed, never leave Codex with invalid TOML.
  if (effectiveProjectTrust(updated, root) !== "trusted") throw new Error("Codex project trust is not effective");
  return updated;
}

type CodexTrustPrompt = {
  active: boolean;
  folder: string | null;
  root: string | null;
  rootNote: "absent" | "parsed" | "invalid";
  safeChoice: boolean;
};

/** Only the bottom, live Codex 0.156 folder-access screen can own stdin. */
function codexTrustPromptState(pane: string): CodexTrustPrompt {
  const noPrompt: CodexTrustPrompt = { active: false, folder: null, root: null, rootNote: "absent", safeChoice: false };
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0) return noPrompt;
  let access = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (/^\s{0,2}Folder access\s*$/.test(rows[index])) { access = index; break; }
  }
  if (access < 0 || last - access > 60) return noPrompt;
  const question = rows.findIndex((row, index) => index > access && /^\s{0,2}Trust this folder\?/.test(row));
  if (question < 0 || question >= last) return noPrompt;
  // A ready input row or transcript continuation below the question means the
  // trust dialog is history, not the current interactive region.
  if (rows.slice(question + 1, last + 1).some(row => /^\s*[›❯>]\s*(?!\d+\.)\S/.test(row))) return noPrompt;

  const noteRows = rows.slice(access + 1, question);
  // The folder must be the first content row after the title. Do not let a
  // later repository-root path stand in for a missing folder path.
  const folderRow = noteRows.find(row => row.trim() !== "");
  const folder = folderRow && /^\s{0,2}\//.test(folderRow) ? folderRow.trim() : null;
  const hasRootNote = noteRows.some(row => /\bNote:|\brepository root\b|Trusting will apply/i.test(row));
  const rootLabel = noteRows.findIndex(row => /\brepository root:/i.test(row));
  const inlineRoot = rootLabel < 0 ? "" : noteRows[rootLabel].split(/\brepository root:/i)[1]?.trim() ?? "";
  const followingRoot = rootLabel < 0 ? "" : noteRows.slice(rootLabel + 1).find(row => row.trim() !== "")?.trim() ?? "";
  const candidateRoot = inlineRoot || followingRoot;
  const root = candidateRoot.startsWith("/") ? candidateRoot : null;
  const rootNote = !hasRootNote ? "absent" : root ? "parsed" : "invalid";
  const choices = rows.slice(question + 1, last + 1).flatMap((row, offset) => {
    const match = row.match(/^\s*([›❯>]?)\s*(\d+)\.\s+(.+?)\s*$/);
    return match ? [{ row: question + 1 + offset, cursor: match[1], number: match[2], text: match[3] }] : [];
  });
  // Unknown option orders, a moved cursor, a third option, or any different
  // footer are held for a human. Never guess where Enter would land.
  const safeChoice = choices.length === 2
    && choices[0].row + 1 === choices[1].row
    && rows.slice(choices[1].row + 1, last).every(row => row.trim() === "")
    && choices[0].cursor === "›" && choices[0].number === "1" && choices[0].text === "Trust and continue"
    && choices[1].cursor === "" && choices[1].number === "2" && choices[1].text === "Quit"
    && /^\s*enter continue\s*·\s*esc quit\s*$/i.test(rows[last]);
  return { active: true, folder, root, rootNote, safeChoice };
}

/** Unknown/older trust layouts are still input-blocking, never auto-answered. */
function codexTrustVariantActive(pane: string): boolean {
  if (codexTrustPromptState(pane).active) return true;
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0) return false;
  const start = Math.max(0, last - 22);
  const folderAccess = rows.findIndex((row, index) => index >= start && /^\s{0,2}Folder access\s*$/.test(row));
  if (folderAccess >= 0) {
    const tail = rows.slice(folderAccess + 1, last + 1);
    if (!tail.some(row => /^\s*[›❯>]\s*(?!\d+\.)\S/.test(row))
      && tail.some(row => /^\s*[›❯>]?\s*\d+\.\s+(?:Open restricted|Trust and continue|Quit)\s*$/i.test(row))
      && /(?:enter|esc|quit|cancel)/i.test(rows[last])) return true;
  }
  const question = rows.findIndex((row, index) => index >= start
    && /^\s*(?:Trust this folder\?|Do you trust the files in this folder\?)/i.test(row));
  if (question < 0 || question >= last) return false;
  const tail = rows.slice(question + 1, last + 1);
  // A normal input row after a quoted menu makes it history, not live UI.
  if (tail.some(row => /^\s*[›❯>]\s*(?!\d+\.)\S/.test(row))) return false;
  return tail.some(row => /^\s*[›❯>]?\s*\d+\.\s+\S/.test(row))
    && (/(?:enter|esc|quit|cancel)/i.test(rows[last])
      || /^\s*[›❯>]?\s*\d+\.\s+\S/.test(rows[last]));
}

/**
 * Structural helpers for the codex usage-limit selection menu (#945).
 *
 * The real codex 0.156.1 dialog (captured live) states that codex has
 * ALREADY switched to Luna Reserve and offers:
 *
 *   • Automatically switched to Luna Reserve xhigh due to usage limits.
 *     You're now using Luna, a faster model for simpler tasks.
 *     Use your reset to continue using the most advanced models, or
 *     wait for usage to reset after 08:00 on 27 Sep.
 *   › 1. Reset usage
 *     2. Add Credits
 *     3. Continue with Luna Reserve
 *     Press enter to confirm or esc to continue working
 *
 * The SAFE key is **Escape** ("esc to continue working"), which dismisses
 * the dialog and keeps the already-active Luna Reserve session. Escape is
 * sent via sendSpecialKey, NEVER via pasteText (which would add an implicit
 * Enter that could confirm option 1 = Reset usage).
 *
 * Design:  keys: ["Escape"]  + verifyAfterKeys: true (menu must vanish).
 * No confirmBeforeEnter / keysAfterConfirm needed: Escape cannot select any
 * numbered option — it is handled by sendSpecialKey, never by paste+Enter.
 */

/** MUST match the exact hint row text to prevent false positives. */
const USAGE_LIMIT_ESC_HINT = /^\s*Press enter to confirm or esc to continue working\s*$/i;
/** Option-set that appears in this specific menu (exact wording). */
const USAGE_LIMIT_OPT1 = /^\s*[›❯>]?\s*1\.\s+Reset usage\b/i;
const USAGE_LIMIT_OPT3 = /^\s*[›❯>]?\s*3\.\s+Continue with Luna Reserve\b/i;

/**
 * True when the usage-limit selection menu is the **current** interactive
 * region of the pane (not a historical transcript copy).
 *
 * Structural requirements (all must hold):
 *   - Hint row "Press enter to confirm or esc to continue working"
 *   - Options 1 and 3 present in the bottom region (with exact text)
 *   - NOT followed by the Codex idle compositor (Context footer / Ask Codex row)
 */
function codexUsageLimitMenuVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0) return false;

  // The hint row "Press enter to confirm or esc to continue working" must be last.
  if (!USAGE_LIMIT_ESC_HINT.test(rows[last])) return false;

  // The three options must appear in the bottom region (within 10 rows of hint).
  const region = rows.slice(Math.max(0, last - 10), last);
  const hasOpt1 = region.some(r => USAGE_LIMIT_OPT1.test(r));
  const hasOpt3 = region.some(r => USAGE_LIMIT_OPT3.test(r));
  if (!hasOpt1 || !hasOpt3) return false;

  // Guard: if the Codex compositor (idle prompt + Context footer) is at the
  // bottom, this is scrollback, not the live menu.
  const tail = region.join("\n");
  if (/[›>]\s*Ask Codex to do anything\b/i.test(tail)) return false;
  if (isCodexContextFooter(rows[last])) return false;

  return true;
}

/** Rate-switch prompts are economic choices, not a fixed keyboard position. */
function codexRateSwitchVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  let title = -1;
  for (let i = last; i >= Math.max(0, last - 18); i--) {
    if (/^\s*(?:Approaching rate limits|Switch to .{1,120} for lower credit usage\?)\s*$/i.test(rows[i])) {
      title = i;
      break;
    }
  }
  if (title < 0) return false;
  const tail = rows.slice(title + 1, last + 1);
  // A copied picker in transcript history is not the currently active menu.
  if (tail.some(row => /^[›>]\s+Ask Codex to do anything\b/.test(row) || isCodexContextFooter(row))) return false;
  return tail.some(row => /^\s*[›❯>]?\s*\d+\.\s*(?:Switch to|Keep current model)\b/i.test(row));
}

/**
 * The exact "Approaching rate limits" picker, as codex 0.157.1 and 0.159.2 both
 * paint it (captured live, tests/fixtures/codex-0157-rate-limit-picker.pane.txt):
 *
 *   Approaching rate limits
 *   Switch to gpt-6-luna for lower credit usage?
 *
 * › 1. Switch to gpt-6-luna                   Fast and affordable model for easier tasks.
 *   2. Keep current model
 *   3. Keep current model (never show again)  Hide future rate limit reminders about switching models
 *
 *   enter select · esc back
 *
 * The cursor starts on 1 = SWITCH, so an Enter (or a delivery's paste+Enter)
 * changes the user's model. Escape selects nothing: it closes the picker, the
 * model stays, and the picker does not come back while usage stays high (live,
 * both versions). Anything that is not exactly this shape — reworded footer,
 * options reordered, a different count — is NOT matched here and stays with the
 * hold-only rate-switch entry, which never presses a key.
 *
 * Bottom-anchored: the hint row must be the last row, the three options directly
 * above it (their wrapped description rows may sit between them), the subtitle
 * and title directly above those. A quote of the picker in the transcript is
 * followed by the composer and never matches.
 */
function codexRateSwitchPickerVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n").filter(row => row.trim() !== "");
  // Narrow panes wrap the option descriptions (#1100, the 80x24 AgEnD legacy
  // size: `Fast and affordable model for easier` / `tasks.`). The wrapped rest
  // sits under the description column, indented far past the option markers and
  // carrying none of its own. Only that is tolerated, and only around the
  // options; everything else keeps the exact shape. A row of free text indented
  // that far is a continuation too, which is why the options themselves,
  // the title, the subtitle and the footer are still matched row by row.
  const wrapped = (row: string) => /^[ \t]{6,}\S/.test(row) && !/^\s*[›❯>]?\s*\d+\./.test(row);
  const MAX_WRAPPED = 3;
  let i = rows.length - 1;
  const take = (shape: RegExp, allowWrapped: boolean): boolean => {
    if (allowWrapped) {
      let skipped = 0;
      while (i >= 0 && wrapped(rows[i]) && skipped < MAX_WRAPPED) { i--; skipped++; }
    }
    if (i < 0 || !shape.test(rows[i])) return false;
    i--;
    return true;
  };
  return take(/^\s*enter select\s*[·•]\s*esc back\s*$/i, false)
    && take(/^\s*[›>]?\s*3\.\s+Keep current model \(never show again\)(?:\s{2,}\S.*)?$/, true)
    && take(/^\s*[›>]?\s*2\.\s+Keep current model\s*$/, true)
    && take(/^\s*[›>]?\s*1\.\s+Switch to \S.*$/, true)
    && take(/^\s*Switch to \S.{0,120} for lower credit usage\?\s*$/, false)
    && take(/^\s*Approaching rate limits\s*$/, false);
}

/** Unknown pickers own stdin too; never type or press Enter into one. */
function codexUnknownSelectionVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0 || !(/\benter\b.*\besc\b/i.test(rows[last])
    || /^\s*Press enter to continue\s*$/i.test(rows[last]))) return false;
  let selected = -1;
  for (let i = last - 1; i >= Math.max(0, last - 24); i--) {
    if (/^\s*[›❯>]\s+\S/.test(rows[i])) { selected = i; break; }
  }
  if (selected < 0) return false;
  if (/^\s*[›❯>]\s+Ask Codex to do anything\b/.test(rows[selected])) return false;
  return !rows.slice(selected + 1, last + 1).some(row =>
    /^[›>]\s+Ask Codex to do anything\b/.test(row) || isCodexContextFooter(row));
}

/**
 * #1099: the Codex TUI lost its app-server. The composer is still painted (empty,
 * or holding the user's draft) but nothing is listening behind it, so a paste
 * only piles up in the input row. Captured from the real binary
 * (0.159.2 / 0.160.0), stage by stage as the app-server stays dead:
 *
 *   ■ Connection lost. Attempting to reconnect…           (0.159.2 only)
 *   • Reconnecting to app-server… (8s)                    (0.159.2)
 *   • Reconnecting to server… (1m 12s)                    (0.160.0; the counter keeps running)
 *   ■ Automatic reconnect could not restore this session. Your draft is still editable. …
 *   ■ Server connection could not be restored
 *   • Reconnect failed — check the endpoint, then relaunch (2m 24s)    (it never recovers)
 *
 * The footer is `ctrl+c quit` with no Context item, which is also why the #978
 * escape hatch ("empty live composer, nothing busy") read this pane as idle.
 *
 * The status row is the live one only when it is the last transcript item above
 * the composer: after it come blank rows, then the composer, then footer rows —
 * and no further `•`/`■` transcript item. A quotation of the text in an answer
 * is followed by more of that answer or by Codex's own `Worked for …` line.
 */
const CODEX_DISCONNECT_ROW = new RegExp(
  String.raw`^[ \t]*•[ \t]+(?:Reconnecting to (?:app-)?server(?:…|\.\.\.)|Reconnect failed[ \t]+—[ \t]+check the endpoint, then relaunch)[ \t]+\(\d+[hms](?:[ \t]+\d+[hms])*\)[ \t]*$`,
  "u",
);
export function codexAppServerDisconnected(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  let composer = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 12); i--) {
    if (/^[›>]/.test(rows[i])) { composer = i; break; }
  }
  if (composer < 0) return false;
  // Nothing after the composer but its draft's continuation rows and the footer.
  if (rows.slice(composer + 1).some(row => /^[•■⚠]/.test(row))) return false;
  let status = composer - 1;
  while (status >= 0 && rows[status].trim() === "") status--;
  return status >= 0 && CODEX_DISCONNECT_ROW.test(rows[status]);
}

/**
 * #984: Codex (0.156+) parks a resumed session behind this screen while
 * another process holds the session's thread-writer lock. Both keys are unsafe
 * to automate: `r` spins while the other writer lives, and `f` (0.157) forks
 * the other instance's conversation and cwd into this one. Match the complete
 * bottom block only, so a transcript that quotes the text cannot hold delivery.
 */
function codexSessionLockVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0 || !/^\s*r retry\s+(?:f fork\s+)?esc\/ctrl\+c\/q exit\b/.test(rows[last])) return false;
  for (let i = last - 1; i >= Math.max(0, last - 4); i--) {
    if (!/^\s*🔒\s+This conversation is open in another app\b/.test(rows[i])) continue;
    return /^\s*Close it there and press R to continue here\.\s*$/.test(rows[i + 1] ?? "")
      && rows.slice(i + 2, last).every(row => row.trim() === "");
  }
  return false;
}

/**
 * #984: in a git worktree, `codex resume --last` (0.157) can select a sibling
 * worktree's session and then ask which directory to run it in. Every choice
 * is wrong for an unattended instance: Escape and "session directory" move it
 * into the sibling's checkout, "current directory" silently continues the
 * sibling's conversation. Recognise the complete picker so it is held for a
 * human instead of being treated as ready or answered.
 */
function codexResumeCwdPickerVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0 || !/^\s*enter continue · esc use session · ctrl\+c quit\s*$/.test(rows[last])) return false;
  const header = rows.findIndex((row, i) => i >= Math.max(0, last - 16) && i < last
    && /^\s*Working directory · resume\s*$/.test(row));
  if (header < 0) return false;
  const block = rows.slice(header + 1, last);
  return block.some(row => /^\s*[›❯>]?\s*\d\.\s+Use session directory \(/.test(row))
    && block.some(row => /^\s*[›❯>]?\s*\d\.\s+Use current directory \(/.test(row))
    && !block.some(row => /^[›>]\s+Ask Codex to do anything\b/.test(row) || isCodexContextFooter(row));
}

/** Only the complete, current Codex installer picker may receive Escape. */
function codexUpdatePickerVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0 || !/^\s*Press enter to continue\s*$/.test(rows[last])) return false;
  for (let first = last - 3; first >= Math.max(0, last - 9); first--) {
    if (!/^\s*[›❯>]\s+1\.\s+Update now\b/.test(rows[first])) continue;
    // At 80 columns Codex 0.153 wraps the installer command to the next row.
    // Permit a bounded continuation, but never another option or cursor.
    const second = rows.findIndex((row, index) => index > first && index <= first + 3
      && /^\s*2\.\s+Skip\s*$/.test(row));
    if (second < 0 || !rows.slice(first + 1, second).every(row =>
      /^\s+\S/.test(row) && !/^\s*[›❯>]?\s*\d+\./.test(row))
      || !/^\s*3\.\s+Skip until next version\s*$/.test(rows[second + 1] ?? "")
      || !rows.slice(second + 2, last).every(row => row.trim() === "")) continue;
    const intro = rows.slice(Math.max(0, first - 14), first);
    if (intro.some(row => /Update available!/.test(row))
      && intro.some(row => /^\s*Release notes: https:\/\/github\.com\/openai\/codex\/releases\/latest\s*$/.test(row))) return true;
  }
  return false;
}

function renderMcpServer(name: string, entry: McpServerEntry, instanceName: string): string {
  const mcpName = `${name}-${instanceName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const env = { ...entry.env, AGEND_INSTANCE_NAME: instanceName };
  const args = entry.args.map(tomlString).join(", ");
  const envLines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join("\n");
  return [
    `[mcp_servers.${mcpName}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${args}]`,
    "tool_timeout_sec = 90",
    "",
    `[mcp_servers.${mcpName}.env]`,
    envLines,
    "",
  ].join("\n");
}

function atomicWritePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
  } finally {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
  }
}

// Account-aware models_cache.json is preferred. These documented Codex models
// are only a last-resort menu when the TUI has not populated its cache yet.
/** The whole of a codex identity, and the only file a profile owns. */
const CODEX_AUTH_FILE = "auth.json";

/** Upper bound on `codex debug models`; it is one HTTPS round trip plus startup. */
const CODEX_CATALOG_REFRESH_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);

const CODEX_FALLBACK_MODELS: ModelOption[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "frontier agentic coding" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "balanced agentic coding" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: "fast, efficient agentic coding" },
];

/** A live Codex status row, whatever its title (#964); see getBusyPattern. */
const CODEX_LIVE_STATUS_ROW = /(?:^|\n)•[ \t]+\S[^\r\n]*?\((?:(?:\d+[hms][ \t]+)+[•·][ \t]+)?esc to interrupt\)(?:[ \t]+·[ \t][^\r\n]*)?[ \t]*(?=\r?\n|$)/i;

const CODEX_RUN_STATE_STATUS_ITEMS = new Set(["run-state", "status"]);
// Deliberately small allow-list of built-in Codex status_line values. These
// patterns identify positive rendered chrome; unknown/custom items fail closed.
const CODEX_STATUS_LINE_VALUE_PATTERNS: Readonly<Record<string, string>> = {
  model: String.raw`[\p{L}\p{N}][\p{L}\p{N}._:/+-]*`,
  "model-name": String.raw`[\p{L}\p{N}][\p{L}\p{N}._:/+-]*`,
  "model-with-reasoning": String.raw`[\p{L}\p{N}][\p{L}\p{N}._:/+-]*(?:[ \t]+(?:none|low|medium|high|xhigh|max|minimal|standard))?(?:[ \t]+(?:fast|flex|priority))?`,
  reasoning: String.raw`(?:none|low|medium|high|xhigh|max)`,
  "run-state": String.raw`Ready`,
  status: String.raw`Ready`,
  "current-dir": String.raw`(?:[/~.]|[A-Za-z]:[\\/])[^\r\n·]*`,
  "project-name": String.raw`[\p{L}\p{N}_.-]+`,
  project: String.raw`[\p{L}\p{N}_.-]+`,
  "project-root": String.raw`[\p{L}\p{N}_.-]+`,
  hostname: String.raw`[\p{L}\p{N}][\p{L}\p{N}.-]*`,
  "git-branch": String.raw`[\p{L}\p{N}_.\/-]+`,
  "pull-request-number": String.raw`PR[ \t]+#?\d+`,
  "branch-changes": String.raw`(?:No changes|\+\d+[ \t]+-\d+)`,
  "codex-version": String.raw`v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?`,
  "session-id": String.raw`[0-9a-f-]{36}`,
  "thread-id": String.raw`[0-9a-f-]{36}`,
  "context-window-size": String.raw`\d+(?:\.\d+)?[kKmM]?[ \t]+window`,
  "five-hour-limit": String.raw`5h[ \t]+\d+(?:\.\d+)?%(?:[ \t]+(?:left|used))?(?:[ \t]+@?[^\r\n·]+)?`,
  "weekly-limit": String.raw`weekly[ \t]+\d+(?:\.\d+)?%(?:[ \t]+(?:left|used))?(?:[ \t]+@?[^\r\n·]+)?`,
  "used-tokens": String.raw`\d+(?:\.\d+)?[kKmM]?[ \t]+(?:tokens?[ \t]+)?used`,
  "total-input-tokens": String.raw`\d+(?:\.\d+)?[kKmM]?[ \t]+in`,
  "total-output-tokens": String.raw`\d+(?:\.\d+)?[kKmM]?[ \t]+out`,
  "thread-credits": String.raw`\d+(?:\.\d+)?[ \t]+credits?`,
  "estimated-thread-cost": String.raw`[$€£][ \t]*\d+(?:[,.]\d+)?`,
  "fast-mode": String.raw`Fast[ \t]+(?:on|off)`,
  "raw-output": String.raw`Raw output`,
  "task-progress": String.raw`\d+[ \t]*/[ \t]*\d+`,
  // #978: Context items, whole or truncated. Codex keeps the configured item
  // order, so Context may be any segment of the footer.
  "context-remaining": CODEX_CONTEXT_ITEM,
  "context-used": CODEX_CONTEXT_ITEM,
  "context-usage": CODEX_CONTEXT_ITEM,
};

/**
 * Codex's resume-loading screen, during which the composer is drawn but input
 * is not yet live (0.154: paste works, Enter is swallowed). Two header layouts
 * are known; each check anchors on structural rows a transcript cannot fake.
 */
function codexBoxedResumeLoading(rows: string[]): boolean {
  // Anchor to the LAST real Codex header in the viewport.  User input and
  // transcript continuations are indented by the TUI, so an unindented
  // box row cannot be forged merely by discussing this screen — the same
  // self-triggering trap that made whole-pane auth/dialog regexes unsafe.
  let header = -1;
  for (let i = 0; i < rows.length; i++) {
    if (/^│ >_ OpenAI Codex \(v[^)]+\)\s*│\s*$/.test(rows[i])) header = i;
  }
  if (header < 1 || !/^╭─+╮\s*$/.test(rows[header - 1])) return false;

  const close = rows.findIndex((row, i) => i > header && i <= header + 8 && /^╰─+╯\s*$/.test(row));
  if (close < 0) return false;
  const loading = rows.slice(header + 1, close).some(row => /^│ model:\s+loading\b.*│\s*$/.test(row));
  if (!loading) return false;

  // In 0.154.0 this is a standalone status row immediately below the
  // loading card, followed by the apparent input row.  That input is only
  // visual at this phase: paste works, Enter is swallowed.
  const resume = rows.findIndex((row, i) => i > close && i <= close + 4 && /^\s{2}Resuming session…\s*$/.test(row));
  if (resume < 0) return false;
  return rows.slice(resume + 1).some(row => /^›(?:\s|$)/.test(row));
}

/**
 * codex 0.159 dropped the box: `  >_ OpenAI Codex (v…)`, then a short header
 * block (`     loading`, or the cwd plus `  permissions: …` once it paints),
 * then `  Resuming session…` over a live-looking `›` composer. The "loading"
 * row disappears after ~2 frames while "Resuming session…" stays for the whole
 * ~1 s load, so the status row — not the loading row — is what marks it.
 *
 * Anti-forgery: an assistant quoting this screen writes the same indented
 * rows, so the header must come before any transcript row (`›`/`•`), and the
 * composer must be the last thing on screen (a settled session has a footer
 * below it; the loading screen has none).
 */
function codexUnboxedResumeLoading(rows: string[]): boolean {
  const header = rows.findIndex(row => /^ {2}>_ OpenAI Codex \(v[^)]+\)\s*$/.test(row));
  if (header < 0) return false;
  if (rows.slice(0, header).some(row => /^[›>•]/.test(row))) return false;
  const resume = rows.findIndex((row, i) => i > header && i <= header + 4 && /^ {2}Resuming session…\s*$/.test(row));
  if (resume < 0) return false;
  // Only header-block rows between the header and the status row.
  if (rows.slice(header + 1, resume).some(row => row.trim() !== "" && !/^ {2,}\S/.test(row))) return false;
  const after = rows.slice(resume + 1).map(row => row.trimEnd());
  const composer = after.findIndex(row => row !== "");
  if (composer < 0 || composer > 2 || !/^›(?:\s|$)/.test(after[composer]!)) return false;
  return after.slice(composer + 1).every(row => row === "");
}

export class CodexBackend implements CliBackend {
  readonly binaryName = "codex";
  private binaryPath: string;
  private readonly sharedCodexHome: string;
  private readonly isolatedCodexHome: string;
  /** Which subscription this instance runs on, or null for the shared login. */
  private credentialProfile: string | null = null;
  /** Set only after preTrust wrote and read back this instance's private config. */
  private authorizedTrust: { cwd: string; root: string } | null = null;
  private configuredStatusLineItems: string[] | null | undefined;
  private configuredStatusLinePattern: RegExp | null | undefined;
  /** Set by buildCommand when the resume plan fell back; read once by the daemon. */
  private launchWarning: string | null = null;
  /** Whether the last buildCommand launched a resume (`resume <id>` or `--last`). */
  private lastLaunchResumes = true;
  /** Set by writeConfig when the status_line could not be made verifiable (#931). */
  private statusLineWarning: string | null = null;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("codex");
    this.sharedCodexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    this.isolatedCodexHome = CodexBackend.resolveShortHome(instanceDir);
  }

  /**
   * Compute and (on first call for an existing instance) migrate to a SHORT
   * persistent CODEX_HOME under `~/.agend/cx/<8-char-hash>/`.
   *
   * Background (#953): codex 0.157.0 added `app-server-control.sock` under
   * CODEX_HOME. For instances with long `-t<topic_id>` suffixes the full path
   * exceeds the Unix socket SUN_LEN (~107 chars). codex canonicalises the path
   * before binding the socket, so a symlink workaround does not help — the real
   * path must be short.
   *
   * Migration steps (each is idempotent; half-completed states self-heal):
   *  1. If shortHome does not exist AND legacyHome is a real directory (not a
   *     symlink) → atomic renameSync. On EXDEV or any other error, fall back
   *     safely: keep using the legacy long path (instance can still start, just
   *     without the short-path fix).
   *  2. If shortHome exists but legacyHome is missing → recreate the backward-
   *     compat symlink (self-heal for rename-succeeded-but-symlink-failed crash).
   *  3. If both shortHome and legacyHome (as symlink) exist → nothing to do.
   *  4. New instance (no legacyHome) → create shortHome directly.
   *
   * Fail-safe guarantee: migration failure must never make the instance worse.
   * The caller always receives a valid path it can use as CODEX_HOME.
   */
  /** Exposed for fleet-manager to delete the short home on instance removal. */
  static shortHomeFor(instanceDir: string): string {
    return codexShortHomeFor(instanceDir);
  }

  private static resolveShortHome(instanceDir: string): string {
    const shortHome = CodexBackend.shortHomeFor(instanceDir);
    const shortBase = join(getAgendHome(), "cx");
    const canonical = resolve(instanceDir);
    const legacyHome = resolve(instanceDir, "codex-home");

    // Only migrate/create when the instance directory itself exists.
    // Constructing CodexBackend for a non-existent dir (cli-env probes, test
    // backends that never ran) must not litter ~/.agend/cx/ with orphan dirs.
    if (!existsSync(canonical)) return shortHome;

    const legacyExists = existsSync(legacyHome);
    const legacyIsRealDir = legacyExists && !lstatSync(legacyHome).isSymbolicLink();
    const shortExists = existsSync(shortHome);

    if (!shortExists) {
      mkdirSync(shortBase, { recursive: true });
      if (legacyIsRealDir) {
        // Attempt atomic rename. Requires same device; fails with EXDEV otherwise.
        try {
          renameSync(legacyHome, shortHome);
          // Log the one-time migration for observability.
          try {
            const logPath = join(shortBase, `${shortHome.split("/").at(-1)}.migrated`);
            writeFileSync(logPath, `${new Date().toISOString()} migrated from ${legacyHome}\n`);
          } catch { /* log failure is non-fatal */ }
        } catch (err) {
          // EXDEV (cross-device) or any other rename failure → fail-safe:
          // fall back to the legacy long path so the instance still works.
          // The socket-length bug persists for this instance but no data is lost.
          const code = (err as NodeJS.ErrnoException).code ?? "unknown";
          try {
            const warnPath = join(shortBase, `${shortHome.split("/").at(-1)}.migration-failed`);
            writeFileSync(warnPath,
              `${new Date().toISOString()} rename failed (${code}): ${(err as Error).message}\n`
              + `legacy path remains in use: ${legacyHome}\n`);
          } catch { /* warn log failure is also non-fatal */ }
          // Return legacy long path so the instance starts (socket may still fail
          // on 0.157.0 for long names, but no data is lost or corrupted).
          return legacyHome;
        }
      } else if (!legacyExists) {
        // New instance — no data to migrate.
        mkdirSync(shortHome, { recursive: true, mode: 0o700 });
      }
      // If legacyExists but is already a symlink: shortHome was deleted externally
      // while the symlink still points to it. Re-create shortHome as a fresh dir.
      if (!existsSync(shortHome)) {
        mkdirSync(shortHome, { recursive: true, mode: 0o700 });
      }
    }

    // Backward-compat symlink: instanceDir/codex-home → shortHome.
    // Also serves as self-heal: if a previous run renamed successfully but
    // crashed before creating the symlink, we recreate it here.
    if (!legacyExists || legacyIsRealDir) {
      // legacyIsRealDir means rename just happened (now shortHome exists, legacyHome gone).
      // !legacyExists means new instance or symlink was deleted — create it.
      try { symlinkSync(shortHome, legacyHome); } catch { /* race or already exists */ }
    }

    return shortHome;
  }

  supportsQueuedInput(): boolean {
    return true;
  }

  /**
   * Codex's input row, from live captures on codex-cli 0.153.4: `› Ask Codex to
   * do anything` when empty, `› <text>` once something is typed or pasted, and
   * the text wraps onto unprefixed continuation rows.
   *
   * NOT bottom-anchored, unlike Kiro's: `Context 63% left` is painted under it.
   * Codex also echoes each submitted message into
   * the transcript with the same `›` prefix, which is why every caller takes
   * the LAST matching row — the transcript echo is always above the input row.
   *
   * The marker alone is deliberately not treated as "ready to accept a paste":
   * the startup update picker highlights its selected option the same way
   * (`› 1. Update now (runs … curl … | sh)`), and pressing Enter there would
   * run an installer. That screen is caught by the dialog probe
   * (updatePickerDialog) before any delivery path reads this pattern.
   */
  getBottomReadyPattern(): RegExp | null {
    return /^\s*›\s?/;
  }

  /** Observed on real Codex 0.156.0: the live input row precedes its footer. */
  isDeliveryInputReadyPane(pane: string): boolean {
    // A composer with no app-server behind it accepts text and never submits it (#1099).
    if (codexAppServerDisconnected(pane)) return false;
    const rows = pane.replace(/\r/g, "").split("\n");
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    const footer = rows.pop() ?? "";
    // Codex preserves other configured status-line items after the context
    // meter (observed on 0.156.0: "Context 100% left · GPT-6-Astra"). They
    // are footer chrome, not evidence that the input row is unavailable.
    const contextFooter = this.isAnyContextFooter(footer);
    // A deliberately configured status_line may omit Context entirely. In
    // that case require a recognized value from the actual configured item
    // list after Codex's exact empty live-composer row. An arbitrary non-empty
    // footer or a recent transcript echo is not a readiness signal; that was
    // the false-ready hole in the old Layer 2 deny-list attempt (#931/#947).
    if (!contextFooter && !this.isConfiguredStatusLineFooter(footer)) return false;
    if (!contextFooter) {
      if (this.getBusyPattern().test(pane)) return false;
      let liveComposer = rows.length - 1;
      while (liveComposer >= 0 && (/^[ \t⋆]*$/.test(rows[liveComposer]))) liveComposer--;
      return liveComposer >= 0 && /^[>›]\s*Ask Codex to do anything\s*$/.test(rows[liveComposer]);
    }
    // Pasted text may wrap over several continuation rows before the footer.
    // Search only its immediate tail, not a historical transcript prompt.
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 8); i--) {
      if (/^[>›]\s+\d+\./.test(rows[i])) return false;
      if (/^[>›]\s+\S/.test(rows[i])) return true;
      if (/^[•■⚠]/.test(rows[i])) return false;
    }
    return false;
  }

  /**
   * Live status chrome that must veto the broad prompt/context ready match.
   *
   * #964: Codex relabels the live status row with the reasoning title
   * (`• Planning the edit (12s • esc to interrupt)`), so "Working" is only one
   * of its titles. Match the row's shape instead, as observed on 0.156/0.157:
   * a column-zero bullet, any title, then the `(… esc to interrupt)`
   * affordance with an optional elapsed time (`12s`, `2m 05s`, `·` or `•`
   * separator), optionally followed by ` · N background terminal(s) …`.
   * Anchoring on the whole row, not on the phrase, keeps an agent reply that
   * merely mentions "esc to interrupt" from pinning the pane as busy.
   */
  getBusyPattern(): RegExp {
    return CODEX_LIVE_STATUS_ROW;
  }

  /**
   * Codex 0.154's Astra theme can keep animating a star field around the input
   * box (and its terminal title) after the TUI has returned to the prompt.
   * Those cosmetic redraws keep tmux control mode noisy, so the daemon cannot
   * wait for two seconds of output silence.
   *
   * Do not use getReadyPattern() here: the Codex header, context meter and
   * input chrome all remain visible while a turn is running.  Instead require
   * the live, empty prompt followed by the context footer at the bottom of the
   * viewport, and reject a live status row immediately above it. A configured
   * no-Context status line must satisfy the same exact prompt/footer shape.
   */
  isPeriodicRedrawIdlePane(pane: string): boolean {
    if (codexAppServerDisconnected(pane)) return false;
    // Astra's 0.154 theme animates U+22C6 star points across otherwise-stable
    // idle chrome.  Remove only that observed decorative glyph; broader
    // punctuation stripping could turn real tool output into a false prompt.
    const rows = pane.replace(/\r/g, "").split("\n").map(row => row.replace(/⋆/gu, ""));
    let prompt = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (/^[>›]\s*Ask Codex to do anything\s*$/.test(rows[i])) {
        prompt = i;
        break;
      }
    }
    if (prompt < 0) return false;

    let footer = -1;
    for (let i = prompt + 1; i < Math.min(rows.length, prompt + 7); i++) {
      if (this.isCodexIdleFooter(rows[i])) {
        footer = i;
        break;
      }
      // Only blank/star-only animation rows may separate prompt and footer.
      if (rows[i].trim() !== "") return false;
    }
    if (footer < 0 || rows.slice(footer + 1).some(row => row.trim() !== "")) return false;

    // A real Codex status row is column-zero TUI chrome.  Quoted examples in a
    // user/assistant message are indented and therefore fail closed here.
    const activeRegion = rows.slice(Math.max(0, prompt - 8), prompt);
    if (activeRegion.some(row => /^•\s+\S.*\besc to interrupt\b/i.test(row))) return false;
    return true;
  }

  /**
   * The row codex paints for input it has taken into its own queue instead of
   * submitting: `↳ <message>` under "Messages to be submitted after next tool
   * call (press esc to interrupt and send immediately)".
   */
  getQueuedInputMarker(): RegExp | null {
    return /↳/;
  }

  buildCommand(config: CliBackendConfig): string {
    this.lastKnownModel = config.model?.trim() || null;
    this.credentialProfile = this.readProfile(config);
    const approvalFlag = config.skipPermissions !== false
      ? "--dangerously-bypass-approvals-and-sandbox"
      : "--full-auto";

    // #984: never trust `codex resume --last` to pick this instance's session.
    // Codex 0.157 scopes it to the git REPOSITORY, so in a worktree it resumes
    // the newest session of any sibling worktree (a lock screen while that
    // instance lives, a silent hijack otherwise), and a new instance in a
    // shared repo does not start fresh. Resume the exact-cwd thread from the
    // shared state DB instead; `--last` is only the fallback for an unreadable
    // DB when no other Codex instance shares the repository.
    let cmd: string;
    this.launchWarning = null;
    this.lastLaunchResumes = false;
    if (config.skipResume) {
      cmd = `${this.binaryPath} ${approvalFlag}`;
    } else {
      const plan = this.planResume(config);
      this.lastLaunchResumes = plan.mode === "resume" || plan.mode === "last";
      if (plan.mode === "resume") cmd = `${this.binaryPath} resume ${shellQuote(plan.id)} ${approvalFlag}`;
      else if (plan.mode === "last") cmd = `${this.binaryPath} resume --last ${approvalFlag}`;
      else cmd = `${this.binaryPath} ${approvalFlag}`;
      if (plan.mode === "last") this.launchWarning = t("codex.resume_db_unreadable_last", plan.cause);
      else if (plan.mode === "fresh" && plan.reason === "unreadable-with-siblings") {
        this.launchWarning = t("codex.resume_db_unreadable_fresh", plan.cause);
      } else if (plan.mode === "fresh") {
        // #1053: "none" is also what a lookup that missed looks like (#1028
        // was a silent new session per restart). A workspace that never had
        // a conversation stays quiet; one whose rollout shows a turn is told
        // which conversation to resume by hand.
        const missed = newestMissedCwdRollout(join(this.isolatedCodexHome, "sessions"), config.workingDirectory);
        if (missed) this.launchWarning = t("codex.resume_none_but_history", config.workingDirectory, missed.id);
      }
    }
    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("codex", model);
      cmd += ` -c ${shellQuote(`model="${model}"`)}`;
    }
    if (config.backendOptions?.provider) {
      const provider = validateProvider(String(config.backendOptions.provider));
      cmd += ` -c ${shellQuote(`model_provider="${provider}"`)}`;
    }
    // AgEnD instances are unattended processes: an interactive self-update
    // picker blocks delivery and must never be enabled by a copied global or
    // managed config layer. Keep this last so the CLI override is authoritative.
    // Both observed Codex 0.155.0 and 0.156.1 support this launch flag. Pin
    // the initial layout so a user/global fullscreen preference cannot make a
    // header-only pane look ready. A later unknown layout still fails closed.
    cmd += " -c check_for_update_on_startup=false --no-alt-screen";
    // codex 0.159's opt-in `instant_interrupt` makes new input steer the
    // running response instead of queueing behind it, which AgEnD's delivery
    // and queued-input (↳) handling assume. Keep it off whatever a user or
    // global config says. Codex before 0.159 ignores the key with a startup
    // warning ("`features.instant_interrupt` is ignored"); nothing else.
    cmd += " -c features.instant_interrupt=false";
    // CODEX_HOME is the only Codex-supported way to isolate the complete base
    // config. A profile only layers over the shared config and would therefore
    // still load every globally registered AgEnD MCP server.
    return `CODEX_HOME=${shellQuote(this.isolatedCodexHome)} ${cmd}`;
  }

  writeConfig(config: CliBackendConfig): void {
    this.authorizedTrust = null;
    // Set before the home is prepared: which login this instance gets is a
    // property of the home, and the home is built here.
    this.credentialProfile = this.readProfile(config);
    this.prepareIsolatedHome();
    this.cleanSharedConfig();

    // Copy all user settings but no AgEnD MCP entries into a private base
    // config, then append only this instance's server(s). Each instance writes
    // a distinct file, eliminating the old concurrent global-config race.
    let content = "";
    try {
      content = stripAgendMcpTables(readFileSync(join(this.sharedCodexHome, "config.toml"), "utf-8"));
    } catch { /* a first-time Codex user may have no global config */ }
    if (content && !content.endsWith("\n")) content += "\n";
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      content += `\n${renderMcpServer(name, entry, config.instanceName)}`;
    }
    atomicWritePrivate(join(this.isolatedCodexHome, "config.toml"), content);

    this.enableContextStatusLine();
    this.disableStartupUpdateCheck();
    this.hideRateLimitModelNudge();

    // Write fleet instructions into AGENTS.md (additive via marker block)
    if (config.instructions) {
      try {
        const agentsMd = join(config.workingDirectory, "AGENTS.md");
        appendWithMarker(agentsMd, config.instanceName, config.instructions);
        // Warn if file exceeds Codex's project_doc_max_bytes limit
        try {
          const size = statSync(agentsMd).size;
          if (size > CODEX_PROJECT_DOC_MAX_BYTES) {
            console.warn(`[agend] AGENTS.md is ${size} bytes, exceeds Codex limit of ${CODEX_PROJECT_DOC_MAX_BYTES} — instructions may be truncated`);
          }
        } catch { /* stat failed — skip size check */ }
      } catch { /* best effort */ }
    }
  }

  /**
   * Stop Codex opening its "Update available!" picker when an instance starts.
   *
   * That dialog owns the input loop until someone answers it, so after a fleet
   * restart every Codex instance sat waiting on a keypress nobody was going to
   * send. AgEnD then reported it as a stuck pane, which is true but unhelpful.
   *
   * `check_for_update_on_startup = false` is Codex's own config key (verified in
   * the binary), so this prevents the prompt rather than racing to dismiss it.
   * There is no CLI flag for it — `codex update` is a subcommand, not a switch.
   *
   * Placement matters: this is a TOP-LEVEL key, so it has to go above the first
   * `[section]` header or TOML would read it as belonging to that section. And a
   * AgEnD's isolated home is unattended, so an inherited `true` is replaced
   * rather than preserved. TOML rejects duplicate keys, so replace in place.
   */
  private disableStartupUpdateCheck(): void {
    const configPath = join(this.isolatedCodexHome, "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch { return; }

    const existing = /^\s*check_for_update_on_startup\s*=\s*(?:true|false)\s*(?:#.*)?$/m;
    if (existing.test(content)) {
      const updated = content.replace(existing, "check_for_update_on_startup = false");
      if (updated !== content) {
        try { atomicWritePrivate(configPath, updated); } catch { /* best effort */ }
      }
      return;
    }

    const LINE = "check_for_update_on_startup = false\n";
    const firstSection = content.search(/^\s*\[/m);
    const updated = firstSection === -1
      ? (content.length && !content.endsWith("\n") ? `${content}\n${LINE}` : `${content}${LINE}`)
      : `${content.slice(0, firstSection)}${LINE}${content.slice(firstSection)}`;
    try { atomicWritePrivate(configPath, updated); } catch { /* best effort */ }
  }

  /**
   * Suppress Codex's rate-limit model-switch reminder for unattended instances.
   * Codex documents this as `notice.hide_rate_limit_model_nudge` (a boolean in
   * the `[notice]` table). This changes only the per-instance config; the
   * runtime holdOnly dialog remains as defense-in-depth for older or changed
   * CLI behavior. No model option is selected automatically.
   */
  private hideRateLimitModelNudge(): void {
    const configPath = join(this.isolatedCodexHome, "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch { return; }

    const updated = setTomlTableBoolean(content, "notice", "hide_rate_limit_model_nudge");
    if (updated !== content) {
      try { atomicWritePrivate(configPath, updated); } catch { /* best effort */ }
    }
  }

  /**
   * Ensure Codex's TUI status line shows context usage: the Context item is
   * both what /ctx scrapes and the footer AgEnD's readiness proofs rely on.
   * Rules (never drops or reorders the user's items):
   *   1. the effective `tui.status_line` already has a context item
   *      (context-remaining / -usage / -used) → leave the config untouched.
   *   2. no context item:
   *        - no status_line at all → write status_line = ["context-remaining"]
   *        - status_line exists     → prepend "context-remaining" to it
   * Best-effort string edit (no TOML writer), but every candidate edit is
   * parsed back and kept only if the effective `tui.status_line` becomes
   * `["context-remaining", ...the user's items]`. A `status_line` key in some
   * other table is not the TUI's and must not be the one edited (#931). If no
   * edit can be verified, the launch warns the operator instead of leaving the
   * pane silently unready.
   */
  private enableContextStatusLine(): void {
    this.configuredStatusLineItems = undefined;
    this.configuredStatusLinePattern = undefined;
    this.statusLineWarning = null;
    const configPath = join(this.isolatedCodexHome, "config.toml");
    // The private copy is rebuilt from the shared one at every launch, so the
    // operator must be pointed at the file their status_line actually lives in.
    const sharedConfigPath = join(this.sharedCodexHome, "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch { /* no file yet */ }

    const ITEM = "context-remaining";
    const current = effectiveTuiStatusLine(content);
    if (current === "invalid") {
      this.statusLineWarning = t("codex.status_line_unverifiable", "tui.status_line is not a list of item names, or config.toml does not parse", sharedConfigPath);
      return;
    }
    // Rule 1: the TUI already shows a context item → don't touch anything.
    if (current?.some(item => CODEX_CONTEXT_STATUS_ITEM_RE.test(item))) return;

    // TOML allows quoted keys: `"status_line" = [...]`, `"tui"."status_line"`,
    // `['tui']`. Every textual candidate is tried; parsing decides.
    const candidates: string[] = [];
    if (current) {
      // Rule 2b: prepend our item to the user's existing array (don't overwrite).
      // First position keeps "Context N% left" at the far left of the footer so a
      // long cwd/other items can't push it past 80 cols and truncate it.
      for (const m of content.matchAll(/["']?status_line["']?\s*=\s*\[([^\]]*)\]/g)) {
        const inner = m[1].trim().replace(/^,\s*/, "").replace(/,\s*$/, "");
        const newInner = inner.length ? `"${ITEM}", ${inner}` : `"${ITEM}"`;
        candidates.push(`${content.slice(0, m.index)}status_line = [${newInner}]${content.slice(m.index! + m[0].length)}`);
      }
    } else {
      // Rule 2a: no status_line at all → add a minimal one.
      const base = content.length && !content.endsWith("\n") ? `${content}\n` : content;
      // Also recognise quoted section headers: `["tui"]` and `['tui']`.
      if (/^\[["']?tui["']?\][^\n]*\n/m.test(base)) {
        candidates.push(base.replace(/^\[["']?tui["']?\][^\n]*\n/m, h => `${h}status_line = ["${ITEM}"]\n`));
      }
      candidates.push(`${base}\n[tui]\nstatus_line = ["${ITEM}"]\n`);
      // A config that defines tui with dotted keys cannot take a [tui] table.
      candidates.push(`tui.status_line = ["${ITEM}"]\n${base}`);
      // Nor can an inline `tui = { … }` table: the item goes inside it.
      candidates.push(base.replace(/^([ \t]*["']?tui["']?[ \t]*=[ \t]*\{)[ \t]*\}/m, `$1 status_line = ["${ITEM}"] }`));
      candidates.push(base.replace(/^([ \t]*["']?tui["']?[ \t]*=[ \t]*\{)/m, `$1 status_line = ["${ITEM}"],`));
    }
    const wanted = [ITEM, ...(current ?? [])];
    const fixed = candidates.find(candidate => {
      const items = effectiveTuiStatusLine(candidate);
      return Array.isArray(items) && items.length === wanted.length && items.every((item, i) => item === wanted[i]);
    });
    if (!fixed) {
      this.statusLineWarning = t("codex.status_line_unverifiable", "no edit of tui.status_line could be verified", sharedConfigPath);
      return;
    }
    try {
      atomicWritePrivate(configPath, fixed);
    } catch (err) {
      // Never block launch on statusline config — but a verified edit that
      // could not be written leaves the pane as unready as an unfixable one.
      const reason = `the verified edit could not be written: ${(err as NodeJS.ErrnoException).code ?? "write failed"}`;
      this.statusLineWarning = t("codex.status_line_unverifiable", reason, sharedConfigPath);
    }
  }

  /** Null when the instance did not ask for a profile — today's behaviour. */
  private readProfile(config: CliBackendConfig): string | null {
    try {
      return resolveCredentialProfile(config.backendOptions);
    } catch {
      // A malformed name is refused where it is written; launching is not the
      // place to discover it, and falling back to the shared login is the
      // behaviour every instance had before profiles existed.
      return null;
    }
  }

  /**
   * Where this instance's `auth.json` comes from.
   *
   * The shared home unless a profile says otherwise. A profile owns the file
   * itself — not a copy, not a link — so codex refreshing the token writes
   * into that subscription and no other.
   */
  private authSourceDir(): string {
    if (!this.credentialProfile) return this.sharedCodexHome;
    const spec = credentialHomeSpec(this.binaryName);
    if (!spec) return this.sharedCodexHome;
    const home = credentialProfileHome(getAgendHome(), this.binaryName, this.credentialProfile);
    prepareCredentialProfileHome(spec, home);
    return home;
  }

  preTrust(workDir: string): void {
    this.authorizedTrust = null;
    const paths = codexTrustPaths(workDir);
    const configPath = join(this.isolatedCodexHome, "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch {}
    const updated = setProjectTrusted(content, paths.root);
    if (updated !== content) atomicWritePrivate(configPath, updated);
    // Do not authorize an automatic Enter merely because the write returned:
    // a stale/untrusted section in the effective isolated config must fail shut.
    const onDisk = readFileSync(configPath, "utf-8");
    if (effectiveProjectTrust(onDisk, paths.root) !== "trusted") throw new Error("Codex project trust did not persist");
    this.authorizedTrust = paths;
  }

  /**
   * Preserve Codex login/session/cache sharing while isolating config.toml
   * and the CODEX_HOME-scoped app-server daemon/control runtime directories.
   */
  /** Session dirs every instance must share with the terminal CLI (#506). */
  private static readonly SHARED_SESSION_DIRS = ["sessions", "archived_sessions"] as const;
  private static readonly PRIVATE_RUNTIME_DIRS = new Set(["app-server-daemon", "app-server-control"]);

  private prepareIsolatedHome(): void {
    mkdirSync(this.isolatedCodexHome, { recursive: true, mode: 0o700 });
    chmodSync(this.isolatedCodexHome, 0o700);
    if (this.sharedCodexHome === this.isolatedCodexHome) return;

    // #1034: Codex's private socket directory check rejects directory symlinks.
    // Detach only the exact shared-home links the old mirror pass created,
    // including dangling links. Leave private directories and other links
    // alone; Codex will create its own real runtime directories on launch.
    for (const name of CodexBackend.PRIVATE_RUNTIME_DIRS) {
      const target = join(this.isolatedCodexHome, name);
      try {
        if (lstatSync(target).isSymbolicLink()
          && readlinkSync(target) === join(this.sharedCodexHome, name)) {
          unlinkSync(target);
        }
      } catch { /* absent, or another startup already detached the link */ }
    }

    // The session dirs must exist in the SHARED home before the symlink pass:
    // on a fresh install they don't yet, so no link was created, and the first
    // archive made Codex create a REAL dir in the instance-private home — a
    // permanent fork the terminal CLI could never see (#506). mkdir -p is
    // EEXIST-safe under concurrent instance startup.
    for (const dir of CodexBackend.SHARED_SESSION_DIRS) {
      try { mkdirSync(join(this.sharedCodexHome, dir), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
    }

    // Heal homes that already forked: merge the private real dir back into the
    // shared one (never overwriting), then replace it with the symlink.
    for (const dir of CodexBackend.SHARED_SESSION_DIRS) {
      this.migrateDivergedSessionDir(dir);
    }

    // Older versions linked SQLite's WAL/SHM files independently of their
    // base database. If the base file had already been created privately,
    // that split one SQLite database across two homes and caused CANTOPEN (or
    // worse, cross-database journal recovery). Remove only links AgEnD made to
    // the matching shared-home path; real private sidecars remain untouched.
    const healedSidecars: string[] = [];
    for (const name of readdirSync(this.isolatedCodexHome)) {
      if (!SQLITE_SIDECAR_RE.test(name)) continue;
      const target = join(this.isolatedCodexHome, name);
      try {
        if (!lstatSync(target).isSymbolicLink()) continue;
        const linkTarget = resolve(dirname(target), readlinkSync(target));
        if (linkTarget !== join(this.sharedCodexHome, name)) continue;
        unlinkSync(target);
        healedSidecars.push(name);
      } catch {
        // A concurrent process may remove an ephemeral sidecar/link first.
      }
    }
    if (healedSidecars.length > 0) {
      console.warn(`[agend] removed unsafe Codex SQLite sidecar links: ${healedSidecars.join(", ")}`);
    }

    // One file, possibly from somewhere else. Everything below is unchanged:
    // sessions, the thread/state/memory databases and every cache still come
    // from the shared home, which is why switching subscription does not throw
    // the conversation away.
    this.linkAuthFile();

    for (const name of readdirSync(this.sharedCodexHome)) {
      if (CodexBackend.PRIVATE_RUNTIME_DIRS.has(name)) continue;
      if (name === "config.toml" || name === AGEND_MCP_CLEANUP_LOCK || name.startsWith(".config.toml.")) continue;
      if (name === CODEX_AUTH_FILE) continue; // handled above, possibly from a profile
      // SQLite resolves a symlinked base DB to the shared path and creates its
      // own adjacent sidecars there. Linking sidecars separately is redundant
      // for shared bases and corrupts the file set for private bases.
      if (SQLITE_SIDECAR_RE.test(name)) continue;
      const source = join(this.sharedCodexHome, name);
      const target = join(this.isolatedCodexHome, name);
      if (existsSync(target)) continue;
      try {
        const type = lstatSync(source).isDirectory() ? "dir" : "file";
        symlinkSync(source, target, type);
      } catch {
        // State/cache links are compatibility aids; config isolation must not
        // fail merely because a concurrently-created cache entry disappeared.
      }
    }
  }

  /**
   * Point this home's `auth.json` at whichever login it should use.
   *
   * Codex refreshes the token by writing through the link rather than replacing
   * it — observed across every instance home on a machine that has been running
   * this arrangement for months, with the shared file's mtime moving. That is
   * behaviour, though, not a contract: a release that starts renaming over the
   * file would leave a real file here and quietly fork the login, with refreshes
   * landing somewhere the profile never sees. So a real file where a link
   * belongs is treated as exactly that — reported, and put back.
   */
  private linkAuthFile(): void {
    const source = join(this.authSourceDir(), CODEX_AUTH_FILE);
    const target = join(this.isolatedCodexHome, CODEX_AUTH_FILE);

    let existing: ReturnType<typeof lstatSync> | null = null;
    try { existing = lstatSync(target); } catch { /* absent */ }

    if (existing?.isSymbolicLink()) {
      let current = "";
      try { current = resolve(dirname(target), readlinkSync(target)); } catch { /* unreadable */ }
      if (current === source) return;
      try { unlinkSync(target); } catch { /* raced */ }
    } else if (existing) {
      // Not a link: codex replaced it, or an older AgEnD copied it. Either way
      // the refreshes it has been collecting are stranded in this instance's
      // home, so say so rather than deleting them silently.
      const stranded = `${target}.replaced-${Date.now()}`;
      try {
        renameSync(target, stranded);
        console.warn(
          `[agend] codex replaced ${CODEX_AUTH_FILE} in ${this.isolatedCodexHome} with a real file — `
          + `its login was no longer shared. Kept a copy at ${stranded} and re-linked to ${source}.`,
        );
      } catch {
        return; // cannot move it; leave the instance working on what it has
      }
    }

    if (!existsSync(source)) return; // not logged in yet; codex will create it
    try {
      symlinkSync(source, target, "file");
    } catch {
      // EEXIST from a concurrent start is the ordinary case and means the link
      // is already there.
    }
  }

  /**
   * One-time heal for an instance whose isolated home grew a REAL session dir
   * (#506): merge it into the shared home without overwriting anything, and
   * only after both the copy and the removal succeed put the symlink in its
   * place. Any failure keeps the private dir — sessions are never the thing
   * sacrificed for tidiness — and logs what happened.
   */
  private migrateDivergedSessionDir(name: string): void {
    const target = join(this.isolatedCodexHome, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(target);
    } catch {
      return; // absent — the symlink pass below will create the link
    }
    if (st.isSymbolicLink()) return; // already correct
    if (!st.isDirectory()) {
      console.warn(`[agend] codex-home/${name} is neither a symlink nor a directory — leaving it untouched`);
      return;
    }

    const shared = join(this.sharedCodexHome, name);
    try {
      mkdirSync(shared, { recursive: true, mode: 0o700 });
      // cp -rn semantics: collisions keep the shared copy. Session rollout
      // filenames are timestamp+uuid, so a genuine collision means the same
      // file — skipping is lossless either way.
      cpSync(target, shared, { recursive: true, force: false, errorOnExist: false });
      rmSync(target, { recursive: true });
      symlinkSync(shared, target, "dir");
      console.warn(`[agend] migrated diverged codex ${name} into shared home: ${shared}`);
    } catch (err) {
      // Keep whatever is left of the private dir. The copy never overwrites, so
      // a retry on next start is safe; worst case is duplicated files in the
      // shared home, never lost ones.
      console.warn(`[agend] codex ${name} migration failed — keeping the instance-private dir (${(err as Error).message})`);
    }
  }

  /**
   * One-time migration for installations polluted by the old global `codex
   * mcp add` path. The lock protects separate fleet processes/upgrades, and
   * atomic rename prevents readers from observing a truncated config.
   */
  private cleanSharedConfig(): void {
    if (this.sharedCodexHome === this.isolatedCodexHome) return;
    mkdirSync(this.sharedCodexHome, { recursive: true, mode: 0o700 });
    const lockPath = join(this.sharedCodexHome, AGEND_MCP_CLEANUP_LOCK);
    let lockFd: number | undefined;
    const acquire = (): boolean => {
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
        return true;
      } catch {
        return false;
      }
    };

    if (!acquire()) {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > AGEND_MCP_CLEANUP_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          if (!acquire()) return;
        } else {
          return;
        }
      } catch {
        return;
      }
    }

    try {
      const configPath = join(this.sharedCodexHome, "config.toml");
      let content: string;
      try { content = readFileSync(configPath, "utf-8"); } catch { return; }
      const cleaned = stripAgendMcpTables(content);
      if (cleaned !== content) atomicWritePrivate(configPath, cleaned);
    } finally {
      if (lockFd !== undefined) {
        try { closeSync(lockFd); } catch {}
      }
      try { unlinkSync(lockPath); } catch {}
    }
  }

  getReadyPattern(): RegExp {
    // Header and context text persist in inline scrollback and even while the
    // CLI is loading or a modal owns stdin. Require the live prompt followed
    // by the Context footer at the *end* of the capture. A valid custom
    // status_line without Context gets a separate configured-item pattern;
    // unknown footer values still fail closed. getBusyPattern vetoes a working
    // turn whose empty composer remains visible.
    // U+22C6 is Codex's observed cosmetic starfield; it can be drawn in the
    // prompt, between prompt/footer, and below the footer. A drafted composer
    // is also idle once this same bottom footer proves it owns the screen.
    const contextReady = /(?:^|\n)[>›][ \t⋆]+(?!\d+\.)\S[^\r\n]*\r?\n(?:[ \t⋆]*\r?\n){0,3}[ \t⋆]+(?:[0-9a-f-]{36}[ \t]+·[ \t]+)?Context[ \t]+(?:\d+%[ \t]+(?:left|used)|\d+…|…)[^\r\n]*(?:\r?\n[ \t⋆]*)*$/i;
    const footerPattern = this.configuredStatusLineFooterPattern();
    if (!footerPattern) return contextReady;

    // The no-Context alternative requires the exact empty composer followed by
    // a recognized configured Codex status_line value. If run-state is
    // configured, that value must specifically be Ready. This is positive
    // structural proof, never a deny-list of known dialogs.
    const footerSource = footerPattern.source.slice(1, -1);
    const noContextReady = new RegExp(
      String.raw`(?:^|\n)[>›][ \t⋆]*Ask Codex to do anything[ \t⋆]*\r?\n(?:[ \t⋆]*\r?\n){0,3}${footerSource}(?:\r?\n[ \t⋆]*)*$`,
      "iu",
    );
    // #978: a configured footer that carries a Context item in any position
    // is the Context footer: same drafted-composer rule as Context-first. The
    // whole row must match the configured item grammar, so an arbitrary
    // indented line that merely contains `Context N% left` cannot pass.
    const configuredContextReady = this.configuredHasContextItem()
      ? new RegExp(
        String.raw`(?:^|\n)[>›][ \t⋆]+(?!\d+\.)\S[^\r\n]*\r?\n(?:[ \t⋆]*\r?\n){0,3}(?=[^\r\n]*${CODEX_CONTEXT_ITEM})${footerSource}(?:\r?\n[ \t⋆]*)*$`,
        "iu",
      )
      : null;
    return new RegExp(
      [contextReady.source, noContextReady.source, configuredContextReady?.source]
        .filter((source): source is string => !!source)
        .map(source => `(?:${source})`)
        .join("|"),
      "iu",
    );
  }

  private readConfiguredStatusLineItems(): string[] | null {
    if (this.configuredStatusLineItems !== undefined) return this.configuredStatusLineItems;
    try {
      const config = tomlTable(parseToml(readFileSync(join(this.isolatedCodexHome, "config.toml"), "utf-8")));
      const tui = tomlTable(config?.tui);
      const items = tui?.status_line;
      this.configuredStatusLineItems = Array.isArray(items) && items.every(item => typeof item === "string")
        ? items as string[]
        : null;
    } catch {
      this.configuredStatusLineItems = null;
    }
    return this.configuredStatusLineItems;
  }

  private configuredStatusLineFooterPattern(): RegExp | null {
    if (this.configuredStatusLinePattern !== undefined) return this.configuredStatusLinePattern;
    const items = this.readConfiguredStatusLineItems();
    if (!items?.length) return this.configuredStatusLinePattern = null;
    const configuredPatterns = items
      .map(item => CODEX_STATUS_LINE_VALUE_PATTERNS[item])
      .filter((pattern): pattern is string => pattern !== undefined);
    if (!configuredPatterns.length) return this.configuredStatusLinePattern = null;

    const segment = `(?:${configuredPatterns.join("|")})`;
    const separator = String.raw`[ \t]+·[ \t]+`;
    const hasRunState = items.some(item => CODEX_RUN_STATE_STATUS_ITEMS.has(item));
    // Ready must occupy its own status-line segment. Other configured items
    // may precede/follow it, as Codex joins visible values with ` · `.
    const line = hasRunState
      ? `(?:${segment}${separator})*Ready(?:${separator}${segment})*`
      : `${segment}(?:${separator}${segment})*`;
    this.configuredStatusLinePattern = new RegExp(`^[ \t⋆]*${line}[ \t⋆]*$`, "iu");
    return this.configuredStatusLinePattern;
  }

  private isConfiguredStatusLineFooter(row: string): boolean {
    const pattern = this.configuredStatusLineFooterPattern();
    if (!pattern) return false;
    pattern.lastIndex = 0;
    return pattern.test(row);
  }

  private configuredHasContextItem(): boolean {
    return (this.readConfiguredStatusLineItems() ?? []).some(item => CODEX_CONTEXT_STATUS_ITEMS.has(item));
  }

  /**
   * #978: a Context item in ANY position, accepted only as part of a footer
   * whose every segment matches the configured status_line items. Codex keeps
   * the user's order (`gpt-5.6-sol medium · Context 46% left · ~/x`); an
   * arbitrary indented transcript line that happens to contain the item does
   * not match that grammar. A stale config fails closed, and the daemon's
   * stable-composer escape hatch then keeps the instance from latching.
   */
  // The configured grammar already makes Context a whole segment, so the item
  // test only has to establish that one is present.
  private isConfiguredContextFooter(row: string): boolean {
    return this.configuredHasContextItem()
      && new RegExp(CODEX_CONTEXT_ITEM, "iu").test(row)
      && this.isConfiguredStatusLineFooter(row);
  }

  /** Any footer that proves the Context meter owns the bottom row. */
  private isAnyContextFooter(row: string): boolean {
    return isCodexContextFooter(row) || this.isConfiguredContextFooter(row);
  }

  /**
   * #978 escape hatch: the live, EMPTY Codex composer within the last few
   * non-blank rows, no busy marker, and none of the known selection screens.
   * Deliberately says nothing about the footer, which is what is unknown.
   */
  isStableUnknownLayoutIdlePane(pane: string): boolean {
    if (this.getBusyPattern().test(pane)) return false;
    // The composer is live-looking and the footer is unknown — exactly this
    // proof's blind spot — but there is no server behind it (#1099).
    if (codexAppServerDisconnected(pane)) return false;
    // Broader than getBusyPattern(): Codex relabels the live status row with
    // the reasoning title (`• Planning the edit (esc to interrupt)`), and the
    // fallback must never read that as idle, whatever the title says.
    if (/(?:^|\n)[ \t]*•[^\n]*\besc to interrupt\b/i.test(pane)) return false;
    // A retained queued message (`↳ …` under "Messages to be submitted after
    // next tool call") means work is pending, whatever the composer shows.
    if (/↳|Messages to be submitted/i.test(pane)) return false;
    if (codexUsageLimitMenuVisible(pane) || codexRateSwitchVisible(pane)
      || codexUnknownSelectionVisible(pane) || codexUpdatePickerVisible(pane)) return false;
    const rows = pane.replace(/\r/g, "").split("\n").filter(row => row.trim() !== "");
    return rows.slice(-6).some(row => /^[>›][ \t⋆]*Ask Codex to do anything[ \t⋆]*$/.test(row));
  }

  private isCodexIdleFooter(row: string): boolean {
    return isCodexContextFooter(row) || this.isConfiguredStatusLineFooter(row);
  }

  /** A proxy reply filters chrome per line; whole-pane readiness is separate. */
  isProxyReplyChromeLine(line: string): boolean {
    return /^\s*[›>]\s+Ask Codex to do anything\s*$/.test(line)
      || this.isAnyContextFooter(line);
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      // Specific quota codes must precede the generic HTTP 429 classifier:
      // OpenAI returns insufficient_quota with status 429, but switching models
      // cannot repair an exhausted account and would only start a failover loop.
      {
        pattern: /^\s*(?:■|⚠|Error:|API Error:)\s*[\s\S]{0,240}?\b(?:insufficient_quota|billing_hard_limit_reached|exceeded\s+your\s+current\s+quota)\b/im,
        type: "quota",
        action: "pause",
        message: "OpenAI quota exceeded",
      },
      {
        // Pane history contains the agent's own prose, source code and search
        // results. Bare `rate limit` used to fail over an otherwise healthy
        // Codex merely for discussing this regex. Match machine-readable API
        // forms or an error-decorated terminal line instead.
        pattern: /^\s*unexpected\s+status\s+429\b|^\s*(?:■|⚠|Error:|API Error:)\s*[\s\S]{0,240}?(?:["'](?:status|code)["']\s*:\s*429\b|\b(?:rate_limit_exceeded|too_many_requests)\b|\brate limit(?:ed| exceeded| reached)?\b|\btoo many requests\b)/im,
        type: "rate_limit",
        action: "failover",
        message: "OpenAI rate limit reached",
      },
      {
        // Same false-positive boundary as rate limits: `authentication` is a
        // normal English/code word. Require a structured 401/code or a
        // decorated CLI error line before pausing every instance on the shared
        // credential.
        pattern: /^\s*unexpected\s+status\s+401\b|^\s*(?:■|⚠|Error:|API Error:)\s*[\s\S]{0,240}?(?:["'](?:status|code)["']\s*:\s*401\b|\b(?:invalid_api_key|authentication_error)\b|\b401\s+Unauthorized\b|\bauthentication (?:failed|error)\b|\binvalid api key\b)/im,
        type: "auth_error",
        action: "pause",
        message: "OpenAI authentication error",
      },
      // Codex writes the apostrophe as U+2019 ("You’ve hit your usage limit.") since
      // 0.156 and as ASCII before (0.153.4): both must match, or no usage limit
      // ever pauses the instance (#1098).
      { pattern: /you['’]ve hit your usage limit/i, type: "quota", action: "pause", message: "Codex usage limit reached — upgrade plan required" },
      {
        // The terminal stage of a lost app-server (#1099): Codex has given up
        // reconnecting and says so, with a counter that never stops. Nothing
        // recovers from here without a relaunch, and every message sent in the
        // meantime waits for an idle that cannot come. Only the LIVE row counts:
        // directly above the LAST composer with no later transcript item or composer
        // (the same test as codexAppServerDisconnected, as a lookahead), so text that
        // merely quotes it does not raise this.
        pattern: new RegExp(
          String.raw`^[ \t]*•[ \t]+Reconnect failed[ \t]+—[ \t]+check the endpoint, then relaunch[ \t]+\(\d+[hms](?:[ \t]+\d+[hms])*\)[ \t]*$`
          + String.raw`(?=\n(?:[ \t]*\n)*[›>][^\n]*(?:\n(?![•■⚠›>])[^\n]*)*(?![\s\S]))`,
          "mu",
        ),
        type: "network",
        action: "notify",
        message: "Codex lost its app-server connection and could not reconnect — restart the instance (messages cannot be delivered until then)",
      },
      {
        // Codex reports an unknown model either as a TUI metadata fallback or
        // as a ChatGPT-account API rejection. Use whitespace-aware phrases so
        // capture-pane hard wraps do not hide either form.
        // Codex quotes the slug with BACKTICKS ("Model metadata for `x` not found.",
        // verified live on 0.160.0 and in the 0.153.4–0.160.0 binaries). The old
        // pattern only took ASCII quotes, so it could never match a real line.
        pattern: /model\s+metadata\s+for\s+['"`‘’“”][^'"`‘’“”]+['"`‘’“”]\s+not\s+found\.\s+defaulting\s+to\s+fallback\s+metadata|model\s+is\s+not\s+supported\s+when\s+using\s+codex\s+with\s+a\s+chatgpt\s+account/i,
        type: "model_error",
        action: "notify",
        message: "Codex model unavailable — use /model to switch",
      },
      {
        // A capacity rejection is a completed failed turn: Codex returns to its
        // prompt without an answer. Keep this anchored to the exact decorated
        // TUI line so ordinary prose about model capacity cannot pause an
        // otherwise healthy instance. The CLI is already back at the prompt, so
        // skipRecoveryWait avoids an extra wait before the backoff timer fires.
        // action "backoff_restart": exponential backoff + resume, up to 3 times;
        // the lifecycle falls back to "pause" after the limit (see #905).
        pattern: /^⚠ Selected model is at capacity\. Please try a different model\.\r?$/m,
        type: "model_error",
        action: "backoff_restart",
        message: t("inst.codex_model_capacity"),
        skipRecoveryWait: true,
      },
      // Workspace (team) accounts report exhaustion differently from personal
      // ones — the full line is:
      //   "■ Your workspace is out of credits. Ask your workspace owner to
      //    refill in order to continue."
      // Neither `insufficient_quota|billing` nor `you've hit your usage limit`
      // matches it, so this state went unreported.
      //
      // `\s+` at each word gap: capture-pane runs without -J, so tmux's hard
      // wrap can land a newline anywhere in the phrase. The `■` prefix and the
      // "Ask your workspace owner…" tail are deliberately left out — the prefix
      // is decoration and the tail is what would wrap.
      {
        pattern: /workspace\s+is\s+out\s+of\s+credits/i,
        type: "quota",
        // pause, not notify: exhausted credits are a dead end until someone
        // refills, so leaving the instance running just burns cycles failing.
        // Matches how the other terminal quota states behave (claude-code's
        // "credit balance is too low", codex's own "you've hit your usage
        // limit"). Costs a manual resume after the refill.
        action: "pause",
        message: "Codex workspace credits exhausted — workspace owner must refill",
      },
      // Codex warns at 10% and 5% remaining, and scopes the limit by period —
      // "weekly" alone missed every `monthly limit` warning.
      //
      // `\s+` at EVERY word gap (not literal spaces) because capture-pane runs without -J,
      // so tmux's hard wrap can land a newline (plus continuation-line padding)
      // at any of these word gaps. The trailing "Run /status for a breakdown."
      // is deliberately NOT part of the pattern — that tail is what actually
      // wrapped in the reported case.
      //
      // `of your <period> limit` is load-bearing: it's what keeps the pattern
      // off the agent's own prose about percentages.
      {
        pattern: /less\s+than\s+(\d+)\s*%\s+of\s+your\s+(hourly|daily|weekly|monthly)\s+limit/i,
        type: "quota",
        action: "notify",
        message: "Codex usage limit running low",
        formatMessage: (m) => `Codex ${m[2].toLowerCase()} limit: less than ${m[1]}% left`,
      },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    const trustHold = this.trustHoldDialog();
    return [
      {
        pattern: /^\s*Trust this folder\?/m,
        keys: ["Enter"],
        description: "Codex authorized folder trust dialog",
        blocksDelivery: true,
        inputBlocked: true,
        autoResolutionKey: "codex-authorized-folder-trust",
        isActive: pane => {
          const state = codexTrustPromptState(pane);
          const authorized = this.authorizedTrust;
          return state.active && state.safeChoice && authorized !== null
            && state.folder === authorized.cwd
            && (state.rootNote === "absent" ? authorized.root === authorized.cwd
              : state.rootNote === "parsed" && state.root === authorized.root);
        },
      },
      trustHold,
      this.updatePickerDialog(),
      this.rateSwitchPickerDialog(),
      ...this.sessionHoldDialogs(),
      this.unknownSelectionHoldDialog(),
    ];
  }

  /**
   * #984: session-selection screens only a human may answer. Held (never
   * keyed) so the delivery gate keeps messages queued and dialog_parked tells
   * the operator; listed before the generic selection hold for a clear notice.
   */
  private sessionHoldDialogs(): RuntimeDialog[] {
    return [
      {
        pattern: /This conversation is open in another app/,
        keys: [],
        description: "Codex session is open in another process (thread lock) — close the other one and press r, or fork manually",
        holdOnly: true,
        blocksDelivery: true,
        inputBlocked: true,
        isActive: codexSessionLockVisible,
      },
      {
        pattern: /Working directory · resume/,
        keys: [],
        description: "Codex resume selected a session from another directory (sibling git worktree) — needs a human choice",
        holdOnly: true,
        blocksDelivery: true,
        inputBlocked: true,
        isActive: codexResumeCwdPickerVisible,
      },
    ];
  }

  private trustHoldDialog(): RuntimeDialog {
    return {
      pattern: /^\s*(?:Folder access|Trust this folder\?|Do you trust the files in this folder\?)/im,
      keys: [],
      description: "Codex folder trust needs human confirmation",
      holdOnly: true,
      blocksDelivery: true,
      inputBlocked: true,
      isActive: codexTrustVariantActive,
    };
  }

  /**
   * #1008: the rate-limit model-switch picker parked unattended instances (it
   * waits forever and its default option changes the model). Prevention is
   * `notice.hide_rate_limit_model_nudge` (hideRateLimitModelNudge — real and
   * effective on 0.157.1 and 0.159.2, verified live); this is the answer for a
   * picker that appears anyway (config not applied, a CLI that moved the key).
   *
   * Escape, not a navigated Enter: it selects nothing, so it can never take
   * option 1 (switch model) or option 3 (writes "never show again" into the
   * config). Deliberately not one-shot: if the picker swallowed the key it is
   * simply sent again on the next poll, and a repeated Escape is harmless.
   */
  private rateSwitchPickerDialog(): RuntimeDialog {
    return {
      // Documentation only: Daemon.dialogMatches uses isActive INSTEAD of this
      // pattern, so it filters nothing here — the structural check below is the
      // whole decision, and ordinary prose about the picker fails it. The words
      // are the picker's own, kept so a reader can find the screen from the log.
      pattern: /Keep current model \(never show again\)/,
      keys: ["Escape"],
      description: "Codex rate-limit model-switch picker — Escape keeps the current model",
      blocksDelivery: true,
      inputBlocked: true,
      isActive: codexRateSwitchPickerVisible,
    };
  }

  private updatePickerDialog(): RuntimeDialog {
    return {
      // Defense in depth for config written by older AgEnD versions or a Codex
      // regression. Match the release URL as well as the banner so ordinary
      // agent prose cannot trigger a keypress.
      pattern: /Update available![\s\S]{0,200}Release notes: https:\/\/github\.com\/openai\/codex\/releases/m,
      keys: ["Escape"],
      description: "Codex startup update-available picker",
      // A delivery must never land on this screen. Its selected option is
      // `› 1. Update now (runs … curl … | sh)` — the same `›` the input row
      // uses — so an Enter here runs an installer instead of sending a message.
      // The runtime dismisser presses Escape, but it only polls every few
      // seconds and a delivery can arrive first (hit live on codex-cli 0.153.4,
      // which parks on this picker for as long as nobody answers it).
      blocksDelivery: true,
      // Daemon.dialogMatches uses isActive INSTEAD OF pattern when present.
      // Check the complete current picker here; a different Enter-only menu
      // must never receive this automatic Escape key.
      isActive: codexUpdatePickerVisible,
    };
  }

  private usageLimitLunaReserveDialog(): RuntimeDialog {
    // The real codex usage-limit dialog states codex has ALREADY switched to
    // Luna Reserve and labels Escape as "continue working". Pressing Escape via
    // sendSpecialKey is the ONLY safe key:
    //
    //   • Escape is sent via sendSpecialKey — never via pasteText (which adds
    //     an implicit bracketed-paste Enter that could confirm Reset usage).
    //   • A digit pasted via pasteText would leave the cursor on option 1 and
    //     its own implicit Enter would fire Reset usage BEFORE any confirmation
    //     gate. This path is explicitly NOT used.
    //
    // verifyAfterKeys: true — confirm the menu is gone after Escape.
    // No confirmBeforeEnter / keysAfterConfirm: Escape needs no confirm gate.
    return {
      pattern: /Press enter to confirm or esc to continue working/i,
      keys: ["Escape"],
      description: "Codex usage limit — pressing Escape to continue with Luna Reserve",
      blocksDelivery: true,
      inputBlocked: true,
      isActive: codexUsageLimitMenuVisible,
      verifyAfterKeys: true,
      autoResolutionKey: "codex-usage-limit-luna-reserve",
      postDismissNotice: {
        text: t("inst.codex_usage_limit_luna_reserve", ""),  // instance name injected by daemon
        label: "codex-usage-limit-selected",
      },
    };
  }

  private unknownSelectionHoldDialog(): RuntimeDialog {
    return {
      pattern: /^\s*[›❯>]\s+\S/m,
      keys: [],
      description: "Codex interactive selection needs human input",
      holdOnly: true,
      blocksDelivery: true,
      inputBlocked: true,
      isActive: codexUnknownSelectionVisible,
    };
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      this.trustHoldDialog(),
      this.rateSwitchPickerDialog(),
      {
        // Codex 0.156 may change the wording/order of this credit-cost choice.
        // Never navigate it by position: a moved option could switch to a
        // more expensive model. A live picker holds delivery and notifies a
        // human; old transcript mentions are excluded by the tail matcher.
        pattern: /(?:Approaching rate limits|Switch to [^\r\n]{1,120} for lower credit usage\?)/i,
        keys: [],
        description: "Codex rate limit model switch dialog needs human choice",
        holdOnly: true,
        blocksDelivery: true,
        inputBlocked: true,
        isActive: codexRateSwitchVisible,
      },
      this.updatePickerDialog(),
      this.usageLimitLunaReserveDialog(),
      ...this.sessionHoldDialogs(),
      this.unknownSelectionHoldDialog(),
    ];
  }

  getInputUnavailableTransients(): InputUnavailableTransient[] {
    return [{
      pattern: /(?:^|\n)\s*Resuming session…\s*(?:\n|$)/,
      description: "Codex session resume in progress",
      isActive: (pane: string) => {
        const rows = pane.split(/\r?\n/);
        return codexBoxedResumeLoading(rows) || codexUnboxedResumeLoading(rows);
      },
    }];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    // The resumed thread is chosen per launch from Codex's own state DB
    // (planResume); AgEnD persists no session id of its own (#913 was reverted).
    return null;
  }

  /** Which Codex session this launch resumes (#984). Reads, never writes, Codex state. */
  private planResume(config: CliBackendConfig): CodexResumePlan {
    // Read the database Codex actually writes: the one in this instance's
    // CODEX_HOME. Normally that is a link to the shared file (same result).
    // But when the shared home had no state DB yet at the first launch, Codex
    // created a private one in the instance home, and the shared path reads
    // as missing for ever: every restart fell back to `--last` or a fresh
    // start (#1028). The shared file is only a fallback for an instance home
    // that has NO database. One that exists but cannot be read (corrupt, an
    // unknown schema) stays unreadable, with its warning: the shared file is
    // not what this CODEX_HOME resumes from, so answering from it could
    // silently start fresh or resume a session this home cannot see.
    const instanceDb = join(this.isolatedCodexHome, "state_5.sqlite");
    const sharedDb = join(this.sharedCodexHome, "state_5.sqlite");
    const lookup = existsSync(instanceDb) || sharedDb === instanceDb
      ? findExactCwdCodexSession(instanceDb, config.workingDirectory)
      : findExactCwdCodexSession(sharedDb, config.workingDirectory);
    return planCodexResume(lookup, () => {
      // Without the fleet's peer list the repository cannot be proven
      // sibling-free, so `--last` stays off the table.
      const peers = config.peerWorkingDirectories?.();
      return peers ? codexSiblingState(config.workingDirectory, peers) : "siblings";
    });
  }

  /** Only a resume paints "Resuming session…"; a fresh launch never does. */
  launchMayShowInputTransient(): boolean {
    return this.lastLaunchResumes;
  }

  consumeLaunchWarning(): string | null {
    const warnings = [this.statusLineWarning, this.launchWarning].filter((w): w is string => !!w);
    this.statusLineWarning = null;
    this.launchWarning = null;
    return warnings.length ? warnings.join("\n") : null;
  }

  getQuitCommand(): string { return "/quit"; }

  getCompactCommand(): string { return "/compact"; }
  getClearCommand(): string { return "/clear"; }

  getCancelKey(): string { return "Escape"; }

  // Codex has no `/effort`; reasoning effort is the `model_reasoning_effort`
  // config key (settable per launch with `-c`). The TUI reads it at startup, so
  // a change needs a respawn — restart, not runtime.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return EFFORT_CAPABILITIES.codex.strategy; }

  /**
   * Effort levels are PER MODEL in Codex, published in the same models_cache
   * that listModels reads (`supported_reasoning_levels`). Verified against a
   * live cache on 2026-08-03:
   *
   *   gpt-5.6-sol / -terra   low, medium, high, xhigh, max, ultra
   *   gpt-5.6-luna           low, medium, high, xhigh, max
   *   gpt-5.5 / 5.4 / -mini  low, medium, high, xhigh
   *
   * The old static ["low","medium","high"] under-reported every one of them —
   * /effort refused `xhigh` for models whose own default IS xhigh (gpt-5.5).
   * `model_reasoning_effort` is not validated by the CLI either (a bogus value
   * launches fine, verified live), so this list is the only guard rail.
   *
   * Levels outside the fleet's canonical ladder (`ultra`) are filtered out:
   * clampEffort and validateEffort know low…max, and offering a level the rest
   * of the pipeline rejects would break /effort in a worse way than omitting
   * it. Fallback when the cache or the model entry is missing: low…xhigh, the
   * floor every catalog model supports today.
   */
  getEffortLevels(): string[] {
    return readCodexEffortLevels({
      isolatedHome: this.isolatedCodexHome,
      sharedHome: this.sharedCodexHome,
      model: this.lastKnownModel,
    });
  }

  /** Model passed to the most recent buildCommand, when this backend launched the CLI. */
  private lastKnownModel: string | null = null;

  /**
   * Codex has no `codex models` command. Its TUI/app-server maintains an
   * account-aware model catalog in $CODEX_HOME/models_cache.json, so consume
   * that cache best-effort and hide internal-only entries. A small documented
   * fallback keeps `/model` usable before the first TUI catalog refresh.
   */
  async listModels(): Promise<ModelOption[]> {
    try {
      const isolatedCache = join(this.isolatedCodexHome, "models_cache.json");
      const cachePath = existsSync(isolatedCache)
        ? isolatedCache
        : join(this.sharedCodexHome, "models_cache.json");
      if (statSync(cachePath).size > CODEX_MODELS_CACHE_MAX_BYTES) {
        return CODEX_FALLBACK_MODELS.map(model => ({ ...model }));
      }

      const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as { models?: unknown };
      if (!Array.isArray(parsed.models)) throw new Error("missing models array");

      const seen = new Set<string>();
      const models: ModelOption[] = [];
      for (const raw of parsed.models) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        if (item.visibility === "hide" || item.hidden === true) continue;
        const id = typeof item.slug === "string" ? item.slug.trim() : "";
        if (!id || !SAFE_MODEL_ID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        const label = typeof item.display_name === "string" && item.display_name.trim()
          ? item.display_name.trim()
          : id;
        const description = typeof item.description === "string" && item.description.trim()
          ? item.description.trim()
          : undefined;
        models.push(description ? { id, label, description } : { id, label });
      }
      if (models.length > 0) return models;
    } catch { /* missing/stale/unknown cache format — use documented fallback */ }

    return CODEX_FALLBACK_MODELS.map(model => ({ ...model }));
  }

  /**
   * Make codex refetch its account catalog into models_cache.json.
   *
   * listModels() only reads that file; codex writes it. Measured on 0.156.0:
   * `codex debug models` fetches the catalog when the cache is older than
   * codex's own TTL (about five minutes — a 4-minute-old cache was served as
   * is, a 6-minute-old one was refetched) and rewrites the file with a new
   * `fetched_at`. `--bundled` would skip the fetch, so it is not passed.
   *
   * What this does NOT force: a cache codex fetched in the last ~5 minutes is
   * trusted by codex and returned unchanged. There is no flag to bypass that,
   * and a list at most five minutes old is not the staleness this exists for.
   *
   * Targets the same CODEX_HOME listModels() reads, so the refetch lands in the
   * file that is read next.
   */
  async refreshModelCatalog(): Promise<void> {
    const home = existsSync(join(this.isolatedCodexHome, "models_cache.json"))
      ? this.isolatedCodexHome
      : this.sharedCodexHome;
    await execFileAsync(this.binaryPath, ["debug", "models"], {
      env: { ...process.env, CODEX_HOME: home },
      timeout: CODEX_CATALOG_REFRESH_TIMEOUT_MS,
      maxBuffer: CODEX_MODELS_CACHE_MAX_BYTES * 2,
    });
  }

  async probeCLIEnv(): Promise<{ version?: string; models: ModelOption[]; currentModel?: string }> {
    // The configured model is readable from the isolated base config. Fall
    // back to the shared user config before this instance has been prepared.
    let currentModel: string | undefined;
    try {
      const isolatedConfig = join(this.isolatedCodexHome, "config.toml");
      const configPath = existsSync(isolatedConfig)
        ? isolatedConfig
        : join(this.sharedCodexHome, "config.toml");
      currentModel = readFileSync(configPath, "utf-8")
        .split("\n")
        .map(l => l.trim())
        .filter(l => !l.startsWith("#"))            // skip comments
        .map(l => l.match(/^model\s*=\s*["']([^"']+)["']/)?.[1])  // `model` only, not *_model
        .find((v): v is string => !!v);
    } catch { /* no config / unreadable */ }
    return { version: probeCliVersion(this.binaryPath), models: await this.listModels(), currentModel };
  }

  cleanup(config: CliBackendConfig): void {
    // Never mutate the shared Codex config from instance cleanup. Remove the
    // private AgEnD capability while preserving sessions and user settings.
    try {
      const configPath = join(this.isolatedCodexHome, "config.toml");
      const content = readFileSync(configPath, "utf-8");
      atomicWritePrivate(configPath, stripAgendMcpTables(content));
    } catch { /* best effort */ }
    this.cleanSharedConfig();

    // Remove fleet instructions marker block from AGENTS.md
    try {
      const agentsMd = join(config.workingDirectory, "AGENTS.md");
      const isEmpty = removeMarker(agentsMd, config.instanceName);
      if (isEmpty && existsSync(agentsMd)) unlinkSync(agentsMd);
    } catch { /* best effort */ }

    // Remove trust entry from the isolated Codex config.
    try {
      const configPath = join(this.isolatedCodexHome, "config.toml");
      const content = readFileSync(configPath, "utf-8");
      const escaped = config.workingDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\n?\\[projects\\."${escaped}"\\]\\ntrust_level = "trusted"\\n?`);
      if (re.test(content)) {
        atomicWritePrivate(configPath, content.replace(re, "\n"));
      }
    } catch { /* best effort */ }
  }
}
