import { measureSyncWork } from "./sync-work-attribution.js";
/**
 * Per-backend tool-event sources for the transcript monitor.
 *
 * claude-code keeps its transcript path in statusline.json and is handled
 * inside TranscriptMonitor itself (it predates this file). The sources here
 * cover backends whose CLIs persist their conversation elsewhere:
 *
 *   codex     — rollout JSONL under <codex home>/sessions/YYYY/MM/DD/,
 *               matched to this instance by session_meta.cwd (sessions are a
 *               shared symlinked dir across instances, #507)
 *   kiro-cli  — primary sessions in ~/.local/share/kiro-cli/data.sqlite3
 *               (Kiro 2.19+), with ~/.kiro/sessions/cli JSONL fallback for
 *               older releases
 *   opencode  — $XDG_DATA_HOME/opencode/opencode.db `part` table rows of
 *               data JSON { type: "tool", tool, state.input }, matched by the
 *               `session` table's directory column
 *
 * Common rules, learned the hard way (#528 traps):
 *   - No persisted byte offsets. Codex writes a fresh rollout per process and
 *     kiro/opencode keep full history — a stale offset is meaningless at best
 *     and replays history at worst.
 *   - First attach to a PRE-EXISTING transcript baselines to its end: only
 *     new work emits. A transcript that APPEARS after the source was created
 *     is this instance's own new session and is read from the start.
 *   - Every poll re-resolves which transcript is active. Pinning to the first
 *     one found silently goes blind when the CLI starts a new session.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sharedRolloutIndex, type RolloutIndex } from "./rollout-index.js";
import Database from "better-sqlite3";
import { sharedKiroTranscriptLane, type KiroDbLane, type KiroDbLease } from "./kiro-transcript-lane.js";
import type { KiroDbCursor } from "./kiro-db-reader.js";
export { extractKiroAssistantStrings } from "./kiro-db-reader.js";
import { lastLineBoundary, readNewLines } from "./transcript-jsonl.js";

export interface ToolUseEvent { name: string; input: unknown }

export interface TranscriptEvents {
  toolUses: ToolUseEvent[];
  toolResults: Array<{ name: string }>;
  assistantTexts: string[];
}

export interface TranscriptCheckpoint {
  path: string;
  offset: number;
  /** Stable path/session identifier used to reject a different rollout. */
  sessionId: string;
}

export interface TranscriptSource {
  /** Read events that appeared since the previous call. Invoked serially. */
  poll(): Promise<TranscriptEvents>;
  /** Asynchronous baseline barrier, awaited before startup becomes accepting. */
  initialize?(): Promise<void>;
  /** Forget the current position; the next poll re-resolves and re-baselines. */
  reset(): void;
  /** Optional durable-delivery checkpoint taken immediately before pane paste. */
  checkpoint?(): Promise<TranscriptCheckpoint | null>;
  /** Release anything held between polls; the next poll may acquire it again. */
  close?(): void;
}

const EMPTY: TranscriptEvents = { toolUses: [], toolResults: [], assistantTexts: [] };

function emptyEvents(): TranscriptEvents {
  return { toolUses: [], toolResults: [], assistantTexts: [] };
}

/* ------------------------------------------------------------------ codex */

/**
 * Follows the newest rollout JSONL whose session_meta.cwd matches this
 * instance's working directory. Rollouts are date-sharded and shared across
 * instances, so cwd is the only reliable ownership signal.
 */
export class CodexRolloutSource implements TranscriptSource {
  private currentFile: string | null = null;
  private byteOffset = 0;
  /** EOF snapshots taken when the monitor attaches; existing history is skipped. */
  private initialOffsets = new Map<string, number>();
  /** Files whose session_meta was read and did NOT match our cwd. */
  private rejected = new Set<string>();
  /**
   * Files whose session_meta WAS read and matches our cwd. The first line of a rollout
   * never changes, so this verdict is as final as a rejection: re-reading a 64 KiB head
   * of the active file on every poll bought nothing (#1161).
   */
  private accepted = new Set<string>();
  private readonly index: RolloutIndex;

  constructor(
    private workingDirectory: string,
    private sessionsDir = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions"),
    _now = Date.now(),
    index?: RolloutIndex,
  ) {
    this.index = index ?? sharedRolloutIndex(sessionsDir);
    this.snapshotExistingFiles();
  }

  reset(): void {
    this.currentFile = null;
    this.byteOffset = 0;
    this.rejected.clear();
    this.accepted.clear();
    this.snapshotExistingFiles();
  }

  async checkpoint(): Promise<TranscriptCheckpoint | null> {
    const active = this.candidateFiles(true).find(file => this.fileBelongsToUs(file.path));
    if (!active) return null;
    try {
      // A line boundary, not the size: a record being written now is read once complete (#1250).
      const offset = await lastLineBoundary(active.path);
      this.currentFile = active.path;
      this.byteOffset = offset;
      return { path: active.path, offset, sessionId: active.path };
    } catch {
      return null;
    }
  }

  private snapshotExistingFiles(): void {
    this.initialOffsets = new Map(this.candidateFiles(true).map(file => [file.path, file.size]));
  }

  /**
   * Newest rollout files first.
   *
   * A resumed Codex session keeps writing to the date shard where it was first
   * created. Limiting discovery to today's/yesterday's directories therefore
   * makes a long-lived instance silently disappear from tool progress, so every
   * shard is considered. That tree only ever grows and every Codex instance reads
   * it, so the listing comes from one shared, incrementally refreshed index
   * (rollout-index.ts) instead of a private walk per instance per poll (#1161).
   * Baselines and checkpoints ask for a fresh listing; the 2 s poll takes the shared one.
   */
  private candidateFiles(fresh = false): readonly { path: string; mtimeMs: number; size: number }[] {
    return this.index.list(fresh);
  }

  private fileBelongsToUs(path: string): boolean {
    if (this.rejected.has(path)) return false;
    if (this.accepted.has(path)) return true;
    try {
      // session_meta is the first line. It can carry long instructions, so
      // give it headroom — but never read the whole rollout.
      const fd = openSync(path, "r");
      let head: string;
      try {
        const buf = Buffer.alloc(65536);
        const bytes = readSync(fd, buf, 0, buf.length, 0);
        head = buf.toString("utf-8", 0, bytes);
      } finally {
        closeSync(fd);
      }
      const firstLine = head.split("\n")[0];
      const meta = JSON.parse(firstLine);
      const cwd = meta?.payload?.cwd;
      if (meta?.type === "session_meta" && cwd === this.workingDirectory) {
        this.accepted.add(path);
        return true;
      }
      this.rejected.add(path);
      return false;
    } catch {
      // First line unreadable/partial — retry next poll, do not cache the verdict.
      return false;
    }
  }

  async poll(): Promise<TranscriptEvents> {
    // Re-resolve every poll: a restarted codex writes a NEW rollout, and
    // staying pinned to the old one goes silently blind (#528 trap 1).
    const candidates = this.candidateFiles();
    const active = candidates.find(c => this.fileBelongsToUs(c.path));
    if (!active) return EMPTY;

    if (active.path !== this.currentFile) {
      // Existing rollout: continue at the EOF captured when the source was
      // created. New rollout: read from the start. Using current mtime here is
      // wrong because appending to a resumed rollout makes an old file look new.
      // The captured size is anchored to its last line boundary (#1250): a record mid-write at creation is kept.
      // Only an anchor that succeeded is committed (#1283 review): if the boundary cannot be read now, nothing is
      // adopted and the next poll tries again from the same captured size — never the raw size, mid-record.
      const captured = this.initialOffsets.get(active.path);
      let offset = 0;
      if (captured !== undefined) {
        try { offset = await lastLineBoundary(active.path, captured); } catch { return EMPTY; }
      }
      this.currentFile = active.path;
      this.byteOffset = offset;
    }

    const { lines, newOffset } = await readNewLines(this.currentFile, this.byteOffset);
    this.byteOffset = newOffset;

    const events = emptyEvents();
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "response_item") continue;
      const p = entry.payload as Record<string, unknown> | undefined;
      if (!p) continue;
      if (p.type === "function_call") {
        let input: unknown = p.arguments;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* keep raw */ } }
        events.toolUses.push({ name: String(p.name ?? "unknown"), input });
      } else if (p.type === "custom_tool_call") {
        events.toolUses.push({ name: String(p.name ?? "unknown"), input: p.input });
      } else if (p.type === "local_shell_call") {
        const action = p.action as Record<string, unknown> | undefined;
        events.toolUses.push({ name: "shell", input: { command: action?.command } });
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        events.toolResults.push({ name: String(p.name ?? "unknown") });
      } else if (p.type === "message" && p.role === "assistant") {
        const content = p.content as Array<Record<string, unknown>> | undefined;
        for (const block of content ?? []) {
          const text = block.text;
          if (typeof text === "string" && text.trim()) events.assistantTexts.push(text);
        }
      }
    }
    return events;
  }
}

/* -------------------------------------------------------------------- kiro */

/**
 * The conversation database for one kiro store.
 *
 * With no store given this is the shared login's, exactly as before. A
 * credential profile has its own store and therefore its own conversations —
 * they are tables in the same file as the login, so an instance on a profile
 * writes its transcript somewhere this reader would never have looked.
 */
export function kiroStoreDbPath(storeHome?: string): string {
  const home = storeHome
    ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kiro-cli");
  return join(home, "data.sqlite3");
}

export interface KiroConversation {
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  /** Length of the stored value — part of the change signature. */
  size: number;
  /** Null when the row exists but its history is missing or unparseable. */
  history: unknown[] | null;
}

export function kiroWorkingDirectoryKeys(workingDirectory: string): string[] {
  const keys = new Set([workingDirectory, resolve(workingDirectory)]);
  try { keys.add(realpathSync(workingDirectory)); } catch { /* keep literal/absolute cwd */ }
  return [...keys];
}

/**
 * Discriminated read of the newest kiro conversation for a working directory.
 * Shared by the live monitor and the #995 forged-envelope scanner so both
 * resolve "this instance's conversation" the same way — and so a safety scan
 * can tell "no conversation" apart from "could not read the store" (#1007).
 */
export type KiroConversationRead =
  | { status: "ok"; conversation: KiroConversation }
  | { status: "no-row" }
  | { status: "error"; reason: string };

export function readKiroConversationStatus(
  dbPath: string,
  workingDirectory: string,
  /** False = metadata only (no value read, no JSON parse): the poll fast path. */
  includeHistory = true,
): KiroConversationRead {
  return measureSyncWork("kiro.conversationStatus", () => readKiroConversationStatusSync(dbPath, workingDirectory, includeHistory));
}
function readKiroConversationStatusSync(
  dbPath: string,
  workingDirectory: string,
  /** False = metadata only (no value read, no JSON parse): the poll fast path. */
  includeHistory = true,
): KiroConversationRead {
  if (!existsSync(dbPath)) return { status: "error", reason: `kiro store not found: ${dbPath}` };
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const keys = kiroWorkingDirectoryKeys(workingDirectory);
    const placeholders = keys.map(() => "?").join(", ");
    // Metadata first: length(value) sizes the change signature without
    // reading or parsing the (growing) transcript on every poll.
    const row = db.prepare(
      `SELECT conversation_id, created_at, updated_at, length(value) AS size
         ${includeHistory ? ", value" : ""}
       FROM conversations_v2 WHERE key IN (${placeholders})
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(...keys) as {
      conversation_id: string; created_at: number; updated_at: number; size: number; value?: string;
    } | undefined;
    if (!row) return { status: "no-row" };
    let history: unknown[] | null = null;
    if (includeHistory) {
      try {
        const parsed = JSON.parse(row.value ?? "") as { history?: unknown };
        history = Array.isArray(parsed.history) ? parsed.history : null;
      } catch { history = null; }
    }
    return {
      status: "ok",
      conversation: {
        conversationId: row.conversation_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        size: row.size,
        history,
      },
    };
  } catch (err) {
    return { status: "error", reason: (err as Error).message };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * Follows the newest Kiro conversation whose cwd matches this instance.
 * Kiro 2.19 moved primary conversations to conversations_v2 in data.sqlite3;
 * legacy releases use <uuid>.jsonl plus sibling <uuid>.json metadata.
 */
export class KiroSessionSource implements TranscriptSource {
  private currentFile: string | null = null;
  private byteOffset = 0;
  private readonly createdAt: number;
  private generation = 0;
  private cursor: KiroDbCursor | undefined;
  private lease: KiroDbLease | null = null;
  private ready: Promise<void> | null = null;
  private needsBaseline = true;

  constructor(
    private workingDirectory: string,
    private sessionsDir = join(homedir(), ".kiro", "sessions", "cli"),
    now = Date.now(),
    private dbPath = kiroStoreDbPath(),
    private lane: KiroDbLane = sharedKiroTranscriptLane,
  ) {
    this.createdAt = now;
    void this.initialize();
  }
  initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.lease ??= this.lane.acquire();
    const lease = this.lease, generation = this.generation;
    if (!this.needsBaseline) return Promise.resolve();
    this.ready = lease.read({ workingDirectory: this.workingDirectory, dbPath: this.dbPath, createdAt: this.createdAt, baseline: true }).then(reply => {
      if (generation !== this.generation || this.lease !== lease) return;
      this.cursor = reply?.cursor;
      this.needsBaseline = false;
    });
    return this.ready;
  }
  reset(): void {
    this.close();
    this.currentFile = null;
    this.byteOffset = 0;
    this.cursor = undefined;
    this.needsBaseline = true;
    void this.initialize();
  }
  close(): void {
    this.generation++;
    this.lease?.close();
    this.lease = null;
    this.ready = null;
  }
  private async pollDb(): Promise<TranscriptEvents | null> {
    const generation = this.generation;
    await this.initialize();
    if (generation !== this.generation || !this.lease) return EMPTY;
    const lease = this.lease;
    const reply = await lease.read({ workingDirectory: this.workingDirectory, dbPath: this.dbPath, createdAt: this.createdAt, baseline: false, cursor: this.cursor });
    if (generation !== this.generation || this.lease !== lease) return EMPTY;
    if (!reply) return null;
    this.cursor = reply.cursor;
    return reply.events;
  }

  /**
   * What each session's metadata said, keyed by file and valid for the mtime/size it was
   * read at (#1161): the fallback used to re-read and re-parse EVERY session's JSON on every
   * 2 s poll, for every instance; now an unchanged file costs one stat.
   * `null` = the file does not concern us (another cwd, or a subagent child).
   */
  private metaCache = new Map<string, { mtimeMs: number; size: number; meta: { updated: number; created: number } | null }>();

  private resolveActiveSession(): { jsonlPath: string; createdAtMs: number } | null {
    let entries: string[];
    try { entries = readdirSync(this.sessionsDir); } catch { return null; }
    let best: { jsonlPath: string; updated: number; createdAtMs: number } | null = null;
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e.endsWith(".json") || e.endsWith(".jsonl")) continue;
      const metaPath = join(this.sessionsDir, e);
      seen.add(metaPath);
      try {
        const st = statSync(metaPath);
        let cached = this.metaCache.get(metaPath);
        if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          // Subagent sessions are children of a turn already being reported.
          const ours = meta.cwd === this.workingDirectory && meta.session_created_reason !== "subagent";
          cached = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            meta: ours
              ? { updated: Date.parse(meta.updated_at ?? "") || 0, created: Date.parse(meta.created_at ?? "") || 0 }
              : null,
          };
          this.metaCache.set(metaPath, cached);
        }
        if (!cached.meta) continue;
        if (!best || cached.meta.updated > best.updated) {
          const jsonlPath = join(this.sessionsDir, e.replace(/\.json$/, ".jsonl"));
          best = { jsonlPath, updated: cached.meta.updated, createdAtMs: cached.meta.created };
        }
      } catch { /* partially written metadata — next poll */ }
    }
    for (const known of this.metaCache.keys()) if (!seen.has(known)) this.metaCache.delete(known);
    return best && existsSync(best.jsonlPath)
      ? { jsonlPath: best.jsonlPath, createdAtMs: best.createdAtMs }
      : null;
  }

  async poll(): Promise<TranscriptEvents> {
    // Current Kiro stores the primary session in SQLite; JSONL is now mostly
    // used for subagents. Keep the legacy path as a compatibility fallback.
    const generation = this.generation;
    const dbEvents = await this.pollDb();
    if (generation !== this.generation) return EMPTY;
    if (dbEvents !== null) return dbEvents;

    const active = this.resolveActiveSession();
    if (!active) return EMPTY;

    if (active.jsonlPath !== this.currentFile) {
      if (active.createdAtMs >= this.createdAt) {
        this.currentFile = active.jsonlPath;
        this.byteOffset = 0; // our own fresh session — observable from the start
      } else {
        // An older session is attached at its last line boundary. If that cannot be read now, nothing is adopted
        // and the next poll tries again (#1283 review) — never offset 0, which would replay the whole session.
        let offset: number;
        try { offset = await lastLineBoundary(active.jsonlPath); } catch { return EMPTY; }
        if (generation !== this.generation) return EMPTY;
        this.currentFile = active.jsonlPath;
        this.byteOffset = offset;
        return EMPTY;
      }
    }

    const { lines, newOffset } = await readNewLines(this.currentFile, this.byteOffset);
    if (generation !== this.generation) return EMPTY;
    this.byteOffset = newOffset;

    const events = emptyEvents();
    for (const line of lines) {
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      collectKiroEvents(entry, events);
    }
    return events;
  }
}

/**
 * Kiro nests { kind: "toolUse", data: { name, input } } blocks inside
 * AssistantMessage content; exact nesting has shifted across kiro versions,
 * so walk the tree for the kind markers instead of hardcoding a path.
 */
function collectKiroEvents(node: unknown, out: TranscriptEvents, depth = 0): void {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectKiroEvents(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.kind === "toolUse" && obj.data && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    out.toolUses.push({ name: String(d.name ?? "unknown"), input: d.input });
    return;
  }
  if (obj.kind === "toolResult" && obj.data && typeof obj.data === "object") {
    out.toolResults.push({ name: "toolResult" });
    return;
  }
  for (const value of Object.values(obj)) collectKiroEvents(value, out, depth + 1);
}

/* ---------------------------------------------------------------- opencode */

interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
    close(): void;
  };
}

function loadSqlite(): SqliteModule | undefined {
  try {
    return (process as { getBuiltinModule?: (id: string) => unknown })
      .getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
  } catch { return undefined; }
}

/**
 * Reads tool parts from opencode's sqlite DB for the newest top-level
 * session in this instance's working directory. Rows are cursored by
 * time_created, which is immutable — a part that later flips from `running`
 * to `completed` only changes time_updated, so each tool use emits once.
 *
 * Requires node:sqlite (Node ≥22.13); silently inert otherwise, matching the
 * session-resume feature's degradation.
 */
export class OpenCodeDbSource implements TranscriptSource {
  private sessionId: string | null = null;
  private partCursor = 0;
  private readonly createdAt: number;

  constructor(
    private workingDirectory: string,
    private dbPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db"),
    now = Date.now(),
  ) {
    this.createdAt = now;
  }

  reset(): void {
    this.sessionId = null;
    this.partCursor = 0;
  }

  async poll(): Promise<TranscriptEvents> {
    const sqlite = loadSqlite();
    if (!sqlite || !existsSync(this.dbPath)) return EMPTY;
    let db: InstanceType<SqliteModule["DatabaseSync"]>;
    try {
      db = new sqlite.DatabaseSync(this.dbPath, { readOnly: true });
    } catch { return EMPTY; }
    try {
      const session = db.prepare(
        "SELECT id, time_created FROM session WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 1",
      ).get(this.workingDirectory) as { id: string; time_created: number } | undefined;
      if (!session) return EMPTY;

      if (session.id !== this.sessionId) {
        this.sessionId = session.id;
        // Fresh session started under us → report from its beginning;
        // pre-existing session → only new parts.
        this.partCursor = session.time_created >= this.createdAt ? 0 : Date.now();
      }

      const rows = db.prepare(
        "SELECT data, time_created FROM part WHERE session_id = ? AND time_created > ? ORDER BY time_created ASC LIMIT 100",
      ).all(this.sessionId, this.partCursor) as Array<{ data: string; time_created: number }>;

      const events = emptyEvents();
      for (const row of rows) {
        this.partCursor = Math.max(this.partCursor, row.time_created);
        let data: Record<string, unknown>;
        try { data = JSON.parse(row.data); } catch { continue; }
        if (data.type === "tool") {
          const state = data.state as Record<string, unknown> | undefined;
          events.toolUses.push({ name: String(data.tool ?? "unknown"), input: state?.input });
        } else if (data.type === "text") {
          const text = data.text;
          if (typeof text === "string" && text.trim()) events.assistantTexts.push(text);
        }
      }
      return events;
    } catch {
      return EMPTY;
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

/* ----------------------------------------------------------------- factory */

/**
 * Source for a backend, or null for backends handled elsewhere (claude-code
 * lives inside TranscriptMonitor) and backends with no known source
 * (antigravity — nothing usable found on disk; grok has
 * events.jsonl with tool names only and can be added later).
 */
export function createTranscriptSource(
  backend: string,
  workingDirectory: string,
  /** The credential profile's store, when this instance runs on one. */
  storeHome?: string,
): TranscriptSource | null {
  switch (backend) {
    case "codex": return new CodexRolloutSource(workingDirectory);
    // undefined keeps each parameter's own default; only the store moves.
    case "kiro-cli": return new KiroSessionSource(workingDirectory, undefined, undefined, kiroStoreDbPath(storeHome));
    case "opencode": return new OpenCodeDbSource(workingDirectory);
    default: return null;
  }
}
