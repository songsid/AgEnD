/** Read-only persisted clock fence. No resource effects, timers, migration registration or operation permit. */
import type Database from "better-sqlite3";
import type { HubTransportStore } from "../store.js";
import type { PersonKey } from "../types.js";
import { epoch, HubProtocolError, person, uuid, validated } from "../validation.js";
import { personKeyString } from "../identity.js";
import { createHubCanonicalPolicyReader } from "./read.js";
import { parseHubRoleCutoverMarker } from "./cutover-marker.js";
import { inspectHubDirectoryDecisionProof, type HubDirectoryDecisionProof } from "../directory-decision-proof.js";
import type { HubCanonicalPolicy } from "./read.js";
export interface HubRoleClockOptions {
  db: Database.Database; hubId: string; realm: string; generation: string; root: PersonKey;
  transport: Pick<HubTransportStore, "read">; current(): boolean; now?: () => number;
}
export function createHubRoleAuthorizationClock(options: HubRoleClockOptions) {
  const { db, transport, current, realm, generation } = options, hubId = validated(uuid, options.hubId), root = validated(person, options.root);
  const readTransport = transport.read, readState = readTransport.bind(transport), now = options.now ?? Date.now;
  let closed = false;
  const live = () => !closed && current() === true && root.realm === realm && transport.read === readTransport;
  const read = createHubCanonicalPolicyReader({ ...options, current: live });
  const rawMarker = () => {
    const rows = db.prepare("SELECT singleton,body FROM hub_role_cutover").all() as { singleton: number; body: string }[];
    if (rows.length !== 1 || rows[0]!.singleton !== 1) throw new HubProtocolError("unavailable");
    return rows[0]!.body;
  };
  const floor = () => {
    const row = db.prepare("SELECT MAX(settled_at) AS at FROM hub_role_expiry_terms").get() as { at: number | null };
    return row.at === null ? 0 : validated(epoch, row.at);
  };
  const registry = () => {
    const rows = db.prepare("SELECT component,version FROM hub_schema WHERE component IN ('roles-cutover','roles-expiry','roles-writer') ORDER BY component").all();
    if (JSON.stringify(rows) !== JSON.stringify([
      { component: "roles-cutover", version: 1 }, { component: "roles-expiry", version: 1 }, { component: "roles-writer", version: 1 },
    ])) throw new HubProtocolError("unavailable");
  };
  function assertTime(readPolicy: () => HubCanonicalPolicy) {
      try {
        const policy = readPolicy();
        if (policy.kind !== "roles") throw new HubProtocolError("unavailable");
        registry();
        const raw = rawMarker(), { marker } = parseHubRoleCutoverMarker(raw, hubId), settled = floor();
        const owner = db.prepare("SELECT hub_id FROM hub_instance WHERE singleton=1").get() as { hub_id: string } | undefined;
        const state = readState(), at = validated(epoch, now()); // The real transport reader includes its independent floor.
        if (owner?.hub_id !== hubId || personKeyString(marker.root) !== personKeyString(root)
          || marker.realm !== realm || policy.policy.revision < marker.fromRevision
          || validated(epoch, state.revision) < marker.transportRevision
          || validated(epoch, state.revocationVersion) < marker.authorizationVersion
          || at < marker.at || at < settled) throw new HubProtocolError("unavailable");
        // The callbacks above cannot replace the image this clock check just established.
        const confirmed = readState(), confirmedOwner = db.prepare("SELECT hub_id FROM hub_instance WHERE singleton=1").get() as { hub_id: string } | undefined;
        if (!live() || confirmedOwner?.hub_id !== hubId || confirmed.revision !== state.revision || confirmed.revocationVersion !== state.revocationVersion
          || readPolicy().raw !== policy.raw || rawMarker() !== raw || floor() !== settled) throw new HubProtocolError("unavailable");
        registry();
      } catch { throw new HubProtocolError("unavailable"); }
  }
  return {
    assertAuthorizationTime() { assertTime(read); },
    /** Only an active same-DB decision frame may expose the exact own generation rebind. */
    assertDirectoryDecision(proof: HubDirectoryDecisionProof) {
      const scoped = () => {
        if (!live()) throw new HubProtocolError("unavailable");
        const view = inspectHubDirectoryDecisionProof(proof, { db, hubId });
        if (view.before.kind !== "roles" || view.current.kind !== "roles" || view.before.policy.realm !== realm
          || view.before.policy.generation !== generation) throw new HubProtocolError("unavailable");
        return view.current;
      };
      assertTime(scoped);
    },
    close() { closed = true; },
  };
}
