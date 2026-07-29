import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, type RuntimeDialog, isModelCompatible, resolveBinary, validateModel } from "./types.js";

export class KiroBackend implements CliBackend {
  readonly binaryName = "kiro-cli";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("kiro-cli");
  }

  buildCommand(config: CliBackendConfig): string {
    const ui = config.kiroUi ?? "legacy";
    let cmd = `${this.binaryPath} chat`;
    if (ui === "legacy") cmd += " --legacy-ui";
    else if (ui === "v3") cmd += " --v3";
    if (config.skipPermissions !== false) cmd += " --trust-all-tools";
    // --resume is boolean: Kiro auto-resumes latest conversation for this working directory
    if (!config.skipResume) cmd += " --resume";
    if (config.model) {
      if (isModelCompatible("kiro-cli", config.model)) {
        cmd += ` --model ${validateModel(config.model)}`;
      } else {
        console.warn(`[agend] model "${config.model}" is not compatible with kiro-cli — skipping --model, using the CLI's default`);
      }
    }
    cmd += " --require-mcp-startup";
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Kiro CLI reads workspace MCP config from .kiro/settings/mcp.json
    // Format: { "mcpServers": { "name": { command, args, env } } }
    //
    // WORKAROUND: kiro-cli ignores the "env" block in mcp.json — the MCP server
    // subprocess inherits the fleet manager's process env, which has a stale
    // AGEND_SOCKET_PATH from whichever daemon wrote to it last.
    // Fix: generate a wrapper script that exports the correct env vars before
    // exec-ing the real MCP server.
    const mcpDir = join(config.workingDirectory, ".kiro", "settings");
    mkdirSync(mcpDir, { recursive: true });
    const mcpConfigPath = join(mcpDir, "mcp.json");

    let mcpConfig: Record<string, unknown> = {};
    try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch { /* new file */ }

    const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
    // Remove stale agend entries whose wrapper scripts no longer exist
    for (const [key, val] of Object.entries(servers)) {
      if (key.startsWith("agend-")) {
        const cmd = (val as Record<string, unknown>)?.command;
        if (typeof cmd === "string" && !existsSync(cmd)) {
          delete servers[key];
        }
      }
    }
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = `${name}-${config.instanceName}`;
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };

      // Write a wrapper script that sets env vars explicitly
      const wrapperPath = join(this.instanceDir, `mcp-wrapper-${name}.sh`);
      const envExports = Object.entries(allEnv)
        .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
        .join("\n");
      // 0o700 (owner-only rwx): wrapper inlines sensitive env (tokens, socket paths).
      // Other users on the host must not be able to read it. Set mode at creation
      // to avoid a world-readable window between writeFileSync and chmodSync.
      writeFileSync(
        wrapperPath,
        `#!/bin/bash\n${envExports}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${entry.command} ${entry.args.map((a: string) => JSON.stringify(a)).join(" ")}\n`,
        { mode: 0o700 },
      );
      // Re-chmod in case the file already existed with looser permissions (writeFileSync's
      // mode only applies on create).
      chmodSync(wrapperPath, 0o700);

      servers[instanceKey] = {
        command: wrapperPath,
        args: [],
      };
    }
    // Clean up old non-namespaced key if present
    delete servers["agend"];
    mcpConfig.mcpServers = servers;

    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Write fleet instructions to .kiro/steering/ (auto-loaded by Kiro CLI)
    if (config.instructions) {
      try {
        const steeringDir = join(config.workingDirectory, ".kiro", "steering");
        mkdirSync(steeringDir, { recursive: true });
        writeFileSync(join(steeringDir, `agend-${config.instanceName}.md`), config.instructions);
      } catch { /* best effort */ }
    }
  }

  getReadyPattern(): RegExp {
    // Startup: trust/banner text. Daily prompt: "22% !>" / "8% ❯";
    // Kiro may insert mode glyphs between them, e.g. "20% λ !>".
    // TUI statusline: "◔ 22%" context indicator shown while waiting for input.
    return /All tools are now trusted|Trust All Tools active|Credits:.*Time:|ask a question or describe a task|\d+%.*[!❯>]|◔\s*\d+%/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /having trouble responding/i, type: "rate_limit", action: "notify", message: "Rate limit (having trouble responding)" },
      { pattern: /model.*not available|Please use '\/model'/i, type: "model_error", action: "notify", message: "Model unavailable — use /model to switch" },
      { pattern: /Response timed out/i, type: "timeout", action: "notify", message: "Kiro response timed out (generation too long) — please try again", skipCooldown: true, skipRecoveryWait: true },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      {
        // Kiro CLI --trust-all-tools now shows a confirmation prompt.
        // Default cursor is on "No, exit" — press Down then Enter to select "Yes, I accept".
        pattern: /[❯›]\s*No, exit/m,
        keys: ["Down", "Enter"],
        description: "Kiro --trust-all-tools confirmation — navigate to 'Yes, I accept'",
      },
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      {
        // Same trust prompt can also appear mid-session if Kiro re-validates.
        pattern: /Do you trust the files|Yes, I accept[\s\S]*No, exit/m,
        keys: ["Down", "Enter"],
        description: "Kiro trust confirmation dialog — auto-accept",
      },
    ];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    // Kiro manages sessions internally via SQLite keyed by working directory.
    // No external session ID needed — --resume handles it automatically.
    return null;
  }

  getQuitCommand(): string { return "/quit"; }

  getCompactCommand(): string { return "/compact"; }

  // kiro's in-session `/model` opens an interactive picker (not a one-shot
  // command), so a runtime paste can't select a specific model — use restart.
  getModelSwitchStrategy(): "runtime" | "restart" { return "restart"; }

  /**
   * Parse `chat --list-models --format json` once. Verified format:
   * `{ "models": [{ model_name, model_id, description, ... }], "default_model": "auto" }`.
   * A bare array (older/other shape) is tolerated. Never throws.
   */
  private readModelsPayload(): { models: import("./types.js").ModelOption[]; defaultModel?: string } {
    try {
      const out = execFileSync(this.binaryPath, ["chat", "--list-models", "--format", "json"],
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const parsed = JSON.parse(out);
      const arr: unknown[] = Array.isArray(parsed) ? parsed : (parsed?.models ?? []);
      const models = arr.map((m: unknown) => {
        if (typeof m === "string") return { id: m, label: m };
        const o = m as Record<string, unknown>;
        const id = String(o.model_id ?? o.id ?? o.name ?? o.model ?? "");
        const label = String(o.model_name ?? o.name ?? o.label ?? id);
        const desc = typeof o.description === "string" ? o.description : undefined;
        return desc ? { id, label, description: desc } : { id, label };
      }).filter(o => o.id);
      const dm = Array.isArray(parsed) ? undefined : parsed?.default_model;
      return { models, defaultModel: typeof dm === "string" && dm.trim() ? dm.trim() : undefined };
    } catch { /* unknown flag/format — fall back to free-text */ }
    return { models: [] };
  }

  async listModels(): Promise<import("./types.js").ModelOption[]> {
    return this.readModelsPayload().models;
  }

  async probeCLIEnv() {
    const { probeCliVersion } = await import("./types.js");
    const { models, defaultModel } = this.readModelsPayload();
    return { version: probeCliVersion(this.binaryPath), models, currentModel: defaultModel };
  }

  // kiro-cli interrupts generation on Ctrl+C (others use Escape).
  getCancelKey(): string { return "C-c"; }

  cleanup(config: CliBackendConfig): void {
    // Only remove namespaced keys — non-namespaced "agend" key may belong to
    // another instance sharing this working directory.
    try {
      const mcpConfigPath = join(config.workingDirectory, ".kiro", "settings", "mcp.json");
      if (existsSync(mcpConfigPath)) {
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        if (mcpConfig.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete mcpConfig.mcpServers[`${name}-${config.instanceName}`];
          }
          writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        }
      }
    } catch { /* best effort */ }

    // Remove fleet instructions steering file
    try {
      const steeringFile = join(config.workingDirectory, ".kiro", "steering", `agend-${config.instanceName}.md`);
      if (existsSync(steeringFile)) unlinkSync(steeringFile);
    } catch { /* best effort */ }
  }
}
