import Database from "better-sqlite3";

export interface EventRow {
  id: number;
  instance_name: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

interface EventRowRaw {
  id: number;
  instance_name: string;
  event_type: string;
  payload: string | null;
  created_at: string;
}

export interface QueryOpts {
  instance?: string;
  type?: string;
  since?: string;
  limit?: number;
}

export interface ActivityRow {
  id: number;
  timestamp: string;
  event: string;
  sender: string;
  receiver: string | null;
  summary: string;
  detail: string | null;
}

function safeParseJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}

export class EventLog {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    // The fleet writes this file while `agend events` / `agend activity` read it
    // from a separate process. Without a busy timeout, either side raises
    // SQLITE_BUSY immediately instead of waiting for the other's write to finish.
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_instance ON events(instance_name, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, created_at);
    `);
    this.insertStmt = this.db.prepare("INSERT INTO events (instance_name, event_type, payload) VALUES (?, ?, ?)");

    // Reaction queue (#432 rework of #408/#413). A reaction is context, not a
    // message: it no longer triggers an agent turn. It waits here until the next
    // REAL message to the same instance, rides in as one compact context line,
    // and is then marked consumed. consumed_at stays (rather than DELETE) so a
    // delivery that fails after summarising does not lose the reactions — they
    // are only marked once the message actually went out.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        username TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reactions_pending ON reactions(instance_name, consumed_at);
    `);

    // Activity log for visualization
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        event     TEXT NOT NULL,
        sender    TEXT NOT NULL,
        receiver  TEXT,
        summary   TEXT NOT NULL,
        detail    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(timestamp);
    `);
  }

  insert(instance: string, type: string, payload?: Record<string, unknown>): void {
    this.insertStmt.run(instance, type, payload != null ? JSON.stringify(payload) : null);
  }

  query(opts: QueryOpts = {}): EventRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.instance) {
      conditions.push("instance_name = ?");
      params.push(opts.instance);
    }
    if (opts.type) {
      conditions.push("event_type = ?");
      params.push(opts.type);
    }
    if (opts.since) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    const sql = `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as EventRowRaw[];
    return rows.map((r) => ({
      ...r,
      payload: r.payload != null ? safeParseJson(r.payload) : null,
    }));
  }

  // ── Activity Log ──────────────────────────────────────────────

  logActivity(event: string, sender: string, summary: string, receiver?: string, detail?: string): void {
    this.db.prepare(
      "INSERT INTO activity (event, sender, receiver, summary, detail) VALUES (?, ?, ?, ?, ?)"
    ).run(event, sender, receiver ?? null, summary, detail ?? null);
  }

  listActivity(opts?: { since?: string; limit?: number }): ActivityRow[] {
    let sql = "SELECT * FROM activity";
    const params: unknown[] = [];
    if (opts?.since) {
      sql += " WHERE timestamp >= ?";
      params.push(opts.since);
    }
    sql += " ORDER BY timestamp ASC";
    if (opts?.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return this.db.prepare(sql).all(...params) as ActivityRow[];
  }

  prune(days: number): void {
    this.db
      .prepare("DELETE FROM events WHERE created_at < datetime('now', ?)")
      .run(`-${days} days`);
    this.db
      .prepare("DELETE FROM activity WHERE timestamp < datetime('now', ?)")
      .run(`-${days} days`);
    // Reactions have their own, shorter horizon: after REACTION_RETENTION_DAYS a
    // pending reaction is stale context nobody should be shown, consumed or not.
    this.db
      .prepare("DELETE FROM reactions WHERE created_at < datetime('now', ?)")
      .run(`-${EventLog.REACTION_RETENTION_DAYS} days`);
  }

  private static REACTION_RETENTION_DAYS = 7;

  /** Queue a reaction for the instance's next real message. */
  addReaction(instance: string, messageId: string, username: string, emoji: string): void {
    this.db
      .prepare("INSERT INTO reactions (instance_name, message_id, username, emoji) VALUES (?, ?, ?, ?)")
      .run(instance, messageId, username, emoji);
  }

  /**
   * A withdrawn reaction is withdrawn context. Deleting the matching pending row
   * (newest first, one per removal) means an add-then-remove nets out to nothing,
   * instead of reporting a 👍 the user visibly took back. Already-consumed rows
   * are left alone — the agent has seen those; history does not un-happen.
   */
  removeReaction(instance: string, messageId: string, username: string, emoji: string): void {
    this.db
      .prepare(`DELETE FROM reactions WHERE id = (
        SELECT id FROM reactions
        WHERE instance_name = ? AND message_id = ? AND username = ? AND emoji = ? AND consumed_at IS NULL
        ORDER BY id DESC LIMIT 1
      )`)
      .run(instance, messageId, username, emoji);
  }

  /**
   * Pending reactions as one compact context line: `👍×2 from hanhanv, ❓×1 from
   * user2`. Returns null (not an empty string) when there is nothing pending, so
   * callers add zero context in the common case. `maxId` is what the caller hands
   * back to markReactionsConsumed — bounding by id keeps a reaction that arrives
   * DURING delivery pending for the next message instead of being silently eaten.
   */
  pendingReactions(instance: string): { summary: string; maxId: number } | null {
    const rows = this.db
      .prepare("SELECT id, username, emoji FROM reactions WHERE instance_name = ? AND consumed_at IS NULL ORDER BY id")
      .all(instance) as Array<{ id: number; username: string; emoji: string }>;
    if (rows.length === 0) return null;

    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.emoji}\u0000${row.username}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [key, count] of counts) {
      const [emoji, username] = key.split("\u0000");
      parts.push(count > 1 ? `${emoji}×${count} from ${username}` : `${emoji} from ${username}`);
    }
    return { summary: parts.join(", "), maxId: rows[rows.length - 1].id };
  }

  /** Mark reactions up to `maxId` as shown. Call only after the delivery succeeded. */
  markReactionsConsumed(instance: string, maxId: number): void {
    this.db
      .prepare("UPDATE reactions SET consumed_at = datetime('now') WHERE instance_name = ? AND id <= ? AND consumed_at IS NULL")
      .run(instance, maxId);
  }

  close(): void {
    this.db.close();
  }
}
