/** Room-only, owner-selected discovery metadata. It conveys no grant or membership. */
import type Database from "better-sqlite3";
import type { HubExposure } from "./types.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError } from "./validation.js";
import type { HubHttpMigration } from "./http/schema.js";
export const HUB_ROOM_AGENT_DISCOVERY_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-room-agent-discovery", version: 1,
  up(db: Database.Database) { db.exec(`CREATE TABLE hub_room_agent_discovery(
    exposure_id TEXT PRIMARY KEY REFERENCES hub_exposures(id) ON DELETE CASCADE,
    owner TEXT NOT NULL, exposure_revision INTEGER NOT NULL CHECK(exposure_revision>0),
    findable INTEGER NOT NULL CHECK(findable IN(0,1)), revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL
  )`); } });
export interface DiscoveryPreference { exposure_id: string; owner: string; exposure_revision: number; findable: number; revision: number; updated_at: number }
export function roomDiscoverySupported(db: Database.Database): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_room_agent_discovery'").get()) return false;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_room_agent_request_settings'").get()) throw new HubProtocolError("unavailable");
  return true;
}
export function roomDiscoverySnapshot(db: Database.Database, e: HubExposure) {
  const preference = db.prepare("SELECT * FROM hub_room_agent_discovery WHERE exposure_id=?").get(e.id) as DiscoveryPreference | undefined;
  const accepting = db.prepare("SELECT accepting,revision FROM hub_room_agent_request_settings WHERE owner=?").get(personKeyString(e.owner)) as { accepting: number; revision: number } | undefined;
  return { preference: preference ?? null, accepting: accepting ?? { accepting: 1, revision: 0 } };
}
export function roomDiscoveryView(db: Database.Database, e: HubExposure) {
  const { preference: p, accepting } = roomDiscoverySnapshot(db, e);
  const findable = p?.owner === personKeyString(e.owner) && p.exposure_revision === e.revision && p.findable === 1;
  const reason = accepting.accepting !== 1 ? "owner-disabled" : e.state === "paused" ? "paused" : e.state !== "published" ? "not-shared" : null;
  return { findable, available: reason === null, ...(reason ? { reason } : {}), revision: p?.revision ?? 0, exposureRevision: e.revision };
}
export function roomFindable(db: Database.Database, e: HubExposure): boolean {
  const view = roomDiscoveryView(db, e); return view.findable && view.available;
}
