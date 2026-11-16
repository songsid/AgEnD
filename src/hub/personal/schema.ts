/** Retained identities stay in place: personal sources never manufacture a Fleet row or Fleet metadata. */
import type Database from "better-sqlite3";
import type { HubHttpMigration } from "../http/schema.js";

export const HUB_PERSONAL_AGENTS_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-personal-agents", version: 1, up(db: Database.Database) {
  db.exec(`
CREATE TABLE hub_personal_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)));
INSERT INTO hub_personal_settings(id) VALUES(1);
CREATE TABLE hub_personal_creators(kind TEXT NOT NULL CHECK(kind IN('person','team')),subject TEXT NOT NULL,PRIMARY KEY(kind,subject));
CREATE TABLE hub_personal_enrollments(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,machine_id TEXT UNIQUE,revoked_at INTEGER,retired_at INTEGER);
CREATE INDEX hub_personal_enrollment_owner ON hub_personal_enrollments(owner,created_at);
CREATE TABLE hub_personal_computers(owner TEXT PRIMARY KEY,machine_id TEXT NOT NULL UNIQUE,enrollment_id TEXT NOT NULL UNIQUE REFERENCES hub_personal_enrollments(id),bound_at INTEGER NOT NULL);
CREATE TABLE hub_personal_agents(
 id TEXT PRIMARY KEY,owner TEXT NOT NULL UNIQUE,machine_id TEXT NOT NULL UNIQUE,
 cli TEXT NOT NULL CHECK(cli IN('codex','claude-code')),model TEXT,
 description TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
`);
  // Rebuilding parent tables would retarget or break retained grants/rooms. Replace the inline NOT NULL
  // columns only, exactly as s3-team-grants does; SQLite leaves parent IDs and inbound FKs unchanged.
  db.exec("DROP INDEX hub_exposures_fleet; DROP INDEX hub_messages_fleet; DROP INDEX hub_room_deliveries_pending");
  for (const [table, columns] of [["hub_exposures", ["fleet_id", "data_view_id", "allowed_tools", "policy_digest"]],
    ["hub_messages", ["fleet_id"]], ["hub_room_deliveries", ["fleet_id"]]] as const) {
    for (const column of columns) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${column} TO ${column}_before_personal;
ALTER TABLE ${table} ADD COLUMN ${column} TEXT;
UPDATE ${table} SET ${column}=${column}_before_personal;
ALTER TABLE ${table} DROP COLUMN ${column}_before_personal;`);
  }
  db.exec(`
ALTER TABLE hub_exposures ADD COLUMN personal_agent_id TEXT REFERENCES hub_personal_agents(id);
ALTER TABLE hub_exposures ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'fleet' CHECK(
 (source_kind='fleet' AND fleet_id IS NOT NULL AND data_view_id IS NOT NULL AND allowed_tools IS NOT NULL AND policy_digest IS NOT NULL AND personal_agent_id IS NULL)
 OR (source_kind='personal' AND fleet_id IS NULL AND data_view_id IS NULL AND allowed_tools IS NULL AND policy_digest IS NULL AND personal_agent_id IS NOT NULL)
);
CREATE UNIQUE INDEX hub_exposures_personal ON hub_exposures(personal_agent_id) WHERE personal_agent_id IS NOT NULL;
CREATE INDEX hub_exposures_fleet ON hub_exposures(fleet_id);
CREATE INDEX hub_messages_fleet ON hub_messages(fleet_id,stage);
CREATE INDEX hub_room_deliveries_pending ON hub_room_deliveries(fleet_id,created_at) WHERE state IN('queued','sent');
CREATE TABLE hub_personal_jobs(
 id TEXT PRIMARY KEY,personal_agent_id TEXT NOT NULL REFERENCES hub_personal_agents(id),
 direct_message_id TEXT UNIQUE REFERENCES hub_messages(id) ON DELETE CASCADE,
 room_delivery_id TEXT UNIQUE REFERENCES hub_room_deliveries(id) ON DELETE CASCADE,
 machine_id TEXT NOT NULL,machine_generation INTEGER,owner TEXT NOT NULL,exposure_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('queued','working','answered','failed')),reason TEXT,
 created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,
 CHECK((direct_message_id IS NOT NULL AND room_delivery_id IS NULL) OR (direct_message_id IS NULL AND room_delivery_id IS NOT NULL))
);
CREATE INDEX hub_personal_jobs_queue ON hub_personal_jobs(state,created_at);
CREATE TABLE hub_personal_mention_refusals(post_id TEXT PRIMARY KEY REFERENCES hub_room_posts(id) ON DELETE CASCADE,
 source_exposure_id TEXT NOT NULL,id TEXT NOT NULL UNIQUE,content_ref TEXT NOT NULL,digest TEXT NOT NULL);
`);
} });
