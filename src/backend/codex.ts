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
import { lastNonBlankRow } from "../pane-input-residue.js";
import { basename, dirname, join, resolve } from "node:path";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type InputUnavailableTransient, type McpServerEntry, type ModelOption, type RuntimeDialog, type StartupDialog, probeCliVersion, resolveBinary, shellQuote, validateModel, validateProvider, warnIfModelMismatch } from "./types.js";
import {
  credentialHomeSpec,
  credentialProfileHome,
  prepareCredentialProfileHome,
  resolveCredentialProfile,
} from "./credential-profile.js";
import { getAgendHome } from "../paths.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";
import { t } from "../locale.js";
import { parse as parseToml } from "smol-toml";
import { CODEX_SESSION_ID, CodexResumeIdentityError, codexCurrentSessionFromPane, codexRolloutForId, codexSessionsForPane, codexSessionOwners, readCodexRolloutMeta, type CodexSessionRecord } from "./codex-session.js";

const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;
const CODEX_MODELS_CACHE_MAX_BYTES = 5 * 1024 * 1024;
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/;
const AGEND_MCP_CLEANUP_LOCK = ".agend-mcp-cleanup.lock";
const AGEND_MCP_CLEANUP_LOCK_STALE_MS = 30_000;
const SQLITE_SIDECAR_RE = /-(?:wal|shm|journal)$/;

function isCodexContextFooter(row: string): boolean {
  const context = String.raw`Context\s+\d+%\s+(?:left|used)`;
  const legacy = new RegExp(String.raw`^\s*${context}(?:\s+⚠\s+\d+\s+warnings?\b[^\r\n]*)?(?:\s+·\s+\S[^\r\n]*)?\s*$`, "i");
  if (legacy.test(row)) return true;
  // A narrow Codex 0.156 pane may truncate the context item after the
  // authoritative first `session-id` item. Keep structural readiness while
  // /ctx honestly reports context unavailable from a truncated percentage.
  return /^\s*[0-9a-f-]{36}\s+·\s+Context\b[^\r\n]*$/i.test(row);
}

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

type CodexResumeDirectoryPrompt = { active: boolean; sessionCwd: string | null; currentCwd: string | null; safeChoice: boolean };

/** Captured from Codex 0.156; only the live, bottom-of-pane four-choice menu. */
export function codexResumeDirectoryPromptState(pane: string): CodexResumeDirectoryPrompt {
  const empty: CodexResumeDirectoryPrompt = { active: false, sessionCwd: null, currentCwd: null, safeChoice: false };
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  let title = -1;
  for (let i = last; i >= Math.max(0, last - 20); i--) {
    if (/^\s{2}Working directory · resume\s*$/.test(rows[i])) { title = i; break; }
  }
  if (title < 0 || !/^\s{2}enter continue · esc use session · ctrl\+c quit\s*$/.test(rows[last])) return empty;
  const menu = rows.slice(title + 1, last);
  const one = menu.findIndex(row => /^› 1\. Use session directory \(/.test(row));
  if (one < 0) return empty;
  const options = menu.slice(one, one + 4);
  const first = options[0]?.match(/^› 1\. Use session directory \((\/[^)]+)\)$/);
  const second = options[1]?.match(/^  2\. Use current directory \((\/[^)]+)\)$/);
  const safeChoice = !!first && !!second
    && options[2] === "  3. Always use session directory"
    && options[3] === "  4. Always use current directory"
    && menu.slice(one + 4).every(row => row.trim() === "")
    && menu.slice(0, one).every(row => row.trim() === ""
      || /^\s{2}(?:Session = latest cwd recorded in the resumed session|Current = your current working directory)$/.test(row));
  return { active: true, sessionCwd: first?.[1] ?? null, currentCwd: second?.[1] ?? null, safeChoice };
}

/** Unknown variants still own stdin; only the exact canonical menu may be answered. */
export function codexResumeDirectoryVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  let title = -1;
  for (let i = last; i >= Math.max(0, last - 20); i--) {
    if (/^\s{2}Working directory · resume\s*$/.test(rows[i])) { title = i; break; }
  }
  if (title < 0) return false;
  const tail = rows.slice(title + 1, last + 1);
  return tail.some(row => /^\s*[›❯]?\s*1\. Use session directory\b/.test(row))
    && tail.some(row => /^\s*[›❯]?\s*2\. Use current directory\b/.test(row))
    && !tail.some(row => /[›❯]\s*(?:Ask Codex|Message Codex|Type a message)/i.test(row));
}

/** Codex's concurrent-owner screen is a hold, never an invitation to press R. */
export function codexResumeLockActive(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0 || !/^\s*r retry\s+esc\/ctrl\+c\/q exit(?:\s+ctrl\+t transcript)?\s*$/.test(rows[last])) return false;
  const recent = rows.slice(Math.max(0, last - 5), last);
  return recent.some(row => /^\s*🔒\s+This conversation is open in another app\b/.test(row))
    && recent.some(row => /^\s*Close it there and press R to continue here\.\s*$/.test(row));
}

/** A changed lock-screen footer is still a hold, never a ready prompt. */
export function codexResumeLockVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  const title = rows.findIndex((row, i) => i >= Math.max(0, last - 8)
    && /^\s*🔒\s+This conversation is open in another app\b/.test(row));
  if (title < 0) return false;
  const tail = rows.slice(title + 1, last + 1);
  return tail.some(row => /Close it there and press R to continue here\./.test(row))
    && !tail.some(row => /^\s*[›❯]\s*(?:Ask Codex|Message Codex|Type a message)/i.test(row));
}

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

/** Unknown pickers own stdin too; never type or press Enter into one. */
function codexUnknownSelectionVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n");
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim() === "") last--;
  if (last < 0 || !/\benter\b.*\besc\b/i.test(rows[last])) return false;
  let selected = -1;
  for (let i = last - 1; i >= Math.max(0, last - 24); i--) {
    if (/^\s*[›❯>]\s+\S/.test(rows[i])) { selected = i; break; }
  }
  if (selected < 0) return false;
  if (/^\s*[›❯>]\s+Ask Codex to do anything\b/.test(rows[selected])) return false;
  return !rows.slice(selected + 1, last + 1).some(row =>
    /^[›>]\s+Ask Codex to do anything\b/.test(row) || isCodexContextFooter(row));
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

/** macOS lockf and Linux flock both fail immediately with status 75 on contention. */
export function codexResumeClaimCommand(platform: NodeJS.Platform, lockPath: string, launch: string): string {
  // A child Codex exit 75 is remapped; only lock contention gets the marker.
  const child = `sh -c ${shellQuote(`${launch}; agend_child_status=$?; if [ "$agend_child_status" -eq 75 ]; then exit 74; fi; exit "$agend_child_status"`)}`;
  const guarded = platform === "darwin"
    ? `lockf -s -t 0 -k -w ${shellQuote(lockPath)} ${child}`
    : `flock -n -E 75 ${shellQuote(lockPath)} ${child}`;
  // Daemon prefixes this command with TERM/AGEND_* assignments. A shell
  // subshell is not a simple command (`VAR=x ( ... )` is a syntax error), but
  // `sh -c` is, so the same claim works in the real daemon launch line.
  return `sh -c ${shellQuote(`${guarded}; agend_resume_status=$?; if [ "$agend_resume_status" -eq 75 ]; then printf '%s\\n' '[agend:codex-session-held]'; fi; exit "$agend_resume_status"`)}`;
}

/** Explicit, stopped-instance recovery for an old conversation without an AgEnD owner record. */
export function attachCodexSession(instanceDir: string, sharedHome: string, currentCwd: string, id: string): void {
  if (!CODEX_SESSION_ID.test(id)) throw new Error("Codex session ID must be a UUID");
  if (existsSync(join(instanceDir, "window-id"))) throw new Error("Stop this instance before attaching a Codex session");
  // Startup writes daemon.pid before window-id. Require a clean stop rather
  // than race an instance still launching. An orphaned stale pid marker must
  // be inspected and removed manually, never inferred to be harmless here.
  if (existsSync(join(instanceDir, "daemon.pid"))) throw new Error("Stop this instance and clear its daemon PID marker before attaching a Codex session");
  const found = codexRolloutForId(sharedHome, id);
  if (!found) throw new Error("Codex session ID was not found in the shared session store");
  if (codexTrustPaths(found.cwd).root !== codexTrustPaths(currentCwd).root) {
    throw new Error("Codex session belongs to a different repository; refusing to attach");
  }
  if (codexSessionOwners(id).length > 0) throw new Error("Codex session has a live owner; close it before attaching");
  const record: CodexSessionRecord = { ...found, owner: basename(instanceDir) };
  atomicWritePrivate(join(instanceDir, "codex-session.json"), JSON.stringify(record));
  atomicWritePrivate(join(instanceDir, "session-id"), id);
  // Human-selected exact identity retires a prior ambiguous-live-pane hold.
  try { unlinkSync(join(instanceDir, "codex-session-unconfirmed")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
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

export class CodexBackend implements CliBackend {
  readonly binaryName = "codex";
  private binaryPath: string;
  private readonly sharedCodexHome: string;
  private readonly isolatedCodexHome: string;
  /** Which subscription this instance runs on, or null for the shared login. */
  private credentialProfile: string | null = null;
  /** Set only after preTrust wrote and read back this instance's private config. */
  private authorizedTrust: { cwd: string; root: string } | null = null;
  private activePanePid: number | null = null;
  private resumeRecord: CodexSessionRecord | null = null;
  private get unconfirmedSessionPath(): string { return join(this.instanceDir, "codex-session-unconfirmed"); }

  constructor(private instanceDir: string, private readonly procRoot = "/proc") {
    this.binaryPath = resolveBinary("codex");
    this.sharedCodexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    this.isolatedCodexHome = resolve(instanceDir, "codex-home");
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
    const rows = pane.replace(/\r/g, "").split("\n");
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    const footer = rows.pop() ?? "";
    // Codex preserves other configured status-line items after our session ID
    // and context meter (observed on 0.156.0: "Context 100% left · GPT-6-Astra").
    // They are footer chrome, not evidence that the input row is unavailable.
    if (!isCodexContextFooter(footer)) return false;
    // Pasted text may wrap over several continuation rows before the footer.
    // Search only its immediate tail, not a historical transcript prompt.
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 8); i--) {
      if (/^[>›]\s+\d+\./.test(rows[i])) return false;
      if (/^[>›]\s+\S/.test(rows[i])) return true;
      if (/^[•■⚠]/.test(rows[i])) return false;
    }
    return false;
  }

  /** Live status chrome that must veto the broad prompt/context ready match. */
  getBusyPattern(): RegExp {
    return /(?:^|\n)•\s+Working\b[^\n]*\besc to interrupt\b/i;
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
   * viewport, and reject a live status row immediately above it.  Transcript
   * quotes are indented by the TUI and, more importantly, cannot replace the
   * final live prompt/footer pair.
   */
  isPeriodicRedrawIdlePane(pane: string): boolean {
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
      if (isCodexContextFooter(rows[i])) {
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

    // Never select by CWD: two instances can share a worktree and --last may
    // select a session still owned by another app. A sidecar written from the
    // actual pane's open rollout + writer lock is the only automatic identity.
    // A present but unreadable/unknown-version record is NOT legacy absence.
    // Do not overwrite it with a fresh session even if a caller requested a
    // skip-resume recovery; a human must resolve this identity first.
    if (this.hasInvalidSessionIdentity(config.workingDirectory)) throw new CodexResumeIdentityError();
    this.resumeRecord = config.skipResume ? null : this.validResumeRecord(config.workingDirectory);
    let cmd: string;
    if (!this.resumeRecord) {
      cmd = `${this.binaryPath} ${approvalFlag}`;
    } else {
      cmd = `${this.binaryPath} resume ${shellQuote(this.resumeRecord.id)} ${approvalFlag}`;
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
    // CODEX_HOME is the only Codex-supported way to isolate the complete base
    // config. A profile only layers over the shared config and would therefore
    // still load every globally registered AgEnD MCP server.
    const launch = `CODEX_HOME=${shellQuote(this.isolatedCodexHome)} ${cmd}`;
    if (!this.resumeRecord) return launch;
    // The shared claim is held for the entire Codex process lifetime;
    // an atomic, cross-daemon fence closes the race between the owner probe and
    // spawn. Exit 75 is recognized as a held session, never a broken session.
    const claims = join(this.sharedCodexHome, ".agend-session-claims");
    mkdirSync(claims, { recursive: true, mode: 0o700 });
    return codexResumeClaimCommand(process.platform, join(claims, `${this.resumeRecord.id}.lock`), launch);
  }

  setActivePanePid(pid: number | null): void { this.activePanePid = pid; }

  /** A fresh launch has no resume identity; it must not be counted as --resume. */
  canResume(workingDirectory: string): boolean { return this.validResumeRecord(workingDirectory) !== null; }
  hasSessionIdentity(): boolean {
    return existsSync(join(this.instanceDir, "codex-session.json")) || existsSync(join(this.instanceDir, "session-id"))
      || existsSync(this.unconfirmedSessionPath);
  }
  hasInvalidSessionIdentity(workingDirectory: string): boolean {
    return existsSync(this.unconfirmedSessionPath) || (this.hasSessionIdentity() && !this.validResumeRecord(workingDirectory));
  }
  hasUnconfirmedSessionIdentity(): boolean { return existsSync(this.unconfirmedSessionPath); }
  /** Positive owner evidence, not merely a stale lock-file name on disk. */
  resumeOwner(workingDirectory: string): number | null {
    const record = this.validResumeRecord(workingDirectory);
    return record ? codexSessionOwners(record.id, this.procRoot).find(pid => pid !== process.pid) ?? null : null;
  }

  private validResumeRecord(workingDirectory: string): CodexSessionRecord | null {
    if (existsSync(this.unconfirmedSessionPath)) return null;
    try {
      const record = JSON.parse(readFileSync(join(this.instanceDir, "codex-session.json"), "utf8")) as CodexSessionRecord;
      if (!record || !CODEX_SESSION_ID.test(record.id) || record.owner !== basename(this.instanceDir)) return null;
      if (readFileSync(join(this.instanceDir, "session-id"), "utf8").trim() !== record.id) return null;
      const rollout = realpathSync(record.rolloutPath);
      const sessions = realpathSync(join(this.sharedCodexHome, "sessions"));
      if (!rollout.startsWith(`${sessions}/`)) return null;
      const meta = readCodexRolloutMeta(rollout);
      if (!meta || meta.id !== record.id || meta.cwd !== record.cwd) return null;
      // A moved worktree may legitimately have a different CWD in the saved
      // session. It must still be the same Git repository as the current CWD.
      const current = codexTrustPaths(workingDirectory);
      if (record.cwd !== current.cwd && codexTrustPaths(record.cwd).root !== current.root) return null;
      return record;
    } catch { return null; }
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
   * The first status-line item is Codex's own current session ID. Unlike fd
   * order, this changes when /new switches chats while old writer locks stay
   * open. Keep context too, then preserve all user-selected remaining items.
   * If the footer is hidden/truncated, checkpointing fails closed instead.
   */
  private enableContextStatusLine(): void {
    const configPath = join(this.isolatedCodexHome, "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch { /* no file yet */ }

    let existing: string[] | undefined;
    try {
      const parsed = parseToml(content) as { tui?: { status_line?: unknown } };
      if (parsed.tui?.status_line !== undefined) {
        if (!Array.isArray(parsed.tui.status_line)
          || !parsed.tui.status_line.every((item: unknown) => typeof item === "string")) return;
        existing = parsed.tui.status_line as string[];
      }
    } catch { return; }
    const tuiHeader = /^[ \t]*\[[ \t]*tui[ \t]*\][ \t]*(?:#.*)?$/m.exec(content);
    const tuiStart = tuiHeader ? tuiHeader.index + tuiHeader[0].length : -1;
    const nextHeader = tuiStart >= 0 ? /^[ \t]*\[/m.exec(content.slice(tuiStart)) : null;
    const tuiEnd = nextHeader ? tuiStart + nextHeader.index : content.length;
    const tuiBody = tuiStart >= 0 ? content.slice(tuiStart, tuiEnd) : "";
    const arr = /^[ \t]*status_line[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(tuiBody);
    if (existing && !arr) return; // an unfamiliar but valid TOML form: preserve it
    if (arr) {
      const items = existing!;
      const context = items.find(item => /^(?:context-remaining|context-usage|context-used)$/.test(item)) ?? "context-remaining";
      const ordered = ["session-id", context, ...items.filter(item => item !== "session-id" && item !== context)];
      const updatedBody = tuiBody.replace(arr[0], `\nstatus_line = ${JSON.stringify(ordered)}`);
      content = content.slice(0, tuiStart) + updatedBody + content.slice(tuiEnd);
    } else {
      if (content.length && !content.endsWith("\n")) content += "\n";
      if (tuiHeader) {
        content = content.slice(0, tuiStart) + '\nstatus_line = ["session-id", "context-remaining"]' + content.slice(tuiStart);
      } else {
        content += '\n[tui]\nstatus_line = ["session-id", "context-remaining"]\n';
      }
    }
    try {
      // A bad rewrite must not turn a working Codex configuration into a
      // startup failure. It merely loses the optional current-ID proof.
      parseToml(content);
      atomicWritePrivate(configPath, content);
    } catch { /* best effort — never block launch on statusline config */ }
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
   * Preserve Codex login/session/cache behavior while isolating config.toml.
   * Before this fix all instances shared CODEX_HOME, so sharing these runtime
   * files is intentionally unchanged. Only config.toml (which contains MCP
   * capabilities and AGEND_DECISIONS) becomes private to this instance.
   */
  /** Session dirs every instance must share with the terminal CLI (#506). */
  private static readonly SHARED_SESSION_DIRS = ["sessions", "archived_sessions"] as const;

  private prepareIsolatedHome(): void {
    mkdirSync(this.isolatedCodexHome, { recursive: true, mode: 0o700 });
    chmodSync(this.isolatedCodexHome, 0o700);
    if (this.sharedCodexHome === this.isolatedCodexHome) return;

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
    // by the Context footer at the *end* of the capture. getBusyPattern still
    // vetoes a working turn whose empty composer remains visible. Unknown TUI
    // layouts cannot claim readiness by merely rendering the old header.
    // U+22C6 is Codex's observed cosmetic starfield; it can be drawn in the
    // prompt, between prompt/footer, and below the footer. A drafted composer
    // is also idle once this same bottom footer proves it owns the screen.
    return /(?:^|\n)[>›][ \t⋆]+(?!\d+\.)\S[^\r\n]*\r?\n(?:[ \t⋆]*\r?\n){0,3}[ \t⋆]+(?:[0-9a-f-]{36}[ \t]+·[ \t]+)?Context[ \t]+(?:\d+%[ \t]+(?:left|used)|\d+…|…)[^\r\n]*(?:\r?\n[ \t⋆]*)*$/i;
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
      { pattern: /you've hit your usage limit/i, type: "quota", action: "pause", message: "Codex usage limit reached — upgrade plan required" },
      {
        // Codex reports an unknown model either as a TUI metadata fallback or
        // as a ChatGPT-account API rejection. Use whitespace-aware phrases so
        // capture-pane hard wraps do not hide either form.
        pattern: /model\s+metadata\s+for\s+['"][^'"]+['"]\s+not\s+found\.\s+defaulting\s+to\s+fallback\s+metadata|model\s+is\s+not\s+supported\s+when\s+using\s+codex\s+with\s+a\s+chatgpt\s+account/i,
        type: "model_error",
        action: "notify",
        message: "Codex model unavailable — use /model to switch",
      },
      {
        // A capacity rejection is a completed failed turn: Codex returns to its
        // prompt without an answer. Keep this anchored to the exact decorated
        // TUI line so ordinary prose about model capacity cannot pause an
        // otherwise healthy instance. The CLI is already ready again, so there
        // is no recovery state to wait for after the pause notification.
        pattern: /^⚠ Selected model is at capacity\. Please try a different model\.\r?$/m,
        type: "model_error",
        action: "pause",
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
        pattern: /^\s{2}Working directory · resume\s*$/m,
        keys: ["Down", "Enter"],
        description: "Codex verified resume directory — use this instance's current worktree",
        blocksDelivery: true,
        inputBlocked: true,
        autoResolutionKey: "codex-verified-resume-directory",
        isActive: pane => {
          const state = codexResumeDirectoryPromptState(pane);
          const record = this.resumeRecord;
          const authorized = this.authorizedTrust;
          return state.active && state.safeChoice && !!record && !!authorized
            && state.sessionCwd === record.cwd && state.currentCwd === authorized.cwd;
        },
      },
      this.resumeDirectoryHoldDialog(),
      this.resumeLockHoldDialog(),
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
      this.unknownSelectionHoldDialog(),
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

  private resumeDirectoryHoldDialog(): RuntimeDialog {
    return {
      pattern: /^\s{2}Working directory · resume\s*$/m,
      keys: [],
      description: "Codex resume directory needs verified session/worktree ownership",
      holdOnly: true,
      blocksDelivery: true,
      inputBlocked: true,
      isActive: codexResumeDirectoryVisible,
    };
  }

  private resumeLockHoldDialog(): RuntimeDialog {
    return {
      pattern: /This conversation is open in another app/,
      keys: [],
      description: "Codex conversation is open in another app — close that owner before a manual restart",
      holdOnly: true,
      blocksDelivery: true,
      inputBlocked: true,
      isActive: codexResumeLockVisible,
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
      // Bottom-anchored, so a transcript that quotes the picker (an agent
      // pasting a pane capture, this very change being reviewed) is not
      // mistaken for a live one: the real picker owns the bottom of the pane
      // and has no input row under it.
      isActive: (pane: string) => {
        const last = lastNonBlankRow(pane);
        return last != null && /^\s*Press enter to continue\s*$/.test(last);
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
      this.resumeDirectoryHoldDialog(),
      this.resumeLockHoldDialog(),
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
      this.unknownSelectionHoldDialog(),
    ];
  }

  getInputUnavailableTransients(): InputUnavailableTransient[] {
    return [{
      pattern: /(?:^|\n)\s*Resuming session…\s*(?:\n|$)/,
      description: "Codex session resume in progress",
      isActive: (pane: string) => {
        const rows = pane.split(/\r?\n/);

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
      },
    }];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(pane?: string): string | null {
    const panePid = this.activePanePid;
    if (!panePid) return null;
    const candidates = codexSessionsForPane(panePid, this.sharedCodexHome, this.procRoot);
    const displayedId = pane === undefined ? null : codexCurrentSessionFromPane(pane);
    // Once ambiguity has revoked the old identity, only fresh visible proof
    // can restore it. A later status callback without a pane cannot silently
    // re-arm the old sidecar just because one fd happened to close.
    if (existsSync(this.unconfirmedSessionPath) && !displayedId) return null;
    const active = candidates.length === 1
      ? displayedId && displayedId !== candidates[0].id ? null : candidates[0]
      : displayedId ? candidates.find(candidate => candidate.id === displayedId) ?? null : null;
    if (!active) {
      // `/new` keeps both native writer locks open even after a completed
      // turn. A null checkpoint must revoke the old resumable sidecar, not
      // leave it armed for a later wake into the wrong conversation.
      const oldId = (() => {
        try { return readFileSync(join(this.instanceDir, "session-id"), "utf8").trim(); }
        catch { return null; }
      })();
      const hasStoredIdentity = existsSync(join(this.instanceDir, "codex-session.json")) || oldId !== null;
      if (candidates.length > 1 || (displayedId && displayedId !== oldId)
        || (pane !== undefined && candidates.length === 0 && hasStoredIdentity)) {
        try { writeFileSync(this.unconfirmedSessionPath, "current Codex session unconfirmed\n", { flag: "wx", mode: 0o600 }); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
      }
      return null;
    }
    const record: CodexSessionRecord = { ...active, owner: basename(this.instanceDir) };
    const path = join(this.instanceDir, "codex-session.json");
    try {
      const prior = readFileSync(path, "utf8");
      if (prior === JSON.stringify(record)) {
        if (existsSync(this.unconfirmedSessionPath)) unlinkSync(this.unconfirmedSessionPath);
        return active.id;
      }
    } catch { /* first checkpoint */ }
    atomicWritePrivate(path, JSON.stringify(record));
    if (existsSync(this.unconfirmedSessionPath)) unlinkSync(this.unconfirmedSessionPath);
    return active.id;
  }

  getQuitCommand(): string { return "/quit"; }

  getCompactCommand(): string { return "/compact"; }
  getClearCommand(): string { return "/clear"; }

  getCancelKey(): string { return "Escape"; }

  // Codex has no `/effort`; reasoning effort is the `model_reasoning_effort`
  // config key (settable per launch with `-c`). The TUI reads it at startup, so
  // a change needs a respawn — restart, not runtime.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return "restart"; }

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
    const FALLBACK = ["low", "medium", "high", "xhigh"];
    const CANONICAL = new Set(["low", "medium", "high", "xhigh", "max"]);
    try {
      const model = this.configuredModel();
      if (!model) return FALLBACK;
      const isolatedCache = join(this.isolatedCodexHome, "models_cache.json");
      const cachePath = existsSync(isolatedCache)
        ? isolatedCache
        : join(this.sharedCodexHome, "models_cache.json");
      if (statSync(cachePath).size > CODEX_MODELS_CACHE_MAX_BYTES) return FALLBACK;
      const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as { models?: unknown };
      if (!Array.isArray(parsed.models)) return FALLBACK;
      const entry = parsed.models.find((m): m is Record<string, unknown> =>
        !!m && typeof m === "object" && (m as Record<string, unknown>).slug === model);
      const levels = (entry?.supported_reasoning_levels as { effort?: unknown }[] | undefined)
        ?.map(l => l?.effort)
        .filter((e): e is string => typeof e === "string" && CANONICAL.has(e));
      return levels?.length ? levels : FALLBACK;
    } catch {
      return FALLBACK;
    }
  }

  /** The model this instance launches with: instance config, else config.toml. */
  /** Model passed to the most recent buildCommand, when this backend launched the CLI. */
  private lastKnownModel: string | null = null;

  private configuredModel(): string | null {
    if (this.lastKnownModel) return this.lastKnownModel;
    for (const home of [this.isolatedCodexHome, this.sharedCodexHome]) {
      try {
        const m = readFileSync(join(home, "config.toml"), "utf-8")
          .match(/^model\s*=\s*"([^"]+)"/m);
        if (m) return m[1];
      } catch { /* try the next home */ }
    }
    return null;
  }

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
