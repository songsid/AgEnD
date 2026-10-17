/**
 * Path containment for checkout_repo / release_repo: an instance creates and removes git worktrees only inside its
 * own `<instanceDir>/repos`, and removes only a worktree it can show is one. Nothing outside passes, whatever the
 * path text says (`..`, a sibling with the same prefix, an absolute path, a symlink inside `repos/`).
 */
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/** Where this instance's checkouts are recorded: path → the source repo's git common dir. */
export const CHECKOUTS_FILE = ".agend-checkouts.json";

export type RepoGuardResult = { ok: true; path: string } | { ok: false; reason: string };

/** realpath, or — for a path that does not exist (yet) — its normalized absolute form. */
function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** `candidate` strictly inside `root`: not root itself, not above it, not on another drive. Both must be real paths. */
function strictlyInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The `repos` directory of this instance, as a real directory. A `repos` that is a symlink (or not a directory) is
 * refused: following it would put worktrees, and deletions, somewhere else.
 */
export function reposRoot(instanceDir: string): RepoGuardResult {
  const dir = join(instanceDir, "repos");
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: "the instance repos directory is not a plain directory" };
  } catch { return { ok: false, reason: "the instance has no repos directory" }; }
  return { ok: true, path: real(dir) };
}

/** Where checkout_repo may create a worktree: one fresh direct child of `repos`, never an existing path. */
export function checkoutTarget(instanceDir: string, source: string, branch: string): RepoGuardResult {
  const root = reposRoot(instanceDir);
  if (!root.ok) return root;
  const name = `${basename(source)}-${branch.replace(/\//g, "-")}`;
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return { ok: false, reason: "invalid checkout name" };
  const target = join(root.path, name);
  if (!strictlyInside(root.path, target) || relative(root.path, target) !== name) return { ok: false, reason: "checkout path outside the instance repos directory" };
  try { lstatSync(target); return { ok: false, reason: "a checkout already exists at that path" }; } catch { /* free, as required */ }
  return { ok: true, path: target };
}

/** The checkouts this instance recorded (path → git common dir). A missing or broken file is no records. */
export function readCheckouts(root: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(root, CHECKOUTS_FILE), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return {}; }
}

export function writeCheckouts(root: string, records: Record<string, string>): void {
  const file = join(root, CHECKOUTS_FILE), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * The real path release_repo may remove, or why not. It must exist, be strictly inside this instance's `repos`
 * (after resolving symlinks — a link inside `repos/` that points out resolves out, and is refused), and not be a
 * symlink itself. Whether it is a worktree is checked separately (verifyWorktree), with git.
 */
export function releaseCandidate(instanceDir: string, rawPath: unknown): RepoGuardResult {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) return { ok: false, reason: "missing path" };
  const root = reposRoot(instanceDir);
  if (!root.ok) return root;
  const expanded = rawPath.replace(/^~(?=$|\/)/, process.env.HOME || "~");
  const absolute = isAbsolute(expanded) ? expanded : join(root.path, expanded);
  let st;
  try { st = lstatSync(absolute); } catch { return { ok: false, reason: "no such checkout" }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: "not a checkout directory" };
  const candidate = real(absolute);
  if (!strictlyInside(root.path, candidate)) return { ok: false, reason: "path outside the instance repos directory" };
  return { ok: true, path: candidate };
}

/**
 * A contained candidate is removable only as a linked git worktree whose top level is exactly that directory, and —
 * when this instance recorded it — of the repository it was checked out from. `git` is injected for tests.
 */
export async function verifyWorktree(
  root: string,
  candidate: string,
  git: (args: string[], cwd: string) => Promise<string>,
): Promise<{ ok: true; commonDir: string } | { ok: false; reason: string }> {
  let top: string, gitDir: string, commonDir: string;
  try {
    top = real((await git(["rev-parse", "--show-toplevel"], candidate)).trim());
    gitDir = real(resolve(candidate, (await git(["rev-parse", "--git-dir"], candidate)).trim()));
    commonDir = real(resolve(candidate, (await git(["rev-parse", "--git-common-dir"], candidate)).trim()));
  } catch { return { ok: false, reason: "not a git worktree" }; }
  if (top !== candidate) return { ok: false, reason: "not the top of a git worktree" };
  // A linked worktree keeps its git dir under the common dir's worktrees/; the main checkout's git dir IS the common dir.
  if (gitDir === commonDir || !strictlyInside(join(commonDir, "worktrees"), gitDir)) return { ok: false, reason: "not a linked git worktree" };
  const recorded = readCheckouts(root)[candidate];
  if (recorded !== undefined && real(recorded) !== commonDir) return { ok: false, reason: "a different repository than the one checked out" };
  if (recorded === undefined) {
    // A checkout from before checkouts were recorded: its repository must list it as one of its worktrees.
    let listed: string;
    try { listed = await git(["--git-dir", commonDir, "worktree", "list", "--porcelain"], commonDir); } catch { return { ok: false, reason: "not a git worktree" }; }
    const paths = listed.split("\n").filter(l => l.startsWith("worktree ")).map(l => real(l.slice("worktree ".length)));
    if (!paths.includes(candidate)) return { ok: false, reason: "not a worktree of its repository" };
  }
  return { ok: true, commonDir };
}
