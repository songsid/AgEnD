/** #3450: one page of classic/TUI history, on a disposable worker. Never opens a live store for writing.
 * Recent timestamp cursors cannot read earlier history: this scan uses source keysets and a frozen day boundary.
 * Budgets are soft by one source, capped at 128 MiB; parser CPU/heap is additionally bounded by the worker runner.
 */
import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { addTurn, emptyLedger, type Turn } from "./cache-ledger.js";
import { kiroClassicRequestTimes, kiroClassicTurns, kiroTuiTurns } from "./kiro-usage.js";
import { emptyDays, foldHours, localDate, type DayRow } from "./usage-rollup.js";

export interface KiroHistoryCursor { phase: "classic" | "tui"; key: string; id: string }
export interface KiroHistoryInput {
  dbPath: string; kiroHome: string; cwds: string[]; profile: string; zone: string; before: string;
  cursor: KiroHistoryCursor;
  maxSources?: number; maxBytes?: number;
}
export interface KiroHistoryOutput { rows: DayRow[]; cursor: KiroHistoryCursor; done: boolean; readBytes: number; sources: number }
export const KIRO_HISTORY_SOURCE_BYTES = 128 * 1024 * 1024;
const HOUR = 3_600_000;
const gone = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const signature = (path: string): string => { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}`; };

export function scanKiroHistory(i: KiroHistoryInput): KiroHistoryOutput {
  const start = performance.now(), maxSources = Math.max(1, Math.min(i.maxSources ?? 8, 32));
  const budget = Math.max(1, Math.min(i.maxBytes ?? 4 * 1024 * 1024, 16 * 1024 * 1024));
  let sources = 0, readBytes = 0, cursor = { ...i.cursor };
  const ledger = emptyLedger();
  const push = (turns: Turn[]) => {
    for (const t of turns) if (localDate(Math.floor(t.t / HOUR) * HOUR, i.zone) < i.before)
      addTurn(ledger, { kind: "kiro", ino: 0, offset: 0 }, t, 0, i.profile);
  };
  const room = () => sources < maxSources && (sources === 0 || (readBytes < budget && performance.now() - start < 100));
  const checkSize = (n: number) => { if (n > KIRO_HISTORY_SOURCE_BYTES) throw new Error("Kiro history source exceeds 128 MiB; backfill remains pending"); };
  const result = (done: boolean): KiroHistoryOutput => {
    const days = emptyDays(); foldHours(days, ledger, Number.MAX_SAFE_INTEGER, i.zone);
    return { rows: days.rows, cursor, done, readBytes, sources };
  };
  let db: Database.Database | null = null;
  try {
    if (existsSync(i.dbPath)) { db = new Database(i.dbPath, { readonly: true, fileMustExist: true }); db.pragma("query_only = ON"); }
    const marks = i.cwds.map(() => "?").join(",");
    if (!marks) throw new Error("Kiro history needs a working-directory binding");
    if (cursor.phase === "classic") {
      // Fetch only bounded metadata; never materialise all conversations or filter by updated_at.
      const rows = db?.prepare(`SELECT key, conversation_id AS id, updated_at AS u, octet_length(value) AS n
        FROM conversations_v2 WHERE key IN (${marks}) AND (key > ? OR (key = ? AND conversation_id > ?))
        ORDER BY key, conversation_id LIMIT ?`).all(...i.cwds, cursor.key, cursor.key, cursor.id, maxSources + 1) as
        Array<{ key: string; id: string; u: number; n: number }> | undefined;
      for (const r of rows ?? []) {
        if (!room()) return result(false);
        checkSize(r.n);
        const row = db!.prepare("SELECT value, updated_at AS u FROM conversations_v2 WHERE key=? AND conversation_id=?")
          .get(r.key, r.id) as { value: string; u: number } | undefined;
        if (!row || row.u !== r.u) throw new Error("Kiro classic history changed during read");
        checkSize(Buffer.byteLength(row.value));
        const value = JSON.parse(row.value) as { history?: unknown };
        if (!Array.isArray(value.history)) throw new Error("Kiro classic history is incomplete");
        push(kiroClassicTurns(value, 0)); readBytes += Buffer.byteLength(row.value); sources++;
        cursor = { phase: "classic", key: r.key, id: r.id };
      }
      cursor = { phase: "tui", key: "", id: "" };
    }
    const dir = join(i.kiroHome, "sessions", "cli");
    let names: string[];
    try { names = readdirSync(dir).filter(n => n.endsWith(".json")).sort(); }
    catch (e) { if (!gone(e)) throw e; names = []; }
    for (const name of names) {
      if (name <= cursor.key) continue;
      if (!room()) return result(false);
      const path = join(dir, name), sidecar = path.replace(/\.json$/, ".jsonl");
      const a = signature(path);
      let b = "-", sideSize = 0;
      try { b = signature(sidecar); sideSize = statSync(sidecar).size; } catch (e) { if (!gone(e)) throw e; }
      const size = statSync(path).size + sideSize; checkSize(size);
      const session = JSON.parse(readFileSync(path, "utf8")) as { cwd?: unknown; session_id?: unknown };
      sources++; readBytes += size;
      if (typeof session.cwd === "string" && i.cwds.includes(session.cwd)) {
        const lines = b === "-" ? [] : readFileSync(sidecar, "utf8").split("\n").filter(l => l.trim());
        // A partial sidecar must not become a durable one-time completion.
        for (const line of lines) JSON.parse(line);
        const times: number[] = [];
        if (db && typeof session.session_id === "string") {
          const originals = db.prepare(`SELECT octet_length(value) AS n FROM conversations_v2 WHERE key IN (${marks}) AND conversation_id=?`)
            .all(...i.cwds, session.session_id) as Array<{ n: number }>;
          const bytes = originals.reduce((n, r) => n + r.n, 0); checkSize(bytes); readBytes += bytes;
          if (originals.length) for (const r of db.prepare(`SELECT value FROM conversations_v2 WHERE key IN (${marks}) AND conversation_id=?`)
            .all(...i.cwds, session.session_id) as Array<{ value: string }>) times.push(...kiroClassicRequestTimes(JSON.parse(r.value)));
        }
        push(kiroTuiTurns(session, lines, 0, times));
      }
      if (signature(path) !== a || (b !== "-" ? signature(sidecar) !== b : existsSync(sidecar)))
        throw new Error("Kiro TUI history changed during read");
      cursor = { phase: "tui", key: name, id: "" };
    }
    return result(true);
  } finally { db?.close(); }
}
