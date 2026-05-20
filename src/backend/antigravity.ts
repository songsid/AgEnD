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
    const geminiDir = join(config.workingDirectory, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    const settingsPath = join(geminiDir, "settings.json");

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* ignore */ }
    }

    // Instance-namespaced MCP keys (same as gemini-cli) to avoid conflicts
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
      for (const [name, entry] of Object.entries(config.mcpServers)) {
        const instanceKey = `${name}-${config.instanceName}`;
        servers[instanceKey] = {
          ...entry,
          env: { ...(entry as any).env, AGEND_INSTANCE_NAME: config.instanceName },
        };
      }
      delete servers["agend"];
      settings.mcpServers = servers;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Write AGENTS.md instructions
    if (config.instructions) {
      const agentsPath = join(config.workingDirectory, "AGENTS.md");
      appendWithMarker(agentsPath, config.instanceName, config.instructions);
    }
  }

  cleanupConfig(workingDirectory: string, instanceName?: string): void {
    const agentsPath = join(workingDirectory, "AGENTS.md");
    if (existsSync(agentsPath)) {
      removeMarker(agentsPath, instanceName ?? "agend");
    }
    // Clean up namespaced MCP key
    const settingsPath = join(workingDirectory, ".gemini", "settings.json");
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const servers = settings.mcpServers;
        if (servers && instanceName) {
          delete servers[`agend-${instanceName}`];
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        }
      } catch { /* ignore */ }
    }
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
      { pattern: /RESOURCE_EXHAUSTED|quota/i, type: "quota", action: "notify", message: "Quota exhausted" },
      { pattern: /error.*authentication|UNAUTHENTICATED/i, type: "auth_error", action: "restart", message: "Authentication error" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [];
  }

  getRuntimeDialogs(): StartupDialog[] {
    return [];
  }
}
