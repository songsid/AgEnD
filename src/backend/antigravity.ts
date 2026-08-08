import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, resolveBinary, shellQuote, warnIfModelMismatch } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";
import { getAgendHome } from "../paths.js";
import { PIE_CLASS } from "../tui-glyphs.js";

/** Parse `agy models`, which may emit slugs or human-readable display names. */
export function parseAntigravityModelsOutput(output: string): import("./types.js").ModelOption[] {
  const models: import("./types.js").ModelOption[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const id = rawLine.trim().replace(/^(?:[*•-]|\d+\.)\s*/, "").trim();
    if (!id
      || /^(?:Available models|Default model):/i.test(id)
      || !/^[A-Za-z0-9][A-Za-z0-9 ._:/()+-]*$/.test(id)
      || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

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
      // agy may expose human-readable model names containing spaces/parens.
      cmd += ` --model ${shellQuote(config.model)}`;
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
      const scriptPath = join(getAgendHome(), "agy-statusline.sh");
      const script = `#!/bin/bash
# AgEnD-generated agy statusline — prints "Context N% used" for /ctx to scrape.
node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log('Context '+(Math.round(j.context_window?.used_percentage||0))+'% used')}catch{}})"
`;
      try {
        mkdirSync(getAgendHome(), { recursive: true });
        writeFileSync(scriptPath, script, { mode: 0o755 });
        chmodSync(scriptPath, 0o755);  // writeFileSync mode only applies on create
      } catch { /* best effort — a bad script write shouldn't block settings */ }

      const agyDir = join(homedir(), ".gemini", "antigravity-cli");
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
    const cwd = join(homedir(), "agend-workspaces", config.instanceName);
    if (existsSync(cwd)) {
      try { rmSync(cwd, { recursive: true }); } catch { /* ignore */ }
    }
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
   * IMPORTANT CAVEAT, deliberately on the record: unlike claude-code (#415) and
   * grok (#430), this pattern is NOT derived from a pane I captured myself.
   * There is no antigravity instance in this fleet and no agy pipe-pane
   * recording on this machine (the closest candidates turned out to be kiro's
   * TUI). The shape comes from the incident observation plus the same
   * asymmetric-cost rules as the other backends: anchored to a line-leading
   * glyph that does not occur in prose, requiring a verb AND a live marker
   * (seconds timer or the esc-to-cancel suffix). A miss falls back to today's
   * behaviour; a false positive on a stable pane would pin `working`, so
   * narrow wins. Verify against a real pane when an agy instance next exists.
   */
  getBusyPattern(): RegExp {
    return /^[ \t]*[·✢✶✻✽][ \t]+\p{L}[^\n]*(?:…|\.\.\.)[^\n]*(?:\b\d+(?:\.\d+)?s\b|\(esc to cancel\))/mu;
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

  // `agy --help`: "--effort  Reasoning effort for the current CLI session
  // (low|medium|high)" — three levels only, so xhigh/max clamp to high, which
  // the caller reports rather than swallowing.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return "runtime"; }
  getEffortLevels(): string[] { return ["low", "medium", "high"]; }

  // agy's model switch is an interactive TUI change → restart to apply reliably.
  getModelSwitchStrategy(): "runtime" | "restart" { return "restart"; }

  async listModels(): Promise<import("./types.js").ModelOption[]> {
    // Verified current format is one model slug per line. Older releases emitted
    // display names such as "Gemini 3.5 Flash (Medium)", which must remain intact
    // because the effort suffix is part of the selectable model name.
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
      const s = JSON.parse(readFileSync(join(homedir(), ".gemini", "antigravity-cli", "settings.json"), "utf-8"));
      if (typeof s?.model === "string" && s.model.trim()) currentModel = s.model.trim();
    } catch { /* no settings / unreadable */ }
    return { version: probeCliVersion(this.binaryPath), models: await this.listModels(), currentModel };
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
      { pattern: /error.*authentication|UNAUTHENTICATED/i, type: "auth_error", action: "notify", message: "Antigravity authentication error — needs re-login" },
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
      { pattern: /Do you trust.*folder|Yes, I trust/i, keys: ["Enter"], description: "Trust folder prompt" },
    ];
  }

  getRuntimeDialogs(): StartupDialog[] {
    return [];
  }
}
