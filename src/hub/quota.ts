/** Hub quota is a volatile hint, never audit content or exposure consent. Only visibility is durable. */
import { exposureOf, grantApplies, grantOf, readExposure, readGrant } from "./catalog.js";
import { personKeyString } from "./identity.js";
import { exposureQuotaSchema } from "./protocol.js";
import { HubProtocolError, validated } from "./validation.js";
import type { HubCore } from "./http/core.js";
import type { HubLinkContext } from "./server.js";
import type { HubExposureQuota, HubQuota, HubRequestContext, HubRoom } from "./types.js";
import { HUB_QUOTA_CAPABILITY, HUB_QUOTA_INTERVAL_MS } from "./member/quota.js";

export class HubQuotaService {
  private readonly links = new Map<string, HubLinkContext>();
  private readonly values = new Map<string, { link: HubLinkContext; quota: HubQuota; at: number }>();
  private readonly pending = new Map<string, { link: HubLinkContext; timer: NodeJS.Timeout }>();
  constructor(private readonly core: HubCore) {}
  noteLink(link: HubLinkContext): void {
    const old = this.links.get(link.fleetId);
    if (old && old.linkEpoch > link.linkEpoch) return;
    if (old !== link) {
      for (const [id, value] of this.values) if (value.link.fleetId === link.fleetId) { this.values.delete(id); this.cancelPending(id); }
      this.links.set(link.fleetId, link);
    }
  }
  receive(raw: HubExposureQuota, link: HubLinkContext): void {
    if (!link.current() || !link.features.has(HUB_QUOTA_CAPABILITY) || !link.features.has("welcome-caps-v1")) throw new HubProtocolError("denied");
    const input = validated(exposureQuotaSchema, raw);
    this.core.atomic(db => {
      const exposure = readExposure(db, input.exposureId);
      if (!exposure || exposure.fleet_id !== link.fleetId || exposure.owner !== personKeyString(link.owner)
        || exposure.state === "withdrawn") throw new HubProtocolError("denied");
      const old = this.values.get(input.exposureId), now = this.core.now();
      this.cancelPending(input.exposureId);
      if (old?.link === link && old.quota.band === input.quota.band) return;
      if (old?.link === link && now >= old.at && now - old.at < HUB_QUOTA_INTERVAL_MS) {
        // Arrival jitter must not drop the only changed-band update forever. Coalesce the latest, then recheck its link.
        const timer = setTimeout(() => {
          this.pending.delete(input.exposureId);
          try { this.receive(input, link); } catch { /* retired or withdrawn while waiting */ }
        }, HUB_QUOTA_INTERVAL_MS - (now - old.at));
        timer.unref?.(); this.pending.set(input.exposureId, { link, timer }); return;
      }
      this.values.set(input.exposureId, { link, quota: structuredClone(input.quota), at: now });
    });
  }
  /** Called only after the caller's room/catalog authorization. Hidden always omits the whole value. */
  projection(exposureId: string): { quota?: HubQuota } {
    return this.core.atomic(db => {
      const setting = db.prepare("SELECT visible FROM hub_quota_preferences WHERE exposure_id=?").get(exposureId) as { visible: number } | undefined;
      if (setting?.visible === 0) return {};
      const e = readExposure(db, exposureId), value = this.values.get(exposureId);
      const link = e ? this.links.get(e.fleet_id) : null;
      if (!e || e.state === "withdrawn" || !link?.current() || value?.link !== link) return { quota: { band: "unknown" } };
      // A passed reset cannot still promise capacity. The next changed band from the member replaces this hint.
      if (value.quota.resetsAt !== undefined && value.quota.resetsAt <= this.core.now()) return { quota: { band: "unknown" } };
      return { quota: structuredClone(value.quota) };
    });
  }
  visible(exposureId: string): boolean {
    return this.core.atomic(db => (db.prepare("SELECT visible FROM hub_quota_preferences WHERE exposure_id=?").get(exposureId) as { visible: number } | undefined)?.visible !== 0);
  }
  roomProjection(room: HubRoom): { quota?: HubQuota } {
    const allowed = this.core.atomic(db => {
      const e = readExposure(db, room.exposureId), g = readGrant(db, room.grantId);
      return room.state === "active" && !!e && !!g && exposureOf(e).state === "published"
        && grantApplies(grantOf(g), exposureOf(e), room.asker, this.core.now()) && grantOf(g).permissions.includes("read-own-room");
    });
    return allowed ? this.projection(room.exposureId) : {};
  }
  async setVisible(ctx: HubRequestContext, exposureId: string, revision: number, visible: boolean): Promise<void> {
    const owner = personKeyString(await ctx.requirePerson());
    this.core.atomic(db => {
      const e = readExposure(db, exposureId);
      if (!e || e.owner !== owner) throw new HubProtocolError("not-found");
      if (e.revision !== revision) throw new HubProtocolError("conflict");
      db.prepare(`INSERT INTO hub_quota_preferences(exposure_id, visible) VALUES(?,?)
        ON CONFLICT(exposure_id) DO UPDATE SET visible=excluded.visible`).run(exposureId, visible ? 1 : 0);
    });
  }
  prune(): void {
    this.core.atomic(db => {
      for (const id of this.values.keys()) {
        const e = readExposure(db, id);
        if (!e || e.state === "withdrawn") { this.values.delete(id); this.cancelPending(id); }
      }
    });
  }
  private cancelPending(id: string): void { const p = this.pending.get(id); if (p) clearTimeout(p.timer); this.pending.delete(id); }
  close(): void { for (const id of this.pending.keys()) this.cancelPending(id); this.links.clear(); this.values.clear(); }
}
