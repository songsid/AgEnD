/** Inert stopped ask lists. Only an exact, journaled Undo may copy them into fresh grants. */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonicalArguments, personKeyString, sha256 } from "./identity.js";
import { readExposure } from "./catalog.js";
import type { HubExposurePointer } from "./agent-catalog-model.js";
import type { HubCore } from "./http/core.js";
import type { PersonKey, HubTx } from "./types.js";
export const HUB_SHARING_RETENTION_MIGRATION = Object.freeze({ component: "s3-sharing-retention", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_stopped_ask_lists(exposure_id TEXT PRIMARY KEY,owner TEXT NOT NULL,fleet_id TEXT NOT NULL,generation INTEGER NOT NULL,
    revision INTEGER NOT NULL,stopped_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,image TEXT NOT NULL,grants TEXT NOT NULL,digest TEXT NOT NULL,restored_by TEXT);
    CREATE INDEX hub_stopped_ask_expiry ON hub_stopped_ask_lists(expires_at);`);
} });
export type RetainedGrant = { id: string; revision: number; owner: string; exposure_id: string; exposure_revision: number; approved_by: string; approved_at: number;
  subject: string; subject_kind: string; subject_label: string | null; permissions: string; starts_at: number; expires_at: number; state: string };
const grants = (db: Database.Database, id: string) => db.prepare("SELECT * FROM hub_grants WHERE exposure_id=? ORDER BY id").all(id) as RetainedGrant[];
export function stoppedImage(db: Database.Database, id: string) {
  const exposure = readExposure(db, id);
  return exposure ? { exposure, grants: grants(db, id) } : null;
}
export type StoppedImage = NonNullable<ReturnType<typeof stoppedImage>>;
interface Kept { exposure_id: string; owner: string; fleet_id: string; generation: number; revision: number; stopped_at: number; expires_at: number; image: string; grants: string; digest: string; restored_by: string | null }
/** Must precede grant revocation in the catalog's own transaction. Repeated snapshots never extend the window. */
export function keepStoppedList(db: Database.Database, core: HubCore, id: string, at: number, original?: StoppedImage): void {
  const captured = original ?? stoppedImage(db, id), exposure = captured?.exposure;
  if (!captured || !exposure?.fleet_id || exposure.state === "withdrawn" || exposure.source_kind === "personal") return;
  const fleet = core.deps.store.read().fleets.find(row => row.id === exposure.fleet_id);
  if (!fleet || fleet.status !== "active" || personKeyString(fleet.owner) !== exposure.owner) return;
  const prior = db.prepare("SELECT revision,owner,generation FROM hub_stopped_ask_lists WHERE exposure_id=?").get(id) as Kept | undefined;
  if (prior?.revision === exposure.revision && prior.owner === exposure.owner && prior.generation === fleet.generation) return;
  const image = canonicalArguments(exposure), entries = canonicalArguments(captured.grants);
  db.prepare(`INSERT INTO hub_stopped_ask_lists VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(exposure_id) DO UPDATE SET
    owner=excluded.owner,fleet_id=excluded.fleet_id,generation=excluded.generation,revision=excluded.revision,stopped_at=excluded.stopped_at,
    expires_at=excluded.expires_at,image=excluded.image,grants=excluded.grants,digest=excluded.digest,restored_by=NULL`)
    .run(id, exposure.owner, exposure.fleet_id, fleet.generation, exposure.revision, at, at + 86_400_000, image, entries, sha256(canonicalArguments([image, entries])));
}
/** Coalesced stop+Undo can omit the withdrawn snapshot. Admission evidence is usable only while its exact grants remain. */
export function keepCoalescedList(db: Database.Database, core: HubCore, id: string, at: number, original: StoppedImage): void {
  if (db.prepare("SELECT 1 FROM hub_stopped_ask_lists WHERE exposure_id=? AND revision=?").get(id, original.exposure.revision)) return;
  if (canonicalArguments(grants(db, id)) !== canonicalArguments(original.grants)) return;
  keepStoppedList(db, core, id, at, original);
}
/** Returns pending before the publication arrives, otherwise a definite restored/skipped result. */
export function restoreStoppedList(db: Database.Database, core: HubCore, tx: HubTx, proof: {
  id: string; owner: PersonKey; fleetId: string; generation: number; original: HubExposurePointer; stopped: HubExposurePointer;
  restored: HubExposurePointer; noticeAt: number; undoId: string;
}): "pending" | "restored" | "skipped" {
  const current = readExposure(db, proof.id), owner = personKeyString(proof.owner);
  const fleet = core.deps.store.read().fleets.find(row => row.id === proof.fleetId);
  if (!current || current.owner !== owner || current.fleet_id !== proof.fleetId || !fleet || fleet.status !== "active"
    || fleet.generation !== proof.generation || personKeyString(fleet.owner) !== owner) return "skipped";
  if (current.revision < proof.restored.revision) return "pending";
  const row = db.prepare("SELECT * FROM hub_stopped_ask_lists WHERE exposure_id=?").get(proof.id) as Kept | undefined;
  if (!row || row.owner !== owner || row.fleet_id !== proof.fleetId || row.generation !== proof.generation || row.revision !== proof.original.revision
    || core.now() >= row.expires_at || proof.noticeAt + 86_400_000 <= core.now() || row.restored_by && row.restored_by !== proof.undoId) return "skipped";
  if (row.restored_by === proof.undoId) return "restored";
  if (sha256(canonicalArguments([row.image, row.grants])) !== row.digest) return "skipped";
  const before = JSON.parse(row.image) as StoppedImage["exposure"], previous = JSON.parse(row.grants) as RetainedGrant[];
  if (proof.stopped.id !== proof.id || proof.restored.id !== proof.id || proof.original.id !== proof.id
    || proof.stopped.revision !== proof.original.revision + 1 || proof.restored.revision !== proof.stopped.revision + 1
    || proof.stopped.state !== "withdrawn" || proof.restored.state !== "published"
    || current.revision !== proof.restored.revision || current.state !== "published" || current.frozen_through >= current.revision
    || before.frozen_through >= before.revision || current.frozen_through !== before.frozen_through
    || (current.sharing_epoch ?? 0) !== (before.sharing_epoch ?? 0) || (current.sharing_paused ?? 0) !== (before.sharing_paused ?? 0)) return "skipped";
  const all = grants(db, proof.id);
  const revoked = previous.map(grant => grant.state === "active" ? { ...grant, state: "revoked", revision: grant.revision + 1 } : grant);
  const coalesced = canonicalArguments(all) === canonicalArguments(previous);
  if (!coalesced && canonicalArguments(all) !== canonicalArguments(revoked)) return "skipped";
  // Even coalesced publication cannot keep the old room/history authorization alive.
  db.prepare("UPDATE hub_grants SET state='revoked',revision=revision+1 WHERE exposure_id=? AND state='active'").run(proof.id);
  db.prepare("UPDATE hub_rooms SET state='closed' WHERE exposure_id=? AND state<>'closed'").run(proof.id);
  for (const grant of previous) {
    if (grant.state !== "active" || grant.exposure_revision !== proof.original.revision || grant.expires_at <= core.now()) continue;
    db.prepare(`INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,subject_kind,subject_label,permissions,starts_at,expires_at,state)
      VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,'active')`)
      .run(randomUUID(), owner, proof.id, current.revision, grant.approved_by, core.now(), grant.subject, grant.subject_kind, grant.subject_label,
        grant.permissions, grant.starts_at, grant.expires_at);
  }
  db.prepare("UPDATE hub_stopped_ask_lists SET restored_by=? WHERE exposure_id=?").run(proof.undoId, proof.id);
  core.audit(tx, { requestId: proof.undoId, actor: { kind: "member", fleetId: proof.fleetId }, action: "exposure.stop-undone", result: "completed", exposureId: proof.id, ownerAtEvent: proof.owner });
  return "restored";
}
