/**
 * #2293: the search index's worker — it alone opens search.db, so no SQLite work of the index runs on the fleet's loop.
 * The fleet posts batches of docs and queries (search-index.ts); this answers queries and says when it is ready and
 * whether the index still needs its backfill. A corrupt file is moved aside (`search.db.corrupt-<stamp>`, with its -wal
 * and -shm) and a fresh one opened — the fleet backfills it; any other failure to open ends the worker (search is then
 * unavailable, the fleet runs on).
 *
 * The backfill of the two sources that live in SQLite is read here too, read-only: the outbox's cross-instance messages
 * (its own retention: 30 days) and the Task Board. A page at a time, yielding between pages, so a query is answered
 * while it runs.
 */
import { parentPort, workerData } from "node:worker_threads";
import { existsSync, renameSync } from "node:fs";
import Database from "better-sqlite3";
import { classifySqliteOpenError } from "../sqlite-open-errors.js";
import { SearchStore } from "./search-store.js";
import { taskDoc, xmsgDoc, xmsgFromOutbox, type TaskRecord } from "./search-docs.js";

const path = String((workerData as { path?: unknown } | undefined)?.path ?? "");
const port = parentPort!;
let store: SearchStore | null = null;

function moveAside(): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) renameSync(path + suffix, `${path}.corrupt-${stamp}${suffix}`);
}
function open(): void {
  try { store = new SearchStore(path); }
  catch (err) {
    if (classifySqliteOpenError(err) !== "corrupt") { port.postMessage({ op: "failed", reason: String((err as Error)?.message ?? err) }); process.exit(0); }
    moveAside();
    store = new SearchStore(path);
  }
  port.postMessage({ op: "ready", built: store.built() });
}
/** A corrupt file found while working: the same as at open — moved aside, a fresh index, a new backfill. */
function recover(err: unknown): boolean {
  if (classifySqliteOpenError(err) !== "corrupt") return false;
  store?.close(); store = null;
  moveAside();
  open();
  return true;
}

const BACKFILL_PAGE = 500;
const MESSAGE_KINDS = ["fleet_inbound", "steer", "broadcast"];
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
function readOnly(file: string | undefined): Database.Database | null {
  if (!file || !existsSync(file)) return null;
  try { const db = new Database(file, { readonly: true, fileMustExist: true }); db.pragma("busy_timeout = 1000"); return db; } catch { return null; }
}
/** The outbox's cross-instance messages since `cutoff`, then every task: what the fleet recorded before the index. */
async function backfill(outboxPath: string | undefined, schedulerPath: string | undefined, cutoff: number): Promise<{ xmsg: number; tasks: number }> {
  let xmsg = 0, tasks = 0;
  const outbox = readOnly(outboxPath);
  if (outbox) try {
    const page = outbox.prepare(`SELECT created_seq AS seq, COALESCE(target_session, target_instance) AS target, created_at AS createdAt, payload_json AS payload, kind
      FROM deliveries WHERE created_seq > ? AND kind IN (${MESSAGE_KINDS.map(() => "?").join(",")}) ORDER BY created_seq LIMIT ?`);
    for (let after = -1; ;) {
      const rows = page.all(after, ...MESSAGE_KINDS, BACKFILL_PAGE) as Array<{ seq: number; target: string; createdAt: string; payload: string; kind: string }>;
      if (!rows.length || !store) break;
      after = rows[rows.length - 1]!.seq;
      const docs = rows.map(r => xmsgFromOutbox(r.target, r.createdAt, r.payload, r.kind)).map(r => (r ? xmsgDoc(r) : null)).filter(d => d !== null && d.ts >= cutoff);
      xmsg += store.add(docs as never);
      await pause();
    }
  } catch { /* an outbox this can't read: its messages are not found, the rest is */ } finally { outbox.close(); }
  const scheduler = readOnly(schedulerPath);
  if (scheduler) try {
    const page = scheduler.prepare("SELECT rowid AS rid, id, title, description, result, status, assignee, created_by, created_at, updated_at FROM tasks WHERE rowid > ? ORDER BY rowid LIMIT ?");
    for (let after = -1; ;) {
      const rows = page.all(after, BACKFILL_PAGE) as Array<TaskRecord & { rid: number }>;
      if (!rows.length || !store) break;
      after = rows[rows.length - 1]!.rid;
      tasks += store.add(rows.map(taskDoc).filter(d => d !== null && d.ts >= cutoff) as never);
      await pause();
    }
  } catch { /* the same for the Task Board */ } finally { scheduler.close(); }
  return { xmsg, tasks };
}

port.on("message", (m: { op: string; id?: number; docs?: unknown[]; filters?: unknown; key?: string; cutoff?: number; instance?: string; now?: number; outboxPath?: string; schedulerPath?: string; batch?: number; gen?: number }) => {
  if (!store) return;
  const reply = (value: unknown) => { if (m.id !== undefined) port.postMessage({ op: "reply", id: m.id, ok: true, value }); };
  try {
    switch (m.op) {
      // Acked once written: the fleet keeps a batch until then, and sends it again to a worker that replaces this one.
      case "add": store.add((m.docs ?? []) as never); if (m.batch !== undefined) port.postMessage({ op: "added", batch: m.batch }); break;
      case "markBuilt": store.markBuilt(Number(m.now) || Date.now()); break;
      case "removeInstance": if (typeof m.instance === "string") { store.removeInstance(m.instance); port.postMessage({ op: "removed", instance: m.instance, gen: m.gen }); } break;
      case "query": reply(store.search(m.filters as never)); break;
      case "context": reply(store.context(String(m.key ?? ""))); break;
      case "prune": reply(store.prune(Number(m.cutoff) || 0)); break;
      case "count": reply(store.count()); break;
      case "backfill": void backfill(m.outboxPath, m.schedulerPath, Number(m.cutoff) || 0).then(reply, err => {
        if (m.id !== undefined) port.postMessage({ op: "reply", id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
      }); break;
      case "close": store.close(); store = null; process.exit(0);
    }
  } catch (err) {
    if (m.id !== undefined) port.postMessage({ op: "reply", id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
    // A corrupt file: a fresh one, announced as not built (the fleet sends its uncommitted batches again and backfills).
    // Any other failed write is let go (acked): sent again it would fail again.
    if (!recover(err) && m.op === "add" && m.batch !== undefined) port.postMessage({ op: "added", batch: m.batch });
  }
});
open();
