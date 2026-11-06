import { EFFORT_CAPABILITIES } from "./effort-metadata.js";
import { flagEffort } from "./launch-effort.js";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type InputBox, type RuntimeDialog, type StartupDialog, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";
import { selectionCard } from "../selection-card.js";
import { displayWidth } from "../ls-rows.js";
import { quotaLine, quotaPausedLine } from "../quota-notice.js";
import { clearGrokWeeklyReset, grokWeeklyResetDue, markGrokWeeklyTryAgainConsumed, noteGrokWeeklyLimitSeen, readGrokWeeklyReset } from "./grok-weekly-reset.js";

/** Session ids are UUIDs (e.g. "019f82d4-…"); guard before shell interpolation. */
const SESSION_ID_RE = /^[A-Za-z0-9-]+$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** The weekly-limit picker is a paid-action modal, not an error line to dismiss. */
/**
 * Grok Build's weekly-limit modal (#2872). Every option it offers is paid or useless while the limit lasts:
 *
 *   ┃  You hit your weekly limit.
 *   ┃  1 (○) Upgrade tier      Upgrade to a higher tier for more usage
 *   ┃  2 (○) Buy more credits  Purchase credits to keep using Grok Build
 *   ┃  3 (○) Try Again         Resubmit the last prompt once you have usage again      (1.0.70; absent on older builds)
 *   ┃  ↑/↓ navigate · y copy                                                Enter:submit
 *   Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss
 *
 * Before the recorded reset: Shift+x (`X`) closes it with nothing selected (1.0.70 audit; 1.0.77 after Esc needs Space
 * first). Never Enter, never a digit, never `y` — digit 3 does not move grok's highlight, and Enter on the default
 * (option 1, Upgrade) is a paid action. The modal leaves no error row, so the quota pause comes from dismissIncident.
 *
 * After the recorded reset: two Downs then Enter lands on Try Again. The list does not wrap (1.0.77 offline:
 * Down on option 3 stays on 3; Down×2 from option 2 is 2→3→3), so Down×2 from any start ends on option 3.
 * Daemon `capture-pane -p` has no reverse-video, so the cursor cannot be re-read; the sequence is the verified
 * start-independent path (fixtures `tests/fixtures/grok-1.0.77-weekly-reset/`). A failed Enter while still limited
 * re-shows the picker on option 1; the next scan Shift+x-pauses again.
 */
const GROK_LEGEND_QUESTION = /^Tab:next answer\s+│\s+Esc:scrollback\s+│\s+Shift\+x:dismiss$/;
const GROK_LEGEND_SCROLLBACK = /^Tab\/Space:question\s+│\s+Ctrl\+e:collapse thinking\s+│\s+Ctrl\+x:shortcuts$/;
/** One option row: its number and label exactly; its description whole, or cut by grok with "…" on a narrow pane (80 columns). */
function grokOption(n: number, label: string, description: string) {
  const row = new RegExp(`^${n} \\(○\\) ${label}(?:\\s{2,}(\\S.*))?$`);
  return (line: string): boolean => {
    const m = row.exec(line);
    if (!m) return false;
    const d = m[1];
    return d === undefined || d === description || (d.endsWith("…") && description.startsWith(d.slice(0, -1)));
  };
}
function grokWeeklyLimitActive(pane: string, legend: "question" | "scrollback" | "either", opts?: { tryAgain?: boolean }): boolean {
  const pattern = /You hit your weekly limit\./;
  pattern.lastIndex = 0;
  if (!pattern.test(pane)) return false;
  const lines = pane.split(/\r?\n/).map(line => line.trimEnd());
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return false;
  const footer = lines[end].trim();
  const wantQuestion = legend === "question" || legend === "either";
  const wantScrollback = legend === "scrollback" || legend === "either";
  if (!((wantQuestion && GROK_LEGEND_QUESTION.test(footer)) || (wantScrollback && GROK_LEGEND_SCROLLBACK.test(footer)))) return false;

  const text = (line: string) => line.replace(/^\s*┃\s?/, "").trim();
  const first = Math.max(0, end - 14);
  const current = lines.slice(first, end + 1);
  const find = (predicate: (line: string) => boolean, from = 0) => {
    for (let i = from; i < current.length; i++) if (predicate(text(current[i]))) return i;
    return -1;
  };
  const title = find(line => line === "You hit your weekly limit.");
  const submit = find(line => /^↑\/↓ navigate · y copy\s+Enter:submit$/.test(line), title + 1);
  if (title < 0 || submit < 0) return false;
  // The WHOLE option list between the title and the footer, in order: exactly 1 Upgrade, 2 Credits and optionally
  // 3 Try Again. Any other numbered row anywhere (a new paid choice, a duplicate) makes it a modal we do not know.
  const options = current.slice(title + 1, submit).map((line, i) => ({ i: title + 1 + i, t: text(line) })).filter(r => /^\d+ \(/.test(r.t));
  const known = [grokOption(1, "Upgrade tier", "Upgrade to a higher tier for more usage"),
    grokOption(2, "Buy more credits", "Purchase credits to keep using Grok Build"),
    grokOption(3, "Try Again", "Resubmit the last prompt once you have usage again")];
  if (options.length < 2 || options.length > 3 || !options.every((r, k) => known[k](r.t))) return false;
  if (opts?.tryAgain && options.length !== 3) return false;
  const upgrade = options[0].i, credits = options[1].i;
  if (![title, upgrade, credits, submit].every(index => /^\s*┃/.test(current[index]))) return false;
  // The Grok keyboard legend must immediately follow the choice footer;
  // another composer or screen below the modal makes the old text stale.
  const between = current.slice(submit + 1).map(text).filter(Boolean);
  if (between.length !== 1) return false;
  if (legend === "question") return GROK_LEGEND_QUESTION.test(between[0]!);
  if (legend === "scrollback") return GROK_LEGEND_SCROLLBACK.test(between[0]!);
  return GROK_LEGEND_QUESTION.test(between[0]!) || GROK_LEGEND_SCROLLBACK.test(between[0]!);
}

type GrokTryAgainGate = { value: boolean; claimFailed: boolean };

function grokWeeklyLimitDialog(instanceDir: string, pending: GrokTryAgainGate): RuntimeDialog {
  const pattern = /You hit your weekly limit\./;
  return {
    pattern,
    keys: ["X"],
    literalKeys: true,
    description: "Grok Build weekly limit (Grok 週限) — Shift+x dismisses it, never an upgrade or credits",
    blocksDelivery: true,
    inputBlocked: true,
    verifyAfterKeys: true,
    autoResolutionKey: "grok-weekly-limit",
    answeredByAgend: true,
    // The user's wording (hmsg-0687db4d): one line, no name, no action suffix.
    dismissIncident: { type: "quota", action: "pause", message: "Grok weekly limit used up — paused", notice: quotaPausedLine("Grok", "weekly") },
    isActive: pane => grokWeeklyLimitActive(pane, "question"),
    answerDetail: () => {
      // The daemon has one autoResolvedDialogKey: this X claim replaces Try Again's. Drop the
      // in-flight pending flag so a later poll cannot send Down×2+Enter again on this episode.
      pending.value = false;
      noteGrokWeeklyLimitSeen(instanceDir);
      return null;
    },
  };
}

/**
 * After the recorded reset: Down×2 then Enter on Try Again.
 * Unique autoResolutionKey so a still-limited re-show falls through to Shift+x on the next scan.
 *
 * The list does not wrap (1.0.77 offline: Down on option 3 stays on 3, `down3.esc.txt`; Down×2 from option 2 is
 * 2→3→3, `from2-downx2.esc.txt`). Down×2 from any start therefore ends on Try Again (1→3, 2→3 clamped, 3→3), so
 * the sequence is start-independent. Daemon `capture-pane -p` has no SGR 7. A non-default start is reachable
 * (View/terminal arrows before the reset; a mid-sequence abort after one Down; a later auto-resolved dialog
 * overwriting the one-slot runtime claim so Try Again can run again in that spawn).
 *
 * Try Again is consumed on the reset file (`tryAgainConsumed`) independently of that one-slot claim, so an
 * ignored Shift+x cannot re-arm Enter against the same still-limited screen. Re-arm only for a new pause
 * episode (Shift+x after a consumed Try Again rewrites the clock). If that durable write fails, fail closed:
 * do not send Enter (claimFailed); Shift+x still matches.
 *
 * isActive has a side effect: when the modal is gone and pending is set it clears the reset file. The daemon
 * calls isActive from every probe and scan. A future "pure matcher" refactor must keep that clear — alpha
 * re-reads the pane before each key, so the clock cannot be dropped in answerDetail.
 */
function grokWeeklyLimitTryAgainDialog(instanceDir: string, pending: GrokTryAgainGate): RuntimeDialog {
  const pattern = /You hit your weekly limit\./;
  // Same array the daemon iterates after answerDetail. Main does not rematch before the first
  // key; emptying it on a failed durable claim is the fail-closed gate before Enter.
  const keys = ["Down", "Down", "Enter"];
  return {
    pattern,
    keys,
    description: "Grok Build weekly-limit reset (Grok 週限) — Try Again after the recorded reset",
    blocksDelivery: true,
    inputBlocked: true,
    verifyAfterKeys: true,
    autoResolutionKey: "grok-weekly-limit-try-again",
    answeredByAgend: true,
    // Stay matched through the Down×2+Enter sequence: answerDetail runs before the keys, and alpha re-reads the
    // pane before each key. Clearing the clock there made isActive false and sent nothing. Drop the clock once
    // the modal is gone (success, or the next Shift+x will write a fresh one). After the sequence, consumed
    // on the reset file keeps isActive false even if pending was cleared by the X fallback.
    isActive: pane => {
      const modal = grokWeeklyLimitActive(pane, "question", { tryAgain: true });
      if (!modal) {
        if (pending.value) {
          pending.value = false;
          clearGrokWeeklyReset(instanceDir);
        }
        pending.claimFailed = false;
        return false;
      }
      if (pending.value) return true;
      if (pending.claimFailed) return false;
      const rec = readGrokWeeklyReset(instanceDir);
      return rec !== null && Date.now() >= rec.resetAt && rec.tryAgainConsumed !== true;
    },
    answerDetail: () => {
      if (!markGrokWeeklyTryAgainConsumed(instanceDir)) {
        pending.claimFailed = true;
        pending.value = false;
        keys.length = 0;
        return { tryAgainConsumed: false };
      }
      pending.value = true;
      pending.claimFailed = false;
      return { tryAgainConsumed: true };
    },
  };
}

/** 1.0.77: Esc:scrollback unbinds Shift+x; Space (the legend's Tab/Space:question) restores the picker. */
function grokWeeklyLimitScrollbackDialog(): RuntimeDialog {
  const pattern = /You hit your weekly limit\./;
  return {
    pattern,
    keys: [" "],
    literalKeys: true,
    description: "Grok Build weekly limit scrollback (Grok 週限) — Space returns to the picker so Shift+x can dismiss",
    blocksDelivery: true,
    inputBlocked: true,
    verifyAfterKeys: true,
    autoResolutionKey: "grok-weekly-limit-scrollback",
    answeredByAgend: true,
    isActive: pane => grokWeeklyLimitActive(pane, "scrollback"),
  };
}

/** Parse the text format emitted by `grok models`. */
export function parseGrokModelsOutput(output: string): import("./types.js").ModelOption[] {
  const models: import("./types.js").ModelOption[] = [];
  const seen = new Set<string>();
  let inModelList = false;

  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^Available models:\s*$/i.test(trimmed)) {
      inModelList = true;
      continue;
    }
    if (!inModelList || !trimmed) continue;

    const id = trimmed
      .replace(/^(?:[*•-]|\d+\.)\s*/, "")
      .replace(/\s+\(default\)\s*$/i, "")
      .trim();
    if (!MODEL_ID_RE.test(id) || !/^grok/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

/** Rows Grok paints under the live box: the keyboard legend, a version/login line. */
const GROK_BOX_FOOTER_MAX_ROWS = 4;
/** Rows a box may hold before the reader stops believing it is one. */
const GROK_BOX_MAX_ROWS = 40;

/**
 * #3199: Grok Build's live input box, read as a region — the same kind of evidence
 * Claude Code's `readClaudeInputBox` (#1200) gives the daemon.
 *
 * The live box is a bottom-anchored `╭─…╮` / `│ ❯ … │` / `╰─…╯` triple whose
 * corners line up. Transcript echoes (`     ❯ <text>  <time>` above the box) are
 * never input. Trust, weekly-limit and approval cards use `┃` or no frame, so
 * they return null: `finishHumanReceipt` still refuses output-edge / unverified
 * proof, and forwards still require `delivered`.
 *
 * Captured from grok 1.0.52–1.0.70 audit panes (`tests/fixtures/grok-1.0.*-audit`)
 * and the watcher fixtures. A live draft is `06-after-cancel` (`│ ❯ stall forever b`).
 *
 * Borders are located by terminal column (`displayWidth`: CJK 2, combining `\p{M}` 0,
 * box-drawing 1). UTF-16 indexes are not columns: a CJK inner shifts the closer
 * left in the string, and a combining inner can put an extra `│` at the top `╮`'s
 * UTF-16 offset while the real closer (and an unsent id) sit further right.
 */
export function readGrokInputBox(pane: string): InputBox | null {
  const rows = pane.replace(/\r/g, "").split("\n").map(row => row.trimEnd());
  let bottom = -1;
  for (let i = rows.length - 1, footer = 0; i >= 0; i--) {
    const row = rows[i]!;
    const left = row.indexOf("╰");
    const right = row.lastIndexOf("╯");
    if (left >= 0 && right > left) { bottom = i; break; }
    if (row.trim() !== "" && ++footer > GROK_BOX_FOOTER_MAX_ROWS) return null;
  }
  if (bottom < 1) return null;
  const leftIdx = rows[bottom]!.indexOf("╰");
  if (leftIdx < 0) return null;
  const leftCol = displayWidth(rows[bottom]!.slice(0, leftIdx));

  let top = -1;
  for (let i = bottom - 1; i >= 0 && bottom - i <= GROK_BOX_MAX_ROWS + 1; i--) {
    const row = rows[i]!;
    const atLeft = indexAtDisplayCol(row, leftCol);
    if (atLeft >= 0 && row[atLeft] === "╭" && row.lastIndexOf("╮") > atLeft) { top = i; break; }
    if (atLeft < 0 || row[atLeft] !== "│") return null;
  }
  if (top < 0 || bottom - top < 2) return null;
  // Inner `│` and the top `╮` line up in terminal columns. The bottom `╯` may sit
  // further right: a long model label (`Grok 4.5 (high) · always-approve`) grows
  // that row past the top rule (tests/fixtures/grok-watcher-idle.pane.txt).
  const rightIdx = rows[top]!.lastIndexOf("╮");
  const rightCol = displayWidth(rows[top]!.slice(0, rightIdx));
  const bottomRightCol = displayWidth(rows[bottom]!.slice(0, rows[bottom]!.lastIndexOf("╯")));
  if (rightCol <= leftCol || bottomRightCol < rightCol) return null;
  if (!frameAt(rows[top]!, leftCol, rightCol, "╭", "╮")) return null;

  const lines: string[] = [];
  for (let i = top + 1; i < bottom; i++) {
    const sides = frameAt(rows[i]!, leftCol, rightCol, "│", "│");
    if (!sides) return null;
    const content = rows[i]!.slice(sides.left + 1, sides.right);
    if (lines.length === 0) {
      const prompt = /^ ❯ ?(.*)$/.exec(content);
      if (!prompt) return null;
      lines.push(prompt[1]!.trimEnd());
    } else {
      if (!content.startsWith(" ")) return null;
      lines.push(content.slice(1).trimEnd());
    }
  }
  if (lines.length === 0) return null;
  return { text: lines.join("\n").trimEnd(), collapsedPastes: 0 };
}

/** UTF-16 index of the first positive-width character whose display column starts at `col`. */
function indexAtDisplayCol(s: string, col: number): number {
  let display = 0;
  let i = 0;
  for (const ch of s) {
    const w = displayWidth(ch);
    if (w > 0) {
      if (display === col) return i;
      if (display > col) return -1;
      display += w;
    }
    i += ch.length;
  }
  return -1;
}

/** Cell-aligned `leftCh`/`rightCh` at `leftCol`/`rightCol`; leftover outside the frame is not a box. */
function frameAt(
  row: string,
  leftCol: number,
  rightCol: number,
  leftCh: string,
  rightCh: string,
): { left: number; right: number } | null {
  const left = indexAtDisplayCol(row, leftCol);
  const right = indexAtDisplayCol(row, rightCol);
  if (left < 0 || right <= left) return null;
  if (row[left] !== leftCh || row[right] !== rightCh) return null;
  if (row.slice(0, left).trim() !== "" || row.slice(right + 1).trim() !== "") return null;
  return { left, right };
}

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
 * tuning.
 */
export class GrokBackend implements CliBackend {
  readonly binaryName = "grok";
  private binaryPath: string;
  // Cached from buildCommand/writeConfig so getSessionId() (which takes no args)
  // can scope to grok's per-cwd session directory.
  private workingDirectory?: string;
  /** Try-again keys are in flight: keep matching until the modal leaves (see grokWeeklyLimitTryAgainDialog). */
  private readonly grokWeeklyTryAgainPending: GrokTryAgainGate = { value: false, claimFailed: false };

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("grok");
  }

  /** #1811: what the last launch left out and why — the Log tab and daemon.log, never a channel. */
  private quietLaunchNotes: string[] = [];
  consumeQuietLaunchNotes(): string[] { const notes = this.quietLaunchNotes; this.quietLaunchNotes = []; return notes; }

  private launchResumes = false;
  resumesPreservedQuotaHistory(): boolean { return this.launchResumes; }

  buildCommand(config: CliBackendConfig): string {
    this.launchResumes = false;
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
      if (sid) { cmd += ` --resume ${sid}`; this.launchResumes = true; }
    }
    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("grok", model);
      cmd += ` --model ${shellQuote(model)}`;
    }
    // #1811: the configured effort, where this grok takes it (launch-effort.ts); else a quiet note.
    const effort = flagEffort("grok", config.effort, this.binaryPath);
    if (effort.arg) cmd += effort.arg;
    this.quietLaunchNotes = effort.note ? [effort.note] : [];
    return cmd;
  }

  /**
   * Build an ASCII-only, per-instance MCP server key. Grok Build's MCP client has
   * a bug where a non-ASCII (e.g. CJK) server name connects but drops ALL tools
   * (tool_count=0, misreported as "connection failed"). Instance names can be CJK
   * (persona ClassicBot channels), so sanitize: pure-ASCII names pass through
   * unchanged (readable + already unique); names with non-ASCII are stripped to an
   * ASCII slug plus a short hash of the ORIGINAL name, so two distinct CJK names
   * sharing a working directory can't collide to the same key.
   */
  private mcpKey(mcpName: string, instanceName: string): string {
    const ascii = instanceName.replace(/[^\x20-\x7E]/g, "");
    if (ascii === instanceName) return `${mcpName}-${instanceName}`;
    const slug = ascii.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const hash = createHash("md5").update(instanceName).digest("hex").slice(0, 8);
    return slug ? `${mcpName}-${slug}-${hash}` : `${mcpName}-${hash}`;
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
    // Drop stale agend entries whose wrapper script no longer exists, plus any
    // legacy non-ASCII key (grok drops all tools on a CJK key — we now always
    // write ASCII keys, so a lingering CJK entry is dead weight to remove).
    for (const [key, val] of Object.entries(servers)) {
      if (key.startsWith("agend-")) {
        const cmd = (val as Record<string, unknown>)?.command;
        if ((typeof cmd === "string" && !existsSync(cmd)) || /[^\x20-\x7E]/.test(key)) {
          delete servers[key];
        }
      }
    }
    // Namespace each server by instance so multiple instances can share a working
    // dir. Key is ASCII-sanitized (grok's MCP client drops tools on a CJK key).
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = this.mcpKey(name, config.instanceName);
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
        `#!/bin/bash\n${envExports}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${[entry.command, ...entry.args].map(shellQuote).join(" ")}\n`,
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

  /** Numbered multi-line input shares the menu cursor glyph; require the actual bottom composer box and footer. */
  isDeliveryComposerPane(pane: string): boolean {
    const rows = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").split("\n").map(row => row.trimEnd());
    const trim = () => { while (rows.length && !rows.at(-1)!.trim()) rows.pop(); };
    trim();
    const footer = rows.pop() ?? "";
    if (!/^\s*(?:Logged in\b.*|Shift\+Tab:mode\s*│\s*Ctrl\+x:shortcuts)\s*$/.test(footer)) return false;
    trim();
    if (!/^\s*╰─{10,}.*╯$/.test(rows.pop() ?? "")) return false;
    const input: string[] = [];
    while (/^\s*│.*│$/.test(rows.at(-1) ?? "")) input.unshift(rows.pop()!);
    if (!/^\s*╭─{10,}╮$/.test(rows.pop() ?? "")) return false;
    // The highlighted numbered row itself must be in the composer, never a card above an empty input box.
    return input.length > 0 && /^\s*│\s*❯(?:\s|│)/.test(input[0]!)
      && (!selectionCard(pane, "Grok") || /^\s*│\s*❯\s*\d{1,2}[.)]\s+\S/.test(input[0]!));
  }

  getReadyPattern(): RegExp {
    // Verified: `❯` is the idle input prompt inside the TUI box; the Grok Build
    // header ("Grok Build" / "Grok <n>") also identifies the ready screen.
    // NOTE: the animated intro logo is pure braille/ANSI with no these markers —
    // do not broaden this to match the splash or idle detection never settles.
    return /❯|Grok \d|Grok Build/m;
  }

  /**
   * The live spinner line, which is on screen only while grok is working.
   *
   * Needed for the same reason claude-code needed one: the TUI keeps its input box
   * (and therefore `❯`) on screen the whole time it works, so the ready pattern is
   * effectively constant-true and `stuck` is unreachable — no hang notification,
   * and a frozen CLI reported as idle, which clears pending work.
   *
   * Measured rather than assumed. I triggered a read-only task on a live grok
   * instance and sampled its pane every second for 90s: 27 distinct frames, and the
   * ready pattern matched **every** working frame. The spinner separates them
   * cleanly — frames 1-25 (working) match this, frames 0 and 26 (before and after)
   * do not. Captured shapes:
   *
   *   ⠹ Waiting for response… 5s        …  ⇣2k [stop]
   *   ⠼ Thinking… 3.0s                  …  ⇣2k [stop]
   *
   * Anchored on the braille spinner glyph, which does not occur in agent prose. The
   * cost is asymmetric — a false positive on a *stable* pane would pin the instance
   * in `working` forever — so `◆ Thought for 1.8s` (past tense, no ellipsis) and
   * `I waited… 30s for the build` are both rejected.
   */
  getBusyPattern(): RegExp {
    // The turn-status spinner line always ends with [stop] (and sometimes [↓][stop]).
    // Confirmed from all fixtures in grok-1.0.52-audit/ and grok-1.0.60-audit/:
    //   ⠴ Waiting for response… 3.0s         3.0s ⇣1.33k [stop]
    //   ⠦ Compacting…                          4.9s ⇣1.20k [stop]
    //   ⠹ Server error (500) | Retrying…       7.0s ⇣1.45k [stop]
    //   ⠼ Run Read `/…/install-sh…`… 0.1s     3m19s ⇣24.4k [↓][stop]
    //
    // The Watchers panel uses braille glyphs too, but its lines do NOT end with [stop]:
    //   ⠴ Monitor Watch PR 2315 merge…        45.2s        ← no [stop]
    //   ⠸ Waiting for PR 2315 merge…          2h01m        ← no [stop]
    //
    // Using [stop] as the discriminator is more robust than a verb whitelist:
    // it works for any present or future Grok status verb (including tool names
    // like "Run", "Read", "Write" that start with common English words that could
    // also appear in watcher titles).
    return /^[ \t]*[\u2800-\u28FF]\s+\S[^\n]*…[^\n]*\[stop\]/mu;
  }

  /**
   * #3199: the live input box, read structurally (`readGrokInputBox`). Same role as
   * Claude Code's `readInputRow` (#1200): a unique-id echo is only a human-receipt
   * proof when this reader can still see the boxed `❯`. Dialogs have no box.
   */
  readInputRow(pane: string): InputBox | null {
    return readGrokInputBox(pane);
  }

  getErrorPatterns(): ErrorPattern[] {
    // NOTE: "Turn cancelled by user" is NORMAL behaviour (user interrupt), not an
    // error — none of the patterns below match it, and none should be added that do.
    //
    // Real Grok error line format (fixtures in tests/fixtures/grok-1.0.60-audit/):
    //   All errors appear on lines prefixed with ┃ (U+2503), the Grok box border.
    //
    //   429:  ┃  Retry failed: rate_limit_error: Rate limit exceeded
    //         ┃  Retry failed: rate_limit_error: rate limit exceeded; too many requests
    //
    //   401:  ┃  Authentication required: … (no status code on screen — intentionally
    //         NOT pattern-matched here; auth is verified via grok models as a second
    //         opinion, LOGIN_FLOWS.grok.authCheck. See tests/grok-1.0.52-audit.test.ts
    //         "grok auth" describe block. #1792 follow-up.)
    //
    //   402/quota: handled by the weekly-limit dialog (WEEKLY), not a pattern here.
    //   403-usage: "Request denied (403): usage limit reached" — intentionally idle
    //              per audit (#1792 follow-up).
    //
    // Only rate_limit is anchored on ┃; auth and quota use the original broader
    // patterns because the audit pinned them as not-error (idle) and the agent
    // auth flow uses a second-opinion check rather than a bare pattern match.
    return [
      {
        // 429: two confirmed formats (fixtures in tests/fixtures/grok-1.0.60-audit/):
        //   1.0.60: "┃  Retry failed: rate_limit_error: …"
        //   1.0.52: "┃  Retry failed: Some resource has been exhausted: Your team has exceeded
        //            ┃  its rate limit. Please try again later."  (wraps at 80col)
        //
        // Require the specific known payload — either `rate_limit_error:` on the Retry
        // line, or the exhausted-resource sentence (which may wrap to a ┃ continuation).
        // This prevents matching unrelated ┃ Retry blocks followed by ┃ lines that merely
        // contain the word "rate_limit" (e.g. a function call like scan_rate_limit()).
        // Consume one required continuation separator; the rest of that line already allows whitespace.
        // Repeating two overlapping whitespace consumers here makes crafted pane text backtrack exponentially.
        pattern: /^[ \t]*┃[ \t]+Retry failed:[ \t]+(?:rate_limit_error:|Some resource has been exhausted:[^\n]*(?:\n[ \t]*┃[ \t][^\n]*)*?rate limit)/im,
        type: "rate_limit",
        action: "failover",
        message: "Grok rate limit reached",
      },
      // 401: intentionally broad backstop; the primary gate is LOGIN_FLOWS.grok.authCheck.
      // The 1.0.52 audit pinned this screen as idle (no auth error raised), so this
      // pattern fires only if future CLI versions show a status code (#1792 follow-up).
      { pattern: /unauthorized|authentication (failed|error)|\b401\b/i, type: "auth_error", action: "pause", message: "Grok authentication error" },
      // quota: the weekly-limit dialog handles the modal; this is a backstop for any
      // plain-text quota message the dialog doesn't catch. The 403-usage form is idle
      // per the audit (#1792 follow-up).
      { pattern: /quota|insufficient credits|out of credits/i, type: "quota", action: "notify", message: "Grok quota/credits exhausted", notice: () => quotaLine("Grok", "quota_credits") },
      // #1066: the server refuses an outdated CLI (HTTP 426, Upgrade Required):
      //   Request failed (426) — Your Grok CLI version (1.0.5) is outdated.
      //   Please update to version 1.0.13 or later via `grok update` or …
      // Neither failover nor a pause helps: only `grok update` does, so tell
      // the operator what to run, on every occurrence (each refused request).
      // Anchored on the server's own wording, spaced to survive a pane wrap —
      // not a bare `426`, which a diff's line numbers or prose also contain.
      {
        pattern: /Your\s+Grok\s+CLI\s+version\s+\(\s*v?(\d+(?:\.\d+)+)\s*\)\s+is\s+outdated\b(?:[\s\S]{0,160}?update\s+to\s+version\s+v?(\d+(?:\.\d+)+))?|Request\s+failed\s+\(426\)/i,
        type: "outdated_cli",
        action: "notify",
        skipCooldown: true,
        message: "Grok CLI is outdated — run `grok update`",
        formatMessage: (m) => {
          const [, current, required] = m;
          return `Grok CLI is outdated${current ? ` (${current})` : ""} — run \`grok update\``
            + (required ? ` (needs ${required} or later)` : "");
        },
      },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    const dir = this.instanceDir;
    return [
      // After the recorded reset: Try Again (question) or Space (scrollback) first so the ready pattern cannot
      // mistake "Grok Build" in the credits row for a composer. Hold is the fallback (before the reset, and if
      // Try Again is already claimed this launch). Never a paid option from startup.
      grokWeeklyLimitTryAgainDialog(dir, this.grokWeeklyTryAgainPending),
      { ...grokWeeklyLimitScrollbackDialog(),
        isActive: pane => grokWeeklyLimitActive(pane, "scrollback") && grokWeeklyResetDue(dir) },
      { ...grokWeeklyLimitDialog(dir, this.grokWeeklyTryAgainPending), keys: [], holdOnly: true, verifyAfterKeys: false, answeredByAgend: false, dismissIncident: undefined, literalKeys: undefined,
        isActive: pane => grokWeeklyLimitActive(pane, "either"),
        heldReason: () => { noteGrokWeeklyLimitSeen(dir); return null; } },
      // Animated intro logo (spinning braille X). It redraws continuously, so
      // AgEnD's idle detector (2s of silence) never fires and messages queue
      // forever. User-confirmed fix: one Enter skips to the ready prompt.
      // Negative lookahead for ❯ so we don't re-submit on the post-logo welcome
      // screen, which still shows the same braille art above the input box.
      {
        pattern: /⣠⣾⠿(?![\s\S]*❯)/,
        keys: ["Enter"],
        description: "Grok intro logo — skip to prompt",
      },
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
    const dir = this.instanceDir;
    return [
      // Same intro-logo skip as startup: if a respawn/crash leaves the pane on the
      // spinning splash, the 5s error-monitor cycle dismisses it without waiting
      // for the next full start sequence.
      {
        pattern: /⣠⣾⠿(?![\s\S]*❯)/,
        keys: ["Enter"],
        description: "Grok intro logo — skip to prompt",
      },
      // After the recorded reset, Try Again first (unique autoResolutionKey). Shift+x still matches so a
      // still-limited re-show pauses again. Before the reset, only Shift+x — never a paid option.
      grokWeeklyLimitTryAgainDialog(dir, this.grokWeeklyTryAgainPending),
      grokWeeklyLimitDialog(dir, this.grokWeeklyTryAgainPending),
      grokWeeklyLimitScrollbackDialog(),
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
  // #1792: Quit is a double press within 1000 ms (grok's own keyboard docs since
  // at least 1.0.46; live on 1.0.50 and 1.0.52). One Ctrl+Q only paints
  // "Ctrl+q:press again to quit", so every stop and pause fell through to the
  // SIGTERM fallback. The daemon spaces the presses 250 ms apart.
  getQuitKeyPresses(): number { return 2; }

  // Trailing space commits the exact slash command before Grok's autocomplete
  // can expand the partial token to `/compact-mode`.
  getCompactCommand(): string { return "/compact "; }
  getClearCommand(): string { return "/new"; }

  // Verified: grok interrupts generation on Ctrl+C.
  getCancelKey(): string { return "C-c"; }

  // `--reasoning-effort` (alias `--effort`) plus a `/effort` TUI command —
  // verified from `grok --help` and the binary's command table on 2026-08-02.
  // The help does not enumerate values, so only the canonical three are offered;
  // grok rejects an unknown level itself rather than us guessing a wider set.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return EFFORT_CAPABILITIES["grok"].strategy; }
  getEffortLevels(): string[] { return [...EFFORT_CAPABILITIES["grok"].levels]; }

  // grok's in-session model switch is a picker → restart to apply reliably.
  getModelSwitchStrategy(): "runtime" | "restart" { return "restart"; }

  async listModels(): Promise<import("./types.js").ModelOption[]> {
    // Verified format:
    //   Available models:
    //     * grok-4.5 (default)
    try {
      const out = execFileSync(this.binaryPath, ["models"],
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const models = parseGrokModelsOutput(out);
      if (models.length) return models;
    } catch { /* fall back to documented set */ }
    return [
      { id: "grok-4.5", label: "grok-4.5" },
    ];
  }

  async probeCLIEnv() {
    const { probeCliVersion } = await import("./types.js");
    // `grok models` prints "Default model: grok-4.5" above the list (verified).
    let currentModel: string | undefined;
    try {
      const out = execFileSync(this.binaryPath, ["models"],
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      currentModel = out.match(/Default model:\s*(\S+)/i)?.[1];
    } catch { /* best effort */ }
    return { version: probeCliVersion(this.binaryPath), models: await this.listModels(), currentModel };
  }

  cleanup(config: CliBackendConfig): void {
    // Remove only this instance's namespaced MCP entries — a non-namespaced key
    // may belong to another instance sharing the working directory.
    try {
      const mcpPath = join(config.workingDirectory, ".mcp.json");
      if (existsSync(mcpPath)) {
        const root = JSON.parse(readFileSync(mcpPath, "utf-8"));
        if (root.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete root.mcpServers[this.mcpKey(name, config.instanceName)];
            // Also drop any legacy raw (pre-sanitize) key for this instance.
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
