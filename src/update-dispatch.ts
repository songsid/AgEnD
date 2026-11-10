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
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export interface DispatchDeps {
  /** `env.PATH` (#3440) replaces PATH for that one program: an npm is asked in the PATH the update will run with. */
  run(command: string, args: string[], timeoutMs: number, env?: { PATH: string }): Promise<{ status: number | null; stdout: string }>;
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
  /** M-2858: the home directory, for the usual places an npm lives that a service's PATH may omit (nvm, Volta, fnm, asdf). */
  homeDir?: string;
  /** M-2858: a directory's entries (nvm's installed versions); none when it cannot be read. */
  listDir?(path: string): Promise<string[]>;
}

export const defaultDispatchDeps: DispatchDeps = {
  run: async (command, args, timeoutMs, env) => {
    try {
      const { stdout } = await promisify(execFile)(command, args, { encoding: "utf8", timeout: timeoutMs, ...(env ? { env: { ...process.env, ...env } } : {}) });
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
  listDir: async path => { try { return await readdir(path); } catch { return []; } },
};

/**
 * M-2858: where an npm usually is when it is not on this process's PATH — a launchd/systemd service, or a runtime that
 * ships Node alone (AgEnD's own bundled Node has no npm), runs with a PATH that may name none. nvm's versions (newest
 * first), Volta, fnm, asdf, Homebrew (Apple silicon, Intel), the system. Each is only a CANDIDATE: it is used only when
 * its global root is the running install's own (npmForRunningInstall), so finding one never updates another install.
 */
export async function usualNpmDirs(deps: Pick<DispatchDeps, "homeDir" | "listDir">): Promise<string[]> {
  const home = deps.homeDir ?? homedir();
  const list = deps.listDir ?? defaultDispatchDeps.listDir!;
  const nvmRoot = join(home, ".nvm", "versions", "node");
  const nvm = (await list(nvmRoot)).filter(v => /^v\d/.test(v))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true })).map(v => join(nvmRoot, v, "bin"));
  return [...nvm, join(home, ".volta", "bin"), join(home, ".local", "share", "fnm", "aliases", "default", "bin"), join(home, ".fnm", "aliases", "default", "bin"),
    join(home, ".asdf", "shims"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
}

/**
 * M-2858: the refusal when no npm can be found at all (not on PATH, not beside the install or its Node, not in a usual
 * place) — what to do, in plain words. Nothing has been changed when it is said.
 */
export function noNpmReason(where: string): string {
  return `no npm was found for the AgEnD installed in ${where}: it is not on this process's PATH, beside AgEnD or its Node, or in a usual place (nvm, Volta, fnm, asdf, Homebrew, /usr/local/bin). npm comes with Node.js: install Node.js (with its npm), or add the folder that holds npm to the PATH this runs with (for the fleet service too: run \`agend install\` again from a shell where \`npm\` works), then update again. Nothing was changed.`;
}

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

type NpmAnswer = { root: string; prefix: string } | null;

/** `npm root -g` / `npm prefix -g`, run as bare `npm` — in `env.PATH` when given, the way the update will run it. */
async function askNpm(deps: DispatchDeps, env?: { PATH: string }): Promise<NpmAnswer> {
  const last = (text: string) => text.trim().split("\n").pop()?.trim() ?? "";
  const ask = (what: string) => deps.run("npm", [what, "-g"], 15_000, env);
  const [root, prefix] = await Promise.all([ask("root"), ask("prefix")]);
  return root.status === 0 && prefix.status === 0 && last(root.stdout) && last(prefix.stdout) ? { root: last(root.stdout), prefix: last(prefix.stdout) } : null;
}

/**
 * #3440: the npm that manages the running install — never merely the first one on the fleet's PATH — PROVED IN THE
 * ENVIRONMENT THE UPDATE WILL RUN IN (#3442/#3443 review). The updater runs bare `npm` (its checks and install), and npm
 * runs on the first `node` its PATH finds, from which it takes its global prefix. So each candidate is a launch PATH —
 * an optional directory first, then the install's own bin (`<prefix>/bin`, as the launch script puts it), then the
 * fleet's PATH — and `npm root -g` is asked under exactly that PATH. Candidates, in order:
 *  1. nothing extra: the install's bin first (its own npm and Node — the 雲晴家 operator's colocated npm — or, with no
 *     npm there, PATH's npm on the Node that order picks);
 *  2. the directory of the Node running AgEnD, when an npm is beside it (AgEnD on a plain Node);
 *  3. the first PATH directory holding an npm, ahead of the install's bin.
 * One is accepted only when its global root IS the running package's root; its directory (2, 3) is then `npmDir`, which
 * the launch puts first — so what runs is what was proved. None: a refusal naming the root and what each answered.
 * A source checkout keeps the old rule: PATH's npm as it is.
 */
export async function npmForRunningInstall(deps: DispatchDeps = defaultDispatchDeps): Promise<{ root: string; prefix: string; npmDir?: string } | { reason: string }> {
  const running = await runningInstall(deps);
  if (running.kind === "unreadable") return { reason: running.reason };
  if (running.kind === "checkout") return (await askNpm(deps)) ?? { reason: "npm could not say where AgEnD is installed" };
  const expected = running.root;
  const executable = deps.isExecutable ?? defaultDispatchDeps.isExecutable!;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  // <prefix>/lib/node_modules → <prefix>/bin, where the colocated npm and its Node live (the 雲晴家 operator's colocatedNpm).
  const ownBin = dirname(colocatedNpm(join(expected, "@songsid", "agend"))?.args[0] ?? join(dirname(dirname(expected)), "bin", "npm"));
  const firstNpmOnPath = async (path: string): Promise<string | null> => {
    for (const dir of path.split(delimiter)) if (dir && isAbsolute(dir) && await executable(join(dir, "npm"))) return join(dir, "npm");
    return null;
  };
  const candidates: Array<{ npmDir?: string; label: string }> = [];
  const own = await firstNpmOnPath([ownBin, pathEnv].join(delimiter));
  candidates.push({ label: own ? (dirname(own) === ownBin ? own : `${own} (PATH's)`) : "npm on PATH" });
  const nodeDir = dirname(deps.execPath ?? process.execPath);
  if (nodeDir !== ownBin && await executable(join(nodeDir, "npm"))) candidates.push({ npmDir: nodeDir, label: `${join(nodeDir, "npm")} (beside the Node running AgEnD)` });
  const onPath = await firstNpmOnPath(pathEnv);
  if (onPath && dirname(onPath) !== ownBin && dirname(onPath) !== nodeDir) candidates.push({ npmDir: dirname(onPath), label: `${onPath} (first on PATH, ahead of ${ownBin})` });
  // M-2858: the usual places, when an npm is there and that directory was not already tried (PATH's own entries were).
  const tried0 = new Set([ownBin, nodeDir, ...pathEnv.split(delimiter).filter(Boolean)]);
  for (const dir of await usualNpmDirs(deps)) {
    if (tried0.has(dir) || !(await executable(join(dir, "npm")))) continue;
    tried0.add(dir);
    candidates.push({ npmDir: dir, label: `${join(dir, "npm")} (not on PATH)` });
  }
  // No npm anywhere: say what to do, not what each non-npm answered.
  if (!own && candidates.length === 1) return { reason: noNpmReason(dirname(dirname(expected))) };
  const tried: string[] = [];
  const realRoot = async (answer: NpmAnswer): Promise<string | null> => {
    if (!answer) return null;
    try { return await deps.realpath(answer.root); } catch { return answer.root; }
  };
  for (const c of candidates) {
    const answer = await askNpm(deps, { PATH: [c.npmDir, ownBin, pathEnv].filter(Boolean).join(delimiter) });
    const root = await realRoot(answer);
    tried.push(`${c.label} → ${root ?? "no answer"}`);
    if (!answer || root !== expected) continue;
    // #3443 review: the launch's `${1%/*}` is the bin of the prefix npm REPORTS (agend = <prefix>/bin/agend), which a
    // symlinked prefix makes differ from the bin guessed from the real root. Proved again in that exact PATH, or refused.
    const launchBin = join(answer.prefix, "bin");
    if (launchBin !== ownBin) {
      const again = await askNpm(deps, { PATH: [c.npmDir, launchBin, pathEnv].filter(Boolean).join(delimiter) });
      const againRoot = await realRoot(again);
      if (!again || againRoot !== expected || again.prefix !== answer.prefix) {
        tried.push(`${c.label}, in the launch PATH (${launchBin} first) → ${againRoot ?? "no answer"}`);
        continue;
      }
    }
    return { ...answer, ...(c.npmDir ? { npmDir: c.npmDir } : {}) };
  }
  return { reason: `no npm here manages the running AgEnD: expected the npm whose global root is ${expected} (tried ${tried.join("; ")})` };
}

/**
 * M-2858: `agend update` runs bare `npm` for every step. With an npm on `pathEnv`, nothing changes (null). With none, the
 * npm that manages the running install (npmForRunningInstall's proof) is found and its directory, then the install's own
 * bin, go first: the PATH to update with. None: the reason, before anything is asked or changed.
 */
export async function npmForUpdate(deps: DispatchDeps = defaultDispatchDeps, pathEnv: string = process.env.PATH ?? ""): Promise<{ ok: true; path: string | null; npmDir?: string } | { ok: false; reason: string }> {
  const executable = deps.isExecutable ?? defaultDispatchDeps.isExecutable!;
  for (const dir of pathEnv.split(delimiter)) if (dir && isAbsolute(dir) && await executable(join(dir, "npm"))) return { ok: true, path: null };
  const found = await npmForRunningInstall({ ...deps, pathEnv });
  if ("reason" in found) return { ok: false, reason: found.reason };
  const first = [found.npmDir, join(found.prefix, "bin")].filter((d): d is string => !!d);
  return { ok: true, path: [...first, pathEnv].filter(Boolean).join(delimiter), npmDir: first[0]! };
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
