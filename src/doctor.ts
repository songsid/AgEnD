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
    add("Fleet", "error", "fleet.yaml", `invalid: ${(err as Error).message.split("\n")[0]}`);
  }

  const defaultBackend = raw.defaults?.backend ?? "claude-code";
  const backendIds = new Set<string>([defaultBackend]);
  for (const config of Object.values(raw.instances ?? {})) {
    backendIds.add(config.backend ?? defaultBackend);
  }
  for (const id of backendIds) {
    const backend = BACKENDS.find(item => item.id === id);
    if (!backend) {
      add("Prerequisites", "error", `backend ${id}`, "unknown backend");
      continue;
    }
    const result = deps.run(backend.binary, ["--version"]);
    const version = String(result.stdout ?? "").trim().split("\n")[0];
    if (!result.error && result.status === 0) {
      add("Prerequisites", "ok", backend.label, version || `${backend.binary} available`);
    } else {
      add("Prerequisites", "error", backend.label, `${backend.binary} not found`);
    }
  }

  const tmuxVersion = deps.run("tmux", ["-V"]);
  const tmuxAvailable = !tmuxVersion.error && tmuxVersion.status === 0;
  add(
    "Prerequisites",
    tmuxAvailable ? "ok" : "error",
    "tmux",
    tmuxAvailable ? String(tmuxVersion.stdout ?? "").trim() : "not found",
  );
  add(
    "Prerequisites",
    deps.env.TERM ? "ok" : "warn",
    "TERM",
    deps.env.TERM || "not set — TUI rendering may fail",
  );

  if (!service.installed) {
    add("Service", "warn", "installed", "no AgEnD service found — run: agend install");
  } else {
    add("Service", "ok", "installed", `${service.manager}: ${service.path}`);
    add(
      "Service",
      service.enabled === true ? "ok" : "warn",
      "enabled",
      service.enabled == null ? "unknown (service manager unavailable)" : service.enabled ? "yes" : "no — run: agend install",
    );
    add(
      "Service",
      service.active === true ? "ok" : "warn",
      "active",
      service.active == null ? "unknown (service manager unavailable)" : service.active ? "running" : "inactive — run: agend start",
    );
  }

  if (deps.platform === "linux") {
    add(
      "Service",
      deps.env.DBUS_SESSION_BUS_ADDRESS ? "ok" : "warn",
      "D-Bus",
      deps.env.DBUS_SESSION_BUS_ADDRESS
        ? "DBUS_SESSION_BUS_ADDRESS is set"
        : "DBUS_SESSION_BUS_ADDRESS is not set — systemd --user may not work",
    );
  }

  const fleetPidPath = join(dataDir, "fleet.pid");
  const fleetPid = readPid(fleetPidPath);
  const fleetAlive = fleetPid != null && deps.processAlive(fleetPid);
  if (!existsSync(fleetPidPath)) {
    add("Fleet", "warn", "fleet process", "fleet.pid not found — fleet is not running");
  } else if (fleetPid == null) {
    add("Fleet", "error", "fleet process", "fleet.pid is invalid");
  } else if (!fleetAlive) {
    add("Fleet", "error", "fleet process", `PID ${fleetPid} is not alive (stale fleet.pid)`);
  } else {
    add("Fleet", "ok", "fleet process", `PID ${fleetPid} is alive`);
  }

  const sessionName = getTmuxSessionName();
  const tmuxSession = tmuxAvailable
    ? deps.run("tmux", tmuxArgs(["has-session", "-t", sessionName]))
    : null;
  const sessionAlive = !!tmuxSession && !tmuxSession.error && tmuxSession.status === 0;
  add(
    "Fleet",
    sessionAlive ? "ok" : fleetAlive ? "error" : "warn",
    "tmux session",
    sessionAlive ? `${sessionName} exists` : `${sessionName} not found`,
  );

  if (!existsSync(configPath)) {
    add("Fleet", "warn", "instances", `fleet.yaml not found at ${configPath}`);
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
    "instances",
    `${counts.running} running, ${counts.paused} paused, ${counts.stopped} stopped, ${counts.crashed} crashed (${names.length} total)`,
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
      ? `${connected}/${runningNames.length} running instance socket(s) reachable`
      : `${connected}/${runningNames.length} reachable; failed: ${ipcProblems.join(", ")}`,
  );

  return {
    checks,
    errors: checks.filter(check => check.status === "error").length,
    warnings: checks.filter(check => check.status === "warn").length,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["", "  \x1b[1mAgEnD doctor\x1b[0m"];
  let section: DoctorCheck["section"] | undefined;
  for (const check of report.checks) {
    if (check.section !== section) {
      section = check.section;
      lines.push("", `  \x1b[1m${section}\x1b[0m`);
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
      ? `  \x1b[32m✓ Doctor complete\x1b[0m (${report.warnings} warning(s))`
      : `  \x1b[31m✗ Doctor found ${report.errors} error(s)\x1b[0m (${report.warnings} warning(s))`,
    "",
  );
  return lines.join("\n");
}
