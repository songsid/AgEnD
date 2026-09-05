import { dirname, join, resolve } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type RuntimeDialog, type StartupDialog, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";

/** Mirror Claude Code's ~/.claude/projects key for a working directory. */
function claudeProjectKey(cwd: string): string {
  let canonical = resolve(cwd);
  try { canonical = realpathSync(canonical); } catch { /* Claude also falls back to the unresolved absolute path */ }

  // Claude Code replaces every non-ASCII alphanumeric character, not only
  // separators. A slash-only replacement misses dots (notably ~/.agend),
  // underscores and spaces, falsely making an existing transcript look absent.
  const sanitized = canonical.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;

  // Claude bounds long project keys to a 200-character prefix plus its stable
  // Java-style string hash. Keep this rare case aligned as well.
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Claude Code's top-level config file, honoring CLAUDE_CONFIG_DIR. */
function claudeJsonPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take `lockPath` via exclusive create, recording {pid, token} so a stale lock
 * can be attributed. Returns the token to release with, or null when the lock
 * could not be acquired within the retry budget.
 *
 * A held lock is NEVER auto-reclaimed. Reclaiming under concurrency cannot be
 * made atomic with the primitives available (rename/link both leave a window
 * where a reclaimed-and-reacquired live lock gets stolen), and every claude.json
 * update is best-effort with a fallback — a skipped trust write is picked up by
 * the startup-dialog dismisser. A lock left by a crashed holder therefore means
 * skipped updates until it is removed manually (delete the .agend.lock file);
 * the crash window is one writeFileSync inside a ~1ms critical section. When
 * the recorded owner PID is verifiably dead we skip immediately instead of
 * burning the whole retry budget waiting for a release that can never come.
 */
export function acquireClaudeJsonLock(lockPath: string, maxAttempts = 40): string | null {
  const token = `${process.pid}.${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify({ pid: process.pid, token });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      writeFileSync(lockPath, payload, { flag: "wx", mode: 0o600 });
      return token;
    } catch { /* already held — fall through to the holder check */ }

    let ownerPid: number | null = null;
    try {
      ownerPid = Number((JSON.parse(readFileSync(lockPath, "utf-8")) as { pid?: unknown }).pid) || null;
    } catch { continue; /* vanished (retry the create now) or content not written yet (retry) */ }
    if (ownerPid !== null) {
      try {
        process.kill(ownerPid, 0);
      } catch (err) {
        // ESRCH = the holder is dead and will never release — give up now.
        // EPERM means alive under another user: keep waiting like any holder.
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return null;
      }
    }
    sleepSync(25);
  }
  return null;
}

/** Release a lock taken by acquireClaudeJsonLock, only if we still own it. */
export function releaseClaudeJsonLock(lockPath: string, token: string): void {
  try {
    const holder = JSON.parse(readFileSync(lockPath, "utf-8")) as { token?: unknown };
    if (holder.token === token) unlinkSync(lockPath);
  } catch { /* already gone or replaced — nothing of ours to release */ }
}

/**
 * Read-modify-write claude.json under a lock file, so concurrent instance
 * spawns don't drop each other's updates, then replace it via atomic rename so
 * a reader never sees a torn file. The file and its lock are created 0600 —
 * claude.json holds OAuth account data, and the rename would otherwise replace
 * the CLI's own 0600 file with the temp file's default 0644/umask mode.
 * `mutate` returns false to skip the write. If the lock cannot be acquired the
 * update is SKIPPED, never performed unlocked (last-write-wins against a
 * concurrent holder could drop that holder's entry); an existing-but-
 * unparseable file is likewise left untouched — never clobber the user's whole
 * config over a parse error. Both give up to the getStartupDialogs() fallback.
 */
function updateClaudeJson(mutate: (cfg: Record<string, unknown>) => boolean): void {
  const path = claudeJsonPath();
  // The parent must exist before both the lock create and the rename — on a
  // fresh machine (no ~/.claude.json yet) an ENOENT here previously made every
  // lock attempt fail, silently degrading to unlocked last-write-wins.
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.agend.lock`;
  const token = acquireClaudeJsonLock(lockPath);
  if (token === null) return;
  try {
    let cfg: Record<string, unknown> = {};
    let raw: string | null = null;
    try { raw = readFileSync(path, "utf-8"); } catch { /* missing file — create a minimal one */ }
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        cfg = parsed as Record<string, unknown>;
      } catch { return; }
    }
    if (!mutate(cfg)) return;
    const tempPath = join(dirname(path), `.claude.json.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
      writeFileSync(tempPath, JSON.stringify(cfg, null, 2), { flag: "wx", mode: 0o600 });
      chmodSync(tempPath, 0o600); // mode above is masked by umask; make 0600 unconditional
      renameSync(tempPath, path);
    } finally {
      try { unlinkSync(tempPath); } catch { /* already renamed */ }
    }
  } finally {
    releaseClaudeJsonLock(lockPath, token);
  }
}


/**
 * Claude's session-resume prompt with the cursor on the destructive default
 * (captured from the 2.1.261 binary: "❯ 1. Resume from summary (recommended)" /
 * "  2. Resume full session as-is"). Anchored to the selector + option number so
 * transcript prose quoting the sentence never matches.
 */
export const CLAUDE_RESUME_PROMPT_DEFAULT = /^[ \t]*[❯›][ \t]*1\.[ \t]*Resume from summary \(recommended\)/m;
/**
 * The resume prompt's two-option menu in ANY arrangement: two consecutive
 * numbered "Resume …" rows. Matches the default shape too, so it must be
 * ordered AFTER the exact entry; on its own it means "a resume menu we do not
 * know how to navigate" — hold, never press.
 */
export const CLAUDE_RESUME_PROMPT_MENU = /^[ \t]*[❯›]?[ \t]*\d\.[ \t]*Resume (?:full session as-is|from summary)[^\n]*\n[ \t]*[❯›]?[ \t]*\d\.[ \t]*Resume (?:full session as-is|from summary)/m;

const RESUME_OPTION_ROW = /^[ \t]*[❯›]?[ \t]*\d\.[ \t]*Resume (?:full session as-is|from summary)/;
const RESUME_DIALOG_FOOTER = /Enter to confirm|Esc to cancel|↑↓|to select|to navigate/i;

/**
 * Is the resume menu the CURRENT interactive region of the pane, and is the
 * cursor on the destructive default? Bottom-anchored on purpose: the LAST pair
 * of option rows must be followed only by the dialog's own footer (at most two
 * rows) — a quoted capture of the menu in a transcript is followed by more
 * transcript and, above all, by the real `❯` input row, so it is not active.
 */
export function claudeResumeMenuState(pane: string): { active: boolean; defaultCursor: boolean } {
  const rows = pane.replace(/\r/g, "").split("\n");
  let start = -1;
  for (let i = rows.length - 2; i >= 0; i--) {
    if (RESUME_OPTION_ROW.test(rows[i]) && RESUME_OPTION_ROW.test(rows[i + 1])) { start = i; break; }
  }
  if (start < 0) return { active: false, defaultCursor: false };
  const trailing = rows.slice(start + 2).filter(r => r.trim().length > 0);
  const active = trailing.length <= 2 && trailing.every(r => RESUME_DIALOG_FOOTER.test(r));
  const defaultCursor = /^[ \t]*[❯›][ \t]*1\.[ \t]*Resume from summary \(recommended\)/.test(rows[start]);
  return { active, defaultCursor };
}
const resumeDefaultActive = (pane: string): boolean => { const s = claudeResumeMenuState(pane); return s.active && s.defaultCursor; };
const resumeMenuActive = (pane: string): boolean => claudeResumeMenuState(pane).active;

export class ClaudeCodeBackend implements CliBackend {
  readonly binaryName = "claude";
  readonly instructionsReloadedOnResume = true;
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("claude");
  }

  buildCommand(config: CliBackendConfig): string {
    const settingsPath = join(this.instanceDir, "claude-settings.json");
    const mcpConfigPath = join(this.instanceDir, "mcp-config.json");
    const envPrefix = ["CMUX_CLAUDE_HOOKS_DISABLED=1", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"];
    if (process.env.ANTHROPIC_BASE_URL) envPrefix.push(`ANTHROPIC_BASE_URL=${shellQuote(process.env.ANTHROPIC_BASE_URL)}`);
    if (process.env.ANTHROPIC_API_KEY && !this.hasOAuthSession()) {
      envPrefix.push(`ANTHROPIC_API_KEY=${shellQuote(process.env.ANTHROPIC_API_KEY)}`);
    }
    let cmd = `${envPrefix.join(" ")} ${this.binaryPath} --settings ${settingsPath} --mcp-config ${mcpConfigPath}`;
    if (config.skipPermissions !== false) cmd += " --dangerously-skip-permissions";

    const sessionIdFile = join(this.instanceDir, "session-id");
    // `session-id` belongs to the instance, not the backend. A ClassicBot can
    // switch from Kiro (or another CLI) to Claude while retaining that marker.
    // Claude's bare `--continue` then looks for a conversation in this cwd and
    // exits when the workspace has never had a Claude session. Treat Claude's
    // own project transcript as the source of truth instead of the generic
    // marker alone. This also makes an empty/missing Classic workspace start
    // fresh rather than entering a resume crash loop.
    if (!config.skipResume && existsSync(sessionIdFile) && this.hasProjectSession(config.workingDirectory)) {
      cmd += " --continue";
    }

    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("claude-code", model);
      cmd += ` --model ${shellQuote(model)}`;
    }

    // Additive system prompt: append fleet instructions without overriding Claude's built-in prompt
    const instrFile = join(this.instanceDir, "fleet-instructions.md");
    if (existsSync(instrFile)) {
      cmd += ` --append-system-prompt-file ${instrFile}`;
    }

    return cmd;
  }

  private hasProjectSession(workingDirectory: string): boolean {
    const cwd = workingDirectory.trim();
    if (!cwd) return false;
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    const encodedCwd = claudeProjectKey(cwd);
    try {
      return readdirSync(join(configDir, "projects", encodedCwd), { withFileTypes: true })
        .some(entry => entry.isFile() && entry.name.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }

  writeConfig(config: CliBackendConfig): void {
    // 1. Write mcp-config.json to instance dir (loaded via --mcp-config)
    const mcpConfigPath = join(this.instanceDir, "mcp-config.json");
    const mcpConfig = { mcpServers: config.mcpServers };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // 2. Write statusline script
    const statusLineCommand = this.writeStatusLineScript();

    // 3. Write claude-settings.json (permissions handled by --dangerously-skip-permissions)
    const settings: Record<string, unknown> = {
      statusLine: {
        type: "command",
        command: statusLineCommand,
      },
    };
    writeFileSync(
      join(this.instanceDir, "claude-settings.json"),
      JSON.stringify(settings),
    );

    // 4. Pre-approve API key to skip interactive prompt on startup
    this.preApproveApiKey(config);

    // 5. Write fleet instructions file (loaded via --append-system-prompt-file)
    if (config.instructions) {
      try { writeFileSync(join(this.instanceDir, "fleet-instructions.md"), config.instructions); } catch { /* best effort */ }
    }
  }

  /**
   * `❯` is the input box, which Claude Code renders persistently — it is on screen
   * while the agent works, not only when it is waiting. So this marks "the TUI has
   * finished starting up", not "the agent is idle"; `getBusyPattern()` is what
   * separates those two. Startup dialogs are matched before this (see
   * getStartupDialogs) because `❯ 1. Resume from summary` would satisfy it.
   *
   * `ok\s*$` used to be the second alternative here and has been removed. `ok` is
   * what *AgEnD's own* statusline script prints (see writeStatusLineScript), so the
   * pattern was matching a line this file writes — permanently true, and true for
   * reasons that had nothing to do with the CLI's state.
   */
  getReadyPattern(): RegExp {
    return /❯/;
  }

  /**
   * The live spinner line, which is on screen only while generating. Captured from
   * running panes and their pipe-pane recordings:
   *
   *   working →  `✢ Accomplishing… (11m 26s · ↓ 38.0k tokens)`
   *   idle    →  `✻ Worked for 6m 49s`
   *
   * Both panes also showed `❯` and the `ok` statusline, which is why neither of
   * those can carry the distinction. The discriminator is the rotating glyph plus
   * Claude's one-word spinner label ending in an ellipsis. The completed line is
   * past tense with no ellipsis. The verb and glyph both rotate, so neither
   * specific value is matched.
   *
   * Claude Code 2.1.239 paints that line incrementally. For roughly the first
   * three seconds — and briefly during later repaints — capture-pane can see only
   * `* Nesting…` before `(3s · ↓ 9 tokens)` is appended. It also emits hyphenated
   * labels such as `Razzle-dazzling…` and `Sock-hopping…`. Requiring the elapsed
   * counter and a letters-only verb made both real shapes look idle. Since `❯`
   * remains visible throughout generation, a settled capture in either shape
   * retired Cancel and the progress bubble while the turn was still running.
   *
   * The animation cycles through six measured frames, including one plain ASCII
   * asterisk. The older leading class required a non-ASCII glyph, so sampling a
   * continuously working pane 50 times at 250ms produced:
   *
   *   ✻ 11/11   ✽ 10/10   ✢ 10/10   · 9/9   ✶ 4/4   * 0/6  ← U+002A never matched
   *
   * Since `❯` is always on screen (claude keeps its input box rendered), the ready
   * pattern is permanently true and this pattern is the only discriminator: one
   * asterisk frame meant "idle" while the CLI was generating, which is what
   * retired cancel buttons mid-turn. 12% of frames, so it hit some turns and not
   * others.
   *
   * Deliberately narrow, because the cost is asymmetric. Matching prose that
   * happens to sit on a *stable* pane would hold the instance in `working`
   * forever — no auto-pause, no cancel-button retirement, and eventually a bogus
   * hang alert. Therefore this accepts only Claude's six measured spinner glyphs,
   * exactly one word (optionally hyphenated), and the Unicode ellipsis. Markdown
   * prose such as `* bullet point…`, `- Something…`, and a completed
   * `✻ Worked for 6m 49s` remain rejected.
   *
   * Note when this actually decides anything: while the CLI really is generating,
   * the elapsed counter ticks, the pane changes, and motion already reports
   * `working`. The veto only bites on a *frozen* pane whose last frame still shows
   * an in-progress spinner — which is exactly the hang this is meant to surface.
   */
  getBusyPattern(): RegExp {
    return /^[ \t]*[✻✽✢·✶*][ \t]+\p{L}+(?:-\p{L}+)*…(?:[ \t]+\([^\n]*)?[ \t]*$/mu;
  }

  getContextUsage(): number | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.context_window?.used_percentage ?? null;
    } catch (err) {
      // File may not exist yet during startup — return null to signal unavailable
      return null;
    }
  }

  getSessionId(): string | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.session_id ?? null;
    } catch {
      return null;
    }
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /API Error: Rate limit/i, type: "rate_limit", action: "failover", message: "API rate limit reached" },
      // pause (not just notify): an auth-expired CLI keeps accepting queued work
      // it can never answer. The pause is lifted by /login's post-success
      // restart, and the lifecycle double-checks with the token-free probe first.
      { pattern: /Login expired|Not logged in|Please run \/login/i, type: "auth_error", action: "pause", message: "Claude login expired — needs re-login (/login)" },
      { pattern: /API Error: Authentication/i, type: "auth_error", action: "pause", message: "Authentication error" },
      // A bad /model choice previously failed silently (live-reported): the CLI
      // prints these and idles without answering. notify (not restart): the
      // session is healthy, only the model selection needs changing.
      {
        // Claude 2.1.250 emits `unrecognized_model` for an unknown ID and
        // `model_access` / the plan sentence when the ID exists but the
        // account is not entitled to it. Keep the prose alternatives narrow:
        // the error monitor also sees normal conversation in pane scrollback.
        pattern: /\[claude-code:(?:unrecognized_model|model_access)\]|There's an issue with the selected model|\bis not available on your [^\n]{0,80},\s*or ask your admin to enable this model/i,
        type: "model_error",
        action: "notify",
        message: "Selected Claude model unavailable — Claude Code may be using a fallback; use /model to choose another",
      },
      { pattern: /API Error: Overloaded/i, type: "rate_limit", action: "notify", message: "API overloaded" },
      { pattern: /credit balance is too low/i, type: "quota", action: "pause", message: "Insufficient API credits" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      // A corrupt claude.json shows a modal whose only options are "1. Exit and
      // fix manually" / "2. Reset with default configuration" (captured live on
      // 2.1.250). Neither is dismissable in a useful direction: Enter exits
      // (crash loop), reset wipes the user's config. The modal's ❯ selector
      // would satisfy the ready pattern, so without this entry the instance
      // reports ready and queued messages get typed into the modal. Must stay
      // FIRST so no dismiss pattern grabs the pane before it.
      {
        pattern: /Configuration error[\s\S]{0,800}?contains invalid JSON/,
        keys: [],
        description: "Claude corrupt-config modal — not dismissable, reporting config_error",
        fatal: { type: "config_error", action: "pause", message: "claude.json is corrupt — Claude Code cannot start. Fix or remove the file (Claude backs the corrupt copy up under <config>/backups/), then wake the instance." },
      },
      // Session resume prompt must be checked BEFORE ready pattern, because ❯ in
      // "❯ 1. Resume from summary" would falsely match the ready pattern /❯/.
      // Only when the cursor is verifiably on option 1 ("❯ 1. Resume from
      // summary (recommended)") do we know that Down+Enter lands on "Resume
      // full session as-is". Any other shape is held by the guard below.
      { pattern: CLAUDE_RESUME_PROMPT_DEFAULT, isActive: resumeDefaultActive, keys: ["Down", "Enter"], description: "Claude session resume prompt — select 'Resume full session as-is'", blocksDelivery: true },
      // The same prompt in a shape we do not know how to navigate (cursor
      // elsewhere, wording changed, options reordered): recognised by its
      // two-option menu structure, never answered — a blind Enter would take
      // the default and drop the full context. Hold the pane, report for a human.
      { pattern: CLAUDE_RESUME_PROMPT_MENU, isActive: resumeMenuActive, keys: [], holdOnly: true, blocksDelivery: true, description: "Claude session resume prompt (unrecognised variant) — holding for a human, never auto-selecting" },
      { pattern: /[❯›]\s*\d+\.\s*No/m, keys: ["Down", "Enter"], description: "Claude 'No, exit' confirmation — navigate to Yes" },
      // The 2.1.250 workspace-trust dialog has no numbered options — the cursor
      // sits on "❯ No, exit" above "Yes, I trust this folder" (captured live).
      // It must be matched BEFORE the generic /I trust/ Enter fallback below:
      // that pattern also matches this screen's "Yes, I trust this folder" text,
      // and a bare Enter there confirms "No, exit" — the dialog fallback itself
      // used to exit the CLI. preTrust() normally prevents the dialog entirely;
      // this is the recovery path when the config write was skipped.
      { pattern: /[❯›]\s*No, exit/m, keys: ["Down", "Enter"], description: "Claude workspace trust dialog — navigate to 'Yes, I trust this folder'" },
      { pattern: /I accept|I trust/i, keys: ["Enter"], description: "Claude 'Yes, I accept' trust dialog" },
      { pattern: /Resume Session/i, keys: ["Escape"], description: "Claude resume session picker — start fresh" },
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      {
        // Claude Code shows a session resume prompt when session is old/large —
        // sometimes only after loading the session, i.e. after the startup scan
        // has already moved on, which is why it is in the runtime table too.
        // Default cursor is on summary; move down to preserve the full context.
        pattern: CLAUDE_RESUME_PROMPT_DEFAULT,
        isActive: resumeDefaultActive,
        keys: ["Down", "Enter"],
        description: "Claude session resume prompt — select 'Resume full session as-is'",
        blocksDelivery: true,
      },
      // Same variant guard as getStartupDialogs: recognise, hold, report — never Enter.
      {
        pattern: CLAUDE_RESUME_PROMPT_MENU,
        isActive: resumeMenuActive,
        keys: [],
        holdOnly: true,
        blocksDelivery: true,
        description: "Claude session resume prompt (unrecognised variant) — holding for a human, never auto-selecting",
      },
    ];
  }

  getQuitCommand(): string { return "/exit"; }

  getCompactCommand(): string { return "/compact"; }
  getClearCommand(): string { return "/clear"; }

  getCancelKey(): string { return "Escape"; }

  // `claude --effort <level>` (low, medium, high, xhigh, max) and a `/effort`
  // slash command in the TUI — verified from `claude --help` on 2026-08-02.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return "runtime"; }
  getEffortLevels(): string[] { return ["low", "medium", "high", "xhigh", "max"]; }

  // claude-code has a clean one-shot in-session `/model <name>` → runtime switch.
  getModelSwitchStrategy(): "runtime" | "restart" { return "runtime"; }

  async listModels(): Promise<import("./types.js").ModelOption[]> {
    return [
      { id: "default", label: "default", description: "account default" },
      { id: "sonnet", label: "sonnet" },
      { id: "opus", label: "opus" },
      { id: "haiku", label: "haiku" },
      { id: "opusplan", label: "opusplan", description: "opus plans, sonnet executes" },
      // Capitalised because that is the form verified to work with
      // `claude --model Fable`; the lowercase alias is unconfirmed.
      { id: "Fable", label: "Fable", description: "Claude Fable 5" },
    ];
  }

  /**
   * Full account catalog from `GET /v1/models` using the same OAuth token the
   * usage panel resolves. Each model also gets an `<id>[1m]` 1M-context
   * variant: the API cannot say which plans may use it, so the variants are
   * offered and a wrong pick surfaces through the model_error pattern above.
   * Any failure (no token, network, non-200) degrades to [] — the static
   * aliases from listModels() always remain available.
   */
  async listApiModels(): Promise<import("./types.js").ModelOption[]> {
    try {
      const { getClaudeOAuthToken } = await import("../usage/providers.js");
      const token = await getClaudeOAuthToken();
      if (!token) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      timer.unref?.();
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return [];
      const body = await res.json() as { data?: Array<{ id?: string; display_name?: string }> };
      const options: import("./types.js").ModelOption[] = [];
      for (const model of body.data ?? []) {
        if (!model.id) continue;
        options.push({ id: model.id, label: model.id, ...(model.display_name ? { description: model.display_name } : {}) });
        options.push({ id: `${model.id}[1m]`, label: `${model.id}[1m]`, description: "1M context — plan-dependent" });
      }
      return options;
    } catch {
      return [];
    }
  }

  async probeCLIEnv() {
    const { probeCliVersion } = await import("./types.js");
    return {
      version: probeCliVersion(this.binaryPath),
      models: await this.listModels(),
      apiModels: await this.listApiModels(),
    };
  }

  cleanup(_config: CliBackendConfig): void {
    // mcp-config.json is in instance dir, cleaned up when instance is deleted
  }

  /**
   * Pre-accept Claude Code's workspace trust dialog for this working directory.
   * The interactive TUI blocks a fresh workspace on "Do you trust the files in
   * this folder?" and nothing in tmux answers it, so the process exits and the
   * instance crash-loops. No CLI flag skips it interactively (verified on
   * 2.1.250 — only -p / non-TTY stdout bypass the dialog); the recognised
   * signal is projects[<cwd>].hasTrustDialogAccepted in claude.json.
   */
  preTrust(workingDirectory: string): void {
    const cwd = workingDirectory?.trim();
    if (!cwd) return;
    const literal = resolve(cwd);
    let canonical = literal;
    try { canonical = realpathSync(literal); } catch { /* not created yet — trust the literal path */ }
    // Trust both spellings when they differ: Claude keys projects by the cwd's
    // realpath but falls back to the unresolved absolute path (see
    // claudeProjectKey above), and which one the TUI sees depends on how tmux
    // entered the directory.
    const paths = canonical === literal ? [canonical] : [canonical, literal];
    try {
      updateClaudeJson(cfg => {
        let projects = cfg.projects as Record<string, unknown> | undefined;
        if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
          projects = {};
          cfg.projects = projects;
        }
        let changed = false;
        for (const p of paths) {
          const existing = projects[p];
          const entry = existing && typeof existing === "object" && !Array.isArray(existing)
            ? existing as Record<string, unknown>
            : {};
          if (entry.hasTrustDialogAccepted === true) continue;
          entry.hasTrustDialogAccepted = true;
          projects[p] = entry;
          changed = true;
        }
        return changed;
      });
    } catch { /* best effort — startup dialog auto-dismiss remains the fallback */ }
  }

  /** Pre-approve ANTHROPIC_API_KEY in claude.json to skip the interactive prompt */
  private preApproveApiKey(_config: CliBackendConfig): void {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const fingerprint = apiKey.length > 20 ? apiKey.slice(-20) : apiKey;
    try {
      updateClaudeJson(cfg => {
        const existing = cfg.customApiKeyResponses as { approved?: string[]; rejected?: string[] } | undefined;
        const approved = existing?.approved ?? [];
        if (approved.includes(fingerprint)) return false;
        cfg.customApiKeyResponses = {
          approved: [...approved, fingerprint],
          rejected: existing?.rejected ?? [],
        };
        return true;
      });
    } catch { /* best effort — the startup prompt remains the fallback */ }
  }

  /** Check if user has an active OAuth session in claude.json */
  private hasOAuthSession(): boolean {
    try {
      const cfg = JSON.parse(readFileSync(claudeJsonPath(), "utf-8"));
      return !!cfg.oauthAccount?.accountUuid;
    } catch {
      return false;
    }
  }

  private writeStatusLineScript(): string {
    const statusFile = join(this.instanceDir, "statusline.json");
    // Use a Node.js script instead of bash to avoid shell injection via statusFile path
    const script = [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "let input = '';",
      "process.stdin.on('data', d => input += d);",
      `process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(statusFile)}, input); console.log('ok'); });`,
    ].join("\n");
    const scriptPath = join(this.instanceDir, "statusline.js");
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }
}
