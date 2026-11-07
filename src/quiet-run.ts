/**
 * #3212 PR 3 (#3305 review P2-5): running a CLI quietly, for at most a deadline — no shell, no input, no output kept.
 *
 * The deadline is a failure, whatever happens after it: a child that answers late (even with exit 0) is still a
 * timeout. At the deadline the child gets SIGINT (kiro dumps core on SIGTERM), then SIGKILL after a grace period; the
 * promise settles once the child is seen gone, and at the latest a short while after SIGKILL — never never.
 */
import type { ChildProcess } from "node:child_process";
import { spawn as guardedSpawn } from "./child-process.js";

export interface QuietRunOptions {
  timeoutMs?: number;
  /** Between SIGINT and SIGKILL. */
  graceMs?: number;
  /** After SIGKILL: give up waiting for the exit event (the child is unreachable either way). */
  killWaitMs?: number;
  spawn?: (binary: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: "ignore"; windowsHide: boolean }) => ChildProcess;
}

/** `code`: the exit code, or null — not started, killed, or past the deadline (`timedOut`). */
export function runQuiet(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, o: QuietRunOptions = {}): Promise<{ code: number | null; timedOut?: true }> {
  const { timeoutMs = 60_000, graceMs = 5_000, killWaitMs = 5_000 } = o;
  const spawn = o.spawn ?? ((b, a, opts) => guardedSpawn(b, a, opts) as ChildProcess);
  return new Promise(resolve => {
    let child: ChildProcess;
    try { child = spawn(binary, [...args], { env, stdio: "ignore", windowsHide: true }); } catch { resolve({ code: null }); return; }
    let done = false, timedOut = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); };
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve(timedOut ? { code: null, timedOut: true } : { code });
    };
    child.once("error", () => finish(null));
    child.once("exit", code => finish(code));
    later(timeoutMs, () => {
      timedOut = true;
      try { child.kill("SIGINT"); } catch { /* gone */ }
      later(graceMs, () => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        later(killWaitMs, () => finish(null));
      });
    });
  });
}
