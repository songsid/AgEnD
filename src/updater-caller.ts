/**
 * #1631 part B: is this `agend install --no-activate` the activation refresh of an `agend update` in flight — the
 * updater of an OLDER version (2.2.0-beta.1 and before), which still refreshes a hand-started fleet's service and so
 * would create a unit or plist where none existed? Then the install writes nothing (see the install command).
 *
 * The answer is "yes" only when it is certain; any doubt or failed probe is "no", and a manual install creates the
 * service as always. Certain means all of:
 * - update-in-progress.json is readable and fresh: its mtime is within the update marker's own budget
 *   (UPDATE_MARKER_MAX_AGE_MS), never in the future — a marker left by a crashed update does not count;
 * - its pid (markUpdateInProgress writes the updater's own pid) is alive, is this process's parent, grandparent or
 *   great-grandparent (an nvm install adds a `bash` layer), and started no later than the marker was written — a
 *   reused pid started after it;
 * - if the marker records a target version, it is the version doing the install.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_MARKER_MAX_AGE_MS } from "./update-marker.js";
import { processStartMs } from "./update-check.js";

/** How far up the process tree the updater may be: updater → (bash for nvm) → launcher sh/exec → this process. */
export const UPDATER_ANCESTOR_DEPTH = 3;
/** `ps -o lstart=` has one-second resolution. */
const START_SLACK_MS = 1_000;

export interface UpdaterCallerProbe {
  now(): number;
  /** mtime of update-in-progress.json, or null when it is absent or unreadable. */
  markerMtimeMs(): number | null;
  /** Its parsed content, or null. */
  marker(): { pid?: unknown; progress?: { version?: unknown }; [field: string]: unknown } | null;
  /** The parent pid of `pid`, or null when it cannot be read. */
  parentOf(pid: number): number | null;
  alive(pid: number): boolean;
  /** When `pid` started (ms since the epoch), or null. */
  startMs(pid: number): number | null;
  selfPid: number;
  selfVersion: string;
}

export type UpdaterCallerVerdict = { updater: true; pid: number } | { updater: false; reason: string };

export function startedByUpdater(p: UpdaterCallerProbe): UpdaterCallerVerdict {
  const no = (reason: string): UpdaterCallerVerdict => ({ updater: false, reason });
  const mtime = p.markerMtimeMs();
  if (mtime === null) return no("no update marker");
  const age = p.now() - mtime;
  if (!(age >= 0 && age < UPDATE_MARKER_MAX_AGE_MS)) return no("the update marker is not fresh");
  const marker = p.marker();
  const pid = marker?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return no("the update marker names no updater pid");
  const version = marker?.progress?.version;
  if (version !== undefined && version !== p.selfVersion) return no("the update marker names another version");
  if (!p.alive(pid)) return no("the marker's updater is not running");
  let at = p.selfPid;
  let found = false;
  for (let depth = 0; depth < UPDATER_ANCESTOR_DEPTH; depth++) {
    const parent = p.parentOf(at);
    if (parent === null || parent <= 1 || parent === at) break;
    if (parent === pid) { found = true; break; }
    at = parent;
  }
  if (!found) return no("the marker's updater is not an ancestor of this process");
  const started = p.startMs(pid);
  if (started === null || started > mtime + START_SLACK_MS) return no("the marker's pid started after the marker was written (reused)");
  return { updater: true, pid };
}

/** Parent pid: /proc on Linux, `ps -o ppid=` elsewhere (macOS). */
function parentOf(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number.parseInt(rest[1] ?? "", 10);
      return Number.isInteger(ppid) ? ppid : null;
    }
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
    const ppid = Number.parseInt(out, 10);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function systemUpdaterCallerProbe(dataDir: string, selfVersion: string): UpdaterCallerProbe {
  const path = join(dataDir, "update-in-progress.json");
  return {
    now: () => Date.now(),
    markerMtimeMs: () => { try { return statSync(path).mtimeMs; } catch { return null; } },
    marker: () => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } },
    parentOf,
    alive,
    startMs: pid => processStartMs(pid),
    selfPid: process.pid,
    selfVersion,
  };
}
