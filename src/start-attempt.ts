/**
 * #2481: the first thing `fleet start` does — before the rest of dist/cli.js's module graph is evaluated (this is its
 * first import), so a fleet that dies anywhere later in its start still counts the attempt. See start-failure.ts.
 * Every other command, and any failure here, does nothing: recording an attempt must never stop a start.
 */
import { fleetLockHeldByAnother } from "./fleet-lock.js";
import { maybeAutoRestore, type RestoreOutcome } from "./mac-auto-restore.js";
import { getAgendHome } from "./paths.js";
import { notifyChatOnce, notifyOnce, notifyRestore, notifyRestoreFailed, ownPackage, readStartedHistory, recentAttemptCount, recordStartAttempt } from "./start-failure.js";

/**
 * Record this `fleet start` as an attempt of `version`, then what is due. #2490: not one that will be refused because
 * another live fleet holds the lock — it is no failed start, and counted it would make the next genuine start look like
 * a crash loop. #2481: on a Mac whose 2.3.x has crash-looped since an upgrade from 2.2.x, the restore of the kept 2.2.x
 * (mac-auto-restore.ts), with its own notices in place of the plain ones. Null when nothing was recorded.
 */
export function recordFleetStartAttempt(home: string, version: string, now: number, deps: {
  lockHeld?: (home: string) => boolean; notify?: typeof notifyOnce; notifyChat?: typeof notifyChatOnce;
  restore?: (home: string, version: string, attempts: number, history: string[] | "unreadable") => RestoreOutcome;
  restoreFailed?: typeof notifyRestoreFailed;
} = {}): RestoreOutcome | null {
  if ((deps.lockHeld ?? fleetLockHeldByAnother)(home)) return null;
  const record = recordStartAttempt(home, version, now);
  const restore = deps.restore ?? ((h: string, v: string, attempts: number, history: string[] | "unreadable") => {
    const own = ownPackage();
    if (!own.prefix) return { kind: "not-due" } as const;
    return maybeAutoRestore(h, own.root, own.prefix, v, history, attempts, { notify: (from, to, preimage) => notifyRestore(h, from, to, preimage) });
  });
  const outcome = restore(home, version, recentAttemptCount(record, now), readStartedHistory(home));
  // Tried and failed: its notices said a restore was happening — correct them (once), with the way back by hand.
  if (outcome.kind === "failed") (deps.restoreFailed ?? notifyRestoreFailed)(home, outcome.from, outcome.to, outcome.reason, outcome.packageAt);
  if (outcome.kind !== "not-due") return outcome;     // restored (or tried): its notices went out; no plain ones
  (deps.notify ?? notifyOnce)(home, record);
  (deps.notifyChat ?? notifyChatOnce)(home, version, now); // #2490: the same failure in General or the admin's DM, once per version
  return outcome;
}

if (process.argv[2] === "fleet" && process.argv[3] === "start") {
  let restored = false;
  try {
    const version = ownPackage().version;
    if (version) restored = recordFleetStartAttempt(getAgendHome(), version, Date.now())?.kind === "restored";
  } catch { /* never in the way of a start */ }
  // #2481: this package is no longer in place — exit before loading any more of it; launchd starts the restored one.
  if (restored) process.exit(1);
}
