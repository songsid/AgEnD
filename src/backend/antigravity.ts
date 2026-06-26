import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, warnIfModelMismatch, resolveBinary } from "./types.js";
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
    if (config.model) {
      warnIfModelMismatch("antigravity", config.model);
      // agy display names contain spaces/parens — strip only shell-unsafe chars
      // rather than validateModel() (which forbids spaces).
      cmd += ` --model ${config.model.replace(/[^a-zA-Z0-9_./ ()-]/g, "")}`;
    }
    return cmd;
  }

  /**
   * If workingDirectory is under a hidden path (e.g. ~/.agend/workspaces/),
   * agy refuses to operate. Use a real non-hidden directory instead.
   */
  resolveWorkingDirectory(workingDirectory: string, instanceName?: string): string {
    const home = homedir();
    const rel = workingDirectory.startsWith(home) ? "~" + workingDirectory.slice(home.length) : workingDirectory;
    const parts = rel.split("/");
    const hasHidden = parts.some(p => p.startsWith(".") && p !== "~");
    if (!hasHidden) return workingDirectory;

    const name = instanceName || parts[parts.length - 1] || "workspace";
    const resolvedDir = join(home, "agend-workspaces", name);
    mkdirSync(resolvedDir, { recursive: true });
    return resolvedDir;
  }

  writeConfig(config: CliBackendConfig): void {
    // Write .agents/agents.md in the resolved CWD (which may differ from config.workingDirectory)
    const cwd = this.resolveWorkingDirectory(config.workingDirectory, config.instanceName);
    const agentsDir = join(cwd, ".agents");
    mkdirSync(agentsDir, { recursive: true });

    if (config.instructions) {
      const agentsPath = join(agentsDir, "agents.md");
      appendWithMarker(agentsPath, config.instanceName, config.instructions);
    }
  }

  cleanup(config: CliBackendConfig): void {
    const cwd = join(homedir(), "agend-workspaces", config.instanceName);
    if (existsSync(cwd)) {
      try { rmSync(cwd, { recursive: true }); } catch { /* ignore */ }
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
    return [
      { pattern: /Do you trust.*folder|Yes, I trust/i, keys: ["Enter"], description: "Trust folder prompt" },
    ];
  }

  getRuntimeDialogs(): StartupDialog[] {
    return [];
  }
}
