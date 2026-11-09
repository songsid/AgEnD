/** Durable outcome of the original bounded mount intent; never a request to restore a database or security state. */
import type Database from "better-sqlite3";
import type { HubMigration } from "./db.js";
import type { HubDirectorySettingsOperation } from "./settings-directory-decision.js";
import { HubProtocolError } from "./validation.js";

export const HUB_DIRECTORY_RECOVERY_MIGRATION: HubMigration = {
  component: "s5-directory-mount-intent", version: 1,
  up(db) {
    db.exec(`CREATE TABLE hub_settings_mount_recovery(
      operation_id TEXT PRIMARY KEY REFERENCES hub_settings_operations(id),
      expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
      state TEXT NOT NULL CHECK(state IN ('pending','ready','compensated')),
      completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= 0),
      CHECK((state='pending') = (completed_at IS NULL)))`);
  },
};
export interface HubDirectoryRecoveryIntent {
  operation: HubDirectorySettingsOperation;
  expiresAt: number;
  state: "pending" | "ready" | "compensated";
  completedAt: number | null;
}
export function readHubDirectoryRecoveryIntent(db: Database.Database, operation: HubDirectorySettingsOperation): HubDirectoryRecoveryIntent | null {
  if (!operation.recovery) return null; // Old/internal decisions never acquire an implicit recovery allowance.
  const row = db.prepare("SELECT expires_at,state,completed_at FROM hub_settings_mount_recovery WHERE operation_id=?").get(operation.id) as
    { expires_at: number; state: HubDirectoryRecoveryIntent["state"]; completed_at: number | null } | undefined;
  if (!row || operation.kind !== "directory" || row.expires_at !== operation.recovery.expiresAt
    || !["pending", "ready", "compensated"].includes(row.state)
    || (row.state === "pending" ? row.completed_at !== null : !Number.isSafeInteger(row.completed_at) || row.completed_at! < operation.at)) {
    throw new HubProtocolError("uncertain");
  }
  return { operation: structuredClone(operation), expiresAt: row.expires_at, state: row.state, completedAt: row.completed_at };
}
export function assertHubDirectoryRecoveryClock(operation: Pick<HubDirectorySettingsOperation, "recovery" | "at">, now: unknown): asserts now is number {
  if (!operation.recovery || !Number.isSafeInteger(now) || (now as number) < operation.at || (now as number) >= operation.recovery.expiresAt) {
    throw new HubProtocolError("revoked");
  }
}
