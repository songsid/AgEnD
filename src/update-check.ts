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
