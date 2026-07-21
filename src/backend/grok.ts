import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type RuntimeDialog, type StartupDialog, isModelCompatible, resolveBinary, validateModel } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

/** Session ids are UUIDs (e.g. "019f82d4-…"); guard before shell interpolation. */
const SESSION_ID_RE = /^[A-Za-z0-9-]+$/;

/**
 * Grok Build (xAI) — https://docs.x.ai/build/cli
 *
 * IMPORTANT — why the interactive TUI, not `grok agent stdio`:
 * Grok Build exposes three surfaces: the interactive TUI (`grok`), headless
 * (`grok -p "<prompt>"`), and an ACP agent (`grok agent stdio`) that speaks
 * JSON-RPC over stdin/stdout. AgEnD drives a backend through a tmux PTY — it
 * scans human-readable pane text for ready/error patterns and injects
 * keystrokes (cancel key, slash commands). An ACP JSON-RPC agent has no
 * human-readable prompt, ready banner, or slash commands, so the CliBackend
 * interface does not map onto it. The interactive TUI is the correct surface,
 * the same choice made for codex/opencode/kiro.
 *
 * Phase 2: ready pattern, cancel/quit keys, /compact, context format, and the
 * device-flow login dialog were confirmed against a live grok session. Error
 * strings beyond the cancellation notice are still best-effort and may need
 * tuning — the backend is registered as experimental (see factory.ts).
 */
export class GrokBackend implements CliBackend {
  readonly binaryName = "grok";
  private binaryPath: string;
  // Cached from buildCommand/writeConfig so getSessionId() (which takes no args)
  // can scope to grok's per-cwd session directory.
  private workingDirectory?: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("grok");
  }

  buildCommand(config: CliBackendConfig): string {
    this.workingDirectory = config.workingDirectory;
    // Flags: -m/--model, --always-approve, -r/--resume <ID>, -p/--single, --no-auto-update.
    // --no-auto-update: an auto-update prompt on launch would corrupt ready detection.
    let cmd = `${this.binaryPath} --no-auto-update`;
    // --always-approve auto-approves tool executions (documented flag). If a grok
    // build ignores it, getRuntimeDialogs() auto-approves the prompt as a net.
    if (config.skipPermissions !== false) cmd += " --always-approve";
    // Resume by explicit session id (verified: grok prints
    // "Resume this session with: grok --resume <uuid>" on exit — there is no
    // bare --continue that reliably resumes). The id is persisted by the daemon
    // from getSessionId(); skip on crash recovery (skipResume) for a clean start.
    if (!config.skipResume) {
      const sid = this.storedSessionId();
      if (sid) cmd += ` --resume ${sid}`;
    }
    if (config.model) {
      if (isModelCompatible("grok", config.model)) {
        cmd += ` --model ${validateModel(config.model)}`;
      } else {
        console.warn(`[agend] model "${config.model}" is not compatible with grok — skipping --model, using the CLI's default`);
      }
    }
    return cmd;
  }

  /** The daemon's persisted session id (written from getSessionId()), for --resume. */
  private storedSessionId(): string | null {
    try {
      const sid = readFileSync(join(this.instanceDir, "session-id"), "utf-8").trim();
      return SESSION_ID_RE.test(sid) ? sid : null;
    } catch { return null; }
  }

  writeConfig(config: CliBackendConfig): void {
    this.workingDirectory = config.workingDirectory;
    // Grok Build merges MCP servers from a project-level .mcp.json (loaded below
    // ~/.grok/config.toml in priority). Using the project file means we never
    // clobber the user's global config. Standard mcpServers format: { command, args, env }.
    const mcpPath = join(config.workingDirectory, ".mcp.json");
    let root: Record<string, unknown> = {};
    try { root = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch { /* new file */ }

    const servers = (root.mcpServers ?? {}) as Record<string, unknown>;
    // Drop stale agend entries whose wrapper script no longer exists.
    for (const [key, val] of Object.entries(servers)) {
      if (key.startsWith("agend-")) {
        const cmd = (val as Record<string, unknown>)?.command;
        if (typeof cmd === "string" && !existsSync(cmd)) delete servers[key];
      }
    }
    // Namespace each server by instance so multiple instances can share a working dir.
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = `${name}-${config.instanceName}`;
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };

      // WORKAROUND (same as kiro-cli): grok does not reliably pass the mcp.json
      // "env" block to the MCP server subprocess — the process would inherit grok's
      // env, which has NO AGEND_SOCKET_PATH (the daemon keeps it out of process.env),
      // so the server can't connect and every MCP tool (reply/react/…) fails. Emit a
      // wrapper that exports the env explicitly, waits for the IPC socket, then execs
      // the real server. This is env-delivery-independent and works either way.
      const wrapperPath = join(this.instanceDir, `mcp-wrapper-${name}.sh`);
      const envExports = Object.entries(allEnv)
        .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
        .join("\n");
      // 0o700: wrapper inlines sensitive env (tokens, socket paths) — owner-only.
      writeFileSync(
        wrapperPath,
        `#!/bin/bash\n${envExports}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${entry.command} ${entry.args.map((a: string) => JSON.stringify(a)).join(" ")}\n`,
        { mode: 0o700 },
      );
      chmodSync(wrapperPath, 0o700);

      servers[instanceKey] = { command: wrapperPath, args: [] };
    }
    // Clean up any legacy non-namespaced key.
    delete servers["agend"];
    root.mcpServers = servers;
    writeFileSync(mcpPath, JSON.stringify(root, null, 2));

    // Fleet instructions → AGENTS.md marker block (Grok reads AGENTS.md project docs,
    // same convention as Codex). Additive + idempotent via the AGEND marker.
    if (config.instructions) {
      try {
        appendWithMarker(join(config.workingDirectory, "AGENTS.md"), config.instanceName, config.instructions);
      } catch { /* best effort */ }
    }
  }

  getReadyPattern(): RegExp {
    // Verified: `❯` is the idle input prompt inside the TUI box; the Grok Build
    // header ("Grok Build" / "Grok <n>") also identifies the ready screen.
    return /❯|Grok \d|Grok Build/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    // NOTE: "Turn cancelled by user" is NORMAL behaviour (user interrupt), not an
    // error — none of the patterns below match it, and none should be added that do.
    // Error strings below are best-effort generic API shapes; tune once observed live.
    return [
      { pattern: /rate.?limit|too many requests|\b429\b/i, type: "rate_limit", action: "failover", message: "Grok rate limit reached" },
      { pattern: /unauthorized|authentication (failed|error)|\b401\b/i, type: "auth_error", action: "pause", message: "Grok authentication error" },
      { pattern: /quota|insufficient credits|out of credits/i, type: "quota", action: "notify", message: "Grok quota/credits exhausted" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      // Workspace trust confirmation ("Do you trust the contents of this directory?")
      // appears BEFORE the login screen — auto-approve with the 'y' hotkey.
      { pattern: /Do you trust the contents|trust.*directory/i, keys: ["y"], description: "Grok workspace trust — auto-approve" },
      // Device-flow login is BLOCKING and cannot be auto-dismissed — the user must
      // approve externally. Empty keys => the daemon sends nothing but treats the
      // screen as "not ready yet" and keeps polling, so the login screen is never
      // mistaken for the idle prompt. (The "[Click here to Upgrade]" banner is
      // non-blocking and is intentionally NOT listed — nothing to dismiss.)
      { pattern: /Waiting for approval|Log in to continue|device.*approval/i, keys: [], description: "Grok device-flow login — wait for user authorization (no auto-dismiss)" },
    ];
  }

  getContextUsage(): number | null {
    // Grok shows context as "12K / 500K" (used / total) in the TUI, not in a file.
    // getContextUsage() has no pane access, so parsing lives in the pane scanners
    // (parseContextPercent in topic-commands.ts + defaultParser in cli.ts), which
    // is what /ctx and `agend ls` use. Nothing file-based to report here.
    return null;
  }

  getSessionId(): string | null {
    // grok stores sessions per working directory (verified):
    //   ~/.grok/sessions/<encodeURIComponent(cwd)>/<session-uuid>/{events.jsonl,…}
    // Scoping by cwd means multiple concurrent grok instances (distinct cwds)
    // never pick up each other's session. Return the UUID of the most-recently
    // ACTIVE session in this instance's cwd for the daemon to persist (--resume).
    if (!this.workingDirectory) return null;
    try {
      const base = join(homedir(), ".grok", "sessions", encodeURIComponent(this.workingDirectory));
      let newestId: string | null = null;
      let newestMtime = -1;
      for (const name of readdirSync(base)) {
        // Session dirs are named by UUID; skip prompt_history.jsonl etc.
        if (!SESSION_ID_RE.test(name) || name.length < 8) continue;
        const sessionDir = join(base, name);
        let st;
        try { st = statSync(sessionDir); } catch { continue; }
        if (!st.isDirectory()) continue;
        // Activity = latest INNER-file mtime. The dir's own mtime doesn't move on
        // append AND is misleadingly recent for a just-created dir, so it must NOT
        // outweigh a resumed older session whose logs were just appended. Only fall
        // back to dir mtime when the session has no inner files yet.
        let activity = -1;
        try {
          for (const f of readdirSync(sessionDir)) {
            try { const m = statSync(join(sessionDir, f)).mtimeMs; if (m > activity) activity = m; } catch { /* skip */ }
          }
        } catch { /* unreadable dir */ }
        if (activity < 0) activity = st.mtimeMs;
        if (activity > newestMtime) { newestMtime = activity; newestId = name; }
      }
      return newestId;
    } catch { return null; }
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      // Mid-task tool-approval prompt ("1. Yes, always  2. Yes  3. No"). Select
      // option 1 so the fleet runs unattended. Primary mechanism is
      // --always-approve at launch; this is the net if that flag is absent/ignored.
      // ⚠️ key needs live confirmation — assumes a numeric hotkey (types "1"+Enter);
      // if grok uses an arrow-select cursor instead, switch to ["Enter"] or nav keys.
      { pattern: /1\.\s*Yes,?\s*always|Yes,?\s*always[\s\S]{0,40}\bNo\b/i, keys: ["1"], description: "Grok tool-approval prompt — select 'Yes, always'" },
    ];
  }

  // grok has no slash quit command — it quits via the Ctrl+Q key chord (getQuitKey).
  getQuitCommand(): string | null { return null; }
  getQuitKey(): string { return "C-q"; }

  getCompactCommand(): string { return "/compact"; }   // verified present

  // Verified: grok interrupts generation on Ctrl+C.
  getCancelKey(): string { return "C-c"; }

  cleanup(config: CliBackendConfig): void {
    // Remove only this instance's namespaced MCP entries — a non-namespaced key
    // may belong to another instance sharing the working directory.
    try {
      const mcpPath = join(config.workingDirectory, ".mcp.json");
      if (existsSync(mcpPath)) {
        const root = JSON.parse(readFileSync(mcpPath, "utf-8"));
        if (root.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete root.mcpServers[`${name}-${config.instanceName}`];
          }
          writeFileSync(mcpPath, JSON.stringify(root, null, 2));
        }
      }
    } catch { /* best effort */ }

    // Remove fleet instructions marker block from AGENTS.md.
    try {
      removeMarker(join(config.workingDirectory, "AGENTS.md"), config.instanceName);
    } catch { /* best effort */ }
  }
}
