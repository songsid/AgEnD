/**
 * M-3770 slice 1.3 (design #4480 §4.2): the home lock, `<home>/.update.lock`. The prefix lock (install-lock.ts) keeps
 * two updaters off one npm prefix; two installs on two prefixes never exclude each other through it, yet they may share
 * one AgEnD home. This lock is keyed to the home:
 *   - `agend update` takes it before npm runs and holds it until it exits (with the prefix lock), recording the install
 *     prefix it updates;
 *   - a fleet start on the home takes it too, briefly, before it claims `fleet.lock`. While another install's live
 *     update holds it, the start is refused: a fleet of another install must not take the home mid-update. The update's
 *     own restart — a fleet whose package is under the prefix being updated — is let through.
 * Same owned-lock mechanism as the prefix lock: a holder is replaced only when proven gone, and release removes the
 * file only while it is still exactly ours.
 *
 * A fleet start never fails closed on this lock's own trouble (its file can't be written, its start time can't be read,
 * a record that can't be parsed): it says so and goes on, because `fleet.lock` still keeps one fleet per home and a
 * fleet that can't start is worse. It is refused only for a proven live update of another install.
 */
import { dirname, join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { acquireInstallLock, holderState, parseInstallLock, type InstallLockDeps, type InstallLockRecord } from "./install-lock.js";

export const HOME_UPDATE_LOCK_FILE = ".update.lock";
const NAME = "home update lock";

export const homeUpdateLockPath = (home: string): string => join(home, HOME_UPDATE_LOCK_FILE);

/** `agend update`: take the home lock for this update of the install under `installPrefix`. */
export function acquireHomeUpdateLock(home: string, update: { spec: string; installPrefix: string }, deps: InstallLockDeps) {
  return acquireInstallLock(home, { spec: update.spec, agendHome: home, installPrefix: update.installPrefix }, deps, { file: HOME_UPDATE_LOCK_FILE, name: NAME });
}

export type HomeLockHolder =
  | { state: "free" }
  | { state: "unreadable" }
  | { state: "live" | "stale" | "unknown"; record: InstallLockRecord };

/** Who holds an owned lock file now (the home lock, or a prefix's install lock): a read only; nothing is taken or moved. */
export function lockHolderAt(path: string, deps: Pick<InstallLockDeps, "processStart" | "exists" | "startTicks" | "bootId">): HomeLockHolder {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? { state: "free" } : { state: "unreadable" }; }
  const record = parseInstallLock(text);
  return record ? { state: holderState(record, deps), record } : { state: "unreadable" };
}

/** Who holds the home lock now. */
export const homeUpdateLockHolder = (home: string, deps: Pick<InstallLockDeps, "processStart" | "exists" | "startTicks" | "bootId">): HomeLockHolder =>
  lockHolderAt(homeUpdateLockPath(home), deps);

/** The npm prefix a global install's package directory lives under (`<prefix>/lib/node_modules/@songsid/agend`), or null. */
export function installPrefixOf(packageDir: string | null): string | null {
  if (!packageDir) return null;
  let real: string;
  try { real = realpathSync(packageDir); } catch { return null; }
  const scope = dirname(real), root = dirname(scope), lib = dirname(root);
  if (!/[\\/]agend$/.test(real) || !/[\\/]@songsid$/.test(scope) || !/[\\/]node_modules$/.test(root)) return null;
  const prefix = /[\\/]lib$/.test(lib) ? dirname(lib) : lib;            // POSIX <prefix>/lib/node_modules; Windows <prefix>/node_modules
  try { return realpathSync(prefix); } catch { return prefix; }
}

export type FleetStartAdmission = { ok: true; release(): void; note?: string } | { ok: false; reason: string };

/**
 * A fleet start on `home`, before it claims `fleet.lock`. `ownPrefix`: the install prefix this fleet runs from (null:
 * a checkout or unknown). Free: taken now and released by the caller once `fleet.lock` is held.
 */
export function admitFleetStart(home: string, ownPrefix: string | null, deps: InstallLockDeps): FleetStartAdmission {
  const taken = acquireInstallLock(home, { spec: "fleet start", agendHome: home }, deps, { file: HOME_UPDATE_LOCK_FILE, name: NAME });
  if (taken.ok) return { ok: true, release: taken.release };
  const holder = homeUpdateLockHolder(home, deps);
  if (holder.state === "live" && holder.record.installPrefix !== undefined) {
    if (ownPrefix !== null && holder.record.installPrefix === ownPrefix) return { ok: true, release: () => {}, note: "the update of this install is restarting it" };
    return { ok: false, reason: `An AgEnD update from another install (${holder.record.installPrefix}, pid ${holder.record.pid}, installing ${holder.record.targetSpec}) is running for this home (${home}). This fleet (${ownPrefix ?? "not a global install"}) waits until it finishes; start it again then.` };
  }
  // Anything else is this lock's own trouble (another start's brief hold, an unreadable record, a holder whose start
  // can't be read): fleet.lock still keeps one fleet per home, so the start goes on and says why.
  return { ok: true, release: () => {}, note: `the home update lock could not be taken (${taken.reason}); starting without it` };
}
