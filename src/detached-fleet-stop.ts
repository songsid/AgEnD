/**
 * A hand-started (detached) fleet, proven by its `fleet.pid` publication and its process identity, and stopped only
 * while that proof holds — the stop `agend restart` has used since #1071 (its branch in cli.ts, whose own rig in
 * tests/fleet-stop-budget-1071.test.ts runs that source), for `agend install` (M-3770 S-246), which once sent SIGTERM,
 * waited two seconds and started the service whether the old fleet had gone or not. The proof is restart's, line for
 * line; tests/service-install-handover-s246.test.ts keeps the two the same.
 *
 * The owner is the process `fleet.pid` names, while:
 *  - the file still holds the same bytes it held when it was first read (a new publication is another owner);
 *  - the process lives with the start time first seen (a recycled PID is not our owner);
 *  - its command line is a fleet start (an argv rewritten while it lives proves nothing: `unknown`).
 * `unknown` authorizes no signal and no start.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { FLEET_STOP_TIMEOUT_MS, stopDetachedOwner, detachedProcessStart, detachedProcessExited, type DetachedOwnerState } from "./fleet-stop-budget.js";
import { isFleetStartCommandLine, readProcessCommandLine } from "./fleet-lock.js";

export interface DetachedOwnerProbes {
  /** The publication's bytes; throws when unreadable. `null`: no file. */
  readPidFile(path: string): string | null;
  /** kill(pid, 0): throws the errno error when it fails. */
  kill0(pid: number): void;
  exited(pid: number): boolean;
  start(pid: number): string | null;
  command(pid: number): string;
}

export const realDetachedOwnerProbes: DetachedOwnerProbes = {
  readPidFile: path => (existsSync(path) ? readFileSync(path, "utf-8") : null),
  kill0: pid => { process.kill(pid, 0); },
  exited: detachedProcessExited,
  start: detachedProcessStart,
  command: readProcessCommandLine,
};

export interface DetachedOwner {
  pid: number;
  /** The publication as first read: only these bytes may be cleaned up after the stop. */
  publication: string;
  inspect(): DetachedOwnerState;
}

/** The owner `pidPath` publishes, or null when nothing is published. `pid` is NaN (or ≤ 1) for an invalid file. */
export function detachedFleetOwner(pidPath: string, probes: DetachedOwnerProbes = realDetachedOwnerProbes): DetachedOwner | null {
  const publication = probes.readPidFile(pidPath);
  if (publication === null) return null;
  const pid = Number(publication.trim());
  let claimedStart: string | null = null;
  const absence = (): DetachedOwnerState | null => {
    try { probes.kill0(pid); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
    return probes.exited(pid) ? "gone" : null;
  };
  const inspect = (): DetachedOwnerState => {
    try {
      const now = probes.readPidFile(pidPath);
      if (now !== null && now !== publication) return "unknown";
    } catch { return "unknown"; }
    const missing = absence();
    if (missing) return missing;
    const start = probes.start(pid);
    if (start === null) return absence() ?? "unknown";
    const command = probes.command(pid);
    if (!command) return absence() ?? (claimedStart !== null && start === claimedStart ? "waiting" : "unknown");
    const fleet = isFleetStartCommandLine(command);
    if (claimedStart !== null && start !== claimedStart) return fleet ? "unknown" : "other";
    // The claimed process is still alive: rewritten argv is not exit proof.
    if (claimedStart !== null && !fleet) return "unknown";
    claimedStart ??= start;
    return fleet ? "fleet" : "other";
  };
  return { pid, publication, inspect };
}

export interface ProvenStopDeps {
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export const realProvenStopDeps: ProvenStopDeps = {
  signal: (pid, signal) => { process.kill(pid, signal); },
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  log: line => console.log(line),
};

/**
 * Stop the proven owner: SIGTERM, up to FLEET_STOP_TIMEOUT_MS for a graceful exit, then SIGKILL — each signal only after
 * the owner is proven again at that moment. Resolves once it is gone; throws (nothing more signalled, nothing started)
 * when the proof is lost.
 */
export async function stopProvenFleet(owner: DetachedOwner, deps: ProvenStopDeps = realProvenStopDeps): Promise<void> {
  await stopDetachedOwner({
    inspect: owner.inspect,
    signal: signal => {
      if (signal === "SIGKILL") deps.log("  ⚠ Grace expired; forcing the confirmed fleet owner to exit.");
      // stdout can block. The helper's earlier proof cannot authorize a signal after that write; prove the exact owner
      // again now.
      const now = owner.inspect();
      if (now === "gone" || now === "other") return;
      if (now !== "fleet") throw new Error("Detached fleet ownership changed before signalling; refusing the signal");
      try { deps.signal(owner.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    },
    now: deps.now,
    sleep: deps.sleep,
  });
}

/**
 * After the owner is gone: remove its publication if it is still the one first read (or already gone). False when a
 * new owner published meanwhile, or the file can't be read — nothing may start then.
 */
export function clearStoppedPublication(pidPath: string, owner: DetachedOwner, probes: Pick<DetachedOwnerProbes, "readPidFile"> & { unlink(path: string): void } = { ...realDetachedOwnerProbes, unlink: unlinkSync }): boolean {
  let current: string | null;
  try { current = probes.readPidFile(pidPath); } catch { return false; }
  if (current !== null && current !== owner.publication) return false;
  try { probes.unlink(pidPath); } catch { /* the old owner already removed it */ }
  return true;
}

export { FLEET_STOP_TIMEOUT_MS };
