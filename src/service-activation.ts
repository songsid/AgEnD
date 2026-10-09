/**
 * Activating a verified install through its service manager (#1449 review r3).
 *
 * The update has proven an exact installed package: its bin target, and the Node that bin's shebang resolves to in the
 * install environment (where the native probe ran). Before anything is stopped, the service manager's EFFECTIVE
 * definition — what systemd has loaded (drop-ins and a failed reload included), what launchd has loaded — must start
 * that exact bin, with `fleet start`, on that exact interpreter, with no environment that changes how Node runs. The
 * disk file alone proves nothing: a drop-in can override `ExecStart`, a reload can fail, launchd keeps its cached job.
 *
 * Every manager command goes through an injected runner, so the sequences are testable without systemd or launchd.
 */
import type { CommandResult } from "./update-install.js";

/** What a manager would execute: the program, its full argv (argv[0] included), and the environment it sets. */
export interface ActivationTuple {
  program: string;
  argv: string[];
  env: Record<string, string>;
}

/**
 * The proven install; every path a realpath. `entry` is its canonical inner CLI, `<dir>/dist/cli.js` — what a service
 * starts (#1450 C4). Before the launcher it was also the npm bin; since #1450 the bin is the sh launcher.
 */
export interface VerifiedTarget {
  bin: string;
  entry: string;
  node: string;
  dir: string;
}

export interface TupleDeps {
  realpath(path: string): string | null;
  /** First line of a file, or null. */
  readFirstLine(path: string): string | null;
  /** Is `path` an executable regular file? */
  isExecutable(path: string): boolean;
}

/** Environment that changes what Node runs or loads: never accepted in a service definition AgEnD activates. */
const INTERPRETER_ENV = ["NODE_OPTIONS", "NODE_PATH"];

/** systemd's PATH when a unit sets none (systemd.exec, "Environment variables in spawned processes"). */
export const SYSTEMD_DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** launchd's PATH when a job sets none. */
export const LAUNCHD_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A busctl `--json=short` reply's `data`, or null. */
function busData(result: CommandResult): unknown {
  if (result.status !== 0) return null;
  try { return (JSON.parse(result.stdout) as { data?: unknown }).data ?? null; } catch { return null; }
}

/** `KEY=VALUE` strings → a map (later entries win, as in systemd). */
function assignments(list: unknown): Record<string, string> | null {
  if (!Array.isArray(list) || !list.every(item => typeof item === "string")) return null;
  const env: Record<string, string> = {};
  for (const item of list as string[]) {
    const eq = item.indexOf("=");
    if (eq > 0) env[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return env;
}

export interface LoadedUnit {
  /** The one ExecStart, argv exactly as systemd holds it (lossless: D-Bus `as`, not `systemctl show`'s joined text). */
  tuple: ActivationTuple;
  needDaemonReload: boolean;
}

/**
 * What systemd will execute for `unit`, read over D-Bus with `busctl --json=short` (#1449 review r4: `systemctl show`
 * joins argv with spaces, so `"fleet start"` and `fleet start` print alike). The effective environment is the
 * manager's environment, then the unit's `Environment=`, then `UnsetEnvironment=`. A unit that also reads
 * `EnvironmentFile=` or uses `PassEnvironment=` cannot be proven from here: refused, never guessed.
 */
export function readLoadedUnit(run: (command: string, args: string[]) => CommandResult, user: boolean, unit: string): { ok: true; unit: LoadedUnit } | { ok: false; reason: string } {
  const scope = user ? ["--user"] : [];
  const name = unit.endsWith(".service") ? unit : `${unit}.service`;
  const bus = (args: string[]) => busData(run("busctl", [...scope, "--json=short", ...args]));
  const path = bus(["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "LoadUnit", "s", name]);
  const objectPath = Array.isArray(path) && typeof path[0] === "string" ? path[0] : null;
  if (!objectPath) return { ok: false, reason: `systemd does not know ${name}` };
  const prop = (iface: string, property: string) => bus(["get-property", "org.freedesktop.systemd1", objectPath, `org.freedesktop.systemd1.${iface}`, property]);
  const exec = prop("Service", "ExecStart");
  if (!Array.isArray(exec) || exec.length !== 1 || !Array.isArray(exec[0]) || typeof exec[0][0] !== "string" || !Array.isArray(exec[0][1])) {
    return { ok: false, reason: `its ExecStart is not exactly one command (${Array.isArray(exec) ? exec.length : "unreadable"})` };
  }
  const argv = exec[0][1] as unknown[];
  if (!argv.every(item => typeof item === "string")) return { ok: false, reason: "its ExecStart argv is unreadable" };
  const files = prop("Service", "EnvironmentFiles");
  if (!Array.isArray(files)) return { ok: false, reason: "its EnvironmentFiles cannot be read" };
  if (files.length > 0) return { ok: false, reason: "it reads EnvironmentFile=, whose effect cannot be proven here" };
  const pass = prop("Service", "PassEnvironment");
  if (!Array.isArray(pass)) return { ok: false, reason: "its PassEnvironment cannot be read" };
  if (pass.length > 0) return { ok: false, reason: "it uses PassEnvironment=, whose effect cannot be proven here" };
  const manager = assignments(bus(["get-property", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Environment"]));
  const own = assignments(prop("Service", "Environment"));
  const unset = prop("Service", "UnsetEnvironment");
  if (!manager || !own || !Array.isArray(unset) || !unset.every(item => typeof item === "string")) {
    return { ok: false, reason: "its environment cannot be read" };
  }
  const env: Record<string, string> = { ...manager, ...own };
  for (const item of unset as string[]) {
    const eq = item.indexOf("=");
    if (eq < 0) delete env[item];
    else if (env[item.slice(0, eq)] === item.slice(eq + 1)) delete env[item.slice(0, eq)];
  }
  const need = prop("Unit", "NeedDaemonReload");
  if (typeof need !== "boolean") return { ok: false, reason: "NeedDaemonReload cannot be read" };
  return { ok: true, unit: { tuple: { program: exec[0][0] as string, argv: argv as string[], env }, needDaemonReload: need } };
}

const xmlUnescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** A launchd plist on disk → the tuple it would run (ProgramArguments; EnvironmentVariables). */
export function parsePlist(xml: string): ActivationTuple | null {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!args) return null;
  const argv = [...args[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => xmlUnescape(m[1]!));
  if (argv.length === 0) return null;
  const env: Record<string, string> = {};
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml);
  if (dict) for (const m of dict[1]!.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) env[xmlUnescape(m[1]!)] = xmlUnescape(m[2]!);
  const program = /<key>Program<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml);
  return { program: program ? xmlUnescape(program[1]!) : argv[0]!, argv, env };
}

/** `launchctl print gui/<uid>/<label>` → the loaded tuple, its pid and state. */
export function parseLaunchctlPrint(text: string): { tuple: ActivationTuple | null; pid: number | null; state: string | null } {
  const lines = text.split("\n").map(l => l.trim());
  const value = (key: string) => lines.find(l => l.startsWith(`${key} = `))?.slice(key.length + 3).trim() ?? null;
  const block = (key: string): string[] | null => {
    const start = lines.findIndex(l => l === `${key} = {`);
    if (start < 0) return null;
    const end = lines.findIndex((l, i) => i > start && l === "}");
    return end < 0 ? null : lines.slice(start + 1, end);
  };
  const argv = block("arguments");
  const env: Record<string, string> = {};
  for (const l of block("environment") ?? []) {
    const at = l.indexOf(" => ");
    if (at > 0) env[l.slice(0, at)] = l.slice(at + 4);
  }
  const program = value("program");
  const pid = Number(value("pid"));
  return {
    tuple: program && argv && argv.length > 0 ? { program, argv, env } : null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    state: value("state"),
  };
}

/** The arguments `fleet start`, as two separate elements (never one "fleet start" argument). */
const FLEET_START = ["fleet", "start"];
const sameArgs = (args: string[], want: string[]) => args.length === want.length && args.every((arg, i) => arg === want[i]);

/** The interpreter a script runs on: its shebang, `env node` resolved on the definition's PATH. */
function scriptInterpreter(script: string, path: string, deps: TupleDeps): string | null {
  const line = deps.readFirstLine(script);
  if (!line?.startsWith("#!")) return null;
  const parts = line.slice(2).trim().split(/\s+/);
  let program = parts[0] ?? "";
  if (/(^|\/)env$/.test(program)) {
    const name = parts.slice(1).find(p => !p.startsWith("-"));
    if (!name) return null;
    program = path.split(":").filter(Boolean).map(dir => `${dir}/${name}`).find(candidate => deps.isExecutable(candidate)) ?? "";
  }
  return program ? deps.realpath(program) : null;
}

/**
 * Does this effective tuple start exactly the verified install? Two shapes are accepted:
 * - the entry script itself (`<entry> fleet start`, what `agend install` writes today): its realpath is the verified
 *   entry, and the interpreter its shebang resolves to on the definition's PATH is the verified Node;
 * - the interpreter explicitly (`<node> <entry> fleet start`, the private runtime's format): both realpaths verified.
 * Anything else — another entry inside the same package, another checkout, extra arguments, NODE_OPTIONS — is not.
 */
export function tupleStartsVerified(
  tuple: ActivationTuple,
  verified: VerifiedTarget,
  _defaultPath: string,
  deps: TupleDeps,
): { ok: true } | { ok: false; reason: string } {
  for (const key of INTERPRETER_ENV) {
    if (tuple.env[key] !== undefined) return { ok: false, reason: `it sets ${key}` };
  }
  const program = deps.realpath(tuple.program);
  const args = tuple.argv.slice(1);
  if (program === verified.entry) {
    if (!sameArgs(args, FLEET_START)) return { ok: false, reason: `its arguments are ${JSON.stringify(args)}, not ["fleet","start"]` };
    // PATH must be in the definition's effective environment: with none (e.g. UnsetEnvironment=PATH), `env node`
    // searches execvp's built-in path (glibc: /bin:/usr/bin), not any manager default — unprovable here (#1449 r5).
    if (tuple.env.PATH === undefined) return { ok: false, reason: "its environment has no PATH, so the Node its `env node` would find cannot be proven" };
    const interpreter = scriptInterpreter(verified.entry, tuple.env.PATH, deps);
    if (interpreter !== verified.node) return { ok: false, reason: `its Node is ${interpreter ?? "unresolvable"}, not the verified ${verified.node}` };
    return { ok: true };
  }
  if (program === verified.node) {
    const entry = args[0] ? deps.realpath(args[0]) : null;
    if (entry !== verified.entry) return { ok: false, reason: `it starts ${args[0] ?? "nothing"}, not ${verified.entry}` };
    if (!sameArgs(args.slice(1), FLEET_START)) return { ok: false, reason: `its arguments are ${JSON.stringify(args.slice(1))}, not ["fleet","start"]` };
    return { ok: true };
  }
  return { ok: false, reason: `it starts ${tuple.program} (${program ?? "missing"}), not ${verified.entry}` };
}

export type ServiceManager =
  | { kind: "systemd"; unit: string; user: boolean }
  | { kind: "launchd"; label: string; plistPath: string; domain: string }
  | { kind: "detached" };

export interface ActivationDeps extends TupleDeps {
  run(command: string, args: string[]): CommandResult;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  /** `agend install --no-activate` through the verified binary. */
  refresh(): CommandResult;
  /** `agend restart` through the verified binary (systemd, detached). Returns its exit status. */
  restart(): void;
  log(message: string): void;
}

export type ActivationOutcome =
  | { ok: true; via: "restart" | "launchd-activation" }
  | { ok: false; message: string; stopped: boolean };

/**
 * Refresh, prove, activate. Nothing is stopped before the effective definition is proven, except where the manager's
 * reload IS the activation (launchd: bootout + bootstrap of a RunAtLoad/KeepAlive job), which is done once, then
 * proven, and rolled back to the preimage job if the proof fails.
 */
export function activateService(manager: ServiceManager, verified: VerifiedTarget, deps: ActivationDeps): ActivationOutcome {
  if (manager.kind === "detached") {
    const refreshed = deps.refresh();
    if (refreshed.status !== 0) deps.log("  ⚠ Service file refresh reported an error (no service installed; continuing)");
    deps.restart();
    return { ok: true, via: "restart" };
  }

  if (manager.kind === "systemd") {
    const scope = manager.user ? ["--user"] : [];
    const refreshed = deps.refresh();
    if (refreshed.status !== 0) deps.log(`  ⚠ Service file refresh failed: ${(refreshed.stderr || refreshed.stdout).trim()}`);
    const reload = deps.run("systemctl", [...scope, "daemon-reload"]);
    if (reload.status !== 0) {
      return { ok: false, stopped: false, message: `  ✗ systemctl${manager.user ? " --user" : ""} daemon-reload failed, so systemd still runs the old definition. Not restarting the fleet.` };
    }
    const read = readLoadedUnit(deps.run, manager.user, manager.unit);
    if (!read.ok) {
      return { ok: false, stopped: false, message: `  ✗ Cannot prove what systemd will run for ${manager.unit}: ${read.reason}. Not restarting the fleet.` };
    }
    const loaded = read.unit;
    if (loaded.needDaemonReload) {
      return { ok: false, stopped: false, message: `  ✗ systemd still needs a daemon-reload for ${manager.unit} (the loaded definition is not the file). Not restarting the fleet.` };
    }
    const match = tupleStartsVerified(loaded.tuple, verified, SYSTEMD_DEFAULT_PATH, deps);
    if (!match.ok) {
      return { ok: false, stopped: false, message: `  ✗ systemd's loaded ${manager.unit} does not start the verified install: ${match.reason}. Not restarting the fleet; fix the unit (agend install) and run agend restart.` };
    }
    deps.restart();
    return { ok: true, via: "restart" };
  }

  // launchd: the reload is the activation (#1449 review r4).
  // Before anything is stopped: the job launchd has LOADED must be the one its plist on disk describes, so that this
  // plist is a true preimage to roll back to; launchd's own environment must not inject NODE_OPTIONS/NODE_PATH; and
  // the refreshed plist must start the verified install. Then one bootout + bootstrap, proven by the loaded tuple and
  // a running pid. Recovery bootstraps the preimage and must prove ITS tuple is what runs — not just any pid.
  const target = `${manager.domain}/${manager.label}`;
  // Every read must COMPLETE (#1449 r5): a timed-out or failed query is uncertainty, never "unset" or "not loaded".
  const completed = (r: CommandResult) => r.status !== null && r.signal === null;
  for (const key of ["NODE_OPTIONS", "NODE_PATH"]) {
    const value = deps.run("launchctl", ["getenv", key]);
    if (!completed(value) || value.status !== 0) {
      return { ok: false, stopped: false, message: `  ✗ Could not read launchd's ${key} (launchctl getenv ${value.signal ? `killed by ${value.signal}` : `exited ${value.status}`}). Not activating; nothing was changed.` };
    }
    if (value.stdout.trim() !== "") {
      return { ok: false, stopped: false, message: `  ✗ launchd's environment sets ${key} for every job, which changes how Node runs. Not activating; unset it (launchctl unsetenv ${key}).` };
    }
  }
  const preimage = deps.readFile(manager.plistPath);
  const preimageTuple = preimage !== null ? parsePlist(preimage) : null;
  // The loaded job, or a CONFIRMED absence: launchctl print exits 113 ("Could not find service") for a job that is not
  // loaded. Anything else that is not a complete, readable job is uncertainty: refuse with nothing touched.
  const before = deps.run("launchctl", ["print", target]);
  let loadedBefore: ReturnType<typeof parseLaunchctlPrint> | null = null;
  if (completed(before) && before.status === 0) {
    loadedBefore = parseLaunchctlPrint(before.stdout);
    if (!loadedBefore.tuple) {
      return { ok: false, stopped: false, message: `  ✗ launchctl print of ${manager.label} could not be read. Not activating; nothing was changed.` };
    }
  } else if (!(completed(before) && before.status === 113)) {
    return { ok: false, stopped: false, message: `  ✗ Could not tell whether ${manager.label} is loaded (launchctl print ${before.signal ? `killed by ${before.signal}` : `exited ${before.status}`}). Not activating; nothing was changed.` };
  }
  if (loadedBefore && (!loadedBefore.tuple || !preimageTuple || !sameJob(loadedBefore.tuple, preimageTuple))) {
    return { ok: false, stopped: false, message: `  ✗ The job launchd has loaded for ${manager.label} is not the one ${manager.plistPath} describes, so there is no job to roll back to safely. Not activating; reload it (agend install, agend restart) first.` };
  }
  const refreshed = deps.refresh();
  if (refreshed.status !== 0) deps.log(`  ⚠ Service file refresh failed: ${(refreshed.stderr || refreshed.stdout).trim()}`);
  const onDisk = deps.readFile(manager.plistPath);
  const diskTuple = onDisk ? parsePlist(onDisk) : null;
  const diskMatch = diskTuple ? tupleStartsVerified(diskTuple, verified, LAUNCHD_DEFAULT_PATH, deps) : { ok: false as const, reason: "the plist cannot be read" };
  if (!diskMatch.ok) {
    if (preimage !== null && onDisk !== preimage) deps.writeFile(manager.plistPath, preimage);
    return { ok: false, stopped: false, message: `  ✗ ${manager.plistPath} does not start the verified install: ${diskMatch.reason}. Restored the previous plist; not restarting the fleet.` };
  }
  if (loadedBefore) {
    const out = deps.run("launchctl", ["bootout", target]);
    if (!completed(out) || out.status !== 0) {
      // The old job may well still be running: leave it, put its plist back.
      if (preimage !== null) deps.writeFile(manager.plistPath, preimage);
      return { ok: false, stopped: false, message: `  ✗ launchctl bootout of ${manager.label} did not complete (${out.signal ? `killed by ${out.signal}` : `exit ${out.status}`}). Restored the previous plist; not activating.` };
    }
  }
  const boot = deps.run("launchctl", ["bootstrap", manager.domain, manager.plistPath]);
  const after = completed(boot) && boot.status === 0 ? deps.run("launchctl", ["print", target]) : null;
  const printed = after && completed(after) && after.status === 0 ? parseLaunchctlPrint(after.stdout) : null;
  const loadedMatch = printed?.tuple ? tupleStartsVerified(printed.tuple, verified, LAUNCHD_DEFAULT_PATH, deps) : null;
  if (printed?.pid && printed.state === "running" && loadedMatch?.ok) return { ok: true, via: "launchd-activation" };

  // Roll back: whatever loaded goes; the preimage plist goes back on disk; the preimage job comes back only if one was
  // running before, and only counts as restored when launchd runs exactly its tuple.
  deps.run("launchctl", ["bootout", target]);
  if (preimage !== null) deps.writeFile(manager.plistPath, preimage);
  let recovery = "No job was running before; the previous plist is back on disk.";
  if (loadedBefore && preimageTuple) {
    const reboot = deps.run("launchctl", ["bootstrap", manager.domain, manager.plistPath]);
    const check = completed(reboot) && reboot.status === 0 ? deps.run("launchctl", ["print", target]) : null;
    const back = check && completed(check) && check.status === 0 ? parseLaunchctlPrint(check.stdout) : null;
    recovery = back?.tuple && back.pid && back.state === "running" && sameJob(back.tuple, preimageTuple)
      ? "Rolled back to the previous job, which is running."
      : "The previous job could NOT be restored: run agend install and agend start.";
  }
  const why = !completed(boot) || boot.status !== 0 ? "launchctl bootstrap failed"
    : !printed ? "launchctl print of the new job did not complete"
    : !printed.pid || printed.state !== "running" ? "the job did not start"
    : `launchd loaded a job that ${loadedMatch && !loadedMatch.ok ? loadedMatch.reason : "cannot be read"}`;
  return { ok: false, stopped: loadedBefore !== null, message: `  ✗ Activating the new launchd job failed: ${why}. ${recovery}` };
}

/** Two launchd jobs are the same when their program and argv are identical and every variable the plist sets matches. */
function sameJob(loaded: ActivationTuple, plist: ActivationTuple): boolean {
  return loaded.program === plist.program
    && sameArgs(loaded.argv, plist.argv)
    && Object.entries(plist.env).every(([key, value]) => loaded.env[key] === value);
}
