import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, lstatSync, readlinkSync, symlinkSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type ModelOption, type RuntimeDialog, type StartupDialog, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

/** Session ids are UUIDs (e.g. "01a0c784-fb91-…"); guard before shell interpolation. */
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,}$/;

/**
 * Enough of a session log to reach the `route_facts` record that names the
 * working directory. Measured on a live session: `"cwd"` landed at byte 3899 of
 * a 450KB log, at sequence 4. 64KiB is ~16x that headroom and keeps the scan
 * cheap even with dozens of sessions on disk.
 */
const SESSION_HEAD_BYTES = 65_536;

/** Read the workspace a session was started in, without reading the whole log. */
export function museSessionCwd(head: string): string | null {
  return head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1") ?? null;
}

/**
 * Meta Muse Code — the `muse` CLI (v1.3.0 verified).
 *
 * Everything below was confirmed against live sessions on 2026-09-22 rather
 * than read out of `--help`, because the two disagree in the places that
 * matter. Three findings shaped this file:
 *
 *   1. The input prompt `❯` stays on screen the entire time muse works, so the
 *      ready pattern alone can never say "idle" — hence getBusyPattern().
 *   2. Ctrl+C is QUIT (twice), not cancel. The TUI's own hint is "esc to
 *      interrupt", and Escape is what stops a run. Wiring C-c to cancel would
 *      have left every instance one stray keypress from death.
 *   3. `--disable-approval` alone still stops at a workspace-trust dialog. It
 *      needs `--trust-workspace` beside it to reach the prompt unattended.
 */
export class MuseBackend implements CliBackend {
  readonly binaryName = "muse";
  private binaryPath: string;
  private readonly sharedXdgConfigHome: string;
  // Cached from buildCommand/writeConfig so getSessionId() (which takes no
  // args) can match sessions against this instance's workspace.
  private workingDirectory?: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("muse");
    this.sharedXdgConfigHome = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"));
  }

  buildCommand(config: CliBackendConfig): string {
    this.workingDirectory = config.workingDirectory;

    // `muse` on PATH is a launcher script that checks for a new release, may
    // replace the binary underneath us, and records an update notice that the
    // next start prints. A fleet agent can run for days; an update arriving
    // mid-run would repaint the pane and swap the CLI. One year in seconds
    // keeps the check quiet while staying inside the launcher's own numeric
    // guard (a non-numeric value also disables it, but undocumented).
    // Muse has one user-level settings.json and loads every MCP server in it.
    // Point only this Muse process at its instance-scoped copy; otherwise two
    // fleet instances both see both socket-bearing MCP tools.
    let cmd = `XDG_CONFIG_HOME=${shellQuote(this.isolatedXdgConfigHome())} MUSE_UPDATE_INTERVAL_SECONDS=31536000 ${this.binaryPath}`;

    // The daemon may prepare a localhost-only usage relay before spawning Muse.
    // If relay preparation fails this remains unset and Muse connects directly;
    // usage must never become a prerequisite for a working conversation.
    if (config.museBaseUrl) cmd += ` --base-url ${shellQuote(config.museBaseUrl)}`;

    // Verified: `--disable-approval` on its own leaves the session parked on
    // "Do you trust this workspace?" forever. Trust is a separate axis, so both
    // flags are needed to reach the prompt unattended.
    //
    // NOT `--yolo`: that disables approval, trust AND the OS sandbox. The
    // sandbox was measured to permit what an agent actually needs — writes in
    // the workspace and to the temp dir, and outbound network through the proxy
    // (curl to example.com returned 200) — so there is nothing to buy by
    // switching it off, and a sandboxed shell is worth keeping.
    if (config.skipPermissions !== false) cmd += " --disable-approval --trust-workspace";

    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("muse", model);
      cmd += ` --model ${shellQuote(model)}`;
    }
    // muse accepts none|minimal|low|medium|high|xhigh|max|ultra; AgEnD's levels
    // are a subset, so whatever the fleet holds is passed through unchanged.
    if (config.effort) cmd += ` --reasoning-effort ${shellQuote(config.effort)}`;

    // Resume is a SUBCOMMAND, and root options may sit on either side of it
    // (stated in `muse resume --help`, and verified: root flags + `resume <id>`
    // launched into the prior conversation with the model flag applied).
    // `resume --last` is workspace-scoped and would silently adopt a session the
    // user started by hand in the same directory, so we resume the id we
    // persisted and nothing else.
    if (!config.skipResume) {
      const sid = this.storedSessionId();
      if (sid) cmd += ` resume ${sid}`;
    }
    return cmd;
  }

  /** The daemon's persisted session id (written from getSessionId()), for resume. */
  private storedSessionId(): string | null {
    try {
      const sid = readFileSync(join(this.instanceDir, "session-id"), "utf-8").trim();
      return SESSION_ID_RE.test(sid) ? sid : null;
    } catch { return null; }
  }

  /**
   * Per-instance MCP key. Keep tool names stable across the shared-settings
   * migration; a non-ASCII instance name becomes an ASCII slug plus a hash.
   */
  private mcpKey(mcpName: string, instanceName: string): string {
    const ascii = instanceName.replace(/[^\x20-\x7E]/g, "");
    if (ascii === instanceName) return `agend-${mcpName}-${instanceName}`;
    const slug = ascii.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const hash = createHash("md5").update(instanceName).digest("hex").slice(0, 8);
    return slug ? `agend-${mcpName}-${slug}-${hash}` : `agend-${mcpName}-${hash}`;
  }

  private isolatedXdgConfigHome(): string {
    return join(this.instanceDir, "muse-xdg");
  }

  /** Muse's per-process settings location after buildCommand sets XDG_CONFIG_HOME. */
  private settingsPath(): string {
    return join(this.isolatedXdgConfigHome(), "muse", "settings.json");
  }

  private sharedSettingsPath(): string {
    return join(this.sharedXdgConfigHome, "muse", "settings.json");
  }

  /** Preserve the user's login while keeping Muse's MCP settings per instance. */
  private linkSharedAuth(): void {
    const sharedMuseDir = join(this.sharedXdgConfigHome, "muse");
    const isolatedXdgHome = this.isolatedXdgConfigHome();
    const isolatedMuseDir = join(isolatedXdgHome, "muse");
    mkdirSync(sharedMuseDir, { recursive: true, mode: 0o700 });
    mkdirSync(isolatedXdgHome, { recursive: true, mode: 0o700 });
    mkdirSync(isolatedMuseDir, { recursive: true, mode: 0o700 });
    chmodSync(isolatedXdgHome, 0o700);
    chmodSync(isolatedMuseDir, 0o700);
    // Muse uses a lock beside auth.json. Both symlinks must point at the same
    // shared files so login/refresh from two instances remains serialized.
    for (const name of ["auth.json", ".auth.json.lock"]) {
      const target = join(sharedMuseDir, name);
      const link = join(isolatedMuseDir, name);
      try {
        const st = lstatSync(link);
        if (st.isSymbolicLink() && readlinkSync(link) === target) continue;
        throw new Error(`Muse auth path is already occupied: ${link}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      symlinkSync(target, link);
    }
  }

  writeConfig(config: CliBackendConfig): void {
    this.workingDirectory = config.workingDirectory;

    // Muse reads every MCP entry in its single XDG settings.json; namespacing
    // keys inside a shared file still exposes all sibling instances' tools to
    // every Muse process. Copy the user's ordinary settings into this instance's
    // XDG home, excluding all AgEnD MCP entries, then add only this socket.
    this.linkSharedAuth();
    const settingsPath = this.settingsPath();
    let root: Record<string, unknown> = {};
    try { root = JSON.parse(readFileSync(this.sharedSettingsPath(), "utf-8")); } catch { /* new file */ }
    if (typeof root.schema_version !== "number") root.schema_version = 1;

    const servers = { ...((root.mcpServers ?? {}) as Record<string, unknown>) };
    for (const key of Object.keys(servers)) {
      if (key === "agend" || key.startsWith("agend-")) delete servers[key];
    }

    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };

      // Same wrapper as grok/kiro. Two jobs: export the env explicitly rather
      // than trusting the CLI to forward the entry's `env` block, and wait for
      // the IPC socket to exist — a server that starts first would fail to
      // connect and every fleet tool (reply/react/…) would be dead for the run.
      const wrapperPath = join(this.instanceDir, `mcp-wrapper-${name}.sh`);
      const envExports = Object.entries(allEnv)
        .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
        .join("\n");
      // 0o700: the wrapper inlines sensitive env (tokens, socket paths).
      writeFileSync(
        wrapperPath,
        `#!/bin/bash\n${envExports}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${entry.command} ${entry.args.map((a: string) => JSON.stringify(a)).join(" ")}\n`,
        { mode: 0o700 },
      );
      chmodSync(wrapperPath, 0o700);

      // Entry shape per muse's own documentation: type/command/args/env/mode.
      // "optional" so a server that fails to start degrades the session instead
      // of stopping it.
      servers[this.mcpKey(name, config.instanceName)] = {
        type: "stdio",
        command: wrapperPath,
        args: [],
        mode: "optional",
      };
    }
    root.mcpServers = servers;
    const temporaryPath = `${settingsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(root, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temporaryPath, settingsPath);
      chmodSync(settingsPath, 0o600);
    } finally {
      try { unlinkSync(temporaryPath); } catch { /* renamed or write failed */ }
    }

    // `muse init` scaffolds AGENTS.md and the binary reads it as project rules,
    // the same convention as codex and grok. Additive + idempotent via marker.
    if (config.instructions) {
      try {
        appendWithMarker(join(config.workingDirectory, "AGENTS.md"), config.instanceName, config.instructions);
      } catch { /* best effort */ }
    }
  }

  requiresDeliveryEnterRetry(): boolean {
    // Measured, not inferred. An Enter that arrives in the same keystroke burst
    // as the text is taken as a NEWLINE: `tmux send-keys "probe N" Enter`
    // failed to submit three times out of three, and the drafts stacked up in
    // the input box —
    //
    //   ❯ probe 1
    //     probe 2
    //     probe 3
    //
    // The damage is not a lost message but a merged one: the next Enter submits
    // the whole draft as a single turn. The daemon's waitForPasteSettle already
    // opens the gap muse needs (a paste followed by Enter a second later
    // submitted every time, including mid-turn), so this is insurance against
    // the case where the settle wait is blind and falls back to a fixed delay.
    //
    // Safe on every delivery, both preconditions verified live: a bare Enter is
    // a no-op at an empty idle prompt, and a no-op mid-turn with empty input.
    return true;
  }

  getReadyPattern(): RegExp {
    // The ready screen carries the `Muse Code <version>` header and an empty
    // `❯` input row. Both survive scrollback, which is fine — this pattern only
    // has to say "the TUI is up"; getBusyPattern() is what says "not now".
    return /❯|Muse Code \d/m;
  }

  /**
   * The working line, which is on screen only while muse is generating.
   *
   * Required for the same reason grok and claude-code needed one: the input box
   * (and therefore `❯`) stays visible the whole time muse works, so the ready
   * pattern is effectively constant-true and the instance would never be seen
   * as busy — no hang detection, and a frozen CLI reported as idle.
   *
   * Sampled from a live run. The phase word changes (`Thinking`, `Working`,
   * `Double checking`) and the leading glyph cycles (◇ ◆ ◈), so neither is the
   * anchor. What every working frame has, and no idle frame does, is the
   * interrupt hint muse prints beside the elapsed timer:
   *
   *   ◇ Thinking (2s · esc to interrupt)
   *   ◆ Double checking (4s · esc to interrupt)
   *
   * Anchoring on the glyph would be wrong in a way that matters: completed
   * output lines start with `◆ ` too (`◆ Panes split the dark screen`), so a
   * glyph-anchored pattern would pin a finished instance in `working` forever.
   */
  getBusyPattern(): RegExp {
    return /\(\s*\d+(?:\.\d+)?s\s*·\s*esc to interrupt\s*\)/;
  }

  getErrorPatterns(): ErrorPattern[] {
    // NOTE: an Escape-interrupted run prints "interrupting run" in the status
    // bar. That is normal user-initiated behaviour, not an error — nothing here
    // matches it, and nothing that does should be added.
    return [
      { pattern: /rate.?limit|too many requests|\b429\b/i, type: "rate_limit", action: "failover", message: "Muse rate limit reached" },
      { pattern: /unauthorized|authentication (failed|error)|\b401\b|muse login/i, type: "auth_error", action: "pause", message: "Muse authentication error" },
      { pattern: /quota|usage limit|out of credits/i, type: "quota", action: "notify", message: "Muse quota exhausted" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      // Workspace trust. `--trust-workspace` normally prevents this from ever
      // appearing; it is still handled because an instance configured with
      // skip_permissions: false gets neither flag and would otherwise hang
      // here forever. Verified layout: a two-row menu, option 1 preselected,
      // "Use Up/Down or 1/2, then Enter."
      {
        pattern: /Do you trust this workspace\?/,
        keys: ["1", "Enter"],
        description: "Muse workspace trust — choose 'Trust and continue'",
      },
      // Login is BLOCKING and cannot be auto-dismissed — the user has to
      // complete it. Empty keys mean the daemon sends nothing but keeps
      // treating the screen as not-ready, so a login page is never mistaken
      // for the idle prompt.
      {
        pattern: /muse login|Log in to (Meta|continue)|device code/i,
        keys: [],
        description: "Muse login — wait for the user to authenticate (no auto-dismiss)",
      },
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      // Net for a tool-approval prompt arriving despite --disable-approval (an
      // enterprise policy can pin approval on). Muse's menus are numbered with
      // the first option preselected, same shape as the trust dialog.
      {
        pattern: /Allow this (tool|command)|Approve this (tool|command)|1\s+(Allow|Approve)/i,
        keys: ["1", "Enter"],
        description: "Muse tool approval — allow",
      },
    ];
  }

  getContextUsage(): number | null {
    // Muse reports context only inside `/status` ("98% left · 23.8K used /
    // 1008K"), not on the persistent status bar, so there is nothing a passive
    // reader can see between turns. Returning a stale or invented number would
    // be worse than none.
    return null;
  }

  // Muse usage is collected by the daemon-owned localhost relay in
  // muse-usage-relay.ts.  Keeping this backend free of direct Meta requests is
  // deliberate: the relay observes only response.subscription_usage frames and
  // the model conversation remains byte-for-byte transparent.

  getSessionId(): string | null {
    // Sessions live at ~/.local/share/muse/sessions/<YYYY>/<MM>/<DD>/<uuid>/,
    // filed by date rather than by workspace, so the workspace has to be read
    // out of each session's own log (`route_facts` names the cwd near the top).
    // Returns the most recently ACTIVE session started in this instance's
    // directory, which is what the daemon persists for resume.
    if (!this.workingDirectory) return null;
    try {
      const root = join(homedir(), ".local", "share", "muse", "sessions");
      let newestId: string | null = null;
      let newestMtime = -1;
      for (const sessionDir of museSessionDirs(root)) {
        const name = sessionDir.slice(sessionDir.lastIndexOf("/") + 1);
        if (!SESSION_ID_RE.test(name)) continue;
        let head: string;
        try {
          const fd = readFileSync(join(sessionDir, "session.jsonl"), { encoding: "utf-8", flag: "r" });
          head = fd.slice(0, SESSION_HEAD_BYTES);
        } catch { continue; }
        if (museSessionCwd(head) !== this.workingDirectory) continue;
        // Activity = latest inner-file mtime. The directory's own mtime does not
        // move when a log is appended, and is misleadingly recent for a session
        // that was only just created — it must not outrank a resumed older
        // session whose log was written to seconds ago.
        let activity = -1;
        try {
          for (const f of readdirSync(sessionDir)) {
            try { const m = statSync(join(sessionDir, f)).mtimeMs; if (m > activity) activity = m; } catch { /* skip */ }
          }
        } catch { /* unreadable */ }
        if (activity > newestMtime) { newestMtime = activity; newestId = name; }
      }
      return newestId;
    } catch { return null; }
  }

  // `/quit` is muse's own "quit when idle". The key chord is Ctrl+C pressed
  // TWICE ("Press Ctrl-C again to quit") — kept as the fallback, with the count
  // the TUI actually requires.
  getQuitCommand(): string | null { return "/quit"; }
  getQuitKey(): string { return "C-c"; }
  getQuitKeyPresses(): number { return 2; }

  getCompactCommand(): string { return "/compact"; }
  getClearCommand(): string | null { return "/clear"; }

  /**
   * Escape, not Ctrl+C. Verified both ways on a live session: Escape mid-run
   * put "interrupting run" in the status bar and returned the prompt with the
   * partial answer kept, while Ctrl+C armed the quit confirmation ("Press
   * Ctrl-C again to quit"). Cancelling with C-c would leave every instance one
   * stray keypress from exiting.
   */
  getCancelKey(): string { return "Escape"; }

  // `/effort` is in the TUI command list, so a level change needs no restart.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return "runtime"; }
  // muse also accepts none|minimal|ultra, which AgEnD has no level for; the
  // canonical five map straight through.
  getEffortLevels(): string[] { return ["low", "medium", "high", "xhigh", "max"]; }

  // `/model` opens an arrow-key picker, not a one-shot command → restart.
  getModelSwitchStrategy(): "runtime" | "restart" { return "restart"; }

  async listModels(): Promise<ModelOption[]> {
    // muse has no models subcommand (the command table is: resume, exec,
    // config, export, trace, skills, plugins, sandbox, schema, serve,
    // session-message, mcp, auth, login, logout, init). This set was read off
    // the live `/model` picker; the `-contributor` variants are the same models
    // with content sharing enabled, which the picker spells out.
    return [
      { id: "muse-spark-1.3", label: "muse-spark-1.3" },
      { id: "muse-spark-1.3-contributor", label: "muse-spark-1.3-contributor (shares content)" },
      { id: "muse-spark-1.2", label: "muse-spark-1.2" },
      { id: "muse-spark-1.2-contributor", label: "muse-spark-1.2-contributor (shares content)" },
    ];
  }

  async probeCLIEnv() {
    const { probeCliVersion } = await import("./types.js");
    // The selected model is the one thing muse persists where we can read it.
    let currentModel: string | undefined;
    try {
      const settings = JSON.parse(readFileSync(
        existsSync(this.settingsPath()) ? this.settingsPath() : this.sharedSettingsPath(),
        "utf-8",
      ));
      if (typeof settings.model === "string") currentModel = settings.model;
    } catch { /* best effort */ }
    return { version: probeCliVersion(this.binaryPath), models: await this.listModels(), currentModel };
  }

  cleanup(config: CliBackendConfig): void {
    try {
      const settingsPath = this.settingsPath();
      const root = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (root.mcpServers) {
        for (const name of Object.keys(config.mcpServers)) {
          delete root.mcpServers[this.mcpKey(name, config.instanceName)];
        }
        writeFileSync(settingsPath, JSON.stringify(root, null, 2), { mode: 0o600 });
        chmodSync(settingsPath, 0o600);
      }
    } catch { /* best effort */ }

    try {
      removeMarker(join(config.workingDirectory, "AGENTS.md"), config.instanceName);
    } catch { /* best effort */ }
  }
}

/** Every `<year>/<month>/<day>/<uuid>` directory under the session store. */
export function museSessionDirs(root: string): string[] {
  const out: string[] = [];
  const children = (dir: string): string[] => {
    try { return readdirSync(dir); } catch { return []; }
  };
  for (const year of children(root)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of children(join(root, year))) {
      for (const day of children(join(root, year, month))) {
        for (const session of children(join(root, year, month, day))) {
          out.push(join(root, year, month, day, session));
        }
      }
    }
  }
  return out;
}
