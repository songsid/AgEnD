/**
 * Mutual exclusion for writes into a CLI's tmux pane.
 *
 * A delivery is not one tmux call, it is a transaction:
 *
 *     set-buffer → paste-buffer → (settle delay) → send-keys Enter → confirm
 *
 * Anything that writes to the same pane while that transaction is mid-flight is
 * not merely interleaved, it is *destructive*: an `Escape` injected between the
 * paste and the Enter discards the pasted text outright, and a stray `Enter`
 * submits a half-composed message. Both look identical to a dropped message from
 * the user's side — the ✅ reaction never arrives and nobody can say why.
 *
 * `Daemon.pasteLock` already serialises inbound channel messages against each
 * other, but three other writers reach the pane without going through it (the
 * post-restart instructions notice, the session-snapshot injection, and the
 * runtime-dialog auto-dismisser). This lock is the single point they all share.
 *
 * Two acquisition modes, because the writers have genuinely different needs:
 *
 * - `run()` queues. Correct for one-shot writers that must eventually happen.
 * - `tryRun()` skips when the lock is busy. Correct for *pollers*: the dialog
 *   dismisser re-checks every 5s, so skipping this cycle costs one tick, whereas
 *   queueing it behind a delivery that is waiting on a wedged pane could defer it
 *   for as long as that wait lasts. A poller that queues is a poller that can
 *   pile up; a poller that skips cannot.
 */
export class PaneWriteLock {
  private tail: Promise<unknown> = Promise.resolve();
  /** Writers queued **or** running. `run()` increments before it awaits anything,
   *  so a writer is visible to `tryRun()` from the moment it is admitted — not
   *  only once the microtask queue gets around to starting it. */
  private pending = 0;

  /** True while any writer holds or is waiting for the pane. */
  get isBusy(): boolean {
    return this.pending > 0;
  }

  /**
   * Run `fn` with exclusive access, queueing behind any writer already admitted.
   * Rejections propagate to *this* caller only — the internal chain is always
   * left resolved so one failed write cannot wedge every later one.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    // Decrement inside the writer, not on the tail chain: a caller that awaits its
    // own write and then asks `isBusy` must see the pane free, rather than busy for
    // one extra microtask because the bookkeeping trailed the result.
    const result = this.tail.then(async () => {
      try {
        return await fn();
      } finally {
        this.pending--;
      }
    });
    // Settle on the chain, not on the returned promise: the caller still sees the
    // rejection, but the next queued writer sees a resolved predecessor.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Run `fn` only if the pane is free right now. Returns `false` without calling
   * `fn` when another writer is queued or running, so periodic callers can simply
   * try again on their next tick instead of accumulating a backlog.
   */
  async tryRun(fn: () => Promise<void>): Promise<boolean> {
    if (this.isBusy) return false;
    await this.run(fn);
    return true;
  }
}
