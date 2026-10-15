/**
 * Ask a fresh login shell where a command is, without ever holding the fleet's event loop.
 *
 * This used to be `spawnSync("bash", ["-lc", …], { timeout: 10_000 })` on the fleet loop. spawnSync waits for its
 * stdout/stderr pipes as well as the shell, and anything the user's login files start in the background (an agent, a
 * keychain helper, a tmux server) inherits those pipes and keeps them open. Bash was done in milliseconds; spawnSync
 * sat out its whole timeout all the same — ten seconds of no IPC, no deliveries and no watchdog ping, every lookup.
 *
 * So: the shell is spawned asynchronously in its own process group; the answer is taken when the SHELL exits, with a
 * short grace for its last bytes, never by waiting for every holder of the pipe to let go; and when the deadline
 * passes, or something is still holding the pipe after the shell is gone, the whole group is killed — it was started
 * for this lookup and nothing else.
 */
import { spawn } from "node:child_process";

/** How long the login shell may take, as before. */
export const LOGIN_SHELL_TIMEOUT_MS = 10_000;
/** After the shell exits: how long its output may still take to drain before the pipe is let go. */
export const LOGIN_SHELL_DRAIN_MS = 250;

export interface LoginShellResult {
  /** The shell's exit status; null when it was killed (timeout) or could not start. */
  status: number | null;
  stdout: string;
  timedOut: boolean;
}

export function runOnLoginShell(
  script: string,
  opts: { shell?: string; timeoutMs?: number; drainMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<LoginShellResult> {
  const timeoutMs = opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;
  const drainMs = opts.drainMs ?? LOGIN_SHELL_DRAIN_MS;
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.shell ?? "bash", ["-lc", script], {
        // Its own process group, so a timeout reaches whatever the login files started, not only the shell.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "ignore"],
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch {
      resolve({ status: null, stdout: "", timedOut: false });
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-pid, "SIGKILL");
      } catch { /* already gone */ }
    };
    const finish = (status: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (drainTimer) clearTimeout(drainTimer);
      // Whoever still holds the pipe was started by this lookup's shell: it goes with it, and so does our end.
      if (timedOut || !child.stdout?.readableEnded) killGroup();
      child.stdout?.destroy();
      resolve({ status, stdout: Buffer.concat(chunks).toString("utf8"), timedOut });
    };
    const deadline = setTimeout(() => finish(null, true), timeoutMs);
    deadline.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish(null, false));
    child.on("exit", (code) => {
      // The shell is done. Its output normally ends with it; give the last bytes a moment, never a background holder.
      if (child.stdout?.readableEnded) { finish(code, false); return; }
      child.stdout?.once("end", () => finish(code, false));
      drainTimer = setTimeout(() => finish(code, false), drainMs);
      drainTimer.unref?.();
    });
  });
}
