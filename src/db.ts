import Database from "better-sqlite3";
import type { MemoryBackupRow } from "./types.js";

export class MemoryDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        chat_id TEXT,
        backed_up_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  insertBackup(filePath: string, content: string, chatId: string | null): void {
    this.db
      .prepare("INSERT INTO memory_backups (file_path, content, chat_id) VALUES (?, ?, ?)")
      .run(filePath, content, chatId);
  }

  getAll(): MemoryBackupRow[] {
    return this.db
      .prepare("SELECT * FROM memory_backups ORDER BY backed_up_at DESC")
      .all() as MemoryBackupRow[];
  }

  getByFilePath(filePath: string): MemoryBackupRow[] {
    return this.db
      .prepare("SELECT * FROM memory_backups WHERE file_path = ? ORDER BY backed_up_at DESC")
      .all(filePath) as MemoryBackupRow[];
  }

  close(): void {
    this.db.close();
  }
}
