import { measureSyncWork } from "./sync-work-attribution.js";
import { LOOPBACK_HOST_NAMES } from "./web-host-guard.js";
import { WEB_REMOTE_DOCS_URL } from "./upgrade-notices.js";
import { readFileSync, existsSync } from "node:fs";
import { exec, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, basename } from "node:path";
import { homedir, release } from "node:os";
import { createRequire } from "node:module";

const execAsync = promisify(exec);
import type { FleetContext } from "./fleet-context.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { formatCents } from "./cost-guard.js";
import { truncateDisplay, MODEL_DISPLAY_WIDTH_MAX } from "./ls-rows.js";
import { detectPlatform } from "./service-installer.js";
import { getTmuxSocketName, getTmuxSessionName } from "./paths.js";
import { t, getLocale } from "./locale.js";
import { commandSpec, decideCommand, telegramMenu, type TelegramMenu } from "./command-table.js";
import { runVisibilityCommand } from "./cross-instance-notice.js";
import type { ChannelConfig } from "./types.js";
import {
  clampContextPercent,
  parseContextPercent,
  parseTokenContextRatio,
  type TokenContextRatio,
} from "./context-percent.js";
import { isGeneralInstance } from "./general-instance.js";
import { backendSupportsSteer } from "./steer-capability.js";
import { SYSINFO_BACKEND_IDS, type BackendCliVersionSnapshot, type SysInfoBackendId } from "./backend/types.js";
import { recordInternalRequest, withOrigin } from "./fleet-control-audit.js";
import { UPDATE_COMMAND } from "./update-check.js";

export { parseContextPercent, parseTokenContextRatio } from "./context-percent.js";
export type { TokenContextRatio } from "./context-percent.js";

/** Longest one setMyCommands call may take. */
const TELEGRAM_COMMANDS_TIMEOUT_MS = 10_000;

type ExecutionFleetContext = FleetContext & {
  getInstanceExecutionState?(instanceName: string): "idle" | "working" | "stuck" | null;
};

/** Sanitize a directory name into a valid instance name. Keeps Unicode letters (incl. CJK). */
export function sanitizeInstanceName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^\p{L}\d-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "project";
}

/** Digits of the topic id kept in a fresh instance-name suffix; lengthened on collision. */
export const INSTANCE_NAME_SUFFIX_DIGITS = 6;

/**
 * Build `<base>-t<last N digits of topicId>` (#1301): when the full-id form
 * is free, N starts at 6 and lengthens on collision, up to the full id.
 * `exists` must cover fleet.yaml keys and instance dirs (a stale tmux window
 * with no config or dir is an orphan that startup cleanup kills — the
 * `-t<digits>` shape is what its matcher recognises). Every name this
 * allocator emits matches the orphan predicate (`isOrphanInstanceWindowName`),
 * so a deleted instance's leftover window is always reaped.
 *
 * A taken candidate is reused as-is ONLY when `isSameTopic` proves the
 * existing entry belongs to this same topic (retry/rebind of a partially
 * created instance keeps the deterministic old path instead of opening a
 * second entry) — this applies to the full form and to every short or
 * lengthened form, so a rebind never allocates a duplicate entry for one
 * topic (#1305 P2-2). A name owned by a *different* topic — including a
 * short suffix that happens to equal another topic's full id (e.g. Discord
 * `blog-t123456` vs Telegram topic `123456`) — is never reused. When even
 * the full-id form is taken by a different topic, allocation refuses with an
 * error (use a different `topic_name`) instead of inventing a non-`-t<digits>`
 * name, so one topic's bind can never overwrite another topic's
 * `working_directory`/`topic_id` (#1305 P1). When `isSameTopic` is omitted
 * the legacy rule applies (a taken full form is reused, taken short forms
 * are skipped); production callers always pass it. A dir-only collision (no
 * config) can never prove same-topic, so callers must report it as a
 * different topic.
 */
export function uniqueInstanceName(
  base: string,
  topicId: number | string,
  exists: (name: string) => boolean,
  isSameTopic?: (name: string) => boolean,
): string {
  const clean = sanitizeInstanceName(base);
  const id = String(topicId);
  const full = `${clean}-t${id}`;
  const candidates: string[] = [];
  for (let n = Math.min(INSTANCE_NAME_SUFFIX_DIGITS, id.length); n < id.length; n++) {
    candidates.push(`${clean}-t${id.slice(-n)}`);
  }
  candidates.push(full);
  // First pass: reuse any candidate already owned by this same topic
  // (retry/rebind keeps the deterministic old path instead of opening a
  // second entry). Every candidate is scanned before anything is allocated:
  // a freed shorter form must not shadow a longer form this topic still owns.
  // Without a proof function the legacy rule applies (a taken full form is
  // reused, taken short forms are skipped).
  for (const name of candidates) {
    if (exists(name) && (isSameTopic?.(name) ?? name === full)) return name;
  }
  // Second pass: the first free candidate, short first.
  for (const name of candidates) {
    if (!exists(name)) return name;
  }
  // Even the full-id form is owned by a different topic: refuse. Callers
  // surface this (handleCreate responds an error and rolls back the topic;
  // bindAndStart throws), so creation fails closed with a clear hint.
  throw new Error(
    `Instance name "${full}" is already used by a different topic; ` +
    `use a different topic_name for topic "${id}".`,
  );
}

/**
 * Base user-facing label for one instance name (#1301): an explicit
 * display_name wins; otherwise only a full snowflake-length `-t<digits>`
 * suffix (19+ digits, the pre-2.1.12 form) is shortened to its last 6,
 * keeping the `-t` shape. Allocator-lengthened suffixes (7–18 digits, #1301
 * collision path) are shown whole. This is only the *base* label — two
 * legacy 19-digit names sharing tail6 still shorten identically, so every
 * fleet renderer must go through `assignDisplayLabels`, which disambiguates
 * against the whole fleet (#1305 P2-1). Agent-facing uses (the `[from:…]`
 * header, logs, lookups) keep the real name — agents address by it.
 */
export function displayInstanceName(name: string, displayName?: string | null): string {
  const dn = displayName?.trim();
  if (dn) return dn;
  return name.replace(/-t(\d{19,})$/, (_, digits: string) => `-t${digits.slice(-6)}`);
}

/**
 * Fleet-wide effective display labels (#1305 P2-1). The base label is
 * shortened only while it stays unique across every entry's effective label
 * — legacy (19-digit), new short, lengthened, and explicit `display_name`
 * entries all compete in one namespace. On collision a `-t<digits>` name
 * lengthens its shown tail just enough to be unique; an explicit
 * `display_name` collision (or an exhausted digit tail) is qualified with the
 * real name. Lookup names are untouched — only the shown label changes.
 * Entries are processed in name order so the result is deterministic.
 */
export function assignDisplayLabels(
  entries: { name: string; displayName?: string | null }[],
): Map<string, string> {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const { name, displayName } of sorted) {
    const explicit = displayName?.trim() || undefined;
    let label = explicit ?? displayInstanceName(name);
    if (used.has(label)) label = disambiguateLabel(name, explicit, label, used);
    used.add(label);
    out.set(name, label);
  }
  return out;
}

function disambiguateLabel(
  name: string,
  explicit: string | undefined,
  base: string,
  used: Set<string>,
): string {
  if (!explicit) {
    const m = name.match(/^(.*-t)(\d+)$/);
    if (m) {
      const [, prefix, digits] = m;
      const shown = digits.length >= 19 ? 6 : digits.length;
      for (let len = shown + 1; len <= digits.length; len++) {
        const candidate = `${prefix}${digits.slice(-len)}`;
        if (!used.has(candidate)) return candidate;
      }
    }
  }
  // Every fallback is checked against the same namespace: real names are
  // unique, but they are NOT unique against arbitrary display_name strings,
  // so even the real-name-shaped fallback must be verified. The numbered
  // loop always terminates (i is unbounded) and is deterministic for a
  // given fleet, since entries are processed in name order.
  const short = displayInstanceName(name);
  let candidate = `${base} (${short})`;
  for (let i = 2; used.has(candidate); i++) {
    candidate = `${base} (${short}) (#${i})`;
  }
  return candidate;
}

/** Allowed filename for /save and /load (no path separators, no shell/inject chars). */
export const SAVE_FILENAME_RE = /^[\w.-]+$/;

/** Backends with a native side-question command that does not steer the active turn. */
export const BTW_SUPPORTED_BACKENDS = new Set(["claude-code"]);

/**
 * Build the backend-specific session-save command, or null if the backend has no
 * /save equivalent. kiro-cli → `/chat save <name>`; claude-code → `/export <name>.md`.
 */
export function saveCommandForBackend(backend: string, filename: string, force = false): string | null {
  if (backend === "kiro-cli") return force ? `/chat save ${filename} -f` : `/chat save ${filename}`;
  if (backend === "claude-code") return `/export ${filename}.md`;
  return null;
}

/** Extract the filename argument from `/save <name>` or `/save@bot <name>`. */
export function parseSaveFilename(text: string): string {
  const m = text.match(/^\/save(?:@\S+)?(?:\s+(.*))?$/);
  return (m?.[1] ?? "").trim();
}

/** Shared message when a backend doesn't support /save. */
/** @deprecated Prefer t("save.unsupported") at the user-facing call site. */
export const SAVE_UNSUPPORTED_MSG = "⚠️ /save is not supported for this backend (only Kiro CLI and Claude Code).";

export function parsePauseWakeCommand(text: string): { action: "pause" | "wake"; instance?: string } | null {
  const match = text.match(/^\/(pause|wake)(?:@\S+)?(?:\s+(\S+))?$/);
  if (!match) return null;
  return { action: match[1] as "pause" | "wake", instance: match[2] };
}

/**
 * The in-session compact/context-reset command for a backend NAME (the fleet
 * process routes /compact via IPC and only has the backend string, not a
 * CliBackend instance). Keep in sync with each backend's getCompactCommand().
 * Most CLIs (claude-code, kiro-cli, codex, opencode) use "/compact".
 * Antigravity (agy) has NO summarizing compact — its only manual context-reset
 * is "/clear" (a full reset; it also auto-summarizes at a token threshold).
 */
/** os.release(), guarded — purely informational, must never break /sysinfo. */
function osRelease(): string {
  try { return release(); } catch { return "?"; }
}

/**
 * `tmux -V`, memoised. One short synchronous exec for the lifetime of the
 * process — /sysinfo is on-demand and rare, and the version cannot change under
 * a running fleet (the server would have to restart with it).
 */
let cachedTmuxVersion: string | null = null;
function tmuxVersion(): string {
  if (cachedTmuxVersion === null) {
    try {
      cachedTmuxVersion = measureSyncWork("topic.tmuxVersion", () => execFileSync("tmux", ["-V"], { encoding: "utf-8", timeout: 3000 }).trim());
    } catch {
      cachedTmuxVersion = "not found";
    }
  }
  return cachedTmuxVersion;
}

const SYSINFO_BACKEND_LABEL_KEYS: Record<SysInfoBackendId, string> = {
  "claude-code": "sysinfo.backend_cli_claude_code",
  codex: "sysinfo.backend_cli_codex",
  "kiro-cli": "sysinfo.backend_cli_kiro_cli",
  grok: "sysinfo.backend_cli_grok",
  antigravity: "sysinfo.backend_cli_antigravity",
  muse: "sysinfo.backend_cli_muse",
};

function backendCliLines(versions?: BackendCliVersionSnapshot): string[] {
  return [
    `**${t("sysinfo.backend_clis")}**`,
    ...SYSINFO_BACKEND_IDS.map(id => {
      const label = t(SYSINFO_BACKEND_LABEL_KEYS[id]);
      const info = versions?.[id];
      const version = info?.version
        ?? (info?.probing ? t("sysinfo.cli_version_probing") : t("sysinfo.cli_version_unknown"));
      return `- ${label}: ${version}`;
    }),
  ];
}

export function compactCommandForBackend(backend: string): string {
  if (backend === "antigravity") return "/clear";
  return "/compact";
}

/**
 * Backends whose `/compact` verifiably takes custom summarization instructions
 * (#1145). Checked against the real CLIs, not assumed:
 *  - claude-code 2.1.288: `/compact <text>` appends the text to the summary
 *    request under `Additional Instructions:` (confirmed in the request body).
 *  - codex 0.160.0: `/compact <text>` is NOT a compaction — the whole line is
 *    submitted as an ordinary chat message. Passing the text would turn a
 *    compact into a prompt, so it must never be appended.
 *  - grok 1.0.46: the binary answers "/compact takes no arguments."
 *  - opencode 1.18: `/compact` calls session.summarize with no text.
 *  - kiro-cli: takes none (audit); antigravity has no summarizing compact.
 *  - muse 1.4.2: accepts the line (empty session: "nothing to summarize") but
 *    no use of the text is verifiable — unsupported until shown otherwise.
 */
export function backendSupportsCompactInstructions(backend: string): boolean {
  return backend === "claude-code";
}

/** Longest custom-instructions text AgEnD pastes (one line; refused, never truncated, beyond it). */
export const COMPACT_INSTRUCTIONS_MAX = 1000;

/**
 * One line, no control characters: the text is pasted into a TUI whose Enter
 * submits it, so a newline would end the command and run the rest as a message.
 * Blank means "none" (Claude Code ignores whitespace-only text the same way).
 */
export function normalizeCompactInstructions(raw: unknown): string {
  return String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The optional argument of a typed `/compact [@bot] [instructions]`, or null when the text is not /compact. */
export function parseCompactCommand(text: string): { instructions: string } | null {
  const match = text.trim().match(/^\/compact(?:@\S+)?(?:\s+([\s\S]*))?$/);
  return match ? { instructions: match[1] ?? "" } : null;
}

/**
 * Full conversation-reset command for a backend NAME. Keep this routing-only
 * lookup in sync with CliBackend.getClearCommand(); the fleet process does not
 * own the backend object that lives inside each daemon.
 */
export function clearCommandForBackend(backend: string): string | null {
  switch (backend) {
    case "claude-code":
    case "codex":
    case "kiro-cli":
    case "antigravity":
    case "opencode":
    case "muse":
    case "mock":
      return "/clear";
    case "grok":
      return "/new";
    default:
      return null;
  }
}

/** @deprecated Prefer t("clear.unsupported") at the user-facing call site. */
export const CLEAR_UNSUPPORTED_MSG = "⚠️ Clear is not supported for this backend.";

/**
 * Extract context-usage % from a captured CLI pane. Scans bottom-up so the
 * MOST RECENT prompt wins (a captured scrollback may hold several). Covers the
 * common CLI prompt formats:
 *   kiro-cli classic:  "6% !>"        kiro-cli TUI: "◔ 6%" (any pie glyph)
 *   bracketed:         "[6%]"         claude/others prompt: "6% ❯" / "6% >"
 *   codex TUI footer:  "Context 94% left" (remaining) or "Context 6% used"
 *   opencode footer:   "1.2K (6%)"   (token count then parenthesized %)
 *   grok title bar:     "12K / 500K" (used tokens / context window)
 * All values returned are context USED (low % = fresh session); codex's
 * "N% left" is remaining, so it's inverted to 100 - N.
 */
export function formatContextUsageLine(context: number, tokenRatio: TokenContextRatio | null = null): string {
  const rounded = Math.round(context);
  const localized = t("ctx.used", rounded);
  return tokenRatio
    ? localized.replace(`${rounded}%`, `${tokenRatio.usedLabel} / ${tokenRatio.totalLabel} (${rounded}%)`)
    : localized;
}

/** Claude Code statusline.json context used % (null if missing / unreadable). */
export function readStatuslineContextPct(dataDir: string, instanceName: string): number | null {
  return measureSyncWork("topic.readStatuslineContextPct", () => readStatuslineContextPctSync(dataDir, instanceName));
}
function readStatuslineContextPctSync(dataDir: string, instanceName: string): number | null {
  try {
    const statusFile = join(dataDir, "instances", instanceName, "statusline.json");
    if (!existsSync(statusFile)) return null;
    const data = JSON.parse(readFileSync(statusFile, "utf-8"));
    const pct = data.context_window?.used_percentage;
    return clampContextPercent(pct);
  } catch {
    return null;
  }
}

/**
 * Claude Code's statusline payload reports the model that actually served the
 * current session. This can differ from fleet.yaml after the CLI rejects a
 * plan-gated model and keeps using its previous/default model.
 */
export function readStatuslineModel(dataDir: string, instanceName: string): string | null {
  return measureSyncWork("topic.readStatuslineModel", () => readStatuslineModelSync(dataDir, instanceName));
}
function readStatuslineModelSync(dataDir: string, instanceName: string): string | null {
  try {
    const statusFile = join(dataDir, "instances", instanceName, "statusline.json");
    if (!existsSync(statusFile)) return null;
    const data = JSON.parse(readFileSync(statusFile, "utf-8"));
    const id = typeof data.model?.id === "string" ? data.model.id.trim() : "";
    const displayName = typeof data.model?.display_name === "string"
      ? data.model.display_name.trim()
      : "";
    if (displayName && id && displayName !== id) return `${displayName} (${id})`;
    return id || displayName || null;
  } catch {
    return null;
  }
}

/** Live-pane scrape used by /ctx, /status Ctx, and /view sidebar. */
export function scrapePaneContext(
  instanceName: string,
  backend: string,
): { context: number | null; tokenRatio: TokenContextRatio | null } {
  try {
    const socketName = getTmuxSocketName();
    // Scrollback (-S -60) so a recent footer/statusline is kept even mid-output.
    const baseArgs = ["capture-pane", "-t", `${getTmuxSessionName()}:${instanceName}`, "-p", "-S", "-60"];
    const tmuxArgs = socketName ? ["-L", socketName, ...baseArgs] : baseArgs;
    const pane = measureSyncWork("topic.scrapePaneContext", () => execFileSync("tmux", tmuxArgs, {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    const tokenRatio = backend === "grok" ? parseTokenContextRatio(pane) : null;
    const context = tokenRatio?.percentage ?? parseContextPercent(pane);
    return { context, tokenRatio };
  } catch {
    return { context: null, tokenRatio: null };
  }
}

const paneContextCache = new Map<string, { at: number; context: number | null; tokenRatio: TokenContextRatio | null }>();
// Below the dashboard's 10s SSE tick on purpose: at the previous 12s the cache was
// guaranteed to be stale on roughly every other tick, which is what made the
// blocking scrape fire so often. Now a tick either hits the cache or triggers a
// background refresh, never a synchronous capture.
const PANE_CONTEXT_CACHE_MS = 8_000;
/** Instances with a background scrape in flight, so polls don't pile up captures. */
const paneScrapeInFlight = new Set<string>();

/** Async twin of scrapePaneContext — same parsers, no blocking. */
async function scrapePaneContextAsync(
  instanceName: string,
  backend: string,
): Promise<{ context: number | null; tokenRatio: TokenContextRatio | null }> {
  try {
    const socketName = getTmuxSocketName();
    const baseArgs = ["capture-pane", "-t", `${getTmuxSessionName()}:${instanceName}`, "-p", "-S", "-60"];
    const tmuxArgs = socketName ? ["-L", socketName, ...baseArgs] : baseArgs;
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const { stdout } = await promisify(execFile)("tmux", tmuxArgs, { encoding: "utf-8", timeout: 2000 });
    const pane = stdout.toString();
    const tokenRatio = backend === "grok" ? parseTokenContextRatio(pane) : null;
    return { context: tokenRatio?.percentage ?? parseContextPercent(pane), tokenRatio };
  } catch {
    return { context: null, tokenRatio: null };
  }
}

/** Refresh one instance's cached context in the background (deduped per instance). */
function refreshPaneContext(instanceName: string, backend: string): void {
  if (paneScrapeInFlight.has(instanceName)) return;
  paneScrapeInFlight.add(instanceName);
  void scrapePaneContextAsync(instanceName, backend)
    .then(scraped => { paneContextCache.set(instanceName, { at: Date.now(), ...scraped }); })
    .finally(() => { paneScrapeInFlight.delete(instanceName); });
}

/** Forget a deleted instance's cached context so the map can't grow forever. */
export function forgetInstanceContext(instanceName: string): void {
  paneContextCache.delete(instanceName);
}

/**
 * Single source of truth for instance context % across /ctx, /status, and View.
 * Claude-code prefers statusline.json (authoritative, no TUI scrape); everyone
 * else scrapes the live pane with the same parsers /ctx uses.
 *
 * Non-blocking by default (stale-while-revalidate): a fresh cache entry is
 * returned as-is; a stale or missing one is returned immediately anyway while a
 * background refresh runs. This used to scrape synchronously with `execFileSync`
 * (2s timeout) on a cache miss, and the 12s TTL is LONGER than the dashboard's
 * 10s poll — so roughly every other tick did N blocking captures. With ten
 * non-claude-code instances and a slow tmux that froze the entire fleet event
 * loop for up to 20s per tick: no IPC, no message delivery, no watchdog ping.
 * Three open browser tabs ran three independent polls.
 *
 * Pass `bypassCache` for a synchronous, authoritative read — used by `/ctx`,
 * where a user is asking right now and 2s of blocking is the correct trade.
 */
export function resolveInstanceContext(
  dataDir: string,
  instanceName: string,
  backend: string,
  opts?: { bypassCache?: boolean },
): { context: number | null; tokenRatio: TokenContextRatio | null } {
  if (backend === "claude-code") {
    const fromFile = readStatuslineContextPct(dataDir, instanceName);
    if (fromFile != null) return { context: fromFile, tokenRatio: null };
  }

  if (opts?.bypassCache) {
    const scraped = scrapePaneContext(instanceName, backend);
    paneContextCache.set(instanceName, { at: Date.now(), ...scraped });
    return scraped;
  }

  const hit = paneContextCache.get(instanceName);
  if (hit && Date.now() - hit.at < PANE_CONTEXT_CACHE_MS) {
    return { context: hit.context, tokenRatio: hit.tokenRatio };
  }

  // Stale or absent: kick off the refresh and answer with what we have. A brand-new
  // instance reads as "no data" for one tick rather than blocking the fleet.
  refreshPaneContext(instanceName, backend);
  return hit ? { context: hit.context, tokenRatio: hit.tokenRatio } : { context: null, tokenRatio: null };
}

const PROFILE_RE = /^\/profile(?:@\w+)?(?:\s+([\s\S]*))?$/;
const RESTART_RE = /^\/restart(?:@[A-Za-z0-9_]*)?(?:\s+(.*))?$/i;
const LEGACY_INSTALL_RE = /^\/install[-_]cli(?:@\S+)?(?:\s+([\s\S]*))?$/;
const VISIBILITY_RE = /^\/visibility(?:@\S+)?(?:\s+([\s\S]*))?$/i;
/** `/name` or `/name@bot`. */
const bare = (name: string) => (text: string) => text === `/${name}` || text.startsWith(`/${name}@`);
/** `/name`, `/name@bot`, or `/name <args>`. */
const withArgs = (name: string) => (text: string) => bare(name)(text) || text.startsWith(`/${name} `);
type TypedForms = ReadonlyArray<readonly [string, (text: string, source: string | undefined) => boolean]>;

/**
 * The typed forms each dispatcher runs, in its order. The one recognizer for both the command-table gate and the
 * dispatch (#1399 review): a form no handler runs (`/STATUS`, `/status report`, `/pause one two`) is text for the
 * agent, and the table never answers it either.
 */
const GENERAL_FORMS: TypedForms = [
  ["profile", (text, source) => source === "telegram" && PROFILE_RE.test(text)],
  ["status", bare("status")],
  ["restart", text => RESTART_RE.test(text)],
  ["sysinfo", text => bare("sysinfo")(text) || text === "/sys-info" || text === "/sys_info"],
  ["doctor", bare("doctor")],
  ["usage", bare("usage")],
  ["tips", withArgs("tips")],
  ["login", withArgs("login")],
  ["install-cli", text => LEGACY_INSTALL_RE.test(text)],
  ["update", bare("update")],
  ["dashboard", withArgs("dashboard")],
  ["visibility", text => VISIBILITY_RE.test(text)],
];
const INSTANCE_FORMS: TypedForms = [
  ["tips", withArgs("tips")],
  ["pause", text => parsePauseWakeCommand(text)?.action === "pause"],
  ["wake", text => parsePauseWakeCommand(text)?.action === "wake"],
  ["collab", bare("collab")],
  ["effort", withArgs("effort")],
  ["model", withArgs("model")],
  ["compact", text => parseCompactCommand(text) !== null],
  ["steer", withArgs("steer")],
  ["btw", withArgs("btw")],
  ["clear", bare("clear")],
  ["cancel", bare("cancel")],
  ["save", withArgs("save")],
  ["raw", text => text === "/raw" || text.startsWith("/raw ")],
  ["ctx", bare("ctx")],
];
const typedCommand = (forms: TypedForms, text: string, source: string | undefined): string | undefined =>
  forms.find(([, matches]) => matches(text, source))?.[0];
/** A typed name that is another spelling of a command-table entry. */
const TELEGRAM_COMMAND_ALIASES: Readonly<Record<string, string>> = { "install-cli": "login" };

export class TopicCommands {
  constructor(private ctx: ExecutionFleetContext) {}

  /** Get the adapter that should reply to a given inbound message */
  /**
   * #754: who may run a typed Telegram command is decided by the command table — the same rule a Discord slash
   * command goes through (`decideCommand`), here with its Telegram column — before any handler runs. `msg.adapterId`
   * is the topic's owning adapter (ownedCopy), so the admin it asks about is that bot's. A command the table does not
   * know (`/raw`) or does not handle here (a passthrough cell) is left to the handlers below. `command` is what the
   * dispatcher recognized (GENERAL_FORMS / INSTANCE_FORMS), so the table judges exactly what would run.
   *
   * Synchronous on purpose (#1399 review): the decision, the handler's own checks and the command's effect run in one
   * stretch, so the instance cannot be rebound to another bot between the check and the act. The refusal, if any.
   */
  private tableRefusal(msg: InboundMessage, command: string | undefined, scope: "general" | "fleet"): [string, ...unknown[]] | null {
    const spec = command ? commandSpec(TELEGRAM_COMMAND_ALIASES[command] ?? command) : undefined;
    if (!spec) return null;
    const fleetAdmin = (): "ok" | "disabled" | "denied" => this.ctx.isFleetAdmin(msg.userId, msg.adapterId) ? "ok"
      : this.ctx.hasFleetAdmins && !this.ctx.hasFleetAdmins(msg.adapterId) ? "disabled" : "denied";
    const decision = decideCommand(spec, scope, {
      fleetAdmin,
      // In a fleet topic the channel's own admin IS the owning bot's fleet admin.
      channelAdmin: () => fleetAdmin() === "ok",
      classicAdmin: () => false,
    }, "telegram");
    if (decision.allow || "passthrough" in decision) return null;
    return decision.reply as [string, ...unknown[]];
  }

  private async sendRefusal(msg: InboundMessage, [key, ...args]: [string, ...unknown[]]): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (adapter) await adapter.sendText(msg.chatId, t(key, ...(args as never[])), { threadId: msg.threadId }).catch(() => {});
  }

  private getReplyAdapter(msg: InboundMessage): ChannelAdapter | null {
    if (msg.adapterId && this.ctx.adapters) {
      return this.ctx.adapters.get(msg.adapterId) ?? this.ctx.adapter;
    }
    return this.ctx.adapter;
  }

  /**
   * #1346: keep only the owning adapter's copy. When several bots share a
   * guild they each receive the same message; the copy that wins the
   * cross-adapter dedup race is arbitrary, so commands must not follow the
   * receiver. A non-owner copy runs no command and answers nothing (null) —
   * the message falls through to normal delivery, which canonicalizes
   * routing to the owner. Replies and permission checks below then use the
   * owner automatically. Without an instance (or owner info) there is
   * nothing to judge by and the copy proceeds as before.
   */
  private ownedCopy(msg: InboundMessage, instanceName?: string): InboundMessage | null {
    if (!instanceName) return msg;
    const owner = this.ctx.getInstanceAdapterId?.(instanceName);
    if (!msg.adapterId || !owner || msg.adapterId === owner) {
      return !msg.adapterId && owner ? { ...msg, adapterId: owner } : msg;
    }
    return null;
  }

  /** Parse and dispatch commands from the General topic */
  async handleGeneralCommand(msg: InboundMessage, instanceName?: string): Promise<boolean> {
    const owned = this.ownedCopy(msg, instanceName);
    if (!owned) return false;
    msg = owned;
    const text = msg.text?.trim();
    if (!text) return false;
    const command = typedCommand(GENERAL_FORMS, text, msg.source);
    const refusal = this.tableRefusal(msg, command, "general");
    if (refusal) { await this.sendRefusal(msg, refusal); return true; }

    if (command === "profile") {
      await this.ctx.runProfileCommand?.(msg, text.match(PROFILE_RE)![1]?.trim());
      return true;
    }

    if (command === "status") {
      await this.handleStatusCommand(msg);
      return true;
    }

    if (command === "restart") {
      const mode = text.match(RESTART_RE)![1]?.trim().toLowerCase();
      await this.handleRestartCommand(msg, mode);
      return true;
    }

    if (command === "sysinfo") {
      await this.handleSysInfoCommand(msg);
      return true;
    }

    if (command === "doctor") {
      await this.handleDoctorCommand(msg);
      return true;
    }

    if (command === "usage") {
      await this.handleUsageCommand(msg);
      return true;
    }

    if (command === "tips") {
      await this.handleTipsCommand(msg);
      return true;
    }

    if (command === "login") {
      await this.handleLoginCommand(msg);
      return true;
    }

    // `/install-cli` became part of `/login` (#1131). Typed, it still works for
    // one release (2.1.10) — with a line saying where it went — and is in no
    // command menu. Both spellings: Telegram command names cannot contain "-".
    if (command === "install-cli") {
      const legacyInstall = text.match(LEGACY_INSTALL_RE)!;
      const adapter = this.getReplyAdapter(msg);
      if (adapter) await adapter.sendText(msg.chatId, t("login.install_cli_moved"), { threadId: msg.threadId }).catch(() => {});
      const rest = (legacyInstall[1] ?? "").trim();
      const mapped = rest === "" ? "/login" : `/login ${rest}`;
      await this.handleLoginCommand({ ...msg, text: mapped });
      return true;
    }


    if (command === "update") {
      await this.handleUpdateCommand(msg);
      return true;
    }

    if (command === "dashboard") {
      await this.handleDashboardCommand(msg);
      return true;
    }

    if (command === "visibility") {
      await this.handleVisibilityCommand(msg, text.match(VISIBILITY_RE)![1] ?? "");
      return true;
    }

    return false;
  }

  /**
   * Pure, secret-free dashboard/menu copy. Issuance belongs to the private
   * delivery action; rendering or previewing this text cannot retire a code.
   */
  getDashboardText(_htmlSpoiler = false, showRemoteHint = true): string {
    const port = this.ctx.fleetConfig?.health_port ?? 19280;
    const host = (this.ctx.fleetConfig as { hostname?: string } | null | undefined)?.hostname || "localhost";
    const access = this.ctx.getDashboardAccess?.();
    if (!access?.ready || !access.token) return t("dashboard.starting");
    const base = `http://${host}:${port}`;
    return [
      t("dashboard.title"),
      "",
      t("dashboard.signin", base),
      "",
      `• View:      ${base}/view`,
      `• Dashboard: ${base}/ui`,
      `• Settings:  ${base}/settings`,
      "",
      t("dashboard.code_help"),
      // #1366: a loopback address does not open on a phone — say where the way in is documented.
      ...(showRemoteHint && (LOOPBACK_HOST_NAMES.includes(host.toLowerCase()) || host === "::1") ? ["", t("dashboard.remote_hint", WEB_REMOTE_DOCS_URL)] : []),
    ].join("\n");
  }

  /**
   * /dashboard (TG): admin-only menu in General; codes are sent privately.
   * `/dashboard revoke` also closes the public link and signs browsers out.
   */
  private async handleDashboardCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;
    // The caller's own adapter decides, and an empty list means the command is off for everyone.
    if (!this.ctx.hasFleetAdmins(msg.adapterId)) { await adapter.sendText(chatId, t("dashboard.disabled"), { threadId }); return; }
    if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) { await adapter.sendText(chatId, t("not_authorized"), { threadId }); return; }

    const arg = (msg.text ?? "").trim().replace(/^\/dashboard(?:@\S+)?/i, "").trim().toLowerCase();
    if (arg === "revoke") {
      const result = this.ctx.revokeWebSessions?.() ?? { count: 0, durable: true };
      // Not durable: they are signed out now, but a restart may bring them back — say so, never "done".
      await adapter.sendText(chatId, result.durable ? t("dashboard.revoked", result.count) : t("dashboard.revoked_not_durable", result.count), { threadId });
      return;
    }

    if (msg.source === "telegram") await this.ctx.dashboardMenu?.(msg);
    else await adapter.sendText(chatId, this.getDashboardText(), { threadId });
  }

  /** Handle /ctx or /compact in any instance topic — returns true if handled */
  async handleInstanceCommand(msg: InboundMessage, instanceName: string): Promise<boolean> {
    const owned = this.ownedCopy(msg, instanceName);
    if (!owned) return false;
    msg = owned;
    const text = msg.text?.trim();
    if (!text) return false;
    const command = typedCommand(INSTANCE_FORMS, text, msg.source);
    const refusal = this.tableRefusal(msg, command, this.ctx.fleetConfig?.instances[instanceName]?.general_topic ? "general" : "fleet");
    if (refusal) { await this.sendRefusal(msg, refusal); return true; }

    // Tips are informational and should appear where requested, including a
    // worker topic. This also keeps Telegram text commands aligned with
    // Discord's channel-local slash-command behavior.
    if (command === "tips") {
      await this.handleTipsCommand(msg);
      return true;
    }

    if (command === "pause" || command === "wake") {
      const pauseWake = parsePauseWakeCommand(text)!;
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }

      const isGeneral = !!this.ctx.fleetConfig?.instances[instanceName]?.general_topic;
      if (isGeneral && !pauseWake.instance) {
        await adapter.sendText(msg.chatId, t(`${pauseWake.action}.usage`), { threadId: msg.threadId });
        return true;
      }
      const target = isGeneral ? pauseWake.instance! : instanceName;
      if (!this.ctx.fleetConfig?.instances[target]) {
        await adapter.sendText(msg.chatId, t("instance.not_found", target), { threadId: msg.threadId });
        return true;
      }
      // #754 audit: a General speaks for its own bot's instances only — an admin of this bot is not one of another's.
      if (isGeneral && this.ctx.getInstanceAdapterId && this.ctx.getInstanceAdapterId(target) !== msg.adapterId) {
        await adapter.sendText(msg.chatId, t("instance.other_bot", target), { threadId: msg.threadId });
        return true;
      }
      if (pauseWake.action === "pause" && isGeneralInstance(this.ctx.fleetConfig, target)) {
        await adapter.sendText(msg.chatId, t("general.pause_forbidden"), { threadId: msg.threadId });
        return true;
      }
      await adapter.sendText(msg.chatId, await this.runPauseWake(target, pauseWake.action), { threadId: msg.threadId });
      return true;
    }

    if (command === "collab") {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      // Channel-admin, as the Discord slash command (#754 audit): it changes how the instance is reached.
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      const isCollab = this.ctx.toggleFleetCollab(instanceName);
      await adapter.sendText(msg.chatId, isCollab
        ? t("collab.on")
        : t("collab.off"),
        { threadId: msg.threadId });
      return true;
    }

    if (command === "effort") {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      const level = text.replace(/^\/effort(@\S+)?/, "").trim();
      if (level) {
        const reply = await this.ctx.applyEffort?.(instanceName, level)
          ?? t("effort.unsupported", this.effectiveBackend(instanceName));
        await adapter.sendText(msg.chatId, reply, { threadId: msg.threadId });
      } else if (this.ctx.promptEffortMenu) {
        // No arg → inline keyboard menu (TG), same shape as /model.
        const fallback = await this.ctx.promptEffortMenu(
          instanceName, msg.userId, msg.threadId ?? msg.chatId, adapter, msg.chatId, msg.threadId, msg.adapterId,
        );
        if (fallback) await adapter.sendText(msg.chatId, fallback, { threadId: msg.threadId });
      }
      return true;
    }

    if (command === "model") {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      const name = text.replace(/^\/model(@\S+)?/, "").trim();
      if (name) {
        const reply = await this.ctx.applyModel(instanceName, name);
        await adapter.sendText(msg.chatId, reply, { threadId: msg.threadId });
      } else if (this.ctx.promptModelMenu) {
        // No arg → inline keyboard menu (TG)
        const fallback = await this.ctx.promptModelMenu(
          instanceName, msg.userId, msg.threadId ?? msg.chatId, adapter, msg.chatId, msg.threadId, msg.adapterId,
        );
        if (fallback) await adapter.sendText(msg.chatId, fallback, { threadId: msg.threadId });
      } else {
        await adapter.sendText(msg.chatId, t("model.usage"), { threadId: msg.threadId });
      }
      return true;
    }

    if (command === "compact") {
      const compact = parseCompactCommand(text)!;
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      // Channel-admin, as the Discord slash command (#754 audit): it rewrites the instance's context.
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      const result = await this.sendCompact(instanceName, compact.instructions);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
      return true;
    }

    if (command === "steer") {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      // Deliberately NOT admin-gated: anyone who can speak in this topic can
      // already send the instance a message; /steer only changes WHEN it lands
      // (mid-turn instead of after), and it goes through the full [user:]
      // formatting — unlike /raw, which bypasses it and is gated.
      const content = text.replace(/^\/steer(@\S+)?/, "").trim();
      if (!content) {
        await adapter.sendText(msg.chatId, t("steer.usage"), { threadId: msg.threadId });
        return true;
      }
      const result = this.sendSteer(instanceName, content, msg);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
      return true;
    }

    if (command === "btw") {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      // Like /steer, /btw is not admin-gated: anyone who can send the agent a
      // normal message may ask a side question. Claude owns the isolation from
      // the active turn; AgEnD only submits its native command immediately.
      const content = text.replace(/^\/btw(@\S+)?/, "").trim();
      if (!content) {
        await adapter.sendText(msg.chatId, t("btw.usage"), { threadId: msg.threadId });
        return true;
      }
      const result = this.sendBtw(instanceName, content, msg);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
      return true;
    }

    if (command === "clear") {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      if (!this.ctx.promptClearConfirmation) {
        await adapter.sendText(msg.chatId, t("clear.prompt_unavailable"), { threadId: msg.threadId });
        return true;
      }
      const fallback = await this.ctx.promptClearConfirmation(
        instanceName,
        msg.threadId ?? msg.chatId,
        adapter,
        msg.chatId,
        msg.threadId,
      );
      if (fallback) await adapter.sendText(msg.chatId, fallback, { threadId: msg.threadId });
      return true;
    }

    if (command === "cancel") {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      const ok = this.ctx.cancelInstance(instanceName);
      await adapter.sendText(msg.chatId, ok ? t("cancel.sent", instanceName) : t("cancel.not_running", instanceName), { threadId: msg.threadId });
      return true;
    }

    if (command === "save") {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      // Channel-admin, as the Discord slash command (#754 audit): it writes a file in the instance's directory.
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      const filename = parseSaveFilename(text);
      if (!filename) {
        await adapter.sendText(msg.chatId, t("save.usage"), { threadId: msg.threadId });
        return true;
      }
      if (!SAVE_FILENAME_RE.test(filename)) {
        await adapter.sendText(msg.chatId, t("filename.invalid"), { threadId: msg.threadId });
        return true;
      }
      const result = await this.sendSave(instanceName, filename);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
      return true;
    }

    // `/raw <text>` is pasted into the CLI as typed, with no [user:] envelope (daemon.ts): it is CLI input, so only
    // the owning bot's fleet admin may send it (#754 audit). An admin's falls through to delivery unchanged.
    if (command === "raw") {
      if (this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) return false;
      const adapter = this.getReplyAdapter(msg);
      if (adapter) await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
      return true;
    }

    if (command !== "ctx") return false;

    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return false;

    const reply = await this.getCtxText(instanceName);
    await adapter.sendText(msg.chatId, reply, { threadId: msg.threadId });
    return true;
  }

  async runPauseWake(instanceName: string, action: "pause" | "wake"): Promise<string> {
    if (action === "pause" && isGeneralInstance(this.ctx.fleetConfig, instanceName)) {
      return t("general.pause_forbidden");
    }
    try {
      const result = await this.ctx.changeInstancePauseState(instanceName, action);
      if (result === "not_idle") return t("pause.not_idle", instanceName);
      return t(result === "paused" ? "pause.success" : "wake.success", instanceName);
    } catch (err) {
      return t(`${action}.failed`, instanceName, (err as Error).message);
    }
  }

  /** Resolve the effective backend name for fleet or classic instances. */
  private effectiveBackend(instanceName: string): string {
    const classicBackend = this.ctx.classicChannels?.getChannelIdByInstance(instanceName)
      ? this.ctx.classicChannels.getBackendByInstance(instanceName, this.ctx.fleetConfig?.defaults?.backend)
      : undefined;
    return this.ctx.fleetConfig?.instances[instanceName]?.backend
      ?? classicBackend
      ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
  }

  /** Get context usage text for an instance (shared by TG + DC) */
  async getCtxText(instanceName: string): Promise<string> {
    // Classic instances live in classicBot.yaml, not fleet.yaml → consult the
    // classic channel manager for those so we don't mis-report defaults.backend.
    const backend = this.effectiveBackend(instanceName);
    // Fresh scrape for /ctx (user is asking right now) — bypass short cache.
    const { context, tokenRatio } = resolveInstanceContext(
      this.ctx.dataDir,
      instanceName,
      backend,
      { bypassCache: true },
    );
    const contextLine = context == null ? null : formatContextUsageLine(context, tokenRatio);
    // Effective model (resolves per-instance → fleet default → classic channel →
    // the CLI's own default) via the shared resolver, so /ctx and /model agree.
    const modelDisplay = backend === "claude-code"
      ? readStatuslineModel(this.ctx.dataDir, instanceName)
        ?? this.ctx.modelDisplayForInstance?.(instanceName)
      : this.ctx.modelDisplayForInstance?.(instanceName);
    const modelLine = modelDisplay ? `\n${t("ctx.model", modelDisplay)}` : "";
    const effortLine = this.effortLineFor(instanceName, backend);
    const autoPauseLine = this.autoPauseLineFor(instanceName);
    const pausedLine = (this.ctx.getInstanceStatus?.(instanceName) ?? "running") === "paused"
      ? `\n${t("ctx.paused")}`
      : "";
    return context != null
      ? `${contextLine}\n${t("ctx.backend", backend)}${modelLine}${effortLine}${autoPauseLine}${pausedLine}\n${t("ctx.instance", instanceName)}`
      : `${t("ctx.unavailable")}\n${t("ctx.backend", backend)}${modelLine}${effortLine}${autoPauseLine}${pausedLine}\n${t("ctx.instance", instanceName)}`;
  }

  /**
   * The `/ctx` effort line, or "" when there is nothing honest to say.
   *
   * Unlike the model, effort has no file the CLI writes back, so all we can show
   * is what we configured. That shapes every rule here:
   *
   * - Backends that take no effort setting say nothing.
   * - antigravity carries its effort in the model name itself, which `/ctx`
   *   already prints on the model line — repeating it would look like two
   *   separate settings.
   * - With no effort configured we print nothing rather than a placeholder, the
   *   same way an unknown model omits its line instead of showing a dash.
   * - A `runtime` backend (claude, grok) can be re-tuned inside its own TUI
   *   without telling us, so the value is labelled as the configured one. For a
   *   `restart` backend (kiro, codex) effort is a launch flag, so what we
   *   configured is what is running and no caveat is needed.
   */
  private effortLineFor(instanceName: string, backend: string): string {
    const strategy = this.ctx.effortStrategyFor?.(instanceName) ?? "unsupported";
    if (strategy === "unsupported") return "";
    if (backend === "antigravity" || backend === "agy") return "";
    const effort = this.ctx.resolveInstanceEffort?.(instanceName)?.effort;
    if (!effort) return "";
    return `\n${t(strategy === "runtime" ? "ctx.effort_configured" : "ctx.effort", effort)}`;
  }

  /**
   * The `/ctx` auto-pause line: effective value, both fleet-topic and Classic instances.
   *
   * Fleet-topic:   instance override → fleet defaults → 0 (disabled)
   * Classic:       classicChannels.getAutoPauseAfterByInstance → fleet defaults → 0
   *
   * Unit: auto_pause_after is already in minutes. 0 = disabled.
   */
  private autoPauseLineFor(instanceName: string): string {
    // General is the dispatcher — it must stay warm and is never auto-paused
    // regardless of the configured value (same rule as daemon.ts:1433).
    if (isGeneralInstance(this.ctx.fleetConfig, instanceName)) {
      return `\n${t("ctx.auto_pause_disabled")}`;
    }
    const fleetDefault = this.ctx.fleetConfig?.defaults?.auto_pause_after;
    let minutes: number | undefined;
    if (this.ctx.classicChannels?.getChannelIdByInstance(instanceName)) {
      // Classic instance: channel → classicBot defaults → fleet defaults
      minutes = this.ctx.classicChannels.getAutoPauseAfterByInstance?.(instanceName, fleetDefault) ?? fleetDefault ?? 0;
    } else {
      // Fleet-topic instance: instance override → fleet defaults → 0
      minutes = this.ctx.fleetConfig?.instances[instanceName]?.auto_pause_after
        ?? fleetDefault
        ?? 0;
    }
    if (!minutes) return `\n${t("ctx.auto_pause_disabled")}`;
    return `\n${t("ctx.auto_pause", `${minutes}m`)}`;
  }

  /** Send the backend-appropriate compact command to an instance's tmux pane */
  async sendCompact(instanceName: string, instructions?: string): Promise<string> {
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc?.connected) {
      const classicBackend = this.ctx.classicChannels?.getChannelIdByInstance(instanceName)
        ? this.ctx.classicChannels.getBackendByInstance(instanceName, this.ctx.fleetConfig?.defaults?.backend)
        : undefined;
      const backend = this.ctx.fleetConfig?.instances[instanceName]?.backend
        ?? classicBackend
        ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
      const base = compactCommandForBackend(backend);
      const custom = normalizeCompactInstructions(instructions);
      if (custom.length > COMPACT_INSTRUCTIONS_MAX) {
        // Refuse rather than cut: a truncated instruction is a different instruction.
        return t("compact.instructions_too_long", String(COMPACT_INSTRUCTIONS_MAX));
      }
      if (!custom) {
        ipc.send({ type: "raw_paste", content: base });
        return t("compact.sent", base);
      }
      if (backendSupportsCompactInstructions(backend)) {
        ipc.send({ type: "raw_paste", content: `${base} ${custom}` });
        return t("compact.sent_with_instructions", base);
      }
      // Compact as asked, without the text, and say so — never send it (codex
      // would take it for a chat message) and never drop it unannounced.
      ipc.send({ type: "raw_paste", content: base });
      return `${t("compact.sent", base)}\n${t("compact.instructions_ignored", backend)}`;
    }
    return t("compact.not_connected");
  }

  /** Whether the instance backend exposes a verified full-reset command. */
  supportsClear(instanceName: string): boolean {
    return clearCommandForBackend(this.effectiveBackend(instanceName)) !== null;
  }

  /**
   * Steer: interject a message into the instance's CURRENT turn. The daemon
   * pastes it into the busy CLI instead of queueing for idle (falling back to
   * the queue if the TUI swallows busy input — see Daemon.steerMessage).
   */
  /**
   * Backends whose TUI accepts a busy-pane paste as steering input,
   * live-verified: claude-code and codex buffer-then-submit at the turn
   * boundary, grok accepts it in its input line. kiro's legacy TUI swallows
   * the paste outright, and opencode/antigravity are unverified — for those
   * the user gets an honest "not supported" instead of a silent queue
   * fallback that looks like a steer but behaves like a normal message.
   */
  sendSteer(
    instanceName: string,
    content: string,
    msg: Pick<InboundMessage, "chatId" | "messageId" | "username" | "userId" | "threadId" | "adapterId" | "source">,
  ): string {
    const backend = this.effectiveBackend(instanceName);
    if (!backendSupportsSteer(backend)) {
      return t("steer.unsupported", backend);
    }
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (!ipc?.connected) return t("steer.not_connected");
    ipc.send({
      type: "steer",
      content,
      delivery_epoch: this.ctx.getDeliveryEpoch?.(instanceName) ?? undefined,
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId ?? "",
        user: msg.username,
        user_id: msg.userId,
        thread_id: msg.threadId ?? "",
        adapter_id: msg.adapterId ?? "",
        source: msg.source,
      },
    });
    return t("steer.sent", instanceName);
  }

  /** Ask a Claude Code side question without folding it into the active turn. */
  sendBtw(
    instanceName: string,
    content: string,
    msg: Pick<InboundMessage, "chatId" | "messageId" | "username" | "userId" | "threadId" | "adapterId" | "source">,
  ): string {
    const backend = this.effectiveBackend(instanceName);
    if (!BTW_SUPPORTED_BACKENDS.has(backend)) return t("btw.unsupported", backend);
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (!ipc?.connected) return t("btw.not_connected");
    ipc.send({
      type: "btw",
      content,
      delivery_epoch: this.ctx.getDeliveryEpoch?.(instanceName) ?? undefined,
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId ?? "",
        user: msg.username,
        user_id: msg.userId,
        thread_id: msg.threadId ?? "",
        adapter_id: msg.adapterId ?? "",
        source: msg.source,
      },
    });
    return t("btw.sent", instanceName);
  }

  /** Send the backend-appropriate full conversation reset through raw_paste. */
  async sendClear(instanceName: string): Promise<string> {
    const backend = this.effectiveBackend(instanceName);
    const cmd = clearCommandForBackend(backend);
    if (!cmd) return t("clear.unsupported");

    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc?.connected) {
      ipc.send({
        type: "raw_paste",
        content: cmd,
        ...(backend === "kiro-cli" ? { confirm_clear: true } : {}),
      });
      return t("clear.sent", cmd);
    }
    return t("clear.not_connected");
  }

  /** Send a backend-appropriate session-save command to a fleet-topic instance. */
  async sendSave(instanceName: string, filename: string): Promise<string> {
    const classicBackend = this.ctx.classicChannels?.getChannelIdByInstance(instanceName)
      ? this.ctx.classicChannels.getBackendByInstance(instanceName, this.ctx.fleetConfig?.defaults?.backend)
      : undefined;
    const backend = this.ctx.fleetConfig?.instances[instanceName]?.backend
      ?? classicBackend
      ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
    const cmd = saveCommandForBackend(backend, filename);
    if (!cmd) return t("save.unsupported");
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc?.connected) {
      ipc.send({ type: "raw_paste", content: cmd });
      return t("save.sent", cmd, instanceName);
    }
    return t("save.not_connected");
  }

  private async handleRestartCommand(msg: InboundMessage, mode?: string): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;

    if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
      await adapter.sendText(chatId, t("not_authorized"), { threadId });
      return;
    }

    if (mode && mode !== "full") {
      await adapter.sendText(chatId, t("restart.usage"), { threadId });
      return;
    }

    recordInternalRequest(this.ctx.dataDir, "restart", `command /restart ${mode ?? "graceful"} by ${msg.adapterId}:${msg.userId}`);
    if (mode !== "full") {
      await adapter.sendText(chatId, t("restart.graceful"), { threadId });
      process.kill(process.pid, "SIGUSR2");
      return;
    }

    const sent = await adapter.sendText(chatId, t("restart.full_preparing"), { threadId });
    if (!this.ctx.requestFullRestart) {
      await adapter.editMessage(sent.chatId, sent.messageId, t("restart.full_launch_failed"), sent.threadId)
        .catch(() => { /* production FleetManager always supplies the reload bridge */ });
      return;
    }
    await this.ctx.requestFullRestart(adapter, sent.chatId, sent.threadId, sent.messageId);
  }

  /**
   * `/usage` — AI subscription usage for CLI backends used by running or paused
   * instances, one compact message. Same permission level as /ctx (none): whoever
   * can talk to the fleet may see how much headroom it has left. Vendor rate
   * limits are protected by the shared 5-minute cache, not by gating callers.
   */
  private async handleUsageCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    try {
      const { getUsageSnapshot } = await import("./usage/usage-api.js");
      const { renderUsageHtml, renderUsageMarkdown } = await import("./usage/format-rich.js");
      const payload = await getUsageSnapshot(false, this.ctx.getActiveUsageProviderIds?.());
      // Each platform gets its native rich format: Telegram needs parse_mode
      // HTML; Discord renders Markdown in plain content. Anything else falls back
      // to Markdown, which degrades to readable text.
      if (adapter.type === "telegram") {
        await adapter.sendText(msg.chatId, renderUsageHtml(payload), { threadId: msg.threadId, format: "html" });
      } else {
        await adapter.sendText(msg.chatId, renderUsageMarkdown(payload), { threadId: msg.threadId });
      }
    } catch (err) {
      await adapter.sendText(msg.chatId, t("usage.failed", (err as Error).message), { threadId: msg.threadId });
    }
  }

  /**
   * `/login [backend] | cancel` — remote CLI re-login.
   * Fleet-admin only: the flow emits live authorization URLs/codes, and anyone
   * completing one binds their own account to this fleet's CLI.
   */
  private async handleLoginCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
      await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
      return;
    }
    if (!this.ctx.startLoginSession || !this.ctx.promptLoginBackends || !this.ctx.cancelLoginSession) {
      await adapter.sendText(msg.chatId, t("login.no_session"), { threadId: msg.threadId });
      return;
    }
    const arg = msg.text.trim().replace(/^\/login(?:@\S+)?/, "").trim();
    const chat = {
      adapter,
      adapterId: msg.adapterId ?? adapter.id,
      chatId: msg.chatId,
      threadId: msg.threadId,
      userId: msg.userId,
    };
    if (!arg) {
      const failure = await this.ctx.promptLoginBackends(chat);
      if (failure) await adapter.sendText(msg.chatId, failure, { threadId: msg.threadId });
      return;
    }
    if (arg === "cancel") {
      await adapter.sendText(msg.chatId, await this.ctx.cancelLoginSession(), { threadId: msg.threadId });
      return;
    }
    if (/\s/.test(arg)) {
      await adapter.sendText(msg.chatId, t("login.usage"), { threadId: msg.threadId });
      return;
    }
    const started = await this.ctx.startLoginSession(arg, chat);
    // null → the still-valid-auth confirmation prompt was posted instead.
    if (started) await adapter.sendText(msg.chatId, started, { threadId: msg.threadId });
  }

  private async handleTipsCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter || !this.ctx.fleetConfig) return;
    const mode = msg.text.trim().replace(/^\/tips(?:@\S+)?/, "").trim().toLowerCase();
    if (mode === "advanced on") {
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return;
      }
      await adapter.sendText(
        msg.chatId,
        this.ctx.unlockAdvancedTips?.(msg.userId)
          ? t("tips.advanced.unlocked")
          : t("tips.unavailable"),
        { threadId: msg.threadId },
      );
      return;
    }
    if (mode === "on" || mode === "off") {
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return;
      }
      this.ctx.fleetConfig.defaults.tips = mode === "on";
      this.ctx.saveFleetConfig();
      await adapter.sendText(msg.chatId, t(mode === "on" ? "tips.enabled" : "tips.disabled"), {
        threadId: msg.threadId,
      });
      return;
    }
    if (mode) {
      await adapter.sendText(msg.chatId, t("tips.usage"), { threadId: msg.threadId });
      return;
    }
    const result = await this.ctx.promptTip?.(
      // The instance name scopes prompt cleanup; the Tip is posted at the
      // caller's current chat/thread below.
      Object.entries(this.ctx.fleetConfig.instances)
        .find(([, config]) => config.general_topic === true
          && (!config.channel_id || config.channel_id === msg.adapterId))?.[0] ?? "general",
      adapter,
      msg.chatId,
      msg.threadId,
    ) ?? "unavailable";
    if (result === "empty") {
      await adapter.sendText(msg.chatId, t("tips.empty"), { threadId: msg.threadId });
    } else if (result === "unavailable") {
      await adapter.sendText(msg.chatId, t("tips.unavailable"), { threadId: msg.threadId });
    }
  }

  private async handleStatusCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter || !this.ctx.fleetConfig) return;
    // Admin-gated: with the /sysinfo instance table folded in, /status now shows
    // the whole fleet's per-instance costs and IPC health in one message.
    if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
      await adapter.sendText(msg.chatId, t("cmd.admin_required", "/status"), { threadId: msg.threadId });
      return;
    }
    const text = await this.getStatusText();
    await adapter.sendText(msg.chatId, text, { threadId: msg.threadId });
  }

  /** Fleet-wide display labels for status/sysinfo tables (#1305 P2-1):
   * display_name first, else a 19+-digit `-t<digits>` suffix shortened to its
   * last 6 — lengthened only while the label stays unique across every
   * instance, so same-tail legacy entries remain distinguishable. Keeps rows
   * short so a large fleet's table fits Discord's 2000-char limit. The FULL
   * name is still used for all lookups — only the displayed label changes. */
  private displayLabels(): Map<string, string> {
    const instances = this.ctx.fleetConfig?.instances ?? {};
    const names = new Set(Object.keys(instances));
    for (const ch of this.ctx.classicChannels?.getAll() ?? []) names.add(ch.instanceName);
    return assignDisplayLabels([...names].map((name) => ({
      name,
      displayName: (instances as Record<string, { display_name?: string }>)[name]?.display_name,
    })));
  }

  /** Get fleet status as markdown text (shared by TG + DC) */
  async getStatusText(): Promise<string> {
    if (!this.ctx.fleetConfig) return t("status.no_config");

    const rows: string[] = [];
    let pausedCount = 0;
    const fleetNames = new Set(Object.keys(this.ctx.fleetConfig.instances));
    const instances = [
      ...Object.keys(this.ctx.fleetConfig.instances).map(name => ({ name, classic: false })),
      ...(this.ctx.classicChannels?.getAll() ?? [])
        .filter(ch => !fleetNames.has(ch.instanceName))
        .map(ch => ({ name: ch.instanceName, classic: true })),
    ];

    const labels = this.displayLabels();
    for (const { name, classic } of instances) {
      const status = this.ctx.getInstanceStatus(name);
      const executionState = status === "paused" ? "paused"
        : status === "running" ? this.ctx.getInstanceExecutionState?.(name) ?? null
          : null;
      const costPaused = this.ctx.costGuard?.isLimited(name);
      if (status === "paused") pausedCount++;

      const backend = classic
        ? this.ctx.classicChannels?.getBackendByInstance(name, this.ctx.fleetConfig.defaults?.backend) ?? "-"
        : this.ctx.fleetConfig.instances[name]?.backend ?? this.ctx.fleetConfig.defaults?.backend ?? "-";
      // Same source as /ctx (statusline for claude-code, pane scrape otherwise).
      // Without this, kiro/grok/codex always showed "-" in the Ctx column.
      const { context } = backend === "-"
        ? { context: null as number | null }
        : resolveInstanceContext(this.ctx.dataDir, name, backend);
      const contextStr = context == null ? "-" : `${Math.round(context)}%`;

      const costCents = this.ctx.costGuard?.getDailyCostCents(name) ?? 0;

      // Merged State (#1052): lifecycle + execution state in one column. The
      // old Status icon column duplicated it (⏸/⏸, 🟢/🟢); IPC duplicated it
      // too (✗ exactly when State is stopped/crashed/—) and stays queryable
      // via /api/fleet's per-instance `ipc` flag.
      const stateLabel = status === "paused" || costPaused || executionState === "paused" ? `⏸ ${t("state.paused")}`
        : status === "stopped" ? `✗ ${t("state.stopped")}`
          : status === "crashed" ? `🔴 ${t("state.crashed")}`
            : executionState === "idle" ? `🟢 ${t("state.idle")}`
              : executionState === "working" ? `🔵 ${t("state.working")}`
                : executionState === "stuck" ? `🔴 ${t("state.stuck")}`
                  // Running but no execution snapshot yet: the old Status
                  // column showed 🟢 here — say running, never idle or "—".
                  : `🟢 ${t("state.running")}`;
      const displayName = labels.get(name) ?? name;
      // Model: same source as /ctx — live statusline for claude-code, the
      // effective resolver otherwise — capped so one long name cannot blow
      // the table wider.
      const modelDisplay = backend === "claude-code"
        ? readStatuslineModel(this.ctx.dataDir, name) ?? this.ctx.modelDisplayForInstance?.(name) ?? "default"
        : this.ctx.modelDisplayForInstance?.(name) ?? "default";
      const model = truncateDisplay(modelDisplay, MODEL_DISPLAY_WIDTH_MAX);
      // "-" distinguishes "backend has no effort setting" from an unset one:
      // an empty cell would read as missing data rather than not-applicable.
      const effort = this.ctx.resolveInstanceEffort?.(name).effort ?? "-";
      rows.push(`| ${displayName} | ${backend} | ${model} | ${contextStr} | ${effort} | ${formatCents(costCents)} | ${stateLabel} |`);
    }

    if (rows.length === 0) return t("status.no_instances");

    const lines = [
      `## ${t("status.title")}`,
      "",
      t("status.table_header"),
      "|----------|---------|-------|-----|--------|------|-------|",
      ...rows,
      "",
      t("status.paused_count", pausedCount),
    ];

    const limitCents = this.ctx.costGuard?.getLimitCents() ?? 0;
    const totalCents = this.ctx.costGuard?.getFleetTotalCents() ?? 0;
    if (limitCents > 0) {
      lines.push("", t("status.daily_cost", formatCents(totalCents), formatCents(limitCents)));
    }

    // Adapter states (only show if any are not connected)
    const adapterStates = this.ctx.getAdapterStates?.();
    if (adapterStates && adapterStates.size > 0) {
      const issues = [...adapterStates.entries()].filter(([, s]) => s.status !== "connected");
      if (issues.length > 0) {
        lines.push("", `**${t("status.adapters")}**`);
        for (const [id, s] of adapterStates) {
          const icon = s.status === "connected" ? "✅" : s.status === "retrying" ? "🔄" : "❌";
          lines.push(`  ${icon} ${id}: ${s.status}${s.lastError ? ` (${s.lastError.slice(0, 60)})` : ""}`);
        }
      }
    }

    return lines.join("\n");
  }

  private async handleSysInfoCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const platform = adapter.type === "discord" ? "discord" : "telegram";
    await this.sendSysInfo(text => adapter.sendText(msg.chatId, text, { threadId: msg.threadId }), { platform });
  }

  /** Share the send-completion gate across topic messages and Discord slash replies. */
  async sendSysInfo(
    send: (text: string) => Promise<unknown>,
    opts?: { platform?: "telegram" | "discord" },
  ): Promise<void> {
    const text = await this.getSysInfoTextAsync(opts);
    try {
      await send(text);
    } finally {
      this.ctx.refreshBackendCliVersions?.();
    }
  }

  /**
   * Get system info as formatted text.
   *
   * System-level only. The per-instance table (state/IPC/cost) moved to /status,
   * which was already the fleet-per-instance view — the two tables overlapped on
   * everything but the IPC column, and each command answered half of "is the
   * machine fine and are the instances fine".
   *
   * @param opts.platform - "telegram" uses markdown table, "discord" uses plain lines
   */
  async getSysInfoTextAsync(opts?: { platform?: "telegram" | "discord" }): Promise<string> {
    const backendCliVersions = this.ctx.getBackendCliVersionSnapshot?.();
    return this.getSysInfoText({ ...opts, backendCliVersions });
  }

  getSysInfoText(opts?: { platform?: "telegram" | "discord"; backendCliVersions?: BackendCliVersionSnapshot }): string {
    const info = this.ctx.getSysInfo();
    const upHours = Math.floor(info.uptime_seconds / 3600);
    const upMins = Math.floor((info.uptime_seconds % 3600) / 60);
    const require = createRequire(import.meta.url);
    const agendVersion = require("../package.json").version ?? "unknown";
    const tipsLang = getLocale() === "zh-TW" ? "zh" : "en";

    // Fleet summary lines (multi-line for mobile readability)
    const summaryLines = [
      `${t("sysinfo.instances")}: ${info.running_count} ${t("sysinfo.running")}, ${info.paused_count} ${t("sysinfo.paused")}`,
      ...(info.fleet_mem_mb !== null ? [`${t("sysinfo.fleet_mem")}: ${(info.fleet_mem_mb / 1024).toFixed(1)} GB`] : []),
      `${t("sysinfo.system_mem")}: ${info.system_mem_gb.used} / ${info.system_mem_gb.total} GB`,
    ];
    const backendVersions = backendCliLines(opts?.backendCliVersions);

    const resources = [
      `📚 **${t("sysinfo.resources")}**`,
      `- ${t("sysinfo.docs")}: https://songsid.github.io/AgEnD`,
      `- ${t("sysinfo.tips")}: https://songsid.github.io/AgEnD/tips-${tipsLang}.html`,
      `- ${t("sysinfo.github")}: https://github.com/songsid/AgEnD`,
    ];

    // Discord: plain key-value lines (Discord doesn't render markdown tables)
    if (opts?.platform === "discord") {
      return [
        `## ${t("sysinfo.title")}`,
        `AgEnD: v${agendVersion}`,
        `OS: ${process.platform} ${osRelease()} (${process.arch})`,
        `Node: ${process.version}`,
        `tmux: ${tmuxVersion()}`,
        `${t("sysinfo.uptime")}: ${upHours}h ${upMins}m`,
        `${t("sysinfo.memory")}: ${info.memory_mb.rss} MB RSS`,
        `${t("sysinfo.heap")}: ${info.memory_mb.heapUsed} / ${info.memory_mb.heapTotal} MB`,
        "",
        ...backendVersions,
        "",
        ...summaryLines,
        "",
        ...resources,
      ].join("\n");
    }

    // Telegram (default): markdown table
    return [
      `## ${t("sysinfo.title")}`,
      "",
      `| ${t("sysinfo.metric")} | ${t("sysinfo.value")} |`,
      "|--------|-------|",
      `| AgEnD | v${agendVersion} |`,
      `| OS | ${process.platform} ${osRelease()} (${process.arch}) |`,
      `| Node | ${process.version} |`,
      `| tmux | ${tmuxVersion()} |`,
      `| ${t("sysinfo.uptime")} | ${upHours}h ${upMins}m |`,
      `| ${t("sysinfo.memory")} | ${info.memory_mb.rss} MB RSS |`,
      `| ${t("sysinfo.heap")} | ${info.memory_mb.heapUsed} / ${info.memory_mb.heapTotal} MB |`,
      "",
      ...backendVersions,
      "",
      ...summaryLines,
      "",
      ...resources,
    ].join("\n");
  }

  private async handleUpdateCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;

    // Access control — only fleet admins of THIS adapter can trigger an update; empty = disabled
    if (!this.ctx.hasFleetAdmins(msg.adapterId)) {
      await adapter.sendText(chatId, t("update.disabled"), { threadId });
      return;
    }
    if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
      await adapter.sendText(chatId, t("not_authorized"), { threadId });
      return;
    }

    const sent = await adapter.sendText(chatId, t("update.progress.preparing", 0), { threadId });
    this.ctx.beginUpdateProgress?.(adapter, chatId, threadId, sent.messageId);

    // The CLI picks the channel from the installed version it replaces; see UPDATE_COMMAND.
    const updateCmd = UPDATE_COMMAND;
    const { spawn } = await import("node:child_process");
    const origin = `command /update by ${msg.adapterId}:${msg.userId}`;
    recordInternalRequest(this.ctx.dataDir, "update", origin);
    const child = spawn("sh", ["-c", `sleep 2 && ${updateCmd}`], {
      detached: true, stdio: "ignore", env: withOrigin(origin),
    });
    child.once("error", err => this.ctx.failUpdateProgress?.(err.message));
    child.unref();
  }

  /** #1302: `/visibility [full|summary|hidden]` in the General topic. */
  private async handleVisibilityCommand(msg: InboundMessage, arg: string): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter || !this.ctx.fleetConfig) return;
    // Same rule as /doctor: this adapter's fleet admins only, and an empty list is "nobody", not "everybody".
    if (!this.ctx.hasFleetAdmins(msg.adapterId) || !this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
      await adapter.sendText(msg.chatId, t("not_authorized"), { threadId: msg.threadId });
      return;
    }
    const reply = runVisibilityCommand(this.ctx.fleetConfig, arg, () => this.ctx.saveFleetConfig());
    await adapter.sendText(msg.chatId, reply, { threadId: msg.threadId });
  }

  private async handleDoctorCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;

    // Same rule as /update: this adapter's fleet admins only, and an empty list is "nobody", not "everybody".
    if (!this.ctx.hasFleetAdmins(msg.adapterId) || !this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
      await adapter.sendText(chatId, t("not_authorized"), { threadId });
      return;
    }

    await adapter.sendText(chatId, t("doctor.running"), { threadId });
    // Async, and execFile rather than a shell string: as execSync this froze the
    // whole fleet event loop for up to 30s — no IPC, no delivery, no WATCHDOG
    // ping — and any allowlisted user could trigger it with /doctor.
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const backend = this.ctx.fleetConfig?.defaults?.backend || "claude-code";
    let output: string;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("agend", ["backend", "doctor", backend], {
        timeout: 30_000,
        encoding: "utf-8",
      });
      output = stripAnsi(stdout) || t("doctor.no_output");
    } catch (err) {
      const e = err as { stdout?: string; message?: string };
      output = stripAnsi(e.stdout ?? e.message ?? t("doctor.failed"));
    }
    await adapter.sendText(chatId, output, { threadId });
  }

  /** Reply with redirect when message arrives in an unbound topic */
  async handleUnboundTopic(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    await adapter.sendText(
      msg.chatId,
      t("topic.unbound"),
      { threadId: msg.threadId },
    );
  }

  /**
   * Handle provider-confirmed topic deletion without deleting instance data.
   * Topology observations are not user authorization for worktree removal.
   */
  handleTopicDeleted(
    threadId: string,
    evidence: { source: "provider-event" | "provider-probe"; adapterId?: string; generation?: number } = { source: "provider-event" },
  ): void {
    const target = this.ctx.routingTable.get(threadId);
    if (!target) return;
    if (target.kind === "general") {
      this.ctx.logger.debug({ instanceName: target.name, threadId }, "Ignoring delete event for General topic");
      return;
    }

    this.ctx.quarantineMissingTopic(threadId, target, evidence);
  }

  /** Create instance config, save fleet.yaml, start daemon, connect IPC. */
  async bindAndStart(dirPath: string, topicId: number | string): Promise<string> {
    if (!this.ctx.fleetConfig) throw new Error("Fleet config not loaded");

    // Short unique suffix (#1301), same rule as create_instance. Reuse of a
    // taken name requires proof it belongs to this same topic (#1305 P1):
    // full topic_id string equality; a dir-only collision (no config entry)
    // can never prove that, so it counts as a different topic.
    const instances = this.ctx.fleetConfig?.instances ?? {};
    const wanted = String(topicId);
    const instanceName = uniqueInstanceName(basename(dirPath), topicId, (candidate) =>
      candidate in instances
      || existsSync(this.ctx.getInstanceDir(candidate)),
    (candidate) => {
      const owner = (instances as Record<string, { topic_id?: unknown }>)[candidate];
      return owner != null && String(owner.topic_id) === wanted;
    });

    this.ctx.fleetConfig.instances[instanceName] = {
      working_directory: dirPath,
      topic_id: topicId,
      restart_policy: this.ctx.fleetConfig.defaults.restart_policy ?? DEFAULT_INSTANCE_CONFIG.restart_policy,
      log_level: this.ctx.fleetConfig.defaults.log_level ?? DEFAULT_INSTANCE_CONFIG.log_level,
    };

    this.ctx.saveFleetConfig();
    this.ctx.routingTable.set(String(topicId), { kind: "instance", name: instanceName });

    // startInstance awaits lifecycle.start → daemon.start (IPC listening) →
    // connectIpcToInstance. By the time it resolves, IPC is already wired —
    // the previous code's 5s sleep + second connect was leftover paranoia.
    await this.ctx.startInstance(instanceName, this.ctx.fleetConfig.instances[instanceName], true);

    this.ctx.logger.info({ instanceName, topicId }, "Topic bound and started");
    return instanceName;
  }

  /** Create Telegram topics for instances that don't have topic_id */
  async autoCreateTopics(): Promise<void> {
    if (!this.ctx.fleetConfig?.channel?.group_id) return;
    const botToken = process.env[this.ctx.fleetConfig.channel.bot_token_env];
    if (!botToken) return;

    let configChanged = false;
    for (const [name, config] of Object.entries(this.ctx.fleetConfig.instances)) {
      if (config.topic_id != null) continue;

      // General topic: determine platform type from channel_id → channels config
      if (config.general_topic) {
        const channels = this.ctx.fleetConfig?.channels ?? (this.ctx.fleetConfig?.channel ? [this.ctx.fleetConfig.channel] : []);
        let platformType: string | undefined;
        if ((config as any).channel_id) {
          const matched = channels.find(c => (c.id ?? c.type) === (config as any).channel_id);
          platformType = matched?.type;
        }
        if (!platformType) {
          if (name.includes("telegram")) platformType = "telegram";
          else if (name.includes("discord")) platformType = "discord";
        }
        if (platformType === "discord") {
          const ch = channels.find(c => c.type === "discord");
          const gcid = ch?.options?.general_channel_id as string | number | undefined;
          // A Discord general needs a real channel id — NOT the TG-convention
          // "1", which makes the DC adapter throw fetching channel "1". Skip
          // (leave unbound) if there's no valid channel to bind to.
          if (gcid == null || !/^\d{17,}$/.test(String(gcid))) {
            this.ctx.logger.warn({ name }, "Discord general has no valid general_channel_id — skipping topic bind (set channel.options.general_channel_id)");
            continue;
          }
          config.topic_id = gcid;
        } else {
          config.topic_id = 1;
        }
        configChanged = true;
        this.ctx.logger.info({ name, topicId: config.topic_id, platformType }, "Bound to General topic");
        continue;
      }

      try {
        const topicName = basename(config.working_directory);
        const threadId = await this.ctx.createForumTopic(topicName);
        config.topic_id = threadId;
        configChanged = true;
        this.ctx.logger.info({ name, topicId: config.topic_id, topicName }, "Auto-created Telegram topic");
      } catch (err) {
        this.ctx.logger.warn({ name, err }, "Failed to auto-create topic");
      }
    }

    if (configChanged) {
      this.ctx.saveFleetConfig();
    }
  }

  /**
   * Register the Telegram command menus (what "/" suggests) for one Telegram connection, or — with no argument — for
   * every Telegram connection in the config. Called by the fleet whenever a Telegram adapter starts or is rebuilt
   * (primary or not), so a connection added or rebound in Settings has its menu without a fleet restart.
   *
   * Two menus, with different needs:
   *  - the fleet menu, on the fleet's forum group (`chat` and `chat_administrators` of `group_id`) — needs `group_id`;
   *  - the ClassicBot menu, on `default` and `all_group_chats` — needs only the token. A Telegram connection that runs
   *    ClassicBot alone has no forum group and no `group_id`, and used to get no menu at all (#1191).
   * Telegram picks the most specific scope: the forum group's own scopes outrank `all_group_chats`, which outranks
   * `default`, so the ClassicBot list is registered on both of those — a stale group-level list (left by another
   * tool) would otherwise hide it in groups.
   */
  async registerBotCommands(channel?: ChannelConfig): Promise<void> {
    const channels = channel ? [channel]
      : this.ctx.fleetConfig?.channels ?? (this.ctx.fleetConfig?.channel ? [this.ctx.fleetConfig.channel] : []);
    for (const ch of channels) {
      if (ch.type === "telegram") await this.registerTelegramMenus(ch);
    }
  }

  private async registerTelegramMenus(ch: ChannelConfig): Promise<void> {
    const adapterId = ch.id ?? ch.type;
    const botToken = process.env[ch.bot_token_env];
    if (!botToken) {
      this.ctx.logger.warn({ adapterId }, "Skipping Telegram bot-command registration — the bot token is not set");
      return;
    }
    // Locks come from the command table's Telegram column (#1177), descriptions from the locale.
    const menu = (which: TelegramMenu) => telegramMenu(which).map(({ name, lock, argHint }) => ({
      command: name,
      description: lock + t(`slash.${name}`) + (argHint ? ` ${t(argHint)}` : ""),
    }));
    const fleetCommands = menu("fleet");
    const classicCommands = menu("classic");

    const setCommands = async (
      commands: Array<{ command: string; description: string }>,
      scope: Record<string, string | number>,
    ): Promise<void> => {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/setMyCommands`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commands, scope }),
          // Registration runs beside the adapter's login, never in front of it; it must also end on its own.
          signal: AbortSignal.timeout(TELEGRAM_COMMANDS_TIMEOUT_MS),
        },
      );
      type TelegramApiResponse = { ok?: boolean; result?: boolean; description?: string };
      let result: TelegramApiResponse | null = null;
      try {
        result = await response.json() as TelegramApiResponse;
      } catch { /* handled by the validation below */ }
      // fetch() resolves on Telegram 4xx/5xx. Without checking both layers we
      // logged a successful registration while Telegram kept the old (often
      // four-command) menu indefinitely.
      if (!response.ok || result?.ok !== true || result.result !== true) {
        throw new Error(
          `Telegram setMyCommands failed (${response.status}): ${result?.description ?? "invalid Bot API response"}`,
        );
      }
    };

    // A chat_administrators scope has higher precedence than the chat scope.
    // Keep both synchronized so a stale admin-only list from BotFather or an
    // older deployment cannot hide newly added commands from fleet admins.
    // Try every scope even if one fails: a bad fleet chat id must not prevent
    // the default Classic menu from being refreshed (or vice versa).
    const registrations: Array<{
      commands: Array<{ command: string; description: string }>;
      scope: Record<string, string | number>;
    }> = [
      ...(ch.group_id ? [
        { commands: fleetCommands, scope: { type: "chat", chat_id: ch.group_id } },
        { commands: fleetCommands, scope: { type: "chat_administrators", chat_id: ch.group_id } },
      ] : []),
      { commands: classicCommands, scope: { type: "all_group_chats" } },
      { commands: classicCommands, scope: { type: "default" } },
    ];
    const failures: Error[] = [];
    for (const registration of registrations) {
      try {
        await setCommands(registration.commands, registration.scope);
      } catch (err) {
        failures.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (failures.length > 0) {
      this.ctx.logger.warn({ err: new AggregateError(failures, failures.map(error => error.message).join("; ")), adapterId },
        "Failed to register bot commands (non-fatal)");
      return;
    }
    this.ctx.logger.info({
      adapterId,
      fleetCommandCount: ch.group_id ? fleetCommands.length : 0,
      classicCommandCount: classicCommands.length,
      scopes: registrations.map(r => r.scope.type),
    }, ch.group_id
      ? "Registered Telegram bot commands for fleet chat/admin and Classic group/default scopes"
      : "Registered Telegram bot commands for Classic group/default scopes (no group_id: no fleet menu)");
  }
}
