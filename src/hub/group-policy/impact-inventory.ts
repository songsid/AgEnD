/** Server-local confirmation inventory. Directory identities never come from display labels or a browser list. */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { HubTransportStore } from "../store.js";
import type { PersonKey } from "../types.js";
import { grantApplies, grantOf, readExposure, exposureOf } from "../catalog.js";
import { personFromString } from "../http/core.js";
import { personKeyString } from "../identity.js";
import { parseStrictJson, person, validated } from "../validation.js";
import { parseHubGroupResource } from "./resources.js";
import { HubGroupPolicyError } from "./store.js";
import type { HubGroupAdminInventory } from "./admin-inventory.js";
import type { HubGroupImpactPerson, HubGroupImpactResource } from "./admin-impact.js";

export function createHubGroupImpactInventory(options: {
  db: Database.Database; transport: Pick<HubTransportStore, "read">; administrator: PersonKey;
  inventory: HubGroupAdminInventory; current(): boolean; now(): number;
}) {
  const { db, transport, inventory, current, now } = options, administrator = validated(person, options.administrator);
  return { snapshot() {
    if (current() !== true) throw new HubGroupPolicyError("unavailable");
    const people = new Map<string, HubGroupImpactPerson>(), resources = new Map<string, HubGroupImpactResource>(), ordinary: unknown[] = [];
    const labels = new Map((db.prepare("SELECT person,display_name,login_label FROM hub_people").all() as { person: string; display_name: string; login_label: string }[])
      .map(row => [row.person, row]));
    const addPerson = (input: PersonKey, hasAskGrant = false) => {
      const key = validated(person, input), id = personKeyString(key);
      if (key.realm !== administrator.realm) throw new HubGroupPolicyError("unavailable");
      const before = people.get(id), label = labels.get(id);
      people.set(id, { key, name: label?.display_name ?? null, login: label?.login_label ?? null, hasAskGrant: before?.hasAskGrant === true || hasAskGrant });
    };
    // Known Hub people only: never enumerate or export the directory.
    for (const id of labels.keys()) addPerson(personFromString(id));
    addPerson(administrator);
    const addResource = (input: Parameters<HubGroupAdminInventory["current"]>[0]) => {
      const item = inventory.current(input); if (!item) return;
      const row = inventory.ledger(input);
      if (row && JSON.stringify(row.resource) !== JSON.stringify(item.resource)) throw new HubGroupPolicyError("unavailable");
      const key = JSON.stringify([input.kind, input.id, input.revision]);
      if (resources.has(key)) return;
      addPerson(item.resource.owner); ordinary.push([key, item.fingerprint]);
      resources.set(key, { resource: item.resource, display: item.display,
        lifecycle: row ? { source: row.source, state: row.state, revision: row.revision } : null });
    };
    for (const fleet of transport.read().fleets) if (fleet.status === "active" && fleet.credentialHash) addResource({ kind: "fleet", id: fleet.id, revision: fleet.generation });
    for (const row of db.prepare("SELECT id,revision FROM hub_exposures WHERE state='published' ORDER BY id").all() as { id: string; revision: number }[]) addResource({ kind: "exposure", ...row });
    for (const row of db.prepare("SELECT body FROM hub_group_resources ORDER BY resource_key").all() as { body: string }[]) {
      const resource = parseHubGroupResource(parseStrictJson(row.body));
      if (resource.kind === "asker") addResource(resource);
    }
    const grants: unknown[] = [], at = now();
    for (const row of db.prepare("SELECT * FROM hub_grants WHERE state='active' AND starts_at<=? AND expires_at>? ORDER BY id").all(at, at) as Parameters<typeof grantOf>[0][]) {
      const grant = grantOf(row), exposure = readExposure(db, grant.exposureId); if (!exposure) continue;
      const currentExposure = exposureOf(exposure), subject = validated(person, grant.subject.person);
      if (currentExposure.state !== "published" || !inventory.current({ kind: "exposure", id: exposure.id, revision: exposure.revision })
        || !grantApplies(grant, currentExposure, subject, at)) continue;
      addPerson(subject, true); grants.push(grant);
    }
    if (current() !== true) throw new HubGroupPolicyError("unavailable");
    const persons = [...people].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p);
    const entries = [...resources].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
    ordinary.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const ordinaryFingerprint = digest({ people: persons, resources: ordinary, grants });
    return { people: persons, resources: entries, ordinaryFingerprint,
      fingerprint: digest({ ordinaryFingerprint, lifecycle: entries.map(e => [e.resource, e.lifecycle]) }) };
  } };
}
