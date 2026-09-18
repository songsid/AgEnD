/**
 * "Setup has been done once."
 *
 * Deliberately not fleet.yaml's existence: a user who deletes or moves
 * fleet.yaml — or whose disk hands back an empty one — would otherwise reopen a
 * pre-fleet setup host, which is an unauthenticated-by-default surface. The
 * marker is its own file and only `agend setup --reset` clears it.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "setup-complete.json";

export interface SetupRecord {
  completedAt: string;
  version?: string;
}

function path(dataDir: string): string {
  return join(dataDir, FILE);
}

export function isSetupComplete(dataDir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path(dataDir), "utf-8")) as Partial<SetupRecord>;
    return typeof parsed.completedAt === "string";
  } catch {
    // Unreadable is not "not done". A corrupt marker must not reopen setup;
    // `agend setup --reset` is the way back, and it is a local command.
    return existsSync(path(dataDir));
  }
}

export function markSetupComplete(dataDir: string, version?: string): void {
  writeFileSync(path(dataDir), JSON.stringify({ completedAt: new Date().toISOString(), version } satisfies SetupRecord) + "\n", { mode: 0o600 });
}

/** Only `agend setup --reset` calls this; no route may. */
export function clearSetupComplete(dataDir: string): boolean {
  try { unlinkSync(path(dataDir)); return true; } catch { return false; }
}
