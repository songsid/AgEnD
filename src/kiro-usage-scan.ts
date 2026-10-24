/**
 * #2122 §10 step 2: one bounded read of Kiro's three stores for the usage ledger, run in a worker thread
 * (kiro-usage-worker.ts) so the fleet loop never parses a conversation (a classic row holds the whole history: tens of
 * MB). Synchronous and self-contained so a test can run it in-process.
 *
 * - Which sources: each Kiro instance's conversations — classic rows whose `key` is its working directory, TUI sessions
 *   whose `cwd` is, and V3 sessions in its working directory's bucket. Only sources changed since the cutoff.
 * - Incremental: a source is read again only when it changed (its signature: the row's `updated_at`, a file's
 *   inode:size:mtime), and only turns after the last one counted (`after`) come back.
 * - Never: a write to Kiro's stores (the database is opened read-only; each read is one statement, so Kiro's own writer
 *   waits at most for that), a child process, a network call.
 * - Bounded: past `maxBytes` read, a changed source is left for the next pass (counted as behind).
 */
import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Turn } from "./cache-ledger.js";
import { kasBucket } from "./backend/kiro-kas-store.js";
import { kiroClassicRequestTimes, kiroClassicTurns, kiroKasTurns, kiroTuiTurns } from "./kiro-usage.js";

/** Where reading a source stopped: what it looked like then, and the time of the last turn counted. */
export interface KiroCursor { sig: string; after: number }
export interface KiroScanInstance {
  name: string;
  /** Its working directory as configured and as resolved (a store records either). */
  cwds: string[];
  /** The classic store it writes: its credential profile's, else the shared one. */
  dbPath: string;
  /** Keyed `classic:<conversation id>`, `tui:<file>`, `kas:<session dir>`. */
  cursors: Record<string, KiroCursor>;
}
export interface KiroScanInput {
  /** KIRO_HOME (default ~/.kiro): the TUI and V3 stores, shared by every login. */
  kiroHome: string;
  cutoff: number;
  maxBytes: number;
  instances: KiroScanInstance[];
  /** TUI session file → its signature and cwd, from earlier scans (only a changed file is parsed to learn its cwd). */
  tuiIndex: Record<string, { sig: string; cwd: string | null }>;
}
export interface KiroScanUpdate { key: string; sig: string; after: number; turns: Turn[] }
export interface KiroScanResult {
  name: string;
  updates: KiroScanUpdate[];
  /** Every source of this instance seen now (a cursor for anything else is stale). */
  live: string[];
  /** A store was there and could not be read: this scan proves nothing about the instance (no coverage). */
  failed: boolean;
}
export interface KiroScanOutput { instances: KiroScanResult[]; tuiIndex: KiroScanInput["tuiIndex"]; readBytes: number; behindBytes: number; behindSources: number }

const gone = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
const sigOf = (path: string): { sig: string; size: number; mtimeMs: number } => {
  const st = statSync(path);
  return { sig: `${st.ino}:${st.size}:${st.mtimeMs}`, size: st.size, mtimeMs: st.mtimeMs };
};
const lines = (path: string): string[] => { try { return readFileSync(path, "utf8").split("\n"); } catch (err) { if (gone(err)) return []; throw err; } };

export function scanKiroUsage(input: KiroScanInput): KiroScanOutput {
  let budget = input.maxBytes, behindBytes = 0, behindSources = 0;
  const dbs = new Map<string, Database.Database | null>();
  const tuiIndex: KiroScanInput["tuiIndex"] = Object.create(null);
  const out: KiroScanResult[] = [];
  const openDb = (path: string): Database.Database | null => {
    if (dbs.has(path)) return dbs.get(path)!;
    let db: Database.Database | null = null;
    // Not there (no classic conversation yet, or no Kiro at all): nothing to read. There and unopenable: a failure.
    if (existsSync(path)) { db = new Database(path, { readonly: true, fileMustExist: true }); db.pragma("query_only = ON"); }
    dbs.set(path, db);
    return db;
  };
  // A classic conversation's request times, for the dedup of a session that carried it into another engine.
  const classicTimes = (db: Database.Database | null, id: string): number[] => {
    if (!db) return [];
    const row = db.prepare("SELECT value FROM conversations_v2 WHERE conversation_id = ?").get(id) as { value?: string } | undefined;
    if (!row?.value) return [];
    try { return kiroClassicRequestTimes(JSON.parse(row.value)); } catch { return []; }
  };
  /** Read one changed source within the budget, or count it as behind. */
  const within = (bytes: number): boolean => {
    if (budget <= 0) { behindBytes += bytes; behindSources++; return false; }
    budget -= Math.max(bytes, 1);
    return true;
  };

  // TUI sessions: one listing for everyone; a file's cwd is learned once per version of it.
  let tuiNames: string[] = [];
  let tuiFailed = false;
  const tuiDir = join(input.kiroHome, "sessions", "cli");
  try { tuiNames = readdirSync(tuiDir).filter(n => n.endsWith(".json")); } catch (err) { if (!gone(err)) tuiFailed = true; }
  const tuiFiles: Array<{ path: string; sig: string; size: number; cwd: string | null }> = [];
  for (const n of tuiNames) {
    const path = join(tuiDir, n);
    try {
      const s = sigOf(path);
      if (s.mtimeMs < input.cutoff) continue;
      const known = input.tuiIndex[path];
      let cwd = known?.sig === s.sig ? known.cwd : undefined;
      if (cwd === undefined) {
        const text = readFileSync(path, "utf8");                 // a read that fails is a failure (below), not an empty store
        try { const v = JSON.parse(text) as { cwd?: unknown }; cwd = typeof v.cwd === "string" ? v.cwd : null; }
        // Being rewritten: read again next pass. Until then whose it is can't be known, so no instance's scan is
        // complete (no coverage, and no cursor is pruned — Prism #2605).
        catch { tuiFailed = true; continue; }
      }
      tuiIndex[path] = { sig: s.sig, cwd };
      tuiFiles.push({ path, sig: s.sig, size: s.size, cwd });
    } catch (err) { if (!gone(err)) tuiFailed = true; }
  }

  try {
    for (const inst of input.instances) {
      const res: KiroScanResult = { name: inst.name, updates: [], live: [], failed: tuiFailed };
      const cwds = new Set(inst.cwds);
      const afterOf = (key: string) => Math.max(inst.cursors[key]?.after ?? -Infinity, input.cutoff);
      const push = (key: string, sig: string, turns: Turn[]) =>
        res.updates.push({ key, sig, after: turns.reduce((m, t) => Math.max(m, t.t), afterOf(key)), turns });

      // Classic: its working directory's rows.
      let db: Database.Database | null = null;
      try {
        db = openDb(inst.dbPath);
        const rows = db ? db.prepare("SELECT conversation_id AS id, key, updated_at AS u, octet_length(value) AS n FROM conversations_v2 WHERE updated_at >= ?").all(input.cutoff) as Array<{ id: string; key: string; u: number; n: number }> : [];
        for (const r of rows) {
          if (!cwds.has(r.key)) continue;
          const key = `classic:${r.id}`, sig = String(r.u);
          res.live.push(key);
          if (inst.cursors[key]?.sig === sig || !within(r.n)) continue;
          const row = db!.prepare("SELECT value FROM conversations_v2 WHERE key = ? AND conversation_id = ?").get(r.key, r.id) as { value?: string } | undefined;
          if (!row?.value) continue;
          let v: unknown;
          try { v = JSON.parse(row.value); } catch { continue; }
          push(key, sig, kiroClassicTurns(v, afterOf(key)));
        }
      } catch { res.failed = true; }

      // TUI: the sessions whose cwd is its working directory.
      for (const f of tuiFiles) {
        if (f.cwd === null || !cwds.has(f.cwd)) continue;
        const key = `tui:${f.path}`;
        res.live.push(key);
        if (inst.cursors[key]?.sig === f.sig) continue;
        const sidecar = f.path.replace(/\.json$/, ".jsonl");
        let size = f.size;
        try { size += statSync(sidecar).size; } catch { /* none yet */ }
        if (!within(size)) continue;
        try {
          const session = JSON.parse(readFileSync(f.path, "utf8")) as { session_id?: unknown };
          const id = typeof session.session_id === "string" ? session.session_id : "";
          push(key, f.sig, kiroTuiTurns(session, lines(sidecar), afterOf(key), id ? classicTimes(db, id) : []));
        } catch (err) { if (!gone(err)) res.failed = true; }
      }

      // V3: its working directory's bucket.
      for (const dir of new Set(inst.cwds.map(c => join(input.kiroHome, "sessions", kasBucket(c))))) {
        let names: string[] = [];
        try { names = readdirSync(dir).filter(n => !n.startsWith(".")); } catch (err) { if (!gone(err)) res.failed = true; continue; }
        for (const n of names) {
          const sessionPath = join(dir, n, "session.json"), messagesPath = join(dir, n, "messages.jsonl");
          try {
            const a = sigOf(sessionPath);
            let m = { sig: "-", size: 0, mtimeMs: 0 };
            try { m = sigOf(messagesPath); } catch (err) { if (!gone(err)) throw err; }
            if (Math.max(a.mtimeMs, m.mtimeMs) < input.cutoff) continue;
            const key = `kas:${join(dir, n)}`, sig = `${a.sig}|${m.sig}`;
            res.live.push(key);
            if (inst.cursors[key]?.sig === sig || !within(a.size + m.size)) continue;
            const session = JSON.parse(readFileSync(sessionPath, "utf8")) as unknown;
            // A converted session's id is `cli_<classic id>_<suffix>`: its source's requests are counted there.
            const source = /^cli_(.+)_[^_]+$/.exec(n)?.[1];
            push(key, sig, kiroKasTurns(session, lines(messagesPath), afterOf(key), source ? classicTimes(db, source) : []));
          } catch (err) { if (!gone(err)) res.failed = true; }   // being rewritten (SyntaxError) included: next pass
        }
      }
      out.push(res);
    }
  } finally {
    for (const db of dbs.values()) db?.close();
  }
  return { instances: out, tuiIndex, readBytes: input.maxBytes - budget, behindBytes, behindSources };
}
