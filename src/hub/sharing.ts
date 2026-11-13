/** Owner pause overlays publication; a reconnect can never infer consent to resume. */
import { z } from "zod";
import { exposureOf, readExposure } from "./catalog.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError, epoch, uuid, validated } from "./validation.js";
import type { HubRequestContext } from "./types.js";
import type { HubCore } from "./http/core.js";

const input = z.strictObject({ revision: epoch, sharingEpoch: epoch, paused: z.boolean() });
/** Browser-only refusal after the exact asker/grant has been authorized; not a member protocol reason. */
export class HubSharingPaused extends Error {}
export class HubSharingService {
  constructor(private readonly core: HubCore) {}
  async change(ctx: HubRequestContext, incomingId: string, incoming: unknown): Promise<void> {
    const id = validated(uuid, incomingId), request = validated(input, incoming);
    const owner = await ctx.requirePerson(), me = personKeyString(owner);
    const owned = () => this.core.atomic(db => {
      const row = readExposure(db, id);
      if (!row || row.owner !== me) throw new HubProtocolError("not-found");
      if (row.revision !== request.revision || (row.sharing_epoch ?? 0) !== request.sharingEpoch) throw new HubProtocolError("conflict");
      const state = exposureOf(row).state;
      if (state !== (request.paused ? "published" : "paused")) throw new HubProtocolError("denied");
      return row;
    });
    let expected = JSON.stringify(owned());
    // Narrowing needs no group widening permission. Resume re-proves the live operational gates.
    const operational = request.paused ? undefined : await this.core.sharingPermission(id, this.core.groupContext(ctx));
    const permit = { assertCurrent: () => {
      operational?.assertCurrent();
      if (ctx.isCurrent?.() !== true || JSON.stringify(this.core.atomic(db => readExposure(db, id))) !== expected) throw new HubProtocolError("stale");
    } };
    await ctx.current();
    this.core.atomic((db, tx) => {
      if (ctx.isCurrent?.() === false) throw new HubProtocolError("revoked");
      const row = owned();
      db.prepare("UPDATE hub_exposures SET sharing_paused=?,sharing_epoch=sharing_epoch+1,updated_at=? WHERE id=?")
        .run(request.paused ? 1 : 0, this.core.now(), id);
      // A capability issued before a pause must never become usable again after Resume.
      db.prepare("DELETE FROM hub_leases WHERE message_id IN (SELECT id FROM hub_messages WHERE exposure_id=?)").run(id);
      // Adopt only our own SQL image, BEFORE audit hooks. A later callback cannot smuggle in another change.
      expected = JSON.stringify(readExposure(db, id));
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: owner },
        action: request.paused ? "exposure.paused" : "exposure.resumed", result: "completed",
        fleetId: row.fleet_id, exposureId: id, ownerAtEvent: owner });
    }, permit);
  }
}
