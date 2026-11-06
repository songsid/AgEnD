/**
 * AgEnD Hub P1, slice 3: S3's own tables in the Hub server DB (`hub/hub.sqlite`), as S5 `HubMigration`s (component
 * "s3-http"). Nothing migrates on import; S5 runs `up` inside its immediate migration transaction.
 *
 * No question or answer text lives here: rooms keep S5 content refs (encrypted under content.key). Session and CSRF
 * secrets are kept only as SHA-256 digests.
 */
import type Database from "better-sqlite3";
import { HUB_BUTTONS_MIGRATION } from "../buttons.js";

export interface HubHttpMigration { readonly component: string; readonly version: number; up(db: Database.Database): void }

const V1 = `
CREATE TABLE hub_people (
  person TEXT PRIMARY KEY,                       -- personKeyString(key)
  realm TEXT NOT NULL, object_id TEXT NOT NULL,
  display_name TEXT NOT NULL, login_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled','unknown')),
  last_checked_at INTEGER NOT NULL
);
CREATE INDEX hub_people_login ON hub_people(login_label);
CREATE TABLE hub_sessions (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  person TEXT NOT NULL REFERENCES hub_people(person),
  created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','ended'))
);
CREATE INDEX hub_sessions_person ON hub_sessions(person, state);
CREATE TABLE hub_catalog_cursor (
  fleet_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE hub_exposures (
  id TEXT PRIMARY KEY, fleet_id TEXT NOT NULL, owner TEXT NOT NULL,
  display_name TEXT NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('published','withdrawn','frozen')),
  data_view_id TEXT NOT NULL, allowed_tools TEXT NOT NULL, policy_digest TEXT NOT NULL,
  frozen_through INTEGER NOT NULL DEFAULT -1,     -- a Hub-side freeze holds every revision up to this one
  updated_at INTEGER NOT NULL
);
CREATE INDEX hub_exposures_owner ON hub_exposures(owner);
CREATE INDEX hub_exposures_fleet ON hub_exposures(fleet_id);
CREATE TABLE hub_grants (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, owner TEXT NOT NULL,
  exposure_id TEXT NOT NULL REFERENCES hub_exposures(id), exposure_revision INTEGER NOT NULL,
  approved_by TEXT NOT NULL, approved_at INTEGER NOT NULL, subject TEXT NOT NULL,
  permissions TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked'))
);
CREATE INDEX hub_grants_subject ON hub_grants(subject, state);
CREATE INDEX hub_grants_exposure ON hub_grants(exposure_id, state);
CREATE TABLE hub_rooms (
  id TEXT PRIMARY KEY, asker TEXT NOT NULL, exposure_id TEXT NOT NULL, owner_at_creation TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES hub_grants(id),
  state TEXT NOT NULL CHECK (state IN ('active','held','closed')), created_at INTEGER NOT NULL,
  UNIQUE (asker, exposure_id, grant_id)
);
CREATE TABLE hub_messages (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES hub_rooms(id),
  idempotency_key TEXT NOT NULL, sequence INTEGER NOT NULL,
  fleet_id TEXT NOT NULL, exposure_id TEXT NOT NULL, exposure_revision INTEGER NOT NULL,
  grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, asker TEXT NOT NULL, owner TEXT NOT NULL,
  content_digest TEXT NOT NULL, question_ref TEXT NOT NULL,
  stage TEXT NOT NULL, member_sequence INTEGER NOT NULL DEFAULT 0, reason_code TEXT, stage_at INTEGER NOT NULL,
  sent_epoch INTEGER NOT NULL DEFAULT 0,
  answer_id TEXT, answer_digest TEXT, answer_ref TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  UNIQUE (room_id, idempotency_key), UNIQUE (room_id, sequence)
);
CREATE INDEX hub_messages_fleet ON hub_messages(fleet_id, stage);
CREATE TABLE hub_receipts (
  fleet_id TEXT NOT NULL, sequence INTEGER NOT NULL, message_id TEXT NOT NULL, content_digest TEXT NOT NULL,
  stage TEXT NOT NULL, at INTEGER NOT NULL, member_delivery_id TEXT, reason_code TEXT,
  PRIMARY KEY (fleet_id, sequence)
);
CREATE TABLE hub_leases (
  decision_id TEXT PRIMARY KEY, fleet_id TEXT NOT NULL, link_epoch INTEGER NOT NULL,
  message_id TEXT NOT NULL, operation_id TEXT NOT NULL, phase TEXT NOT NULL, operation_digest TEXT NOT NULL,
  exposure_revision INTEGER NOT NULL, revocation_version INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX hub_leases_message ON hub_leases(message_id);
`;

export const HUB_HTTP_MIGRATIONS: readonly HubHttpMigration[] = Object.freeze([
  Object.freeze({ component: "s3-http" as const, version: 1, up: (db: Database.Database) => { db.exec(V1); } }),
  HUB_BUTTONS_MIGRATION,
]);
