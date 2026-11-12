/** Accidental-launch/overlap interlock, not an authorization source. Verify the real Leader GO before writing a plan. */
export function requireWindow(plan, sha, now, stopped = false) {
  if (stopped) throw Error('Campaign stopped: overlap or operator stop');
  if (!plan || plan.explicitGo !== true || typeof plan.goReference !== 'string' || !plan.goReference.startsWith('xmsg-')) throw Error('Explicit later Leader GO required');
  if (!/^[0-9a-f]{40}$/.test(sha) || plan.source !== sha) throw Error('Source SHA differs from approved campaign plan');
  if (!Number.isSafeInteger(plan.from) || !Number.isSafeInteger(plan.until) || plan.until <= plan.from || plan.until - plan.from > 2 * 60 * 60_000) throw Error('Invalid bounded campaign window');
  if (now < plan.from || now >= plan.until) throw Error('Outside the allocated campaign window');
  if (!/^2\.3\.\d+(?:-(?:alpha|beta)\.\d+)?$/.test(plan.version)) throw Error('Explicit 2.3.x source-build version stamp required');
  return plan;
}
export const phases = ['protocol', 'ui-capacity', 'rollback'];
/** Host budget requested for the swap-off campaign. /proc's MemAvailable is converted to MiB by the watcher. */
export function requireHostBudget(load, availableMiB) {
  if (!Number.isFinite(load) || !Number.isFinite(availableMiB)) throw Error('Host resource readings unavailable');
  if (load >= 12) throw Error('Host load reached campaign stop ceiling');
  if (availableMiB < 4096) throw Error('Host available memory below 4 GiB');
}
