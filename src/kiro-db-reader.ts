/** SQLite and large JSON work runs only in the transcript isolate. */
import Database from "better-sqlite3";
import { statSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { TranscriptEvents } from "./transcript-sources.js";
const EMPTY: TranscriptEvents = { toolUses: [], toolResults: [], assistantTexts: [] };
const emptyEvents = (): TranscriptEvents => ({ toolUses: [], toolResults: [], assistantTexts: [] });
export interface KiroDbCursor { conversationId: string | null; historyCursor: number; signature: string; toolNames: Array<[string, string]>; }
export class KiroDbReader {
  private readonly createdAt: number;
  private dbConversationId: string | null = null;
  private dbHistoryCursor = 0;
  private dbSignature = "";
  private dbToolNames = new Map<string, string>();
  /**
   * One read-only handle for the life of the poll loop (#1048). Kiro's store
   * is one database for every conversation — ~1 GB on a lived-in machine —
   * and opening it per poll, for every kiro instance every 2 s, ran on the
   * fleet's event loop.
   */
  private db: Database.Database | null = null;
  /** The store file the handle was opened on; a replaced file is reopened. */
  private dbIno = 0;
  private newestRowStmt: Database.Statement | null = null;
  private historyStmt: Database.Statement | null = null;
  private createdAtStmt: Database.Statement | null = null;

  constructor(private workingDirectory: string, private dbPath: string, now = Date.now(), baseline = true) {
    this.createdAt = now;
    if (baseline) this.snapshotDbBaseline();
  }

  reset(): void {
    this.close();
    this.dbKeys = null;
    this.dbConversationId = null;
    this.dbHistoryCursor = 0;
    this.dbSignature = "";
    this.dbToolNames.clear();
    this.snapshotDbBaseline();
  }

  /** Resolved once per baseline: realpath is a syscall, and this runs every poll. */
  private dbKeys: string[] | null = null;
  private workingDirectoryKeys(): string[] {
    if (this.dbKeys) return this.dbKeys;
    const keys = new Set([this.workingDirectory, resolve(this.workingDirectory)]);
    try { keys.add(realpathSync(this.workingDirectory)); } catch { /* keep literal/absolute cwd */ }
    this.dbKeys = [...keys];
    return this.dbKeys;
  }

  close(): void {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
    this.newestRowStmt = null;
    this.historyStmt = null;
    this.createdAtStmt = null;
  }

  /** The shared handle, opened on first use; null while the store is absent. */
  private openDb(): Database.Database | null {
    let ino: number;
    try { ino = statSync(this.dbPath).ino; } catch { this.close(); return null; }
    // A handle keeps reading the file it opened: if kiro replaced the store,
    // that is a stale copy that never errors, so follow the path instead.
    if (this.db && ino === this.dbIno) return this.db;
    this.close();
    this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    this.dbIno = ino;
    return this.db;
  }

  /**
   * The newest conversation for this workspace and its change signal. The
   * size is `octet_length`, which SQLite answers from the record header:
   * `length()` on TEXT counts characters, so it read every conversation in
   * full on every poll (#1048) — 56 ms a round across 13 real kiro
   * workspaces, against 0.05 ms for this. The size stays in the signature
   * because two saves inside one millisecond share an `updated_at`.
   * No `created_at` either: it is stored after `value`, so reading it walks
   * the whole conversation too (9 ms for one 18 MB row); `updated_at` comes
   * from the key index. `conversationCreatedAt()` reads it on a switch.
   */
  private newestDbRow(db: Database.Database): { key: string; conversation_id: string; updated_at: number; size: number } | undefined {
    const keys = this.workingDirectoryKeys();
    if (!this.newestRowStmt || this.newestRowStmt.database !== db) {
      this.newestRowStmt = db.prepare(
        `SELECT key, conversation_id, updated_at, octet_length(value) AS size
         FROM conversations_v2 WHERE key IN (?, ?, ?)
         ORDER BY updated_at DESC LIMIT 1`,
      );
    }
    // Always three parameters, so one prepared statement serves every call.
    const [a, b = a, c = b] = keys;
    return this.newestRowStmt.get(a, b, c) as { key: string; conversation_id: string; updated_at: number; size: number } | undefined;
  }

  /** When a conversation began; read only when the poll switches to it. */
  private conversationCreatedAt(db: Database.Database, key: string, conversationId: string): number {
    if (!this.createdAtStmt || this.createdAtStmt.database !== db) {
      this.createdAtStmt = db.prepare(
        "SELECT created_at FROM conversations_v2 WHERE key = ? AND conversation_id = ? LIMIT 1",
      );
    }
    const row = this.createdAtStmt.get(key, conversationId) as { created_at: number } | undefined;
    return row?.created_at ?? 0;
  }

  /** The whole history, read only when the signature says it changed. */
  private readDbHistory(db: Database.Database, key: string, conversationId: string): unknown[] | null {
    if (!this.historyStmt || this.historyStmt.database !== db) {
      this.historyStmt = db.prepare(
        "SELECT value FROM conversations_v2 WHERE key = ? AND conversation_id = ? LIMIT 1",
      );
    }
    const row = this.historyStmt.get(key, conversationId) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { history?: unknown };
      return Array.isArray(parsed.history) ? parsed.history : [];
    } catch { return null; }
  }

  /**
   * Kiro 2.19 moved primary conversations into data.sqlite3. Snapshot the
   * active row in the isolate before admission so its existing history is
   * never replayed as live tool progress.
   */
  baseline(): void { this.snapshotDbBaseline(); }

  private snapshotDbBaseline(): void {
    try {
      const db = this.openDb();
      if (!db) return;
      const row = this.newestDbRow(db);
      if (!row) return;
      const history = this.readDbHistory(db, row.key, row.conversation_id);
      if (!history) return;
      this.dbConversationId = row.conversation_id;
      this.dbHistoryCursor = history.length;
      this.dbSignature = `${row.updated_at}:${row.size}`;
    } catch {
      // Old Kiro schema or busy DB — legacy JSONL remains available.
      this.close();
    }
  }

  read(): TranscriptEvents | null {
    try {
      const db = this.openDb();
      if (!db) return null;
      const row = this.newestDbRow(db);
      if (!row) return null;
      const signature = `${row.updated_at}:${row.size}`;
      if (row.conversation_id === this.dbConversationId && signature === this.dbSignature) return EMPTY;

      const history = this.readDbHistory(db, row.key, row.conversation_id);
      if (!history) return EMPTY;
      if (row.conversation_id !== this.dbConversationId) {
        this.dbConversationId = row.conversation_id;
        this.dbToolNames.clear();
        // A conversation created after this monitor belongs to this daemon;
        // an older conversation selected by --resume is history to baseline.
        this.dbHistoryCursor = this.conversationCreatedAt(db, row.key, row.conversation_id) >= this.createdAt ? 0 : history.length;
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
      // A replaced or corrupted store: drop the handle so the next poll reopens.
      this.close();
      return null;
    }
  }

  cursor(): KiroDbCursor { return { conversationId: this.dbConversationId, historyCursor: this.dbHistoryCursor, signature: this.dbSignature, toolNames: [...this.dbToolNames] }; }
  restore(cursor: KiroDbCursor): void { this.dbConversationId = cursor.conversationId; this.dbHistoryCursor = cursor.historyCursor; this.dbSignature = cursor.signature; this.dbToolNames = new Map(cursor.toolNames); }
  async poll(): Promise<TranscriptEvents> { return this.read() ?? emptyEvents(); }
}

/** Strings a kiro assistant turn can carry: plain response + tool-call text. */
export function extractKiroAssistantStrings(entry: unknown): string[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const assistant = (entry as Record<string, unknown>).assistant;
  if (!assistant || typeof assistant !== "object" || Array.isArray(assistant)) return [];
  const out: string[] = [];
  const record = assistant as Record<string, unknown>;
  const response = record.Response as Record<string, unknown> | undefined;
  if (response && typeof response.content === "string" && response.content.trim()) out.push(response.content);
  const toolUse = record.ToolUse as Record<string, unknown> | undefined;
  if (toolUse && typeof toolUse.content === "string" && toolUse.content.trim()) out.push(toolUse.content);
  return out;
}

function collectKiroDbEvents(entry: unknown, out: TranscriptEvents, toolNames: Map<string, string>): void {
  if (!entry || typeof entry !== "object") return;
  const record = entry as Record<string, unknown>;
  // Assistant text is observable too (#995 scans it for fabricated peer
  // envelopes — the #856 forgery lived in a ToolUse content string).
  for (const text of extractKiroAssistantStrings(entry)) out.assistantTexts.push(text);
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
