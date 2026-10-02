/**
 * Per-instance directories are private to the user running the fleet.
 *
 * `<dataDir>/instances/<name>` holds `agent.token` (the bearer for the agent endpoint) and
 * `channel.sock` (the IPC socket to the MCP server). Created with a plain `mkdirSync` they inherit the
 * process umask — 0775 on a distro with a per-user group — which leaves the directory writable by the
 * user's group and traversable by everyone, with the token inside. The files themselves are 0600; the
 * directory is the second lock, and it was open.
 *
 * Rules that keep this from becoming a different problem:
 *  - only a real directory owned by the current user is ever changed, and the check and the change are
 *    made on the SAME open file descriptor (`open` with O_NOFOLLOW | O_DIRECTORY, then `fstat`/`fchmod`).
 *    A `lstat` followed by a `chmod` on the path leaves a window in which a group member, who could write
 *    the old group-writable parent, swaps the entry for a symlink — and `chmod` follows it;
 *  - the `instances` directory itself is validated before anything under it is listed: a symlinked or
 *    foreign root stops the pass, it is not walked;
 *  - only the directories themselves: never a recursive walk, so a file the user put in there keeps the
 *    mode they gave it;
 *  - what cannot be fixed (not ours, unreadable) is reported, never silently dropped.
 *
 * Not covered, and why that is acceptable: an attacker who can replace an intermediate component of the
 * path (the data directory, which is not group-writable) is already the user.
 */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;

export type SkipReason = "symlink" | "not-a-directory" | "not-owner" | "missing" | "unreadable" | "chmod-failed";

export type TightenOutcome =
  /** Group/other bits were set; the directory is now 0700. */
  | { kind: "tightened"; from: number }
  /** Already private. */
  | { kind: "ok" }
  /** Not ours to change, or not reachable. */
  | { kind: "skipped"; why: SkipReason };

function ownUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Test seam: runs between the open and the fstat/fchmod, i.e. exactly where a path swap would land. */
export interface TightenHooks { afterOpen?: () => void }

/**
 * Make one directory 0700 if — and only if — it is a real directory we own and it is open to group or other.
 *
 * A directory the owner cannot even open for reading (mode without `r`) is reported as unreadable rather than
 * changed by path: there is no way to bind that change to what was checked, and a mode like that is not
 * something this fleet ever creates.
 */
export function tightenDir(path: string, hooks: TightenHooks = {}): TightenOutcome {
  const uid = ownUid();
  // No getuid (Windows): POSIX modes mean nothing there, so there is nothing to tighten.
  if (uid === null) return { kind: "ok" };

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (err) {
    return { kind: "skipped", why: classifyOpenFailure(path, (err as NodeJS.ErrnoException).code) };
  }
  try {
    hooks.afterOpen?.();
    const st = fstatSync(fd);
    if (!st.isDirectory()) return { kind: "skipped", why: "not-a-directory" };
    if (st.uid !== uid) return { kind: "skipped", why: "not-owner" };
    const mode = st.mode & 0o777;
    if ((mode & 0o077) === 0 && (mode & 0o700) === 0o700) return { kind: "ok" };
    try { fchmodSync(fd, PRIVATE_DIR_MODE); } catch { return { kind: "skipped", why: "chmod-failed" }; }
    return { kind: "tightened", from: mode };
  } finally {
    closeSync(fd);
  }
}

/** Why an open with O_NOFOLLOW | O_DIRECTORY failed. Diagnostic only — nothing is changed on this path. */
function classifyOpenFailure(path: string, code: string | undefined): SkipReason {
  if (code === "ENOENT") return "missing";
  if (code === "ELOOP" || code === "ENOTDIR") {
    try { return lstatSync(path).isSymbolicLink() ? "symlink" : "not-a-directory"; } catch { return "missing"; }
  }
  return "unreadable";
}

/**
 * `mkdir -p` for an instance directory, born private and corrected if it already existed loose.
 *
 * `mode` on mkdir is filtered by the umask, which can only remove bits, so 0700 survives any sane umask —
 * but a directory that was already there keeps whatever it had, hence the explicit tighten after.
 */
export function ensureInstanceDir(instanceDir: string): void {
  mkdirSync(instanceDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  tightenDir(instanceDir);
}

export interface TightenReport {
  /** Directories changed to 0700, with the mode each had. */
  tightened: Array<{ dir: string; from: string }>;
  /** Directories left alone because they were not ours to change or could not be reached. */
  skipped: Array<{ dir: string; why: string }>;
}

/**
 * Startup pass over what earlier versions left behind: `<dataDir>/instances` and each instance directory
 * directly under it. Idempotent, quiet when everything is already private, and it never throws — a fleet
 * must start even when a directory cannot be fixed.
 */
export function tightenInstanceDirs(dataDir: string): TightenReport {
  const report: TightenReport = { tightened: [], skipped: [] };
  const root = join(dataDir, "instances");
  const note = (dir: string, outcome: TightenOutcome): void => {
    if (outcome.kind === "tightened") report.tightened.push({ dir, from: `0o${outcome.from.toString(8)}` });
    // A child that vanished between the listing and the open is not news; everything else is.
    else if (outcome.kind === "skipped" && outcome.why !== "missing") report.skipped.push({ dir, why: outcome.why });
  };

  // The root first, and as the gate: a symlink, a non-directory, a directory someone else owns or one we cannot
  // open stops the pass. Listing it first would walk straight through a link into somebody else's directories.
  const rootOutcome = tightenDir(root);
  if (rootOutcome.kind === "skipped") {
    note(root, rootOutcome);          // "missing" (no instances yet) stays quiet; the rest is reported
    return report;
  }
  note(root, rootOutcome);

  let names: string[];
  try { names = readdirSync(root); } catch { report.skipped.push({ dir: root, why: "unreadable" }); return report; }
  for (const name of names) {
    const dir = join(root, name);
    // A stray file or a symlink is not an instance directory: ignored here, and tightenDir would refuse it anyway.
    let isDir = false;
    try { isDir = lstatSync(dir).isDirectory(); } catch { /* vanished */ }
    if (!isDir) continue;
    note(dir, tightenDir(dir));
  }
  return report;
}
