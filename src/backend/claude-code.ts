import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type RuntimeDialog, type StartupDialog, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";

/** Mirror Claude Code's ~/.claude/projects key for a working directory. */
function claudeProjectKey(cwd: string): string {
  let canonical = resolve(cwd);
  try { canonical = realpathSync(canonical); } catch { /* Claude also falls back to the unresolved absolute path */ }

  // Claude Code replaces every non-ASCII alphanumeric character, not only
  // separators. A slash-only replacement misses dots (notably ~/.agend),
  // underscores and spaces, falsely making an existing transcript look absent.
  const sanitized = canonical.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;

  // Claude bounds long project keys to a 200-character prefix plus its stable
  // Java-style string hash. Keep this rare case aligned as well.
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}


export class ClaudeCodeBackend implements CliBackend {
  readonly binaryName = "claude";
  readonly instructionsReloadedOnResume = true;
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("claude");
  }

  buildCommand(config: CliBackendConfig): string {
    const settingsPath = join(this.instanceDir, "claude-settings.json");
    const mcpConfigPath = join(this.instanceDir, "mcp-config.json");
    const envPrefix = ["CMUX_CLAUDE_HOOKS_DISABLED=1", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"];
    if (process.env.ANTHROPIC_BASE_URL) envPrefix.push(`ANTHROPIC_BASE_URL=${shellQuote(process.env.ANTHROPIC_BASE_URL)}`);
    if (process.env.ANTHROPIC_API_KEY && !this.hasOAuthSession()) {
      envPrefix.push(`ANTHROPIC_API_KEY=${shellQuote(process.env.ANTHROPIC_API_KEY)}`);
    }
    let cmd = `${envPrefix.join(" ")} ${this.binaryPath} --settings ${settingsPath} --mcp-config ${mcpConfigPath}`;
    if (config.skipPermissions !== false) cmd += " --dangerously-skip-permissions";

    const sessionIdFile = join(this.instanceDir, "session-id");
    // `session-id` belongs to the instance, not the backend. A ClassicBot can
    // switch from Kiro (or another CLI) to Claude while retaining that marker.
    // Claude's bare `--continue` then looks for a conversation in this cwd and
    // exits when the workspace has never had a Claude session. Treat Claude's
    // own project transcript as the source of truth instead of the generic
    // marker alone. This also makes an empty/missing Classic workspace start
    // fresh rather than entering a resume crash loop.
    if (!config.skipResume && existsSync(sessionIdFile) && this.hasProjectSession(config.workingDirectory)) {
      cmd += " --continue";
    }

    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("claude-code", model);
      cmd += ` --model ${model}`;
    }

    // Additive system prompt: append fleet instructions without overriding Claude's built-in prompt
    const instrFile = join(this.instanceDir, "fleet-instructions.md");
    if (existsSync(instrFile)) {
      cmd += ` --append-system-prompt-file ${instrFile}`;
    }

    return cmd;
  }

  private hasProjectSession(workingDirectory: string): boolean {
    const cwd = workingDirectory.trim();
    if (!cwd) return false;
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    const encodedCwd = claudeProjectKey(cwd);
    try {
      return readdirSync(join(configDir, "projects", encodedCwd), { withFileTypes: true })
        .some(entry => entry.isFile() && entry.name.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }

  writeConfig(config: CliBackendConfig): void {
    // 1. Write mcp-config.json to instance dir (loaded via --mcp-config)
    const mcpConfigPath = join(this.instanceDir, "mcp-config.json");
    const mcpConfig = { mcpServers: config.mcpServers };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // 2. Write statusline script
    const statusLineCommand = this.writeStatusLineScript();

    // 3. Write claude-settings.json (permissions handled by --dangerously-skip-permissions)
    const settings: Record<string, unknown> = {
      statusLine: {
        type: "command",
        command: statusLineCommand,
      },
    };
    writeFileSync(
      join(this.instanceDir, "claude-settings.json"),
      JSON.stringify(settings),
    );

    // 4. Pre-approve API key to skip interactive prompt on startup
    this.preApproveApiKey(config);

    // 5. Write fleet instructions file (loaded via --append-system-prompt-file)
    if (config.instructions) {
      try { writeFileSync(join(this.instanceDir, "fleet-instructions.md"), config.instructions); } catch { /* best effort */ }
    }
  }

  /**
   * `❯` is the input box, which Claude Code renders persistently — it is on screen
   * while the agent works, not only when it is waiting. So this marks "the TUI has
   * finished starting up", not "the agent is idle"; `getBusyPattern()` is what
   * separates those two. Startup dialogs are matched before this (see
   * getStartupDialogs) because `❯ 1. Resume from summary` would satisfy it.
   *
   * `ok\s*$` used to be the second alternative here and has been removed. `ok` is
   * what *AgEnD's own* statusline script prints (see writeStatusLineScript), so the
   * pattern was matching a line this file writes — permanently true, and true for
   * reasons that had nothing to do with the CLI's state.
   */
  getReadyPattern(): RegExp {
    return /❯/;
  }

  /**
   * The live spinner line, which is on screen only while generating. Captured from
   * running panes and their pipe-pane recordings:
   *
   *   working →  `✢ Accomplishing… (11m 26s · ↓ 38.0k tokens)`
   *   idle    →  `✻ Worked for 6m 49s`
   *
   * Both panes also showed `❯` and the `ok` statusline, which is why neither of
   * those can carry the distinction. The discriminator is the rotating glyph plus
   * Claude's one-word spinner label ending in an ellipsis. The completed line is
   * past tense with no ellipsis. The verb and glyph both rotate, so neither
   * specific value is matched.
   *
   * Claude Code 2.1.239 paints that line incrementally. For roughly the first
   * three seconds — and briefly during later repaints — capture-pane can see only
   * `* Nesting…` before `(3s · ↓ 9 tokens)` is appended. It also emits hyphenated
   * labels such as `Razzle-dazzling…` and `Sock-hopping…`. Requiring the elapsed
   * counter and a letters-only verb made both real shapes look idle. Since `❯`
   * remains visible throughout generation, a settled capture in either shape
   * retired Cancel and the progress bubble while the turn was still running.
   *
   * The animation cycles through six measured frames, including one plain ASCII
   * asterisk. The older leading class required a non-ASCII glyph, so sampling a
   * continuously working pane 50 times at 250ms produced:
   *
   *   ✻ 11/11   ✽ 10/10   ✢ 10/10   · 9/9   ✶ 4/4   * 0/6  ← U+002A never matched
   *
   * Since `❯` is always on screen (claude keeps its input box rendered), the ready
   * pattern is permanently true and this pattern is the only discriminator: one
   * asterisk frame meant "idle" while the CLI was generating, which is what
   * retired cancel buttons mid-turn. 12% of frames, so it hit some turns and not
   * others.
   *
   * Deliberately narrow, because the cost is asymmetric. Matching prose that
   * happens to sit on a *stable* pane would hold the instance in `working`
   * forever — no auto-pause, no cancel-button retirement, and eventually a bogus
   * hang alert. Therefore this accepts only Claude's six measured spinner glyphs,
   * exactly one word (optionally hyphenated), and the Unicode ellipsis. Markdown
   * prose such as `* bullet point…`, `- Something…`, and a completed
   * `✻ Worked for 6m 49s` remain rejected.
   *
   * Note when this actually decides anything: while the CLI really is generating,
   * the elapsed counter ticks, the pane changes, and motion already reports
   * `working`. The veto only bites on a *frozen* pane whose last frame still shows
   * an in-progress spinner — which is exactly the hang this is meant to surface.
   */
  getBusyPattern(): RegExp {
    return /^[ \t]*[✻✽✢·✶*][ \t]+\p{L}+(?:-\p{L}+)*…(?:[ \t]+\([^\n]*)?[ \t]*$/mu;
  }

  getContextUsage(): number | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.context_window?.used_percentage ?? null;
    } catch (err) {
      // File may not exist yet during startup — return null to signal unavailable
      return null;
    }
  }

  getSessionId(): string | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.session_id ?? null;
    } catch {
      return null;
    }
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /API Error: Rate limit/i, type: "rate_limit", action: "failover", message: "API rate limit reached" },
      { pattern: /Login expired|Not logged in|Please run \/login/i, type: "auth_error", action: "notify", message: "Claude login expired — needs re-login (/login)" },
      { pattern: /API Error: Authentication/i, type: "auth_error", action: "pause", message: "Authentication error" },
      { pattern: /API Error: Overloaded/i, type: "rate_limit", action: "notify", message: "API overloaded" },
      { pattern: /credit balance is too low/i, type: "quota", action: "pause", message: "Insufficient API credits" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      // Session resume prompt must be checked BEFORE ready pattern, because ❯ in
      // "❯ 1. Resume from summary" would falsely match the ready pattern /❯/.
      { pattern: /Resume from summary \(recommended\)/, keys: ["Down", "Enter"], description: "Claude session resume prompt — select 'Resume full session as-is'" },
      { pattern: /[❯›]\s*\d+\.\s*No/m, keys: ["Down", "Enter"], description: "Claude 'No, exit' confirmation — navigate to Yes" },
      { pattern: /I accept|I trust/i, keys: ["Enter"], description: "Claude 'Yes, I accept' trust dialog" },
      { pattern: /Resume Session/i, keys: ["Escape"], description: "Claude resume session picker — start fresh" },
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      {
        // Claude Code shows a session resume prompt when session is old/large.
        // Default cursor is on summary; move down to preserve the full context.
        pattern: /Resume from summary \(recommended\)/,
        keys: ["Down", "Enter"],
        description: "Claude session resume prompt — select 'Resume full session as-is'",
      },
    ];
  }

  getQuitCommand(): string { return "/exit"; }

  getCompactCommand(): string { return "/compact"; }
  getClearCommand(): string { return "/clear"; }

  getCancelKey(): string { return "Escape"; }

  // `claude --effort <level>` (low, medium, high, xhigh, max) and a `/effort`
  // slash command in the TUI — verified from `claude --help` on 2026-08-02.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return "runtime"; }
  getEffortLevels(): string[] { return ["low", "medium", "high", "xhigh", "max"]; }

  // claude-code has a clean one-shot in-session `/model <name>` → runtime switch.
  getModelSwitchStrategy(): "runtime" | "restart" { return "runtime"; }

  async listModels(): Promise<import("./types.js").ModelOption[]> {
    return [
      { id: "default", label: "default", description: "account default" },
      { id: "sonnet", label: "sonnet" },
      { id: "opus", label: "opus" },
      { id: "haiku", label: "haiku" },
      { id: "opusplan", label: "opusplan", description: "opus plans, sonnet executes" },
      // Capitalised because that is the form verified to work with
      // `claude --model Fable`; the lowercase alias is unconfirmed.
      { id: "Fable", label: "Fable", description: "Claude Fable 5" },
    ];
  }

  async probeCLIEnv() {
    const { probeCliVersion } = await import("./types.js");
    return { version: probeCliVersion(this.binaryPath), models: await this.listModels() };
  }

  cleanup(_config: CliBackendConfig): void {
    // mcp-config.json is in instance dir, cleaned up when instance is deleted
  }

  /** Pre-approve ANTHROPIC_API_KEY in ~/.claude.json to skip the interactive prompt */
  private preApproveApiKey(_config: CliBackendConfig): void {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const fingerprint = apiKey.length > 20 ? apiKey.slice(-20) : apiKey;
    const claudeJsonPath = join(homedir(), ".claude.json");

    let claudeCfg: Record<string, unknown> = {};
    try {
      claudeCfg = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    } catch { /* new file or parse error */ }

    const existing = claudeCfg.customApiKeyResponses as { approved?: string[]; rejected?: string[] } | undefined;
    const approved = existing?.approved ?? [];
    if (!approved.includes(fingerprint)) {
      claudeCfg.customApiKeyResponses = {
        approved: [...approved, fingerprint],
        rejected: existing?.rejected ?? [],
      };
      writeFileSync(claudeJsonPath, JSON.stringify(claudeCfg, null, 2));
    }
  }

  /** Check if user has an active OAuth session in ~/.claude.json */
  private hasOAuthSession(): boolean {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf-8"));
      return !!cfg.oauthAccount?.accountUuid;
    } catch {
      return false;
    }
  }

  private writeStatusLineScript(): string {
    const statusFile = join(this.instanceDir, "statusline.json");
    // Use a Node.js script instead of bash to avoid shell injection via statusFile path
    const script = [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "let input = '';",
      "process.stdin.on('data', d => input += d);",
      `process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(statusFile)}, input); console.log('ok'); });`,
    ].join("\n");
    const scriptPath = join(this.instanceDir, "statusline.js");
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }
}
