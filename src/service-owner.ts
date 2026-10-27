import { resolve } from "node:path";

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
 * #2741: the systemd service unit a process runs in (its innermost `<name>.service` cgroup), whatever it is called; null
 * for a scope (a login shell, a terminal tab) or no systemd cgroup.
 */
export function systemdServiceOf(cgroupText: string): string | null {
  for (const row of cgroupText.split("\n")) {
    const fields = row.split(":");
    if (fields[0] !== "0" && !fields[1]?.split(",").includes("name=systemd")) continue;
    const units = fields.slice(2).join(":").split("/").filter(part => /\.(service|scope)$/.test(part));
    const inner = units.at(-1);
    if (inner?.endsWith(".service")) return inner.slice(0, -".service".length);
  }
  return null;
}

/**
 * This `fleet start` runs under the service manager: the AgEnD unit's ExecStart (the process is in that unit's
 * cgroup), or the launchd job (launchd names the job in XPC_SERVICE_NAME, and is the parent). Whatever that fleet runs
 * shares the answer (an agent's pane inherits the cgroup and the variable): a `fleet start` typed there is not handed
 * over, and the fleet's singleton lock refuses it while that fleet runs. Anything else is a hand-run.
 *
 * #2741: a unit of any name counts when systemd waits for it to notify (Type=notify: NOTIFY_SOCKET is set, and the
 * process is in a service's cgroup) — that is a unit whose ExecStart is this fleet, e.g. a second fleet's own
 * `my-second-fleet.service`. Handing it over would exit before READY and loop on Result=protocol. A shell never has
 * NOTIFY_SOCKET (the fleet keeps it from what it starts: sd-notify.ts), and a terminal tab is a scope, not a service.
 */
export function startedByServiceManager(o: {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; ownCgroup: string | null; ppid: number; launchdLabel: string;
}): boolean {
  if (o.platform === "darwin") return o.env.XPC_SERVICE_NAME === o.launchdLabel || o.ppid === 1;
  if (o.ownCgroup === null) return false;
  if (agendSystemdUnitOf(o.ownCgroup) !== null) return true;
  return !!o.env.NOTIFY_SOCKET && systemdServiceOf(o.ownCgroup) !== null;
}

/**
 * #2741: does the installed service run THIS AgEnD home? Its definition names a home (AGEND_HOME, written for a
 * non-default one), else it runs the default one. Unknown (an unreadable definition, one whose home is not read here:
 * serviceDefinitionHome, or an unknown default home) is not
 * "different": the hand-over goes ahead as before. A fleet of another home is never handed to that service — it would
 * start or stop the other fleet and leave this one as it was.
 */
export function serviceRunsHome(o: { serviceHome: string | null; defaultHome: string | null; ownHome: string; definitionRead: boolean }): boolean {
  if (!o.definitionRead) return true;
  const home = o.serviceHome ?? o.defaultHome;
  if (home === null) return true;
  return resolve(home) === resolve(o.ownHome);
}

/**
 * #2356: does a no-instance `fleet start` / `fleet stop` hand over to `agend start` / `agend stop`? Only on a host with
 * an AgEnD service installed, and never for the manager's own start or AgEnD's marked detached start. Nothing runs
 * `fleet stop` for the manager (the units have no ExecStop), so a stop with a service installed always hands over.
 */
export function redirectsToService(o: {
  command: "start" | "stop"; directMarker: boolean; byServiceManager: boolean; installedServicePath: string | null;
  /** #2741: the installed service runs this process's AgEnD home (serviceRunsHome). */
  sameHome: boolean;
}): boolean {
  if (!o.installedServicePath || !o.sameHome) return false;
  if (o.command === "stop") return true;
  return !o.directMarker && !o.byServiceManager;
}
