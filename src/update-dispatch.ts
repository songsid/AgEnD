/**
 * #1450 C5: chat `/update` runs the INSTALLED `agend` — the one npm put in its global prefix, verified by identity —
 * by absolute path, never whichever `agend` comes first on the fleet's PATH (a checkout, another prefix). That keeps
 * the deliberate choice "update what is installed, on its own channel" (the CLI picks the channel from the version it
 * replaces). No unverified fallback: when npm cannot say where it installed AgEnD, or what it says does not hold
 * together, `/update` refuses and says to run `agend update` from a shell.
 *
 * Runs on the fleet's event loop: every step is async and bounded.
 */
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export interface DispatchDeps {
  run(command: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string }>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
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
};

export type InstalledAgend = { ok: true; agend: string; version: string } | { ok: false; reason: string };

/** npm's global root and prefix → the installed package, its bin target, and the bin link that must lead to it. */
export async function resolveInstalledAgend(deps: DispatchDeps = defaultDispatchDeps): Promise<InstalledAgend> {
  const last = (text: string) => text.trim().split("\n").pop()?.trim() ?? "";
  const [root, prefix] = await Promise.all([deps.run("npm", ["root", "-g"], 15_000), deps.run("npm", ["prefix", "-g"], 15_000)]);
  if (root.status !== 0 || prefix.status !== 0 || !last(root.stdout) || !last(prefix.stdout)) {
    return { ok: false, reason: "npm could not say where AgEnD is installed" };
  }
  const pkgDir = join(last(root.stdout), "@songsid", "agend");
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
  const agend = join(last(prefix.stdout), "bin", "agend");
  let target: string, linked: string;
  try { [target, linked] = await Promise.all([deps.realpath(join(pkgDir, binRel)), deps.realpath(agend)]); }
  catch { return { ok: false, reason: `${agend} does not lead to the installed package` }; }
  if (target !== linked) return { ok: false, reason: `${agend} leads to ${linked}, not the installed package's ${target}` };
  return { ok: true, agend, version: manifest.version };
}

/**
 * `<installed agend> update`, 2 s from now, from a detached `sh` that outlives this fleet (the update restarts it). The
 * path is a positional argument, never spliced into the script.
 */
export const DELAYED_UPDATE_SCRIPT = 'sleep 2 && exec "$1" update';
export function updateCommand(agend: string): { command: string; args: string[] } {
  return { command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT, "sh", agend] };
}
