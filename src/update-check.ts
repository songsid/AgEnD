import { execFileSync } from "node:child_process";

export interface UpdateVersionOptions {
  version?: string;
  beta?: boolean;
  force?: boolean;
}

/** Resolve the npm selector used by `agend update`. */
export function getUpdateSelector(opts: UpdateVersionOptions): string {
  return opts.version ?? (opts.beta ? "beta" : "latest");
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
