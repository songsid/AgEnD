import type Database from "better-sqlite3";

/** App policy and operation bookkeeping; never grants extra room/grant authority. */
export const HUB_MCP_DOOR_MIGRATION = Object.freeze({component:"s3-mcp-door",version:1,up(db:Database.Database) {
  db.exec(`CREATE TABLE hub_mcp_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), everyone INTEGER NOT NULL CHECK(everyone IN (0,1)), subjects TEXT NOT NULL
  ); INSERT INTO hub_mcp_settings VALUES(1,1,0,1,'[]');
  CREATE TABLE hub_mcp_room_policy (room_id TEXT PRIMARY KEY REFERENCES hub_group_rooms(id), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
  CREATE TABLE hub_mcp_room_posts (post_id TEXT PRIMARY KEY REFERENCES hub_room_posts(id), app_id TEXT NOT NULL REFERENCES hub_mcp_apps(id), app_name TEXT NOT NULL);
  CREATE TABLE hub_mcp_direct_questions (message_id TEXT PRIMARY KEY REFERENCES hub_messages(id),app_id TEXT NOT NULL REFERENCES hub_mcp_apps(id),app_name TEXT NOT NULL);
  CREATE TABLE hub_mcp_calls (
    app_id TEXT NOT NULL REFERENCES hub_mcp_apps(id), operation_id TEXT NOT NULL, kind TEXT NOT NULL,
    digest TEXT NOT NULL, room_id TEXT, message_id TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY(app_id,operation_id)
  );
  CREATE TABLE hub_mcp_budgets (person TEXT NOT NULL, kind TEXT NOT NULL, window INTEGER NOT NULL, used INTEGER NOT NULL,
    PRIMARY KEY(person,kind,window));
  CREATE TABLE hub_mcp_rate_notices (person TEXT NOT NULL,room_id TEXT NOT NULL REFERENCES hub_group_rooms(id),window INTEGER NOT NULL,
    refused INTEGER NOT NULL,post_id TEXT REFERENCES hub_room_posts(id),PRIMARY KEY(person,room_id,window));`);
}});
