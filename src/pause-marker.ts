import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PAUSED_MARKER_FILE = "paused";
const LEGACY_PAUSED_MARKER_FILE = "paused-state.json";

export function hasPausedMarker(instanceDir: string): boolean {
  return existsSync(join(instanceDir, PAUSED_MARKER_FILE))
    || existsSync(join(instanceDir, LEGACY_PAUSED_MARKER_FILE));
}

export function writePausedMarker(instanceDir: string, pausedAt = Date.now()): void {
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, PAUSED_MARKER_FILE), String(pausedAt), { encoding: "utf8", mode: 0o600 });
}

export function clearPausedMarker(instanceDir: string): void {
  for (const file of [PAUSED_MARKER_FILE, LEGACY_PAUSED_MARKER_FILE]) {
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
