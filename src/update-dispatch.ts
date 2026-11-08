/**
 * #1450 C5: chat `/update` runs the INSTALLED `agend` — the one npm put in its global prefix, verified by identity —
 * by absolute path, never whichever `agend` comes first on the fleet's PATH (a checkout, another prefix). That keeps
 * the deliberate choice "update what is installed, on its own channel" (the CLI picks the channel from the version it
 * replaces). No unverified fallback: when npm cannot say where it installed AgEnD, or what it says does not hold
 * together, `/update` refuses and says to run `agend update` from a shell.
 *
 * #3440: which `npm` is asked matters. A fleet service's PATH can put a system npm (e.g. `/usr/bin/npm`) ahead of the
 * nvm Node that installed AgEnD, and that npm's global root has no AgEnD in it. The npm that manages THIS running
 * package is the one asked: an npm is accepted only when its global root is the running package's own root. With the
 * patch from the 雲晴家 fleet operator, who verified it on the original failing machine.
 *
 * Runs on the fleet's event loop: every step is async and bounded.
 */
import { execFile } from "./child-process.js";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export interface DispatchDeps {
  run(command: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string }>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  /** An executable file there (#3440). */
  isExecutable?(path: string): Promise<boolean>;
  /** The package directory this code runs from — whose global root the npm asked must have (#3440). Null: unknown. */
  packageDir?: string | null;
  /** The Node running this process (#3440): the npm beside it is a candidate when AgEnD runs on a plain Node. */
  execPath?: string;
  /** This process's PATH (#3440): where PATH's `npm` lives. */
  pathEnv?: string;
}

export const defaultDispatchDeps: DispatchDeps = {
  run: async (command, args, timeoutMs) => {
    try {
      const { stdout } = await promisify(execFile)(command, args, { encoding: "utf8", timeout: timeoutMs });
      return { status: 0, stdout: String(stdout) };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return { status: typeof code === "number" ? code : null, stdout: "" };
    }
  },
  readFile: path => readFile(path, "utf8"),
  realpath: path => realpath(path),
  isExecutable: async path => { try { await access(path, constants.X_OK); return true; } catch { return false; } },
  packageDir: fileURLToPath(new URL("..", import.meta.url)),
  execPath: process.execPath,
};

/**
 * #3440: the `npm` beside a POSIX global install of this package: `<prefix>/lib/node_modules/@songsid/agend` →
 * `<prefix>/bin/npm`, run by `<prefix>/bin/node`. npm takes its global prefix from the Node that runs it, and its
 * `#!/usr/bin/env node` would pick PATH's Node — the same system one that hid the install — so the prefix's own Node runs
 * it explicitly. Null for anything else (a checkout, a Windows prefix). (From the 雲晴家 fleet operator's patch.)
 */
export function colocatedNpm(packageDir: string | null | undefined, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | null {
  if (!packageDir || platform === "win32") return null;
  const pkg = packageDir.replace(/\/+$/, "");
  const scope = dirname(pkg), root = dirname(scope), lib = dirname(root);
  if (basename(pkg) !== "agend" || basename(scope) !== "@songsid" || basename(root) !== "node_modules" || basename(lib) !== "lib") return null;
  const bin = join(dirname(lib), "bin");
  return { command: join(bin, "node"), args: [join(bin, "npm")] };
}

/**
 * #3440: what the running package is — a global install (its realpath'd global node_modules), a source checkout, or
 * unknowable. A location that cannot be read (EACCES, the package being replaced) is NOT a checkout: guessing from
 * PATH then could update another install (#3443 review), so it refuses. No package directory at all: PATH's npm, as before.
 */
type RunningInstall = { kind: "global"; root: string } | { kind: "checkout" } | { kind: "unreadable"; reason: string };
async function runningInstall(deps: DispatchDeps): Promise<RunningInstall> {
  if (!deps.packageDir) return { kind: "checkout" };
  let real: string;
  try { real = await deps.realpath(deps.packageDir); }
  catch (err) {
    const code = (err as { code?: unknown }).code;
    return { kind: "unreadable", reason: `cannot read where the running AgEnD is installed (${deps.packageDir}${typeof code === "string" ? `: ${code}` : ""}), so it cannot tell which install to update` };
  }
  const scope = dirname(real), root = dirname(scope);
  return basename(real) === "agend" && basename(scope) === "@songsid" && basename(root) === "node_modules" ? { kind: "global", root } : { kind: "checkout" };
}

type Npm = { command: string; args: string[]; label: string };

/**
 * #3440 (#3443 review): the directory of the npm that proved the install, for the update to run with first on PATH — so
 * the CLI's own npm checks and install, and the Node npm runs on, are the ones just verified, never another npm the
 * service's PATH lists first. A candidate run by an explicit Node: that npm's directory (its Node beside it). PATH's: the
 * first PATH directory holding an executable `npm`.
 */
async function npmDirOf(npm: Npm, deps: DispatchDeps, executable: (path: string) => Promise<boolean>): Promise<string | undefined> {
  if (npm.args.length) return dirname(npm.args[0]!);
  for (const dir of (deps.pathEnv ?? process.env.PATH ?? "").split(delimiter)) {
    if (dir && isAbsolute(dir) && await executable(join(dir, "npm"))) return dir;
  }
  return undefined;
}
type NpmAnswer = { root: string; prefix: string } | null;

async function askNpm(npm: Npm, deps: DispatchDeps): Promise<NpmAnswer> {
  const last = (text: string) => text.trim().split("\n").pop()?.trim() ?? "";
  const ask = (what: string) => deps.run(npm.command, [...npm.args, what, "-g"], 15_000);
  const [root, prefix] = await Promise.all([ask("root"), ask("prefix")]);
  return root.status === 0 && prefix.status === 0 && last(root.stdout) && last(prefix.stdout) ? { root: last(root.stdout), prefix: last(prefix.stdout) } : null;
}

/**
 * #3440: the npm that manages the running install — never merely the first one on the fleet's PATH. Candidates: the npm
 * beside the running package (run by that prefix's Node), the npm beside the Node running AgEnD (run by it), then PATH's.
 * One is accepted only when its global root IS the running package's root, so another install elsewhere (an old AgEnD in
 * a system root) can never be the one updated. A source checkout keeps the old rule: PATH's npm.
 */
async function npmForRunningInstall(deps: DispatchDeps): Promise<{ root: string; prefix: string; npmDir?: string } | { reason: string }> {
  const running = await runningInstall(deps);
  const onPath: Npm = { command: "npm", args: [], label: "npm on PATH" };
  if (running.kind === "unreadable") return { reason: running.reason };
  if (running.kind === "checkout") return (await askNpm(onPath, deps)) ?? { reason: "npm could not say where AgEnD is installed" };
  const expected = running.root;
  const executable = deps.isExecutable ?? defaultDispatchDeps.isExecutable!;
  const candidates: Npm[] = [];
  const beside = colocatedNpm(join(expected, "@songsid", "agend"));
  if (beside && await executable(beside.command) && await executable(beside.args[0]!)) candidates.push({ ...beside, label: beside.args[0]! });
  const execPath = deps.execPath ?? process.execPath;
  const nextToNode = join(dirname(execPath), "npm");
  if (!candidates.some(c => c.label === nextToNode) && await executable(nextToNode)) candidates.push({ command: execPath, args: [nextToNode], label: nextToNode });
  candidates.push(onPath);
  const tried: string[] = [];
  for (const npm of candidates) {
    const answer = await askNpm(npm, deps);
    let root: string | null = null;
    if (answer) { try { root = await deps.realpath(answer.root); } catch { root = answer.root; } }
    tried.push(`${npm.label} → ${root ?? "no answer"}`);
    if (answer && root === expected) return { ...answer, npmDir: await npmDirOf(npm, deps, executable) };
  }
  return { reason: `no npm here manages the running AgEnD: expected the npm whose global root is ${expected} (tried ${tried.join("; ")})` };
}

/** `npmDir` (#3440): the directory of the npm that proved this install — the update runs with it first on PATH. */
export type InstalledAgend = { ok: true; agend: string; version: string; npmDir?: string } | { ok: false; reason: string };

/** npm's global root and prefix → the installed package, its bin target, and the bin link that must lead to it. */
export async function resolveInstalledAgend(deps: DispatchDeps = defaultDispatchDeps): Promise<InstalledAgend> {
  const found = await npmForRunningInstall(deps);
  if ("reason" in found) return { ok: false, reason: found.reason };
  const pkgDir = join(found.root, "@songsid", "agend");
  const notAgend = { ok: false as const, reason: `${pkgDir} is not an installed AgEnD package` };
  let parsed: unknown;
  try { parsed = JSON.parse(await deps.readFile(join(pkgDir, "package.json"))); }
  catch { return notAgend; }
  // Whatever parsed (null, an array, a string…) is judged by shape, never dereferenced blindly.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return notAgend;
  const manifest = parsed as { name?: unknown; version?: unknown; bin?: unknown };
  const bin = manifest.bin;
  const binRel = typeof bin === "string" ? bin
    : typeof bin === "object" && bin !== null && !Array.isArray(bin) && typeof (bin as Record<string, unknown>).agend === "string" ? (bin as Record<string, string>).agend : null;
  if (manifest.name !== "@songsid/agend" || typeof manifest.version !== "string" || !manifest.version || !binRel) return notAgend;
  const agend = join(found.prefix, "bin", "agend");
  let target: string, linked: string;
  try { [target, linked] = await Promise.all([deps.realpath(join(pkgDir, binRel)), deps.realpath(agend)]); }
  catch { return { ok: false, reason: `${agend} does not lead to the installed package` }; }
  if (target !== linked) return { ok: false, reason: `${agend} leads to ${linked}, not the installed package's ${target}` };
  return { ok: true, agend, version: manifest.version, ...(found.npmDir ? { npmDir: found.npmDir } : {}) };
}

/**
 * `<installed agend> update`, 2 s from now, from a detached `sh`. Service callers must wrap it in an independent scope before launch. The
 * path is a positional argument, never spliced into the script. #3440: the agend's own bin directory (`<prefix>/bin`,
 * where its `npm` and `node` live) goes first on PATH, so the CLI's npm checks and install use the npm that installed
 * it, not a system npm the service's PATH happens to list first. (From the 雲晴家 fleet operator's patch.) That also puts
 * every global package's bin ahead of the system tools for the updater's run — as in an nvm user's own shell.
 */
export const DELAYED_UPDATE_SCRIPT = 'sleep 2 && PATH="${1%/*}:$PATH" && export PATH && exec "$1" update';
/** #3443 review: with the proving npm's directory (`$2`, data) ahead of the agend's own — it may hold no npm (a custom prefix). */
export const DELAYED_UPDATE_SCRIPT_NPM = 'sleep 2 && PATH="$2:${1%/*}:$PATH" && export PATH && exec "$1" update';
export function updateCommand(agend: string, npmDir?: string): { command: string; args: string[] } {
  return npmDir && isAbsolute(npmDir)
    ? { command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT_NPM, "sh", agend, npmDir] }
    : { command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT, "sh", agend] };
}
