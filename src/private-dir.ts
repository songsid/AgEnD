/**
 * Per-instance directories are private to the user running the fleet.
 *
 * `<dataDir>/instances/<name>` holds `agent.token` (the bearer for the agent endpoint) and
 * `channel.sock` (the IPC socket to the MCP server). Created with a plain `mkdirSync` they inherit the
 * process umask — 0775 on a distro with a per-user group — which leaves the directory writable by the
 * user's group and traversable by everyone, with the token inside. The files themselves are 0600; the
 * directory is the second lock, and it was open.
 *
 * Two rules keep this from becoming a different problem:
 *  - only a real directory owned by the current user is ever changed — a symlink is left alone (chmod
 *    follows it) and so is anything we do not own, because those are not ours to re-permission;
 *  - only the directory itself: never a recursive walk, so a file the user put in there keeps the mode
 *    they gave it.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;

export type TightenOutcome =
  /** Group/other bits were set; the directory is now 0700. */
  | { kind: "tightened"; from: number }
  /** Already private. */
  | { kind: "ok" }
  /** Not ours to change: a symlink, not a directory, owned by someone else, or it cannot be read. */
  | { kind: "skipped"; why: "symlink" | "not-a-directory" | "not-owner" | "unreadable" | "chmod-failed" };

function ownUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Make one directory 0700 if — and only if — it is a real directory we own and it is open to group or other. */
export function tightenDir(path: string): TightenOutcome {
  let st;
  try { st = lstatSync(path); } catch { return { kind: "skipped", why: "unreadable" }; }
  if (st.isSymbolicLink()) return { kind: "skipped", why: "symlink" };
  if (!st.isDirectory()) return { kind: "skipped", why: "not-a-directory" };
  const uid = ownUid();
  // No getuid (Windows): POSIX modes mean nothing there, so there is nothing to tighten.
  if (uid === null) return { kind: "ok" };
  if (st.uid !== uid) return { kind: "skipped", why: "not-owner" };
  const mode = st.mode & 0o777;
  if ((mode & 0o077) === 0 && (mode & 0o700) === 0o700) return { kind: "ok" };
  try { chmodSync(path, PRIVATE_DIR_MODE); } catch { return { kind: "skipped", why: "chmod-failed" }; }
  return { kind: "tightened", from: mode };
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
  /** Directories left alone because they were not ours to change. */
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
    else if (outcome.kind === "skipped" && outcome.why !== "unreadable") report.skipped.push({ dir, why: outcome.why });
  };
  let names: string[];
  try { names = readdirSync(root); } catch { return report; }     // no instances yet: nothing to do
  note(root, tightenDir(root));
  for (const name of names) {
    const dir = join(root, name);
    let isDir = false;
    try { isDir = lstatSync(dir).isDirectory(); } catch { /* vanished */ }
    if (!isDir) continue;                                            // a stray file or a symlink is not an instance directory
    note(dir, tightenDir(dir));
  }
  return report;
}
