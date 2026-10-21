/**
 * #2356: which AgEnD systemd unit, if any, a process belongs to, read from its own /proc/<pid>/cgroup (cgroup v2 `0::`
 * and v1 `N:name=systemd:` rows alike). The process's cgroup is the manager's own answer: a unit file on disk, an
 * INVOCATION_ID in the environment or a parent pid only suggest it.
 */
export type AgendSystemdUnit = "com.agend.fleet" | "agend";

export function agendSystemdUnitOf(cgroupText: string): AgendSystemdUnit | null {
  for (const row of cgroupText.split("\n")) {
    const path = row.split(":").slice(2).join(":");
    const hit = /\/(com\.agend\.fleet|agend)\.service(?:\/|$)/.exec(path);
    if (hit) return hit[1] as AgendSystemdUnit;
  }
  return null;
}

/**
 * The exit code of a SIGUSR1 full reload (a `fleet restart --reload` from an AgEnD before #2356, or a hand-sent
 * signal). Under an AgEnD unit a clean exit is a stop: Restart=on-failure leaves the fleet down. EX_TEMPFAIL there
 * makes systemd bring the unit back with the new code. Elsewhere 0: launchd's KeepAlive restarts on any exit, and a
 * detached fleet's reloader starts the next one itself.
 */
export const FULL_RELOAD_UNDER_SYSTEMD_EXIT_CODE = 75;

export function fullReloadExitCode(ownCgroupText: string | null): number {
  return ownCgroupText !== null && agendSystemdUnitOf(ownCgroupText) ? FULL_RELOAD_UNDER_SYSTEMD_EXIT_CODE : 0;
}
