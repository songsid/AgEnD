// #1408 §4: what a panel may own while it is mounted, and nothing it can leak.
//
// Every navigation — a new panel, the same panel on another route (View A → B), a language switch, Retry — gets a
// new lease. Work started under a lease asks lease.current() after EVERY await and before any DOM write, title,
// focus or action it publishes; once the lease is superseded or disposed the answer is false and the continuation
// does nothing. An AbortController cannot do this alone: a fetch that already has its body, or an import, still
// resumes. Timers, listeners, fetches and stream subscriptions taken through the lease are released by dispose().
import { useEffect, useMemo, useRef } from "./app-html.js";

let leases = 0;
const live = new Set();            // leases not yet disposed (the leak tests read leaseCount())

export function createLease(timers = globalThis) {
  const id = ++leases;
  let alive = true;
  const timeouts = new Set(), intervals = new Set(), offs = new Set(), aborts = new Set();
  const lease = {
    id,
    current: () => alive,
    /** setTimeout that never fires after dispose, and is cleared by it. */
    timeout(fn, ms) {
      if (!alive) return null;
      const h = timers.setTimeout(() => { timeouts.delete(h); if (alive) fn(); }, ms);
      timeouts.add(h);
      return h;
    },
    interval(fn, ms) {
      if (!alive) return null;
      const h = timers.setInterval(() => { if (alive) fn(); }, ms);
      intervals.add(h);
      return h;
    },
    clear(h) { if (timeouts.delete(h)) timers.clearTimeout(h); if (intervals.delete(h)) timers.clearInterval(h); },
    /** addEventListener, removed on dispose. */
    on(target, type, fn, opts) {
      if (!alive || !target) return () => {};
      target.addEventListener(type, fn, opts);
      const off = () => { if (offs.delete(off)) target.removeEventListener(type, fn, opts); };
      offs.add(off);
      return off;
    },
    /** Keep an unsubscribe function (a stream subscription, a store listener) until dispose. */
    hold(off) { if (!alive) { off(); return off; } offs.add(off); return off; },
    /** fetch with this lease's abort signal. The caller still checks current() after each await. */
    fetch(url, opts = {}) {
      const ac = new AbortController();
      aborts.add(ac);
      return timers.fetch(url, { ...opts, signal: ac.signal }).finally(() => aborts.delete(ac));
    },
    dispose() {
      if (!alive) return;
      alive = false;
      live.delete(lease);
      for (const h of timeouts) timers.clearTimeout(h);
      for (const h of intervals) timers.clearInterval(h);
      for (const off of [...offs]) off();
      for (const ac of aborts) ac.abort();
      timeouts.clear(); intervals.clear(); offs.clear(); aborts.clear();
    },
    /** For the leak tests: what this lease still holds. */
    holding: () => timeouts.size + intervals.size + offs.size + aborts.size,
  };
  live.add(lease);
  return lease;
}

/** Leases created and not yet disposed, across the page (the 50-mount leak tests assert this returns to its base). */
export function leaseCount() { return live.size; }

/**
 * A panel's lease for one navigation: a new one whenever `key` changes (route, language, retry), the old one
 * disposed before the new route's effects run, and the last one disposed on unmount.
 */
export function useLease(key) {
  const prev = useRef(null);
  // The old lease ends the moment the new navigation renders, not one effect later: nothing of A lands after B began.
  const lease = useMemo(() => { if (prev.current) prev.current.dispose(); return (prev.current = createLease()); }, [key]);
  useEffect(() => () => lease.dispose(), [lease]);
  return lease;
}
