import type { HubHttpMigration } from "../http/schema.js";
import type Database from "better-sqlite3";

/** Additive group chat storage; existing direct rooms and their delivery history are unchanged. */
export const HUB_ROOMS_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-rooms", version: 1, up(db: Database.Database) {
  db.exec(`
CREATE TABLE hub_group_rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  all_mention INTEGER NOT NULL DEFAULT 1 CHECK(all_mention IN (0,1)),
  history_for_new TEXT NOT NULL DEFAULT 'since-join' CHECK(history_for_new IN ('since-join','all'))
);
CREATE TABLE hub_room_members (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES hub_group_rooms(id),
  kind TEXT NOT NULL CHECK(kind IN ('person','agent','assistant')), subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('manager','member')), joined_sequence INTEGER NOT NULL,
  read_sequence INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id,kind,subject)
);
CREATE INDEX hub_room_members_subject ON hub_room_members(kind,subject,room_id);
CREATE TABLE hub_room_posts (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES hub_group_rooms(id), sequence INTEGER NOT NULL,
  author_kind TEXT NOT NULL CHECK(author_kind IN ('person','agent','assistant','system')),
  author_id TEXT NOT NULL, author_subject TEXT NOT NULL, author_name TEXT NOT NULL,
  content_ref TEXT NOT NULL, digest TEXT NOT NULL, mentions TEXT NOT NULL, reply_to TEXT,
  idempotency_key TEXT, created_at INTEGER NOT NULL,
  UNIQUE(room_id,sequence), UNIQUE(room_id,author_subject,idempotency_key)
);
CREATE INDEX hub_room_posts_page ON hub_room_posts(room_id,sequence);
CREATE TABLE hub_direct_room_reads (
  room_id TEXT NOT NULL REFERENCES hub_rooms(id), message_id TEXT NOT NULL REFERENCES hub_messages(id),
  answer_id TEXT NOT NULL, PRIMARY KEY(room_id,message_id)
);
`);
} });

/** R2 retained per-agent deliveries. Unknown components keep older binaries from opening this state. */
export const HUB_ROOM_AGENTS_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-room-agents", version: 1, up(db: Database.Database) {
  db.exec(`
ALTER TABLE hub_room_members ADD COLUMN owner_at_join TEXT;
ALTER TABLE hub_room_posts ADD COLUMN answer_to TEXT;
ALTER TABLE hub_room_posts ADD COLUMN delivery_id TEXT;
ALTER TABLE hub_room_posts ADD COLUMN stage TEXT;
CREATE TABLE hub_room_deliveries (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES hub_group_rooms(id),
  parent_id TEXT NOT NULL REFERENCES hub_room_posts(id), reply_id TEXT NOT NULL REFERENCES hub_room_posts(id),
  exposure_id TEXT NOT NULL, exposure_revision INTEGER NOT NULL, fleet_id TEXT NOT NULL, owner TEXT NOT NULL,
  asker TEXT NOT NULL, asker_member TEXT NOT NULL, agent_member TEXT NOT NULL,
  payload_ref TEXT NOT NULL, payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','sent','answered','retired','expired')),
  sent_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  answer_id TEXT, answer_digest TEXT, UNIQUE(parent_id,exposure_id)
);
CREATE INDEX hub_room_deliveries_pending ON hub_room_deliveries(fleet_id,created_at) WHERE state IN ('queued','sent');
CREATE INDEX hub_room_deliveries_parent ON hub_room_deliveries(parent_id);
CREATE INDEX hub_room_deliveries_expiry ON hub_room_deliveries(expires_at) WHERE state IN ('queued','sent');
`);
} });

export const HUB_ROOM_CREATORS_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-room-creators", version: 1, up(db: Database.Database) {
  db.exec("CREATE TABLE hub_room_creators(kind TEXT NOT NULL CHECK(kind IN ('person','team')),subject TEXT NOT NULL,PRIMARY KEY(kind,subject))");
} });

export const HUB_ROOM_ASSISTANT_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-room-assistant", version: 1, up(db: Database.Database) {
  db.exec(`ALTER TABLE hub_group_rooms ADD COLUMN assistant_for TEXT;
CREATE UNIQUE INDEX hub_group_room_assistant_person ON hub_group_rooms(assistant_for) WHERE assistant_for IS NOT NULL;
CREATE TABLE hub_room_assistant_calls(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,parent_id TEXT NOT NULL UNIQUE,reply_id TEXT NOT NULL,
  asker TEXT NOT NULL,asker_member TEXT NOT NULL,assistant_member TEXT NOT NULL,payload_ref TEXT NOT NULL,payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','working','answered','failed')),reason TEXT,created_at INTEGER NOT NULL);
CREATE INDEX hub_room_assistant_queued ON hub_room_assistant_calls(state,created_at) WHERE state='queued';`);
} });

/** Pre-sign-in display feedback must not manufacture hub_people's successful-sign-in witness. */
export const HUB_ROOM_DIRECTORY_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-room-directory", version: 1, up(db: Database.Database) {
  db.exec("CREATE TABLE hub_room_people(person TEXT PRIMARY KEY,display_name TEXT NOT NULL,login_label TEXT NOT NULL,observed_at INTEGER NOT NULL)");
} });
