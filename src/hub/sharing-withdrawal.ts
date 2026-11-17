/** Withdrawal closes pending outcomes in the same transaction, without releasing any later answer or history. */
import type Database from "better-sqlite3";
import type { HubCore } from "./http/core.js";
import { personFromString } from "./http/core.js";
import type { HubTx } from "./types.js";
export const HUB_SHARING_WITHDRAWAL_MIGRATION = Object.freeze({ component: "s3-sharing-withdrawal", version: 1, up(db: Database.Database) {
  db.exec("ALTER TABLE hub_room_deliveries ADD COLUMN reason_code TEXT");
} });
export interface SharingSettlement { direct: string[]; group: string[] }
export function settleSharingWithdrawal(db: Database.Database, core: HubCore, tx: HubTx, ids: readonly string[], throughRevision = Number.MAX_SAFE_INTEGER): SharingSettlement {
  const result: SharingSettlement = { direct: [], group: [] }, at = core.now();
  for (const id of ids) {
    const exposure = db.prepare("SELECT owner,fleet_id FROM hub_exposures WHERE id=?").get(id) as { owner: string; fleet_id: string | null } | undefined;
    if (!exposure) continue;
    for (const row of db.prepare("SELECT id,room_id FROM hub_messages WHERE exposure_id=? AND owner=? AND (stage IN ('queued','delivered','consumed') OR stage='cancelled' AND reason_code='publication-changed') AND answer_ref IS NULL AND exposure_revision<=?").all(id, exposure.owner, throughRevision) as { id: string; room_id: string }[]) {
      db.prepare("UPDATE hub_messages SET stage='cancelled',reason_code='owner-stopped-sharing',stage_at=? WHERE id=?").run(at, row.id);
      db.prepare("DELETE FROM hub_leases WHERE message_id=?").run(row.id);
      core.audit(tx, { requestId: row.id, actor: { kind: "local-host" }, action: "question.not-answered", result: "completed", reasonCode: "owner-stopped-sharing",
        messageId: row.id, roomId: row.room_id, exposureId: id, ownerAtEvent: personFromString(exposure.owner), ...(exposure.fleet_id ? { fleetId: exposure.fleet_id } : {}) });
      result.direct.push(row.id);
    }
    for (const row of db.prepare("SELECT id,reply_id,room_id FROM hub_room_deliveries WHERE exposure_id=? AND owner=? AND (state IN ('queued','sent') OR state='retired' AND reason_code='publication-changed') AND exposure_revision<=?").all(id, exposure.owner, throughRevision) as { id: string; reply_id: string; room_id: string }[]) {
      db.prepare("UPDATE hub_room_deliveries SET state='retired',reason_code='owner-stopped-sharing' WHERE id=?").run(row.id);
      db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(row.reply_id);
      core.audit(tx, { requestId: row.id, actor: { kind: "local-host" }, action: "room.question.not-answered", result: "completed", reasonCode: "owner-stopped-sharing",
        messageId: row.reply_id, roomId: row.room_id, exposureId: id, ownerAtEvent: personFromString(exposure.owner), ...(exposure.fleet_id ? { fleetId: exposure.fleet_id } : {}) });
      result.group.push(row.id);
    }
  }
  return result;
}
