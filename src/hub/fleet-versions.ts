/** Phase 1 diagnostics, never update authority. Reports are values from an authenticated Fleet. */
import { compareSemver, isExactVersion } from "../update-check.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError, validated } from "./validation.js";
import type { HubCore } from "./http/core.js";
import type { HubLinkContext } from "./server.js";
import type { HubFleetInfo } from "./types.js";

import { HUB_FLEET_INFO_CAPABILITY, fleetInfoSchema, warnFleetDiagnostics } from "./fleet-info.js";
export const HUB_FLEET_VERSIONS_MIGRATION = Object.freeze({ component: "s3-fleet-versions", version: 1, up(db: import("better-sqlite3").Database) {
  db.exec(`CREATE TABLE hub_fleet_versions (
    fleet_id TEXT PRIMARY KEY, version TEXT, runs_as_service INTEGER CHECK(runs_as_service IN (0,1)),
    version_reported_at INTEGER, last_connected_at INTEGER NOT NULL, capabilities TEXT NOT NULL
  )`);
} });
export type HubFleetVersionState = "too-old-rooms" | "needs-update" | "unknown" | "current";
export interface HubFleetVersionView { version: string | null; runsAsService: boolean | null; versionReportedAt: number | null;
  lastConnectedAt: number | null; connected: boolean; versionState: HubFleetVersionState }
/** No recommendation until phase 2 is configured. Capability absence wins over version comparison. */
export function fleetVersionState(version: string | null, capabilities: readonly string[] | null, recommendedVersion: string | null): HubFleetVersionState {
  if (capabilities && (!capabilities.includes("welcome-caps-v1") || !capabilities.includes("room-ask-v1"))) return "too-old-rooms";
  if (!version || !isExactVersion(version)) return "unknown";
  if (recommendedVersion && compareSemver(version, recommendedVersion) === -1) return "needs-update";
  return "current";
}
interface Row { version: string | null; runs_as_service: number | null; version_reported_at: number | null; last_connected_at: number; capabilities: string }
export class HubFleetVersions {
  private readonly links = new Map<string, HubLinkContext>();
  constructor(private readonly core: HubCore) {}
  private eligible(link: HubLinkContext): boolean {
    if (!link.current()) throw new HubProtocolError("stale");
    const fleet = this.core.deps.store.read().fleets.find(f => f.id === link.fleetId);
    return !!fleet && fleet.status === "active" && personKeyString(fleet.owner) === personKeyString(link.owner);
  }
  connected(link: HubLinkContext): void {
    if (this.links.get(link.fleetId) === link) return;
    try {
      // Legacy injected transports sometimes have no stored Fleet. Never invent one for diagnostics.
      if (!this.eligible(link)) return;
      // Observe the live connection even if its optional SQL write fails; do not retry that write on every frame.
      this.links.set(link.fleetId, link);
      this.core.atomic(db => {
        if (!this.eligible(link)) throw new HubProtocolError("revoked");
        db.prepare(`INSERT INTO hub_fleet_versions(fleet_id,last_connected_at,capabilities) VALUES(?,?,?)
          ON CONFLICT(fleet_id) DO UPDATE SET last_connected_at=excluded.last_connected_at, capabilities=excluded.capabilities`)
          .run(link.fleetId, this.core.now(), JSON.stringify([...link.features]));
      });
    } catch { warnFleetDiagnostics(this.core.deps.log, link.fleetId, "connect"); }
  }
  report(value: unknown, link: HubLinkContext): void {
    const info: HubFleetInfo = validated(fleetInfoSchema, value);
    if (!link.features.has("welcome-caps-v1") || !link.features.has(HUB_FLEET_INFO_CAPABILITY)) throw new HubProtocolError("incompatible");
    if (!this.eligible(link)) throw new HubProtocolError("revoked");
    this.connected(link);
    this.core.atomic(db => {
      if (!this.eligible(link) || this.links.get(link.fleetId) !== link) throw new HubProtocolError("stale");
      db.prepare("UPDATE hub_fleet_versions SET version=?,runs_as_service=?,version_reported_at=? WHERE fleet_id=?")
        .run(info.version, info.runsAsService ? 1 : 0, this.core.now(), link.fleetId);
    });
  }
  view(fleetId: string, recommendedVersion: string | null = null, batchDb?: import("better-sqlite3").Database): HubFleetVersionView {
    const read = <T>(work: (db: import("better-sqlite3").Database) => T): T => batchDb ? work(batchDb) : this.core.atomic(work);
    return read(db => {
      const row = db.prepare("SELECT * FROM hub_fleet_versions WHERE fleet_id=?").get(fleetId) as Row | undefined;
      const connected = this.links.get(fleetId)?.current() === true;
      return { version: row?.version ?? null, runsAsService: row?.runs_as_service == null ? null : row.runs_as_service === 1,
        versionReportedAt: row?.version_reported_at ?? null, lastConnectedAt: row?.last_connected_at ?? null, connected,
        versionState: fleetVersionState(row?.version ?? null, row ? JSON.parse(row.capabilities) as string[] : null, recommendedVersion) };
    });
  }
  close(): void { this.links.clear(); }
}
