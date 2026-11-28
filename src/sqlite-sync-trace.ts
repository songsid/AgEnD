/**
 * M-3916: opt-in attribution of synchronous SQLite writes to the event-loop stall log.
 *
 * The fleet's main thread commits to about twenty SQLite databases synchronously. A commit can wait for the ext4
 * journal (the stall sampler saw the main thread in `jbd2_log_wait_commit`), and a stall log that only says "slow sync
 * work: unknown" cannot say which database it was. With `AGEND_SQLITE_SYNC_TRACE=1` in the fleet's environment, every
 * write through better-sqlite3 (a prepared statement's run(), exec(), and a transaction function) is timed and recorded
 * with `noteSyncWork("sqlite:<file name>")`, so the stall line names the database and how long its writes took.
 *
 * Off by default: nothing is patched and nothing is measured unless the variable is set. Reads (get/all/iterate) are
 * never timed. Idempotent; installing twice patches once.
 */
import Database from "better-sqlite3";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { noteSyncWork } from "./sync-work-attribution.js";

export const SQLITE_SYNC_TRACE_ENV = "AGEND_SQLITE_SYNC_TRACE";
const PATCHED = Symbol.for("agend.sqliteSyncTrace");

/** The stall-log label for a database: its file name, or `memory` for an in-memory one. */
export function sqliteTraceLabel(name: string | undefined): string {
  if (!name || name === ":memory:" || name === "") return "sqlite:memory";
  return `sqlite:${basename(name)}`;
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
let restore: (() => void) | null = null;
/** Tests only: undo the patch (the native Statement class is shared by every test file in a worker). */
export function restoreSqliteSyncTraceForTests(): void { restore?.(); restore = null; }

/** Patch better-sqlite3 once when the variable is set; returns whether tracing is on. */
export function installSqliteSyncTrace(env: NodeJS.ProcessEnv = process.env, Db: typeof Database = Database): boolean {
  if (env[SQLITE_SYNC_TRACE_ENV] !== "1") return false;
  const proto = Db.prototype as unknown as Record<string | symbol, unknown>;
  if (proto[PATCHED]) return true;
  const probe = new Db(":memory:");
  const statementProto = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, unknown>;
  probe.close();
  // Only the outermost write is recorded: a run() inside a transaction is part of the transaction's own time.
  let depth = 0;
  const timed = (label: () => string, fn: () => unknown): unknown => {
    if (depth > 0) return fn();
    const startedAt = performance.now();
    depth++;
    try { return fn(); } finally { depth--; noteSyncWork(label(), startedAt); }
  };
  const run = statementProto.run as AnyFn;
  statementProto.run = function (this: { database?: { name?: string } }, ...args: unknown[]) {
    return timed(() => sqliteTraceLabel(this.database?.name), () => run.apply(this, args));
  };
  const exec = proto.exec as AnyFn;
  proto.exec = function (this: { name?: string }, ...args: unknown[]) {
    return timed(() => sqliteTraceLabel(this.name), () => exec.apply(this, args));
  };
  const transaction = proto.transaction as AnyFn;
  proto.transaction = function (this: { name?: string }, ...args: unknown[]) {
    const tx = transaction.apply(this, args) as AnyFn & Record<string, AnyFn>;
    const db = this;
    const wrap = (inner: AnyFn): AnyFn => function (this: unknown, ...a: unknown[]) {
      return timed(() => sqliteTraceLabel(db.name), () => inner.apply(this, a));
    };
    const outer = wrap(tx) as AnyFn & Record<string, AnyFn>;
    for (const mode of ["deferred", "immediate", "exclusive"] as const) if (typeof tx[mode] === "function") outer[mode] = wrap(tx[mode]);
    return outer;
  };
  proto[PATCHED] = true;
  restore = () => { statementProto.run = run; proto.exec = exec; proto.transaction = transaction; delete proto[PATCHED]; };
  return true;
}
