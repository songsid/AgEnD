/**
 * M-3770 slice 2.5, wiring part 5 (design update-wiring-m3770.md §2, §3, §10.1): the updater's hands — what `runUpdate`
 * is given on a real host. Built up piece by piece; each hand takes its process effects through an injected runner, so
 * the sequence is testable without npm, a service manager or a fleet.
 *
 * The install hand (D1): the TARGET release's own installer in its install-only mode, under this updater's prefix lock
 * (its token handed over), then the installed package's own `agend.updateTx` read again (§10.1) — a release that
 * doesn't speak the transaction after all is rolled back, never trialled.
 */
import { join, parse } from "node:path";
import { MIN_UPDATE_TX, updateTxOf } from "./update-phase.js";

type Check = { ok: true } | { ok: false; reason: string };

export interface InstallHandInput {
  /** The exact target: `@songsid/agend` and its version (never a tag). */
  name: string;
  version: string;
  /** The proven install's package directory (`<prefix>/lib/node_modules/@songsid/agend`). */
  packagePath: string;
  /** This updater's prefix-lock token: the installer is admitted by it (AGEND_INSTALL_TOKEN). */
  prefixToken: string;
}

export interface InstallHandEnv {
  run(command: string, args: string[], opts: { env: Record<string, string>; cwd: string }): { status: number | null; signal?: string | null };
  readFile(path: string): string | null;
  /** The environment the installer runs in (this process's, by default). */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** The install-only installer's exit codes (launcher/agend-install.cjs installOnlyUnderUpdate). */
const NOT_ADMITTED = 75;

export function installHand(i: InstallHandInput, x: InstallHandEnv): Check {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(i.version)) return { ok: false, reason: `the target ${i.version} isn't an exact version` };
  const spec = `${i.name}@${i.version}`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(x.env ?? process.env)) if (typeof v === "string") env[k] = v;
  env.AGEND_INSTALL_TOKEN = i.prefixToken;
  // M-3812: from the filesystem root, so npm exec never runs a project's own node_modules/.bin first.
  const done = x.run("npm", ["exec", "--yes", "--package", spec, "--", "agend-install", "--install-only", "--target", i.version],
    { env, cwd: parse(x.cwd ?? process.cwd()).root });
  if (done.status === NOT_ADMITTED) return { ok: false, reason: `the installer of ${spec} wasn't admitted under this update's prefix lock` };
  if (done.status !== 0) return { ok: false, reason: `the installer of ${spec} failed (exit ${done.status ?? done.signal ?? "unknown"})` };
  // §10.1: the INSTALLED package.json, read again — its version and its own V_tx, before any trial.
  let pkg: unknown = null;
  try { pkg = JSON.parse(x.readFile(join(i.packagePath, "package.json")) ?? "null"); } catch { pkg = null; }
  const installed = (pkg as { name?: unknown; version?: unknown } | null);
  if (!installed || installed.name !== i.name || installed.version !== i.version) {
    return { ok: false, reason: `after the install, ${i.packagePath} isn't ${spec}` };
  }
  const tx = updateTxOf(pkg);
  if (tx < MIN_UPDATE_TX) return { ok: false, reason: `the installed ${spec} doesn't speak the update transaction (agend.updateTx ${tx})` };
  return { ok: true };
}
