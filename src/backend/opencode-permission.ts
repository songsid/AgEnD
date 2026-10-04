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
 *      denies) when the binary's own `--help` lists it, else the version-independent
 *      `OPENCODE_PERMISSION` env (unknown env is ignored by an older OpenCode);
 *   2. if a prompt still appears: the runtime dialogs below answer it with **Allow once** (a single
 *      Enter — nothing is remembered) and hold delivery while it is on screen.
 *
 * Panes verified against real OpenCode 1.16.2 / 1.17.20 / 1.18.34 (tests/fixtures/opencode-*).
 */

/** What an older OpenCode (no `--auto` on its TUI) is given instead: only the prompt that was reported. */
export const OPENCODE_PERMISSION_ENV = `OPENCODE_PERMISSION='{"external_directory":"allow"}'`;

/** `--help` rows look like `      --auto          auto-approve …` (yargs, with an optional short alias first). */
export function helpAdvertisesAutoFlag(help: string): boolean {
  return /^\s*(?:-[A-Za-z0-9],\s*)?--auto(?:[ =<,]|$)/m.test(help);
}

/** The OpenCode CLI's own banner and command list: a truncated or foreign output proves nothing. */
export function looksLikeOpencodeHelp(help: string): boolean {
  return /^\s*opencode \[project\]/m.test(help);
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

const READY = /Ask anything|ctrl\+p commands/;
const PERMISSION_HEADER = /△\s*Permission required/;
const PERMISSION_OPTIONS = /\bAllow once\s{2,}Allow always\s{2,}Reject\b/;
const ALWAYS_HEADER = /△\s*Always allow/;
const ALWAYS_OPTIONS = /\bConfirm\s{2,}Cancel\b/;

function lastLines(pane: string, count: number): string[] {
  return pane.split("\n").filter(line => line.trim() !== "").slice(-count);
}

/**
 * OpenCode's permission prompt is the CURRENT interactive region: its option row is among the last
 * few lines, its header just above, and the idle prompt (`ctrl+p commands`, "Ask anything") is
 * not on screen. A transcript that merely quotes the dialog — a pasted pane, this very bug being
 * discussed — has the idle prompt below it and never counts.
 */
export function opencodePermissionPromptActive(pane: string): boolean {
  const bottom = lastLines(pane, 6);
  if (!bottom.some(line => PERMISSION_OPTIONS.test(line))) return false;
  if (bottom.some(line => READY.test(line))) return false;
  return lastLines(pane, 40).some(line => PERMISSION_HEADER.test(line));
}

/** The second page behind "Allow always": `△ Always allow` … `Confirm   Cancel`. */
export function opencodeAlwaysConfirmActive(pane: string): boolean {
  const bottom = lastLines(pane, 6);
  if (!bottom.some(line => ALWAYS_OPTIONS.test(line))) return false;
  if (bottom.some(line => READY.test(line))) return false;
  return lastLines(pane, 40).some(line => ALWAYS_HEADER.test(line));
}
