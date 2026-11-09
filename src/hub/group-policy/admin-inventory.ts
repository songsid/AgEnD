/** Current ordinary resources, independent of group-policy state. Never revive a withdrawn/revoked/replaced resource. */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { exposureOf, readExposure } from "../catalog.js";
import { personKeyString } from "../identity.js";
import type { HubTransportStore } from "../store.js";
import type { PersonKey } from "../types.js";
import { parseStrictJson } from "../validation.js";
import { parseHubGroupResource, type HubGroupResource, type HubGroupResourceView } from "./resources.js";
import { HubGroupPolicyError } from "./store.js";
import type { GroupImpactResource, GroupResumeRequest } from "./admin-dto.js";

export interface HubGroupInventoryItem {
  readonly resource: HubGroupResource;
  /** Exact ordinary binding/material; labels alone never retarget a resume. */
  readonly fingerprint: string;
  readonly display: GroupImpactResource;
}
export function createHubGroupAdminInventory(options: { db: Database.Database; transport: Pick<HubTransportStore, "read">; realm: string }) {
  const { db, transport, realm } = options;
  const ledger = (input: GroupResumeRequest["resource"]): HubGroupResourceView | null => {
    const raw = db.prepare("SELECT body,source,state,revision FROM hub_group_resources WHERE resource_key=?")
      .get(JSON.stringify([input.kind, input.id, input.revision])) as { body: string; source: string; state: string; revision: number } | undefined;
    if (!raw) return null;
    const resource = parseHubGroupResource(parseStrictJson(raw.body));
    if (resource.kind !== input.kind || resource.id !== input.id || resource.revision !== input.revision || resource.owner.realm !== realm
      || !["group", "manual"].includes(raw.source) || !["active", "suspended"].includes(raw.state)
      || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new HubGroupPolicyError("unavailable");
    return { resource, source: raw.source as HubGroupResourceView["source"], state: raw.state as HubGroupResourceView["state"], revision: raw.revision };
  };
  const name = (owner: PersonKey) => (db.prepare("SELECT display_name FROM hub_people WHERE person=?").get(personKeyString(owner)) as
    { display_name: string } | undefined)?.display_name ?? null;
  const current = (input: GroupResumeRequest["resource"]): HubGroupInventoryItem | null => {
    let resource: HubGroupResource, material: unknown, label: string | null = null;
    if (input.kind === "fleet") {
      const fleet = transport.read().fleets.find(f => f.id === input.id);
      if (!fleet || fleet.status !== "active" || fleet.generation !== input.revision || !fleet.credentialHash) return null;
      resource = parseHubGroupResource({ ...input, owner: fleet.owner }); material = fleet;
    } else if (input.kind === "exposure") {
      const raw = readExposure(db, input.id); if (!raw) return null;
      const exposure = exposureOf(raw), fleet = transport.read().fleets.find(f => f.id === exposure.fleetId);
      if (exposure.state !== "published" || exposure.revision !== input.revision || !fleet || fleet.status !== "active" || !fleet.credentialHash
        || personKeyString(fleet.owner) !== personKeyString(exposure.owner)) return null;
      resource = parseHubGroupResource({ ...input, owner: exposure.owner }); material = { exposure, fleet }; label = exposure.displayName;
    } else {
      // Asker provenance can only have been registered for this canonical immutable person.
      const row = ledger(input); if (!row || input.revision !== 1 || row.resource.owner.objectId !== input.id) return null;
      resource = row.resource; material = resource;
    }
    if (resource.owner.realm !== realm) throw new HubGroupPolicyError("unavailable");
    return { resource, fingerprint: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
      display: { ...input, label, owner: { name: name(resource.owner) } } };
  };
  return { current, ledger,
    paused() {
      const result: { item: HubGroupInventoryItem; lifecycleRevision: number }[] = [];
      const rows = db.prepare("SELECT body FROM hub_group_resources WHERE state='suspended' ORDER BY resource_key").all() as { body: string }[];
      for (const raw of rows) {
        const resource = parseHubGroupResource(parseStrictJson(raw.body)), item = current(resource), row = ledger(resource);
        if (item && row?.state === "suspended") {
          if (JSON.stringify(item.resource) !== JSON.stringify(row.resource)) throw new HubGroupPolicyError("unavailable");
          result.push({ item, lifecycleRevision: row.revision });
        }
      }
      return result;
    },
  };
}
export type HubGroupAdminInventory = ReturnType<typeof createHubGroupAdminInventory>;
