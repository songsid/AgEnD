/**
 * Run work under a wall-clock deadline without cancelling it.
 *
 * Nothing here aborts anything — a tmux spawn or an HTTP call keeps going after
 * its deadline passes; the caller simply stops waiting and can say so. That is
 * the point: a step with no deadline cannot report anything while it hangs, so
 * the user sees silence and assumes the whole operation is stuck (#722, and the
 * post-login recovery that silently swallowed its own success message).
 *
 * Rejections are reported rather than thrown, so one failed step never takes
 * the surrounding loop down with it, and are always observed — an abandoned
 * promise that rejects later must not surface as an unhandled rejection.
 */
export type DeadlineResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

/** Largest delay setTimeout honours; anything above is clamped to 1ms by Node. */
const MAX_TIMER_MS = 2_147_483_647;

export async function runBeforeDeadline<T>(start: () => Promise<T>, deadline: number): Promise<DeadlineResult<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { status: "timeout" };
  let work: Promise<T>;
  try {
    work = start();
  } catch (reason) {
    // A synchronous throw from `start` is a rejection like any other.
    return { status: "rejected", reason };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>(resolve => {
    // Node clamps a delay above the 32-bit maximum to 1ms — so a very distant
    // deadline would fire IMMEDIATELY and report every step as timed out, the
    // exact opposite of what the caller asked for. Cap instead.
    timer = setTimeout(() => resolve({ status: "timeout" }), Math.min(remaining, MAX_TIMER_MS));
    timer.unref?.();
  });
  const settled = work.then<DeadlineResult<T>, DeadlineResult<T>>(
    value => ({ status: "fulfilled", value }),
    reason => ({ status: "rejected", reason }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
