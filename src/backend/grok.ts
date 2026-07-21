import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, isModelCompatible, resolveBinary, validateModel } from "./types.js";
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
 * Phase 2: ready pattern, cancel/quit keys, /compact, context format, and the
 * device-flow login dialog were confirmed against a live grok session. Error
 * strings beyond the cancellation notice are still best-effort and may need
 * tuning — the backend is registered as experimental (see factory.ts).
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
    // Verified: `❯` is the idle input prompt inside the TUI box; the Grok Build
    // header ("Grok Build" / "Grok <n>") also identifies the ready screen.
    return /❯|Grok \d|Grok Build/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    // NOTE: "Turn cancelled by user" is NORMAL behaviour (user interrupt), not an
    // error — none of the patterns below match it, and none should be added that do.
    // Error strings below are best-effort generic API shapes; tune once observed live.
    return [
      { pattern: /rate.?limit|too many requests|\b429\b/i, type: "rate_limit", action: "failover", message: "Grok rate limit reached" },
      { pattern: /unauthorized|authentication (failed|error)|\b401\b/i, type: "auth_error", action: "pause", message: "Grok authentication error" },
      { pattern: /quota|insufficient credits|out of credits/i, type: "quota", action: "notify", message: "Grok quota/credits exhausted" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      // Device-flow login is BLOCKING and cannot be auto-dismissed — the user must
      // approve externally. Empty keys => the daemon sends nothing but treats the
      // screen as "not ready yet" and keeps polling, so the login screen is never
      // mistaken for the idle prompt. (The "[Click here to Upgrade]" banner is
      // non-blocking and is intentionally NOT listed — nothing to dismiss.)
      { pattern: /Waiting for approval|Log in to continue|device.*approval/i, keys: [], description: "Grok device-flow login — wait for user authorization (no auto-dismiss)" },
    ];
  }

  getContextUsage(): number | null {
    // Grok shows context as "12K / 500K" (used / total) in the TUI, not in a file.
    // getContextUsage() has no pane access, so parsing lives in the pane scanners
    // (parseContextPercent in topic-commands.ts + defaultParser in cli.ts), which
    // is what /ctx and `agend ls` use. Nothing file-based to report here.
    return null;
  }

  getSessionId(): string | null {
    // Sessions live in ~/.grok/sessions and are resumed via --continue; no
    // external session ID is threaded through AgEnD.
    return null;
  }

  // grok has no slash quit command — it quits via the Ctrl+Q key chord (getQuitKey).
  getQuitCommand(): string | null { return null; }
  getQuitKey(): string { return "C-q"; }

  getCompactCommand(): string { return "/compact"; }   // verified present

  // Verified: grok interrupts generation on Ctrl+C.
  getCancelKey(): string { return "C-c"; }

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
