import { CANONICAL_EFFORT, EFFORT_CAPABILITIES, agyEffortLevels } from "./effort-metadata.js";
import { dirname, join } from "node:path";
import { ensureInstanceDir } from "../private-dir.js";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  type CliBackend,
  type CliBackendConfig,
  type ErrorPattern,
  type RuntimeDialog,
  type StartupDialog,
  resolveBinary,
  shellQuote,
  warnIfModelMismatch,
} from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";
import { getAgendHome } from "../paths.js";
import { PIE_CLASS } from "../tui-glyphs.js";

/** Parse `agy models`, which may emit TSV slug/display pairs or legacy single-column names. */
/**
 * agy's logged-out startup screen, as the CLI paints it (captured offline from 1.0.10 and 1.3.1):
 *
 *   Welcome to the Antigravity CLI. You are currently not signed in.
 *   Select login method:
 *   > 1. Google OAuth
 *     2. Use a Google Cloud project
 *   ↑/↓ Navigate · enter Select            (1.0.10: [Use arrow keys to navigate, Enter to select])
 *
 * Bottom-anchored: the not-signed-in line, then the title, then only numbered option rows and at most one key-hint
 * row. A transcript that quotes the screen has the prompt below it, so it never matches. ("not logged into
 * Antigravity", the old pattern, is only ever written to agy's log file, never to the pane.)
 */
export function agyLoginScreenActive(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n").map(row => row.replace(/\s+$/, "")).filter(row => row.trim() !== "");
  let title = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (/^[ \t]*Select login method:$/.test(rows[i]!)) { title = i; break; }
  if (title < 1 || !/You are currently not signed in\.?$/.test(rows[title - 1]!)) return false;
  const below = rows.slice(title + 1);
  let options = 0;
  while (options < below.length && /^[ \t]*(?:[>❯›][ \t]*)?\d\.[ \t]+\S/.test(below[options]!)) options++;
  const rest = below.slice(options);
  return options >= 2 && (rest.length === 0 || (rest.length === 1 && /navigate/i.test(rest[0]!) && /select/i.test(rest[0]!)));
}

/**
 * agy's trust prompt, bottom-anchored (captured live, 1.3.1):
 *
 *   Do you trust the contents of this project?
 *   Antigravity CLI requires permission to read, edit, and execute files here.
 *   > Yes, I trust this folder
 *     No, exit
 *     ↑/↓ Navigate · enter Confirm
 *                                                   Gemini 3.8 Flash · high
 *
 * "yes": the prompt is the live screen and the one cursor is on "Yes, I trust this folder"; "other": it is the live
 * screen but the cursor is elsewhere, missing or doubled; null: not the live screen (not present, or something other
 * than its own hint/status rows follows the options — a quoted copy in a conversation).
 */
export function agyTrustDialogState(pane: string): "yes" | "other" | null {
  const rows = pane.replace(/\r/g, "").split("\n").map(row => row.replace(/\s+$/, "")).filter(row => row.trim() !== "");
  let title = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (/^[ \t]*Do you trust the contents of this project\?$/.test(rows[i]!)) { title = i; break; }
  if (title < 0) return null;
  const below = rows.slice(title + 1);
  const yes = below.findIndex(row => /^[ \t]*(?:\S[ \t]+)?Yes, I trust this folder$/.test(row));
  if (yes < 0 || yes > 2 || !/^[ \t]*(?:\S[ \t]+)?No, exit$/.test(below[yes + 1] ?? "")) return null;
  const tail = below.slice(yes + 2);
  if (tail.length > 2 || !tail.every(row => /Navigate|Confirm|·/.test(row))) return null;
  const cursorOn = (row: string) => /^[ \t]*[>❯›][ \t]/.test(row);
  return cursorOn(below[yes]!) && !cursorOn(below[yes + 1]!) ? "yes" : "other";
}

/**
 * The levels on the `--effort` row of `agy --help`, in AgEnD's canonical order, or null when the row or its
 * `(a|b|…)` list is absent. 1.3.1: "--effort   Reasoning effort for the current CLI session (low|medium|high|xhigh|max)";
 * 1.0.10 has no --effort at all. Unknown names are dropped.
 */
export function parseAgyEffortLevels(help: string): string[] | null {
  const row = help.split("\n").find(line => /^\s*--effort\b/.test(line));
  const list = row ? /\(([A-Za-z]+(?:\|[A-Za-z]+)+)\)/.exec(row) : null;
  if (!list) return null;
  const offered = new Set(list[1].toLowerCase().split("|"));
  const levels = CANONICAL_EFFORT.filter(level => offered.has(level));
  return levels.length > 0 ? levels : null;
}

export function parseAntigravityModelsOutput(output: string): import("./types.js").ModelOption[] {
  const models: import("./types.js").ModelOption[] = [];
  const seen = new Set<string>();
  const validSlug = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
  const validLabel = /^[A-Za-z0-9][A-Za-z0-9 ._:/()+-]*$/;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(?:Fetching available models|Available models|Default model):?/i.test(line)) continue;

    const tab = line.indexOf("\t");
    const id = (tab >= 0 ? line.slice(0, tab) : line)
      .trim().replace(/^(?:[*•-]|\d+\.)\s*/, "").trim();
    const label = tab >= 0 ? line.slice(tab + 1).trim() : id;
    if (!id
      || !(tab >= 0 ? validSlug.test(id) : validLabel.test(id))
      || !validLabel.test(label)
      || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models;
}

export class AntigravityBackend implements CliBackend {
  readonly binaryName = "agy";
  private binaryPath: string;
  private readonly mcpWrapperPath: string;

  constructor(
    private instanceDir: string,
    private userHome = homedir(),
    private agendHome = getAgendHome(),
  ) {
    this.binaryPath = resolveBinary("agy");
    this.mcpWrapperPath = join(instanceDir, "agy-mcp-env.sh");
  }

  buildCommand(config: CliBackendConfig): string {
    // agy 1.1.17+ has no per-workspace MCP config and no --mcp-config flag. Its
    // global MCP child does inherit the CLI process environment, so MCP-mode
    // instances launch through an owner-only wrapper written by writeConfig().
    // The wrapper keeps socket paths and decisions out of the shared config.
    const prefix = config.agentMode === "mcp" && existsSync(this.mcpWrapperPath)
      ? `${shellQuote(this.mcpWrapperPath)} `
      : "";
    let cmd = `${prefix}${this.binaryPath} --dangerously-skip-permissions`;
    if (!config.skipResume) cmd += " --continue";
    if (config.model) {
      warnIfModelMismatch("antigravity", config.model);
      // agy may expose human-readable model names containing spaces/parens.
      cmd += ` --model ${shellQuote(config.model)}`;
    }
    return cmd;
  }

  /** agy >= 1.1.0 accepts hidden working directories (upstream issue #20). */
  resolveWorkingDirectory(workingDirectory: string, instanceName?: string): string {
    void instanceName;
    mkdirSync(workingDirectory, { recursive: true });
    return workingDirectory;
  }

  writeConfig(config: CliBackendConfig): void {
    // Write .agents/agents.md in the persistent configured workspace.
    const cwd = this.resolveWorkingDirectory(config.workingDirectory, config.instanceName);
    const agentsDir = join(cwd, ".agents");
    mkdirSync(agentsDir, { recursive: true });

    if (config.instructions) {
      const agentsPath = join(agentsDir, "agents.md");
      appendWithMarker(agentsPath, config.instanceName, config.instructions);
    }

    if (config.agentMode === "mcp" && Object.keys(config.mcpServers).length > 0) {
      this.writeMcpEnvWrapper(config);
      this.ensureGlobalMcpLauncher(config);
    } else {
      // An instance explicitly switched to CLI mode must not retain secrets from
      // an earlier MCP-mode launch.
      try { unlinkSync(this.mcpWrapperPath); } catch { /* absent */ }
    }

    this.enableStatusLine();
  }

  private writeMcpEnvWrapper(config: CliBackendConfig): void {
    const entry = Object.values(config.mcpServers)[0];
    if (!entry) return;
    ensureInstanceDir(this.instanceDir);
    const exports = Object.entries({ ...entry.env, AGEND_INSTANCE_NAME: config.instanceName })
      .map(([key, value]) => `export ${key}=${shellQuote(String(value))}`)
      .join("\n");
    writeFileSync(
      this.mcpWrapperPath,
      `#!/bin/sh\n${exports}\nexec "$@"\n`,
      { mode: 0o700 },
    );
    // mode only applies on create; also heal a wrapper from an older version.
    chmodSync(this.mcpWrapperPath, 0o700);
  }

  private ensureGlobalMcpLauncher(config: CliBackendConfig): void {
    const entry = Object.values(config.mcpServers)[0];
    const serverPath = entry?.args?.[0];
    if (!entry || typeof serverPath !== "string") return;

    const configDir = join(this.userHome, ".gemini", "config");
    const configPath = join(configDir, "mcp_config.json");
    const lockPath = join(configDir, ".agend-mcp.lock");
    mkdirSync(configDir, { recursive: true });

    let lockFd: number | undefined;
    try {
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
      } catch (err) {
        // A crashed writer must not block every future agy launch forever.
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
          else return; // another fleet process is writing the identical entry
          lockFd = openSync(lockPath, "wx", 0o600);
        } catch {
          return;
        }
      }
      writeFileSync(lockFd, String(process.pid));

      let root: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, "utf-8").trim();
          root = content ? JSON.parse(content) : {};
        } catch {
          throw new Error(`Refusing to overwrite invalid Antigravity MCP config: ${configPath}`);
        }
      }
      if (!root || typeof root !== "object" || Array.isArray(root)) {
        throw new Error(`Refusing to overwrite invalid Antigravity MCP config: ${configPath}`);
      }

      const existing = root.mcpServers;
      const servers: Record<string, unknown> = existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};

      // Remove only entries recognizable as older AgEnD-managed servers. Key
      // names alone are not ownership evidence: a user may have their own
      // server named "agend".
      for (const [name, value] of Object.entries(servers)) {
        if (name === "agend-fleet") continue;
        if (this.isManagedAgendMcpEntry(value)) delete servers[name];
      }

      const current = servers["agend-fleet"];
      if (current && !this.isManagedAgendMcpEntry(current)) {
        throw new Error("Antigravity MCP server name 'agend-fleet' is already user-managed");
      }
      servers["agend-fleet"] = {
        command: entry.command,
        args: [join(dirname(serverPath), "agy-mcp-launcher.js")],
      };
      root.mcpServers = servers;

      const tempPath = `${configPath}.${process.pid}.tmp`;
      writeFileSync(tempPath, JSON.stringify(root, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, configPath);
      chmodSync(configPath, 0o600);
    } finally {
      if (lockFd !== undefined) {
        closeSync(lockFd);
        try { unlinkSync(lockPath); } catch { /* stale cleanup */ }
      }
    }
  }

  private isManagedAgendMcpEntry(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    const env = entry.env;
    if (env && typeof env === "object" && !Array.isArray(env)
      && typeof (env as Record<string, unknown>).AGEND_SOCKET_PATH === "string") return true;
    const command = typeof entry.command === "string" ? entry.command : "";
    const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
    return [command, ...args].some(path => /(?:^|[/\\])(?:mcp-server|agy-mcp-launcher)\.js$/.test(path));
  }

  /**
   * Make agy's TUI footer show context usage so /ctx can scrape it. agy has no
   * native context-% element — its statusLine is a hook that runs a command
   * script and renders whatever the script prints. So we (1) write a small
   * script that turns agy's JSON telemetry into "Context N% used", and (2) point
   * statusLine.command at it (+ enabled: true) in the user's global
   * ~/.gemini/antigravity-cli/settings.json. A user's OWN statusLine.command is
   * never overwritten. Best-effort — never blocks launch.
   */
  private enableStatusLine(): void {
    try {
      // (Re)write our statusline script each launch so it stays current. agy
      // pipes JSON telemetry on stdin; we emit "Context N% used" (matches
      // parseContextPercent). Uses node (always present in an AgEnD env) rather
      // than jq (not guaranteed); a parse error prints nothing (empty footer).
      const scriptPath = join(this.agendHome, "agy-statusline.sh");
      const script = `#!/bin/bash
# AgEnD-generated agy statusline — prints "Context N% used" for /ctx to scrape.
node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log('Context '+(Math.round(j.context_window?.used_percentage||0))+'% used')}catch{}})"
`;
      try {
        mkdirSync(this.agendHome, { recursive: true });
        writeFileSync(scriptPath, script, { mode: 0o755 });
        chmodSync(scriptPath, 0o755);  // writeFileSync mode only applies on create
      } catch { /* best effort — a bad script write shouldn't block settings */ }

      const agyDir = join(this.userHome, ".gemini", "antigravity-cli");
      const settingsPath = join(agyDir, "settings.json");
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")) ?? {}; } catch { /* new/empty/corrupt → start fresh */ }
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {};
      const statusLine = (settings.statusLine && typeof settings.statusLine === "object" && !Array.isArray(settings.statusLine))
        ? settings.statusLine as Record<string, unknown>
        : {};

      let changed = false;
      if (statusLine.enabled !== true) { statusLine.enabled = true; changed = true; }
      // Only install our script if the user hasn't set their own command.
      const hasUserCommand = typeof statusLine.command === "string" && statusLine.command.trim() !== "";
      if (!hasUserCommand && statusLine.command !== scriptPath) { statusLine.command = scriptPath; changed = true; }

      if (!changed) return;  // nothing to update — don't rewrite the user's file
      settings.statusLine = statusLine;
      mkdirSync(agyDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    } catch { /* best effort — never block launch on statusline config */ }
  }

  cleanup(config: CliBackendConfig): void {
    const agentsPath = join(config.workingDirectory, ".agents", "agents.md");
    try {
      if (removeMarker(agentsPath, config.instanceName)) rmSync(agentsPath, { force: true });
    } catch { /* best effort */ }
    try { unlinkSync(this.mcpWrapperPath); } catch { /* absent */ }
  }

  getReadyPattern(): RegExp {
    // Daily prompts observed in the TUI are either a pie context reading
    // ("◑ 42%") on its own footer line, or a standalone ">" between separators.
    // Pie branch is line-anchored so agent prose like "● 45% 完成" cannot
    // false-ready the pane (● is in PIE_CLASS).
    //
    // Bare `Gemini` was removed: it is the model label in the persistent header,
    // on screen while streaming too, so it made the whole pattern constant-true
    // (same failure as claude-code's old `ok` — see #415). The remaining markers
    // are still visible during generation; getBusyPattern() is what separates
    // idle from working.
    return new RegExp(`\\? for shortcuts|^\\s*${PIE_CLASS}\\s*\\d+%|^>\\s*$`, "m");
  }

  /**
   * The live spinner line, on screen only while agy is generating — as reported
   * from the duplicate-reply incident pane: a rotating star/dot glyph, a
   * "thinking" verb, and a live seconds timer, e.g. `✢ Thinking… 12s` /
   * `· Reasoning... (esc to cancel)`.
   *
   * The first alternative was reconstructed from that incident report, never captured.
   *
   * #1328, captured live from a signed-in agy 1.3.1 (tests/fixtures/agy-1.3.1-busy-generating*.pane.txt): the
   * working row is a BRAILLE spinner frame, a verb and an ellipsis, and nothing else — `⣯  Generating...` — with no
   * timer and no `(esc to cancel)` on it, so the first alternative never matched and agy was always seen as idle.
   * Under AgEnD's own statusLine the footer is blank while working (no `esc to cancel` hint either), so this row is
   * the one signal. It is gone once the reply is written. Line-anchored at both ends, so prose quoting it mid-line, or
   * a list item that happens to end in "...", does not count.
   */
  getBusyPattern(): RegExp {
    return /^[ \t]*[·✢✶✻✽][ \t]+\p{L}[^\n]*(?:…|\.\.\.)[^\n]*(?:\b\d+(?:\.\d+)?s\b|\(esc to cancel\))|^[ \t]*[\u2800-\u28FF][ \t]+\p{L}[^\n]*?(?:…|\.\.\.)[ \t]*(?:\(esc to cancel\)|\d+(?:\.\d+)?s)?[ \t]*$/mu;
  }

  // agy periodically reruns and repaints its statusLine hook even when the
  // resulting footer is byte-for-byte identical on screen. A raw tmux %output
  // event is therefore not sufficient evidence that the agent started work.
  hasPeriodicPaneRedraw(): boolean { return true; }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    try {
      const f = join(this.instanceDir, "session-id");
      return readFileSync(f, "utf-8").trim() || null;
    } catch { return null; }
  }

  // agy does not implement /quit — it treats it as a normal chat message.
  // Verified with agy 1.1.8: two Ctrl+C presses exit the idle TUI cleanly.
  getQuitCommand(): null { return null; }
  getQuitKey(): string { return "C-c"; }
  getQuitKeyPresses(): number { return 2; }

  // agy has no summarizing /compact — "/clear" is the only manual context reset
  // (full reset; agy also auto-summarizes at a token threshold).
  getCompactCommand(): string { return "/clear"; }
  getClearCommand(): string { return "/clear"; }

  // agy's documented interrupt is Ctrl+C (2-stage: 2nd press exits the CLI).
  // Escape also stops streams and can't exit the app, so it's the safer cancel.
  getCancelKey(): string { return "Escape"; }

  // The levels come from the binary's own `--help` ("--effort … (low|medium|high|xhigh|max)" in 1.3.1), read by the
  // CLI env probe (probeCLIEnv, in its bounded worker) and cached with the rest of the CLI env; until a probe has run,
  // or when the help lists none, low|medium|high, so xhigh/max then clamp to high, which the caller reports.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return EFFORT_CAPABILITIES["antigravity"].strategy; }
  getEffortLevels(): string[] { return agyEffortLevels(); }

  // agy's model switch is an interactive TUI change → restart to apply reliably.
  getModelSwitchStrategy(): "runtime" | "restart" { return "restart"; }

  async listModels(): Promise<import("./types.js").ModelOption[]> {
    // agy 1.1.24 emits `slug<TAB>Display Name`; older releases emitted one slug
    // or human-readable name per line. stderr carries the fetching spinner and
    // is intentionally ignored.
    try {
      const out = execFileSync(this.binaryPath, ["models"],
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const models = parseAntigravityModelsOutput(out);
      if (models.length) return models;
    } catch { /* unknown format — fall back to free-text */ }
    return [];
  }

  async probeCLIEnv() {
    const { probeCliVersion } = await import("./types.js");
    // agy stores the selected model in its own settings.json (the same file the
    // statusline hook lives in), e.g. "model": "Gemini 3.5 Flash (Medium)".
    let currentModel: string | undefined;
    try {
      const s = JSON.parse(readFileSync(join(this.userHome, ".gemini", "antigravity-cli", "settings.json"), "utf-8"));
      if (typeof s?.model === "string" && s.model.trim()) currentModel = s.model.trim();
    } catch { /* no settings / unreadable */ }
    const models = await this.listModels();
    if (currentModel) {
      // settings.json stores the display name, while `agy --model` and the
      // Settings picker use the TSV slug. Keep an already-slug value unchanged.
      currentModel = models.find(model => model.label === currentModel)?.id ?? currentModel;
    }
    // The effort levels this binary takes, from its own --help (#1328). Runs here, in the probe worker, never on a
    // tool path; a failed or list-less help leaves them out and readers keep the previous value or the fallback.
    let effortLevels: string[] | undefined;
    try {
      const help = execFileSync(this.binaryPath, ["--help"], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      effortLevels = parseAgyEffortLevels(help) ?? undefined;
    } catch { /* no help → previous value or the fallback */ }
    return { version: probeCliVersion(this.binaryPath), models, currentModel, ...(effortLevels ? { effortLevels } : {}) };
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      // The account-level cap, relayed verbatim from the server ("Individual
      // quota reached. Please upgrade your subscription to increase your
      // limits. Resets in 139h12m12s."). Listed before the generic quota
      // pattern: the monitor fires the FIRST matching pattern, and this one's
      // full line carries the reset time the usage overlay parses. The quota
      // summary API cannot see this cap — its buckets read 0% used while the
      // CLI is blocked — so this pane line is the only source of truth.
      {
        pattern: /(?:Individual|Organization) quota reached[^\n]*/i,
        type: "quota",
        action: "notify",
        message: "Antigravity quota reached",
        formatMessage: m => m[0].trim(),
        skipRecoveryWait: true,
      },
      { pattern: /RESOURCE_EXHAUSTED|quota/i, type: "quota", action: "notify", message: "Quota exhausted" },
      { pattern: /error.*authentication|UNAUTHENTICATED/i, type: "auth_error", action: "pause", message: "Antigravity authentication error — needs re-login" },
      // Model generation change pins the resumed session to a dead model placeholder
      // (e.g. MODEL_PLACEHOLDER_M264) → every message returns "unknown model key".
      // The CLI stays up, so this never self-recovers — force a fresh restart
      // (skipRecoveryWait) that abandons the session so agy falls back to a valid
      // model. skipRecoveryWait: the CLI is still at its prompt, not crashed.
      { pattern: /unknown model key|failed to construct executor/i, type: "model_error", action: "restart", message: "Model no longer available — restarting with a fresh session", skipRecoveryWait: true },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      // #1328, captured live from agy 1.3.1 (tests/fixtures/agy-1.3.1-trust-dialog.pane.txt): the title is "Do you
      // trust the contents of this project?", then "> Yes, I trust this folder" / "  No, exit". Enter confirms the
      // row under the cursor, so it is sent once, and only when the cursor is verified on "Yes"; a prompt still up
      // after that, or one with the cursor anywhere else, is held for a human (the hold that follows).
      {
        pattern: /Yes, I trust this folder/,
        isActive: pane => agyTrustDialogState(pane) === "yes",
        keys: ["Enter"],
        description: "Trust folder prompt",
        blocksDelivery: true,
        inputBlocked: true,
        autoResolutionKey: "antigravity-folder-trust",
      },
      this.trustHoldDialog(),
    ];
  }

  /** Any live agy trust prompt that is not being answered: never keyed, deliveries held (startup and runtime). */
  private trustHoldDialog(): RuntimeDialog {
    return {
      pattern: /Do you trust the contents of this project/,
      isActive: pane => agyTrustDialogState(pane) !== null,
      keys: [],
      holdOnly: true,
      blocksDelivery: true,
      inputBlocked: true,
      description: "Antigravity folder trust needs human confirmation",
    };
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      {
        // Google may sample this after any completed turn. A single numeric
        // hotkey dismisses it; Enter would submit an empty follow-up prompt.
        pattern: /^\s*\[1\] Good\s+\[2\] Fine\s+\[3\] Bad\s+\[0\] Skip\s*$/m,
        keys: ["0"],
        description: "Antigravity feedback survey — skip",
      },
      this.trustHoldDialog(),
    ];
  }
}
