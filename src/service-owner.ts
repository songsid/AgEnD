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

/**
 * #2356: AgEnD's own detached `fleet start` (from `agend start` with no service, or a detached `agend restart`) is
 * marked so it starts directly; the fleet deletes the marker at once, so nothing it launches (an agent's shell) has it.
 */
export const DIRECT_FLEET_START_ENV = "AGEND_FLEET_START_DIRECT";

/**
 * This `fleet start` runs under the service manager: the AgEnD unit's ExecStart (the process is in that unit's
 * cgroup), or the launchd job (launchd names the job in XPC_SERVICE_NAME, and is the parent). Whatever that fleet runs
 * shares the answer (an agent's pane inherits the cgroup and the variable): a `fleet start` typed there is not handed
 * over, and the fleet's singleton lock refuses it while that fleet runs. Anything else is a hand-run.
 */
export function startedByServiceManager(o: {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; ownCgroup: string | null; ppid: number; launchdLabel: string;
}): boolean {
  if (o.platform === "darwin") return o.env.XPC_SERVICE_NAME === o.launchdLabel || o.ppid === 1;
  return o.ownCgroup !== null && agendSystemdUnitOf(o.ownCgroup) !== null;
}

/**
 * #2356: does a no-instance `fleet start` / `fleet stop` hand over to `agend start` / `agend stop`? Only on a host with
 * an AgEnD service installed, and never for the manager's own start or AgEnD's marked detached start. Nothing runs
 * `fleet stop` for the manager (the units have no ExecStop), so a stop with a service installed always hands over.
 */
export function redirectsToService(o: {
  command: "start" | "stop"; directMarker: boolean; byServiceManager: boolean; installedServicePath: string | null;
}): boolean {
  if (!o.installedServicePath) return false;
  if (o.command === "stop") return true;
  return !o.directMarker && !o.byServiceManager;
}
