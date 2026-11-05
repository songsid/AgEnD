/**
 * S5b (S-51; docs/design/hub-composition.md §3–§4): the Hub's private databases. Opening with private modes from the
 * first byte, the per-slice migration registry, the "created together" set check, the Hub-instance binding, and the
 * unit of work (HubUnitOfWork) with `hubTxDatabase` for slices that run their own statements inside it.
 * Nothing here runs on import; only composition calls it, and only while a Hub switch is on.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory, privatePath } from "./private-files.js";
import type { HubTx, HubUnitOfWork } from "./types.js";

/** Composition's closed set of hold reasons (hub-composition.md §2). */
export type HubHoldCode =
  | "hub-incomplete"
  | "hub-unsealed"
  | "hub-state-newer"
  | "hub-state-mismatch"
  | "hub-storage"
  | "hub-directory-secret"
  | "hub-member-pairing"
  | "service-unavailable";

export class HubStateError extends Error {
  constructor(
    readonly code: HubHoldCode,
    message: string,
  ) {
    super(message);
    this.name = "HubStateError";
  }
}

/** One slice's schema step. `up` must be idempotent for its own version (CREATE … IF NOT EXISTS). */
export interface HubMigration {
  readonly component: string;
  readonly version: number;
  up(db: Database.Database): void;
}

/**
 * The files composition creates together on one side (§3), relative to the AgEnD home. Prerequisites written earlier
 * (S1's identity keys, the sealed manifest, pairing files) are never part of a set.
 */
export interface HubStateSet {
  readonly database: string;
  readonly floors: readonly string[];
  readonly keys: readonly string[];
}

export type HubSetState = "new" | "complete";

/** "new" when no member of the set exists, "complete" when all do; anything else is hub-state-mismatch. */
export function inspectStateSet(home: string, set: HubStateSet): HubSetState {
  const members = [set.database, ...set.floors, ...set.keys];
  const present = members.filter((rel) => {
    try {
      lstatSync(join(home, rel));
      return true;
    } catch {
      return false;
    }
  });
  if (present.length === 0) return "new";
  if (present.length === members.length) return "complete";
  const missing = members.filter((m) => !present.includes(m));
  throw new HubStateError("hub-state-mismatch", `Hub state is partial (missing: ${missing.join(", ")}); nothing is recreated`);
}

const COMPONENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Transaction callbacks are synchronous. A thenable result is refused (inside the transaction, so it rolls back), and
 * its eventual settlement is observed so a late rejection is never an unhandled rejection.
 */
function requireSynchronous<T>(result: T, what: string): T {
  if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
    try {
      (result as unknown as PromiseLike<unknown>).then(undefined, () => undefined);
    } catch {
      /* a hostile thenable: refused below either way */
    }
    throw new Error(`Hub ${what} must be synchronous: no awaits inside it`);
  }
  return result;
}

/**
 * Open (or, with `create`, first create) a private SQLite database at `rel` under `home`. The file is created 0600
 * before SQLite touches it; its directory is a private, owned, non-symlink chain (S1's privatePath). WAL/SHM files are
 * checked to be private after the journal mode is set.
 */
export function openHubDatabase(home: string, rel: string, options: { create: boolean }): Database.Database {
  let db: Database.Database | undefined;
  try {
    ensurePrivateDirectory(home, dirname(rel).replaceAll("\\", "/"));
    const path = join(home, rel);
    if (options.create) {
      closeSync(openSync(path, "wx", 0o600));
    } else if (!existsSync(path)) {
      throw new HubStateError("hub-state-mismatch", "the Hub database is missing");
    }
    privatePath(home, rel);
    db = new Database(path, { fileMustExist: true });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("secure_delete = ON");
    db.pragma("synchronous = FULL");
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) privatePath(home, rel + suffix);
    }
    return db;
  } catch (err) {
    db?.close();
    if (err instanceof HubStateError) throw err;
    throw new HubStateError("hub-storage", `the Hub database could not be opened privately: ${(err as Error).message}`);
  }
}

/**
 * Apply every slice's migrations in one immediate transaction. A component stored with a higher version than this
 * build knows, or a component this build does not know at all, means a newer build wrote the database: refuse.
 */
export function applyHubMigrations(db: Database.Database, migrations: readonly HubMigration[]): void {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (!COMPONENT.test(m.component) || !Number.isSafeInteger(m.version) || m.version < 1 || typeof m.up !== "function") {
      throw new HubStateError("hub-storage", `invalid Hub migration ${String(m.component)}`);
    }
    if (seen.has(m.component)) throw new HubStateError("hub-storage", `duplicate Hub migration ${m.component}`);
    seen.add(m.component);
  }
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS hub_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    const stored = new Map(
      (db.prepare("SELECT component, version FROM hub_schema").all() as { component: string; version: number }[]).map((r) => [r.component, r.version]),
    );
    for (const [component, version] of stored) {
      if (!seen.has(component)) throw new HubStateError("hub-state-newer", `the Hub database has "${component}" (v${version}), which this version does not know`);
    }
    for (const m of migrations) {
      const current = stored.get(m.component);
      if (current !== undefined && current > m.version) {
        throw new HubStateError("hub-state-newer", `the Hub database has ${m.component} v${current}; this version knows v${m.version}`);
      }
      if (current === m.version) continue;
      requireSynchronous(m.up(db) as unknown, `migration ${m.component}`);
      db.prepare("INSERT INTO hub_schema(component, version) VALUES(?, ?) ON CONFLICT(component) DO UPDATE SET version = excluded.version").run(m.component, m.version);
    }
  }).immediate();
}

/** The database's Hub (or member's Hub) id: written once at creation, compared on every open. */
export const HUB_INSTANCE_MIGRATION: HubMigration = Object.freeze({
  component: "s5-instance",
  version: 1,
  up(db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS hub_instance (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), hub_id TEXT NOT NULL, created_at INTEGER NOT NULL)");
  },
});

export function bindHubInstance(db: Database.Database, hubId: string, mode: HubSetState, now: number): void {
  const row = db.prepare("SELECT hub_id FROM hub_instance WHERE singleton = 1").get() as { hub_id: string } | undefined;
  if (mode === "new") {
    if (row) throw new HubStateError("hub-state-mismatch", "a new Hub database already has an owner");
    db.prepare("INSERT INTO hub_instance(singleton, hub_id, created_at) VALUES(1, ?, ?)").run(hubId, now);
    return;
  }
  if (!row) throw new HubStateError("hub-state-mismatch", "the Hub database does not say which Hub it belongs to");
  if (row.hub_id !== hubId) throw new HubStateError("hub-state-mismatch", "the Hub database belongs to another Hub");
}

/** Live transactions: a token maps to its database only while its `atomic` callback runs. */
const liveTx = new WeakMap<HubTx, Database.Database>();

/**
 * The database behind a live transaction, for a slice's own statements (S3's repositories). Throws once the
 * transaction has committed or rolled back, so a leaked handle cannot write outside a transaction.
 */
export function hubTxDatabase(tx: HubTx): Database.Database {
  const db = liveTx.get(tx);
  if (!db || !db.inTransaction) throw new Error("Hub transaction is not active");
  return db;
}

/** HubUnitOfWork over one database: immediate transactions; nested calls are savepoints; async work is refused. */
export function createHubUnitOfWork(db: Database.Database): HubUnitOfWork {
  return {
    atomic<T>(work: (tx: HubTx) => T): T {
      const run = db.transaction(() => {
        const tx: HubTx = Object.freeze({ id: randomUUID() });
        liveTx.set(tx, db);
        try {
          return requireSynchronous(work(tx), "transaction (atomic)");
        } finally {
          liveTx.delete(tx);
        }
      });
      return db.inTransaction ? run() : run.immediate();
    },
  };
}
