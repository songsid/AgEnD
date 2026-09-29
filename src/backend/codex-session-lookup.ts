/**
 * #984 F3: find the Codex session that belongs to THIS instance's working
 * directory, instead of trusting `codex resume --last`.
 *
 * Codex 0.157's `--last` is repository-scoped: in a git worktree it resumes
 * the newest session of ANY worktree of the same repo, so sibling AgEnD
 * instances took each other's sessions (lock screen while the owner lives,
 * silent hijack with `resume_cwd = "current"`). The shared `state_5.sqlite`
 * already records each thread's exact cwd; reading it read-only lets AgEnD
 * pick the instance's own thread without migrating, claiming or writing any
 * Codex state (the reasons #913 was reverted). See
 * docs/design/984-codex-exact-cwd-resume.zh-TW.md.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

/** Columns the lookup depends on; any missing one means "schema unreadable". */
export const CODEX_THREAD_COLUMNS = [
  "id", "cwd", "source", "archived", "first_user_message", "recency_at_ms", "updated_at_ms",
] as const;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExactCwdSession =
  | { kind: "found"; id: string }
  | { kind: "none" }
  | { kind: "unreadable"; reason: string };

export type SiblingState = "siblings" | "alone";

export type CodexResumePlan =
  | { mode: "resume"; id: string }
  | { mode: "fresh"; reason: "no-session" }
  | { mode: "fresh"; reason: "unreadable-with-siblings"; cause: string; warning: string }
  | { mode: "last"; cause: string; warning: string };

/**
 * The only way the lookup opens Codex's database. Read-only and never
 * creating the file: AgEnD must not write, checkpoint or recreate Codex state.
 */
export function openCodexStateReadonly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true, timeout: 1_000 });
}

/** The working directory as configured and as the filesystem resolves it. */
function cwdCandidates(workingDirectory: string): string[] {
  const configured = resolve(workingDirectory);
  let real: string | null = null;
  try { real = realpathSync(configured); } catch { /* a missing dir still matches as configured */ }
  return real && real !== configured ? [configured, real] : [configured];
}

/**
 * Newest interactive thread recorded for exactly this directory. Exact
 * equality only: a prefix or LIKE match would take a subdirectory's (or a
 * similarly named sibling's) session.
 *
 * "Has anything in it" is `first_user_message <> ''` — checked against real
 * Codex data (#1017), not inferred from a column name:
 * - `has_user_event` does NOT mean that. Real 0.157 sessions with a first
 *   message and millions of tokens carry 0; the one row with 1 was empty.
 *   Filtering on it matched no real session, so every restart silently
 *   started a new conversation.
 * - `tokens_used > 0` drops real sessions too: a provider that reports no
 *   token usage leaves it at 0, as does a restart during the first turn.
 * - `first_user_message` is empty exactly for threads that were opened and
 *   never written to, which is what resuming must skip.
 * tests/fixtures/codex-real-threads.json holds the real rows behind this.
 */
export function findExactCwdCodexSession(
  stateDbPath: string,
  workingDirectory: string,
  open: (path: string) => Database.Database = openCodexStateReadonly,
): ExactCwdSession {
  let db: Database.Database | null = null;
  try {
    db = open(stateDbPath);
    const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(c => c.name));
    const missing = CODEX_THREAD_COLUMNS.filter(c => !columns.has(c));
    if (missing.length > 0) return { kind: "unreadable", reason: `threads schema missing: ${missing.join(", ")}` };
    const [first, second = first] = cwdCandidates(workingDirectory);
    const row = db.prepare(`
      SELECT id FROM threads
      WHERE cwd IN (?, ?)
        AND source = 'cli'
        AND archived = 0
        AND first_user_message <> ''
      ORDER BY recency_at_ms DESC, updated_at_ms DESC, id DESC
      LIMIT 1
    `).get(first, second) as { id: unknown } | undefined;
    if (!row) return { kind: "none" };
    // A malformed id means the schema no longer means what we think it does.
    if (typeof row.id !== "string" || !SESSION_ID_RE.test(row.id)) {
      return { kind: "unreadable", reason: "threads.id is not a session UUID" };
    }
    return { kind: "found", id: row.id };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { kind: "unreadable", reason: e.code ?? e.message ?? String(err) };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * The directory's git common dir: a string for a repo, null for "not a git
 * repository", "unknown" for anything else (timeout, git missing, …).
 */
export type GitCommonDir = (dir: string) => string | null | "unknown";

export const defaultGitCommonDir: GitCommonDir = dir => {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2_000,
    }).trim() || "unknown";
  } catch (err) {
    const e = err as { status?: number | null; stderr?: string | Buffer };
    const stderr = String(e.stderr ?? "");
    return e.status === 128 && /not a git repository/i.test(stderr) ? null : "unknown";
  }
};

/**
 * Whether another Codex instance works in the same repository. Anything
 * undeterminable counts as a sibling: the caller then refuses `--last`, which
 * is what would take a sibling's session.
 */
export function codexSiblingState(
  workingDirectory: string,
  otherWorkingDirectories: readonly string[],
  gitCommonDir: GitCommonDir = defaultGitCommonDir,
): SiblingState {
  const own = gitCommonDir(workingDirectory);
  if (own === null) return "alone";
  if (own === "unknown") return "siblings";
  for (const other of otherWorkingDirectories) {
    const theirs = gitCommonDir(other);
    if (theirs === "unknown" || theirs === own) return "siblings";
  }
  return "alone";
}

/**
 * The launch decision. Never falls back to `--last` when the lookup worked
 * and found nothing: in a worktree that is exactly the call that resumes a
 * sibling's session. Siblings are only computed when the database is
 * unreadable.
 */
export function planCodexResume(lookup: ExactCwdSession, siblings: () => SiblingState): CodexResumePlan {
  if (lookup.kind === "found") return { mode: "resume", id: lookup.id };
  if (lookup.kind === "none") return { mode: "fresh", reason: "no-session" };
  if (siblings() === "siblings") {
    return {
      mode: "fresh",
      reason: "unreadable-with-siblings",
      cause: lookup.reason,
      warning: `Codex session database unreadable (${lookup.reason}); another Codex instance shares this repository, so starting a new session instead of \`resume --last\`. Earlier conversations are kept and can be resumed manually.`,
    };
  }
  return {
    mode: "last",
    cause: lookup.reason,
    warning: `Codex session database unreadable (${lookup.reason}); no other Codex instance shares this repository, falling back to \`resume --last\`.`,
  };
}
