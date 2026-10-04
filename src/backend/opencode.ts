import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, type RuntimeDialog, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";
import {
  cachedOpencodeAutoSupport,
  opencodeAlwaysConfirmActive,
  opencodePermissionPromptActive,
  probeOpencodeAutoSupport,
} from "./opencode-permission.js";

export class OpenCodeBackend implements CliBackend {
  readonly binaryName = "opencode";
  private binaryPath: string;
  /** cwd of the last spawn — getSessionId matches OpenCode's session rows by directory. */
  private workingDirectory: string | null = null;
  /** Session id passed via --session at the last spawn, if any. */
  private launchedSessionId: string | null = null;
  /** Epoch ms of the last spawn — sessions created before it belong to someone else. */
  private launchedAt: number | null = null;
  /**
   * Bumped by every buildCommand. A discovery is only ever valid for the launch it started
   * under: the hijack guard below (created after OUR launch, or the id we resumed with) is
   * defined against launchedAt/launchedSessionId, so a listing that comes back after a newer
   * launch must not be judged against — or cached for — the newer one.
   */
  private launchGeneration = 0;
  /** What discovery found, and for which launch. */
  private discovered: { generation: number; id: string } | null = null;
  /** The discovery running now: concurrent callers share it instead of forking another CLI. */
  private discovering: { generation: number; promise: Promise<string | null> } | null = null;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("opencode");
  }

  /**
   * Find out, off the event loop, whether this binary's TUI takes `--auto` (cached per binary
   * generation). The daemon awaits it before it builds the launch command; `buildCommand` itself
   * only reads the answer.
   */
  async prepareLaunch(): Promise<void> {
    await probeOpencodeAutoSupport(this.binaryPath);
  }

  buildCommand(config: CliBackendConfig): string {
    // Use per-instance config via OPENCODE_CONFIG env (set in writeConfig)
    let cmd = this.binaryPath;
    // Every other backend runs with its skip-permissions switch; OpenCode asks before it touches a
    // path outside the project, so without one an instance parks on "Access external directory".
    // `--auto` answers every ask "once" itself and keeps an explicit `deny`, but only a binary whose
    // --help lists it may be given it (an unknown flag makes OpenCode exit 1). Anything else — an
    // older OpenCode, an unreadable help — gets NO switch: the only version-independent form, the
    // OPENCODE_PERMISSION env, is merged over the user's own config and would override their
    // `deny`, and the runtime dialog below answers the prompt "once" instead. See opencode-permission.ts.
    if (config.skipPermissions !== false && cachedOpencodeAutoSupport(this.binaryPath) === "yes") cmd += " --auto";
    this.workingDirectory = config.workingDirectory;
    this.launchedSessionId = null;
    this.launchedAt = Date.now();
    this.launchGeneration++;

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

  /**
   * Synchronous and cache-only (#1160): what the last finished discovery found for THIS launch, else
   * the id persisted by a previous save (which also covers the daemon-start path where a stale
   * window from the previous run is saved before any spawn in this process has captured
   * workingDirectory). It never forks the CLI — it used to, for up to 15 s, on the fleet thread,
   * from every idle observation. `refreshSessionId()` is what updates the cache.
   */
  getSessionId(): string | null {
    if (this.discovered && this.discovered.generation === this.launchGeneration) return this.discovered.id;
    try {
      const f = join(this.instanceDir, "session-id");
      return readFileSync(f, "utf-8").trim() || null;
    } catch { return null; }
  }

  /**
   * Find this instance's OpenCode session via the CLI's own listing and cache it for `getSessionId()`.
   * Single-flight: a call made while a discovery is running gets that discovery's promise, so an
   * idle observation and a stop/pause racing it cost ONE CLI run. Never rejects.
   *
   * Resolves to what `getSessionId()` answers afterwards. Before any spawn in this process
   * (no workingDirectory/launchedAt to judge a row against) there is nothing to discover and that
   * is the persisted id.
   */
  refreshSessionId(): Promise<string | null> {
    if (!this.workingDirectory || this.launchedAt === null) return Promise.resolve(this.getSessionId());
    const generation = this.launchGeneration;
    if (this.discovering && this.discovering.generation === generation) return this.discovering.promise;
    const launch = { workingDirectory: this.workingDirectory, launchedAt: this.launchedAt, launchedSessionId: this.launchedSessionId };
    const entry: { generation: number; promise: Promise<string | null> } = {
      generation,
      promise: this.discoverSessionId(launch).then(found => {
        // A newer launch started while the CLI was listing: the rows were judged against the OLD
        // launch's directory/time/resumed id and mean nothing for the new one. Drop them.
        if (found && this.launchGeneration === generation) this.discovered = { generation, id: found };
        return this.getSessionId();
      }, () => this.getSessionId()).finally(() => {
        if (this.discovering === entry) this.discovering = null;
      }),
    };
    this.discovering = entry;
    return entry.promise;
  }

  /**
   * Find this instance's OpenCode session via the CLI's own listing —
   * `opencode session list --format json` — the official output surface for
   * exactly the data this needs ({ id, directory, created, updated } per
   * session, newest first, subagent children excluded). This replaced a
   * direct read of opencode.db: same information, but semver-protected CLI
   * output instead of a private sqlite schema, and no node:sqlite
   * requirement. ~1 s per call, which is why it runs asynchronously and
   * single-flight (refreshSessionId) and is never on the synchronous path.
   *
   * A row is only accepted when it matches the spawn this backend performed:
   * same directory AND (created after our launch, or the exact id we resumed
   * with). A session someone created manually in the same cwd before our
   * spawn can therefore never be adopted — the hijack #525 removed must not
   * return through this path. The directory filter is done here because the
   * listing is global; `--continue`'s apparent per-cwd behavior is an
   * undocumented server-scoping side effect we deliberately do not rely on.
   */
  private async discoverSessionId(launch: { workingDirectory: string; launchedAt: number; launchedSessionId: string | null }): Promise<string | null> {
    const sessions = await this.listSessions(launch.workingDirectory);
    if (!sessions) return null;
    const candidates = sessions
      .filter(s => s.directory === launch.workingDirectory && !s.parentID)
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    for (const session of candidates) {
      if (session.id === launch.launchedSessionId) return session.id;
      if ((session.created ?? 0) >= launch.launchedAt) return session.id;
    }
    return null;
  }

  /**
   * `opencode session list --format json`, bounded and best-effort, off the event loop. Split out
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
  private async listSessions(workingDirectory: string): Promise<Array<{ id: string; directory: string; created?: number; updated?: number; parentID?: string }> | null> {
    try {
      const { stdout } = await promisify(execFile)(
        this.binaryPath,
        ["session", "list", "--format", "json", "-n", "50"],
        { encoding: "utf-8", timeout: 15_000, cwd: workingDirectory },
      );
      const parsed = JSON.parse(stdout);
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
    // Only reached when the launch switch (--auto / OPENCODE_PERMISSION) did not cover a prompt — a
    // `.env` read on an older OpenCode, a user config's own `ask`. Answered with "Allow once": the
    // option OpenCode selects by default, one Enter, nothing remembered. (This used to be
    // Right+Enter = "Allow always", an implicit and wider grant.) Both are structural, not a
    // viewport grep: a transcript that quotes the prompt has the idle prompt below it and is not
    // answered, and while a real one is up the pane takes no delivery and is not "stuck".
    return [
      {
        pattern: /Permission required/i,
        isActive: opencodePermissionPromptActive,
        keys: ["Enter"],
        description: "OpenCode permission prompt — Allow once",
        blocksDelivery: true,
        inputBlocked: true,
      },
      {
        // The page behind "Allow always" (a human, or an older AgEnD, got that far): Escape is
        // OpenCode's own Cancel there (verified on 1.16.2 / 1.17.20 / 1.18.34, whichever of
        // Confirm / Cancel is highlighted) and goes back to the prompt above, which is then answered
        // with "Allow once". Right+Enter is NOT a cancel: with Cancel already selected it wraps to Confirm.
        pattern: /Always allow/i,
        isActive: opencodeAlwaysConfirmActive,
        keys: ["Escape"],
        description: "OpenCode 'Always allow' confirmation — Cancel (back to the prompt)",
        blocksDelivery: true,
        inputBlocked: true,
      },
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
