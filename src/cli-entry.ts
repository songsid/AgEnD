/**
 * #1450 C4: the CLI's canonical inner entry — `realpath(<package>/dist/cli.js)`, from this module's own location. Never
 * `process.argv[1]`: that is whatever started this process (npm's bin link, the launcher, another checkout's file).
 * Every place that records or re-runs "this CLI" (service files, detached starts, reloads, completions) uses this.
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function canonicalCliEntry(moduleUrl: string = import.meta.url): string {
  const entry = join(dirname(fileURLToPath(moduleUrl)), "cli.js");
  try { return realpathSync(entry); } catch { return entry; }
}

/** Run this CLI again: the Node running now (the verified selection, C2) on the canonical entry — no PATH lookup. */
export function selfCommand(args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [canonicalCliEntry(), ...args] };
}

/**
 * The same, after `seconds`, from a detached `sh` that outlives this process (quickstart exits right after asking).
 * Every value is a positional argument, never spliced into the script, so paths with spaces, `$` or backticks stay
 * data (C5).
 */
export const DELAYED_EXEC_SCRIPT = 'sleep "$1" && shift && exec "$@"';
export function delayedSelfCommand(seconds: number, args: string[]): { command: string; args: string[] } {
  const self = selfCommand(args);
  return { command: "sh", args: ["-c", DELAYED_EXEC_SCRIPT, "sh", String(seconds), self.command, ...self.args] };
}
