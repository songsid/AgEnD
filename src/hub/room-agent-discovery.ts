import { z } from "zod";
import type Database from "better-sqlite3";
import type { HubCore } from "./http/core.js";
import type { HubRequestContext } from "./types.js";
import { exposureOf, readExposure } from "./catalog.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError, uuid, validated } from "./validation.js";
import { roomDiscoverySnapshot, roomDiscoveryView } from "./room-agent-discovery-model.js";
const inputSchema = z.strictObject({ findable: z.boolean(), ifRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), exposureRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export class HubRoomAgentDiscovery {
  constructor(private readonly core: HubCore) {}
  private fence(ctx: HubRequestContext) { return { assertCurrent: () => { this.core.check(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked"); } }; }
  async setting(ctx: HubRequestContext, id: string, input?: unknown) {
    validated(uuid, id); const actor = await ctx.requirePerson(), owner = personKeyString(actor);
    const owned = (db: Database.Database) => {
      const row = readExposure(db, id); if (!row || row.owner !== owner) throw new HubProtocolError("not-found"); return row;
    };
    const body = input === undefined ? null : validated(inputSchema, input);
    const before = this.core.atomic(db => {
      const row = owned(db), e = exposureOf(row), view = roomDiscoveryView(db, e);
      if (body && (body.exposureRevision !== e.revision || body.ifRevision !== view.revision)) throw new HubProtocolError("conflict");
      if (body && !view.available) throw new HubProtocolError("denied");
      return { row, view, snapshot: roomDiscoverySnapshot(db, e) };
    }, this.fence(ctx));
    if (!body) return before.view;
    const permission = await this.core.groupExposure(id, null, this.core.groupContext(ctx));
    return this.core.atomic((db, tx) => {
      const row = owned(db), e = exposureOf(row);
      if (JSON.stringify(row) !== JSON.stringify(before.row) || JSON.stringify(roomDiscoverySnapshot(db, e)) !== JSON.stringify(before.snapshot)) throw new HubProtocolError("stale");
      const view = roomDiscoveryView(db, e); if (!view.available) throw new HubProtocolError("denied");
      if (view.findable === body.findable) return view;
      if (!Number.isSafeInteger(view.revision + 1)) throw new HubProtocolError("unavailable");
      db.prepare(`INSERT INTO hub_room_agent_discovery VALUES(?,?,?,?,?,?) ON CONFLICT(exposure_id) DO UPDATE SET
        owner=excluded.owner,exposure_revision=excluded.exposure_revision,findable=excluded.findable,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(id, owner, e.revision, body.findable ? 1 : 0, view.revision + 1, this.core.now());
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor }, ownerAtEvent: actor,
        exposureId: id, action: "exposure.room-discovery", result: "completed", reasonCode: body.findable ? "enabled" : "disabled" });
      if (JSON.stringify(owned(db)) !== JSON.stringify(row)) throw new HubProtocolError("stale");
      const after = roomDiscoveryView(db, e);
      if (!after.available || after.findable !== body.findable || after.revision !== view.revision + 1) throw new HubProtocolError("stale");
      const final = roomDiscoverySnapshot(db, e);
      if (JSON.stringify(final.accepting) !== JSON.stringify(before.snapshot.accepting)
        || final.preference?.owner !== owner || final.preference.exposure_revision !== e.revision
        || final.preference.findable !== Number(body.findable)) throw new HubProtocolError("stale");
      return after;
    }, { assertCurrent: () => { this.fence(ctx).assertCurrent(); permission.assertCurrent(); } });
  }
}
