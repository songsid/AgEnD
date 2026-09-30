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
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import Database from "better-sqlite3";

/** Columns the lookup depends on; any missing one means "schema unreadable". */
export const CODEX_THREAD_COLUMNS = [
  "id", "cwd", "source", "archived", "has_user_event", "first_user_message", "rollout_path", "recency_at_ms", "updated_at_ms",
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
 *   rollout decides whether a turn ever ran. A thread nobody used (e.g. an
 *   untouched fork) holds only `session_meta`/`thread_settings_applied`; any
 *   turn — however its first input was delivered, including hidden goal
 *   context — writes `task_started`, a `turn_context` or a `response_item`.
 * tests/fixtures/codex-real-threads.json holds the real rows behind this.
 */
export function findExactCwdCodexSession(
  stateDbPath: string,
  workingDirectory: string,
  open: (path: string) => Database.Database = openCodexStateReadonly,
  rolloutHasTurn: (path: string) => boolean = rolloutRecordsTurn,
): ExactCwdSession {
  let db: Database.Database | null = null;
  try {
    db = open(stateDbPath);
    const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(c => c.name));
    const missing = CODEX_THREAD_COLUMNS.filter(c => !columns.has(c));
    if (missing.length > 0) return { kind: "unreadable", reason: `threads schema missing: ${missing.join(", ")}` };
    const [first, second = first] = cwdCandidates(workingDirectory);
    // Every thread of this directory, newest first, until one has content —
    // no page limit, so a run of empty threads cannot hide an older session.
    const rows = db.prepare(`
      SELECT id, has_user_event, first_user_message, rollout_path FROM threads
      WHERE cwd IN (?, ?)
        AND source = 'cli'
        AND archived = 0
      ORDER BY recency_at_ms DESC, updated_at_ms DESC, id DESC
    `).iterate(first, second) as IterableIterator<{ id: unknown; has_user_event: unknown; first_user_message: unknown; rollout_path: unknown }>;
    let row: { id: unknown } | undefined;
    for (const r of rows) {
      // Any sign of content is enough; only a thread with none is skipped.
      // has_user_event = 1 is what the #984 lookup accepted, so keeping it
      // means this lookup never resumes less than that one did.
      if (r.has_user_event === 1
        || (typeof r.first_user_message === "string" && r.first_user_message !== "")
        || (typeof r.rollout_path === "string" && rolloutHasTurn(r.rollout_path))) { row = r; break; }
    }
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

/** Rollouts are read in chunks of this size until a turn entry or the end. */
const ROLLOUT_CHUNK_BYTES = 256 * 1024;

/**
 * The entries of a thread nobody used. Real untouched threads (e.g. a fork)
 * hold exactly `session_meta` and `event_msg:thread_settings_applied`.
 */
function isUntouchedThreadEntry(entry: { type?: unknown; payload?: { type?: unknown } }): boolean {
  return entry.type === "session_meta"
    || (entry.type === "event_msg" && entry.payload?.type === "thread_settings_applied");
}

/**
 * Whether a Codex rollout (JSONL) may hold a conversation. Read-only, in
 * chunks, stopping at the first entry that is not part of an untouched thread
 * — in real rollouts a turn entry follows the ~22 KB session_meta line.
 *
 * "No" needs proof: the file has the known untouched shape and nothing else
 * (`session_meta` + `thread_settings_applied`). Every other entry — a turn,
 * an entry type from a newer Codex, a line this code cannot parse — counts
 * as yes: resuming a doubtful thread fails loudly, skipping a real one
 * silently loses the conversation. A missing or unreadable rollout cannot be
 * resumed, so it counts as no.
 */
export function rolloutRecordsTurn(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(ROLLOUT_CHUNK_BYTES);
    // A multi-byte character may straddle two chunks; the decoder holds it.
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let position = 0;
    let recognised = false;
    for (;;) {
      const read = readSync(fd, buf, 0, ROLLOUT_CHUNK_BYTES, position);
      position += read;
      const text = pending + (read === 0 ? decoder.end() : decoder.write(buf.subarray(0, read)));
      const lines = text.split("\n");
      pending = read === 0 ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: { type?: unknown; payload?: { type?: unknown } };
        try { entry = JSON.parse(line) as typeof entry; } catch { return true; } // unparseable: not provably empty
        if (!isUntouchedThreadEntry(entry)) return true;
        if (entry.type === "session_meta") recognised = true;
      }
      if (read === 0) return !recognised;
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * #1053: a conversation this workspace had but the lookup did not return.
 *
 * `planCodexResume` starts fresh on "none", and "never had a conversation"
 * and "had one the lookup missed" look the same from there: #1028 (reading a
 * database this CODEX_HOME does not write) was a silent new session on every
 * restart, the old one still in `codex resume`. The rollout files are the
 * ground truth the database indexes: each begins with `session_meta` naming
 * its cwd. The newest interactive rollout of this directory with a turn in
 * it, if any; null for a workspace that never had one. Read only when the
 * lookup already said "none", so the walk costs nothing on a normal resume.
 */
export function newestMissedCwdRollout(
  sessionsDir: string,
  workingDirectory: string,
  rolloutHasTurn: (path: string) => boolean = rolloutRecordsTurn,
): { id: string; path: string } | null {
  const candidates = new Set(cwdCandidates(workingDirectory));
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (st.isFile() && e.startsWith("rollout-") && e.endsWith(".jsonl")) files.push({ path: p, mtimeMs: st.mtimeMs });
      } catch { /* raced with deletion */ }
    }
  };
  walk(sessionsDir, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    const meta = rolloutSessionMeta(f.path);
    if (!meta || !candidates.has(resolve(meta.cwd)) || meta.source !== "cli") continue;
    if (rolloutHasTurn(f.path)) return { id: meta.id, path: f.path };
  }
  return null;
}

/** The first line of a rollout, when it is the session_meta the thread was created with. */
function rolloutSessionMeta(path: string): { id: string; cwd: string; source: unknown } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    // session_meta can carry long instructions; its line is still bounded.
    const buf = Buffer.alloc(ROLLOUT_CHUNK_BYTES);
    const read = readSync(fd, buf, 0, ROLLOUT_CHUNK_BYTES, 0);
    const first = buf.toString("utf8", 0, read).split("\n")[0] ?? "";
    const entry = JSON.parse(first) as { type?: unknown; payload?: { id?: unknown; cwd?: unknown; source?: unknown } };
    const payload = entry.payload;
    if (entry.type !== "session_meta" || typeof payload?.cwd !== "string") return null;
    if (typeof payload.id !== "string" || !SESSION_ID_RE.test(payload.id)) return null;
    return { id: payload.id, cwd: payload.cwd, source: payload.source };
  } catch {
    return null;
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
