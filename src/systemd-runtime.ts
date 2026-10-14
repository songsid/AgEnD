import type { CommandResult } from "./update-install.js";
import { peerUnreachable, type PeerBus } from "./systemd-peer-bus.js";

/** Runtime evidence is independent of the definition on disk. Unknown is never stopped. */
export interface SystemdRuntime {
  active: string;
  sub: string;
  pid: number;
  control: number;
  job: number;
  type: string;
  killMode: string;
  sendSigkill: boolean;
}

/**
 * #1804: busctl could not reach the bus at all — no D-Bus user bus (a host without dbus-user-session, where systemctl
 * still reaches the manager through `$XDG_RUNTIME_DIR/systemd/private`, a peer socket busctl cannot use: it always sends
 * Hello(), which that socket answers with "Invalid request descriptor"), or no busctl to run. Only then do the readers
 * turn to the private socket (systemd-peer-bus.ts); any other busctl failure keeps its bus-path meaning.
 */
export function busUnreachable(result: CommandResult): boolean {
  if (result.signal !== null) return false;
  if (result.status === null) return true;
  return result.status !== 0 && /^Failed to connect to bus\b/m.test(result.stderr);
}

/** One line for a failed command: how it ended, then the first line it printed. */
export function commandFailure(result: CommandResult): string {
  const said = (result.stderr || result.stdout).trim().split("\n", 1)[0] ?? "";
  return `${result.signal ? `killed by ${result.signal}` : result.status === null ? "did not run" : `exited ${result.status}`}${said ? `: ${said}` : ""}`;
}

/** The D-Bus channel for one reader: busctl, or — only when busctl cannot reach a bus — the private socket. */
export type SystemdChannel = { ok: true; call: (args: string[]) => CommandResult; objectPath: string } | { ok: false; reason: string };

/**
 * #1804: load `name` (LoadUnit) over busctl; if busctl cannot reach a bus at all, over the manager's private socket
 * through `peer` (systemdPeerBus), and every later read of this unit goes the same way. Each failure says which:
 * neither reachable, the call refused on a reachable channel, or no private socket offered.
 */
export function systemdChannel(run: (command: string, args: string[]) => CommandResult, user: boolean, name: string, peer?: PeerBus): SystemdChannel {
  const scope = user ? ["--user"] : [];
  const loadUnit = ["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "LoadUnit", "s", name];
  const viaBusctl = (args: string[]) => run("busctl", [...scope, "--json=short", ...args]);
  const objectPath = (r: CommandResult): string | null => {
    if (r.status !== 0 || r.signal !== null) return null;
    try {
      const parsed = JSON.parse(r.stdout) as { type?: unknown; data?: unknown };
      const path = parsed.type === "o" && Array.isArray(parsed.data) && parsed.data.length === 1 ? parsed.data[0] : null;
      return typeof path === "string" && path.startsWith("/org/freedesktop/systemd1/unit/") ? path : null;
    } catch { return null; }
  };
  const viaBus = viaBusctl(loadUnit);
  if (!busUnreachable(viaBus)) {
    const path = objectPath(viaBus);
    return path ? { ok: true, call: viaBusctl, objectPath: path } : { ok: false, reason: `busctl could not load ${name} (${commandFailure(viaBus)})` };
  }
  const bus = `the D-Bus ${user ? "user " : ""}bus cannot be reached (busctl ${commandFailure(viaBus)})`;
  if (!peer) return { ok: false, reason: `${bus}, and systemd's private socket was not tried` };
  const viaPeer = (args: string[]) => peer(user, args);
  const loaded = viaPeer(loadUnit);
  if (peerUnreachable(loaded)) return { ok: false, reason: `neither busctl nor the systemd${user ? " --user" : ""} manager's private socket can be reached (busctl ${commandFailure(viaBus)}; ${commandFailure(loaded)})` };
  const path = objectPath(loaded);
  return path ? { ok: true, call: viaPeer, objectPath: path } : { ok: false, reason: `${bus}, and systemd could not load ${name} over its private socket (${commandFailure(loaded)})` };
}

/** `peer`: the manager's private socket, for a host where busctl cannot reach a bus (#1804). */
export function readSystemdRuntime(run: (command: string, args: string[]) => CommandResult, user: boolean, unit: string, peer?: PeerBus): SystemdRuntime | null {
  const name = unit.endsWith(".service") ? unit : `${unit}.service`;
  let channel: SystemdChannel;
  try { channel = systemdChannel(run, user, name, peer); } catch { return null; }
  if (!channel.ok) return null;
  const { call, objectPath } = channel;
  const bus = (args: string[], type: string): unknown => {
    try {
      const r = call(args);
      if (r.status !== 0 || r.signal !== null) return null;
      const parsed = JSON.parse(r.stdout) as { type?: unknown; data?: unknown };
      return parsed.type === type ? parsed.data : null;
    } catch { return null; }
  };
  const prop = (iface: string, property: string, type: string) => bus(["get-property", "org.freedesktop.systemd1", objectPath, `org.freedesktop.systemd1.${iface}`, property], type);
  const active = prop("Unit", "ActiveState", "s"), sub = prop("Unit", "SubState", "s");
  const job = prop("Unit", "Job", "(uo)");
  const type = prop("Service", "Type", "s"), killMode = prop("Service", "KillMode", "s");
  const sendSigkill = prop("Service", "SendSIGKILL", "b");
  const control = prop("Service", "ControlPID", "u"), pid = prop("Service", "MainPID", "u");
  const uint = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
  if (typeof active !== "string" || typeof sub !== "string" || typeof type !== "string" || typeof killMode !== "string" ||
      typeof sendSigkill !== "boolean" || !uint(pid) || !uint(control) ||
      !Array.isArray(job) || job.length !== 2 || !uint(job[0]) || typeof job[1] !== "string" ||
      (job[0] === 0 ? job[1] !== "/" : !job[1].startsWith("/org/freedesktop/systemd1/job/"))) return null;
  return { active, sub, pid, control, job: job[0], type, killMode, sendSigkill };
}

// Custom stop modes can forget tracking without killing the old process. Leave them to the operator.
const trackedStop = (s: SystemdRuntime): boolean => ["notify", "simple", "exec"].includes(s.type) &&
  ["mixed", "control-group"].includes(s.killMode) && s.sendSigkill;

export const systemdStopped = (s: SystemdRuntime | null): boolean => !!s && trackedStop(s) &&
  ((s.active === "inactive" && s.sub === "dead") || (s.active === "failed" && s.sub === "failed")) &&
  s.pid === 0 && s.control === 0 && s.job === 0;

export const systemdRunning = (s: SystemdRuntime | null): boolean => !!s && trackedStop(s) &&
  s.active === "active" && s.sub === "running" && s.pid > 0 && s.control === 0 && s.job === 0;
