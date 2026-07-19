import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type RuntimeDialog, type StartupDialog, isModelCompatible, resolveBinary, validateModel } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;

export class CodexBackend implements CliBackend {
  readonly binaryName = "codex";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("codex");
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
      if (isModelCompatible("codex", config.model)) {
        cmd += ` -c model="${validateModel(config.model)}"`;
      } else {
        console.warn(`[agend] model "${config.model}" is not compatible with codex — skipping model override, using the CLI's default`);
      }
    }
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Codex stores MCP config globally in ~/.codex/config.toml.
    // Use execFileSync (no shell) to avoid escaping issues with env values
    // containing JSON (e.g. AGEND_DECISIONS). Use namespaced key to avoid
    // conflicts when multiple Codex instances run simultaneously.
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      // Codex rejects non-ASCII MCP server names (e.g. CJK instance names) and
      // would otherwise fail silently, leaving the instance with no reply MCP
      // server. Sanitize to the safe charset codex accepts.
      const mcpName = `${name}-${config.instanceName}`.replace(/[^A-Za-z0-9_-]/g, "_");
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };
      const args = ["mcp", "add", mcpName];
      for (const [k, v] of Object.entries(allEnv)) {
        args.push("--env", `${k}=${v}`);
      }
      args.push("--", entry.command, ...entry.args);
      // Remove existing entry first (codex mcp add fails if name exists)
      try { execFileSync(this.binaryPath, ["mcp", "remove", mcpName], { stdio: "ignore" }); } catch { /* may not exist */ }
      // Surface add failures — a silent failure means no reply MCP server.
      try { execFileSync(this.binaryPath, args, { stdio: "ignore" }); }
      catch (e) { console.warn(`[codex] mcp add "${mcpName}" failed: ${(e as Error).message}`); }
    }
    // Clean up old non-namespaced key if present (one-time migration)
    try { execFileSync(this.binaryPath, ["mcp", "remove", "agend"], { stdio: "ignore" }); } catch { /* may not exist */ }

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
    const configPath = join(homedir(), ".codex", "config.toml");
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
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, content);
    } catch { /* best effort — never block launch on statusline config */ }
  }

  preTrust(workDir: string): void {
    const configPath = join(homedir(), ".codex", "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch {}

    const section = `[projects."${workDir}"]`;
    if (content.includes(section)) return;

    mkdirSync(dirname(configPath), { recursive: true });
    appendFileSync(configPath, `\n${section}\ntrust_level = "trusted"\n`);
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
      { pattern: /less than \d+% of your weekly limit/i, type: "quota", action: "notify", message: "Codex weekly limit running low" },
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

  cleanup(config: CliBackendConfig): void {
    for (const name of Object.keys(config.mcpServers)) {
      // Must match the sanitized name used in writeConfig, or removal misses it.
      const mcpName = `${name}-${config.instanceName}`.replace(/[^A-Za-z0-9_-]/g, "_");
      try { execFileSync(this.binaryPath, ["mcp", "remove", mcpName], { stdio: "ignore" }); } catch { /* best effort */ }
    }

    // Remove fleet instructions marker block from AGENTS.md
    try {
      const agentsMd = join(config.workingDirectory, "AGENTS.md");
      const isEmpty = removeMarker(agentsMd, config.instanceName);
      if (isEmpty && existsSync(agentsMd)) unlinkSync(agentsMd);
    } catch { /* best effort */ }

    // Remove trust entry from ~/.codex/config.toml
    try {
      const configPath = join(homedir(), ".codex", "config.toml");
      const content = readFileSync(configPath, "utf-8");
      const escaped = config.workingDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\n?\\[projects\\."${escaped}"\\]\\ntrust_level = "trusted"\\n?`);
      if (re.test(content)) {
        writeFileSync(configPath, content.replace(re, "\n"));
      }
    } catch { /* best effort */ }
  }
}
