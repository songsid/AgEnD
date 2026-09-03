import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, type RuntimeDialog, resolveBinary, shellQuote, validateEffort, validateModel, warnIfModelMismatch } from "./types.js";
import { PIE_CLASS } from "../tui-glyphs.js";

// Kiro CLI feature gates. These are deliberately separate: the flags shipped
// in different releases, so one broad "old Kiro" check would still crash some
// supported versions with an unknown argument.
// - 1.25.0: https://kiro.dev/changelog/cli/1-25/ (MCP startup checks)
// - 1.27.0: verified against Kiro's archived 1.26.0/1.27.0 binaries. Before
//   this, classic was the only UI and neither --legacy-ui nor --classic existed.
// - 2.6.0: https://kiro.dev/changelog/cli/2-6/ (initial effort flag)
export const KIRO_REQUIRE_MCP_MIN = "1.25.0";
export const KIRO_LEGACY_UI_MIN = "1.27.0";
export const KIRO_EFFORT_FLAG_MIN = "2.6.0";

export interface KiroCliCompatibility {
  version?: string;
  supportsRequireMcpStartup: boolean;
  supportsLegacyUi: boolean;
  supportsEffortFlag: boolean;
  source: "version" | "help" | "unknown";
}

type KiroProbeRunner = (binaryPath: string, args: string[]) => string;

const UNKNOWN_KIRO_COMPATIBILITY: KiroCliCompatibility = {
  supportsRequireMcpStartup: false,
  supportsLegacyUi: false,
  supportsEffortFlag: false,
  source: "unknown",
};

interface CachedKiroCompatibility {
  cacheKey: string;
  compatibility: KiroCliCompatibility;
}

const compatibilityCache = new Map<string, CachedKiroCompatibility>();
const warnedUnsupportedEffortCacheKeys = new Set<string>();

function parseSemver(value: string | undefined): [number, number, number] | undefined {
  const match = value?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: [number, number, number], minimum: string): boolean {
  const required = parseSemver(minimum)!;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== required[i]) return version[i] > required[i];
  }
  return true;
}

function helpAdvertisesFlag(help: string, flag: string): boolean {
  return new RegExp(`^\\s*${flag}(?:[ =<]|$)`, "m").test(help);
}

/** Probe once per backend construction, falling back from semver to --help. */
export function probeKiroCliCompatibility(
  binaryPath: string,
  run: KiroProbeRunner = (binary, args) => execFileSync(binary, args, {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }),
): KiroCliCompatibility {
  let version: string | undefined;
  try {
    version = run(binaryPath, ["--version"]).trim().split("\n")[0].slice(0, 80) || undefined;
  } catch { /* fall through to capability help */ }

  const parsed = parseSemver(version);
  if (parsed) {
    return {
      version,
      supportsRequireMcpStartup: versionAtLeast(parsed, KIRO_REQUIRE_MCP_MIN),
      supportsLegacyUi: versionAtLeast(parsed, KIRO_LEGACY_UI_MIN),
      supportsEffortFlag: versionAtLeast(parsed, KIRO_EFFORT_FLAG_MIN),
      source: "version",
    };
  }

  try {
    const help = run(binaryPath, ["chat", "--help"]);
    return {
      version,
      supportsRequireMcpStartup: helpAdvertisesFlag(help, "--require-mcp-startup"),
      supportsLegacyUi: helpAdvertisesFlag(help, "--legacy-ui"),
      supportsEffortFlag: helpAdvertisesFlag(help, "--effort"),
      source: "help",
    };
  } catch {
    return { ...UNKNOWN_KIRO_COMPATIBILITY, version };
  }
}

function kiroBinaryCacheKey(binaryPath: string): string {
  try {
    const stat = statSync(binaryPath);
    // Kiro may upgrade its binary in place. Metadata makes a new binary
    // generation probe again without putting synchronous CLI calls on every
    // createBackend() hot path.
    return `${binaryPath}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    // If the binary is installed later, its new stat-derived key invalidates
    // this conservative "unavailable" result automatically.
    return `${binaryPath}\0unavailable`;
  }
}

function cachedKiroCliCompatibility(binaryPath: string, run?: KiroProbeRunner): CachedKiroCompatibility {
  const cacheKey = kiroBinaryCacheKey(binaryPath);
  const cached = compatibilityCache.get(cacheKey);
  if (cached) return cached;
  const entry = { cacheKey, compatibility: probeKiroCliCompatibility(binaryPath, run) };
  compatibilityCache.set(cacheKey, entry);
  return entry;
}

/** Process-level memo used by backend construction; exported for regression tests. */
export function getCachedKiroCliCompatibility(
  binaryPath: string,
  run?: KiroProbeRunner,
): KiroCliCompatibility {
  return cachedKiroCliCompatibility(binaryPath, run).compatibility;
}

/** Test-only reset for the process-level compatibility and warning memo. */
export function resetKiroCompatibilityCacheForTests(): void {
  compatibilityCache.clear();
  warnedUnsupportedEffortCacheKeys.clear();
}

/** Startup budget for a `--resume` launch (60% first output, 40% ready). */
export const KIRO_RESUME_STARTUP_BUDGET_MS = 60_000;

export class KiroBackend implements CliBackend {
  readonly binaryName = "kiro-cli";
  private binaryPath: string;
  private readonly compatibility: KiroCliCompatibility;
  private readonly compatibilityCacheKey?: string;
  private warnedUnsupportedEffort = false;
  /**
   * UI flavour and trust mode of the LAST command built. The Enter-drop
   * delivery gate (dropsEnterWhileBusy / getBottomReadyPattern) is specific to
   * the legacy UI's prompt row, so both are derived from what was actually
   * launched rather than assumed. Defaults match kiro's config defaults
   * (`kiro_ui: legacy`, `--trust-all-tools`) for a backend that has not built a
   * command yet.
   */
  private activeUi: "legacy" | "tui" | "v3" = "legacy";
  private activeTrustAll = true;

  constructor(private instanceDir: string, compatibility?: KiroCliCompatibility) {
    this.binaryPath = resolveBinary("kiro-cli");
    if (compatibility) {
      this.compatibility = compatibility;
    } else {
      const cached = cachedKiroCliCompatibility(this.binaryPath);
      this.compatibility = cached.compatibility;
      this.compatibilityCacheKey = cached.cacheKey;
    }
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

  dropsEnterWhileBusy(): boolean {
    // Verified live (kiro-cli 2.21.0, --legacy-ui): text pasted while a shell
    // tool ran surfaced in the prompt row after the turn, UNSUBMITTED, and the
    // next message's Enter submitted both as one. Enter during a turn is
    // discarded, not queued — so the daemon must not treat a quiet pane as an
    // open prompt (tool execution and backend retries are silent for seconds).
    //
    // Legacy UI with --trust-all-tools only: the gate needs a prompt row it can
    // recognise row-locally, and the daemon fails CLOSED without one. The
    // v3/new TUI paints a different screen; without trust-all the legacy row
    // would be a bare `N% >`, indistinguishable from tool output such as
    // `100% > done` — and never verified live. Both keep the silence gate until
    // their ready marker is verified.
    return this.activeUi === "legacy" && this.activeTrustAll;
  }

  /**
   * Live evidence (kiro-cli 2.21.0, 2026-09-03): `--resume` prints nothing
   * until the conversation comes back from the backend ("Picking up where we
   * left off…") — >15s blank while runtime.us-east-1.kiro.dev timed out and
   * kiro retried every 10s — and the default 25s budget (15s to first output)
   * declared it dead, cleared the session, and started fresh. A fresh prompt
   * is local (~5s even with MCP), so it keeps the default budget.
   */
  getStartupBudgetMs(ctx: { resume: boolean }): number | undefined {
    return ctx.resume ? KIRO_RESUME_STARTUP_BUDGET_MS : undefined;
  }

  retriesResumeOnStartupFailure(): boolean {
    // A resume miss is far more often "the backend was slow" than "the session
    // is broken"; one more attempt before abandoning the conversation is cheap.
    return true;
  }

  getBottomReadyPattern(): RegExp | null {
    if (!this.dropsEnterWhileBusy()) return null;
    // Legacy-UI prompt row, live captures: "51% !>", "1% !> How can I help?",
    // "2% !> Not sure where to start? …" (placeholder hint shares the row), and
    // the mode-glyph form "20% λ !>". While a tool runs the bottom row is the
    // tool banner ("Purpose: …"); while generating it is "⠇ Thinking…" — neither
    // matches, which is exactly the point.
    //
    // Anchored to the ROW START: the context percentage is the first thing on
    // the prompt row, then an optional mode glyph, then the marker. Unanchored
    // (`\d+%[^\n]*[!❯>]`) matched ordinary tool output such as
    // `Progress 50% > /tmp/output` or `download 100% -> done` and declared a busy
    // pane ready. Under --trust-all-tools (the only mode the gate runs in) the
    // ASCII marker is `!>` and its `!` is REQUIRED, so a bare `100% > done` at a
    // row start is not a prompt either; the glyph form `8% ❯` (see
    // getReadyPattern) needs no `!` because `❯` never occurs in tool output.
    return /^\s*\d+%\s*(?:[^\s\d%!❯>]{1,2}\s+)?(?:!\s?[❯>]|❯)/;
  }

  buildCommand(config: CliBackendConfig): string {
    const ui = config.kiroUi ?? "legacy";
    let cmd = `${this.binaryPath} chat`;
    if (ui === "legacy" && this.compatibility.supportsLegacyUi) cmd += " --legacy-ui";
    else if (ui === "v3") cmd += " --v3";
    // Record what is actually being launched for the delivery gate (see
    // dropsEnterWhileBusy): a "legacy" request on a binary without --legacy-ui
    // runs the default new TUI, not the legacy screen.
    this.activeUi = ui === "legacy" && this.compatibility.supportsLegacyUi ? "legacy" : ui === "v3" ? "v3" : "tui";
    this.activeTrustAll = config.skipPermissions !== false;
    if (config.skipPermissions !== false) cmd += " --trust-all-tools";
    // --resume is boolean: Kiro auto-resumes latest conversation for this working directory
    if (!config.skipResume) cmd += " --resume";
    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("kiro-cli", model);
      cmd += ` --model ${shellQuote(model)}`;
    }
    if (config.effort) {
      const effort = validateEffort(config.effort);
      if (this.compatibility.supportsEffortFlag) {
        cmd += ` --effort ${effort}`;
      } else if (this.shouldWarnUnsupportedEffort()) {
        const detected = this.compatibility.version
          ? `detected ${this.compatibility.version}`
          : "unknown version";
        console.warn(`[agend] kiro-cli ${detected} does not support the --effort launch flag (requires >= ${KIRO_EFFORT_FLAG_MIN}); configured effort "${effort}" was not applied`);
      }
    }
    if (this.compatibility.supportsRequireMcpStartup) cmd += " --require-mcp-startup";
    return cmd;
  }

  private shouldWarnUnsupportedEffort(): boolean {
    if (!this.compatibilityCacheKey) {
      if (this.warnedUnsupportedEffort) return false;
      this.warnedUnsupportedEffort = true;
      return true;
    }
    if (warnedUnsupportedEffortCacheKeys.has(this.compatibilityCacheKey)) return false;
    warnedUnsupportedEffortCacheKeys.add(this.compatibilityCacheKey);
    return true;
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

  getBusyPattern(): RegExp {
    // Live legacy-UI capture (2026-08-13): Kiro leaves its ordinary ready
    // statusline ("64% λ !>") on screen while the model is generating, and
    // paints a separate braille-spinner line such as "⠹ Thinking...".  The
    // ready marker therefore cannot distinguish idle from thinking by itself.
    //
    // Kiro does not always erase the spinner row after a turn. A multiline
    // search across the whole pane therefore treated a historical spinner as
    // live forever, even when a newer `72% λ !>` prompt was visible below it.
    // The live spinner is the last non-blank row in every captured working
    // frame; require that position so completed-turn history cannot veto ready.
    // Use horizontal whitespace explicitly — `\s` would cross row boundaries.
    return /(?:^|\n)[ \t]*[\u2800-\u28ff][ \t]+(?:Thinking|Working)(?:\.{3}|…)[ \t]*(?:\n[ \t]*)*$/i;
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
        pattern: /You are not logged in|ExpiredTokenException|no device registration found for token|Access denied:.*bearer token.*invalid|^\s*\d+:\s*(?:dispatch failure[^\n]*?)?No token\s*$/im,
        type: "auth_error",
        action: "pause",
        message: "Kiro login is missing or expired — run `kiro-cli login` to restore all kiro instances",
      },
      // Backend unreachable. Live 2026-09-03: runtime.us-east-1.kiro.dev stopped
      // answering for hours; every kiro instance printed
      //   `1: dispatch failure (timeout): request timed out: error sending
      //    request for url (https://runtime.us-east-1.kiro.dev/)`
      // and retried every 10s. Distinct from the auth line above
      // (`dispatch failure (other): No token`, matched first). fleetWide: this is
      // one outage, not N incidents — the lifecycle notifies once and the daemon
      // stops burning `--resume` attempts (and sessions) while it lasts.
      // skipRecoveryWait: kiro is back at its prompt between retries.
      {
        pattern: /dispatch failure \(timeout\)|request timed out: error sending request for url \((https?:\/\/[^)\s]*kiro\.dev[^)\s]*)\)/i,
        type: "network",
        action: "notify",
        message: "Kiro backend unreachable — requests to the kiro.dev runtime are timing out",
        formatMessage: match => {
          const host = match[1]?.match(/^https?:\/\/([^/]+)/)?.[1];
          return host
            ? `Kiro backend unreachable — requests to ${host} are timing out`
            : "Kiro backend unreachable — requests to the kiro.dev runtime are timing out";
        },
        skipRecoveryWait: true,
        fleetWide: true,
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
  getClearCommand(): string { return "/clear"; }
  getClearConfirmationDialog(): RuntimeDialog {
    return {
      pattern: /Are you sure\?[\s\S]{0,240}?This will erase the conversation history[\s\S]{0,240}?\[y\/n\]:/i,
      keys: ["y", "Enter"],
      description: "Kiro conversation clear confirmation — auto-confirm",
    };
  }

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
    const { models, defaultModel } = this.readModelsPayload();
    return { version: this.compatibility.version, models, currentModel: defaultModel };
  }

  // kiro-cli interrupts generation on Ctrl+C (others use Escape).
  getCancelKey(): string { return "C-c"; }

  // `kiro-cli chat --effort <EFFORT>` (low|medium|high|xhigh|max) — it is on the
  // `chat` SUBCOMMAND, which is why a top-level `--help` search misses it. No
  // `/effort` in the TUI command table, so changing it needs a respawn. Keep
  // this capability surface stable when the binary is absent or old; buildCommand
  // is the compatibility boundary that omits an unsupported flag and warns.
  getEffortStrategy(): "runtime" | "restart" { return "restart"; }
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
