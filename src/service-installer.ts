import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import ejs from "ejs";
const { render } = ejs;
import { homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, "..", "templates");

interface ServiceVars {
  label: string;
  execPath: string;
  path?: string;
  workingDirectory: string;
  logPath: string;
  isRoot?: boolean;
}

export function detectPlatform(): "macos" | "linux" {
  return platform() === "darwin" ? "macos" : "linux";
}

// A value ending up inside a systemd unit line (or plist <string>) must not
// contain control characters — a newline would let an attacker close the
// current directive and inject new ones (e.g. ExecStartPost=rm -rf ~).
// The `]]>` guard prevents escaping out of plist CDATA in future templates.
function assertSafeServiceValue(name: string, value: string): void {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(
      `Unsafe service template variable ${name}: contains control characters`,
    );
  }
  if (value.includes("]]>")) {
    throw new Error(
      `Unsafe service template variable ${name}: contains plist CDATA terminator`,
    );
  }
}

function assertAbsolutePath(name: string, value: string): void {
  if (!value.startsWith("/")) {
    throw new Error(`Service template variable ${name} must be an absolute path`);
  }
}

function validateVars(vars: ServiceVars & { path: string }): void {
  assertSafeServiceValue("label", vars.label);
  assertSafeServiceValue("execPath", vars.execPath);
  assertSafeServiceValue("workingDirectory", vars.workingDirectory);
  assertSafeServiceValue("logPath", vars.logPath);
  assertSafeServiceValue("path", vars.path);
  assertAbsolutePath("execPath", vars.execPath);
  assertAbsolutePath("workingDirectory", vars.workingDirectory);
  assertAbsolutePath("logPath", vars.logPath);
  // label is used as a filename component — restrict to safe charset
  if (!/^[A-Za-z0-9._-]+$/.test(vars.label)) {
    throw new Error(`Service label must match [A-Za-z0-9._-]+, got: ${vars.label}`);
  }
}

/**
 * Preserve the caller's PATH order, then append locations commonly omitted by
 * sudo/systemd. The npm-prefix inference is important for root+nvm installs:
 * `agend update` may run with sudo's secure_path even though Codex lives beside
 * the nvm-installed AgEnD binary.
 */
export function buildServicePath(
  basePath = process.env.PATH ?? "",
  execPath = process.argv[1] ?? "",
  homeDir = homedir(),
): string {
  const dirs = basePath
    .split(":")
    .filter(Boolean)
    .filter(p => !p.includes("/mnt/") && !p.includes("Program Files"));
  const moduleMarker = "/lib/node_modules/";
  const markerIndex = execPath.indexOf(moduleMarker);
  const npmPrefixBin = markerIndex >= 0
    ? join(execPath.slice(0, markerIndex), "bin")
    : undefined;
  const nvmBins: string[] = [];
  try {
    const nvmVersions = join(homeDir, ".nvm", "versions", "node");
    for (const version of readdirSync(nvmVersions).sort().reverse()) {
      nvmBins.push(join(nvmVersions, version, "bin"));
    }
  } catch { /* nvm is optional */ }
  const fallbacks = [
    dirname(process.execPath),
    npmPrefixBin,
    ...nvmBins,
    join(homeDir, ".local", "bin"),
    join(homeDir, ".npm-global", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];

  for (const candidate of fallbacks) {
    if (candidate && !dirs.includes(candidate)) dirs.push(candidate);
  }
  return dirs.join(":");
}

function withDefaults(vars: ServiceVars): ServiceVars & { path: string } {
  const path = buildServicePath(vars.path, vars.execPath);
  const full = { ...vars, path, isRoot: vars.isRoot ?? (process.getuid?.() === 0) };
  validateVars(full);
  return full;
}

export function renderLaunchdPlist(vars: ServiceVars): string {
  const template = readFileSync(join(templatesDir, "launchd.plist.ejs"), "utf-8");
  return render(template, withDefaults(vars));
}

export function renderSystemdUnit(vars: ServiceVars): string {
  const template = readFileSync(join(templatesDir, "systemd.service.ejs"), "utf-8");
  return render(template, withDefaults(vars));
}

export interface ServiceInfo {
  installed: boolean;
  path: string | null;
  manager: "systemd --user" | "launchd";
  enabled: boolean | null;
  active: boolean | null;
}

function servicePathForLabel(label: string): string {
  return detectPlatform() === "macos"
    ? join(process.env.HOME ?? homedir(), "Library/LaunchAgents", `${label}.plist`)
    : join(process.env.HOME ?? homedir(), ".config/systemd/user", `${label}.service`);
}

/** Inspect the user service without changing it. `null` means manager unavailable. */
export function inspectService(label = SERVICE_LABEL): ServiceInfo {
  const plat = detectPlatform();
  const path = servicePathForLabel(label);
  const manager = plat === "macos" ? "launchd" : "systemd --user";
  if (!existsSync(path)) return { installed: false, path: null, manager, enabled: null, active: null };

  if (plat === "macos") {
    const uid = process.getuid?.() ?? 501;
    const domain = `gui/${uid}`;
    const activeResult = spawnSync("launchctl", ["print", `${domain}/${label}`], {
      encoding: "utf8",
      timeout: 5000,
    });
    const disabledResult = spawnSync("launchctl", ["print-disabled", domain], {
      encoding: "utf8",
      timeout: 5000,
    });
    const active = activeResult.error || activeResult.status == null ? null : activeResult.status === 0;
    let enabled: boolean | null = null;
    if (!disabledResult.error && disabledResult.status === 0) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      enabled = !new RegExp(`"${escaped}"\\s*=>\\s*true`).test(String(disabledResult.stdout ?? ""));
    }
    return { installed: true, path, manager, enabled, active };
  }

  const activeResult = spawnSync("systemctl", ["--user", "is-active", label], {
    encoding: "utf8",
    timeout: 5000,
  });
  const serviceState = classifySystemdServiceState(activeResult);
  const enabledResult = spawnSync("systemctl", ["--user", "is-enabled", label], {
    encoding: "utf8",
    timeout: 5000,
  });
  const enabledDetails = `${enabledResult.stderr ?? ""} ${enabledResult.error?.message ?? ""}`.toLowerCase();
  const enabled = enabledResult.error
    || enabledResult.status == null
    || /failed to connect to bus|no medium found|transport endpoint|connection refused|system has not been booted/.test(enabledDetails)
    ? null
    : /^enabled(?:-runtime)?$/.test(String(enabledResult.stdout ?? "").trim());
  return {
    installed: true,
    path,
    manager,
    enabled,
    active: serviceState === "unavailable" ? null : serviceState === "running",
  };
}

export function uninstallService(label: string): boolean {
  const plat = detectPlatform();
  const path = servicePathForLabel(label);
  if (!existsSync(path)) return false;

  if (plat === "macos") {
    const uid = process.getuid?.() ?? 501;
    const domain = `gui/${uid}`;
    spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore", timeout: 5000 });
    const disabled = spawnSync("launchctl", ["disable", `${domain}/${label}`], { encoding: "utf8", timeout: 5000 });
    if (disabled.error || disabled.status !== 0) {
      throw new Error(`launchctl could not disable ${label}: ${String(disabled.stderr ?? disabled.error?.message ?? "unknown error").trim()}`);
    }
  } else {
    // `disable --now` both stops the live unit and removes its enablement links.
    // Fail closed before unlinking: deleting the unit after a D-Bus failure can
    // leave an untracked service process running until the next login/reboot.
    const disabled = spawnSync("systemctl", ["--user", "disable", "--now", label], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (disabled.error || disabled.status !== 0) {
      throw new Error(`systemctl could not disable/stop ${label}: ${String(disabled.stderr ?? disabled.error?.message ?? "unknown error").trim()}`);
    }
  }

  unlinkSync(path);
  if (plat === "linux") {
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5000 });
  }
  return true;
}

export function installService(vars: ServiceVars): string {
  const plat = detectPlatform();
  if (plat === "macos") {
    const plistPath = join(
      process.env.HOME!,
      "Library/LaunchAgents",
      `${vars.label}.plist`,
    );
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, renderLaunchdPlist(vars));
    return plistPath;
  } else {
    const unitPath = join(
      process.env.HOME!,
      ".config/systemd/user",
      `${vars.label}.service`,
    );
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, renderSystemdUnit(vars));
    return unitPath;
  }
}

const SERVICE_LABEL = "com.agend.fleet";

export type ServiceState = "running" | "stopped" | "unavailable";

/**
 * Keep service-manager reachability separate from unit state. In particular,
 * `systemctl is-active` uses non-zero exits for both an inactive unit and a
 * missing D-Bus, but only the former is safe to follow with start/restart.
 */
export function classifySystemdServiceState(result: {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
}): ServiceState {
  const stdout = String(result.stdout ?? "").trim().toLowerCase();
  const stderr = String(result.stderr ?? "").trim().toLowerCase();
  if (stdout === "active" || stdout === "activating") return "running";
  if (stdout === "inactive" || stdout === "failed" || stdout === "unknown") return "stopped";
  const details = `${stderr} ${result.error?.message ?? ""}`.toLowerCase();
  if (
    result.error
    || result.status == null
    || /failed to connect to bus|no medium found|transport endpoint|connection refused|system has not been booted/.test(details)
  ) return "unavailable";
  // A reachable systemd returns a concrete exit status for a missing/stopped
  // unit. Treat that as stopped; callers separately decide whether it is installed.
  return "stopped";
}

export function getSystemdServiceState(label: string, user = true): ServiceState {
  const args = [...(user ? ["--user"] : []), "is-active", label];
  const result = spawnSync("systemctl", args, { encoding: "utf8", timeout: 5000 });
  return classifySystemdServiceState(result);
}

/**
 * `systemctl restart` is synchronous for Type=notify units: it returns only
 * after the replacement process sends READY=1. A large fleet can legitimately
 * spend minutes stopping and starting its windows, so the old generic 15-second
 * CLI timeout reported a failure while systemd kept the restart job running.
 */
export const SYSTEMD_RESTART_TIMEOUT_MS = 5 * 60_000;

type SystemctlRunner = (
  file: string,
  args: string[],
  options: { stdio: "inherit"; timeout: number },
) => unknown;

export function restartSystemdService(
  label: string,
  user = true,
  run: SystemctlRunner = execFileSync,
): boolean {
  try {
    run(
      "systemctl",
      [...(user ? ["--user"] : []), "restart", label],
      { stdio: "inherit", timeout: SYSTEMD_RESTART_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

export function getServicePath(): string | null {
  const path = servicePathForLabel(SERVICE_LABEL);
  return existsSync(path) ? path : null;
}

/** Legacy/root installs may use a system-level unit instead of the user unit. */
export function getSystemServicePath(): string | null {
  if (detectPlatform() === "macos") return null;
  for (const path of [
    "/etc/systemd/system/agend.service",
    "/usr/lib/systemd/system/agend.service",
    "/lib/systemd/system/agend.service",
  ]) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function stopService(): boolean {
  const plat = detectPlatform();
  try {
    if (plat === "macos") {
      const uid = process.getuid?.() ?? 501;
      execSync(`launchctl bootout gui/${uid}/${SERVICE_LABEL}`, { stdio: "inherit" });
    } else {
      execSync(`systemctl --user stop ${SERVICE_LABEL}`, { stdio: "inherit" });
    }
    return true;
  } catch {
    return false;
  }
}

export function startService(): boolean {
  const plat = detectPlatform();
  try {
    if (plat === "macos") {
      const plistPath = join(process.env.HOME!, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
      if (!existsSync(plistPath)) return false;
      const uid = process.getuid?.() ?? 501;
      const domain = `gui/${uid}`;
      execSync(`launchctl bootstrap ${domain} ${plistPath}`, { stdio: "inherit" });
      execSync(`launchctl enable ${domain}/${SERVICE_LABEL}`, { stdio: "inherit" });
    } else {
      try { execSync("systemctl --user daemon-reload", { stdio: "pipe" }); } catch {}
      execSync(`systemctl --user start ${SERVICE_LABEL}`, { stdio: "inherit" });
    }
    return true;
  } catch {
    return false;
  }
}

export function startSystemService(): boolean {
  if (detectPlatform() === "macos" || !getSystemServicePath()) return false;
  try {
    try { execSync("systemctl daemon-reload", { stdio: "pipe" }); } catch {}
    execSync("systemctl start agend", { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

export function activateService(plistPath: string, pidPath: string): void {
  // Kill manually-running fleet if present
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, "SIGTERM");
      // Wait briefly for process to exit
      for (let i = 0; i < 20; i++) {
        try { process.kill(pid, 0); } catch { break; }
        execSync("sleep 0.1");
      }
    } catch {
      // Process already gone
    }
    try { unlinkSync(pidPath); } catch {}
  }

  const plat = detectPlatform();
  if (plat === "macos") {
    const uid = process.getuid?.() ?? 501;
    const domain = `gui/${uid}`;
    const label = plistPath.replace(/.*\//, "").replace(/\.plist$/, "");
    // Unload if previously loaded (ignore errors)
    try { execSync(`launchctl bootout ${domain}/${label}`, { stdio: "ignore" }); } catch {}
    execSync(`launchctl bootstrap ${domain} ${plistPath}`, { stdio: "inherit" });
    execSync(`launchctl enable ${domain}/${label}`, { stdio: "inherit" });
  } else {
    const serviceName = plistPath.replace(/.*\//, "").replace(/\.service$/, "");
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync(`systemctl --user enable --now ${serviceName}`, { stdio: "inherit" });
  }
}
