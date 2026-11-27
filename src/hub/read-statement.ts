/** Prepared code only: each call still executes SQLite and returns fresh rows. */
import type Database from "better-sqlite3";

const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();
const MAX_READ_STATEMENTS = 64;
function statement(db: Database.Database, sql: string): Database.Statement {
  if (!db.open) { statements.delete(db); throw new TypeError("Hub read database is closed"); }
  const known = statements.get(db)?.get(sql);
  if (known) return known;
  const prepared = db.prepare(sql);
  if (!prepared.readonly) throw new TypeError("Hub read statement must be read-only");
  let cache = statements.get(db);
  if (!cache) { cache = new Map(); statements.set(db, cache); }
  // Constant owned queries fit this bound. A new query beyond it executes freshly;
  // cache capacity never becomes a new admission or authorization condition.
  if (cache.size < MAX_READ_STATEMENTS) cache.set(sql, prepared);
  return prepared;
}
export function readHubSqlRow(db: Database.Database, sql: string, ...parameters: unknown[]): unknown {
  return statement(db, sql).get(...parameters);
}
export function readHubSqlRows(db: Database.Database, sql: string, ...parameters: unknown[]): unknown[] {
  return statement(db, sql).all(...parameters);
}

/** Owned connection teardown; never carry prepared code to another handle. */
export function clearHubReadStatements(db: Database.Database): void { statements.delete(db); }
