/** Add one subject kind without rebuilding the grant parent table or rewriting retained authority/expiry. */
import type Database from "better-sqlite3";
import type { HubHttpMigration } from "../http/schema.js";

export const HUB_TEAM_GRANTS_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-team-grants", version: 1,
  up(db: Database.Database) {
    const columns = new Set((db.prepare("PRAGMA table_info(hub_grants)").all() as { name: string }[]).map(row => row.name));
    if (!columns.has("subject_kind") || columns.has("subject_kind_before_teams")) throw new Error("Incomplete grant subject schema");
    // DROP/replace of the parent table would invalidate retained room foreign keys. Replace only its inline CHECK
    // column. SQLite updates the old CHECK on rename and removes it with that old column; IDs and child tables stay put.
    db.exec(`ALTER TABLE hub_grants RENAME COLUMN subject_kind TO subject_kind_before_teams;
ALTER TABLE hub_grants ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'person' CHECK(subject_kind IN ('person','group','team'));
UPDATE hub_grants SET subject_kind=subject_kind_before_teams;
ALTER TABLE hub_grants DROP COLUMN subject_kind_before_teams;`);
  } });
