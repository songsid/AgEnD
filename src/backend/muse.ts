import { EFFORT_CAPABILITIES } from "./effort-metadata.js";
import { join, resolve } from "node:path";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, chmodSync, lstatSync, readlinkSync, symlinkSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type InputDraft, type ModelOption, type RuntimeDialog, type StartupDialog, resolveBinary, shellQuote, validateModel, warnIfModelMismatch } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

/** Session ids are UUIDs (e.g. "01a0c784-fb91-…"); guard before shell interpolation. */
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,}$/;

/**
 * Enough of a session log to reach the `route_facts` record that names the
 * working directory. Measured on a live session: `"cwd"` landed at byte 3899 of
 * a 450KB log, at sequence 4. 65,536 decoded characters is ~16x that headroom
 * and keeps the scan cheap even with dozens of sessions on disk.
 */
const SESSION_HEAD_CHARS = 65_536;

/** Read the workspace a session was started in, without reading the whole log. */
export function museSessionCwd(head: string): string | null {
  return head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, "$1") ?? null;
}

/**
 * Bounded head read: the first `maxChars` UTF-16 code units of a file,
 * decoded as UTF-8, without reading the whole file (#1228: session logs grow
 * past hundreds of KB while discovery only needs the `route_facts` head).
 * The bound is decoded characters, not bytes — exactly what the old
 * readFileSync-then-slice produced, so a log whose head is mostly multibyte
 * text stays discoverable. Bytes are pulled in 64KB chunks and decoded with a
 * streaming decoder (a character split across a chunk boundary still decodes
 * intact); the byte budget is bounded by ~64KB per 16K ASCII chars and at most
 * ~320KB for a head of pure 4-byte characters. Returns null when the file
 * cannot be opened or read. Synchronous blocking I/O like the other store
 * readers — never on the fleet event loop.
 */
export function readFileHeadSync(filePath: string, maxChars: number): string | null {
  if (!(maxChars >= 1)) return "";
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    // ignoreBOM: the old Buffer.toString kept a leading U+FEFF, so the
    // equivalence with full-read-then-slice holds for BOM files too (#1281).
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const chunk = Buffer.alloc(65_536);
    let head = "";
    for (;;) {
      if (head.length >= maxChars) break;
      let nread: number;
      try {
        nread = readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        return null;
      }
      if (nread <= 0) {
        head += decoder.decode(); // EOF: flush any buffered partial character
        break;
      }
      head += decoder.decode(chunk.subarray(0, nread), { stream: true });
    }
    return head.slice(0, maxChars);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

const MUSE_SEPARATOR = /^─{10,}\s*$/;
/**
 * The status bar's own grammar, not merely "some indented text": the model id
 * first, then at least one more ` · `-joined field
 * (`  muse-spark-1.3-contributor · high · ~/cwd · Launch overrides`). A chooser
 * drawn under the box (`  1 Allow`) or any other indented row cannot pass for it.
 */
const MUSE_STATUS_BAR = /^\s{1,4}[^\s·]+(?:\s+·\s+[^·\s][^·]*)+$/;
/**
 * Menu chrome muse draws for its dialogs and pickers. The picker chrome is muse
 * 1.4.0's list component, captured live on its login menu (2026-09-28):
 *   Log in with browser · Enter to choose     (the selected row)
 *   Set an API key
 *   ↓↑ to select · Esc to quit                (the hint row)
 */
const MUSE_DIALOG_CHROME = /Allow this (?:tool|command)|Approve this (?:tool|command)|^\s*[>❯]?\s*1\s+(?:Allow|Approve|Trust)\b|Use Up\/Down|Esc (?:quits|to cancel)|↓↑ to select|·\s*Enter to choose\b/i;
/** The status bar is one row; a long cwd in a narrow pane wraps it onto a few more. */
const MUSE_MAX_STATUS_ROWS = 4;
/** The working line's timer: `◇ Thinking (2s · esc to interrupt)`. */
const MUSE_BUSY = /\(\s*(?:\d+(?:\.\d+)?[hms]\s*)+·\s*esc to interrupt\s*\)/;
const MUSE_MAX_INPUT_ROWS = 200;

/**
 * True when every row after the bottom separator is muse's status bar: its
 * first row in the bar's grammar, the rest a wrapped continuation of it. A
 * picker, a dialog, a busy line or a second separator there means the box above
 * is not the live input (#829 review: a chooser under an old box).
 */
function museStatusFooter(rows: readonly string[], bottomSeparator: number, busy: RegExp): boolean {
  const status = rows.slice(bottomSeparator + 1);
  if (status.length === 0 || !MUSE_STATUS_BAR.test(status[0])) return false;
  if (!status.every(row => /^\s+\S/.test(row) && !MUSE_SEPARATOR.test(row.trim()) && !busy.test(row) && !MUSE_DIALOG_CHROME.test(row))) return false;
  // A wrapped cwd continues as path text; a numbered option list or a
  // selection cursor under the bar is a picker, not the bar.
  return !status.slice(1).some(row => /^\s*[>❯›]?\s*\d+[.)]?\s+\S/.test(row) || /^\s*[>›]/.test(row));
}

/**
 * The rows of muse's live input box, or null when the bottom of the pane is not
 * muse's layout (#829). The box is the LAST thing above the status bar:
 *
 *   ─────────────────────────────            separator
 *   ❯ [user:… ] first row of the text        `❯ ` then the text
 *     second row                             continuation rows, two-space indent
 *   ─────────────────────────────            separator
 *     model · effort · cwd · …               status bar (a long cwd may wrap)
 *
 * Captured live on muse 1.4.2 (tests/fixtures/muse-input-829/). A `❯` row above
 * an echoed turn in the transcript is never read: the box must end at the
 * separator directly above the status bar.
 */
export function museInputBox(pane: string, busy: RegExp = MUSE_BUSY): InputDraft | null {
  const rows = pane.replace(/\r/g, "").split("\n");
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  let bottom = -1;
  for (let i = rows.length - 2; i >= Math.max(0, rows.length - 1 - MUSE_MAX_STATUS_ROWS); i--) {
    if (MUSE_SEPARATOR.test(rows[i])) { bottom = i; break; }
  }
  if (bottom < 2 || !museStatusFooter(rows, bottom, busy)) return null;
  for (let top = bottom - 1, n = 0; top >= 1 && n < MUSE_MAX_INPUT_ROWS; top--, n++) {
    const row = rows[top];
    if (MUSE_SEPARATOR.test(row)) return null;
    if (/^❯(?:\s|$)/.test(row)) {
      if (!MUSE_SEPARATOR.test(rows[top - 1])) return null;
      const box = rows.slice(top, bottom);
      if (!box.slice(1).every(r => r === "" || /^ {2}/.test(r))) return null;
      // Only the ASCII spaces muse pads rows with are dropped; any other
      // character on screen, Unicode spaces included, is part of the draft.
      const text = [box[0].replace(/^❯ ?/, "").replace(/ +$/, ""), ...box.slice(1).map(r => r.slice(2).replace(/ +$/, ""))];
      // The separators span the pane: that is the width the box was wrapped to.
      const width = rows[bottom].trimEnd().length;
      return { rows: text.every(r => r === "") ? [] : text, width };
    }
  }
  return null;
}

/**
 * True only when `rows` are exactly how muse 1.4.2 draws `text` in a box
 * `width` columns wide (#829 review). Captured live at 80 columns
 * (tests/fixtures/muse-input-829/wrap-*):
 *  - a hard newline starts a new row; an empty line is an empty row;
 *  - a line too long for the row wraps at a space — every space at the break
 *    is dropped — when the next word does not fit in `width - 4` columns;
 *  - a word longer than that is cut at exactly `width - 3` columns;
 *  - trailing ASCII spaces are not drawn (any other trailing character is).
 * Whitespace is never compared loosely: `/tmp/foo bar` is not `/tmp/foobar`.
 * A wrap is only judged for printable ASCII, whose width is its length;
 * anything else must fit on one row as is. A collapsed `[Pasted Content N
 * chars]` hides its content, so it never matches.
 */
export function museDraftShows(rows: readonly string[], width: number, text: string): boolean {
  const full = width - 3;
  let i = 0;
  for (const line of text.replace(/\r/g, "").split("\n").map(l => l.replace(/ +$/, ""))) {
    let rest = line;
    for (;;) {
      const row = rows[i];
      if (row === undefined) return false;
      i++;
      if (rest === "") {
        if (row !== "") return false;
        break;
      }
      if (row === "" || !rest.startsWith(row)) return false;
      rest = rest.slice(row.length);
      if (rest === "") break;
      // The line continues on the next row: muse must have wrapped it here.
      if (!/^[\x20-\x7e]*$/.test(row + rest)) return false;
      const gap = /^ */.exec(rest)![0].length;
      if (gap > 0) {
        const word = rest.slice(gap).split(" ")[0];
        if (word === "" || row.length + gap + word.length <= full - 1) return false;
        rest = rest.slice(gap);
      } else if (row.length !== full) {
        return false;
      }
    }
  }
  return i === rows.length;
}

/**
 * muse's logged-out menu (1.4.3): the two choices, then the key hint, as the last rows of the pane, with any cursor
 * glyph allowed in front of a choice.
 */
export function museLoginScreenActive(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n").map(row => row.replace(/\s+$/, "")).filter(row => row.trim() !== "");
  if (rows.length < 3) return false;
  const [browser, apiKey, hint] = rows.slice(-3) as [string, string, string];
  const choice = (row: string, label: string) => new RegExp(`^[ \\t]*(?:[❯›>▸][ \\t]*)?${label}\\b`).test(row);
  return choice(browser, "Log in with browser") && choice(apiKey, "Set an API key") && /to select\b.*\bEsc to quit$/.test(hint);
}

/**
 * The logged-out menu as a dialog (#1328): 1.4.3 paints "Log in with browser · Enter to choose" / "Set an API key" /
 * "↓↑ to select · Esc to quit". The older login wording matches none of it, and the ready pattern (`Muse Code \d`)
 * matched the header, so a logged-out muse passed as ready. Held — a human has to log in — with deliveries blocked,
 * in the startup scan and at runtime; the parked-dialog report tells them. Bottom-anchored (museLoginScreenActive).
 */
const MUSE_LOGIN_MENU: RuntimeDialog = {
  pattern: /Log in with browser|Set an API key/,
  isActive: museLoginScreenActive,
  keys: [],
  holdOnly: true,
  blocksDelivery: true,
  inputBlocked: true,
  description: "Muse login menu — waiting for a human to log in (never answered)",
};

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
  /**
   * #1510: the reply-completion guard covers muse, its turn end read from the session log (run `started` /
   * `terminal`, recorded on 1.4.4 in tests/fixtures/reply-guard-1510): between a run and the run a mid-run message
   * starts, the pane shows one idle frame — the log does not.
   */
  readonly replyCompletionGuard = true;
  readonly turnEndFromTranscript = true;
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

  private mirrorSharedConfigEntries(sourceDir: string, isolatedDir: string, excluded: Set<string>): void {
    for (const name of readdirSync(sourceDir)) {
      if (excluded.has(name)) continue;
      const link = join(isolatedDir, name);
      try {
        lstatSync(link);
        continue; // Keep any per-instance file Muse already created.
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      symlinkSync(join(sourceDir, name), link);
    }
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
    // XDG_CONFIG_HOME also affects tools run by Muse. Mirror unrelated XDG and
    // Muse config entries, while owning only settings.json in this instance.
    this.mirrorSharedConfigEntries(this.sharedXdgConfigHome, isolatedXdgHome, new Set(["muse"]));
    this.mirrorSharedConfigEntries(sharedMuseDir, isolatedMuseDir, new Set(["settings.json", "auth.json", ".auth.json.lock"]));
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
        `#!/bin/bash\n${envExports}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${[entry.command, ...entry.args].map(shellQuote).join(" ")}\n`,
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
   *   ◈ Calling tools (1m 31s · esc to interrupt)
   *
   * The timer grows units: past a minute it reads `1m 31s` (#1045). Matching
   * seconds only let every turn longer than a minute read as not busy — 87
   * of the 196 working rows in a real muse log — so the idle proof passed
   * mid-turn and idle-edge actions (a deferred pause's `/quit`, #1042) fired.
   *
   * Anchoring on the glyph would be wrong in a way that matters: completed
   * output lines start with `◆ ` too (`◆ Panes split the dark screen`), so a
   * glyph-anchored pattern would pin a finished instance in `working` forever.
   */
  getBusyPattern(): RegExp {
    return MUSE_BUSY;
  }

  /**
   * Structural proof that muse's TUI is parked at its idle input prompt.
   *
   * Muse's status bar (`model · effort · cwd · ...`) redraws periodically even
   * when the session is fully idle. Without this method `canProvePeriodicIdle`
   * stays false in the daemon, so every status-bar repaint triggers a plain
   * `recordOutput()` call, resetting the silence debounce and leaving the
   * instance stuck in `working` forever (no auto-pause, cancel never retires,
   * delegate_task times out on the readiness gate).
   *
   * The idle layout, last four non-blank rows:
   *   ─────────────────────────────  (separator)
   *   ❯                             (empty input box — no user text after it)
   *   ─────────────────────────────  (separator)
   *     model · effort · cwd        (status bar)
   *
   * Muse draws inline, so until the transcript fills the window tmux pads the
   * capture with blank rows BELOW the status bar (live muse 1.4.0 at 120x36,
   * 2026-09-28: six of them). Counting those as "bottom rows" pushed the prompt
   * out of the old fixed 8-row window, so a freshly restarted, idle muse could
   * never prove it was idle and stayed `working` until the transcript grew
   * (#958). The proof is therefore anchored to the last non-blank rows: the
   * live input box must END the capture, which also means a `❯ / ───` pair
   * sitting in scrollback can never qualify.
   *
   * Per the CliBackend contract, this method must be a strong structural proof:
   * false positives can retire Cancel and admit a new delivery into a busy CLI.
   * A working pane shows `◇ Thinking (2s · esc to interrupt)` in the rows
   * immediately above the top separator; checking those rows with getBusyPattern()
   * returns false for working panes, matching the codex implementation's approach.
   *
   * Note: `canProvePeriodicIdle` in the daemon is set by the *presence* of this
   * method (`!!this.backend?.isPeriodicRedrawIdlePane`), not its return value —
   * so returning false for working panes only resets the confirmation count and
   * keeps it working; it does not disable the periodic-idle path.
   */
  isPeriodicRedrawIdlePane(pane: string): boolean {
    const rows = pane.replace(/\r/g, "").split("\n");
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    const separator = MUSE_SEPARATOR;
    const busyPattern = this.getBusyPattern();
    // The approval prompt is auto-answered rather than input-blocking, so the
    // idle proof itself must refuse a frame that shows dialog chrome.
    const dialogChrome = MUSE_DIALOG_CHROME;
    // Everything after the bottom separator must be the status bar.
    let bottomSeparator = -1;
    for (let i = rows.length - 2; i >= Math.max(0, rows.length - 1 - MUSE_MAX_STATUS_ROWS); i--) {
      if (separator.test(rows[i])) { bottomSeparator = i; break; }
    }
    if (bottomSeparator < 2) return false;
    if (!museStatusFooter(rows, bottomSeparator, busyPattern)) return false;
    // Directly above it, the EMPTY live prompt. A `❯` with text is a draft
    // (or, higher up, a transcript echo) and never proves idle.
    if (!/^❯\s*$/.test(rows[bottomSeparator - 1])) return false;
    const topSeparator = bottomSeparator - 2;
    if (!separator.test(rows[topSeparator])) return false;
    // No busy indicator and no dialog just above the input box. The working
    // line (`◇ Thinking (2s · esc to interrupt)`) sits immediately above the
    // top separator; check 8 rows up to be safe.
    const above = rows.slice(Math.max(0, topSeparator - 8), topSeparator);
    if (above.some(r => busyPattern.test(r) || dialogChrome.test(r))) return false;
    // Arrow-key pickers (`/model`) are refused by their component chrome
    // above, not by guessing from answer text that happens to list model ids.
    // A `›` selection cursor is refused too; `❯` is not a cursor here — muse
    // echoes submitted messages with it.
    return !above.some(r => /^\s*›\s+\S/.test(r));
  }

  getErrorPatterns(): ErrorPattern[] {
    // NOTE: an Escape-interrupted run prints "interrupting run" in the status
    // bar. That is normal user-initiated behaviour, not an error — nothing here
    // matches it, and nothing that does should be added.
    return [
      { pattern: /rate.?limit|too many requests|\b429\b/i, type: "rate_limit", action: "failover", message: "Muse rate limit reached" },
      // Muse's own sign-in failures, and only as muse prints them (#1042). The
      // scan reads the whole pane, transcript included, so a fragment such as
      // `401`, "unauthorized", "Not logged in" or "run `muse login`" also
      // matches a diff row (muse numbers them: editing line 401 paused the
      // instance and /quit it mid-task) or the conversation. Muse has no
      // token-free auth check to overrule a false hit. So: whole muse
      // sentences (1.4.1 binary; the API-key one observed live), on a row that
      // is not one of the transcript's own: ❯ user, ◆ assistant, or a numbered
      // diff row (`401 +`, `582 -`, `25  ` context) — an edit to a file that
      // holds these sentences, this one included, shows them there.
      {
        pattern: new RegExp("^(?![ \\t]*(?:[❯◆]|\\d+ [+\\- ]))[^\\n]*(?:"
          + "still unauthorized after a token refresh; run `muse login` again"
          + "|your saved login is no longer valid\\. Log in again or use a different account"
          + "|your API key from META_API_KEY was rejected"
          + "|Not logged in\\. Run \\S+(?: \\S+)? again to log in"
          + "|Not logged in\\W+run /login to get started"
          + ")", "m"),
        type: "auth_error", action: "pause", message: "Muse authentication error",
      },
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
      MUSE_LOGIN_MENU,
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      MUSE_LOGIN_MENU,
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
        const head = readFileHeadSync(join(sessionDir, "session.jsonl"), SESSION_HEAD_CHARS);
        if (head === null) continue;
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
   * stops the run, removes the interrupted turn from the transcript and puts
   * that prompt's text back into the input box (muse 1.4.2, 2026-10-05: in the
   * same frame the busy line goes away), while Ctrl+C armed the quit
   * confirmation ("Press Ctrl-C again to quit"). Cancelling with C-c would
   * leave every instance one stray keypress from exiting. The restored text is
   * cleared before the next delivery (#829): see inputDraft.
   */
  getCancelKey(): string { return "Escape"; }

  /**
   * #1217: muse 1.4.2 on `resume <id>` for a session it does not have (verified
   * live on a private socket): `retained session not found: session <id> has
   * no saved log`, then exit 1.
   */
  resumeMissingPattern(): RegExp {
    return /retained session not found: session \S+ has no saved log/;
  }

  /** The live input box (#829): no rows when empty, null when the bottom of the screen is not muse's layout. */
  inputDraft(pane: string): InputDraft | null {
    return museInputBox(pane, this.getBusyPattern());
  }

  inputDraftShows(draft: InputDraft, text: string): boolean {
    return museDraftShows(draft.rows, draft.width, text);
  }

  /**
   * One line per round, from either end (live, muse 1.4.2 keymap: ctrl+u is
   * delete-start, ctrl+k delete-end): the cursor's line is emptied — all of
   * its rows when it wraps — then joined to the line before it (Backspace) or
   * pulls up the line after it (Delete). Verified on a live four-line draft
   * with the cursor at its end and at its start, on wrapped lines, and on a
   * collapsed `[Pasted Content N chars]` row; extra rounds on an empty box
   * change nothing. Never C-c: that arms muse's quit.
   */
  getClearInputKeys(): readonly string[] { return ["C-u", "C-k", "BSpace", "DC"]; }

  // `/effort` is in the TUI command list, so a level change needs no restart.
  getEffortStrategy(): "runtime" | "restart" | "unsupported" { return EFFORT_CAPABILITIES["muse"].strategy; }
  // muse also accepts none|minimal|ultra, which AgEnD has no level for; the
  // canonical five map straight through.
  getEffortLevels(): string[] { return [...EFFORT_CAPABILITIES["muse"].levels]; }

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
    return {
      version: probeCliVersion(this.binaryPath, {
        ...process.env,
        // The launcher checks for and may install updates on startup. A
        // diagnostic version probe should not trigger that updater.
        MUSE_UPDATE_INTERVAL_SECONDS: "31536000",
      }),
      models: await this.listModels(),
      currentModel,
    };
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
