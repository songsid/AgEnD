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
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

export interface ToolUseEvent { name: string; input: unknown }

export interface TranscriptEvents {
  toolUses: ToolUseEvent[];
  toolResults: Array<{ name: string }>;
  assistantTexts: string[];
}

export interface TranscriptSource {
  /** Read events that appeared since the previous call. Invoked serially. */
  poll(): Promise<TranscriptEvents>;
  /** Forget the current position; the next poll re-resolves and re-baselines. */
  reset(): void;
}

const EMPTY: TranscriptEvents = { toolUses: [], toolResults: [], assistantTexts: [] };

function emptyEvents(): TranscriptEvents {
  return { toolUses: [], toolResults: [], assistantTexts: [] };
}

/** Shared JSONL tailer: byte-offset incremental reads of a single file. */
async function readNewLines(path: string, fromOffset: number): Promise<{ lines: string[]; newOffset: number }> {
  const stats = await stat(path);
  if (stats.size <= fromOffset) return { lines: [], newOffset: fromOffset };
  const fh = await open(path, "r");
  try {
    const length = stats.size - fromOffset;
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, fromOffset);
    return { lines: buffer.toString("utf-8").split("\n").filter(l => l.trim()), newOffset: stats.size };
  } finally {
    await fh.close();
  }
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

  constructor(
    private workingDirectory: string,
    private sessionsDir = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions"),
    _now = Date.now(),
  ) {
    this.snapshotExistingFiles();
  }

  reset(): void {
    this.currentFile = null;
    this.byteOffset = 0;
    this.rejected.clear();
    this.snapshotExistingFiles();
  }

  private snapshotExistingFiles(): void {
    this.initialOffsets = new Map(this.candidateFiles().map(file => [file.path, file.size]));
  }

  /**
   * Newest rollout files first.
   *
   * A resumed Codex session keeps writing to the date shard where it was first
   * created. Limiting discovery to today's/yesterday's directories therefore
   * makes a long-lived instance silently disappear from tool progress. There
   * are normally only tens of rollout files, and rejected cwd matches are
   * cached, so walking all shards is both correct and cheap.
   */
  private candidateFiles(): Array<{ path: string; mtimeMs: number; size: number }> {
    const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
    const walk = (dir: string, depth: number): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e);
        try {
          const st = statSync(p);
          if (st.isDirectory() && depth < 4) walk(p, depth + 1);
          else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) {
            out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch { /* raced with deletion */ }
      }
    };
    walk(this.sessionsDir, 0);
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private fileBelongsToUs(path: string): boolean {
    if (this.rejected.has(path)) return false;
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
      if (meta?.type === "session_meta" && cwd === this.workingDirectory) return true;
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
      this.currentFile = active.path;
      // Existing rollout: continue at the EOF captured when the source was
      // created. New rollout: read from the start. Using current mtime here is
      // wrong because appending to a resumed rollout makes an old file look new.
      this.byteOffset = this.initialOffsets.get(active.path) ?? 0;
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
 * Follows the newest Kiro conversation whose cwd matches this instance.
 * Kiro 2.19 moved primary conversations to conversations_v2 in data.sqlite3;
 * legacy releases use <uuid>.jsonl plus sibling <uuid>.json metadata.
 */
export class KiroSessionSource implements TranscriptSource {
  private currentFile: string | null = null;
  private byteOffset = 0;
  private readonly createdAt: number;
  private dbConversationId: string | null = null;
  private dbHistoryCursor = 0;
  private dbSignature = "";
  private dbToolNames = new Map<string, string>();

  constructor(
    private workingDirectory: string,
    private sessionsDir = join(homedir(), ".kiro", "sessions", "cli"),
    now = Date.now(),
    private dbPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kiro-cli", "data.sqlite3"),
  ) {
    this.createdAt = now;
    this.snapshotDbBaseline();
  }

  reset(): void {
    this.currentFile = null;
    this.byteOffset = 0;
    this.dbConversationId = null;
    this.dbHistoryCursor = 0;
    this.dbSignature = "";
    this.dbToolNames.clear();
    this.snapshotDbBaseline();
  }

  private workingDirectoryKeys(): string[] {
    const keys = new Set([this.workingDirectory, resolve(this.workingDirectory)]);
    try { keys.add(realpathSync(this.workingDirectory)); } catch { /* keep literal/absolute cwd */ }
    return [...keys];
  }

  private newestDbRow(db: Database.Database): { conversation_id: string; created_at: number; updated_at: number; size: number; value?: string } | undefined {
    const keys = this.workingDirectoryKeys();
    const placeholders = keys.map(() => "?").join(", ");
    return db.prepare(
      `SELECT conversation_id, created_at, updated_at, length(value) AS size
       FROM conversations_v2 WHERE key IN (${placeholders})
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(...keys) as { conversation_id: string; created_at: number; updated_at: number; size: number } | undefined;
  }

  private readDbHistory(db: Database.Database, conversationId: string): unknown[] | null {
    const row = db.prepare(
      "SELECT value FROM conversations_v2 WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(conversationId) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { history?: unknown };
      return Array.isArray(parsed.history) ? parsed.history : [];
    } catch { return null; }
  }

  /**
   * Kiro 2.19 moved primary conversations into data.sqlite3. Snapshot the
   * active row synchronously at monitor creation so its existing history is
   * never replayed as live tool progress.
   */
  private snapshotDbBaseline(): void {
    if (!existsSync(this.dbPath)) return;
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      const row = this.newestDbRow(db);
      if (!row) return;
      const history = this.readDbHistory(db, row.conversation_id);
      if (!history) return;
      this.dbConversationId = row.conversation_id;
      this.dbHistoryCursor = history.length;
      this.dbSignature = `${row.updated_at}:${row.size}`;
    } catch { /* old Kiro schema or busy DB — legacy JSONL remains available */ }
    finally { try { db?.close(); } catch { /* already closed */ } }
  }

  private pollDb(): TranscriptEvents | null {
    if (!existsSync(this.dbPath)) return null;
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      const row = this.newestDbRow(db);
      if (!row) return null;
      const signature = `${row.updated_at}:${row.size}`;
      if (row.conversation_id === this.dbConversationId && signature === this.dbSignature) return EMPTY;

      const history = this.readDbHistory(db, row.conversation_id);
      if (!history) return EMPTY;
      if (row.conversation_id !== this.dbConversationId) {
        this.dbConversationId = row.conversation_id;
        this.dbToolNames.clear();
        // A conversation created after this monitor belongs to this daemon;
        // an older conversation selected by --resume is history to baseline.
        this.dbHistoryCursor = row.created_at >= this.createdAt ? 0 : history.length;
      }
      if (history.length < this.dbHistoryCursor) {
        // Compaction can replace history with a shorter summary. Treat the new
        // compacted body as a baseline instead of waiting for it to grow past
        // the old cursor (or replaying retained history).
        this.dbHistoryCursor = history.length;
        this.dbSignature = signature;
        return EMPTY;
      }
      const events = emptyEvents();
      for (const entry of history.slice(this.dbHistoryCursor)) {
        collectKiroDbEvents(entry, events, this.dbToolNames);
      }
      this.dbHistoryCursor = history.length;
      this.dbSignature = signature;
      return events;
    } catch {
      return null;
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  private resolveActiveSession(): { jsonlPath: string; createdAtMs: number } | null {
    let entries: string[];
    try { entries = readdirSync(this.sessionsDir); } catch { return null; }
    let best: { jsonlPath: string; updated: number; createdAtMs: number } | null = null;
    for (const e of entries) {
      if (!e.endsWith(".json") || e.endsWith(".jsonl")) continue;
      const metaPath = join(this.sessionsDir, e);
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (meta.cwd !== this.workingDirectory) continue;
        // Subagent sessions are children of a turn already being reported.
        if (meta.session_created_reason === "subagent") continue;
        const updated = Date.parse(meta.updated_at ?? "") || 0;
        const created = Date.parse(meta.created_at ?? "") || 0;
        if (!best || updated > best.updated) {
          const jsonlPath = join(this.sessionsDir, e.replace(/\.json$/, ".jsonl"));
          best = { jsonlPath, updated, createdAtMs: created };
        }
      } catch { /* partially written metadata — next poll */ }
    }
    return best && existsSync(best.jsonlPath)
      ? { jsonlPath: best.jsonlPath, createdAtMs: best.createdAtMs }
      : null;
  }

  async poll(): Promise<TranscriptEvents> {
    // Current Kiro stores the primary session in SQLite; JSONL is now mostly
    // used for subagents. Keep the legacy path as a compatibility fallback.
    const dbEvents = this.pollDb();
    if (dbEvents !== null) return dbEvents;

    const active = this.resolveActiveSession();
    if (!active) return EMPTY;

    if (active.jsonlPath !== this.currentFile) {
      this.currentFile = active.jsonlPath;
      if (active.createdAtMs >= this.createdAt) {
        this.byteOffset = 0; // our own fresh session — observable from the start
      } else {
        try { this.byteOffset = (await stat(active.jsonlPath)).size; } catch { this.byteOffset = 0; }
        return EMPTY;
      }
    }

    const { lines, newOffset } = await readNewLines(this.currentFile, this.byteOffset);
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

function collectKiroDbEvents(entry: unknown, out: TranscriptEvents, toolNames: Map<string, string>): void {
  if (!entry || typeof entry !== "object") return;
  const record = entry as Record<string, unknown>;
  const assistant = record.assistant as Record<string, unknown> | undefined;
  const toolUse = assistant?.ToolUse as Record<string, unknown> | undefined;
  const uses = toolUse?.tool_uses;
  if (Array.isArray(uses)) {
    for (const raw of uses) {
      if (!raw || typeof raw !== "object") continue;
      const use = raw as Record<string, unknown>;
      const name = String(use.name ?? use.orig_name ?? "unknown");
      const id = typeof use.id === "string" ? use.id : undefined;
      if (id) toolNames.set(id, name);
      out.toolUses.push({ name, input: use.args ?? use.orig_args });
    }
  }

  const user = record.user as Record<string, unknown> | undefined;
  const content = user?.content as Record<string, unknown> | undefined;
  const resultsContainer = content?.ToolUseResults as Record<string, unknown> | undefined;
  const results = resultsContainer?.tool_use_results;
  if (Array.isArray(results)) {
    for (const raw of results) {
      if (!raw || typeof raw !== "object") continue;
      const result = raw as Record<string, unknown>;
      const id = typeof result.tool_use_id === "string" ? result.tool_use_id : "";
      out.toolResults.push({ name: toolNames.get(id) ?? "toolResult" });
    }
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
 * (antigravity, gemini-cli — nothing usable found on disk; grok has
 * events.jsonl with tool names only and can be added later).
 */
export function createTranscriptSource(
  backend: string,
  workingDirectory: string,
): TranscriptSource | null {
  switch (backend) {
    case "codex": return new CodexRolloutSource(workingDirectory);
    case "kiro-cli": return new KiroSessionSource(workingDirectory);
    case "opencode": return new OpenCodeDbSource(workingDirectory);
    default: return null;
  }
}
