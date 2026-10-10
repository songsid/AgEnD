// One stream of reads under a lease (moved from panel-view.js for #1523 N3: View's pane and roster, and the usage
// dialog every page's header opens, share it).
/**
 * One stream of reads under a lease (the pane, the roster, usage): one at a time, and only the newest may land. A tick
 * while a read is on its way is skipped; a forced read (Refresh), or one started after the last has hung STUCK_MS,
 * supersedes it — and a superseded read's answer is dropped at every step: its response, its body, its commit
 * (#1448 review: an interval alone starts overlapping reads, and lease.current() only tells navigations apart).
 */
const STUCK_MS = 10_000;
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
export function readStream(lease) {
  let gen = 0, busy = false, since = 0;
  return {
    /** A token for a new read, or 0 when this one should not start. */
    begin(force = false) {
      const at = clock();
      if (busy && !force && at - since < STUCK_MS) return 0;
      busy = true; since = at;
      return ++gen;
    },
    /** May this read still land? */
    live: (token) => token === gen && lease.current(),
    end(token) { if (token === gen) busy = false; },
  };
}

