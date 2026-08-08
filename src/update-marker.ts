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
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How long a marker is believed. Long enough for a slow npm install plus a
 * fleet restart on a loaded machine; short enough that a broken update costs
 * one quiet window, not silence until someone notices.
 */
export const UPDATE_MARKER_MAX_AGE_MS = 15 * 60_000;

const FILE = "update-in-progress.json";

export type UpdateProgressStage =
  | "preparing"
  | "downloading"
  | "installed"
  | "stopping"
  | "starting"
  | "complete"
  | "failed";

export interface UpdateProgressTarget {
  adapterId: string;
  chatId: string;
  threadId?: string;
  messageId: string;
}

export interface UpdateProgressState {
  stage: UpdateProgressStage;
  target: UpdateProgressTarget;
  version?: string;
  error?: string;
  failedStage?: UpdateProgressStage;
}

export interface UpdateMarker {
  startedAt: number;
  pid: number;
  progress?: UpdateProgressState;
}

function markerPath(dataDir: string): string {
  return join(dataDir, FILE);
}

function readMarker(dataDir: string): UpdateMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(dataDir), "utf-8")) as Partial<UpdateMarker>;
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null;
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return null;
    return parsed as UpdateMarker;
  } catch {
    return null;
  }
}

function writeMarker(dataDir: string, marker: UpdateMarker): boolean {
  const path = markerPath(dataDir);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(marker), { mode: 0o600 });
    renameSync(temp, path);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* best effort */ }
    return false;
  }
}

/** Persist the channel message that `/update` will edit across process restart. */
export function beginUpdateProgress(dataDir: string, target: UpdateProgressTarget, now = Date.now()): void {
  writeMarker(dataDir, {
    startedAt: now,
    pid: process.pid,
    progress: { stage: "preparing", target },
  });
}

/** Read the live progress contract shared by the old CLI and the new fleet. */
export function readUpdateProgress(dataDir: string): (UpdateMarker & { progress: UpdateProgressState }) | null {
  const marker = readMarker(dataDir);
  if (!marker?.progress?.target?.messageId || !marker.progress.target.adapterId) return null;
  return marker as UpdateMarker & { progress: UpdateProgressState };
}

/** Advance the cross-process progress state without losing its message target. */
export function setUpdateProgressStage(
  dataDir: string,
  stage: UpdateProgressStage,
  details: { version?: string; error?: string } = {},
): boolean {
  const marker = readMarker(dataDir);
  if (!marker?.progress) return false;
  const previousStage = marker.progress.stage;
  marker.pid = process.pid;
  marker.progress = {
    ...marker.progress,
    stage,
    ...(details.version !== undefined ? { version: details.version } : {}),
    ...(details.error !== undefined ? { error: details.error.replace(/\s+/g, " ").trim().slice(0, 300) } : {}),
    ...(stage === "failed" ? { failedStage: previousStage } : {}),
  };
  return writeMarker(dataDir, marker);
}

/** Called by `agend update` before it touches anything. */
export function markUpdateInProgress(dataDir: string, now = Date.now()): void {
  const existing = readMarker(dataDir);
  writeMarker(dataDir, {
    startedAt: existing?.startedAt ?? now,
    pid: process.pid,
    ...(existing?.progress ? { progress: existing.progress } : {}),
  });
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
  if (!existsSync(markerPath(dataDir))) return false;
  const marker = readMarker(dataDir);
  if (!marker) return false;
  if (marker.progress?.stage === "failed" || marker.progress?.stage === "complete") return false;
  // A clock jump backwards would otherwise make a marker look infinitely fresh.
  const age = now - marker.startedAt;
  return age >= 0 && age < UPDATE_MARKER_MAX_AGE_MS;
}
