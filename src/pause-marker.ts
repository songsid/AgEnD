import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PAUSED_MARKER_FILE = "paused";
const LEGACY_PAUSED_MARKER_FILE = "paused-state.json";
/**
 * Why the instance is paused, beside the marker rather than inside it: the
 * marker's single-number format is what older versions read back, so a
 * rollback keeps working. Absent means "unknown" (written before this file).
 */
export const PAUSE_REASON_FILE = "paused-reason";
/** `error`: a non-auth error pause (e.g. model capacity exhausted); `auth`: a login failure. */
export type PauseReason = "idle" | "warm_cap" | "operator" | "auth" | "error";
const PAUSE_REASONS: readonly PauseReason[] = ["idle", "warm_cap", "operator", "auth", "error"];

export function hasPausedMarker(instanceDir: string): boolean {
  return existsSync(join(instanceDir, PAUSED_MARKER_FILE))
    || existsSync(join(instanceDir, LEGACY_PAUSED_MARKER_FILE));
}

export function writePausedMarker(instanceDir: string, pausedAt = Date.now(), reason?: PauseReason | null): void {
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, PAUSED_MARKER_FILE), String(pausedAt), { encoding: "utf8", mode: 0o600 });
  if (reason) writeFileSync(join(instanceDir, PAUSE_REASON_FILE), reason, { encoding: "utf8", mode: 0o600 });
  else { try { unlinkSync(join(instanceDir, PAUSE_REASON_FILE)); } catch { /* absent */ } }
}

export function readPauseReason(instanceDir: string): PauseReason | null {
  try {
    const value = readFileSync(join(instanceDir, PAUSE_REASON_FILE), "utf8").trim();
    return (PAUSE_REASONS as readonly string[]).includes(value) ? value as PauseReason : null;
  } catch {
    return null;
  }
}

export function clearPausedMarker(instanceDir: string): void {
  for (const file of [PAUSED_MARKER_FILE, LEGACY_PAUSED_MARKER_FILE, PAUSE_REASON_FILE]) {
    try { unlinkSync(join(instanceDir, file)); } catch { /* absent marker */ }
  }
}

export function readPausedAt(instanceDir: string): number | null {
  try {
    const value = Number(readFileSync(join(instanceDir, PAUSED_MARKER_FILE), "utf8").trim());
    if (Number.isFinite(value) && value > 0) return value;
  } catch { /* try legacy format */ }
  try {
    const legacy = JSON.parse(readFileSync(join(instanceDir, LEGACY_PAUSED_MARKER_FILE), "utf8")) as { paused_at?: unknown };
    return typeof legacy.paused_at === "number" && Number.isFinite(legacy.paused_at) ? legacy.paused_at : null;
  } catch {
    return null;
  }
}
