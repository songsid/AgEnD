/**
 * #2481: the first thing `fleet start` does — before the rest of dist/cli.js's module graph is evaluated (this is its
 * first import), so a fleet that dies anywhere later in its start still counts the attempt. See start-failure.ts.
 * Every other command, and any failure here, does nothing: recording an attempt must never stop a start.
 */
import { fleetLockHeldByAnother } from "./fleet-lock.js";
import { getAgendHome } from "./paths.js";
import { notifyChatOnce, notifyOnce, ownPackage, recordStartAttempt } from "./start-failure.js";

/**
 * Record this `fleet start` as an attempt of `version`, then the notices due. #2490: not one that will be refused
 * because another live fleet holds the lock — it is no failed start, and counted it would make the next genuine start
 * look like a crash loop. False when nothing was recorded.
 */
export function recordFleetStartAttempt(home: string, version: string, now: number, deps: {
  lockHeld?: (home: string) => boolean; notify?: typeof notifyOnce; notifyChat?: typeof notifyChatOnce;
} = {}): boolean {
  if ((deps.lockHeld ?? fleetLockHeldByAnother)(home)) return false;
  (deps.notify ?? notifyOnce)(home, recordStartAttempt(home, version, now));
  (deps.notifyChat ?? notifyChatOnce)(home, version, now); // #2490: the same failure in General or the admin's DM, once per version
  return true;
}

if (process.argv[2] === "fleet" && process.argv[3] === "start") {
  try {
    const version = ownPackage().version;
    if (version) recordFleetStartAttempt(getAgendHome(), version, Date.now());
  } catch { /* never in the way of a start */ }
}
