import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type McpServerEntry, type ModelOption, type RuntimeDialog, type StartupDialog, probeCliVersion, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;
const CODEX_MODELS_CACHE_MAX_BYTES = 5 * 1024 * 1024;
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/;
const AGEND_MCP_CLEANUP_LOCK = ".agend-mcp-cleanup.lock";
const AGEND_MCP_CLEANUP_LOCK_STALE_MS = 30_000;

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

  buildCommand(config: CliBackendConfig): string {
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
  private prepareIsolatedHome(): void {
    mkdirSync(this.isolatedCodexHome, { recursive: true, mode: 0o700 });
    chmodSync(this.isolatedCodexHome, 0o700);
    if (this.sharedCodexHome === this.isolatedCodexHome || !existsSync(this.sharedCodexHome)) return;

    for (const name of readdirSync(this.sharedCodexHome)) {
      if (name === "config.toml" || name === AGEND_MCP_CLEANUP_LOCK || name.startsWith(".config.toml.")) continue;
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
    // Startup/header: "OpenAI Codex". Daily prompt: a line beginning with ">".
    // Statusline variants report either "% left" or "% used" while idle.
    return /% left|% used|OpenAI Codex|^>/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /rate limit|429 Too Many Requests/i, type: "rate_limit", action: "failover", message: "OpenAI rate limit reached" },
      { pattern: /authentication|401 Unauthorized/i, type: "auth_error", action: "pause", message: "OpenAI authentication error" },
      { pattern: /insufficient_quota|billing/i, type: "quota", action: "pause", message: "OpenAI quota exceeded" },
      { pattern: /you've hit your usage limit/i, type: "quota", action: "pause", message: "Codex usage limit reached — upgrade plan required" },
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

  getCancelKey(): string { return "Escape"; }

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
