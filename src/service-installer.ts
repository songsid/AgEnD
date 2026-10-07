import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, renameSync, statSync, chmodSync } from "node:fs";
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
 *
 * #1348: also strip any `node_modules` path segment, and deduplicate while
 * preserving first-appearance order. `node_modules/.bin` entries (and npm's
 * own `@npmcli/run-script/…/node-gyp-bin`) must never land in the service
 * unit: they're process-local to an npm-script run and self-perpetuate across
 * updates because each `agend install` copies the existing unit's PATH forward.
 */
export function buildServicePath(
  basePath = process.env.PATH ?? "",
  execPath = process.argv[1] ?? "",
  homeDir = homedir(),
): string {
  const seen = new Set<string>();
  const dirs = basePath
    .split(":")
    .filter(Boolean)
    // Drop Windows/WSL mount noise and node_modules entries.
    .filter(p => !p.includes("/mnt/") && !p.includes("Program Files") && !p.includes("/node_modules/"))
    // Deduplicate, keeping the first occurrence.
    .filter(p => { if (seen.has(p)) return false; seen.add(p); return true; });
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
    if (candidate && !seen.has(candidate)) { seen.add(candidate); dirs.push(candidate); }
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

/** Empty input follows the CLI's [Y/n] default. */
export function isServiceRemovalConfirmed(answer: string): boolean {
  return /^\s*(?:y|yes)?\s*$/i.test(answer);
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

/**
 * Replace a unit file atomically without widening its permissions: the temp
 * file gets the original's mode before the rename. A unit can carry
 * Environment= credentials, and a fresh temp file under umask 022 would turn a
 * 0600 unit into 0644 (#1122 review).
 */
function replaceUnitFile(unitPath: string, text: string): void {
  const mode = statSync(unitPath).mode & 0o7777;
  const tmp = `${unitPath}.agend-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, unitPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * #908: bring an installed AgEnD unit up to `KillMode=mixed` before it is
 * restarted. Units written before this have none, so systemd used its default
 * (control-group) and SIGTERMed the tmux server and every CLI at the same
 * moment as the fleet. Only an absent KillMode is filled in: an explicit value
 * is the operator's own choice and is left as it is.
 */
export function ensureSystemdKillModeMixed(unitPath: string): "added" | "present" | "custom" | "unreadable" {
  let text: string;
  try { text = readFileSync(unitPath, "utf-8"); } catch { return "unreadable"; }
  const lines = text.split("\n");
  const service = lines.findIndex(l => l.trim() === "[Service]");
  if (service < 0) return "unreadable";
  let end = lines.findIndex((l, i) => i > service && /^\s*\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  const existing = lines.slice(service + 1, end).find(l => /^\s*KillMode\s*=/.test(l));
  if (existing) return /^\s*KillMode\s*=\s*mixed\s*$/.test(existing) ? "present" : "custom";
  // After the section's last directive, before the blank line that ends it.
  let at = end;
  while (at > service + 1 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, "KillMode=mixed");
  replaceUnitFile(unitPath, lines.join("\n"));
  return "added";
}

type UnitSectionName = "Unit" | "Service";

interface UnitDirectivePolicy {
  section: UnitSectionName;
  key: string;
  value: string;
  /**
   * Values AgEnD itself once wrote, which are upgraded rather than treated as
   * the operator's choice. Anything else that is present is left alone.
   */
  legacy?: readonly string[];
  /** Values that already mean `value` (e.g. `0x0` for `0`). */
  equivalent?: (value: string) => boolean;
  /**
   * The directive accumulates (systemd ORs CoredumpFilter assignments, an
   * empty one resets them) and may come from drop-ins applied after the main
   * file: classify it from all of them, not from its first line.
   */
  allAssignments?: boolean;
}

/** `[Service]` assignments of `key`, in order, from one unit file's text. */
function serviceAssignments(text: string, key: string): string[] {
  const out: string[] = [];
  let inService = false;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`);
  for (const line of text.split("\n")) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) { inService = section[1] === "Service"; continue; }
    if (!inService) continue;
    const m = pattern.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Unit search path for the scope a unit file lives in, highest precedence first. */
function unitLoadPath(unitPath: string): string[] {
  const user = unitPath.includes(`${join(".config", "systemd", "user")}`) || unitPath.startsWith("/etc/systemd/user/")
    || unitPath.startsWith("/usr/lib/systemd/user/");
  const dirs = user
    ? [join(homedir(), ".config", "systemd", "user"), "/etc/systemd/user", "/run/systemd/user", "/usr/lib/systemd/user"]
    : ["/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"];
  const own = dirname(unitPath);
  return dirs.includes(own) ? dirs : [own, ...dirs];
}

/**
 * The drop-in files systemd applies to a unit file, as systemd 249's
 * dropin.c builds them: every unit-specific `<name>.service.d/` across the
 * load path first, then the type-wide `service.d/` across the load path ("the
 * most generic, overridable by more specific drop-ins"); among files with the
 * same name the first directory in that order wins; the survivors are applied
 * in file-name order (#1122 review).
 *
 * `reported` are paths systemd itself listed (DropInPaths): they join the
 * same ranking — by their directory if it is one of the above, otherwise
 * after the known directories of their kind — so a file systemd loaded from a
 * directory AgEnD does not scan still counts, and one the ranking shadows does
 * not come back. Files that no longer exist are dropped.
 */
export function effectiveUnitDropIns(unitPath: string, reported: readonly string[] = []): string[] {
  const name = unitPath.split("/").pop()!;
  const loadPath = unitLoadPath(unitPath);
  const dirs = [...loadPath.map(d => join(d, `${name}.d`)), ...loadPath.map(d => join(d, "service.d"))];
  const rank = (path: string): number => {
    const dir = dirname(path);
    const known = dirs.indexOf(dir);
    if (known >= 0) return known;
    // Unknown directory: after the known ones of its own kind.
    return dir.endsWith(`/${name}.d`) ? loadPath.length - 0.5 : dirs.length + 0.5;
  };
  const files: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir).filter(n => n.endsWith(".conf")); } catch { continue; }
    for (const n of names) files.push(join(dir, n));
  }
  for (const path of reported) if (path.endsWith(".conf") && existsSync(path)) files.push(path);
  const winner = new Map<string, string>();
  for (const path of [...new Set(files)].sort((a, b) => rank(a) - rank(b))) {
    const base = path.split("/").pop()!;
    if (!winner.has(base)) winner.set(base, path);
  }
  return [...winner.keys()].sort().map(base => winner.get(base)!);
}

/** Drop-ins found on disk only (no systemd report). */
export function unitDropInCandidates(unitPath: string): string[] {
  return effectiveUnitDropIns(unitPath);
}

export type CoredumpFilterState = "none" | "zero" | "custom";

/**
 * What CoredumpFilter the unit ends up with, from the main file's [Service]
 * sections and then each drop-in, in order. Explicit masks OR together. An
 * EMPTY assignment drops every mask before it and restores the inherited value
 * (the manager's own filter, normally 0x33): "zero" only if an explicit 0 comes
 * after it. "none" = never set; "custom" = the result is not AgEnD's 0 — the
 * operator's call, warned about but never gated.
 */
export function unitCoredumpFilterState(mainText: string, dropInPaths: readonly string[]): CoredumpFilterState {
  const texts = [mainText];
  for (const path of dropInPaths) {
    try { texts.push(readFileSync(path, "utf-8")); } catch { /* unreadable: systemd skips it too */ }
  }
  const assignments = texts.flatMap(t => serviceAssignments(t, "CoredumpFilter"));
  if (assignments.length === 0) return "none";
  let inherited = false;
  let nonzero = false;
  for (const value of assignments) {
    if (value === "") { inherited = true; nonzero = false; continue; }
    inherited = false;
    if (!/^(?:0x)?0+$/i.test(value)) nonzero = true;
  }
  return inherited || nonzero ? "custom" : "zero";
}

const UNIT_HARDENING: readonly UnitDirectivePolicy[] = [
  { section: "Unit", key: "StartLimitIntervalSec", value: "30min" },
  { section: "Unit", key: "StartLimitBurst", value: "4" },
  { section: "Service", key: "TimeoutStartSec", value: "15min", legacy: ["0"] },
  { section: "Service", key: "KillMode", value: "mixed" },
  // Classified from every assignment, drop-ins included: see unitCoredumpFilterState.
  { section: "Service", key: "CoredumpFilter", value: "0", equivalent: v => /^(?:0x)?0+$/i.test(v), allAssignments: true },
  { section: "Service", key: "LimitCORE", value: "0" },
];

export type UnitDirectiveOutcome = "added" | "upgraded" | "present" | "custom";

export type UnitHardeningResult =
  | { kind: "unreadable" }
  | { kind: "ok"; directives: Record<string, UnitDirectiveOutcome> };

function sectionBounds(lines: string[], name: UnitSectionName): { start: number; end: number } | null {
  const start = lines.findIndex(l => l.trim() === `[${name}]`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^\s*\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  return { start, end };
}

/**
 * Bring an installed AgEnD unit up to the directives AgEnD now ships, before
 * it is restarted (#908 KillMode, #1113 crash dumps / start limits / start
 * timeout). A directive that is absent is added at the end of its section; one
 * that still carries a value AgEnD itself used to write is upgraded; anything
 * else present is the operator's choice and is left as it is. A [Unit] section
 * is required only for the [Unit] directives — a unit without one keeps the
 * [Service] fixes. Written atomically, and only if something changed.
 */
export function ensureSystemdUnitHardening(
  unitPath: string,
  opts: { dropInPaths?: readonly string[] } = {},
): UnitHardeningResult {
  let text: string;
  try { text = readFileSync(unitPath, "utf-8"); } catch { return { kind: "unreadable" }; }
  const lines = text.split("\n");
  if (!sectionBounds(lines, "Service")) return { kind: "unreadable" };
  const directives: Record<string, UnitDirectiveOutcome> = {};
  let changed = false;
  for (const policy of UNIT_HARDENING) {
    const bounds = sectionBounds(lines, policy.section);
    if (!bounds) continue;
    if (policy.allAssignments) {
      const state = unitCoredumpFilterState(lines.join("\n"), opts.dropInPaths ?? unitDropInCandidates(unitPath));
      if (state === "custom") { directives[policy.key] = "custom"; continue; }
      if (state === "zero") { directives[policy.key] = "present"; continue; }
    }
    const pattern = new RegExp(`^\\s*${policy.key}\\s*=\\s*(.*?)\\s*$`);
    const at = lines.slice(bounds.start + 1, bounds.end).findIndex(l => pattern.test(l));
    if (at >= 0) {
      const index = bounds.start + 1 + at;
      const current = pattern.exec(lines[index])![1];
      if (current === policy.value || policy.equivalent?.(current)) {
        directives[policy.key] = "present";
      } else if (policy.legacy?.includes(current)) {
        lines[index] = `${policy.key}=${policy.value}`;
        directives[policy.key] = "upgraded";
        changed = true;
      } else {
        directives[policy.key] = "custom";
      }
      continue;
    }
    // After the section's last directive, before the blank line that ends it.
    let insert = bounds.end;
    while (insert > bounds.start + 1 && lines[insert - 1].trim() === "") insert--;
    lines.splice(insert, 0, `${policy.key}=${policy.value}`);
    directives[policy.key] = "added";
    changed = true;
  }
  if (changed) replaceUnitFile(unitPath, lines.join("\n"));
  return { kind: "ok", directives };
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
