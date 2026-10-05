/**
 * #1209-risk-1 / #1210 / #1215 / #1217a SPIKE (branch-only): unified per-backend
 * "true signal" readers answering two questions without pane pixels —
 *   (A) did the CLI itself re-engage/resume a turn (double-drive guard), and
 *   (B) is the CLI ready / busy / unknown (store-corroborated only).
 *
 * Design: snapshot-compare. A backend adapter produces a read-only
 * `TurnFingerprint` of its own session store; the backend-agnostic
 * `compareFingerprints` decides reengaged / quiet / unknown by diffing a
 * pre-restart checkpoint against a post-restart read. Every read is
 * out-of-band and query-only: nothing here touches the pane-based
 * idle/busy state machine (red line shared with #1210).
 *
 * Store shapes assumed (spike-grade, verify against live CLIs before
 * productizing): claude/codex/muse JSONL entries carry a `timestamp`
 * (ISO string or epoch ms); codex threads carry updated_at_ms /
 * recency_at_ms; kiro KAS session.json carries createdAt/lastModifiedAt.
 * Every parse is defensive: an absent field is null, never an exception.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type SignalState = "yes" | "no" | "unknown";
export type StoreReadiness = "ready" | "busy" | "unknown";

/** One read-only snapshot of a backend's session store for one session. */
export interface TurnFingerprint {
  /** Which session the store attributes to this workspace (null when unmapped). */
  sessionId: string | null;
  /** Newest store mtime the adapter trusts as "CLI wrote" (ms epoch, -1 unread). */
  storeMtimeMs: number;
  /** Tail entry timestamp when the journal carries one, else null. */
  tailTimestampMs: number | null;
  /** Best-effort tail entry kind (e.g. "assistant"/"response_item"), else null. */
  tailKind: string | null;
}

export type ReengagementVerdict = "reengaged" | "quiet" | "unknown";

export interface SessionSignals {
  reengaged: SignalState;
  readiness: StoreReadiness;
  /** One human-readable line naming the source behind the verdict. */
  evidence: string;
}

/** Parse an ISO instant or epoch-ms timestamp; anything else is null. */
export function asInstant(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Last non-blank line of a JSONL file, parsed, or null when absent/unparseable. */
export function readJsonlTail(path: string): { entry: Record<string, unknown>; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
    // Tail window only: the newest entry is what a re-engagement would append.
    const WINDOW = 64 * 1024;
    const fd = readFileSync(path, "utf-8").slice(Math.max(0, st.size - WINDOW));
    const lines = fd.split("\n").map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>;
        if (entry && typeof entry === "object") return { entry, mtimeMs: st.mtimeMs };
      } catch { /* keep scanning older lines in the window */ }
    }
    return null;
  } catch {
    return null;
  }
}

function tailOf(entry: Record<string, unknown>): { ts: number | null; kind: string | null } {
  const ts = asInstant(entry.timestamp ?? entry.time ?? entry.createdAt ?? entry.lastModifiedAt);
  const raw = entry.type ?? entry.kind ?? entry.payload;
  const kind = typeof raw === "string" ? raw
    : (raw && typeof raw === "object" ? String((raw as Record<string, unknown>).type ?? "") || null : null);
  return { ts, kind: kind || null };
}

/**
 * Backend-agnostic (A): did the store advance past what the daemon itself
 * caused? `daemonCausedMtimeMs` is the newest store write the daemon can
 * attribute to its own launch (e.g. the resume it just performed); anything
 * newer means somebody else drove the CLI. A changed session id means the
 * store now belongs to a different conversation (backend switch, #1217).
 */
export function compareFingerprints(
  before: TurnFingerprint | null,
  after: TurnFingerprint | null,
  daemonCausedMtimeMs = -1,
): ReengagementVerdict {
  if (!before || !after || before.storeMtimeMs < 0 || after.storeMtimeMs < 0) return "unknown";
  if (before.sessionId && after.sessionId && before.sessionId !== after.sessionId) return "reengaged";
  const advanced =
    after.storeMtimeMs > Math.max(before.storeMtimeMs, daemonCausedMtimeMs)
    || (before.tailTimestampMs !== null && after.tailTimestampMs !== null
      && after.tailTimestampMs > before.tailTimestampMs);
  return advanced ? "reengaged" : "quiet";
}

/**
 * Backend-agnostic (B), spike verdict: stores are append-only journals with
 * no completion semantics the spike could verify, so a store alone cannot say
 * "busy" vs "ready" — it can only say "wrote recently". The pane stays the
 * busyness authority; this seam returns unknown rather than guessing, and the
 * finding is that (B)-from-store needs per-backend completion-entry research.
 */
export function readinessFromStore(_fp: TurnFingerprint | null): { readiness: StoreReadiness; reason: string } {
  return { readiness: "unknown", reason: "append-only journal without verified completion entries; pane stays authoritative" };
}

// --- Per-backend adapters (pure over injectable roots; read-only) ---

export interface ClaudeRoots { configDir: string; cwd: string; sessionId: string | null }

function claudeProjectKey(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

/** `~/.claude/projects/<key>/<sessionId>.jsonl`: mtime + tail entry. */
export function claudeFingerprint(r: ClaudeRoots): TurnFingerprint | null {
  if (!r.sessionId) return null;
  const path = join(r.configDir, "projects", claudeProjectKey(r.cwd), `${r.sessionId}.jsonl`);
  const tail = readJsonlTail(path);
  if (!tail) return null;
  const t = tailOf(tail.entry);
  return { sessionId: r.sessionId, storeMtimeMs: tail.mtimeMs, tailTimestampMs: t.ts, tailKind: t.kind };
}

export interface CodexDb {
  prepare: (sql: string) => { get: (...args: never[]) => unknown };
  close: () => void;
}

export interface CodexRoots {
  stateDbPath: string;
  sessionId: string | null;
  openDb: (path: string) => CodexDb | null;
  rolloutTail: (path: string) => { entry: Record<string, unknown>; mtimeMs: number } | null;
}

/** `state_5.sqlite` threads row (updated_at_ms/recency_at_ms) + rollout tail. */
export function codexFingerprint(r: CodexRoots): TurnFingerprint | null {
  if (!r.sessionId) return null;
  let db: CodexDb | null = null;
  try {
    db = r.openDb(r.stateDbPath);
    if (!db) return null;
    const row = db.prepare(
      "SELECT updated_at_ms, recency_at_ms, rollout_path FROM threads WHERE id = ?",
    ).get(r.sessionId as never) as { updated_at_ms?: unknown; recency_at_ms?: unknown; rollout_path?: unknown } | undefined;
    if (!row) return null;
    const dbMtime = Math.max(
      typeof row.updated_at_ms === "number" ? row.updated_at_ms : -1,
      typeof row.recency_at_ms === "number" ? row.recency_at_ms : -1,
    );
    let tailTs: number | null = null;
    let tailKind: string | null = null;
    let fileMtime = -1;
    if (typeof row.rollout_path === "string") {
      const tail = r.rolloutTail(row.rollout_path);
      if (tail) {
        const t = tailOf(tail.entry);
        tailTs = t.ts;
        tailKind = t.kind;
        fileMtime = tail.mtimeMs;
      }
    }
    const mtime = Math.max(dbMtime, fileMtime);
    return mtime < 0 ? null : { sessionId: r.sessionId, storeMtimeMs: mtime, tailTimestampMs: tailTs, tailKind };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

export interface KiroKasRoots { kiroHome: string; bucket: string; sessionId: string | null }

/** KAS `<home>/sessions/<bucket>/<id>/{session.json, messages.jsonl}`. */
export function kiroKasFingerprint(r: KiroKasRoots): TurnFingerprint | null {
  if (!r.sessionId) return null;
  const dir = join(r.kiroHome, "sessions", r.bucket, r.sessionId);
  try {
    const meta = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as Record<string, unknown>;
    const instants = [asInstant(meta.lastModifiedAt), asInstant(meta.createdAt)].filter((v): v is number => v !== null);
    let mtime = instants.length ? Math.max(...instants) : -1;
    let tailTs: number | null = null;
    const tail = readJsonlTail(join(dir, "messages.jsonl"));
    if (tail) {
      tailTs = tailOf(tail.entry).ts;
      mtime = Math.max(mtime, tail.mtimeMs);
    } else {
      // messages.jsonl may be absent for a fresh session; session.json's own mtime still counts.
      try { mtime = Math.max(mtime, statSync(join(dir, "session.json")).mtimeMs); } catch { /* keep instants */ }
    }
    return mtime < 0 ? null : { sessionId: r.sessionId, storeMtimeMs: mtime, tailTimestampMs: tailTs, tailKind: null };
  } catch {
    return null;
  }
}

export interface MuseRoots { sessionsRoot: string; cwd: string; sessionId: string | null }

/** Walk `<root>/<YYYY>/<MM>/<DD>/<sessionId>/` like MuseBackend.getSessionId does. */
export function museFingerprint(r: MuseRoots): TurnFingerprint | null {
  if (!r.sessionId) return null;
  const found = findMuseSessionDir(r.sessionsRoot, r.sessionId);
  if (!found) return null;
  let activity = -1;
  try {
    for (const f of readdirSync(found)) {
      try {
        const m = statSync(join(found, f)).mtimeMs;
        if (m > activity) activity = m;
      } catch { /* raced */ }
    }
  } catch {
    return null;
  }
  if (activity < 0) return null;
  const tail = readJsonlTail(join(found, "session.jsonl"));
  const t = tail ? tailOf(tail.entry) : { ts: null, kind: null };
  return { sessionId: r.sessionId, storeMtimeMs: activity, tailTimestampMs: t.ts, tailKind: t.kind };
}

function findMuseSessionDir(root: string, sessionId: string, depth = 0): string | null {
  if (depth > 4) return null;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }
  if (entries.includes(sessionId)) {
    const p = join(root, sessionId);
    try { if (existsSync(join(p, "session.jsonl"))) return p; } catch { /* not it */ }
  }
  for (const e of entries) {
    if (e === sessionId) continue;
    const hit = findMuseSessionDir(join(root, e), sessionId, depth + 1);
    if (hit) return hit;
  }
  return null;
}
