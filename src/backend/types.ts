import { execFileSync } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Observable execution state derived from the active CLI pane. */
export type InstanceState = "idle" | "working" | "stuck";

/** Point-in-time state returned by the daemon's IPC state query. */
export interface InstanceStateSnapshot {
  state: InstanceState;
  /** Milliseconds since the pane content last changed. */
  unchangedForMs: number;
  /** Unix timestamp of the most recent successful pane observation. */
  observedAt: number;
  /** Unix timestamp of the most recent state transition. */
  stateChangedAt: number;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CliBackendConfig {
  workingDirectory: string;
  instanceDir: string;
  instanceName: string;
  mcpServers: Record<string, McpServerEntry>;
  skipPermissions?: boolean;
  model?: string;
  /** Kiro-only UI/agent profile. Defaults to "legacy". */
  kiroUi?: "legacy" | "tui" | "v3";
  /** When true, backend should not resume a previous session (crash recovery). */
  skipResume?: boolean;
  /** Fleet instructions content to inject into the CLI's additive system prompt mechanism. */
  instructions?: string;
  /** Agent communication mode: "mcp" (default) or "cli" (HTTP endpoint). */
  agentMode?: "mcp" | "cli";
  /** Health server port for CLI mode (agend-agent connects here). */
  agentPort?: number;
}

/** Action to take when an error pattern is detected in PTY output. */
export type ErrorActionType = "notify" | "failover" | "restart" | "pause";

/** Categorizes detected errors for logging and response. */
export type ErrorType = "rate_limit" | "auth_error" | "crash" | "network" | "quota" | "timeout" | "model_error";

export interface ErrorPattern {
  pattern: RegExp;
  type: ErrorType;
  action: ErrorActionType;
  /** Human-readable description for notifications. */
  message: string;
  /** Build the notification text from the regex match, when a static string
   * would lose information the user needs. `message` stays the fallback for
   * when the match can't be re-derived. Receives the LAST match in the pane,
   * i.e. the most recent occurrence. */
  formatMessage?: (match: RegExpMatchArray) => string;
  /** Skip the 5-min per-type notification cooldown so every occurrence notifies
   * (e.g. Kiro "Response timed out" — each timeout should reach the user). */
  skipCooldown?: boolean;
  /** Don't enter the "waiting for recovery" state after this error. Use for
   * self-recovering errors (e.g. a timeout — the CLI is back at its prompt
   * immediately) whose backend ready-pattern only matches the startup banner,
   * so waiting would block ALL future error detection forever. */
  skipRecoveryWait?: boolean;
}

/** A selectable model, surfaced by `/model` (id is what gets applied). */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
}

/** Result of probing a CLI backend's environment at startup (cached to disk). */
export interface CliEnv {
  backend: string;
  version?: string;
  authenticated?: boolean;
  currentModel?: string;
  models: ModelOption[];
  /** Epoch ms the probe ran (drives the cache TTL). */
  probedAt: number;
}

/** Best-effort `<binary> --version` (first line, trimmed). Never throws. */
export function probeCliVersion(binaryPath: string): string | undefined {
  try {
    const out = execFileSync(binaryPath, ["--version"], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n")[0].slice(0, 80) || undefined;
  } catch { return undefined; }
}

/** A dialog that may appear at runtime and needs auto-dismissal via key sequences. */
export interface RuntimeDialog {
  /** Pattern to detect the dialog in PTY output. */
  pattern: RegExp;
  /** Key sequence to dismiss: strings are literal text, "Up"/"Down"/"Enter"/"Escape" are special keys. */
  keys: string[];
  /** Human-readable description for logging. */
  description: string;
}

/** A dialog that may appear during CLI startup (trust prompts, session pickers, etc.). */
export type StartupDialog = RuntimeDialog;

export interface CliBackend {
  /** The CLI binary name (e.g. "claude", "gemini", "codex") */
  readonly binaryName: string;

  /** Build the shell command string to launch the CLI in a tmux window. */
  buildCommand(config: CliBackendConfig): string;

  /** Write all config files the CLI needs before launch. */
  writeConfig(config: CliBackendConfig): void;

  /** Read context window usage percentage (0-100). Returns null if unavailable. */
  getContextUsage(): number | null;

  /** Read session ID for resume capability. Returns null if unavailable. */
  getSessionId(): string | null;

  /** Regex to detect when the CLI is ready to accept input. */
  getReadyPattern(): RegExp;

  /** Error patterns to detect in PTY output during operation. */
  getErrorPatterns?(): ErrorPattern[];

  /**
   * Interactive dialogs that can appear during operation (not just startup).
   * The daemon's error monitor auto-dismisses these by sending the specified keys.
   */
  getRuntimeDialogs?(): RuntimeDialog[];

  /**
   * Dialogs that may appear during CLI startup (trust prompts, confirmation dialogs).
   * The daemon's dismissDialogsUntilReady auto-dismisses these before the CLI is ready.
   */
  getStartupDialogs?(): StartupDialog[];

  /** Whether this backend re-reads instruction files on --resume (e.g. Claude Code's --append-system-prompt-file). */
  readonly instructionsReloadedOnResume?: boolean;

  /** Pre-approve a working directory to skip trust dialogs on startup. */
  preTrust?(workingDirectory: string): void;

  /** Resolve working directory (e.g. create symlink to avoid hidden paths). Returns resolved path. */
  resolveWorkingDirectory?(workingDirectory: string, instanceName?: string): string;

  /**
   * Slash/text command to gracefully quit the CLI (e.g. "/exit", "/quit"),
   * typed then followed by Enter. Return null when the CLI has no quit command
   * and quits via a key chord instead — implement getQuitKey() in that case.
   */
  getQuitCommand(): string | null;

  /**
   * The tmux key chord that quits the CLI, for backends whose quit is a keypress
   * rather than a typed command (e.g. grok Ctrl+Q). Consulted only when
   * getQuitCommand() returns null. Values are tmux send-keys names (e.g. "C-q").
   */
  getQuitKey?(): string;

  /**
   * Number of times to send getQuitKey(). Defaults to one. Some TUIs use a
   * two-stage Ctrl+C flow (first cancels/arms exit, second confirms exit).
   */
  getQuitKeyPresses?(): number;

  /**
   * In-session command to compact/reset the conversation context. Most CLIs use
   * "/compact"; some (e.g. Codex) use "/compact" too, OpenCode uses "/compact".
   * Used by the /compact fleet command.
   */
  getCompactCommand(): string;

  /**
   * The tmux key that interrupts the CLI's current generation WITHOUT quitting —
   * "Escape" for most, "C-c" (Ctrl+C) for kiro-cli. Used by the cancel button and
   * /cancel. Values are tmux send-keys names.
   */
  getCancelKey(): string;

  /** Clean up config files on shutdown. */
  cleanup?(config: CliBackendConfig): void;

  /**
   * List selectable models for `/model`. Best-effort — may exec the CLI's own
   * model-listing subcommand (formats vary and are UNVERIFIED for some CLIs) or
   * return a static alias set. Return [] when unknown; callers fall back to
   * free-text `/model <name>`. Must never throw.
   */
  listModels?(config: CliBackendConfig): Promise<ModelOption[]>;

  /**
   * How a model switch takes effect for this backend:
   * "runtime" — paste the CLI's in-session `/model <name>` (only clean for CLIs
   * with a one-shot command, e.g. claude-code); "restart" — persist + respawn
   * (universal; use for picker-style CLIs like kiro/opencode/antigravity).
   * Absent ⇒ treated as "restart".
   */
  getModelSwitchStrategy?(model: string): "runtime" | "restart";

  /**
   * Probe the CLI environment at startup: version, available models, and
   * (best-effort) auth/current model. Result is cached to disk so `/model` and
   * status views read it without re-running the CLI. Must never throw.
   */
  probeCLIEnv?(config: CliBackendConfig): Promise<{ version?: string; authenticated?: boolean; currentModel?: string; models: ModelOption[] }>;
}

/**
 * Resolve the full path to a CLI binary.
 * tmux new-window runs commands in a minimal shell without user PATH,
 * so we resolve at daemon startup time when the full PATH is available.
 */
function commonBinaryDirs(): string[] {
  const dirs = [
    dirname(process.execPath),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];

  // Root installations often retain Codex under an nvm prefix while sudo's
  // secure_path omits it. Probe every installed nvm Node bin as a fallback.
  try {
    const nvmVersions = join(homedir(), ".nvm", "versions", "node");
    for (const version of readdirSync(nvmVersions).sort().reverse()) {
      dirs.push(join(nvmVersions, version, "bin"));
    }
  } catch { /* nvm is optional */ }

  // Also cover custom npm prefixes such as ~/.npm-global.
  try {
    const prefix = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (prefix) dirs.push(join(prefix, "bin"));
  } catch { /* npm may not be in the restricted PATH */ }

  return [...new Set(dirs)];
}

export function resolveBinary(name: string, fallbackDirs?: readonly string[]): string {
  try {
    const resolved = execFileSync("which", [name], { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch { /* search common absolute locations below */ }

  for (const dir of fallbackDirs ?? commonBinaryDirs()) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* try next candidate */ }
  }
  return name; // final fallback keeps the previous shell-PATH behavior
}

/**
 * Whitelist for model names embedded into the shell command line.
 * Allows letters, digits, dot, underscore, hyphen, colon, slash
 * (e.g. "claude-3-5-sonnet", "gpt-4o-mini-2024-07-18", "openrouter/anthropic:beta").
 * Throws if `model` contains anything else, since `buildCommand` returns a
 * shell string consumed by tmux and we cannot rely on argv-style quoting.
 */
const SAFE_MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
export function validateModel(model: string): string {
  if (!SAFE_MODEL_RE.test(model)) {
    throw new Error(`Invalid model name: ${JSON.stringify(model)} — must match ${SAFE_MODEL_RE}`);
  }
  return model;
}

/** Known model prefixes/patterns per backend. Model is skipped if it doesn't match the target backend. */
const BACKEND_MODEL_PATTERNS: Record<string, RegExp> = {
  "claude-code": /^(sonnet|opus|haiku|opusplan|best|claude)/i,
  "kiro-cli": /^(claude|sonnet|opus|haiku|auto)/i,
  "codex": /^(gpt|o[0-9]|chatgpt)/i,
  "gemini-cli": /^gemini/i,
  "opencode": /./,  // opencode accepts anything (provider-dependent)
  // Current agy emits slugs (gemini-3.6-flash-high); older versions emitted
  // display names (Gemini 3.5 Flash (High)). Accept both forms.
  "antigravity": /^(gemini|claude|gpt[- ])/i,
  "grok": /^grok/i,  // grok-4.5, grok-4.3, grok-code, grok-build-0.1
};

/** Check if a model name is compatible with the given backend. */
export function isModelCompatible(backendName: string, model: string): boolean {
  const pattern = BACKEND_MODEL_PATTERNS[backendName];
  if (!pattern) return true; // unknown backend — pass through
  return pattern.test(model);
}

/**
 * Warn (but never block) when a model name doesn't match the backend's typical
 * pattern. The model is still passed through to the CLI — the CLI is the source
 * of truth for which models it accepts, and new model names (e.g. "fable")
 * appear faster than this heuristic can track. Silently dropping --model would
 * leave the CLI on its default model, which is worse than a loud CLI error.
 */
export function warnIfModelMismatch(backendName: string, model: string): void {
  if (!isModelCompatible(backendName, model)) {
    console.warn(`[agend] model "${model}" doesn't match typical pattern for ${backendName}, passing through anyway`);
  }
}

/** POSIX single-quote escape for embedding arbitrary values in a shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
