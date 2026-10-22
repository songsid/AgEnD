/**
 * #2374: `spawn` and `execFile` for the fleet's own code, with every piped stdio stream heard.
 *
 * A child's stdin/stdout/stderr pipes are EventEmitters of their own: `child.on("error")` and the `execFile` callback
 * never see their errors, and an `error` nobody listens to is an uncaught exception, which stops the fleet (#2243).
 * Here each pipe gets a listener for its whole life. By default a pipe error kills the child and is passed on as the
 * child's own `error` (when anything listens for one), so the call fails with it: `execFile`'s callback and promise get
 * the pipe error even if the child then exits 0, or had already exited while something else held the pipe, and nothing
 * half-read passes for an answer. A caller that listens on the pipe itself keeps its own handling; one with a different
 * response passes `onError` to `guardStdio`. The `*Sync` forms have no streams and come from node:child_process directly.
 */
import * as cp from "node:child_process";
import { promisify } from "node:util";

type Pipes = { stdin?: unknown; stdout?: unknown; stderr?: unknown; kill?: (signal?: NodeJS.Signals) => boolean;
  emit?: (event: "error", err: Error) => boolean; listenerCount?: (event: "error") => number };
type Listens = { on?: (event: "error", listener: (err: Error) => void) => unknown; listenerCount?: (event: "error") => number };

/**
 * An `error` listener on each of the child's pipes. The default response kills the child and passes the error on as
 * the child's `error` (only to a listener: unheard, it would be uncaught again), unless the caller heard that pipe's
 * errors itself (another listener): then the caller's own handling is the response. Tolerates test doubles.
 */
export function guardStdio<T>(child: T, onError?: (err: Error) => void): T {
  const c = child as Pipes | null | undefined;
  if (!c) return child;
  for (const stream of [c.stdin, c.stdout, c.stderr] as Listens[]) {
    if (!stream || typeof stream.on !== "function") continue;
    stream.on("error", onError ?? ((err: Error) => {
      if ((stream.listenerCount?.("error") ?? 1) > 1) return;
      try { c.kill?.(); } catch { /* already gone */ }
      if ((c.listenerCount?.("error") ?? 0) > 0) c.emit?.("error", err);
    }));
  }
  return child;
}

export const spawn = ((...args: unknown[]) =>
  guardStdio((cp.spawn as (...a: unknown[]) => cp.ChildProcess)(...args))) as typeof cp.spawn;

/** `execFile`/`exec` guarded; `promisify` of it keeps node's own { stdout, stderr } form, with its `.child` guarded. */
function guarded<F>(original: () => F): F {
  const call = (...args: unknown[]) => guardStdio((original() as (...a: unknown[]) => cp.ChildProcess)(...args));
  Object.defineProperty(call, promisify.custom, {
    value: (...args: unknown[]) => {
      const promise = (promisify(original() as never) as (...a: unknown[]) => Promise<unknown> & { child?: unknown })(...args);
      guardStdio(promise.child);
      return promise;
    },
  });
  return call as unknown as F;
}
export const execFile = guarded(() => cp.execFile);
export const exec = guarded(() => cp.exec);
