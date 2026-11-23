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
