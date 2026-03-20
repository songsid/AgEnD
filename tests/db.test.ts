import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryDb } from "../src/db.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

describe("MemoryDb", () => {
  let tmpDir: string;
  let db: MemoryDb;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-db-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    db = new MemoryDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates table on init", () => {
    const rows = db.getAll();
    expect(rows).toEqual([]);
  });

  it("inserts and retrieves a backup", () => {
    db.insertBackup("/path/to/memory.md", "# Memory content", "chat123");
    const rows = db.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe("/path/to/memory.md");
    expect(rows[0].content).toBe("# Memory content");
    expect(rows[0].chat_id).toBe("chat123");
  });

  it("retrieves backups for a specific file", () => {
    db.insertBackup("/a.md", "v1", null);
    db.insertBackup("/a.md", "v2", null);
    db.insertBackup("/b.md", "other", null);
    const rows = db.getByFilePath("/a.md");
    expect(rows).toHaveLength(2);
  });
});
