import {readRequestContextResolutionHistory,requestContextResolutionHistoriesEqual} from "./request-context-resolution.js";
import {contactRetirementImage} from "./contact-auth-store.js";
/** The activation transaction is authoritative for Go back; retained.json is only a projection. */
import type Database from "better-sqlite3";
import { z } from "zod";
import { activateRequestContextBarrier, assertRequestContextCompatibility } from "./request-context-compatibility.js";
import type { RequestContextActivationLease } from "./request-context-update-guard.js";

export const REQUEST_CONTEXT_ACTIVATIONS_TABLE = "request_context_activations_v1";
const attemptId = z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
const time = z.number().int().nonnegative().safe();
const record = z.strictObject({ epoch: z.string().min(1).max(256), owner: z.string().min(1).max(256), activatedAt: time,
  invalidates: z.array(attemptId).max(1024), offeredLatestDeadline: time.nullable() }).superRefine((r, ctx) => {
  if (new Set(r.invalidates).size !== r.invalidates.length || JSON.stringify([...r.invalidates].sort()) !== JSON.stringify(r.invalidates)
    || (r.invalidates.length === 0) !== (r.offeredLatestDeadline === null)) ctx.addIssue({ code: "custom", message: "Invalid Go back offer" });
});
export type RequestContextActivationRecord = z.infer<typeof record>;
/** Uses an already confined, read-only outbox handle. Unreadable or malformed means refusal, never no activation. */
export function readRequestContextActivations(db: Database.Database): readonly RequestContextActivationRecord[] {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(REQUEST_CONTEXT_ACTIVATIONS_TABLE) as { type: string } | undefined;
  const floor = db.prepare("SELECT 1 FROM sqlite_master WHERE name='request_context_compatibility'").get();
  if (!table) { if (floor) throw Error("Activation history unavailable"); return []; }
  if (table.type !== "table" || !floor) throw Error("Invalid activation history");
  assertRequestContextCompatibility(db, 1);
  const rows = db.prepare(`SELECT epoch,owner,activated_at,invalidates_json,offered_latest_deadline FROM ${REQUEST_CONTEXT_ACTIVATIONS_TABLE} ORDER BY activated_at,epoch LIMIT 1025`).all() as Array<{
    epoch: string; owner: string; activated_at: number; invalidates_json: string; offered_latest_deadline: number | null;
  }>;
  if (!rows.length || rows.length > 1024) throw Error("Invalid activation history");
  return rows.map(r => record.parse({ epoch: r.epoch, owner: r.owner, activatedAt: r.activated_at,
    invalidates: JSON.parse(r.invalidates_json), offeredLatestDeadline: r.offered_latest_deadline }));
}
/**
 * Before any restore, under updater locks and the EXCLUSIVE lease, pass a manifest-hash-verified private copy of the actual snapshot, opened readonly.
 * Never open the immutable snapshot in place: even readonly WAL opens can create sidecars.
 * A timestamp cannot prove ordering: a backwards clock can stamp a pre-activation commit later than activation.
 * Only preservation of the live activation history proves that restoration will not erase the version floor.
 */
export function requestContextGoBackAllowed(db: Database.Database, id: string, committedAt: number,
  snapshotDb?: Database.Database): boolean {
  attemptId.parse(id); time.parse(committedAt); // Audit metadata only; never evidence for permission.
  const live = readRequestContextActivations(db);
  if (live.some(r => r.invalidates.includes(id))) return false;
  const retirements=contactRetirementImage(db);
  if (!live.length) {
    if(readRequestContextResolutionHistory(db).guard)throw Error("Resolution without activation history");
    // Legacy ticket retirement precedes first On. It still must never be undone
    // by restoring an older snapshot, even when there is no activation to compare.
    if(!snapshotDb)return retirements==="none";
    return snapshotDb!==db&&snapshotDb.readonly&&retirements===contactRetirementImage(snapshotDb);
  }
  if (!snapshotDb || snapshotDb === db || !snapshotDb.readonly) return false;
  const snapshot = readRequestContextActivations(snapshotDb);
  return JSON.stringify(live) === JSON.stringify(snapshot) && requestContextResolutionHistoriesEqual(db,snapshotDb)
    && retirements===contactRetirementImage(snapshotDb);
}
/**
 * Dormant assembly primitive. The caller stages every owner before this, and supplies freshly rechecked readiness
 * and the exact confirmed Go back offer. Floor, epoch, owner and invalidation are one SQLite COMMIT, including when
 * nested in the owning transaction. Failure anywhere leaves no partial activation or Go back invalidation.
 */
export function commitRequestContextActivation(db: Database.Database, value: RequestContextActivationRecord,
  update: RequestContextActivationLease, stillReadyAndSameOffer: () => boolean): void {
  const input = record.parse(value);
  db.transaction(() => {
    if (!update.current() || !stillReadyAndSameOffer()) throw Error("Activation preparation changed");
    activateRequestContextBarrier(db, 1);
    db.exec(`CREATE TABLE IF NOT EXISTS ${REQUEST_CONTEXT_ACTIVATIONS_TABLE} (
      epoch TEXT PRIMARY KEY, owner TEXT NOT NULL, activated_at INTEGER NOT NULL,
      invalidates_json TEXT NOT NULL, offered_latest_deadline INTEGER);
      CREATE TRIGGER IF NOT EXISTS request_context_activation_no_update BEFORE UPDATE ON ${REQUEST_CONTEXT_ACTIVATIONS_TABLE}
        BEGIN SELECT RAISE(ABORT,'Activation history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS request_context_activation_no_delete BEFORE DELETE ON ${REQUEST_CONTEXT_ACTIVATIONS_TABLE}
        BEGIN SELECT RAISE(ABORT,'Activation history is immutable'); END;`);
    db.prepare(`INSERT INTO ${REQUEST_CONTEXT_ACTIVATIONS_TABLE} VALUES (?,?,?,?,?)`).run(input.epoch, input.owner, input.activatedAt,
      JSON.stringify(input.invalidates), input.offeredLatestDeadline);
    assertRequestContextCompatibility(db, 1);
    if (!update.current() || !stillReadyAndSameOffer()) throw Error("Activation preparation changed");
    readRequestContextActivations(db);
  })();
}
