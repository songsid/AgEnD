/**
 * #1450 C5: chat `/update` runs the INSTALLED `agend` — the one npm put in its global prefix, verified by identity —
 * by absolute path, never whichever `agend` comes first on the fleet's PATH (a checkout, another prefix). That keeps
 * the deliberate choice "update what is installed, on its own channel" (the CLI picks the channel from the version it
 * replaces). No unverified fallback: when npm cannot say where it installed AgEnD, or what it says does not hold
 * together, `/update` refuses and says to run `agend update` from a shell.
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
  /** `env` replaces PATH for that one program (an npm runs with its own directory first, so its node is its own). */
  run(command: string, args: string[], timeoutMs: number, env?: { PATH: string }): Promise<{ status: number | null; stdout: string }>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  /** An executable file there. */
  isExecutable?(path: string): Promise<boolean>;
  /** The running AgEnD package's directory (where THIS code is installed). */
  packageDir?: string;
  /** The Node running this process. */
  execPath?: string;
  /** This process's PATH. */
  pathEnv?: string;
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
};

/**
 * `binDir`: the directory of the npm that manages this install — the update must run with it first on PATH, so its
 * `agend update`, `npm` and npm's `node` are this install's (#3440). Absent: PATH already finds it (or a source checkout).
 */
export type InstalledAgend = { ok: true; agend: string; version: string; binDir?: string } | { ok: false; reason: string };

/**
 * #3440: the global node_modules this running AgEnD was installed into, from where its code actually lives
 * (`<root>/@songsid/agend`), or null when it is not a global install (a source checkout: the PATH npm decides, as before).
 */
async function runningGlobalRoot(deps: DispatchDeps): Promise<string | null> {
  const dir = deps.packageDir ?? fileURLToPath(new URL("..", import.meta.url));
  let real: string;
  try { real = await deps.realpath(dir); } catch { return null; }
  const scope = dirname(real), root = dirname(scope);
  return basename(real) === "agend" && basename(scope) === "@songsid" && basename(root) === "node_modules" ? root : null;
}

/**
 * #3440: the npm that manages the running install, never merely the first one on the fleet's PATH (a service's PATH can
 * be minimal, or put a system npm before nvm's). Candidates: `<prefix>/bin/npm` beside the running package, the npm
 * next to the Node running AgEnD, then PATH's. Each runs with its own directory first on PATH — npm takes its global
 * prefix from the Node that runs it — and is accepted only when its `npm root -g` is the running package's root.
 */
async function npmForRunningInstall(deps: DispatchDeps): Promise<{ npm: string; binDir?: string; root: string; prefix: string } | { reason: string }> {
  const last = (text: string) => text.trim().split("\n").pop()?.trim() ?? "";
  const ask = async (npm: string, env?: { PATH: string }) => {
    const [root, prefix] = await Promise.all([deps.run(npm, ["root", "-g"], 15_000, env), deps.run(npm, ["prefix", "-g"], 15_000, env)]);
    return root.status === 0 && prefix.status === 0 && last(root.stdout) && last(prefix.stdout) ? { root: last(root.stdout), prefix: last(prefix.stdout) } : null;
  };
  const expected = await runningGlobalRoot(deps);
  if (!expected) {
    const answer = await ask("npm");
    return answer ? { npm: "npm", ...answer } : { reason: "npm could not say where AgEnD is installed" };
  }
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  const executable = deps.isExecutable ?? defaultDispatchDeps.isExecutable!;
  const candidates = [...new Set([
    join(dirname(dirname(expected)), "bin", "npm"),                 // <prefix>/lib/node_modules → <prefix>/bin/npm
    join(dirname(deps.execPath ?? process.execPath), "npm"),          // the npm beside a plain Node running AgEnD
  ])];
  const tried: string[] = [];
  for (const npm of candidates) {
    if (!(await executable(npm))) continue;
    const binDir = dirname(npm);
    const answer = await ask(npm, { PATH: [binDir, pathEnv].filter(Boolean).join(delimiter) });
    let root: string | null = null;
    if (answer) { try { root = await deps.realpath(answer.root); } catch { root = answer.root; } }
    tried.push(`${npm} → ${root ?? "no answer"}`);
    if (root === expected) return { npm, binDir, ...answer! };
  }
  const onPath = await ask("npm", { PATH: pathEnv });
  let pathRoot: string | null = null;
  if (onPath) { try { pathRoot = await deps.realpath(onPath.root); } catch { pathRoot = onPath.root; } }
  tried.push(`npm on PATH → ${pathRoot ?? "no answer"}`);
  if (onPath && pathRoot === expected) return { npm: "npm", ...onPath };
  return { reason: `no npm here manages the running AgEnD: expected the npm whose global root is ${expected} (tried ${tried.join("; ")})` };
}

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
  return { ok: true, agend, version: manifest.version, ...(found.binDir ? { binDir: found.binDir } : {}) };
}

/**
 * `<installed agend> update`, 2 s from now, from a detached `sh`. Service callers must wrap it in an independent scope before launch. The
 * path is a positional argument, never spliced into the script. With `binDir` (#3440), that npm's directory goes first on
 * PATH — also data, `$2` — so the update's own `npm`, and the `node` npm runs on, are the running install's.
 */
export const DELAYED_UPDATE_SCRIPT = 'sleep 2 && exec "$1" update';
export const DELAYED_UPDATE_SCRIPT_WITH_PATH = 'sleep 2 && PATH="$2:$PATH" && export PATH && exec "$1" update';
export function updateCommand(agend: string, binDir?: string): { command: string; args: string[] } {
  return binDir && isAbsolute(binDir)
    ? { command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT_WITH_PATH, "sh", agend, binDir] }
    : { command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT, "sh", agend] };
}
