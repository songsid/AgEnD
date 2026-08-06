import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, type RuntimeDialog, resolveBinary, validateEffort, validateModel, warnIfModelMismatch } from "./types.js";
import { PIE_CLASS } from "../tui-glyphs.js";

export class KiroBackend implements CliBackend {
  readonly binaryName = "kiro-cli";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("kiro-cli");
  }

  requiresDeliveryEnterRetry(): boolean {
    // Kiro has no native Enter-submitted input queue, and its TUI can swallow
    // Enter while still processing a paste (post-restart redraw, or a large
    // paste on a slow host) while producing output that looks busy — so
    // observation alone cannot decide whether the message was submitted. A
    // second bare Enter is safe for Kiro on every delivery: verified live that
    // it is a no-op both at an empty prompt and during generation.
    return true;
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
      const model = validateModel(config.model);
      warnIfModelMismatch("kiro-cli", model);
      cmd += ` --model ${model}`;
    }
    if (config.effort) cmd += ` --effort ${validateEffort(config.effort)}`;
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
    // TUI statusline: the context indicator shown while waiting for input,
    // e.g. "◑ 27%". The glyph steps through PIE_GLYPHS as the window fills,
    // so all of them have to match — not just the low-usage "◔".
    return new RegExp(
      `All tools are now trusted|Trust All Tools active|Credits:.*Time:`
      + `|ask a question or describe a task|\\d+%.*[!❯>]|${PIE_CLASS}\\s*\\d+%`,
      "m",
    );
  }

  /**
   * The tool kiro is running right now, for the live progress line.
   *
   * kiro announces every tool call in the pane and reports its completion
   * separately. Captured from a live pane:
   *
   *   I will run the following command: … (using tool: shell)
   *   Purpose: Merge #419
   *    - Completed in 67.914s
   *
   * So "running" is not a marker but a *relationship*: the last announcement with
   * no completion line after it. Comparing positions is what makes this usable —
   * matching `(using tool: …)` alone would leave the last tool of the turn pinned
   * to the progress line forever.
   *
   * `Purpose:` is included when kiro emitted one, because "shell: Merge #419" says
   * far more than "shell". It is agent-written text; the caller flattens and caps
   * it.
   */
  getPaneActivity(pane: string): string | null {
    const announcements = [...pane.matchAll(/\(using tool: ([^)\n]+)\)/g)];
    const last = announcements.at(-1);
    if (last?.index === undefined) return null; // index 0 is a valid position

    const after = pane.slice(last.index);
    if (/^\s*-\s*Completed in\b/m.test(after)) return null; // that tool has finished

    const purpose = after.match(/^\s*Purpose:\s*(.+)$/m);
    return purpose ? `${last[1]}: ${purpose[1].trim()}` : last[1];
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /model.*not available|Please use '\/model'/i, type: "model_error", action: "notify", message: "Model unavailable — use /model to switch" },
      { pattern: /Response timed out/i, type: "timeout", action: "notify", message: "Kiro response timed out (generation too long) — please try again", skipCooldown: true, skipRecoveryWait: true },
      // Session/login expiry. kiro had NO auth pattern, so an expired login was
      // silent: it kept accepting work and failing every turn. Strings taken from
      // the kiro-cli binary itself ("You are not logged in, please log in with",
      // AWS SSO "ExpiredTokenException", "no device registration found for token")
      // rather than guessed. Deliberately specific — bare "Unauthorized"/"Not
      // logged in" would false-positive on an agent merely discussing auth code.
      {
        // Ordering is load-bearing: the monitor takes the FIRST matching pattern,
        // and kiro prints `Kiro is having trouble responding right now:` as the
        // header for *every* failure kind — so the generic entry (now last) used
        // to swallow auth failures and label them "Rate limit". Worse than the
        // wrong label: classified as rate_limit it only notified, so the
        // auth auto-pause never fired and the instance kept feeding messages to a
        // CLI that could not answer (issue #440).
        //
        // `No token` / `dispatch failure` are what an expired-or-missing login
        // actually prints at runtime; the other three come from the kiro-cli
        // binary. The No-token alternative is anchored to kiro's numbered error
        // list (`   2: dispatch failure (other): No token`) rather than matched as
        // a bare keyword, because this fleet maintains AgEnD and an agent quoting
        // this very error must not pause itself.
        pattern: /You are not logged in|ExpiredTokenException|no device registration found for token|^\s*\d+:\s*(?:dispatch failure[^\n]*?)?No token\s*$/im,
        type: "auth_error",
        action: "pause",
        message: "Kiro login is missing or expired — run `kiro-cli login` to restore all kiro instances",
      },
      // #384: the AgEnD MCP server died, or something wrote non-JSON-RPC to its
      // stdout and kiro dropped the connection. kiro keeps running and keeps
      // answering, so nothing looks broken — but every fleet tool is gone, which
      // for an AgEnD instance means it can no longer reply, report, or delegate.
      // It cannot reconnect in-session; only a restart re-establishes the
      // transport, which is why this is the one kiro error with action "restart".
      //
      // Both alternatives are matched on their full structure rather than on a
      // keyword. An agent discussing this very failure — plausible in a fleet that
      // maintains AgEnD — must not restart itself, so "MCP" or "transport closed"
      // alone would be far too eager. The quoted server name and the complete
      // stdout sentence are things kiro prints, not things people paraphrase.
      //
      // No skipCooldown: if MCP is broken in a way a restart cannot fix, the
      // default 5-minute per-pattern cooldown is what keeps this from becoming a
      // restart loop.
      {
        pattern: /Transport to MCP server '[^']+' is closed|non-JSON-RPC output to stdout which caused the connection to close/,
        type: "crash",
        action: "restart",
        message: "MCP transport closed — fleet tools were unavailable, restarting to reconnect",
        // No formatMessage. The obvious thing to extract is the quoted server
        // name, but it is always `agend-<instance-name>` and the notification is
        // already addressed to that instance — it would restate the one thing the
        // reader already knows. It would also only work half the time:
        // resolveErrorMessage formats the LAST match in the pane, and kiro prints
        // the stdout sentence after the transport line, so the name is usually not
        // in the match that gets formatted.
      },
      // Real throttling, matched on the exceptions kiro actually raises (all four
      // are present in the binary) rather than on the shared header.
      {
        pattern: /ThrottlingException|TooManyRequestsException|RequestThrottledException|SlowDownException/,
        type: "rate_limit",
        action: "notify",
        message: "Kiro is being throttled by the service — retry shortly",
      },
      // LAST on purpose: this header wraps every failure kind, so it must only
      // catch what nothing above explained. Message no longer claims a rate limit
      // — that assertion is what sent operators looking at quota for an auth bug.
      // (Dedup is keyed by `type:pattern.source`, so this keeps its own baseline
      // independent of the throttling entry above.)
      {
        pattern: /having trouble responding/i,
        type: "rate_limit",
        action: "notify",
        message: "Kiro reported a failure — see the instance pane for the cause",
      },
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

  // `kiro-cli chat --effort <EFFORT>` (low|medium|high|xhigh|max) — it is on the
  // `chat` SUBCOMMAND, which is why a top-level `--help` search misses it. No
  // `/effort` in the TUI command table, so changing it needs a respawn.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return "restart"; }
  getEffortLevels(): string[] { return ["low", "medium", "high", "xhigh", "max"]; }

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
