import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, type RuntimeDialog, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";

export class OpenCodeBackend implements CliBackend {
  readonly binaryName = "opencode";
  private binaryPath: string;
  /** cwd of the last spawn — getSessionId matches OpenCode's session rows by directory. */
  private workingDirectory: string | null = null;
  /** Session id passed via --session at the last spawn, if any. */
  private launchedSessionId: string | null = null;
  /** Epoch ms of the last spawn — sessions created before it belong to someone else. */
  private launchedAt: number | null = null;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("opencode");
  }

  buildCommand(config: CliBackendConfig): string {
    // Use per-instance config via OPENCODE_CONFIG env (set in writeConfig)
    let cmd = this.binaryPath;
    this.workingDirectory = config.workingDirectory;
    this.launchedSessionId = null;
    this.launchedAt = Date.now();

    // Resume only a session explicitly persisted for this instance. OpenCode's
    // --continue is global and can hijack an unrelated session from another cwd.
    if (!config.skipResume) {
      const sessionIdFile = join(this.instanceDir, "session-id");
      if (existsSync(sessionIdFile)) {
        const sid = readFileSync(sessionIdFile, "utf-8").trim();
        if (sid) {
          cmd += ` --session ${sid}`;
          this.launchedSessionId = sid;
        }
      }
    }

    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("opencode", model);
      cmd += ` --model ${shellQuote(model)}`;
    }

    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // OpenCode reads opencode.json from the working directory.
    // Use instance-specific MCP server key name to avoid conflicts when
    // multiple instances share the same working directory.
    const configPath = join(config.workingDirectory, "opencode.json");
    let oc: Record<string, unknown> = {};
    try {
      oc = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch { /* new file */ }

    // MCP servers — use instance name as key to avoid multi-instance conflicts
    const mcp = (oc.mcp ?? {}) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const safeInstanceName = config.instanceName.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, "-") || config.instanceName.replace(/[^a-zA-Z0-9-]/g, "x");
      const instanceKey = `${name}-${safeInstanceName}`;
      // Remove old non-sanitized key if present
      const oldKey = `${name}-${config.instanceName}`;
      if (oldKey !== instanceKey) delete mcp[oldKey];
      mcp[instanceKey] = {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName },
      };
    }
    // Clean up old non-namespaced key if present
    delete mcp["agend"];
    oc.mcp = mcp;
    delete oc.mcpServers;

    // Add fleet instructions file to instructions (additive — appends to existing array)
    if (config.instructions) {
      try {
        const instrFile = join(config.instanceDir, "fleet-instructions.md");
        writeFileSync(instrFile, config.instructions);
        const paths = (oc.instructions ?? []) as string[];
        if (!paths.includes(instrFile)) paths.push(instrFile);
        oc.instructions = paths;
      } catch { /* best effort */ }
    }

    writeFileSync(configPath, JSON.stringify(oc, null, 2));
  }

  getReadyPattern(): RegExp {
    return /Ask anything|ctrl\+p commands/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      {
        // Pane scrollback also contains the user's prose. Require OpenCode's
        // decorated error-line prefix and token boundaries so IDs such as
        // 14290/4012 cannot trigger recovery actions.
        pattern: /^\s*(?:■|⚠️?|Error:)\s*[^\n]*\b(?:rate[ _-]?limit(?:ed|ing)?|too many requests|429)\b/im,
        type: "rate_limit",
        action: "failover",
        message: "Rate limit reached",
      },
      {
        pattern: /^\s*(?:■|⚠️?|Error:)\s*[^\n]*\b(?:auth(?:entication)?[ _-]?(?:error|failed|failure)|unauthorized|401)\b/im,
        type: "auth_error",
        action: "pause",
        message: "Authentication error",
      },
    ];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    const discovered = this.discoverSessionId();
    if (discovered) return discovered;
    // Fallback: the id persisted by a previous save (also covers the daemon-start
    // path where a stale window from the previous run is saved before any spawn
    // in this process has captured workingDirectory).
    try {
      const f = join(this.instanceDir, "session-id");
      return readFileSync(f, "utf-8").trim() || null;
    } catch { return null; }
  }

  /**
   * Find this instance's OpenCode session via the CLI's own listing —
   * `opencode session list --format json` — the official output surface for
   * exactly the data this needs ({ id, directory, created, updated } per
   * session, newest first, subagent children excluded). This replaced a
   * direct read of opencode.db: same information, but semver-protected CLI
   * output instead of a private sqlite schema, and no node:sqlite
   * requirement. ~1.2s per call is fine — discovery only runs from
   * saveSessionId sites (shutdown, pause, crash respawn, idle checkpoint),
   * never on a hot path.
   *
   * A row is only accepted when it matches the spawn this backend performed:
   * same directory AND (created after our launch, or the exact id we resumed
   * with). A session someone created manually in the same cwd before our
   * spawn can therefore never be adopted — the hijack #525 removed must not
   * return through this path. The directory filter is done here because the
   * listing is global; `--continue`'s apparent per-cwd behavior is an
   * undocumented server-scoping side effect we deliberately do not rely on.
   */
  private discoverSessionId(): string | null {
    if (!this.workingDirectory || this.launchedAt === null) return null;
    const sessions = this.listSessions();
    if (!sessions) return null;
    const candidates = sessions
      .filter(s => s.directory === this.workingDirectory && !s.parentID)
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    for (const session of candidates) {
      if (session.id === this.launchedSessionId) return session.id;
      if ((session.created ?? 0) >= this.launchedAt) return session.id;
    }
    return null;
  }

  /**
   * `opencode session list --format json`, bounded and best-effort. Split out
   * as the process-spawning seam so tests stub it with fixture rows instead
   * of a real CLI.
   *
   * Runs with cwd = the instance's working directory: the listing is scoped
   * to the PROJECT opencode resolves for the cwd it runs in (a git root, or
   * the "global" project outside one — verified on 1.18.15). Run anywhere
   * else and the instance's sessions may simply not be in the output. The
   * exact-directory filter in discoverSessionId still applies on top, because
   * a project can span several directories (worktrees, monorepo).
   */
  private listSessions(): Array<{ id: string; directory: string; created?: number; updated?: number; parentID?: string }> | null {
    if (!this.workingDirectory) return null;
    try {
      const out = execFileSync(
        this.binaryPath,
        ["session", "list", "--format", "json", "-n", "50"],
        { encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], cwd: this.workingDirectory },
      );
      const parsed = JSON.parse(out);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      // CLI missing/slow/failed, or the working directory is gone — resume is
      // best-effort, never fatal.
      return null;
    }
  }

  getQuitCommand(): string { return "/quit"; }

  getCompactCommand(): string { return "/compact"; }
  getClearCommand(): string { return "/clear"; }

  // OpenCode's default session_interrupt keybinding is Escape (Ctrl+C exits).
  getCancelKey(): string { return "Escape"; }

  async listModels(): Promise<import("./types.js").ModelOption[]> {
    // Verified: `opencode models` prints one `provider/model` id per line.
    try {
      const out = execFileSync(this.binaryPath, ["models"],
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const ids = [...new Set(out.split("\n")
        .map(l => l.trim().split(/\s+/)[0])
        .filter(id => /^[\w.-]+\/[\w.-]+$/.test(id)))];
      if (ids.length) return ids.map(id => ({ id, label: id }));
    } catch { /* fall back to free-text */ }
    return [];
  }

  async probeCLIEnv(): Promise<{ version?: string; models: import("./types.js").ModelOption[] }> {
    const { probeCliVersion } = await import("./types.js");
    return { version: probeCliVersion(this.binaryPath), models: await this.listModels() };
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      { pattern: /Permission required/i, keys: ["Right", "Enter"], description: "OpenCode permission prompt — Allow always" },
      { pattern: /confirm/i, keys: ["Enter"], description: "OpenCode confirm prompt" },
    ];
  }

  cleanup(config: CliBackendConfig): void {
    // Clean up instance-specific MCP entries from opencode.json.
    // Only remove namespaced keys — non-namespaced "agend" key may belong to
    // another instance sharing this working directory.
    try {
      const configPath = join(config.workingDirectory, "opencode.json");
      if (existsSync(configPath)) {
        const oc = JSON.parse(readFileSync(configPath, "utf-8"));
        if (oc.mcp) {
          for (const name of Object.keys(config.mcpServers)) {
            const safeName = config.instanceName.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, "-") || config.instanceName.replace(/[^a-zA-Z0-9-]/g, "x");
            delete oc.mcp[`${name}-${safeName}`];
            delete oc.mcp[`${name}-${config.instanceName}`]; // clean up old non-sanitized keys
          }
        }
        // Remove fleet instructions path from instructions
        const instrFile = join(config.instanceDir, "fleet-instructions.md");
        if (Array.isArray(oc.instructions)) {
          oc.instructions = oc.instructions.filter((p: string) => p !== instrFile);
        }
        writeFileSync(configPath, JSON.stringify(oc, null, 2));
      }
    } catch { /* best effort */ }

    // Remove fleet instructions file
    try {
      const instrFile = join(config.instanceDir, "fleet-instructions.md");
      if (existsSync(instrFile)) unlinkSync(instrFile);
    } catch { /* best effort */ }
  }
}
