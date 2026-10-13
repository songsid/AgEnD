import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureInstanceDir } from "./private-dir.js";

/**
 * #1716: written by the daemon when its stop (or pause) flow meets the CLI's
 * "background work is still active" quit menu, cancels it with Escape, and
 * stops the process — the background work was ended, and that must not stay
 * silent. Readers scope by the operation that just stopped the instance
 * (`sinceAt`): a marker older than the current stop never reports, so markers
 * are never deleted and can never go stale — each stop overwrites the file.
 */
export const BACKGROUND_WORK_ENDED_FILE = "background-work-ended.json";

export interface BackgroundWorkEndedMarker {
  /** Same-machine wall clock, for scoping and forensics. */
  at: number;
  /** The stop-flow reason ("stop", "pause (idle)", ...). */
  reason: string;
}

export function writeBackgroundWorkEndedMarker(instanceDir: string, reason: string, at = Date.now()): void {
  ensureInstanceDir(instanceDir);
  const marker: BackgroundWorkEndedMarker = { at, reason };
  writeFileSync(join(instanceDir, BACKGROUND_WORK_ENDED_FILE), JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
}

/** The marker from a stop that began at `sinceAt`; null when absent, unreadable, or older. */
export function readBackgroundWorkEndedMarker(instanceDir: string, sinceAt: number): BackgroundWorkEndedMarker | null {
  try {
    const raw = JSON.parse(readFileSync(join(instanceDir, BACKGROUND_WORK_ENDED_FILE), "utf8")) as {
      at?: unknown;
      reason?: unknown;
    };
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < sinceAt) return null;
    return { at: raw.at, reason: typeof raw.reason === "string" ? raw.reason : "stop" };
  } catch {
    return null;
  }
}
