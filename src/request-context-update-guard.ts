/** Cutover is never part of a trial update. Hold both updater exclusions through the SQLite COMMIT. */
import { readFileSync } from "node:fs";
import { acquireHomeUpdateLock, homeUpdateLockHolder } from "./home-update-lock.js";
import type { InstallLockDeps } from "./install-lock.js";
import { takeSharedLease } from "./state-lease.js";
import { readCurrent } from "./update-journal.js";

export interface RequestContextActivationLease {
  /** Recheck inside the activation transaction immediately before COMMIT. */
  current(): boolean;
  release(): void;
}
export function requestContextUpdateSettled(home: string): boolean {
  const read = readCurrent(home);
  return read.state === "none" || read.state === "closing" && read.attempt.stage === "committed";
}
/**
 * The caller supplies an actually held Fleet lease, never a config flag. This excludes legacy in-process rollback
 * even when current is absent. It does not finish a closing attempt, reclaim a stale updater or close Go back.
 * Go back invalidation belongs in the activation's own durable transaction, not a separate retained.json write.
 */
export function acquireRequestContextActivationLease(home: string, installPrefix: string, deps: InstallLockDeps,
  fleet: { current(): boolean }): RequestContextActivationLease | null {
  if (!fleet.current() || homeUpdateLockHolder(home, deps).state !== "free") return null;
  const homeLock = acquireHomeUpdateLock(home, { spec: "request-context activation", installPrefix }, deps);
  if (!homeLock.ok) return null;
  let bytes: string;
  try { bytes = readFileSync(homeLock.path, "utf8"); }
  catch { homeLock.release(); return null; }
  const shared = takeSharedLease(home, "request-context activation", { busyMs: 0 });
  if (!shared.ok) { homeLock.release(); return null; }
  let released = false;
  const current = () => {
    if (released) return false;
    try { return fleet.current() && readFileSync(homeLock.path, "utf8") === bytes && requestContextUpdateSettled(home); }
    catch { return false; }
  };
  const release = () => { if (released) return; released = true; shared.lease.release(); homeLock.release(); };
  if (!current()) { release(); return null; }
  return { current, release };
}
