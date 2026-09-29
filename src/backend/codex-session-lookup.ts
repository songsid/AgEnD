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
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

/** Columns the lookup depends on; any missing one means "schema unreadable". */
export const CODEX_THREAD_COLUMNS = [
  "id", "cwd", "source", "archived", "first_user_message", "rollout_path", "recency_at_ms", "updated_at_ms",
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
 * "Has anything in it" was checked against real Codex data (#1017), not
 * inferred from a column name:
 * - `has_user_event` does NOT mean that. Real 0.157 sessions with a first
 *   message and millions of tokens carry 0. Filtering on it matched no real
 *   session, so every restart silently started a new conversation.
 * - `tokens_used > 0` drops real sessions too: a provider that reports no
 *   token usage leaves it at 0, as does a restart during the first turn.
 * - A non-empty `first_user_message` proves content, but an empty one does
 *   not prove the opposite: a real 38-turn session (0.156.1) and `/goal`-first
 *   sessions (openai/codex#28423) have empty list metadata. For those the
 *   rollout decides — a thread nobody wrote to (e.g. an untouched fork) holds
 *   only `session_meta`/`thread_settings_applied`, never a user message.
 * tests/fixtures/codex-real-threads.json holds the real rows behind this.
 */
export function findExactCwdCodexSession(
  stateDbPath: string,
  workingDirectory: string,
  open: (path: string) => Database.Database = openCodexStateReadonly,
  rolloutHasUserMessage: (path: string) => boolean = rolloutRecordsUserMessage,
): ExactCwdSession {
  let db: Database.Database | null = null;
  try {
    db = open(stateDbPath);
    const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(c => c.name));
    const missing = CODEX_THREAD_COLUMNS.filter(c => !columns.has(c));
    if (missing.length > 0) return { kind: "unreadable", reason: `threads schema missing: ${missing.join(", ")}` };
    const [first, second = first] = cwdCandidates(workingDirectory);
    const rows = db.prepare(`
      SELECT id, first_user_message, rollout_path FROM threads
      WHERE cwd IN (?, ?)
        AND source = 'cli'
        AND archived = 0
      ORDER BY recency_at_ms DESC, updated_at_ms DESC, id DESC
      LIMIT ${MAX_CANDIDATE_THREADS}
    `).all(first, second) as Array<{ id: unknown; first_user_message: unknown; rollout_path: unknown }>;
    const row = rows.find(r => (typeof r.first_user_message === "string" && r.first_user_message !== "")
      || (typeof r.rollout_path === "string" && rolloutHasUserMessage(r.rollout_path)));
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

/** How many of the directory's newest threads the lookup will look through. */
const MAX_CANDIDATE_THREADS = 50;
/** The head of a rollout the content check reads; a user message sits in the first few lines. */
const ROLLOUT_HEAD_BYTES = 1024 * 1024;

/**
 * Whether a Codex rollout (JSONL) records a user message. Reads only the
 * head of the file, read-only; a missing or unreadable rollout cannot be
 * resumed, so it counts as no. A head too long to hold one without it has
 * clearly been used, so it counts as yes.
 */
export function rolloutRecordsUserMessage(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(ROLLOUT_HEAD_BYTES);
    const read = readSync(fd, buf, 0, ROLLOUT_HEAD_BYTES, 0);
    const lines = buf.subarray(0, read).toString("utf8").split("\n");
    const complete = read < ROLLOUT_HEAD_BYTES ? lines : lines.slice(0, -1);
    for (const line of complete) {
      if (!line.includes('"response_item"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown; role?: unknown } };
        if (entry.type === "response_item" && entry.payload?.type === "message" && entry.payload.role === "user") return true;
      } catch { /* a malformed line says nothing */ }
    }
    return read === ROLLOUT_HEAD_BYTES;
  } catch {
    return false;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
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
