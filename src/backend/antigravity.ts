import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, realpathSync, lstatSync } from "node:fs";
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

  /**
   * If workingDirectory is under a hidden path (e.g. ~/.agend/workspaces/),
   * agy refuses to operate. Create a non-hidden symlink and return it.
   */
  resolveWorkingDirectory(workingDirectory: string, instanceName?: string): string {
    const home = homedir();
    const rel = workingDirectory.startsWith(home) ? "~" + workingDirectory.slice(home.length) : workingDirectory;
    const parts = rel.split("/");
    const hasHidden = parts.some(p => p.startsWith(".") && p !== "~");
    if (!hasHidden) return workingDirectory;

    const symlinkName = instanceName || parts[parts.length - 1] || "workspace";
    const symlinkParent = join(home, "agend-workspaces");
    mkdirSync(symlinkParent, { recursive: true });
    const symlinkPath = join(symlinkParent, symlinkName);

    if (existsSync(symlinkPath)) {
      try {
        if (realpathSync(symlinkPath) !== workingDirectory) {
          unlinkSync(symlinkPath);
          symlinkSync(workingDirectory, symlinkPath);
        }
      } catch {
        try { unlinkSync(symlinkPath); } catch { /* ignore */ }
        try { symlinkSync(workingDirectory, symlinkPath); } catch { /* ignore */ }
      }
    } else {
      symlinkSync(workingDirectory, symlinkPath);
    }
    return symlinkPath;
  }

  writeConfig(config: CliBackendConfig): void {
    const agentsDir = join(config.workingDirectory, ".agents");
    mkdirSync(agentsDir, { recursive: true });
    const mcpConfigPath = join(agentsDir, "mcp_config.json");

    let mcpConfig: Record<string, unknown> = {};
    if (existsSync(mcpConfigPath)) {
      try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch { /* ignore */ }
    }

    // Write MCP servers in agy format
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
      for (const [name, entry] of Object.entries(config.mcpServers)) {
        const instanceKey = `${name}-${config.instanceName}`;
        servers[instanceKey] = {
          ...entry,
          env: { ...(entry as any).env, AGEND_INSTANCE_NAME: config.instanceName },
        };
      }
      delete servers["agend"];
      mcpConfig.mcpServers = servers;
    }

    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Write AGENTS.md instructions in .agents/ directory
    if (config.instructions) {
      const agentsPath = join(agentsDir, "AGENTS.md");
      appendWithMarker(agentsPath, config.instanceName, config.instructions);
    }
  }

  cleanup(config: CliBackendConfig): void {
    const agentsDir = join(config.workingDirectory, ".agents");
    const agentsPath = join(agentsDir, "AGENTS.md");
    if (existsSync(agentsPath)) {
      removeMarker(agentsPath, config.instanceName);
    }
    // Clean up namespaced MCP key
    const mcpConfigPath = join(agentsDir, "mcp_config.json");
    if (existsSync(mcpConfigPath)) {
      try {
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        const servers = mcpConfig.mcpServers;
        if (servers) {
          delete servers[`agend-${config.instanceName}`];
          writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        }
      } catch { /* ignore */ }
    }
    // Remove symlink
    const symlinkPath = join(homedir(), "agend-workspaces", config.instanceName);
    try {
      const stat = lstatSync(symlinkPath);
      if (stat.isSymbolicLink()) unlinkSync(symlinkPath);
    } catch { /* ignore */ }
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
    return [
      { pattern: /Do you trust.*folder|Yes, I trust/i, keys: ["Enter"], description: "Trust folder prompt" },
    ];
  }

  getRuntimeDialogs(): StartupDialog[] {
    return [];
  }
}
