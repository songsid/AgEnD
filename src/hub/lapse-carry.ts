/**
 * M-3543 (the user's choice of 2026-11-23): an owner's "Share again" of a LAPSED agent — shared, but its backend or folder
 * changed since, so its consent no longer matched (#3147) — republishes the same exposure at the next revision. Grants are
 * bound to an exposure revision (catalog.ts), so without this every "who may ask" grant would stop at the republish.
 *
 * This one step carries, from the previous revision to the new one and nothing else:
 *   - the exposure's ACTIVE, UNEXPIRED grants, keeping their original expiry (never extended) — their grant rooms
 *     (hub_rooms, by grant id) follow; live AD membership and the Hub's group permissions are still checked as ever;
 *   - the agent's room-discovery preference (findable in rooms), when it was set for the previous revision.
 * A stop-then-share is not a lapse republish and still revokes as before. Switch it off with `HUB_LAPSE_CARRY = false`
 * (or the caller's option): a lapse republish then leaves grants for the owner to give again.
 */
import type Database from "better-sqlite3";

export const HUB_LAPSE_CARRY = true;

export interface LapseCarry { grants: number; discovery: number }

export function carryLapsePermissions(db: Database.Database, exposureId: string, fromRevision: number, toRevision: number, now: number): LapseCarry {
  if (!(toRevision === fromRevision + 1)) return { grants: 0, discovery: 0 };
  const grants = db.prepare(`UPDATE hub_grants SET exposure_revision=?, revision=revision+1
    WHERE exposure_id=? AND exposure_revision=? AND state='active' AND expires_at>?`).run(toRevision, exposureId, fromRevision, now).changes;
  let discovery = 0;
  try {
    discovery = db.prepare(`UPDATE hub_room_agent_discovery SET exposure_revision=?, revision=revision+1, updated_at=?
      WHERE exposure_id=? AND exposure_revision=?`).run(toRevision, now, exposureId, fromRevision).changes;
  } catch { /* a Hub without room discovery: nothing to carry */ }
  return { grants, discovery };
}

/**
 * #4361 review: the lapse as the member reported it — the revision at which this fleet's stored catalog says the exposure
 * lapsed (agent-catalog-lapse-v1 only; a member reports `lapsed` only on a link that negotiated it), or null.
 */
export function lapsedRevision(body: string | undefined | null, exposureId: string): number | null {
  if (!body) return null;
  try {
    const row = (JSON.parse(body) as { agents?: Array<{ exposure?: { id?: string; revision?: number; state?: string; lapsed?: boolean } | null }> }).agents
      ?.find(a => a.exposure?.id === exposureId)?.exposure;
    return row && row.state === "published" && row.lapsed === true && Number.isSafeInteger(row.revision) ? row.revision! : null;
  } catch { return null; }
}
export function catalogLapse(db: Database.Database, fleetId: string, exposureId: string): number | null {
  const row = db.prepare("SELECT body FROM hub_agent_catalogs WHERE fleet_id=?").get(fleetId) as { body: string } | undefined;
  return lapsedRevision(row?.body, exposureId);
}

/**
 * #4361 review (P1): a catalog is a Fleet's claim, never authority over an exposure. When a catalog shows the republish
 * before its snapshot (previous catalog: lapsed at R; this one: published at R+1), only this pending evidence is kept —
 * in memory, per database, keyed by exposure AND the reporting Fleet — and no permission is written. The snapshot, whose
 * exposure binding (Fleet, owner) the Hub checks, consumes it. Lost on a restart: then nothing carries (owner grants again).
 */
const pending = new WeakMap<Database.Database, Map<string, { fleetId: string; from: number }>>();
export function rememberLapse(db: Database.Database, exposureId: string, fleetId: string, from: number): void {
  let m = pending.get(db); if (!m) { m = new Map(); pending.set(db, m); }
  m.set(exposureId, { fleetId, from });
  while (m.size > 256) m.delete(m.keys().next().value!);
}
export function takeLapse(db: Database.Database, exposureId: string, fleetId: string): number | null {
  const m = pending.get(db), v = m?.get(exposureId);
  if (!v) return null;
  m!.delete(exposureId);
  return v.fleetId === fleetId ? v.from : null;
}
/** The exposure as the Hub holds it belongs to this Fleet and owner (never a catalog's word for it). */
export function ownedBy(db: Database.Database, exposureId: string, fleetId: string, owner: string): { revision: number; state: string } | null {
  const row = db.prepare("SELECT fleet_id, owner, revision, state FROM hub_exposures WHERE id=?").get(exposureId) as { fleet_id: string; owner: string; revision: number; state: string } | undefined;
  return row && row.fleet_id === fleetId && row.owner === owner ? { revision: row.revision, state: row.state } : null;
}
