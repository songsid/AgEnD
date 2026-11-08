/** #3425: browser authority is separate from the member transport's revocationVersion. No I/O on import. */
import type Database from "better-sqlite3";
import { HubProtocolError } from "./validation.js";

/** Required schema: an older binary must refuse this component instead of ignoring browser authority. */
export const HUB_SESSION_EPOCH_MIGRATION = Object.freeze({
  component: "s3-session-epoch", version: 1,
  up(db: Database.Database): void {
    const column = (db.prepare("PRAGMA table_info(hub_sessions)").all() as { name: string }[]).some(c => c.name === "directory_epoch");
    const table = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_directory_epoch'").get();
    if (column !== table) throw new HubProtocolError("uncertain");
    if (!table) {
      db.exec(`CREATE TABLE hub_directory_epoch(singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL CHECK(epoch>=0));
        INSERT INTO hub_directory_epoch VALUES(1,0);
        ALTER TABLE hub_sessions ADD COLUMN directory_epoch INTEGER NOT NULL DEFAULT 0 CHECK(directory_epoch>=0)`);
    }
    // A lost existing row is never recreated at zero. Migration retries cannot revive earlier cookies.
    readHubSessionEpoch(db);
  },
});

export function readHubSessionEpoch(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT epoch FROM hub_directory_epoch WHERE singleton=1").get() as { epoch: number } | undefined;
    if (!row || !Number.isSafeInteger(row.epoch) || row.epoch < 0) throw new HubProtocolError("uncertain");
    return row.epoch;
  } catch { throw new HubProtocolError("uncertain"); }
}

/**
 * Only the future settings-v2 decision's owning transaction calls this; it does NOT start/commit a transaction,
 * authorize a change, write a file, or replace the shared sealed writer. The caller owns audit, floor, operation,
 * binding, material and complete notice rows in that SAME decision. Actor rotation, if any, inserts a fresh row
 * afterward in that transaction; no old token or recent-auth proof is carried forward.
 */
export function advanceHubSessionEpoch(db: Database.Database, expected: number): number {
  if (!db.inTransaction || !Number.isSafeInteger(expected) || expected < 0) throw new HubProtocolError("invalid");
  if (readHubSessionEpoch(db) !== expected) throw new HubProtocolError("conflict");
  const next = expected + 1;
  if (!Number.isSafeInteger(next)) throw new HubProtocolError("unavailable");
  const result = db.prepare("UPDATE hub_directory_epoch SET epoch=? WHERE singleton=1 AND epoch=?").run(next, expected);
  if (result.changes !== 1) throw new HubProtocolError("conflict");
  db.prepare("UPDATE hub_sessions SET state='ended' WHERE directory_epoch<=? AND state='active'").run(expected);
  return next;
}
