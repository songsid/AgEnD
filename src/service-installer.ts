import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, renameSync, statSync, chmodSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { ensureUserSystemd } from "./user-systemd.js";
import ejs from "ejs";
const { render } = ejs;
import { homedir, platform } from "node:os";
import { canonicalCliEntry } from "./cli-entry.js";
import { FLEET_STOP_TIMEOUT_MS } from "./fleet-stop-budget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, "..", "templates");

interface ServiceVars {
  label: string;
  /** The CLI the service starts: canonicalCliEntry(). */
  execPath: string;
  /**
   * The Node that runs it, NAMED in the definition (#1450 C6): the selected interpreter — this process's own, since
   * `agend install` runs on what the launcher selected. Never left to `#!/usr/bin/env node` and the service's PATH.
   */
  nodePath?: string;
  /**
   * Instead of a named Node: the package's sh launcher, which finds Node at each start. Only for a SYSTEM Node (no
   * bundled runtime on this host): a named system Node breaks when an nvm/brew upgrade removes its directory, while
   * the bundled runtime's path only changes with an npm update, which re-renders the service (#1450 leader review).
   */
  launcherPath?: string;
  path?: string;
  workingDirectory: string;
  logPath: string;
  isRoot?: boolean;
  /**
   * The AgEnD home the service's fleet must use, when it is not the default one: written as AGEND_HOME into the
   * definition, so a fleet started on a custom home comes back on it after a service restart or an update. Absent for
   * the default home: the definition is then byte-identical to one without this field.
   */
  agendHome?: string;
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

function validateVars(vars: ServiceVars & { path: string; nodePath: string; program: string[] }): void {
  assertSafeServiceValue("label", vars.label);
  assertSafeServiceValue("execPath", vars.execPath);
  for (const word of vars.program) {
    assertSafeServiceValue(vars.program.length === 1 ? "launcherPath" : "nodePath", word);
    assertAbsolutePath(vars.program.length === 1 ? "launcherPath" : "nodePath", word);
  }
  assertSafeServiceValue("workingDirectory", vars.workingDirectory);
  assertSafeServiceValue("logPath", vars.logPath);
  assertSafeServiceValue("path", vars.path);
  if (vars.agendHome !== undefined) {
    assertSafeServiceValue("agendHome", vars.agendHome);
    assertAbsolutePath("agendHome", vars.agendHome);
  }
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
  execPath = canonicalCliEntry(),
  homeDir = homedir(),
  /** The Node this process runs on: under AgEnD's bundled Node it lives in node_modules, and is never added (#1450). */
  nodeExec = process.execPath,
): string {
  const seen = new Set<string>();
  const dirs = basePath
    .split(":")
    .filter(Boolean)
    // Drop Windows/WSL mount noise and node_modules entries.
    .filter(p => !p.includes("/mnt/") && !p.includes("Program Files") && !p.includes("/node_modules/"))
    // Only absolute entries: an empty or relative one resolves against the service's working directory (#1473 review).
    .filter(p => p.startsWith("/"))
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
    dirname(nodeExec),
    npmPrefixBin,
    ...nvmBins,
    join(homeDir, ".local", "bin"),
    join(homeDir, ".npm-global", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];

  for (const candidate of fallbacks) {
    // Apply the same node_modules predicate to fallback candidates: even
    // dirname(process.execPath) can be e.g. /project/node_modules/node/bin
    // when Node itself lives inside a node_modules tree.
    if (candidate && !candidate.includes("/node_modules/") && !seen.has(candidate)) {
      seen.add(candidate);
      dirs.push(candidate);
    }
  }
  return dirs.join(":");
}

/**
 * What a service starts when the caller does not say: this package's own selection (launcher/runtime-select.cjs, C2)
 * — the bundled runtime or an AGEND_NODE, named; a system Node, through the launcher. Anything that cannot be
 * resolved (a file outside a package, a checkout without a launcher) names this process's Node, as before.
 */
export function defaultServiceProgram(execPath: string): { nodePath: string } | { launcherPath: string } {
  try {
    const launcherDir = join(dirname(dirname(execPath)), "launcher");
    const select = createRequire(import.meta.url)(join(launcherDir, "runtime-select.cjs")) as { selectRuntime(dir: string): { ok: boolean; node?: string; source?: string } };
    const chosen = select.selectRuntime(launcherDir);
    if (chosen.ok && chosen.source === "system" && existsSync(join(launcherDir, "agend"))) return { launcherPath: join(launcherDir, "agend") };
    if (chosen.ok && chosen.node) return { nodePath: chosen.node };
  } catch { /* not inside a package with a launcher */ }
  return { nodePath: process.execPath };
}

function withDefaults(vars: ServiceVars): ServiceVars & { path: string; nodePath: string; program: string[] } {
  const path = buildServicePath(vars.path, vars.execPath);
  const chosen = vars.nodePath || vars.launcherPath ? (vars.launcherPath ? { launcherPath: vars.launcherPath } : { nodePath: vars.nodePath! }) : defaultServiceProgram(vars.execPath);
  const program = "launcherPath" in chosen ? [chosen.launcherPath] : [chosen.nodePath, vars.execPath];
  const full = { ...vars, path, nodePath: "nodePath" in chosen ? chosen.nodePath : "", program, isRoot: vars.isRoot ?? (process.getuid?.() === 0) };
  validateVars(full);
  return full;
}

export function renderLaunchdPlist(vars: ServiceVars): string {
  const template = readFileSync(join(templatesDir, "launchd.plist.ejs"), "utf-8");
  return render(template, { agendHome: undefined, ...withDefaults(vars) });
}

export function renderSystemdUnit(vars: ServiceVars): string {
  const template = readFileSync(join(templatesDir, "systemd.service.ejs"), "utf-8");
  return render(template, { agendHome: undefined, ...withDefaults(vars), systemdQuote, systemdEnvironmentQuote, stopTimeoutSec: FLEET_STOP_TIMEOUT_MS / 1_000 });
}

/**
 * One `Environment=` assignment, exactly: double-quoted (a path with spaces stays one assignment), `\` and `"` escaped,
 * and `%` (specifiers, which systemd expands in Environment=) as `%%`. Unlike a command line, `$` is NOT special in
 * Environment= (systemd.exec: no variable expansion there), so it is left as is.
 */
export function systemdEnvironmentQuote(assignment: string): string {
  return `"${assignment.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/**
 * The AGEND_HOME a service definition carries, or null: read back from what renderLaunchdPlist / renderSystemdUnit
 * write (a refresh keeps it). Anything not shaped like ours is null.
 */
export function serviceDefinitionAgendHome(text: string): string | null {
  const plist = /<key>AGEND_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  if (plist) {
    return plist[1]!.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  const unit = /^Environment="AGEND_HOME=((?:[^"\\]|\\.)*)"\s*$/m.exec(text);
  if (!unit) return null;
  return unit[1]!.replace(/\\(.)/g, "$1").replace(/%%/g, "%");
}

/**
 * Which AgEnD home a service definition being written should name. A non-default home of this CLI is named. On a
 * REFRESH (`install --no-activate`, an update's) run from the default home, an existing definition's home is kept:
 * an update typed in a shell without AGEND_HOME must not move a custom-home service back to ~/.agend.
 */
export function serviceHomeFor(cliHome: string, opts: { refresh: boolean; existingDefinition: string | null; isDefault: (home: string) => boolean }): { workingDirectory: string; logPath: string; agendHome?: string } {
  const kept = opts.refresh && opts.isDefault(cliHome) && opts.existingDefinition ? serviceDefinitionAgendHome(opts.existingDefinition) : null;
  const home = kept && kept.startsWith("/") ? kept : cliHome;
  // The fleet's directory and log follow the same home it is told to use.
  const where = { workingDirectory: home, logPath: join(home, "fleet.log") };
  return opts.isDefault(home) ? where : { ...where, agendHome: home };
}

/**
 * One word of a systemd command line, exactly (#1460 review): double-quoted, with `\` and `"` escaped inside, and
 * systemd's own expansions neutralised — `%` (specifiers) as `%%`, `$` (variables) as `$$`. A path with spaces stays one
 * argument.
 */
export function systemdQuote(word: string): string {
  return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/** The words of a systemd command line as systemd splits them: quotes, backslash escapes, `%%` and `$$` undone. */
export function systemdWords(line: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    let word = "";
    let quote: string | null = null;
    for (; i < line.length; i++) {
      const c = line[i]!;
      if (quote) {
        if (c === quote) { quote = null; continue; }
        if (c === "\\" && i + 1 < line.length) { word += line[++i]; continue; }
        word += c;
      } else {
        if (/\s/.test(c)) break;
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === "\\" && i + 1 < line.length) { word += line[++i]; continue; }
        word += c;
      }
    }
    words.push(word.replace(/%%/g, "%").replace(/\$\$/g, "$"));
  }
  return words;
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
  if (detectPlatform() === "linux") ensureUserSystemd();   // #2264
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

export interface LaunchdReloadDeps {
  run(command: string, args: string[], inherit?: boolean): { status: number | null; signal: NodeJS.Signals | null };
  sleep(ms: number): void;
  /** Monotonic ms. */
  now(): number;
}
const defaultLaunchdReloadDeps: LaunchdReloadDeps = {
  run: (command, args, inherit) => {
    const r = spawnSync(command, args, { stdio: inherit ? "inherit" : "ignore", timeout: 15_000 });
    return { status: r.status, signal: r.signal };
  },
  sleep: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  now: () => performance.now(),
};

/**
 * `agend install`'s launchd (re)load: bootout whatever is loaded, then bootstrap — but only once launchd has
 * CONFIRMED the job gone (`launchctl print` → 113). bootout returns before the job is unloaded (macOS 15: a bootstrap
 * right after it fails with 5, EIO), so the wait is bounded (10 s, monotonic); a job still loaded, a print that times
 * out or fails is not "gone" — nothing is bootstrapped, and the install says so (#1473 review).
 */
export function reloadLaunchdJob(domain: string, label: string, plistPath: string, deps: LaunchdReloadDeps = defaultLaunchdReloadDeps): void {
  const target = `${domain}/${label}`;
  deps.run("launchctl", ["bootout", target]);                      // not loaded is fine: confirmed below
  const deadline = deps.now() + 10_000;
  for (;;) {
    const printed = deps.run("launchctl", ["print", target]);
    if (printed.status === 113 && printed.signal === null) break;
    if (deps.now() >= deadline) throw new Error(`launchd did not confirm that ${label} was unloaded within 10 s; nothing was loaded (retry: agend install)`);
    deps.sleep(100);
  }
  const boot = deps.run("launchctl", ["bootstrap", domain, plistPath], true);
  if (boot.status !== 0) throw new Error(`launchctl bootstrap ${domain} ${plistPath} failed (${boot.signal ?? `exit ${boot.status}`})`);
  const enabled = deps.run("launchctl", ["enable", target], true);
  if (enabled.status !== 0) throw new Error(`launchctl enable ${target} failed (${enabled.signal ?? `exit ${enabled.status}`})`);
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

/**
 * The CLI file a unit starts: `ExecStart=<entry> fleet start`, or `ExecStart=<node> <entry> fleet start` (the explicit
 * interpreter, #1450). "" when there is no ExecStart.
 */
export function unitCliEntry(unitText: string): string {
  const words = systemdWords(unitText.match(/^ExecStart=(.*)$/m)?.[1] ?? "");
  // The launcher form (a system Node, found at each start) starts its package's dist/cli.js.
  if (words[0] && /\/launcher\/agend$/.test(words[0])) return join(dirname(dirname(words[0])), "dist", "cli.js");
  return (words[0] && /(^|\/)node$/.test(words[0]) ? words[1] : words[0]) ?? "";
}

/** Where `agend install` keeps a launchd job: the user's LaunchAgents (the gui/<uid> domain of a logged-in user). */
export function launchdPlistPath(label: string): string {
  return join(process.env.HOME!, "Library/LaunchAgents", `${label}.plist`);
}

export function installService(vars: ServiceVars): string {
  if (detectPlatform() === "linux") ensureUserSystemd(undefined, { linger: true });   // #2264: `agend install`
  const plat = detectPlatform();
  if (plat === "macos") {
    const plistPath = launchdPlistPath(vars.label);
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

export type SystemUnitRefresh =
  | { kind: "updated"; execStart?: string; oomPolicyAdded?: boolean }
  | { kind: "current" }
  | { kind: "foreign"; reason: string }
  | { kind: "unreadable" };

/**
 * #1884: a legacy system unit (/etc/systemd/system/agend.service, written by an operator for a root fleet; AgEnD only
 * recognises it) is AgEnD's service too, but a refresh used to write only the user unit. An update from 2.1 left its
 * ExecStart on 2.1's `bin/agend` script, and `agend restart`'s C6 guard then refused it (the loaded unit does not start
 * the selected Node): the update installed 2.2 and left 2.1 running.
 *
 * The refresh rewrites that one line to what the user unit gets — this package's selected program, `fleet start` — when
 * the unit has exactly one ExecStart and it starts THIS package's fleet (its program, or the script a Node runs, is a
 * file inside `pkgDir`). Every other line, and an ExecStart that starts anything else, is the operator's and stays.
 * Written atomically with the file's own mode. Proof and rollback are the restart's and the updater's, exactly as for
 * the user unit: a daemon-reload, the loaded ExecStart judged against the selection, the preimage put back on refusal.
 */
export function refreshSystemUnitExecStart(unitPath: string, vars: ServiceVars, pkgDir: string): SystemUnitRefresh {
  let text: string;
  try { text = readFileSync(unitPath, "utf-8"); } catch { return { kind: "unreadable" }; }
  const lines = text.split("\n");
  const bounds = sectionBounds(lines, "Service");
  if (!bounds) return { kind: "unreadable" };
  const at = lines.map((line, index) => ({ line, index })).filter(({ line, index }) => index > bounds.start && index < bounds.end && /^\s*ExecStart\s*=/.test(line));
  if (at.length !== 1) return { kind: "foreign", reason: `${at.length} ExecStart lines` };
  const words = systemdWords(at[0].line.replace(/^\s*ExecStart\s*=\s*/, ""));
  const real = (path: string | undefined) => { if (!path?.startsWith("/")) return null; try { return realpathSync(path); } catch { return null; } };
  const root = real(pkgDir);
  const inside = (path: string | undefined) => { const r = real(path); return !!root && !!r && (r === root || r.startsWith(`${root}/`)); };
  const starts = words.length >= 3 && words[words.length - 2] === "fleet" && words[words.length - 1] === "start"
    && (words.length === 3 ? inside(words[0]) : words.length === 4 && /(^|\/)node$/.test(words[0]) && inside(words[1]));
  if (!starts) return { kind: "foreign", reason: "its ExecStart does not start this package's fleet" };
  const wanted = /^ExecStart=.*$/m.exec(renderSystemdUnit(vars))![0];
  const execChanged = at[0].line.trim() !== wanted;
  if (execChanged) lines[at[0].index] = wanted;
  // #2015: the same refresh gives the unit OOMPolicy=continue when it sets no OOMPolicy at all (the user unit gets it
  // by being rewritten). One it does set, whatever the value, is the operator's.
  const service = sectionBounds(lines, "Service")!;
  const hasOomPolicy = lines.slice(service.start + 1, service.end).some(l => /^\s*OOMPolicy\s*=/.test(l));
  if (!hasOomPolicy) {
    let insert = service.end;
    while (insert > service.start + 1 && lines[insert - 1].trim() === "") insert--;
    lines.splice(insert, 0, "OOMPolicy=continue");
  }
  if (!execChanged && hasOomPolicy) return { kind: "current" };
  replaceUnitFile(unitPath, lines.join("\n"));
  return { kind: "updated", ...(execChanged ? { execStart: wanted.slice("ExecStart=".length) } : {}), ...(!hasOomPolicy ? { oomPolicyAdded: true } : {}) };
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
  /** Applies only to a unit whose main file passes this (#2331: NotifyAccess only for Type=notify). */
  when?: (unitText: string) => boolean;
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
  { section: "Service", key: "TimeoutStopSec", value: String(FLEET_STOP_TIMEOUT_MS / 1_000), legacy: ["60", "60s", "1min"] },
  { section: "Service", key: "KillMode", value: "mixed" },
  // Classified from every assignment, drop-ins included: see unitCoredumpFilterState.
  { section: "Service", key: "CoredumpFilter", value: "0", equivalent: v => /^(?:0x)?0+$/i.test(v), allAssignments: true },
  { section: "Service", key: "LimitCORE", value: "0" },
  // #2015: an OOM-killed process stops only itself. `stop` (systemd's default) is never something AgEnD wrote, so a
  // unit that sets it is the operator's choice and is left alone.
  { section: "Service", key: "OOMPolicy", value: "continue" },
  // #2331: the fleet says READY=1 through a short-lived systemd-notify helper, never as the main process. systemd takes
  // it only with NotifyAccess=all: with main or exec (or none) it refuses the signal, and the start times out — every
  // 15 minutes since TimeoutStartSec=15min (#1122), silently before, when it was 0. AgEnD only ever shipped `main`
  // (0.0.24-beta.5–12) and `all`; a Type=notify unit without the line has systemd's default, main.
  { section: "Service", key: "NotifyAccess", value: "all", legacy: ["main", "exec", "none"], when: serviceTypeIsNotify },
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
    if (policy.when && !policy.when(lines.join("\n"))) continue;
    // An explicit override or duplicate is an operator policy, not a legacy
    // AgEnD default. Do not overwrite it or gate it as our managed value.
    if (policy.key === "TimeoutStopSec") {
      const drops = opts.dropInPaths ?? unitDropInCandidates(unitPath);
      const texts = drops.map(path => { try { return readFileSync(path, "utf8"); } catch { return ""; } });
      if (serviceAssignments(lines.join("\n"), policy.key).length > 1
        || texts.some(text => serviceAssignments(text, policy.key).length > 0)) {
        directives[policy.key] = "custom"; continue;
      }
    }
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

/** #2331: does a unit file's own [Service] say Type=notify (its last assignment)? */
export function serviceTypeIsNotify(unitText: string): boolean {
  const types = serviceAssignments(unitText, "Type");
  return types.length > 0 && types[types.length - 1] === "notify";
}

/** #2331: AgEnD's own drop-in, named to sort after an operator's, that puts NotifyAccess back to `all`. */
export const NOTIFY_DROPIN = "zz-agend-notify.conf";

export interface LoadedNotify {
  type: string;
  notifyAccess: string;
  timeoutStart: string;
  fragment: string;
  dropIns: string[];
}

/** What systemd has LOADED for the unit (never the file: #1804), through `show` — `systemctl show -p <prop> --value`. */
export function readLoadedNotify(show: (property: string) => string | null): LoadedNotify | null {
  const type = show("Type"), notifyAccess = show("NotifyAccess");
  if (!type || !notifyAccess) return null;
  return {
    type, notifyAccess,
    timeoutStart: show("TimeoutStartUSec") ?? "",
    fragment: show("FragmentPath") ?? "",
    dropIns: (show("DropInPaths") ?? "").split(/\s+/).filter(Boolean),
  };
}

export type NotifyRepair =
  | { kind: "fine" }
  | { kind: "unknown" }
  | { kind: "repaired"; path: string; from: string; dropIns: string[] }
  | { kind: "refused"; notifyAccess: string; dropIns: string[]; detail: string };

/** Write AgEnD's drop-in for a unit file; returns its path. */
export function writeNotifyDropIn(unitPath: string): string {
  const dir = `${unitPath}.d`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, NOTIFY_DROPIN);
  writeFileSync(path, [
    "# Written by AgEnD (#2331). The fleet tells systemd it is ready through a short-lived systemd-notify helper,",
    "# which systemd accepts only with NotifyAccess=all. Another drop-in here set it to something else, so systemd",
    "# refused the fleet's ready signal and restarted it every time TimeoutStartSec ran out. This file can go once",
    "# no other drop-in sets NotifyAccess.",
    "[Service]",
    "NotifyAccess=all",
    "",
  ].join("\n"), { mode: 0o644 });
  return path;
}

/**
 * #2331: a Type=notify unit must LOAD NotifyAccess=all, or systemd refuses the fleet's READY and restarts it when the
 * start times out. The main file is fixed by the hardening above; what is still wrong after a reload comes from a
 * drop-in AgEnD did not write. Rather than touch the operator's file, AgEnD adds its own last-sorting drop-in, reloads
 * and asks systemd again. `reload` reloads the manager; `write` writes the drop-in (tests).
 */
export function ensureLoadedNotifyAccess(
  unitPath: string | null,
  show: (property: string) => string | null,
  reload: () => boolean,
  write: (unitPath: string) => string = writeNotifyDropIn,
): NotifyRepair {
  const before = readLoadedNotify(show);
  if (!before) return { kind: "unknown" };
  if (before.type !== "notify" || before.notifyAccess === "all") return { kind: "fine" };
  if (!unitPath) return { kind: "refused", notifyAccess: before.notifyAccess, dropIns: before.dropIns, detail: "its unit file is not known here" };
  let path: string;
  try { path = write(unitPath); } catch (err) {
    return { kind: "refused", notifyAccess: before.notifyAccess, dropIns: before.dropIns, detail: `AgEnD could not write ${join(`${unitPath}.d`, NOTIFY_DROPIN)} (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  reload();
  const after = readLoadedNotify(show);
  if (after && (after.type !== "notify" || after.notifyAccess === "all")) return { kind: "repaired", path, from: before.notifyAccess, dropIns: before.dropIns };
  return { kind: "refused", notifyAccess: after?.notifyAccess ?? before.notifyAccess, dropIns: after?.dropIns ?? before.dropIns, detail: "it is still set after AgEnD's own drop-in (a later one wins)" };
}

/** What a repair says, one line each ("" for nothing). */
export function notifyRepairLines(r: NotifyRepair, unit: string, reloadCmd: string): string[] {
  if (r.kind === "repaired") {
    return [`  ✓ ${r.path}: NotifyAccess=all — systemd had NotifyAccess=${r.from} loaded${r.dropIns.length ? ` (from ${r.dropIns.join(", ")})` : ""}, which refuses the fleet's ready signal and restarts it every 15 minutes (#2331)`];
  }
  if (r.kind === "refused") {
    return [`  ⚠ systemd loads NotifyAccess=${r.notifyAccess} for ${unit}${r.dropIns.length ? ` (drop-ins: ${r.dropIns.join(", ")})` : ""}: the fleet's ready signal is refused, and systemd restarts it every time TimeoutStartSec runs out (15 minutes). ${r.detail[0]!.toUpperCase()}${r.detail.slice(1)}. Remove the line that sets NotifyAccess, run \`${reloadCmd}\`, then \`agend restart\` (#2331).`];
  }
  return [];
}

/** Directives a leftover drop-in may set that decide whether the fleet starts and stays up. */
const LEFTOVER_KEYS = ["Type", "NotifyAccess", "ExecStart", "TimeoutStartSec", "WatchdogSec", "Restart", "EnvironmentFile"] as const;
/** Labels AgEnD used before its rename (source builds before 2026-03-31; never in a published package). */
const OLD_LABELS = ["com.ccd.fleet", "com.claude-channel-daemon"] as const;

export interface ServiceLeftover { path: string; detail: string }

/**
 * #2331: service files AgEnD did not write, or no longer uses, that can change how the fleet starts: drop-ins that set
 * the directives above, a user unit beside the system unit that runs the fleet, units and plists under AgEnD's old
 * labels. Reported, never removed: AgEnD writes no drop-in but its own zz-agend-notify.conf, and the others may be
 * someone's on purpose. They are named on every install, start and restart until they are gone (facts about the host).
 */
export function serviceLeftovers(o: { home: string; dropIns: readonly string[]; systemUnit: string | null; userUnitPath?: string }): ServiceLeftover[] {
  const out: ServiceLeftover[] = [];
  for (const path of o.dropIns) {
    if (path.endsWith(`/${NOTIFY_DROPIN}`)) continue;
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const set = LEFTOVER_KEYS.flatMap((key) => serviceAssignments(text, key).slice(-1).map((v) => `${key}=${v}`));
    if (set.length) out.push({ path, detail: `a drop-in sets ${set.join(", ")} (AgEnD writes none but its own ${NOTIFY_DROPIN}); keep it only if you added it on purpose` });
  }
  const userUnit = o.userUnitPath ?? join(o.home, ".config", "systemd", "user", `${SERVICE_LABEL}.service`);
  if (o.systemUnit && existsSync(userUnit)) {
    out.push({ path: userUnit, detail: `a user unit beside the system unit ${o.systemUnit}, which runs the fleet; this one is not used — \`systemctl --user disable ${SERVICE_LABEL}\`, then remove it` });
  }
  for (const label of OLD_LABELS) {
    for (const path of [join(o.home, ".config", "systemd", "user", `${label}.service`), join(o.home, "Library", "LaunchAgents", `${label}.plist`)]) {
      if (existsSync(path)) out.push({ path, detail: "a service from before AgEnD's rename (a source build); it does not run this fleet — disable it and remove it" });
    }
  }
  return out;
}

/**
 * #2331: after a reload, the fleet's unit as systemd loaded it — NotifyAccess made right if a drop-in got in the way,
 * and any leftovers named. One line each, for install, start and restart to print.
 */
export function loadedUnitCheck(o: { user: boolean; unit: string; unitPath: string | null; home?: string }): string[] {
  const scope = o.user ? " --user" : "";
  // One `systemctl show` per state of the manager (now; after a reload), never one per property.
  const snapshot = (): Map<string, string> | null => {
    let out: string;
    try { out = execSync(`systemctl${scope} show -p ${LOADED_PROPERTIES.join(",")} ${o.unit}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }); } catch { return null; }
    const values = new Map<string, string>();
    for (const line of out.split("\n")) { const at = line.indexOf("="); if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim()); }
    return values;
  };
  let loaded = snapshot();
  const show = (property: string): string | null => loaded?.get(property) ?? null;
  const reloadCmd = `systemctl${scope} daemon-reload`;
  const reload = (): boolean => {
    let ok = true;
    try { execSync(reloadCmd, { stdio: "pipe", timeout: 30_000 }); } catch { ok = false; }
    loaded = snapshot();
    return ok;
  };
  const lines = notifyRepairLines(ensureLoadedNotifyAccess(o.unitPath, show, reload), o.unit, reloadCmd);
  const now = readLoadedNotify(show);
  for (const l of serviceLeftovers({ home: o.home ?? homedir(), dropIns: now?.dropIns ?? [], systemUnit: o.user ? null : o.unit })) {
    lines.push(`  ℹ ${l.path}: ${l.detail} (#2331)`);
  }
  return lines;
}

/** What #2331 reads of a loaded unit, in one `systemctl show -p …`. */
export const LOADED_PROPERTIES = ["Type", "NotifyAccess", "TimeoutStartUSec", "FragmentPath", "DropInPaths"] as const;

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
  if (detectPlatform() === "linux") ensureUserSystemd();   // #2264
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

/**
 * What a `systemctl restart` came to (#1446 item 4). Only OUR wait running out is indeterminate: the Type=notify job
 * may still finish and start a healthy replacement, which then settles the update marker. systemctl exiting with an
 * error is a definite failure and must not be reported as success.
 */
export type SystemdRestartOutcome = "restarted" | "timed-out" | "failed";

export function systemdRestartOutcome(
  label: string,
  user = true,
  run: SystemctlRunner = execFileSync,
): SystemdRestartOutcome {
  try {
    run(
      "systemctl",
      [...(user ? ["--user"] : []), "restart", label],
      { stdio: "inherit", timeout: SYSTEMD_RESTART_TIMEOUT_MS },
    );
    return "restarted";
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? "timed-out" : "failed";
  }
}

export function restartSystemdService(
  label: string,
  user = true,
  run: SystemctlRunner = execFileSync,
): boolean {
  if (user && run === execFileSync) ensureUserSystemd(undefined, { linger: true });   // #2264: a restart
  return systemdRestartOutcome(label, user, run) === "restarted";
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
      ensureUserSystemd();   // #2264: the bus a non-login shell left out (a stop changes no host setting)
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
      ensureUserSystemd(undefined, { linger: true });   // #2264: without it, root on WSL got "Failed to connect to bus" and no fleet
      try { execSync("systemctl --user daemon-reload", { stdio: "pipe" }); } catch {}
      // #2331: a Type=notify unit that refuses the fleet's READY would be killed when its start times out.
      for (const line of loadedUnitCheck({ user: true, unit: SERVICE_LABEL, unitPath: join(homedir(), ".config", "systemd", "user", `${SERVICE_LABEL}.service`) })) console.log(line);
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
    reloadLaunchdJob(domain, label, plistPath);
  } else {
    const serviceName = plistPath.replace(/.*\//, "").replace(/\.service$/, "");
    ensureUserSystemd(undefined, { linger: true });   // #2264: linger on, so the fleet outlives the login that installed it
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    // #2331: what systemd loaded, before the fleet starts under it.
    for (const line of loadedUnitCheck({ user: true, unit: serviceName, unitPath: plistPath })) console.log(line);
    execSync(`systemctl --user enable --now ${serviceName}`, { stdio: "inherit" });
  }
}
