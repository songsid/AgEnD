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
