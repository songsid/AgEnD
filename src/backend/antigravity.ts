import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, resolveBinary } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

export class AntigravityBackend implements CliBackend {
  readonly binaryName = "agy";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("agy");
  }

  buildCommand(config: CliBackendConfig): string {
    let cmd = `${this.binaryPath} --dangerously-skip-permissions`;
    if (!config.skipResume) cmd += " --continue";
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Antigravity uses .gemini/settings.json for MCP servers (same structure as gemini-cli)
    const geminiDir = join(config.workingDirectory, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    const settingsPath = join(geminiDir, "settings.json");

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* ignore */ }
    }

    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      settings.mcpServers = config.mcpServers;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Write AGENTS.md instructions
    if (config.instructions) {
      const agentsPath = join(config.workingDirectory, "AGENTS.md");
      appendWithMarker(agentsPath, config.instanceName, config.instructions);
    }
  }

  cleanupConfig(workingDirectory: string): void {
    const agentsPath = join(workingDirectory, "AGENTS.md");
    if (existsSync(agentsPath)) {
      removeMarker(agentsPath, "agend");
    }
  }

  getPromptPattern(): RegExp {
    return /^>\s*$/m;
  }

  getReadyPattern(): RegExp {
    return /\? for shortcuts|Gemini/m;
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    try {
      const f = join(this.instanceDir, "session-id");
      return readFileSync(f, "utf-8").trim() || null;
    } catch { return null; }
  }

  getQuitCommand(): string { return "/quit"; }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /error.*quota/i, type: "quota", action: "restart", message: "Quota exceeded" },
      { pattern: /error.*authentication/i, type: "auth_error", action: "restart", message: "Authentication error" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [];
  }

  getRuntimeDialogs(): StartupDialog[] {
    return [];
  }
}
