/**
 * M-3770 S-246 (design #4480 P3, S-238 option a): `agend install` while a hand-started fleet runs — the hand-over from
 * that fleet to the service, with no path that leaves AgEnD down.
 *
 *  1. Refuse before any stop: the owner is proven (detached-fleet-stop.ts), and the service manager is proven usable
 *     (prepare) right before the stop. A refusal stops nothing.
 *  2. The stop is the guarded one `agend restart` uses: SIGTERM, a graceful wait of up to FLEET_STOP_TIMEOUT_MS, SIGKILL
 *     only to the owner proven again, and nothing started until it is gone (the old way: SIGTERM, two seconds, start).
 *  3. The service starts only once the old fleet has gone and its publication is cleared. If the service can't be
 *     started then, the hand-started fleet is started again, as it was.
 */
import type { DetachedOwner } from "./detached-fleet-stop.js";

export interface HandoverDeps {
  /** Prove the service manager can take the fleet now; throws the reason when it can't. Nothing is stopped by it. */
  prepare(): void;
  /** The hand-started fleet `fleet.pid` publishes, or null. */
  owner(): DetachedOwner | null;
  stop(owner: DetachedOwner): Promise<void>;
  /** Clear the stopped owner's publication; false when another owner published meanwhile (or it can't be read). */
  clear(owner: DetachedOwner): boolean;
  /** Enable and start the service (the old fleet is gone: it signals nothing). Throws when it can't. */
  activate(): void;
  /** Start the hand-started fleet again, detached, as it ran before. */
  restartHandStarted(): void;
  log(line: string): void;
}

export type HandoverOutcome =
  | { ok: true; stopped: boolean }
  /** Nothing was stopped or started. `error`: the service manager's own refusal, for its hints. */
  | { ok: false; stage: "refused"; message: string; error?: unknown }
  /** The stop didn't complete as proven; nothing was started. */
  | { ok: false; stage: "stop"; message: string }
  /** The old fleet was stopped and the service couldn't start: the hand-started fleet was started again (when it ran). */
  | { ok: false; stage: "activate"; message: string; restarted: boolean; error: unknown };

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function handOverToService(d: HandoverDeps): Promise<HandoverOutcome> {
  const owner = d.owner();
  let running = false;
  if (owner) {
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1) return { ok: false, stage: "refused", message: "Invalid detached fleet PID; nothing was stopped or started." };
    const state = owner.inspect();
    if (state === "unknown" || state === "waiting") return { ok: false, stage: "refused", message: "Cannot confirm the hand-started fleet's owner; nothing was stopped or started." };
    running = state === "fleet";
  }
  // Re-proven last before the stop: a manager that can't take the fleet refuses here, with the fleet still running.
  try { d.prepare(); }
  catch (err) { return { ok: false, stage: "refused", message: reason(err), error: err }; }
  if (owner) {
    if (running) {
      d.log("Stopping the hand-started fleet (up to 5 minutes for a graceful shutdown)...");
      try { await d.stop(owner); }
      catch (err) { return { ok: false, stage: "stop", message: `${reason(err)} The service was not started.` }; }
    }
    // A stale publication (its process gone) is cleared the same way: only the bytes first read.
    if (!d.clear(owner)) return { ok: false, stage: "stop", message: "The fleet's owner changed or its fleet.pid can't be read; the service was not started." };
  }
  try { d.activate(); }
  catch (err) {
    if (running) {
      try { d.restartHandStarted(); }
      catch (again) { return { ok: false, stage: "activate", message: `${reason(err)} Starting the fleet again failed too (${reason(again)}); run \`agend start\`.`, restarted: false, error: err }; }
    }
    return { ok: false, stage: "activate", message: reason(err), restarted: running, error: err };
  }
  return { ok: true, stopped: running };
}
