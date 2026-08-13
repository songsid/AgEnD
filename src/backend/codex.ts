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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type McpServerEntry, type ModelOption, type RuntimeDialog, type StartupDialog, probeCliVersion, resolveBinary, shellQuote, validateModel, validateProvider, warnIfModelMismatch } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;
const CODEX_MODELS_CACHE_MAX_BYTES = 5 * 1024 * 1024;
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/;
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

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("codex");
    this.sharedCodexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    this.isolatedCodexHome = resolve(instanceDir, "codex-home");
  }

  supportsQueuedInput(): boolean {
    return true;
  }

  buildCommand(config: CliBackendConfig): string {
    this.lastKnownModel = config.model?.trim() || null;
    const approvalFlag = config.skipPermissions !== false
      ? "--dangerously-bypass-approvals-and-sandbox"
      : "--full-auto";

    // `codex resume --last` resumes the most recent session for the current
    // working directory. Each AgEnD instance has a unique working_directory,
    // so sessions are per-instance scoped and won't collide.
    // If no prior session exists (first launch), Codex falls back to a fresh session.
    let cmd: string;
    if (config.skipResume) {
      cmd = `${this.binaryPath} ${approvalFlag}`;
    } else {
      cmd = `${this.binaryPath} resume --last ${approvalFlag}`;
    }
    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("codex", model);
      cmd += ` -c model="${model}"`;
    }
    if (config.backendOptions?.provider) {
      const provider = validateProvider(String(config.backendOptions.provider));
      cmd += ` -c ${shellQuote(`model_provider="${provider}"`)}`;
    }
    // CODEX_HOME is the only Codex-supported way to isolate the complete base
    // config. A profile only layers over the shared config and would therefore
    // still load every globally registered AgEnD MCP server.
    return `CODEX_HOME=${shellQuote(this.isolatedCodexHome)} ${cmd}`;
  }

  writeConfig(config: CliBackendConfig): void {
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
   * Ensure Codex's TUI status line shows context usage so /ctx can scrape it.
   * Rules (never overwrites the user's status_line):
   *   1. status_line already has a context item (context-remaining / -usage /
   *      -used) → leave the whole config untouched (they already show context).
   *   2. no context item:
   *        - no status_line at all → write status_line = ["context-remaining"]
   *        - status_line exists     → append "context-remaining" to it
   * If a user's own status_line is long and truncates at 80 cols, that's their
   * config — /ctx just reports context unavailable. Best-effort string edit of
   * ~/.codex/config.toml (no toml dependency); other settings untouched.
   */
  private enableContextStatusLine(): void {
    const configPath = join(this.isolatedCodexHome, "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch { /* no file yet */ }

    // Rule 1: any existing context item → don't touch anything.
    if (/status_line\s*=\s*\[[^\]]*context-(remaining|usage|used)[^\]]*\]/.test(content)) return;

    const ITEM = "context-remaining";
    const arr = content.match(/status_line\s*=\s*\[([^\]]*)\]/);
    if (arr) {
      // Rule 2b: prepend our item to the user's existing array (don't overwrite).
      // First position keeps "Context N% left" at the far left of the footer so a
      // long cwd/other items can't push it past 80 cols and truncate it.
      const inner = arr[1].trim().replace(/^,\s*/, "").replace(/,\s*$/, "");
      const newInner = inner.length ? `"${ITEM}", ${inner}` : `"${ITEM}"`;
      content = content.replace(arr[0], `status_line = [${newInner}]`);
    } else {
      // Rule 2a: no status_line at all → add a minimal one.
      if (content.length && !content.endsWith("\n")) content += "\n";
      if (/^\[tui\]/m.test(content)) {
        content = content.replace(/^\[tui\][^\n]*\n/m, h => `${h}status_line = ["${ITEM}"]\n`);
      } else {
        content += `\n[tui]\nstatus_line = ["${ITEM}"]\n`;
      }
    }
    try {
      atomicWritePrivate(configPath, content);
    } catch { /* best effort — never block launch on statusline config */ }
  }

  preTrust(workDir: string): void {
    const configPath = join(this.isolatedCodexHome, "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch {}

    const section = `[projects."${workDir}"]`;
    if (content.includes(section)) return;

    atomicWritePrivate(configPath, `${content.trimEnd()}\n\n${section}\ntrust_level = "trusted"\n`);
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

    for (const name of readdirSync(this.sharedCodexHome)) {
      if (name === "config.toml" || name === AGEND_MCP_CLEANUP_LOCK || name.startsWith(".config.toml.")) continue;
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
    // Startup/header: "OpenAI Codex". Prompt glyph is ">" on older Codex and
    // "›" (U+203A) on newer releases. Exclude numbered menu selections so a
    // trust/confirmation dialog is not mistaken for an idle input prompt.
    // Statusline variants report either "% left" or "% used" while idle.
    return /% left|% used|OpenAI Codex|^[>›](?!\s*\d+\.)/m;
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
    return [
      { pattern: /Do you trust the files in this folder/i, keys: ["Enter"], description: "Codex trust dialog" },
      { pattern: /Yes, continue/i, keys: ["Enter"], description: "Codex 'Yes, continue' confirmation" },
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      {
        // Codex shows a model switch dialog when approaching rate limits.
        // Auto-select "Keep current model (never show again)" — option 3.
        pattern: /Approaching rate limits[\s\S]*Switch to.*for lower credit/m,
        keys: ["Down", "Down", "Enter"],
        description: "Codex rate limit model switch dialog",
      },
    ];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    // Codex manages sessions internally via SQLite (~/.codex/state_5.sqlite).
    // `resume --last` handles session selection by CWD automatically.
    return null;
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
