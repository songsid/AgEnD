/**
 * Detection-signal seam: the shared base for #1209 / #1217a / #1210 / #1215.
 *
 * A read-only, query-only observation layer answering ONE question without
 * pane pixels: did the CLI itself re-engage a turn since the checkpoint
 * (double-drive guard)? Per-backend adapters produce a `TurnFingerprint` of
 * the CLI's own session store; the backend-agnostic `compareFingerprints`
 * diffs a pre-action checkpoint against a post-action read.
 *
 * RED LINE: this seam never touches the idle/busy state machine.
 * `readinessFromStore` always returns `unknown` — the pane stays the
 * busyness authority, exactly as today. Nothing here drives, resumes, or
 * writes any CLI state; every read is out-of-band and defensive (an absent
 * field is null, never an exception).
 *
 * Tail-timestamp fields below were verified against live stores, not assumed:
 * - claude-code 2.1.289 transcript JSONL: user/assistant/system entries carry
 *   ISO `timestamp`, but the tail is usually bookkeeping (`cost-state`,
 *   `last-prompt`, `mode`, `ai-title`, …) with NO timestamp — so the reader
 *   scans backwards for the newest timestamped entry instead of taking the
 *   last line.
 * - codex rollout JSONL: all 53k lines of a lived-in rollout carry top-level
 *   ISO `timestamp`; `type` + `payload.type` name the kind
 *   (`response_item:message`, `event_msg:task_started`, `turn_context`, …).
 *   threads row verified with `updated_at_ms` / `recency_at_ms` epoch millis.
 * - muse 1.4.x `session.jsonl`: entries carry NO `timestamp` at all — time is
 *   `recorded_at` in epoch MICROseconds, kind is `payload_type`; the first
 *   line is a `retained_frame` wrapper with neither.
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
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectKey } from "./claude-code.js";
import { openCodexStateReadonly } from "./codex-session-lookup.js";

/** One read-only snapshot of a backend's session store for one session. */
export interface TurnFingerprint {
  /** Which session the store attributes to this workspace (null when unmapped). */
  sessionId: string | null;
  /** Newest store mtime the adapter trusts as "CLI wrote" (ms epoch, -1 unread). */
  storeMtimeMs: number;
  /** Newest entry timestamp the journal carries, else null. */
  tailTimestampMs: number | null;
  /** Best-effort tail entry kind, else null. */
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
 * claude `type`/`subtype`, codex `type` + `payload.type`, muse `payload_type`.
 */
export function entryKind(entry: Record<string, unknown>): string | null {
  const payload = entry.payload;
  const payloadObj = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
  const base = str(entry.type) ?? str(entry.kind) ?? str(entry.payload_type)
    ?? str(payloadObj?.type) ?? str(payloadObj?.payload_type);
  if (!base) return null;
  const detail = str(entry.subtype) ?? str(payloadObj?.type)
    ?? str(entry.payload_type) ?? str(payloadObj?.payload_type);
  return detail && detail !== base ? `${base}:${detail}` : base;
}

/** Newest timestamp one journal entry carries across the three store shapes. */
export function entryTimestampMs(entry: Record<string, unknown>): number | null {
  return asTimestampMs(
    entry.recorded_at ?? entry.timestamp ?? entry.time ?? entry.createdAt ?? entry.lastModifiedAt,
  );
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
 * a corrupt line is skipped, never fatal. Windowed by design: a very large
 * tail entry falls back to older ones — detection delayed, never fabricated.
 */
export function readJsonlTailEntries(path: string, want = 8): TailRead | null {
  if (!(want >= 1)) want = 1;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
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
    if (entries.length === 0) return null;
    return { entries, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Newest timestamped entry of a tail: skips timestamp-less bookkeeping
 * (claude `cost-state`/`last-prompt`, muse `retained_frame`) instead of
 * reporting the journal as timeless. Null when no entry carries time.
 */
export function tailEvidence(
  entries: readonly Record<string, unknown>[],
): { timestampMs: number; kind: string | null } | null {
  for (const entry of entries) {
    const timestampMs = entryTimestampMs(entry);
    if (timestampMs !== null) return { timestampMs, kind: entryKind(entry) };
  }
  return null;
}

export interface CompareOptions {
  /**
   * Newest store write the daemon can attribute to its own action (e.g. the
   * resume it just performed). Anything newer means somebody else drove the
   * CLI; anything at or below it does not count. -1 (default) = no daemon
   * write to exclude.
   */
  daemonCausedMtimeMs?: number;
  /** Clock for the flush-grace window; defaults to Date.now(), injectable. */
  nowMs?: number;
  /** See DEFAULT_FLUSH_GRACE_MS; injectable per caller. */
  flushGraceMs?: number;
}

/**
 * Backend-agnostic re-engagement verdict. A changed session id means the
 * store now belongs to a different conversation (feeds #1217a). Otherwise an
 * advance past the daemon's own writes — file mtime or journal timestamp —
 * means the CLI wrote on its own. Inside the flush-grace window after a
 * daemon write, `quiet` is withheld as `unknown` (see module doc).
 */
export function compareFingerprints(
  before: TurnFingerprint | null,
  after: TurnFingerprint | null,
  options: CompareOptions = {},
): ReengagementVerdict {
  if (!before || !after || before.storeMtimeMs < 0 || after.storeMtimeMs < 0) return "unknown";
  if (before.sessionId && after.sessionId && before.sessionId !== after.sessionId) return "reengaged";
  const daemonCausedMtimeMs = options.daemonCausedMtimeMs ?? -1;
  const cutoff = Math.max(before.storeMtimeMs, daemonCausedMtimeMs);
  const mtimeAdvanced = after.storeMtimeMs > cutoff;
  const tailAdvanced = before.tailTimestampMs !== null
    && after.tailTimestampMs !== null
    && after.tailTimestampMs > before.tailTimestampMs;
  if (mtimeAdvanced || tailAdvanced) return "reengaged";
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

// --- Per-backend adapters (pure over injectable roots; read-only) ---

export interface ClaudeRoots {
  /** Honors CLAUDE_CONFIG_DIR at the call site; tests inject a tmp dir. */
  configDir: string;
  cwd: string;
  sessionId: string | null;
}

/** `~/.claude/projects/<key>/<sessionId>.jsonl`: mtime + newest timestamped tail entry. */
export function claudeFingerprint(r: ClaudeRoots): TurnFingerprint | null {
  if (!r.sessionId) return null;
  const path = join(r.configDir, "projects", claudeProjectKey(r.cwd), `${r.sessionId}.jsonl`);
  const tail = readJsonlTailEntries(path);
  if (!tail) return null;
  const evidence = tailEvidence(tail.entries);
  return {
    sessionId: r.sessionId,
    storeMtimeMs: tail.mtimeMs,
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
  sessionId: string | null;
  /** Defaults to the #984 read-only opener (never creates the file). */
  openDb?: (path: string) => CodexDb | null;
  /** Defaults to the windowed JSONL tail; injectable for tests. */
  rolloutTail?: (path: string) => TailRead | null;
}

/**
 * `state_5.sqlite` threads row (`updated_at_ms`/`recency_at_ms`, both epoch
 * millis on live 0.157 state) + rollout tail. The database is opened read-only
 * exactly like #984 (never created, checkpointed, or migrated); a schema that
 * no longer matches is null (unknown), never a guess.
 */
export function codexFingerprint(r: CodexRoots): TurnFingerprint | null {
  if (!r.sessionId) return null;
  const openDb = r.openDb ?? ((path: string) => openCodexStateReadonly(path) as unknown as CodexDb);
  const rolloutTail = r.rolloutTail ?? ((path: string) => readJsonlTailEntries(path));
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
    ).get(r.sessionId as never) as
      { updated_at_ms?: unknown; recency_at_ms?: unknown; rollout_path?: unknown } | undefined;
    if (!row) return null;
    const dbMtime = Math.max(
      typeof row.updated_at_ms === "number" ? row.updated_at_ms : -1,
      typeof row.recency_at_ms === "number" ? row.recency_at_ms : -1,
    );
    let tailTimestampMs: number | null = null;
    let tailKind: string | null = null;
    let fileMtime = -1;
    if (typeof row.rollout_path === "string") {
      const tail = rolloutTail(row.rollout_path);
      if (tail) {
        fileMtime = tail.mtimeMs;
        const evidence = tailEvidence(tail.entries);
        tailTimestampMs = evidence?.timestampMs ?? null;
        tailKind = evidence?.kind ?? null;
      }
    }
    const storeMtimeMs = Math.max(dbMtime, fileMtime);
    return storeMtimeMs < 0
      ? null
      : { sessionId: r.sessionId, storeMtimeMs, tailTimestampMs, tailKind };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

export interface MuseRoots {
  sessionsRoot: string;
  sessionId: string | null;
}

/**
 * `<root>/<YYYY>/<MM>/<DD>/<sessionId>/`, mirroring MuseBackend.getSessionId:
 * activity is the newest inner-file mtime (the directory's own mtime does not
 * move on append), and time comes from `recorded_at` micros of `session.jsonl`.
 */
export function museFingerprint(r: MuseRoots): TurnFingerprint | null {
  if (!r.sessionId) return null;
  const dir = findMuseSessionDir(r.sessionsRoot, r.sessionId);
  if (!dir) return null;
  let activity = -1;
  try {
    for (const f of readdirSync(dir)) {
      try {
        const m = statSync(join(dir, f)).mtimeMs;
        if (m > activity) activity = m;
      } catch { /* raced with deletion */ }
    }
  } catch {
    return null;
  }
  if (activity < 0) return null;
  const tail = readJsonlTailEntries(join(dir, "session.jsonl"));
  const evidence = tail && tailEvidence(tail.entries);
  return {
    sessionId: r.sessionId,
    storeMtimeMs: activity,
    tailTimestampMs: evidence?.timestampMs ?? null,
    tailKind: evidence?.kind ?? null,
  };
}

function findMuseSessionDir(root: string, sessionId: string, depth = 0): string | null {
  if (depth > 4) return null;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }
  if (entries.includes(sessionId)) {
    const candidate = join(root, sessionId);
    try {
      if (existsSync(join(candidate, "session.jsonl"))) return candidate;
    } catch { /* not it */ }
  }
  for (const e of entries) {
    if (e === sessionId) continue;
    const hit = findMuseSessionDir(join(root, e), sessionId, depth + 1);
    if (hit) return hit;
  }
  return null;
}
