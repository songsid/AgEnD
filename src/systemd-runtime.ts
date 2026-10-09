import type { CommandResult } from "./update-install.js";

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

export function readSystemdRuntime(run: (command: string, args: string[]) => CommandResult, user: boolean, unit: string): SystemdRuntime | null {
  const scope = user ? ["--user"] : [];
  const bus = (args: string[], type: string): unknown => {
    try {
      const r = run("busctl", [...scope, "--json=short", ...args]);
      if (r.status !== 0 || r.signal !== null) return null;
      const parsed = JSON.parse(r.stdout) as { type?: unknown; data?: unknown };
      return parsed.type === type ? parsed.data : null;
    } catch { return null; }
  };
  const name = unit.endsWith(".service") ? unit : `${unit}.service`;
  const path = bus(["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "LoadUnit", "s", name], "o");
  if (!Array.isArray(path) || path.length !== 1 || typeof path[0] !== "string" || !path[0].startsWith("/org/freedesktop/systemd1/unit/")) return null;
  const prop = (iface: string, property: string, type: string) => bus(["get-property", "org.freedesktop.systemd1", path[0] as string, `org.freedesktop.systemd1.${iface}`, property], type);
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
