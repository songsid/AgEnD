import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

/**
 * How AgEnD keeps OpenCode's permission prompts out of an instance's way.
 *
 * OpenCode asks before it touches a path outside the project (`external_directory`), reads a
 * `.env` file, loops on a failing tool, or does whatever the user's own config marks `ask`.
 * Every other backend AgEnD runs is started with its skip-permissions switch; OpenCode had none,
 * so a read of `/tmp/x.jpg` parked the instance on "Access external directory /tmp" until a human
 * answered (#opencode-permissions). Two layers, from the source outwards:
 *
 *   1. at launch: `--auto` (OpenCode answers every ask "once" itself; an explicit `deny` still
 *      denies) when the binary's own `--help` lists it. An older OpenCode gets NOTHING: its only
 *      launch-time form, the `OPENCODE_PERMISSION` env, is merged over the user's own config and
 *      overrides their `deny` (and replaces an env they already set), so the prompt is left to 2.;
 *   2. if a prompt still appears: the runtime dialogs below answer it with **Allow once** (a single
 *      Enter — nothing is remembered) and hold delivery while it is on screen.
 *
 * Panes verified against real OpenCode 1.16.2 / 1.17.20 / 1.18.34 (tests/fixtures/opencode-*).
 */

/** `--help` rows look like `      --auto          auto-approve …` (yargs, with an optional short alias first). */
export function helpAdvertisesAutoFlag(help: string): boolean {
  return /^\s*(?:-[A-Za-z0-9],\s*)?--auto(?:[ =<,]|$)/m.test(help);
}

/**
 * The OpenCode CLI's own help, complete enough to be believed about what it LACKS: the banner, the
 * Options section, and the TUI flags every version has. A truncated or foreign output proves nothing
 * (banner only, an empty Options section, `--help` alone), and "no --auto" must not be learned from it.
 */
export function looksLikeOpencodeHelp(help: string): boolean {
  if (!/^\s*opencode \[project\]/m.test(help)) return false;
  const options = help.split(/^Options:\s*$/m)[1];
  if (options === undefined) return false;
  return ["help", "version", "model", "continue", "session", "prompt", "agent"]
    .every(flag => new RegExp(`^\\s*(?:-[A-Za-z0-9],\\s*)?--${flag}(?:[ =<,]|$)`, "m").test(options));
}

export type OpencodeAutoSupport = "yes" | "no" | "unknown";

export type OpencodeHelpRunner = (binaryPath: string) => Promise<string>;

const runHelp: OpencodeHelpRunner = async binaryPath => {
  const { stdout } = await promisify(execFile)(binaryPath, ["--help"], {
    encoding: "utf-8",
    timeout: 5_000,
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
  });
  return stdout;
};

/** A probe that could not answer is retried after this long (a loaded host, a binary being replaced). */
const UNKNOWN_TTL_MS = 60_000;

interface CachedSupport { support: OpencodeAutoSupport; probedAt: number }
const cache = new Map<string, CachedSupport>();
const inFlight = new Map<string, Promise<OpencodeAutoSupport>>();

/** Keyed by the binary's identity, so an upgrade in place is probed again and nothing else is. */
function binaryKey(binaryPath: string): string {
  try {
    const stat = statSync(binaryPath);
    return `${binaryPath}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${binaryPath}\0unavailable`;
  }
}

/** What the last probe of this very binary found, without running anything. */
export function cachedOpencodeAutoSupport(binaryPath: string): OpencodeAutoSupport {
  const hit = cache.get(binaryKey(binaryPath));
  if (!hit) return "unknown";
  if (hit.support === "unknown" && Date.now() - hit.probedAt >= UNKNOWN_TTL_MS) return "unknown";
  return hit.support;
}

/**
 * Ask the binary, once per binary generation (single-flight, cached): does its TUI take `--auto`?
 * Asynchronous on purpose — a launch must not fork on the fleet's event loop. Never rejects.
 */
export function probeOpencodeAutoSupport(binaryPath: string, run: OpencodeHelpRunner = runHelp): Promise<OpencodeAutoSupport> {
  const key = binaryKey(binaryPath);
  const hit = cache.get(key);
  if (hit && (hit.support !== "unknown" || Date.now() - hit.probedAt < UNKNOWN_TTL_MS)) return Promise.resolve(hit.support);
  const running = inFlight.get(key);
  if (running) return running;
  const probe = run(binaryPath).then((help): OpencodeAutoSupport => {
    if (!looksLikeOpencodeHelp(help)) return "unknown";
    return helpAdvertisesAutoFlag(help) ? "yes" : "no";
  }, (): OpencodeAutoSupport => "unknown").then(support => {
    cache.set(key, { support, probedAt: Date.now() });
    return support;
  }).finally(() => { inFlight.delete(key); });
  inFlight.set(key, probe);
  return probe;
}

/** Test seam. */
export function resetOpencodeAutoSupportCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

// ── the prompts, as the pane shows them ──────────────────────────────────────

/** Idle prompt, or the busy composer's footer: the composer is the CURRENT region, so no dialog is. */
const COMPOSER = /Ask anything|ctrl\+p commands|\besc\s+(?:again\s+to\s+)?interrupt/i;
/** The dialog's left bar. Every line of a real dialog, from its header to its option row, carries it. */
const BAR = /^\s*[┃│|]/;
const HINT_INLINE = /⇆ select {2,}enter confirm/;
const HINT_LINE = /^(?:ctrl\+f fullscreen {2,})?⇆ select {2,}enter confirm$/;

function barBody(line: string): string {
  return line.replace(/^\s*[┃│|]?\s*/, "").trimEnd();
}

/**
 * A live OpenCode dialog is one bordered block at the BOTTOM of the pane, in this order:
 *
 *     ┃  △ <header>                                  ← the whole line, nothing after the title
 *     ┃  …body…
 *     ┃   <option row>  [ctrl+f fullscreen]  ⇆ select  enter confirm   ← or the hints on the next line
 *     ┃                                  • OpenCode x.y.z                (at most a few status lines)
 *
 * Each piece is anchored to a whole line, not looked for as a substring, and the composer (idle
 * prompt, or the busy footer) must NOT be on screen below it: a transcript that quotes the prompt,
 * an agent explaining it, a draft in the composer, a pasted pane — all have the composer under
 * them, or no dialog hints on the option row, or the pieces out of order.
 */
function liveDialog(pane: string, header: RegExp, optionRow: RegExp): boolean {
  const lines = pane.split("\n").filter(line => line.trim() !== "").slice(-40);
  let row = -1;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
    if (optionRow.test(barBody(lines[i]!))) { row = i; break; }
  }
  if (row < 0) return false;
  // Bar-only spacer lines (the 60-column layout wraps the hints under a blank one) carry nothing.
  const below = lines.slice(row + 1).filter(line => barBody(line) !== "");
  if (below.length > 4 || below.some(line => COMPOSER.test(line))) return false;
  const hintsHere = HINT_INLINE.test(lines[row]!);
  const hintsNext = below.length > 0 && HINT_LINE.test(barBody(below[0]!));
  if (!hintsHere && !hintsNext) return false;
  let top = -1;
  for (let i = row - 1; i >= 0; i--) {
    if (header.test(barBody(lines[i]!))) { top = i; break; }
  }
  if (top < 0) return false;
  return lines.slice(top, row + 1).every(line => BAR.test(line));
}

const PERMISSION_HEADER = /^△ Permission required$/;
const PERMISSION_OPTIONS = /^Allow once {2,}Allow always {2,}Reject(?: {2,}\S.*)?$/;
const ALWAYS_HEADER = /^△ Always allow$/;
const ALWAYS_OPTIONS = /^Confirm {2,}Cancel(?: {2,}\S.*)?$/;

/** The permission prompt: `△ Permission required` … `Allow once   Allow always   Reject`. */
export function opencodePermissionPromptActive(pane: string): boolean {
  return liveDialog(pane, PERMISSION_HEADER, PERMISSION_OPTIONS);
}

/** The second page behind "Allow always": `△ Always allow` … `Confirm   Cancel`. */
export function opencodeAlwaysConfirmActive(pane: string): boolean {
  return liveDialog(pane, ALWAYS_HEADER, ALWAYS_OPTIONS);
}
