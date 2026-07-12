import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    this.enableStatusLine();
  }

  /**
   * Turn on agy's status line so the TUI footer shows context usage, letting
   * /ctx scrape a context %. Merges { statusLine: { enabled: true } } into the
   * user's global ~/.gemini/antigravity-cli/settings.json WITHOUT clobbering any
   * other fields (e.g. a custom statusLine.command). Best-effort.
   */
  private enableStatusLine(): void {
    try {
      const agyDir = join(homedir(), ".gemini", "antigravity-cli");
      const settingsPath = join(agyDir, "settings.json");
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")) ?? {}; } catch { /* new/empty/corrupt → start fresh */ }
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {};
      const statusLine = (settings.statusLine && typeof settings.statusLine === "object" && !Array.isArray(settings.statusLine))
        ? settings.statusLine as Record<string, unknown>
        : {};
      if (statusLine.enabled === true) return;  // already on — don't rewrite the user's file
      statusLine.enabled = true;
      settings.statusLine = statusLine;
      mkdirSync(agyDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    } catch { /* best effort — never block launch on statusline config */ }
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
