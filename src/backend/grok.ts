import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type RuntimeDialog, isModelCompatible, resolveBinary, validateModel } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

/**
 * Grok Build (xAI) — https://docs.x.ai/build/cli
 *
 * IMPORTANT — why the interactive TUI, not `grok agent stdio`:
 * Grok Build exposes three surfaces: the interactive TUI (`grok`), headless
 * (`grok -p "<prompt>"`), and an ACP agent (`grok agent stdio`) that speaks
 * JSON-RPC over stdin/stdout. AgEnD drives a backend through a tmux PTY — it
 * scans human-readable pane text for ready/error patterns and injects
 * keystrokes (cancel key, slash commands). An ACP JSON-RPC agent has no
 * human-readable prompt, ready banner, or slash commands, so the CliBackend
 * interface does not map onto it. The interactive TUI is the correct surface,
 * the same choice made for codex/opencode/kiro.
 *
 * ⚠️ PHASE 1 — patterns marked "UNVERIFIED" below are best-effort: the grok
 * binary is not installed in this environment, so the exact ready banner, error
 * strings, slash commands, and cancel key could not be observed live. They must
 * be confirmed against a real `grok` session before this backend is trusted in
 * production (three-state detection depends on getReadyPattern being correct).
 * The launch flags, MCP config path, and model names ARE confirmed from the
 * official docs (docs.x.ai/build/cli) and released documentation.
 */
export class GrokBackend implements CliBackend {
  readonly binaryName = "grok";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("grok");
  }

  buildCommand(config: CliBackendConfig): string {
    // Confirmed flags (docs.x.ai/build/cli): -m/--model, --always-approve,
    // -c/--continue, -r/--resume <ID>, -p/--single, --no-auto-update.
    // --no-auto-update: an auto-update prompt on launch would corrupt ready detection.
    let cmd = `${this.binaryPath} --no-auto-update`;
    // --always-approve auto-approves tool executions (AgEnD's skipPermissions default).
    if (config.skipPermissions !== false) cmd += " --always-approve";
    // --continue resumes the most recent session for this working directory.
    if (!config.skipResume) cmd += " --continue";
    if (config.model) {
      if (isModelCompatible("grok", config.model)) {
        cmd += ` --model ${validateModel(config.model)}`;
      } else {
        console.warn(`[agend] model "${config.model}" is not compatible with grok — skipping --model, using the CLI's default`);
      }
    }
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Grok Build merges MCP servers from a project-level .mcp.json (loaded below
    // ~/.grok/config.toml in priority). Using the project file means we never
    // clobber the user's global config. Standard mcpServers format: { command, args, env }.
    const mcpPath = join(config.workingDirectory, ".mcp.json");
    let root: Record<string, unknown> = {};
    try { root = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch { /* new file */ }

    const servers = (root.mcpServers ?? {}) as Record<string, unknown>;
    // Drop stale agend entries whose command binary no longer exists.
    for (const [key, val] of Object.entries(servers)) {
      if (key.startsWith("agend-")) {
        const cmd = (val as Record<string, unknown>)?.command;
        if (typeof cmd === "string" && !existsSync(cmd)) delete servers[key];
      }
    }
    // Namespace each server by instance so multiple instances can share a working dir.
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = `${name}-${config.instanceName}`;
      servers[instanceKey] = {
        command: entry.command,
        args: entry.args,
        env: { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName },
      };
    }
    // Clean up any legacy non-namespaced key.
    delete servers["agend"];
    root.mcpServers = servers;
    writeFileSync(mcpPath, JSON.stringify(root, null, 2));

    // Fleet instructions → AGENTS.md marker block (Grok reads AGENTS.md project docs,
    // same convention as Codex). Additive + idempotent via the AGEND marker.
    if (config.instructions) {
      try {
        appendWithMarker(join(config.workingDirectory, "AGENTS.md"), config.instanceName, config.instructions);
      } catch { /* best effort */ }
    }
  }

  getReadyPattern(): RegExp {
    // ⚠️ UNVERIFIED — needs confirmation against a live grok TUI. Matches the
    // likely input-ready hints (prompt glyph / "esc to interrupt" / help hint).
    // If wrong, three-state detection will misfire; verify before production use.
    return /[›❯]|esc to interrupt|\/help for|Ask Grok/im;
  }

  getErrorPatterns(): ErrorPattern[] {
    // ⚠️ UNVERIFIED error strings — generic API-error shapes, low risk but needs tuning.
    return [
      { pattern: /rate.?limit|too many requests|\b429\b/i, type: "rate_limit", action: "failover", message: "Grok rate limit reached" },
      { pattern: /unauthorized|authentication (failed|error)|\b401\b/i, type: "auth_error", action: "pause", message: "Grok authentication error" },
      { pattern: /quota|insufficient credits|out of credits/i, type: "quota", action: "notify", message: "Grok quota/credits exhausted" },
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    // ⚠️ UNVERIFIED — with --always-approve, tool-approval prompts should not
    // appear. Placeholder for any residual confirm prompt; confirm keys live.
    return [];
  }

  getContextUsage(): number | null {
    // No known file-based context source yet; statusline/parse support is a
    // later checklist phase (/ctx + agend ls %).
    return null;
  }

  getSessionId(): string | null {
    // Sessions live in ~/.grok/sessions and are resumed via --continue; no
    // external session ID is threaded through AgEnD.
    return null;
  }

  getQuitCommand(): string { return "/exit"; }   // ⚠️ UNVERIFIED

  getCompactCommand(): string { return "/compact"; }   // ⚠️ UNVERIFIED

  // ⚠️ UNVERIFIED — most coding TUIs interrupt generation on Escape (Ctrl+C exits).
  getCancelKey(): string { return "Escape"; }

  cleanup(config: CliBackendConfig): void {
    // Remove only this instance's namespaced MCP entries — a non-namespaced key
    // may belong to another instance sharing the working directory.
    try {
      const mcpPath = join(config.workingDirectory, ".mcp.json");
      if (existsSync(mcpPath)) {
        const root = JSON.parse(readFileSync(mcpPath, "utf-8"));
        if (root.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete root.mcpServers[`${name}-${config.instanceName}`];
          }
          writeFileSync(mcpPath, JSON.stringify(root, null, 2));
        }
      }
    } catch { /* best effort */ }

    // Remove fleet instructions marker block from AGENTS.md.
    try {
      removeMarker(join(config.workingDirectory, "AGENTS.md"), config.instanceName);
    } catch { /* best effort */ }
  }
}
