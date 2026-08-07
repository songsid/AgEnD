import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, type RuntimeDialog, resolveBinary, validateModel, warnIfModelMismatch } from "./types.js";

/** Minimal surface of node:sqlite we use (loaded lazily — Node <22.13 lacks it). */
interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  };
}

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
      cmd += ` --model ${model}`;
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
      { pattern: /rate.?limit|too many requests|429/i, type: "rate_limit", action: "failover", message: "Rate limit reached" },
      { pattern: /auth.*error|unauthorized|401/i, type: "auth_error", action: "pause", message: "Authentication error" },
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
   * Find this instance's OpenCode session in opencode's own sqlite DB
   * ($XDG_DATA_HOME/opencode/opencode.db, table `session` with id/directory/
   * timestamps). OpenCode never exports the id of a TUI session anywhere the
   * daemon can read directly, so this is the discovery source that lets
   * saveSessionId → session-id file → `--session <id>` resume work at all.
   *
   * A row is only accepted when it matches the spawn this backend performed:
   * same directory AND (created after our launch, or the exact id we resumed
   * with). A session someone created manually in the same cwd before our spawn
   * can therefore never be adopted — the hijack #525 removed must not return
   * through this path.
   *
   * Requires node:sqlite (unflagged since Node 22.13); on older runtimes this
   * quietly returns null and resume simply stays unavailable.
   */
  private discoverSessionId(): string | null {
    if (!this.workingDirectory || this.launchedAt === null) return null;
    try {
      const sqlite = (process as { getBuiltinModule?: (id: string) => unknown })
        .getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
      if (!sqlite) return null;
      const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
      const dbPath = join(dataHome, "opencode", "opencode.db");
      if (!existsSync(dbPath)) return null;
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        // parent_id IS NULL excludes subagent child sessions. LIMIT 10 keeps the
        // scan bounded; the active session is the newest by time_updated anyway.
        const rows = db.prepare(
          "SELECT id, time_created FROM session WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 10",
        ).all(this.workingDirectory) as Array<{ id: string; time_created: number }>;
        for (const row of rows) {
          if (row.id === this.launchedSessionId) return row.id;
          if (row.time_created >= this.launchedAt) return row.id;
        }
        return null;
      } finally {
        db.close();
      }
    } catch {
      // DB busy/locked, sqlite unavailable, schema drift — resume is best-effort.
      return null;
    }
  }

  getQuitCommand(): string { return "/quit"; }

  getCompactCommand(): string { return "/compact"; }

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
