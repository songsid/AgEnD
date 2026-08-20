import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import net from "node:net";
import { loadRawFleetConfig } from "./config.js";
import { hasPausedMarker } from "./pause-marker.js";
import { getTmuxSessionName, getTmuxSocketName } from "./paths.js";
import { BACKENDS } from "./setup-wizard.js";
import type { ServiceInfo } from "./service-installer.js";
import { t } from "./locale.js";

export type DoctorCheckStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  section: "Prerequisites" | "Service" | "Fleet" | "MCP IPC";
  status: DoctorCheckStatus;
  label: string;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  errors: number;
  warnings: number;
}

interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  run: (file: string, args: string[]) => SpawnSyncReturns<string>;
  processAlive: (pid: number) => boolean;
  connectSocket: (path: string) => Promise<boolean>;
}

const defaultDeps: DoctorDeps = {
  env: process.env,
  platform: platform(),
  run: (file, args) => spawnSync(file, args, { encoding: "utf8", timeout: 5000 }),
  processAlive: pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  connectSocket: connectUnixSocket,
};

function tmuxArgs(args: string[]): string[] {
  const socket = getTmuxSocketName();
  return socket ? ["-L", socket, ...args] : args;
}

function readPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function hasCrashLoop(dataDir: string, name: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, "instances", name, "crash-state.json"), "utf8"));
    return Number(value?.crashesInWindow) >= 3;
  } catch {
    return false;
  }
}

export async function connectUnixSocket(path: string, timeoutMs = 1000): Promise<boolean> {
  if (!existsSync(path)) return false;
  return new Promise(resolve => {
    const client = net.createConnection(path);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
  });
}

/** Collect read-only diagnostics. Dependencies are injectable for deterministic tests. */
export async function collectDoctorReport(
  dataDir: string,
  service: ServiceInfo,
  overrides: Partial<DoctorDeps> = {},
): Promise<DoctorReport> {
  const deps = { ...defaultDeps, ...overrides };
  const checks: DoctorCheck[] = [];
  const add = (section: DoctorCheck["section"], status: DoctorCheckStatus, label: string, detail: string) => {
    checks.push({ section, status, label, detail });
  };
  const configPath = join(dataDir, "fleet.yaml");
  let raw: ReturnType<typeof loadRawFleetConfig> = {};
  try {
    raw = loadRawFleetConfig(configPath);
  } catch (err) {
    add("Fleet", "error", "fleet.yaml", t("doctor.config_invalid", (err as Error).message.split("\n")[0]));
  }

  const defaultBackend = raw.defaults?.backend ?? "claude-code";
  const backendIds = new Set<string>([defaultBackend]);
  for (const config of Object.values(raw.instances ?? {})) {
    backendIds.add(config.backend ?? defaultBackend);
  }
  for (const id of backendIds) {
    // `mock` is an in-process test backend and deliberately has no CLI binary.
    if (id === "mock") continue;
    const backend = BACKENDS.find(item => item.id === id);
    if (!backend) {
      add("Prerequisites", "error", t("doctor.backend_label", id), t("doctor.backend_unknown"));
      continue;
    }
    const result = deps.run(backend.binary, ["--version"]);
    const version = String(result.stdout ?? "").trim().split("\n")[0];
    if (!result.error && result.status === 0) {
      add("Prerequisites", "ok", backend.label, version || t("doctor.binary_available", backend.binary));
    } else {
      add("Prerequisites", "error", backend.label, t("doctor.binary_missing", backend.binary));
    }
  }

  const tmuxVersion = deps.run("tmux", ["-V"]);
  const tmuxAvailable = !tmuxVersion.error && tmuxVersion.status === 0;
  add(
    "Prerequisites",
    tmuxAvailable ? "ok" : "error",
    "tmux",
    tmuxAvailable ? String(tmuxVersion.stdout ?? "").trim() : t("doctor.not_found"),
  );
  add(
    "Prerequisites",
    deps.env.TERM ? "ok" : "warn",
    "TERM",
    deps.env.TERM || t("doctor.term_unset"),
  );

  if (!service.installed) {
    add("Service", "warn", t("doctor.service_installed"), t("doctor.service_none"));
  } else {
    const managerUnavailable = service.manager === "systemd --user"
      ? t("doctor.manager_user_unavailable")
      : t("doctor.manager_unavailable");
    add("Service", "ok", t("doctor.service_installed"), `${service.manager}: ${service.path}`);
    add(
      "Service",
      service.enabled === true ? "ok" : "warn",
      t("doctor.service_enabled"),
      service.enabled == null ? managerUnavailable : service.enabled ? t("doctor.yes") : t("doctor.no_install"),
    );
    add(
      "Service",
      service.active === true ? "ok" : "warn",
      t("doctor.service_active"),
      service.active == null ? managerUnavailable : service.active ? t("doctor.service_running") : t("doctor.inactive_start"),
    );
  }

  if (deps.platform === "linux") {
    add(
      "Service",
      deps.env.DBUS_SESSION_BUS_ADDRESS ? "ok" : "warn",
      "D-Bus",
      deps.env.DBUS_SESSION_BUS_ADDRESS
        ? t("doctor.dbus_set")
        : t("doctor.dbus_unset"),
    );
  }

  const fleetPidPath = join(dataDir, "fleet.pid");
  const fleetPid = readPid(fleetPidPath);
  const fleetAlive = fleetPid != null && deps.processAlive(fleetPid);
  if (!existsSync(fleetPidPath)) {
    add("Fleet", "warn", t("doctor.fleet_process"), t("doctor.pid_missing"));
  } else if (fleetPid == null) {
    add("Fleet", "error", t("doctor.fleet_process"), t("doctor.pid_invalid"));
  } else if (!fleetAlive) {
    add("Fleet", "error", t("doctor.fleet_process"), t("doctor.pid_stale", fleetPid));
  } else {
    add("Fleet", "ok", t("doctor.fleet_process"), t("doctor.pid_alive", fleetPid));
  }

  const sessionName = getTmuxSessionName();
  const tmuxSession = tmuxAvailable
    ? deps.run("tmux", tmuxArgs(["has-session", "-t", sessionName]))
    : null;
  const sessionAlive = !!tmuxSession && !tmuxSession.error && tmuxSession.status === 0;
  add(
    "Fleet",
    sessionAlive ? "ok" : fleetAlive ? "error" : "warn",
    t("doctor.tmux_session"),
    sessionAlive ? t("doctor.session_exists", sessionName) : t("doctor.session_missing", sessionName),
  );

  if (!existsSync(configPath)) {
    add("Fleet", "warn", t("doctor.instances"), t("doctor.config_missing", configPath));
  }
  const names = Object.keys(raw.instances ?? {});
  const counts = { running: 0, paused: 0, stopped: 0, crashed: 0 };
  const runningNames: string[] = [];
  for (const name of names) {
    const instanceDir = join(dataDir, "instances", name);
    if (hasPausedMarker(instanceDir)) {
      counts.paused++;
      continue;
    }
    if (hasCrashLoop(dataDir, name)) {
      counts.crashed++;
      continue;
    }
    const pid = readPid(join(instanceDir, "daemon.pid"));
    if (pid != null && deps.processAlive(pid)) {
      counts.running++;
      runningNames.push(name);
    } else {
      counts.stopped++;
    }
  }
  add(
    "Fleet",
    "ok",
    t("doctor.instances"),
    t("doctor.instance_counts", counts.running, counts.paused, counts.stopped, counts.crashed, names.length),
  );

  const ipcResults = await Promise.all(runningNames.map(async name => {
    const socketPath = join(dataDir, "instances", name, "channel.sock");
    return { name, socketPath, exists: existsSync(socketPath), connected: await deps.connectSocket(socketPath) };
  }));
  const connected = ipcResults.filter(result => result.connected).length;
  const missing = ipcResults.filter(result => !result.exists).map(result => result.name);
  const unreachable = ipcResults.filter(result => result.exists && !result.connected).map(result => result.name);
  const ipcProblems = [...missing, ...unreachable];
  add(
    "MCP IPC",
    ipcProblems.length === 0 ? "ok" : "error",
    "channel.sock",
    ipcProblems.length === 0
      ? t("doctor.ipc_ok", connected, runningNames.length)
      : t("doctor.ipc_failed", connected, runningNames.length, ipcProblems.join(", ")),
  );

  return {
    checks,
    errors: checks.filter(check => check.status === "error").length,
    warnings: checks.filter(check => check.status === "warn").length,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const sectionLabels: Record<DoctorCheck["section"], string> = {
    Prerequisites: t("doctor.section.prerequisites"),
    Service: t("doctor.section.service"),
    Fleet: t("doctor.section.fleet"),
    "MCP IPC": t("doctor.section.ipc"),
  };
  const lines = ["", `  \x1b[1m${t("doctor.title")}\x1b[0m`];
  let section: DoctorCheck["section"] | undefined;
  for (const check of report.checks) {
    if (check.section !== section) {
      section = check.section;
      lines.push("", `  \x1b[1m${sectionLabels[section]}\x1b[0m`);
    }
    const icon = check.status === "ok"
      ? "\x1b[32m✓\x1b[0m"
      : check.status === "warn"
        ? "\x1b[33m⚠\x1b[0m"
        : "\x1b[31m✗\x1b[0m";
    lines.push(`  ${icon} ${check.label}: ${check.detail}`);
  }
  lines.push(
    "",
    report.errors === 0
      ? `  \x1b[32m✓ ${t("doctor.complete", report.warnings)}\x1b[0m`
      : `  \x1b[31m✗ ${t("doctor.errors", report.errors, report.warnings)}\x1b[0m`,
    "",
  );
  return lines.join("\n");
}
