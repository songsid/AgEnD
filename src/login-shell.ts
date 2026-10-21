/**
 * Ask a fresh login shell where a command is, without ever holding the fleet's event loop.
 *
 * This used to be `spawnSync("bash", ["-lc", …], { timeout: 10_000 })` on the fleet loop. spawnSync waits for its
 * stdout/stderr pipes as well as the shell, and anything the user's login files start in the background (an agent, a
 * keychain helper, a tmux server) inherits those pipes and keeps them open. Bash was done in milliseconds; spawnSync
 * sat out its whole timeout all the same — ten seconds of no IPC, no deliveries and no watchdog ping, every lookup.
 *
 * So: the shell is spawned asynchronously in its own process group; the answer is taken when the SHELL exits, with a
 * short grace for its last bytes, never by waiting for every holder of the pipe to let go. The group is killed — it
 * was started for this lookup — when the deadline passes, when more than LOGIN_SHELL_MAX_OUTPUT_BYTES arrive, or when
 * something still holds the pipe after the shell is gone. A background child that let go of the pipe is left alone,
 * as it always was.
 */
import { spawn } from "node:child_process";

/** How long the login shell may take, as before. */
export const LOGIN_SHELL_TIMEOUT_MS = 10_000;
/** After the shell exits: how long its output may still take to drain before the pipe is let go. */
export const LOGIN_SHELL_DRAIN_MS = 250;
/** The most output kept — spawnSync's own default maxBuffer, which the old call had. More is a failed lookup. */
export const LOGIN_SHELL_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface LoginShellResult {
  /** The shell's exit status; null when it was killed (timeout, too much output) or could not start. */
  status: number | null;
  stdout: string;
  timedOut: boolean;
  /** More than maxOutputBytes arrived: the lookup was ended, and nothing it printed is an answer. */
  overflow: boolean;
}

export function runOnLoginShell(
  script: string,
  opts: { shell?: string; timeoutMs?: number; drainMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<LoginShellResult> {
  const timeoutMs = opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;
  const drainMs = opts.drainMs ?? LOGIN_SHELL_DRAIN_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? LOGIN_SHELL_MAX_OUTPUT_BYTES;
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
      resolve({ status: null, stdout: "", timedOut: false, overflow: false });
      return;
    }
    const chunks: Buffer[] = [];
    let kept = 0;
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
    const finish = (status: number | null, timedOut: boolean, overflow = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (drainTimer) clearTimeout(drainTimer);
      // Whoever still holds the pipe was started by this lookup's shell: it goes with it, and so does our end.
      // (An overflow is always mid-stream, so it lands here through `readableEnded` too.)
      if (timedOut || !child.stdout?.readableEnded) killGroup();
      child.stdout?.destroy();
      resolve(overflow
        ? { status: null, stdout: "", timedOut: false, overflow: true }
        : { status, stdout: Buffer.concat(chunks).toString("utf8"), timedOut, overflow: false });
    };
    const deadline = setTimeout(() => finish(null, true), timeoutMs);
    deadline.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      kept += chunk.length;
      // A bounded answer, as spawnSync's maxBuffer was: past it, a truncated path must not pass for a binary.
      if (kept > maxOutputBytes) { finish(null, false, true); return; }
      chunks.push(chunk);
    });
    // #2243: the pipe is its own emitter; unheard, its error would be uncaught and stop the fleet. A failed read is no answer.
    child.stdout?.on("error", () => { chunks.length = 0; finish(null, false); });
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
