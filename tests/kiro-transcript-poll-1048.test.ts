/**
 * #1048: the kiro transcript poll stalled the fleet's event loop. Every kiro
 * instance polls every 2 s, and each poll opened kiro's whole store (1 GB on
 * the machine that hit this) and asked for `length(value)` — which, on TEXT,
 * reads every conversation in full. 13 kiro instances made that ~56 ms of
 * synchronous work per round on the fleet's main thread, before any parsing.
 */
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KiroSessionSource } from "../src/transcript-sources.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";

const ROOT = mkdtempSync(join(tmpdir(), "agend-1048-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const sessionsDir = join(ROOT, "no-sessions");

function createStore(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE conversations_v2 (
    key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, conversation_id))`);
  // Kiro's own indexes (read off a real 1 GB store): updated_at is served
  // from the key index, which is what makes the change signal cheap.
  db.exec(`CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);
    CREATE INDEX idx_conversations_v2_updated_at ON conversations_v2(updated_at DESC);`);
  return db;
}
const entry = (i: number, tool?: string) => ({
  user: { content: { Prompt: { prompt: `turn ${i} ` + "x".repeat(2000) } } },
  assistant: tool
    ? { ToolUse: { tool_uses: [{ id: `t${i}`, name: tool, args: { command: `run ${i}` } }] } }
    : { Response: { content: "reply ".repeat(300) } },
});
const conversation = (turns: number, extra: object[] = []) =>
  JSON.stringify({ history: [...Array.from({ length: turns }, (_, i) => entry(i)), ...extra] });

describe("the kiro poll is cheap when nothing changed (#1048)", () => {
  // The real fleet: 13 kiro workspaces, 0.8–18 MB conversations, ~60 MB.
  const WORKSPACES = 13;
  const dbPath = join(ROOT, "bench.sqlite3");
  const dirs = Array.from({ length: WORKSPACES }, (_, i) => join(ROOT, `ws-${i}`));
  let store: Database.Database;
  beforeAll(() => {
    store = createStore(dbPath);
    const insert = store.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)");
    const now = Date.now();
    // ~75 MB in all, the largest rows ~11 MB: the real store's shape.
    dirs.forEach((d, i) => insert.run(d, `conv-${i}`, conversation(i % 3 === 0 ? 4000 : 1200), now - 60_000, now - 10_000));
    store.close();
  });

  it("the poll query reads nothing SQLite must walk a conversation for", async () => {
    // Cost here is decided by which columns the per-poll query reads, not by
    // how fast this machine is: sub-millisecond timings cannot tell the two
    // shapes apart on a fast CI box (#1049 CI: 0.80 ms vs 1.05 ms). SQLite
    // must walk a multi-MB row to reach `value` or any column stored after it
    // (length(value) counts characters; created_at sits after value). A
    // column before `value`, one the chosen index carries, or
    // octet_length(value) (the record header) costs nothing.
    const source = new KiroSessionSource(dirs[0]!, sessionsDir, Date.now(), dbPath);
    try {
      await source.poll();
      const sql: string = (source as any).newestRowStmt.source;
      const probe = new Database(dbPath, { readonly: true });
      const columns = (probe.pragma("table_info(conversations_v2)") as Array<{ cid: number; name: string }>);
      const valueAt = columns.find(c => c.name === "value")!.cid;
      const plan = (probe.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("a", "a", "a") as Array<{ detail: string }>)
        .map(r => r.detail).join(" ");
      const index = /USING (?:COVERING )?INDEX (\w+)/.exec(plan)?.[1];
      const indexed = index
        ? (probe.pragma(`index_info(${index})`) as Array<{ name: string }>).map(c => c.name)
        : [];
      probe.close();
      const selected = /^\s*SELECT\s+([\s\S]*?)\s+FROM\s/i.exec(sql)![1]!
        .split(",").map(e => e.trim().replace(/\s+AS\s+\w+$/i, "").toLowerCase());
      expect(index, plan).toBe("idx_conversations_v2_key_updated");
      for (const expr of selected) {
        if (expr === "octet_length(value)") continue;
        const col = columns.find(c => c.name === expr);
        expect(col, `"${expr}" is not a plain column: it would read the value`).toBeDefined();
        expect(col!.cid < valueAt || indexed.includes(expr), `"${expr}" is stored after value and not in ${index}`).toBe(true);
      }
    } finally {
      source.close();
    }
  });

  it("a round of idle polls over ~75 MB of conversations stays far below one parse", async () => {
    const sources = dirs.map(d => new KiroSessionSource(d, sessionsDir, Date.now(), dbPath));
    try {
      for (const s of sources) await s.poll(); // warm: statements prepared, pages cached
      const lag = monitorEventLoopDelay({ resolution: 1 });
      lag.enable();
      const rounds: number[] = [];
      for (let r = 0; r < 10; r++) {
        const t0 = performance.now();
        for (const s of sources) expect((await s.poll()).toolUses).toEqual([]);
        rounds.push(performance.now() - t0);
        await new Promise(r => setImmediate(r));
      }
      lag.disable();
      rounds.sort((a, b) => a - b);
      const median = rounds[5]!;
      // On the real store: 100 ms a round before (length() and created_at
      // both read every value), 0.28 ms after. An absolute sanity bound; the
      // shape itself is pinned by the test above.
      console.log(`[#1048] idle poll round median ${median.toFixed(2)} ms over ${WORKSPACES} workspaces; max event-loop delay ${(lag.max / 1e6).toFixed(1)} ms`);
      expect(median, `idle round ${median.toFixed(2)} ms`).toBeLessThan(15);
      expect(lag.max / 1e6, "event-loop delay").toBeLessThan(100); // sanity bound; GC included
    } finally {
      for (const s of sources) s.close();
    }
  });
});

describe("one store handle, and changes still seen", () => {
  let n = 0;
  const fresh = () => {
    const dbPath = join(ROOT, `store-${++n}.sqlite3`);
    const db = createStore(dbPath);
    const dir = join(ROOT, `work-${n}`);
    db.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)")
      .run(dir, "c1", conversation(3), Date.now() - 60_000, 1_000);
    return { dbPath, db, dir };
  };
  const sources: KiroSessionSource[] = [];
  const stores: Database.Database[] = [];
  afterEach(() => {
    for (const s of sources.splice(0)) s.close();
    for (const d of stores.splice(0)) d.close();
  });

  it("keeps one handle across polls instead of reopening the store", async () => {
    const { dbPath, db, dir } = fresh(); stores.push(db);
    const source = new KiroSessionSource(dir, sessionsDir, Date.now(), dbPath); sources.push(source);
    const handle = (source as any).db;
    expect(handle).toBeTruthy();
    for (let i = 0; i < 5; i++) await source.poll();
    expect((source as any).db).toBe(handle);
  });

  it("sees a save that kept updated_at but changed the size", async () => {
    const { dbPath, db, dir } = fresh(); stores.push(db);
    const source = new KiroSessionSource(dir, sessionsDir, Date.now(), dbPath); sources.push(source);
    expect((await source.poll()).toolUses).toEqual([]);
    // Two saves inside one millisecond share an updated_at.
    db.prepare("UPDATE conversations_v2 SET value = ? WHERE conversation_id = 'c1'")
      .run(conversation(3, [entry(99, "execute_bash")]));
    expect((await source.poll()).toolUses).toEqual([{ name: "execute_bash", input: { command: "run 99" } }]);
  });

  it("does not re-read or re-parse an unchanged conversation", async () => {
    const { dbPath, db, dir } = fresh(); stores.push(db);
    const source = new KiroSessionSource(dir, sessionsDir, Date.now(), dbPath); sources.push(source);
    await source.poll();
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return parse(...a); }) as typeof JSON.parse;
    try {
      for (let i = 0; i < 5; i++) await source.poll();
    } finally { JSON.parse = parse; }
    expect(parses).toBe(0);
  });

  it("follows a replaced store file instead of reading the old one forever", async () => {
    const { dbPath, db, dir } = fresh(); stores.push(db);
    const source = new KiroSessionSource(dir, sessionsDir, Date.now(), dbPath); sources.push(source);
    await source.poll();
    // Kiro writes a new store and moves it into place (new inode).
    const next = `${dbPath}.next`;
    db.pragma("wal_checkpoint(TRUNCATE)"); // the copy must carry the rows
    db.close(); stores.pop();
    copyFileSync(dbPath, next);
    const replacement = new Database(next); stores.push(replacement);
    replacement.prepare("UPDATE conversations_v2 SET value = ?, updated_at = 2000 WHERE conversation_id = 'c1'")
      .run(conversation(3, [entry(7, "fs_write")]));
    replacement.pragma("wal_checkpoint(TRUNCATE)");
    renameSync(next, dbPath);
    expect((await source.poll()).toolUses).toEqual([{ name: "fs_write", input: { command: "run 7" } }]);
  });

  it("a stopped monitor releases the handle, and polling again reacquires it", async () => {
    const { dbPath, db, dir } = fresh(); stores.push(db);
    const source = new KiroSessionSource(dir, sessionsDir, Date.now(), dbPath); sources.push(source);
    const monitor = new TranscriptMonitor(join(ROOT, `inst-${n}`), { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any, source);
    monitor.startPolling(10);
    await new Promise(r => setTimeout(r, 40));
    expect((source as any).db).toBeTruthy();
    monitor.stop();
    expect((source as any).db).toBeNull();
    db.prepare("UPDATE conversations_v2 SET value = ?, updated_at = 5000 WHERE conversation_id = 'c1'")
      .run(conversation(3, [entry(5, "execute_bash")]));
    expect((await source.poll()).toolUses).toEqual([{ name: "execute_bash", input: { command: "run 5" } }]);
    expect((source as any).db).toBeTruthy();
  });
});
