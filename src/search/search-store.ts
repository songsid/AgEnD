/**
 * #2293: the global search's index — `search.db`, a derived store of its own (SQLite FTS5, trigram tokenizer).
 *
 * Synchronous (better-sqlite3); it runs in the search worker (search-worker.ts), never on the fleet's loop. Tests use it
 * directly. What is indexed is masked first (maskSecrets, the Log tab's), and only the fields the docs below carry.
 *
 * Queries: every term of 3+ characters is an FTS5 trigram MATCH (a substring, any script — no word breaking needed for
 * Chinese or Japanese); a term of 1–2 characters cannot use a trigram index, so it is an `instr()` filter on rows the
 * other terms or the filters already narrowed. A query of short terms only scans the newest SHORT_SCAN_ROWS rows that
 * match the filters (newest first) and says so (`limited`).
 */
import Database from "better-sqlite3";
import { maskOpenSecretTail, maskSecrets } from "../log-steps.js";

export type SearchSource = "chat" | "xmsg" | "task";
export const SEARCH_SOURCES: readonly SearchSource[] = ["chat", "xmsg", "task"];

/**
 * One searchable thing. `key` is unique per thing (a later doc with the same key replaces it: a task updated).
 * - chat: `instance` its chat, `role` user|agent, `mine` the account that wrote it (`<connection>:<user>`, or
 *   `web:<name>` for a web message of an owner-less session), `ref` { boot, id } — the chat row it opens.
 * - xmsg: `instance` the sender, `peer` the target, `role` the request kind, `ref` { correlationId?, kind }.
 * - task: `instance` the assignee (else who created it, else "tasks"), `role` its status, `ref` { taskId }.
 */
export interface SearchDoc {
  key: string;
  source: SearchSource;
  instance: string;
  peer?: string;
  sender: string;
  role?: string;
  mine?: string;
  /** Epoch ms. */
  ts: number;
  ref: Record<string, unknown>;
  text: string;
}

export interface SearchFilters {
  /** At most QUERY_MAX_TERMS terms, split on whitespace (case-insensitive). */
  q: string;
  /** Only these instances (a doc matches by its instance or, for a cross-instance message, its peer). */
  instances?: readonly string[];
  sources?: readonly SearchSource[];
  /** Epoch ms bounds (inclusive since, exclusive until). */
  since?: number;
  until?: number;
  /** Only docs whose `mine` is one of these. */
  mine?: readonly string[];
  /**
   * Instances whose cross_instance_visibility is "hidden" now: a cross-instance message to or from one is not found
   * (fleet-traffic's rule). Judged at query time, so changing the setting applies to what was indexed before it.
   */
  hidden?: readonly string[];
  /**
   * When the fleet's default is "hidden": a cross-instance message is found only when both its sides are among these
   * (the instances set to show theirs); every other name — another instance, an external session — follows the default.
   */
  xmsgAmong?: readonly string[];
  limit?: number;
}

export interface SearchHit {
  key: string; source: SearchSource; instance: string; peer: string | null; sender: string; role: string | null; ts: number;
  ref: Record<string, unknown>;
  /** The matching sentence (around the first hit) and where the hits are in it: [start, end) offsets. */
  snippet: string;
  marks: Array<[number, number]>;
}
export interface SearchResult { hits: SearchHit[]; limited: boolean }

export const QUERY_MAX_CHARS = 200;
export const QUERY_MAX_TERMS = 8;
export const RESULT_MAX = 200;
export const SHORT_SCAN_ROWS = 5000;
export const ROW_CAP = 300_000;
export const TEXT_MAX = 16_000;
/**
 * Masking reads this much past TEXT_MAX before the text is cut (#2295 review): a secret cut at the edge loses what makes
 * it recognisable (a closing quote), so the cut comes after the mask. One starting in the kept text and shorter than
 * this is masked whole — a private key block is a few KB. A text cut before it got here (the web chat's history keeps
 * 16000 characters) can end inside a quoted secret: its open tail is masked too (maskOpenSecretTail).
 */
export const MASK_MARGIN = 16_000;
const SCHEMA_VERSION = "1";
const SNIPPET_BEFORE = 60, SNIPPET_AFTER = 120;

/** The terms of a query: whitespace-split, lower-cased, deduplicated; long (3+ characters) and short ones apart. */
export function parseQuery(q: string): { long: string[]; short: string[] } {
  const terms = [...new Set(String(q ?? "").slice(0, QUERY_MAX_CHARS).toLowerCase().split(/\s+/).filter(Boolean))].slice(0, QUERY_MAX_TERMS);
  const len = (t: string) => [...t].length;
  return { long: terms.filter(t => len(t) >= 3), short: terms.filter(t => len(t) < 3) };
}

/** An FTS5 query that matches `term` as a literal substring (a phrase; its quotes doubled). */
const phrase = (term: string) => `"${term.replace(/"/g, '""')}"`;

/** The sentence around the first hit of any term, and every hit's place in it. */
export function snippetOf(text: string, terms: readonly string[]): { snippet: string; marks: Array<[number, number]> } {
  const lower = text.toLowerCase();
  let first = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (first < 0 || i < first)) first = i; }
  const from = first < 0 ? 0 : Math.max(0, first - SNIPPET_BEFORE);
  const to = Math.min(text.length, (first < 0 ? 0 : first) + SNIPPET_AFTER + SNIPPET_BEFORE);
  const lead = from > 0 ? "…" : "", tail = to < text.length ? "…" : "";
  const body = text.slice(from, to).replace(/\s+/g, " ");
  const snippet = lead + body + tail;
  const marks: Array<[number, number]> = [];
  const lb = snippet.toLowerCase();
  for (const t of terms) for (let i = lb.indexOf(t); i >= 0; i = lb.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const m of marks) { const last = merged.at(-1); if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push([...m]); }
  return { snippet, marks: merged };
}

export class SearchStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 1000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs(
        rowid INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, source TEXT NOT NULL, instance TEXT NOT NULL, peer TEXT,
        sender TEXT NOT NULL, role TEXT, mine TEXT, ts INTEGER NOT NULL, ref TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS docs_ts ON docs(ts);
      CREATE INDEX IF NOT EXISTS docs_instance_ts ON docs(instance, ts);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text, sender, content='docs', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, text, sender) VALUES (new.rowid, new.text, new.sender); END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, text, sender) VALUES ('delete', old.rowid, old.text, old.sender); END;
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, text, sender) VALUES ('delete', old.rowid, old.text, old.sender);
        INSERT INTO docs_fts(rowid, text, sender) VALUES (new.rowid, new.text, new.sender); END;`);
  }

  /** Whether this index was built (backfilled) under the current schema; false on a new or older one. */
  built(): boolean {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string } | undefined;
    return row?.v === SCHEMA_VERSION && !!this.db.prepare("SELECT v FROM meta WHERE k = 'built_at'").get();
  }
  /** Marks a finished backfill (a rebuild starts over: everything is replaced or added by key). */
  markBuilt(now: number): void {
    const set = this.db.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    this.db.transaction(() => { set.run("schema", SCHEMA_VERSION); set.run("built_at", String(now)); })();
  }

  /** Add or replace docs (by key), in one transaction. Text is masked, one-spaced at its edges and bounded. */
  add(docs: readonly SearchDoc[]): number {
    const put = this.db.prepare(`INSERT INTO docs(key, source, instance, peer, sender, role, mine, ts, ref, text)
      VALUES (@key, @source, @instance, @peer, @sender, @role, @mine, @ts, @ref, @text)
      ON CONFLICT(key) DO UPDATE SET source = excluded.source, instance = excluded.instance, peer = excluded.peer,
        sender = excluded.sender, role = excluded.role, mine = excluded.mine, ts = excluded.ts, ref = excluded.ref, text = excluded.text`);
    let n = 0;
    this.db.transaction(() => {
      for (const d of docs) {
        if (!valid(d)) continue;
        put.run({ key: d.key, source: d.source, instance: d.instance, peer: d.peer ?? null, sender: d.sender.slice(0, 256), role: d.role ?? null,
          mine: d.mine ?? null, ts: Math.trunc(d.ts), ref: JSON.stringify(d.ref ?? {}), text: indexedText(d.text) });
        n++;
      }
    })();
    return n;
  }

  /** An instance's docs go (the instance was deleted). */
  /**
   * An instance removed from the fleet: its chat goes, as the fleet forgets it. Its cross-instance messages and tasks
   * stay — the outbox and the Task Board still hold them, and the other side's view of them is not this instance's.
   */
  removeInstance(instance: string): number {
    return this.db.prepare("DELETE FROM docs WHERE source = 'chat' AND instance = ?").run(instance).changes;
  }

  /** Docs older than `cutoff` go, then the oldest beyond `cap`; in chunks (the caller yields between calls). */
  prune(cutoff: number, cap = ROW_CAP, chunk = 1000): { removed: number; more: boolean } {
    let removed = this.db.prepare("DELETE FROM docs WHERE rowid IN (SELECT rowid FROM docs WHERE ts < ? ORDER BY ts LIMIT ?)").run(cutoff, chunk).changes;
    if (removed < chunk) {
      const count = (this.db.prepare("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
      if (count > cap) removed += this.db.prepare("DELETE FROM docs WHERE rowid IN (SELECT rowid FROM docs ORDER BY ts LIMIT ?)").run(Math.min(chunk, count - cap)).changes;
    }
    return { removed, more: removed >= chunk };
  }

  count(): number { return (this.db.prepare("SELECT count(*) AS n FROM docs").get() as { n: number }).n; }

  /** The newest matches, newest first. */
  search(f: SearchFilters): SearchResult {
    const { long, short } = parseQuery(f.q);
    if (!long.length && !short.length) return { hits: [], limited: false };
    const limit = Math.max(1, Math.min(RESULT_MAX, Math.trunc(f.limit ?? 50)));
    const where: string[] = [], args: unknown[] = [];
    if (f.instances?.length) {
      const marks = f.instances.map(() => "?").join(",");
      where.push(`(d.instance IN (${marks}) OR (d.source = 'xmsg' AND d.peer IN (${marks})))`); args.push(...f.instances, ...f.instances);
    }
    if (f.sources?.length) { where.push(`d.source IN (${f.sources.map(() => "?").join(",")})`); args.push(...f.sources); }
    if (typeof f.since === "number") { where.push("d.ts >= ?"); args.push(f.since); }
    if (typeof f.until === "number") { where.push("d.ts < ?"); args.push(f.until); }
    if (f.mine?.length) { where.push(`d.mine IN (${f.mine.map(() => "?").join(",")})`); args.push(...f.mine); }
    if (f.hidden?.length) {
      const marks = f.hidden.map(() => "?").join(",");
      where.push(`NOT (d.source = 'xmsg' AND (d.instance IN (${marks}) OR d.peer IN (${marks})))`); args.push(...f.hidden, ...f.hidden);
    }
    if (f.xmsgAmong) {
      const marks = f.xmsgAmong.map(() => "?").join(",");
      where.push(f.xmsgAmong.length ? `(d.source <> 'xmsg' OR (d.instance IN (${marks}) AND d.peer IN (${marks})))` : "d.source <> 'xmsg'");
      args.push(...f.xmsgAmong, ...f.xmsgAmong);
    }
    const shortWhere = short.map(() => "instr(lower(d.text || ' ' || d.sender), ?) > 0");
    let rows: Row[], limited = false;
    if (long.length) {
      const sql = `SELECT d.* FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid WHERE docs_fts MATCH ?
        ${[...where, ...shortWhere].map(w => `AND ${w}`).join(" ")} ORDER BY d.ts DESC, d.rowid DESC LIMIT ?`;
      rows = this.db.prepare(sql).all(long.map(phrase).join(" "), ...args, ...short, limit) as Row[];
    } else {
      // Short terms only: the newest SHORT_SCAN_ROWS rows the filters allow, scanned.
      const scan = `SELECT * FROM docs d ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.ts DESC, d.rowid DESC LIMIT ?`;
      const sql = `SELECT * FROM (${scan}) AS d WHERE ${shortWhere.join(" AND ")} ORDER BY d.ts DESC, d.rowid DESC LIMIT ?`;
      rows = this.db.prepare(sql).all(...args, SHORT_SCAN_ROWS, ...short, limit) as Row[];
      const scanned = (this.db.prepare(`SELECT count(*) AS n FROM (${scan}) AS d`).get(...args, SHORT_SCAN_ROWS) as { n: number }).n;
      limited = scanned >= SHORT_SCAN_ROWS;
    }
    const terms = [...long, ...short];
    return { hits: rows.map(r => ({ ...hitOf(r), ...snippetOf(r.text, terms) })), limited };
  }

  /** One doc by key, with (for a chat message) up to `around` messages of its chat before and after it. */
  context(key: string, around = 8): { doc: SearchHit & { text: string }; before: Array<SearchHit & { text: string }>; after: Array<SearchHit & { text: string }> } | null {
    const row = this.db.prepare("SELECT * FROM docs WHERE key = ?").get(key) as Row | undefined;
    if (!row) return null;
    const full = (r: Row) => ({ ...hitOf(r), snippet: "", marks: [] as Array<[number, number]>, text: r.text });
    if (row.source !== "chat") return { doc: full(row), before: [], after: [] };
    const before = (this.db.prepare(`SELECT * FROM docs WHERE source = 'chat' AND instance = ? AND (ts < ? OR (ts = ? AND rowid < ?))
      ORDER BY ts DESC, rowid DESC LIMIT ?`).all(row.instance, row.ts, row.ts, row.rowid, around) as Row[]).reverse();
    const after = this.db.prepare(`SELECT * FROM docs WHERE source = 'chat' AND instance = ? AND (ts > ? OR (ts = ? AND rowid > ?))
      ORDER BY ts, rowid LIMIT ?`).all(row.instance, row.ts, row.ts, row.rowid, around) as Row[];
    return { doc: full(row), before: before.map(full), after: after.map(full) };
  }

  close(): void { try { this.db.close(); } catch { /* already */ } }
}

/**
 * What the index stores of a text: masked, then cut. An open tail is masked first too — the end of what arrived may
 * already be a cut (the history's), and the rules for closed values would otherwise take part of its opener (a lone
 * backslash of \" read as a bare value) — and again after the cut to TEXT_MAX.
 */
function indexedText(text: string): string {
  return maskOpenSecretTail(maskSecrets(maskOpenSecretTail(text.slice(0, TEXT_MAX + MASK_MARGIN))).slice(0, TEXT_MAX)).trim();
}
interface Row { rowid: number; key: string; source: SearchSource; instance: string; peer: string | null; sender: string; role: string | null; mine: string | null; ts: number; ref: string; text: string }
function hitOf(r: Row): Omit<SearchHit, "snippet" | "marks"> {
  let ref: Record<string, unknown> = {};
  try { const v = JSON.parse(r.ref); if (v && typeof v === "object" && !Array.isArray(v)) ref = v; } catch { /* {} */ }
  return { key: r.key, source: r.source, instance: r.instance, peer: r.peer, sender: r.sender, role: r.role, ts: r.ts, ref };
}
function valid(d: SearchDoc): boolean {
  return !!d && typeof d.key === "string" && d.key.length > 0 && d.key.length <= 300 && SEARCH_SOURCES.includes(d.source)
    && typeof d.instance === "string" && d.instance.length > 0 && typeof d.sender === "string" && typeof d.text === "string"
    && typeof d.ts === "number" && Number.isFinite(d.ts) && (d.peer === undefined || typeof d.peer === "string");
}
