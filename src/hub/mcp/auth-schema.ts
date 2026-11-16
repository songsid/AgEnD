/** Connector 4c credentials are independent of browser/member credentials; only digests are stored. */
import type Database from "better-sqlite3";

export const HUB_MCP_AUTH_MIGRATION = Object.freeze({
  component: "s3-mcp-auth", version: 1,
  up(db: Database.Database): void {
    db.exec(`CREATE TABLE hub_mcp_clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE hub_mcp_authorizations (
      id_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES hub_mcp_clients(id),
      redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scopes TEXT NOT NULL,
      state TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE hub_mcp_apps (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES hub_mcp_clients(id),
      person TEXT NOT NULL REFERENCES hub_people(person), scopes TEXT NOT NULL,
      resource TEXT NOT NULL, directory_epoch INTEGER NOT NULL,
      created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','ended'))
    );
    CREATE INDEX hub_mcp_apps_person ON hub_mcp_apps(person,state);
    CREATE TABLE hub_mcp_codes (
      code_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES hub_mcp_apps(id),
      redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE hub_mcp_tokens (
      token_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES hub_mcp_apps(id),
      kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at INTEGER NOT NULL
    );
    CREATE INDEX hub_mcp_tokens_app ON hub_mcp_tokens(app_id);`);
  },
});
