import { readHubSqlRow, readHubSqlRows } from "../read-statement.js";
/** Read-only persisted clock fence. No resource effects, timers, migration registration or operation permit. */
import type Database from "better-sqlite3";
import type { HubTransportStore } from "../store.js";
import type { PersonKey } from "../types.js";
import { epoch, HubProtocolError, person, uuid, validated } from "../validation.js";
import { personKeyString } from "../identity.js";
import type { HubCanonicalPolicy } from "./read.js";
import { createHubCanonicalPolicyReader } from "./read.js";
import { parseHubRoleCutoverMarker } from "./cutover-marker.js";
export interface HubRoleClockOptions {
  db: Database.Database; hubId: string; realm: string; generation: string; root: PersonKey;
  transport: Pick<HubTransportStore, "read"> & Partial<Pick<HubTransportStore, "readVersion">>; current(): boolean; now?: () => number;
  /** Internal composition: the exact old policy only during its synchronous owned directory decision. */
  policy?(): HubCanonicalPolicy;
}
export function createHubRoleAuthorizationClock(options: HubRoleClockOptions) {
  const { db, transport, current, realm } = options, hubId = validated(uuid, options.hubId), root = validated(person, options.root);
  const readTransport = transport.read, readVersion = transport.readVersion;
  const readState = readVersion ? readVersion.bind(transport) : readTransport.bind(transport), now = options.now ?? Date.now;
  let closed = false;
  const live = () => !closed && current() === true && root.realm === realm && transport.read === readTransport && transport.readVersion === readVersion;
  const read = options.policy ?? createHubCanonicalPolicyReader({ ...options, current: live });
  const rawMarker = () => {
    const rows = readHubSqlRows(db, "SELECT singleton,body FROM hub_role_cutover") as { singleton: number; body: string }[];
    if (rows.length !== 1 || rows[0]!.singleton !== 1) throw new HubProtocolError("unavailable");
    return rows[0]!.body;
  };
  const floor = () => {
    const row = readHubSqlRow(db, "SELECT MAX(settled_at) AS at FROM hub_role_expiry_terms") as { at: number | null };
    return row.at === null ? 0 : validated(epoch, row.at);
  };
  const registry = () => {
    const rows = readHubSqlRows(db, "SELECT component,version FROM hub_schema WHERE component IN ('roles-cutover','roles-expiry','roles-writer') ORDER BY component");
    if (JSON.stringify(rows) !== JSON.stringify([
      { component: "roles-cutover", version: 1 }, { component: "roles-expiry", version: 1 }, { component: "roles-writer", version: 1 },
    ])) throw new HubProtocolError("unavailable");
  };
  return {
    assertAuthorizationTime() {
      try {
        const policy = read();
        if (policy.kind !== "roles") throw new HubProtocolError("unavailable");
        registry();
        const raw = rawMarker(), { marker } = parseHubRoleCutoverMarker(raw, hubId), settled = floor();
        const owner = readHubSqlRow(db, "SELECT hub_id FROM hub_instance WHERE singleton=1") as { hub_id: string } | undefined;
        const state = readState(), at = validated(epoch, now()); // The real transport reader includes its independent floor.
        if (owner?.hub_id !== hubId || personKeyString(marker.root) !== personKeyString(root)
          || marker.realm !== realm || policy.policy.revision < marker.fromRevision
          || validated(epoch, state.revision) < marker.transportRevision
          || validated(epoch, state.revocationVersion) < marker.authorizationVersion
          || at < marker.at || at < settled) throw new HubProtocolError("unavailable");
        // The callbacks above cannot replace the image this clock check just established.
        const confirmed = readState(), confirmedOwner = readHubSqlRow(db, "SELECT hub_id FROM hub_instance WHERE singleton=1") as { hub_id: string } | undefined;
        if (!live() || confirmedOwner?.hub_id !== hubId || confirmed.revision !== state.revision || confirmed.revocationVersion !== state.revocationVersion
          || read().raw !== policy.raw || rawMarker() !== raw || floor() !== settled) throw new HubProtocolError("unavailable");
        registry();
      } catch { throw new HubProtocolError("unavailable"); }
    },
    close() { closed = true; },
  };
}
