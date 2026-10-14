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

/**
 * #1804: busctl could not reach the bus at all — no D-Bus user bus (a host without dbus-user-session, where systemctl
 * still reaches the manager through `$XDG_RUNTIME_DIR/systemd/private`, a peer socket busctl cannot use: it always sends
 * Hello(), which that socket answers with "Invalid request descriptor"), or no busctl to run. Only then do the readers
 * fall back to systemctl; any other busctl failure keeps its bus-path meaning.
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

/**
 * `systemctl show <unit> --property=…` → each property's printed values (EnvironmentFiles prints one line per file, and
 * none at all when there is none). A non-zero exit means systemctl could not reach the manager: for a unit it does not
 * know, `show` still exits 0 with LoadState=not-found.
 */
export function systemctlShow(run: (command: string, args: string[]) => CommandResult, user: boolean, name: string, properties: string[]):
  { ok: true; values: Map<string, string[]> } | { ok: false; reason: string } {
  const result = run("systemctl", [...(user ? ["--user"] : []), "show", name, `--property=${properties.join(",")}`]);
  if (result.status !== 0 || result.signal !== null) return { ok: false, reason: `systemctl${user ? " --user" : ""} show ${commandFailure(result)}` };
  const values = new Map<string, string[]>();
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq) : "";
    if (!properties.includes(key)) return { ok: false, reason: `systemctl show printed an unexpected line (${JSON.stringify(line.slice(0, 80))})` };
    values.set(key, [...(values.get(key) ?? []), line.slice(eq + 1)]);
  }
  return { ok: true, values };
}

/** The same runtime evidence from `systemctl show`, for a host whose bus busctl cannot reach (#1804). */
function readSystemdRuntimeWithoutBus(run: (command: string, args: string[]) => CommandResult, user: boolean, name: string): SystemdRuntime | null {
  const shown = systemctlShow(run, user, name, ["ActiveState", "SubState", "MainPID", "ControlPID", "Job", "Type", "KillMode", "SendSIGKILL"]);
  if (!shown.ok) return null;
  const one = (key: string): string | null => { const v = shown.values.get(key); return v?.length === 1 ? v[0]! : null; };
  const uint = (text: string | null): number | null => {
    if (text === null || !/^(0|[1-9]\d{0,9})$/.test(text)) return null;
    const n = Number(text);
    return n <= 0xffffffff ? n : null;
  };
  const active = one("ActiveState"), sub = one("SubState"), type = one("Type"), killMode = one("KillMode"), sigkill = one("SendSIGKILL");
  const pid = uint(one("MainPID")), control = uint(one("ControlPID"));
  // systemd 249 prints `Job=` with no job and `Job=<id>` with one queued (never `Job=0`).
  const jobText = one("Job");
  const job = jobText === "" ? 0 : jobText !== null && jobText !== "0" ? uint(jobText) : null;
  if (!active || !sub || !type || !killMode || (sigkill !== "yes" && sigkill !== "no") || pid === null || control === null || job === null) return null;
  return { active, sub, pid, control, job, type, killMode, sendSigkill: sigkill === "yes" };
}

export function readSystemdRuntime(run: (command: string, args: string[]) => CommandResult, user: boolean, unit: string): SystemdRuntime | null {
  const scope = user ? ["--user"] : [];
  const name = unit.endsWith(".service") ? unit : `${unit}.service`;
  const parse = (r: CommandResult, type: string): unknown => {
    try {
      if (r.status !== 0 || r.signal !== null) return null;
      const parsed = JSON.parse(r.stdout) as { type?: unknown; data?: unknown };
      return parsed.type === type ? parsed.data : null;
    } catch { return null; }
  };
  const call = (args: string[]): CommandResult | null => { try { return run("busctl", [...scope, "--json=short", ...args]); } catch { return null; } };
  const bus = (args: string[], type: string): unknown => { const r = call(args); return r && parse(r, type); };
  const load = call(["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "LoadUnit", "s", name]);
  if (!load) return null;
  if (busUnreachable(load)) { try { return readSystemdRuntimeWithoutBus(run, user, name); } catch { return null; } }
  const path = parse(load, "o");
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
