/** Same company-join request only: one initial approval plus at most eight 2–6s jittered retries.
 * The caller owns current(): invalidate it on session/request/navigation changes. This is presentation orchestration,
 * never an enrollment permit. Each approval still asks the Hub. The immutable outer deadline is never extended.
 */
export function createJoinApprovalQueue(options) {
  const { requestId, csrf, deadline } = options;
  const approve = options.approve.bind(options), current = options.current?.bind(options) || (() => true);
  const changed = options.onChange?.bind(options) || (() => {}), now = options.now?.bind(options) || (() => Date.now());
  const random = options.random?.bind(options) || (() => Math.random());
  let stopped = false, flight = null;
  const retired = () => ({ ok: false, code: "retired" });
  // A local timer cannot prove nothing was issued. The caller must read the authoritative join projection.
  const timedOut = () => ({ ok: false, code: "unavailable", deadline: true });
  const live = () => { try { return !stopped && current() === true; } catch { return false; } };
  const emit = (event) => { if (live()) { try { changed(event); } catch { /* a renderer's own failure */ } } };
  const finish = (mine, result, phase) => {
    if (flight !== mine) return;
    clearTimeout(mine.retryTimer); clearTimeout(mine.deadlineTimer); mine.abort?.abort(); flight = null;
    if (live()) emit({ phase, attempts: mine.attempts });
    // A synchronous observer may itself retire the page/session.
    mine.resolve(live() ? result : retired());
  };
  const step = async (mine) => {
    if (flight !== mine) return;
    if (!live()) { finish(mine, retired(), "retired"); return; }
    if (now() >= deadline) { finish(mine, timedOut(), "uncertain"); return; }
    mine.attempts++;
    if (mine.attempts === 1) emit({ phase: "approving", attempts: mine.attempts });
    if (!live()) { finish(mine, retired(), "retired"); return; }
    let answer;
    try { answer = await approve(requestId, csrf, mine.abort?.signal); }
    catch { answer = { ok: false, code: "unavailable" }; }
    if (flight !== mine) return;
    if (!live()) { finish(mine, retired(), "retired"); return; }
    if (now() >= deadline) { finish(mine, timedOut(), "uncertain"); return; }
    if (answer?.ok === true) { finish(mine, answer, "done"); return; }
    const busy = answer?.code === "backpressure" && (answer.reason === undefined || answer.reason === "backpressure");
    if (!busy || mine.attempts >= 9) { finish(mine, answer || { ok: false, code: "unavailable" }, "failed"); return; }
    const sample = random(), delay = 2000 + Math.floor((Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0) * 4000);
    emit({ phase: "queued", attempts: mine.attempts, retryInMs: delay });
    if (!live()) { finish(mine, retired(), "retired"); return; }
    mine.retryTimer = setTimeout(() => { mine.retryTimer = null; void step(mine); }, Math.min(delay, deadline - now()));
  };
  return {
    run() {
      if (!live()) return Promise.resolve(retired());
      if (flight) return flight.promise;
      if (!Number.isFinite(deadline) || typeof requestId !== "string" || !requestId || typeof csrf !== "string" || !csrf)
        return Promise.resolve({ ok: false, code: "unavailable" });
      const mine = { attempts: 0, retryTimer: null, deadlineTimer: null,
        abort: typeof AbortController === "function" ? new AbortController() : null, promise: null, resolve: null };
      mine.promise = new Promise(resolve => { mine.resolve = resolve; }); flight = mine;
      if (now() >= deadline) finish(mine, timedOut(), "uncertain");
      else {
        mine.deadlineTimer = setTimeout(() => finish(mine, timedOut(), "uncertain"), deadline - now());
        void step(mine);
      }
      return mine.promise;
    },
    cancel() { stopped = true; if (flight) finish(flight, retired(), "retired"); },
  };
}
