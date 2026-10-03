/**
 * Keep crash dumps small, from inside the fleet (#1113 hotfix).
 *
 * On WSL every crash is piped to /wsl-capture-crash, which ignores
 * RLIMIT_CORE, so kiro-cli and the fleet left ~1 GB / ~450 MB dumps in
 * %TEMP%\wsl-crashes. A zero /proc/<pid>/coredump_filter writes no memory
 * mappings into a dump (a few KB). The unit's `CoredumpFilter=0` was meant to
 * set it, but systemd 249 silently ignores that directive in a unit file
 * (only a transient `systemd-run -p` honours it), so the fleet sets its own
 * filter at startup instead. The value is inherited across fork/exec by a
 * tmux server the fleet starts; panes of a server that already existed get
 * it from coredumpFilterLaunchPrefix below.
 *
 * Linux only. No privilege needed: a process may always narrow its own filter.
 */
import { readFileSync, writeFileSync } from "node:fs";

export type CoredumpFilterOutcome = "set" | "already" | "unsupported" | "failed";

export function disableCoredumpMemory(
  path = "/proc/self/coredump_filter",
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CoredumpFilterOutcome | "kept" {
  if (platform !== "linux") return "unsupported";
  // An operator debugging a crash keeps full dumps (and any filter they set).
  if (env.AGEND_KEEP_COREDUMP_FILTER === "1") return "kept";
  try {
    if (/^0+$/.test(readFileSync(path, "utf-8").trim())) return "already";
  } catch {
    return "unsupported"; // no such file: a kernel without it
  }
  try {
    writeFileSync(path, "0");
    return /^0+$/.test(readFileSync(path, "utf-8").trim()) ? "set" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * The fleet process's start-up step: called once the fleet owns its lock,
 * before anything is spawned, so a tmux server it starts inherits it.
 */
export function limitFleetCoreDumps(
  log: { info(msg: string): void; error(msg: string): void },
  disable: () => CoredumpFilterOutcome | "kept" = disableCoredumpMemory,
): void {
  const outcome = disable();
  if (outcome === "set" || outcome === "already") log.info("Crash dumps limited to a few KB (coredump_filter=0 for the fleet and every CLI it launches).");
  else if (outcome === "failed") log.error("⚠ Could not set /proc/self/coredump_filter to 0; a crash may write a full-size core dump (#1113).");
}

/**
 * Shell prefix for AgEnD's own CLI launch commands (#1125 review). The fleet's
 * filter reaches a CLI only if the tmux server was started by this fleet; a
 * server that already existed (the default socket may hold a user's own
 * session, which AgEnD reuses and never kills) forks panes with ITS filter.
 * So each launch sets the filter of the pane's own shell before the CLI
 * starts: `echo` is a builtin in sh, bash, zsh and fish, the redirect order
 * silences a failure, and the CLI and everything it spawns inherit the value.
 * Empty where it does not apply or the operator opted out.
 */
export function coredumpFilterLaunchPrefix(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "linux" || env.AGEND_KEEP_COREDUMP_FILTER === "1") return "";
  return "echo 0 2>/dev/null >/proc/self/coredump_filter; ";
}
