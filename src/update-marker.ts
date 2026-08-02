/**
 * A cross-process marker saying "an `agend update` is running right now".
 *
 * Why a file and not a boolean: the noise this suppresses spans three
 * processes. `agend update` runs `npm install -g`, which replaces the package
 * directory *while the old fleet daemon is still running* — that alone kills
 * MCP servers, and the old daemon dutifully reports each one. Then `agend
 * restart` SIGTERMs the daemon, and instances die during the stop. None of this
 * is an incident, but the process that knows an update is happening is not the
 * process sending the alerts.
 *
 * The marker always expires. An update that dies halfway (npm fails, the
 * machine reboots) must not leave the fleet permanently unable to report a real
 * crash — a stale marker is ignored, and the next fleet startup deletes it.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How long a marker is believed. Long enough for a slow npm install plus a
 * fleet restart on a loaded machine; short enough that a broken update costs
 * one quiet window, not silence until someone notices.
 */
export const UPDATE_MARKER_MAX_AGE_MS = 15 * 60_000;

const FILE = "update-in-progress.json";

function markerPath(dataDir: string): string {
  return join(dataDir, FILE);
}

/** Called by `agend update` before it touches anything. */
export function markUpdateInProgress(dataDir: string, now = Date.now()): void {
  try {
    writeFileSync(markerPath(dataDir), JSON.stringify({ startedAt: now, pid: process.pid }));
  } catch {
    // Best effort: failing to write the marker costs a few spurious alerts,
    // which is not a reason to abort someone's upgrade.
  }
}

/** Called when the update finishes or gives up, and by the new fleet on startup. */
export function clearUpdateMarker(dataDir: string): void {
  try { unlinkSync(markerPath(dataDir)); } catch { /* absent is the goal */ }
}

/**
 * Is an update in flight? False for a marker older than the max age — an
 * abandoned marker must not silence real incidents forever.
 */
export function isUpdateInProgress(dataDir: string, now = Date.now()): boolean {
  const path = markerPath(dataDir);
  if (!existsSync(path)) return false;
  let startedAt: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { startedAt?: unknown };
    if (typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)) {
      startedAt = parsed.startedAt;
    }
  } catch {
    // Truncated or hand-edited: treat as unknown age rather than as fresh.
  }
  if (startedAt === null) return false;
  // A clock jump backwards would otherwise make a marker look infinitely fresh.
  const age = now - startedAt;
  return age >= 0 && age < UPDATE_MARKER_MAX_AGE_MS;
}
