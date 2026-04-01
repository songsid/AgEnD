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
  }

  close(): void {
    this.db.close();
  }
}
