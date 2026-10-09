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

/** The proven install. `bin` and `node` are realpaths. */
export interface VerifiedTarget {
  bin: string;
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

/** Split a systemd `Environment=` value: space-separated assignments, an assignment may be double-quoted. */
function splitSystemdEnvironment(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const item = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]!;
    const eq = item.indexOf("=");
    if (eq > 0) env[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return env;
}

/** `systemctl show -p ExecStart -p Environment -p NeedDaemonReload <unit>` → the loaded tuple and reload state. */
export function parseSystemdShow(text: string): { tuple: ActivationTuple | null; needDaemonReload: boolean | null; execStarts: number } {
  const props = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const exec = props.get("ExecStart") ?? "";
  const entries = [...exec.matchAll(/\{ path=([^;]*?) ; argv\[\]=([^;]*?) ;/g)];
  const need = props.get("NeedDaemonReload");
  const env = splitSystemdEnvironment(props.get("Environment") ?? "");
  const tuple = entries.length === 1
    ? { program: entries[0]![1]!.trim(), argv: entries[0]![2]!.trim().split(/\s+/), env }
    : null;
  return { tuple, needDaemonReload: need === "yes" ? true : need === "no" ? false : null, execStarts: entries.length };
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
 * - the bin script itself (`<bin> fleet start`, what `agend install` writes today): its realpath is the verified bin,
 *   and the interpreter its shebang resolves to on the definition's PATH is the verified Node;
 * - the interpreter explicitly (`<node> <bin> fleet start`, the private runtime's format): both realpaths verified.
 * Anything else — another entry inside the same package, another checkout, extra arguments, NODE_OPTIONS — is not.
 */
export function tupleStartsVerified(
  tuple: ActivationTuple,
  verified: VerifiedTarget,
  defaultPath: string,
  deps: TupleDeps,
): { ok: true } | { ok: false; reason: string } {
  for (const key of INTERPRETER_ENV) {
    if (tuple.env[key] !== undefined) return { ok: false, reason: `it sets ${key}` };
  }
  const program = deps.realpath(tuple.program);
  const args = tuple.argv.slice(1);
  if (program === verified.bin) {
    if (args.join(" ") !== "fleet start") return { ok: false, reason: `it runs "${args.join(" ")}", not "fleet start"` };
    const interpreter = scriptInterpreter(verified.bin, tuple.env.PATH ?? defaultPath, deps);
    if (interpreter !== verified.node) return { ok: false, reason: `its Node is ${interpreter ?? "unresolvable"}, not the verified ${verified.node}` };
    return { ok: true };
  }
  if (program === verified.node) {
    const entry = args[0] ? deps.realpath(args[0]) : null;
    if (entry !== verified.bin) return { ok: false, reason: `it starts ${args[0] ?? "nothing"}, not ${verified.bin}` };
    if (args.slice(1).join(" ") !== "fleet start") return { ok: false, reason: `it runs "${args.slice(1).join(" ")}", not "fleet start"` };
    return { ok: true };
  }
  return { ok: false, reason: `it starts ${tuple.program} (${program ?? "missing"}), not ${verified.bin}` };
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
    const show = deps.run("systemctl", [...scope, "show", "-p", "ExecStart", "-p", "Environment", "-p", "NeedDaemonReload", manager.unit]);
    const loaded = show.status === 0 ? parseSystemdShow(show.stdout) : null;
    if (!loaded || loaded.needDaemonReload !== false || !loaded.tuple) {
      return { ok: false, stopped: false, message: `  ✗ Could not read what systemd has loaded for ${manager.unit} (${loaded?.execStarts ?? 0} ExecStart, NeedDaemonReload=${loaded?.needDaemonReload ?? "unknown"}). Not restarting the fleet.` };
    }
    const match = tupleStartsVerified(loaded.tuple, verified, SYSTEMD_DEFAULT_PATH, deps);
    if (!match.ok) {
      return { ok: false, stopped: false, message: `  ✗ systemd's loaded ${manager.unit} does not start the verified install: ${match.reason}. Not restarting the fleet; fix the unit (agend install) and run agend restart.` };
    }
    deps.restart();
    return { ok: true, via: "restart" };
  }

  // launchd: the reload is the activation. Prove everything on disk first; then one bootout + bootstrap; then prove the
  // loaded job; on failure put the preimage job back.
  const preimage = deps.readFile(manager.plistPath);
  const target = `${manager.domain}/${manager.label}`;
  const refreshed = deps.refresh();
  if (refreshed.status !== 0) deps.log(`  ⚠ Service file refresh failed: ${(refreshed.stderr || refreshed.stdout).trim()}`);
  const onDisk = deps.readFile(manager.plistPath);
  const diskTuple = onDisk ? parsePlist(onDisk) : null;
  const diskMatch = diskTuple ? tupleStartsVerified(diskTuple, verified, LAUNCHD_DEFAULT_PATH, deps) : { ok: false as const, reason: "the plist cannot be read" };
  if (!diskMatch.ok) {
    if (preimage !== null && onDisk !== preimage) deps.writeFile(manager.plistPath, preimage);
    return { ok: false, stopped: false, message: `  ✗ ${manager.plistPath} does not start the verified install: ${diskMatch.reason}. Restored the previous plist; not restarting the fleet.` };
  }
  deps.run("launchctl", ["bootout", target]);
  const boot = deps.run("launchctl", ["bootstrap", manager.domain, manager.plistPath]);
  const printed = boot.status === 0 ? parseLaunchctlPrint(deps.run("launchctl", ["print", target]).stdout) : null;
  const loadedMatch = printed?.tuple ? tupleStartsVerified(printed.tuple, verified, LAUNCHD_DEFAULT_PATH, deps) : null;
  if (printed?.pid && loadedMatch?.ok) return { ok: true, via: "launchd-activation" };

  // Roll back to the job that was running before.
  deps.run("launchctl", ["bootout", target]);
  let restored = false;
  if (preimage !== null) {
    deps.writeFile(manager.plistPath, preimage);
    restored = deps.run("launchctl", ["bootstrap", manager.domain, manager.plistPath]).status === 0
      && parseLaunchctlPrint(deps.run("launchctl", ["print", target]).stdout).pid !== null;
  }
  const why = boot.status !== 0 ? "launchctl bootstrap failed" : !printed?.pid ? "the job did not start" : `launchd loaded a job that ${loadedMatch && !loadedMatch.ok ? loadedMatch.reason : "cannot be read"}`;
  return {
    ok: false, stopped: true,
    message: `  ✗ Activating the new launchd job failed: ${why}. ${restored ? "Rolled back to the previous job, which is running." : "The previous job could NOT be restored: run agend install and agend start."}`,
  };
}
