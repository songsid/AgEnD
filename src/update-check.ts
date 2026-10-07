import { execFileSync } from "node:child_process";

/**
 * What a chat `/update` (Discord slash or Telegram) runs: no channel flag, ever.
 * The installed CLI decides from its own version (getUpdateSelector), so the
 * caller's view of "which version am I" cannot send a beta install to @latest.
 */
export const UPDATE_COMMAND = "agend update";

export interface UpdateVersionOptions {
  version?: string;
  /** The alpha channel (`@alpha`, the next minor's previews, #1259). */
  alpha?: boolean;
  beta?: boolean;
  /** Back to the stable line (`@latest`), even from a beta install — may go back a version. */
  stable?: boolean;
  force?: boolean;
}

/**
 * SemVer 2.0.0, strictly (https://semver.org/): numeric identifiers without
 * leading zeros, alphanumeric prerelease identifiers containing a non-digit,
 * no empty identifiers. A leading `v` and surrounding space are tolerated, as
 * npm prints them.
 */
const NUM = "(?:0|[1-9]\\d*)";
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD_ID = "[0-9A-Za-z-]+";
const SEMVER = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?$`);

interface ParsedSemver { core: [string, string, string]; pre: string[] }

function parseSemver(version: string): ParsedSemver | null {
  const m = SEMVER.exec(version.trim());
  if (!m) return null;
  return { core: [m[1], m[2], m[3]], pre: m[4] ? m[4].split(".") : [] };
}

/** A version npm will accept as an exact version (strict SemVer). */
export function isExactVersion(version: string): boolean {
  return parseSemver(version) !== null;
}

/** A semver prerelease (`x.y.z-<pre>`): a beta (or rc, alpha…) install. Anything that does not parse is not one. */
export function isPrereleaseVersion(version: string): boolean {
  return (parseSemver(version)?.pre.length ?? 0) > 0;
}

/** Two numeric identifiers, exactly at any size: no leading zeros, so the longer is the larger. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Semver order: -1 when a < b, 0 when equal, 1 when a > b; null when either
 * does not parse. A prerelease ranks below its own release (2.1.10-beta.6 <
 * 2.1.10); numeric identifiers compare as exact integers (no float rounding),
 * below alphanumeric ones, which compare in ASCII order.
 */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(pa.core[i], pb.core[i]);
    if (order !== 0) return order;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return Math.sign(pb.pre.length - pa.pre.length);
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return compareNumeric(x, y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(pa.pre.length - pb.pre.length);
}

export type UpdateChannel = "latest" | "beta" | "alpha";

/**
 * The npm dist-tag an install follows (#1259): an alpha (`x.y.z-alpha.N`) is on
 * `@alpha`, any other prerelease (beta, rc…) on `@beta`, a release on `@latest`.
 * Mirrors what publish.yml publishes each tag to (scripts/npm-dist-tag.mjs).
 */
export function installedChannel(version: string): UpdateChannel {
  const pre = parseSemver(version)?.pre ?? [];
  if (pre.length === 0) return "latest";
  return pre[0] === "alpha" ? "alpha" : "beta";
}

/**
 * The npm selector `agend update` installs from. An explicit choice wins
 * (`--version`, then `--alpha`, `--beta`, `--stable`); with none, the line the
 * installed version is on — an alpha stays on `@alpha`, a beta on `@beta`, so
 * nobody is moved to another channel without asking. `installedVersion` is the
 * version of the package being replaced (the CLI's own package.json), never
 * the version of whatever code happened to call it.
 */
export function getUpdateSelector(opts: UpdateVersionOptions, installedVersion: string): string {
  if (opts.version) return opts.version;
  if (opts.alpha) return "alpha";
  if (opts.beta) return "beta";
  if (opts.stable) return "latest";
  return installedChannel(installedVersion);
}

/**
 * Which "update available" line to post. A beta or alpha install's `/update`
 * stays on its channel, so a newer STABLE release needs `--stable` — say so
 * rather than "Run: /update", which would not move it there.
 */
export function updateNoticeKey(currentVersion: string, targetVersion: string): "update.available_stable" | "update.available_current" {
  return isPrereleaseVersion(currentVersion) && !isPrereleaseVersion(targetVersion) ? "update.available_stable" : "update.available_current";
}

/**
 * The install would go back to an older version, and nobody asked for that.
 * `--force`, `--version` and `--stable` are asking; an unknown target or a
 * version that does not parse cannot be judged, and is not refused.
 */
export function isUnrequestedDowngrade(installedVersion: string, targetVersion: string | null, opts: UpdateVersionOptions): boolean {
  if (opts.force || opts.version || opts.stable || targetVersion === null) return false;
  const order = compareSemver(targetVersion, installedVersion);
  return order !== null && order < 0;
}

/**
 * Query the registry without making update availability a hard dependency.
 * A failed lookup deliberately returns null so the existing install flow can
 * continue during registry/network outages.
 */
export function lookupTargetVersion(
  selector: string,
  run: typeof execFileSync = execFileSync,
): string | null {
  try {
    const output = run(
      "npm",
      ["view", `@songsid/agend@${selector}`, "version"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      },
    );
    const version = String(output).trim();
    return version || null;
  } catch {
    return null;
  }
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function shouldSkipUpdate(
  currentVersion: string,
  targetVersion: string | null,
  force = false,
): boolean {
  return !force
    && targetVersion !== null
    && normalizeVersion(currentVersion) === normalizeVersion(targetVersion);
}

/**
 * The running fleet started before the installed package was written: it is
 * still executing the previous version's code (#1113 hotfix). That happens
 * when an update installed the package but its restart did not go through —
 * a second `agend update` then saw "already up to date" and left the old
 * process running against the new files on disk. Unknown (no pid, no start
 * time) is false: never restart on a guess.
 */
export function runningFleetPredatesInstall(opts: {
  pid: number | null;
  installedAtMs: number;
  processStartMs: (pid: number) => number | null;
  /**
   * Whether `pid` is an AgEnD fleet process (its command line). A stale
   * fleet.pid can name a recycled pid — an unrelated process that a restart
   * would signal (#1125 review) — so anything not confirmed is not a fleet.
   */
  isFleetProcess: (pid: number) => boolean;
  marginMs?: number;
}): boolean {
  if (opts.pid === null || !Number.isFinite(opts.installedAtMs)) return false;
  if (!opts.isFleetProcess(opts.pid)) return false;
  const started = opts.processStartMs(opts.pid);
  if (started === null) return false;
  return started < opts.installedAtMs - (opts.marginMs ?? 2_000);
}

/** Start time of a live process, via `ps -o lstart=` (Linux and macOS); null if gone. */
export function processStartMs(pid: number, run: (args: string[]) => string = args =>
  execFileSync("ps", args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: process.env.TZ }, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }),
): number | null {
  try {
    const text = run(["-o", "lstart=", "-p", String(pid)]).trim();
    if (!text) return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

interface UpdateOutput {
  log(message: string): void;
  error(message: string): void;
}

/** Report restart status and let the CLI translate failure into exit code 1. */
export function reportUpdateRestart(
  status: number | null,
  output: UpdateOutput = console,
): boolean {
  if (status === 0) {
    output.log("  ✓ Service restarted");
    return true;
  }

  output.error("\n  ✗ Auto-restart FAILED. Fleet may be stopped.");
  output.error("  Run: agend start");
  output.error("  Service status: agend status\n");
  return false;
}
