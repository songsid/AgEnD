/**
 * M-2281 (#2980): how `/login` runs a CLI's installer in its window — nobody types there, so nothing may wait for
 * an answer, and the install must not starve the fleet that is still serving every chat.
 *
 * - **No terminal to ask on.** `setsid -w` gives the install a session of its own with no controlling terminal, so
 *   `/dev/tty` cannot be opened, and stdin is `/dev/null`. A prompt that asks there (codex's "Start Codex now?",
 *   kiro's "replace it?", sudo's password) fails at once instead of waiting out the session timeout. Without
 *   `setsid` (macOS has none), stdin is still `/dev/null`. The same wrapper install-agend.ps1 uses (#2583).
 * - **Low priority.** `nice -n 10`, plus `ionice -c2 -n7` where it exists and is permitted: a ~0.5 GB download and
 *   unpack (codex 0.166) yields CPU and disk to the fleet and its CLIs.
 * - **Stoppable.** The install's own session is not the window's, so closing the window (cancel, timeout, fleet
 *   stop) would not reach it: the window's shell forwards HUP/INT/TERM to the install's whole process group.
 * - **The user's shell.** Installers pick the rc file for their PATH line from `$SHELL`; the window inherits the
 *   tmux server's environment, where it may be missing (a service). The account's login shell is passed, so the
 *   line lands in the file the user's own terminals read.
 *
 * - **Its verdict is kept.** In a tmux pane it starts once remain-on-exit is on (see the script): an install that ends
 *   at once still leaves a dead pane with its exit code and output for the session to judge. The wrapper also prints
 *   its exit code after the session's marker, for when tmux never records the pane's exit status (see the script).
 *
 * The exit code is the install's own: the session judges success by it.
 */
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { shellQuote } from "./backend/types.js";
import { spawnProbeCommand, PROBE_DEADLINE_MS } from "./binary-probe.js";

/** Runs `$1` detached from any terminal, at low priority; HUP/INT/TERM on this shell reach its whole process group. */
export const UNATTENDED_INSTALL_SCRIPT = [
  // In a tmux pane, start only once AgEnD has set remain-on-exit on the window (at most ~10 s): an install that fails
  // at once — a prompt with no terminal does — would otherwise close the window before it is set, taking its exit code
  // and output with it. Outside tmux ($TMUX_PANE unset) there is nothing to wait for.
  // ${AGEND_TMUX:-tmux}: the tmux the fleet runs (its server exports it with the bundled tmux, M-2457); else PATH's.
  'T="${AGEND_TMUX:-tmux}"; if [ -n "${TMUX_PANE:-}" ] && command -v "$T" >/dev/null 2>&1; then i=0; while [ "$("$T" show-options -wqv -t "$TMUX_PANE" remain-on-exit 2>/dev/null)" != on ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; fi',
  'P=""',
  'if command -v ionice >/dev/null 2>&1 && ionice -c2 -n7 true >/dev/null 2>&1; then P="ionice -c2 -n7"; fi',
  'if command -v setsid >/dev/null 2>&1; then setsid -w nice -n 10 $P sh -c "$1" </dev/null & else nice -n 10 $P sh -c "$1" </dev/null & fi',
  "pid=$!",
  // `kill -TERM -$pid`, not `kill -- -$pid`: dash's kill refuses `--` ("Illegal number"). Before setsid has run there is
  // no such group yet, and the plain pid is what exists.
  "trap 'kill -TERM -$pid 2>/dev/null || kill -TERM $pid 2>/dev/null; exit 129' HUP INT TERM",
  // The verdict, said by the wrapper itself as its last line ("$2<code>", $2 = the session's own marker): tmux 3.4 can
  // miss the pane's SIGCHLD — the pane is dead (its pty closed) but the shell stays an unreaped zombie and
  // #{pane_dead_status} never appears (reproduced: 3 in 40 runs, the status still absent 15 s later). The session reads
  // this line instead; no marker, no line.
  'wait "$pid"; rc=$?',
  'if [ -n "${2:-}" ]; then printf \'\\n%s%s\\n\' "$2" "$rc"; fi',
  'exit "$rc"',
].join("\n");

/** The account's login shell, when it is an absolute path to an executable; else undefined (keep the inherited one). */
export async function loginShell(read: () => string | null | undefined = () => userInfo().shell): Promise<string | undefined> {
  let shell: string | null | undefined;
  try { shell = read(); } catch { return undefined; }
  if (!shell || !isAbsolute(shell)) return undefined;
  // Child `sh` `[ -f && -x ]`, same as resolveBackendBinary's install-dir probe: an accessSync on a dead mount
  // can hang a pool thread forever (#3009); a child can be killed (binary-probe.ts).
  const child = spawnProbeCommand("sh", ["-c", '[ -f "$1" ] && [ -x "$1" ] && echo "$1"', "sh", shell]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      child.answer,
      new Promise<undefined>((r) => {
        timer = setTimeout(() => { child.kill(); r(undefined); }, PROBE_DEADLINE_MS);
        timer.unref?.();
      }),
    ]);
    return found ?? undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The window's command for an install command. `shell`: the $SHELL to give it; null keeps the inherited one.
 * `exitMarker` (installExitMarker()): the wrapper prints `<marker><exit code>` as its last line, for the session.
 */
export function unattendedInstallCommand(command: string, shell: string | null = null, exitMarker?: string): string {
  const env = shell ? `SHELL=${shellQuote(shell)} ` : "";
  if (exitMarker !== undefined && !/^[A-Za-z0-9-]+=$/.test(exitMarker)) throw new Error("exit marker: letters, digits and '-' ending in '='");
  return `${env}sh -c ${shellQuote(UNATTENDED_INSTALL_SCRIPT)} agend-install ${shellQuote(command)}${exitMarker ? ` ${shellQuote(exitMarker)}` : ""}`;
}

/** A marker for one install: random per run, so nothing the installer prints can pass for the wrapper's verdict. */
export function installExitMarker(): string {
  return `AGEND-INSTALL-EXIT-${randomBytes(8).toString("hex")}=`;
}
/** The exit code the wrapper printed after `marker` (its last such line), or undefined when there is none. */
export function exitCodeFromMarker(pane: string, marker: string): number | undefined {
  let code: number | undefined;
  for (const line of pane.split("\n")) {
    const at = line.indexOf(marker);
    if (at < 0) continue;
    const m = /^(\d{1,3})\s*$/.exec(line.slice(at + marker.length));
    if (m) code = Number(m[1]);
  }
  return code;
}
/** The pane without the wrapper's verdict line (what a person is shown). */
export function withoutExitMarker(pane: string, marker: string): string {
  return pane.split("\n").filter((l) => !l.includes(marker)).join("\n");
}
