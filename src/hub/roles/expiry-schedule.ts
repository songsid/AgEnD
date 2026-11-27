import type { createHubRoleExpirySettlement, RoleExpiryResult } from "./expiry.js";

const RECHECK_MS = 30_000;
const RETRY_MS = 1_000;

/** Owns one timer and one settlement. Authorization remains in the settlement/role readers. */
export function scheduleHubRoleExpiry(options: {
  expiry: Pick<ReturnType<typeof createHubRoleExpirySettlement>, "nextExpiry" | "settle" | "close">;
  current(): boolean;
  now(): number;
  held(code: string): void;
}) {
  let closed = false, timer: ReturnType<typeof setTimeout> | null = null;
  let flight: Promise<void> | null = null;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const plan = (retry = false) => {
    clear();
    if (closed || flight || !options.current()) return;
    let delay = RETRY_MS;
    if (!retry) {
      try {
        const at = options.expiry.nextExpiry();
        delay = at === null ? RECHECK_MS : Math.min(RECHECK_MS, Math.max(0, at - options.now()));
      } catch { options.held("unavailable"); }
    }
    timer = setTimeout(run, delay);
    timer.unref();
  };
  const run = () => {
    clear();
    if (closed || flight || !options.current()) return;
    let retry = false;
    flight = Promise.resolve().then(() => options.expiry.settle()).then((result: RoleExpiryResult) => {
      retry = !result.ok;
      if (!result.ok && !closed && options.current()) options.held(result.code);
    }, () => {
      retry = true;
      if (!closed && options.current()) options.held("unavailable");
    }).finally(() => { flight = null; plan(retry); });
  };
  run(); // Startup also settles overdue terms; no directory read when none are due.
  return {
    replan() { plan(); },
    async close() { closed = true; clear(); options.expiry.close(); await flight; },
  };
}
