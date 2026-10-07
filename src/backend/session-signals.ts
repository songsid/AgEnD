/**
 * Detection-signal seam: the shared base for #1209 / #1217a / #1210 / #1215.
 *
 * A read-only, query-only observation layer answering ONE question without
 * pane pixels: did the CLI itself re-engage a turn since the checkpoint
 * (double-drive guard)? Per-backend adapters discover the workspace's session
 * in the CLI's own session store and produce a `TurnFingerprint`; the
 * backend-agnostic `compareFingerprints` diffs a pre-action checkpoint
 * against a post-action read.
 *
 * RED LINE: this seam never touches the idle/busy state machine.
 * `readinessFromStore` always returns `unknown` — the pane stays the
 * busyness authority, exactly as today. Nothing here drives, resumes, or
 * writes any CLI state; every read is out-of-band and defensive (an absent
 * field is null, never an exception).
 *
 * SYNC I/O WARNING: every read below is synchronous blocking file/database
 * I/O. Never resolve fingerprints on the fleet event loop or inside a tool
 * handler — use a bounded worker context.
 *
 * What counts as re-engagement: a new TURN, not a store write. CLIs
 * bookkeep without turns (claude `cost-state`/`ai-title`, codex threads-row
 * touches, muse `session.workspace_branch.observed`), so both the mtime and
 * the tail path are gated on turn-shaped journal entries (`isTurnKind`):
 * file mtime is recorded for grace bookkeeping but never drives the verdict
 * alone. Kinds this seam does not recognise default to bookkeeping — a new
 * turn vocabulary delays detection to the next recognised write instead of
 * fabricating or blocking on it.
 *
 * Daemon exclusion covers BOTH paths: the daemon's own action (e.g. a resume)
 * writes tail entries too, so a turn tail counts only past
 * `max(before.tail, daemonCausedMtimeMs) + tailSkewMs`. The skew (default 2s:
 * filesystem timestamp granularity plus entry-ts vs flush-mtime reorder —
 * a live codex tail was observed 2ms AFTER its row mtime) keeps a
 * daemon-caused tail from reading as someone else's turn.
 *
 * Tail-timestamp fields were verified against live stores, not assumed:
 * - claude-code 2.1.289 transcript JSONL: user/assistant/system entries carry
 *   ISO `timestamp`, but the tail is usually bookkeeping (`cost-state`,
 *   `last-prompt`, `mode`, `ai-title`, …) with NO timestamp — so the reader
 *   scans backwards for the newest timestamped TURN entry instead of taking
 *   the last line.
 * - codex rollout JSONL: every line of a lived-in 53k-line rollout carries
 *   top-level ISO `timestamp`; `type` + `payload.type` name the kind
 *   (`response_item:message`, `event_msg:task_started`, `turn_context`,
 *   `token_usage_record`, …). threads row verified with `updated_at_ms` /
 *   `recency_at_ms` epoch millis.
 * - muse 1.4.x `session.jsonl`: entries carry NO `timestamp` at all — time is
 *   `recorded_at` in epoch MICROseconds, kind is `payload_type` (plus inner
 *   `payload.kind` for the `runtime.session` envelope: `task`/`run` are the
 *   turn frames, surveyed live over 49k lines); the first line is a
 *   `retained_frame` wrapper with neither.
 *
 * Flush grace and its residual: a CLI that just re-engaged may not have
 * flushed its store yet, so a checkpoint taken too early reads `quiet` for a
 * live turn. Inside `flushGraceMs` after the daemon's own write the seam
 * answers `unknown` instead of `quiet`. Residual, by design and bounded: a
 * re-engagement that flushes after this compare is caught by the NEXT
 * checkpoint compare (at most one grace period of delayed detection, never a
 * fabricated verdict). A re-engagement that never writes to the session store
 * is invisible to this seam. Callers MUST re-compare across checkpoints; a
 * single `quiet` inside the grace window must never authorize driving.
 *
 * kiro-classic `data.sqlite3` and KAS are deliberately NOT covered here: the
 * classic schema needs its own round (see #1210) and the spike's KAS field
 * assumptions were never verified against a live store.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { claudeProjectKey } from "./claude-code.js";
import { findExactCwdCodexSession, openCodexStateReadonly, rolloutRecordsTurn } from "./codex-session-lookup.js";
import { museSessionCwd, museSessionDirs, readFileHeadSync } from "./muse.js";

/** Which backend's journal a kind filter applies to. */
export type TurnBackend = "claude" | "codex" | "muse";

/** One read-only snapshot of a backend's session store for one session. */
export interface TurnFingerprint {
  /** Session id discovered in the store itself (never caller-supplied). */
  sessionId: string | null;
  /** Newest store mtime observed (grace bookkeeping; never drives the verdict alone). */
  storeMtimeMs: number;
  /** Newest TURN entry timestamp the journal carries, else null. */
  tailTimestampMs: number | null;
  /** Best-effort tail turn-entry kind, else null. */
  tailKind: string | null;
}

export type ReengagementVerdict = "reengaged" | "quiet" | "unknown";

/** Busyness from a store alone: always unknown — the pane stays authoritative. */
export type StoreReadiness = "ready" | "busy" | "unknown";

/**
 * How long after the daemon's own store write a `quiet` read is untrustworthy.
 * 10 s matches the transcript-marker wait bound (#758): a journal flush lands
 * well inside it, while the window stays short enough to schedule around.
 */
export const DEFAULT_FLUSH_GRACE_MS = 10_000;

/**
 * Entry-ts vs daemon-mtime skew bound (ms). A daemon-caused tail must clear
 * the daemon's own mtime by more than this to count as someone else's turn.
 */
export const DEFAULT_TAIL_SKEW_MS = 2_000;

/** Epoch microseconds at or above this are muse `recorded_at`, not millis. */
const MICROSECONDS_FLOOR = 1e14;

/**
 * Parse an ISO instant, epoch millis, or epoch micros (muse `recorded_at`);
 * anything else is null. Numbers below the micros floor pass through as
 * millis; what no tailed store emits (e.g. epoch seconds) is out of scope.
 */
export function asTimestampMs(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v >= MICROSECONDS_FLOOR ? v / 1000 : v;
  }
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Best-effort kind of one journal entry across the three store shapes:
 * claude `type`/`subtype`, codex `type` + `payload.type`, muse `payload_type`
 * (+ inner `payload.kind` for the `runtime.session` envelope).
 */
export function entryKind(entry: Record<string, unknown>): string | null {
  const payload = entry.payload;
  const payloadObj = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
  const base = str(entry.type) ?? str(entry.kind) ?? str(entry.payload_type)
    ?? str(payloadObj?.type) ?? str(payloadObj?.payload_type) ?? str(payloadObj?.kind);
  if (!base) return null;
  const detail = str(entry.subtype) ?? str(payloadObj?.kind) ?? str(entry.payload_type)
    ?? str(payloadObj?.type) ?? str(payloadObj?.payload_type);
  return detail && detail !== base ? `${base}:${detail}` : base;
}

/** Newest timestamp one journal entry carries across the three store shapes. */
export function entryTimestampMs(entry: Record<string, unknown>): number | null {
  return asTimestampMs(
    entry.recorded_at ?? entry.timestamp ?? entry.time ?? entry.createdAt ?? entry.lastModifiedAt,
  );
}

/**
 * Whether a tail kind proves a turn ran (as opposed to CLI bookkeeping).
 * Unrecognised kinds default to bookkeeping: a new turn vocabulary delays
 * detection instead of blocking legitimate resumes on false positives.
 */
export function isTurnKind(backend: TurnBackend, kind: string | null): boolean {
  if (!kind) return false;
  if (backend === "claude") return kind === "user" || kind === "assistant";
  if (backend === "codex") {
    return kind === "response_item" || kind.startsWith("response_item:")
      || kind.startsWith("event_msg:task_");
  }
  if (kind === "command.invoked" || kind === "session.resumed") return true;
  if (kind.startsWith("runtime.user_intent.")) return true;
  if (kind.startsWith("tool_batch.effect.")) return true;
  return kind === "runtime.session.task" || kind === "runtime.session.task_source_committed"
    || kind === "runtime.session:task" || kind === "runtime.session:run";
}

/** Newest parseable entries of a JSONL journal, newest first, plus file mtime. */
export interface TailRead {
  entries: Array<Record<string, unknown>>;
  mtimeMs: number;
}

/** Bytes scanned back from the end of a journal looking for tail entries. */
const TAIL_SCAN_BYTES = 1024 * 1024;

/**
 * Read-only tail of a JSONL journal: the newest `want` parseable entries
 * within the last 1 MB, newest first. A truncated line at the window edge or
 * a corrupt line is skipped, never fatal. Windowed by design: when the tail
 * itself is one entry larger than the window, the read still returns the
 * file mtime with an empty entry list (detection delayed, never fabricated).
 * Synchronous blocking I/O — see the module warning.
 */
export function readJsonlTailEntries(path: string, want = 8): TailRead | null {
  if (!(want >= 1)) want = 1;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const window = Math.min(st.size, TAIL_SCAN_BYTES);
    const buf = Buffer.alloc(window);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, window, st.size - window);
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    const lines = buf.toString("utf8").split("\n");
    const entries: Array<Record<string, unknown>> = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < want; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          entries.push(parsed as Record<string, unknown>);
        }
      } catch { /* partial line at the window edge or corrupt: skip */ }
    }
    return { entries, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Newest timestamped TURN entry of a tail: skips timestamp-less bookkeeping
 * (claude `cost-state`/`last-prompt`, muse `retained_frame`) AND timestamped
 * non-turn writes (codex `token_count`, muse `workspace_branch.observed`).
 * Null when no turn entry carries time.
 */
export function tailEvidence(
  entries: readonly Record<string, unknown>[],
  backend: TurnBackend,
): { timestampMs: number; kind: string | null } | null {
  for (const entry of entries) {
    const kind = entryKind(entry);
    if (!isTurnKind(backend, kind)) continue;
    const timestampMs = entryTimestampMs(entry);
    if (timestampMs !== null) return { timestampMs, kind };
  }
  return null;
}

export interface CompareOptions {
  /**
   * Newest store write the daemon can attribute to its own action (e.g. the
   * resume it just performed). A turn tail counts only past
   * `max(before.tail, daemonCausedMtimeMs) + tailSkewMs`; anything at or
   * below it does not count. -1 (default) = no daemon write to exclude.
   */
  daemonCausedMtimeMs?: number;
  /** Clock for the flush-grace window; defaults to Date.now(), injectable. */
  nowMs?: number;
  /** See DEFAULT_FLUSH_GRACE_MS; injectable per caller. */
  flushGraceMs?: number;
  /** See DEFAULT_TAIL_SKEW_MS; injectable per caller. */
  tailSkewMs?: number;
}

/**
 * Backend-agnostic re-engagement verdict. A changed session id means the
 * store now belongs to a different conversation (feeds #1217a). Otherwise
 * only a TURN-tail advance past the daemon's own writes (plus skew) means
 * the CLI wrote on its own — plain mtime movement is bookkeeping until a
 * turn entry says otherwise. Inside the flush-grace window after a daemon
 * write, `quiet` is withheld as `unknown` (see module doc).
 */
export function compareFingerprints(
  before: TurnFingerprint | null,
  after: TurnFingerprint | null,
  options: CompareOptions = {},
): ReengagementVerdict {
  if (!before || !after || before.storeMtimeMs < 0 || after.storeMtimeMs < 0) return "unknown";
  if (before.sessionId && after.sessionId && before.sessionId !== after.sessionId) return "reengaged";
  const daemonCausedMtimeMs = options.daemonCausedMtimeMs ?? -1;
  const tailSkewMs = Math.max(0, options.tailSkewMs ?? DEFAULT_TAIL_SKEW_MS);
  const afterTail = after.tailTimestampMs;
  const pastBefore = afterTail !== null
    && (before.tailTimestampMs === null || afterTail > before.tailTimestampMs);
  const pastDaemon = afterTail !== null
    && (daemonCausedMtimeMs < 0 || afterTail > daemonCausedMtimeMs + tailSkewMs);
  if (pastBefore && pastDaemon) return "reengaged";
  if (daemonCausedMtimeMs >= 0) {
    const nowMs = options.nowMs ?? Date.now();
    const flushGraceMs = options.flushGraceMs ?? DEFAULT_FLUSH_GRACE_MS;
    if (nowMs - daemonCausedMtimeMs <= flushGraceMs) return "unknown";
  }
  return "quiet";
}

/**
 * Store-corroborated busyness, by design always unknown: append-only journals
 * carry no verified completion semantics, so a store alone cannot say "busy"
 * vs "ready" — it can only say "wrote recently". The pane stays authoritative;
 * this seam MUST NOT feed the idle/busy state machine.
 */
export function readinessFromStore(_fp: TurnFingerprint | null): { readiness: StoreReadiness; reason: string } {
  return {
    readiness: "unknown",
    reason: "append-only journal without verified completion entries; pane stays authoritative",
  };
}

// --- Per-backend adapters (store-side session discovery; read-only) ---
// Synchronous blocking I/O throughout — see the module warning.

export interface ClaudeRoots {
  /** Honors CLAUDE_CONFIG_DIR at the call site; tests inject a tmp dir. */
  configDir: string;
  cwd: string;
}

/**
 * Newest `<sessionId>.jsonl` of `~/.claude/projects/<key>/` plus its newest
 * timestamped TURN tail entry. The session id is discovered from the store,
 * never caller-supplied, so a conversation switch surfaces as an id change.
 */
export function claudeFingerprint(r: ClaudeRoots): TurnFingerprint | null {
  const dir = join(r.configDir, "projects", claudeProjectKey(r.cwd));
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let bestFile: string | null = null;
  let bestMtime = -1;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (m > bestMtime) { bestMtime = m; bestFile = name; }
    } catch { /* raced with deletion */ }
  }
  if (!bestFile) return null;
  const tail = readJsonlTailEntries(join(dir, bestFile));
  const evidence = tail && tailEvidence(tail.entries, "claude");
  return {
    sessionId: bestFile.slice(0, -".jsonl".length),
    storeMtimeMs: tail?.mtimeMs ?? bestMtime,
    tailTimestampMs: evidence?.timestampMs ?? null,
    tailKind: evidence?.kind ?? null,
  };
}

/** Minimal database surface the codex adapter needs; production passes better-sqlite3. */
export interface CodexDb {
  prepare: (sql: string) => { get: (...args: never[]) => unknown };
  close: () => void;
}

export interface CodexRoots {
  stateDbPath: string;
  cwd: string;
  /** Defaults to the #984 read-only opener (never creates the file). */
  openDb?: (path: string) => CodexDb | null;
  /** Defaults to the windowed JSONL tail; injectable for tests. */
  rolloutTail?: (path: string) => TailRead | null;
  /** Defaults to the production rollout turn check; injectable for tests. */
  rolloutHasTurn?: (path: string) => boolean;
}

/**
 * The exact-cwd session from `state_5.sqlite` (same lookup as #984: newest
 * interactive thread of this directory, never `--last`), then its threads
 * row (`updated_at_ms`/`recency_at_ms`) plus rollout tail. The database is
 * opened read-only (never created, checkpointed, or migrated); an unknown
 * session or a schema that no longer matches is null (unknown), never a
 * guess. The session id is discovered from the store, never caller-supplied.
 */
export function codexFingerprint(r: CodexRoots): TurnFingerprint | null {
  const openDb = r.openDb ?? ((path: string) => openCodexStateReadonly(path) as unknown as CodexDb);
  const rolloutTail = r.rolloutTail ?? ((path: string) => readJsonlTailEntries(path));
  const rolloutHasTurn = r.rolloutHasTurn ?? rolloutRecordsTurn;
  const discoveryOpen = (path: string): Database.Database => {
    let db: CodexDb | null = null;
    try { db = openDb(path); } catch { /* fall through to throw */ }
    if (!db) throw new Error(`codex state unreadable: ${path}`);
    return db as unknown as Database.Database;
  };
  let sessionId: string;
  try {
    const lookup = findExactCwdCodexSession(r.stateDbPath, r.cwd, discoveryOpen, rolloutHasTurn);
    if (lookup.kind !== "found") return null;
    sessionId = lookup.id;
  } catch {
    return null;
  }
  let db: CodexDb | null = null;
  try {
    try {
      db = openDb(r.stateDbPath);
    } catch {
      return null;
    }
    if (!db) return null;
    const row = db.prepare(
      "SELECT updated_at_ms, recency_at_ms, rollout_path FROM threads WHERE id = ?",
    ).get(sessionId as never) as
      { updated_at_ms?: unknown; recency_at_ms?: unknown; rollout_path?: unknown } | undefined;
    if (!row) return null;
    let tailTimestampMs: number | null = null;
    let tailKind: string | null = null;
    let fileMtime = -1;
    if (typeof row.rollout_path === "string") {
      const tail = rolloutTail(row.rollout_path);
      if (tail) {
        fileMtime = tail.mtimeMs;
        const evidence = tailEvidence(tail.entries, "codex");
        tailTimestampMs = evidence?.timestampMs ?? null;
        tailKind = evidence?.kind ?? null;
      }
    }
    const storeMtimeMs = Math.max(
      typeof row.updated_at_ms === "number" ? row.updated_at_ms : -1,
      typeof row.recency_at_ms === "number" ? row.recency_at_ms : -1,
      fileMtime,
    );
    return storeMtimeMs < 0
      ? null
      : { sessionId, storeMtimeMs, tailTimestampMs, tailKind };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

export interface MuseRoots {
  sessionsRoot: string;
  cwd: string;
}

/** Session-id pattern, mirroring muse.ts (MuseBackend session ids are UUIDs). */
const MUSE_SESSION_ID_RE = /^[0-9a-fA-F-]{8,}$/;

/** Log head scanned for the workspace marker, mirroring muse.ts. */
const MUSE_SESSION_HEAD_CHARS = 65_536;

/**
 * The most recently active session started in this working directory,
 * mirroring MuseBackend.getSessionId (workspace read out of each session's
 * own log, activity = newest inner-file mtime), plus its newest timestamped
 * TURN tail entry. The session id is discovered from the store, never
 * caller-supplied, so a conversation switch surfaces as an id change.
 */
export function museFingerprint(r: MuseRoots): TurnFingerprint | null {
  if (!r.cwd) return null;
  let bestId: string | null = null;
  let bestDir = "";
  let bestActivity = -1;
  for (const sessionDir of museSessionDirs(r.sessionsRoot)) {
    const name = sessionDir.slice(sessionDir.lastIndexOf("/") + 1);
    if (!MUSE_SESSION_ID_RE.test(name)) continue;
    const head = readFileHeadSync(join(sessionDir, "session.jsonl"), MUSE_SESSION_HEAD_CHARS);
    if (head === null) continue;
    if (museSessionCwd(head) !== r.cwd) continue;
    let activity = -1;
    try {
      for (const f of readdirSync(sessionDir)) {
        try {
          const m = statSync(join(sessionDir, f)).mtimeMs;
          if (m > activity) activity = m;
        } catch { /* raced with deletion */ }
      }
    } catch { /* unreadable */ }
    if (activity > bestActivity) { bestActivity = activity; bestId = name; bestDir = sessionDir; }
  }
  if (!bestId) return null;
  const tail = readJsonlTailEntries(join(bestDir, "session.jsonl"));
  const evidence = tail && tailEvidence(tail.entries, "muse");
  return {
    sessionId: bestId,
    storeMtimeMs: bestActivity,
    tailTimestampMs: evidence?.timestampMs ?? null,
    tailKind: evidence?.kind ?? null,
  };
}
