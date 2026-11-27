/** Administrator-chosen version advice. Saving never installs or grants an update. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { compareSemver, isExactVersion } from "../update-check.js";
import { validated, HubProtocolError } from "./validation.js";
import { createPublishedVersionLookup } from "./published-version.js";
import { HUB_RECOMMENDATION_CAPABILITY, recommendationAckSchema, type HubRecommendationAck } from "./recommendation-model.js";
import type { HubCore } from "./http/core.js";
import type { HubRequestContext } from "./types.js";
import type { HubLinkContext } from "./server.js";
import type { HubFleetVersions } from "./fleet-versions.js";

export const HUB_RECOMMENDATIONS_MIGRATION = Object.freeze({ component: "s3-version-recommendations", version: 1, up(db: import("better-sqlite3").Database) {
  db.exec(`CREATE TABLE hub_version_recommendation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL CHECK(mode IN ('hub','specific','none')),
    version TEXT,effective TEXT,revision INTEGER NOT NULL,set_at INTEGER NOT NULL);
    CREATE TABLE hub_version_recommendation_receipts(fleet_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,version TEXT,last_epoch INTEGER NOT NULL,
    last_sent_at INTEGER NOT NULL,acked INTEGER NOT NULL DEFAULT 0,notified_at INTEGER);`);
} });
const settingSchema = z.strictObject({ mode: z.enum(["hub", "specific", "none"]), version: z.unknown().optional(), ifRevision: z.number().int().min(0).optional() });
interface Row { mode: "hub" | "specific" | "none"; version: string | null; effective: string | null; revision: number; set_at: number }
export interface HubRecommendationSetting { mode: Row["mode"]; version: string | null; recommendedVersion: string | null; hubVersion: string | null;
  configured: boolean; revision: number; setAt: number | null }
export class HubRecommendationRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly version?: string) { super(code); }
}
export class HubVersionRecommendations {
  private readonly lookup;
  private readonly links = new Map<string, HubLinkContext>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private dirty = false;
  private closed = false;
  constructor(private readonly core: HubCore, private readonly versions: HubFleetVersions) {
    this.lookup = core.deps.versionRegistry ?? createPublishedVersionLookup();
  }
  private hubVersion(): string | null { const v = this.core.deps.hubSettings?.info.version; return v && isExactVersion(v) ? v.replace(/^v/, "") : null; }
  settings(): HubRecommendationSetting {
    return this.core.atomic(db => {
      let row = db.prepare("SELECT * FROM hub_version_recommendation WHERE singleton=1").get() as Row | undefined;
      const hubVersion = this.hubVersion();
      if (row?.mode === "hub" && hubVersion && row.effective !== hubVersion) {
        db.prepare("UPDATE hub_version_recommendation SET effective=?,revision=revision+1,set_at=? WHERE singleton=1").run(hubVersion, this.core.now());
        row = { ...row, effective: hubVersion, revision: row.revision + 1, set_at: this.core.now() };
      }
      return { mode: row?.mode ?? "none", version: row?.version ?? null, recommendedVersion: row?.effective ?? null,
        hubVersion, configured: !!row, revision: row?.revision ?? 0, setAt: row?.set_at ?? null };
    });
  }
  private async prepare(ctx: HubRequestContext, value: unknown, save: boolean) {
    const permit = await this.core.management(ctx, "hub.admin"), input = validated(settingSchema, value), before = this.settings();
    const check = () => { this.core.check(); permit.assertCurrent(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked"); };
    check();
    if (save && input.ifRevision !== before.revision) throw new HubRecommendationRefusal(409, "revision-conflict");
    let version: string | null = null;
    if (input.mode === "specific") {
      if (typeof input.version !== "string" || input.version.length > 128 || input.version !== input.version.trim() || !isExactVersion(input.version)) throw new HubRecommendationRefusal(400, "version-invalid");
      version = input.version.replace(/^v/, "");
    } else if (input.version != null) throw new HubProtocolError("invalid");
    const effective = input.mode === "hub" ? this.hubVersion() : version;
    if (input.mode === "hub" && !effective) throw new HubRecommendationRefusal(503, "hub-version-unknown");
    if (effective) {
      let found: Awaited<ReturnType<typeof this.lookup>>;
      try { found = await this.lookup(effective); } catch { found = "unavailable"; }
      check();
      if (found !== "found") throw new HubRecommendationRefusal(found === "not-found" ? 422 : 503, found === "not-found" ? "version-not-found" : "npm-unavailable", effective);
    }
    check();
    if (this.settings().revision !== before.revision || (input.mode === "hub" && effective !== this.hubVersion())) throw new HubRecommendationRefusal(409, "revision-conflict");
    return { permit, check, input, before, effective, version };
  }
  async preview(ctx: HubRequestContext, value: unknown) {
    const p = await this.prepare(ctx, value, false);
    return this.core.atomic(() => {
      p.check();
      const affected = p.effective ? this.core.deps.store.read().fleets.filter(f => {
        if (f.status !== "active") return false;
        const v = this.versions.view(f.id).version;
        return !v || compareSemver(v, p.effective!) === -1;
      }).length : 0;
      return { recommendedVersion: p.effective, affected, revision: p.before.revision };
    });
  }
  async save(ctx: HubRequestContext, value: unknown): Promise<HubRecommendationSetting> {
    const p = await this.prepare(ctx, value, true);
    const result = this.core.atomic((db, tx) => {
      p.check(); if (this.settings().revision !== p.before.revision) throw new HubRecommendationRefusal(409, "revision-conflict");
      db.prepare(`INSERT INTO hub_version_recommendation VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
        mode=excluded.mode,version=excluded.version,effective=excluded.effective,revision=excluded.revision,set_at=excluded.set_at`)
        .run(p.input.mode, p.version, p.effective, p.before.revision + 1, this.core.now());
      this.core.audit(tx, { requestId: ctx.requestId, actor: p.permit.actor.kind === "directory" ? { kind: "person", person: p.permit.actor.person } : { kind: "local-host" }, action: "fleet.version-recommendation", result: "completed" });
      return this.settings();
    });
    this.wake(); return result;
  }
  ready(link: HubLinkContext): void { if (link.current() && link.features.has(HUB_RECOMMENDATION_CAPABILITY)) { this.links.set(link.fleetId, link); this.wake(); } }
  notifiedAt(fleetId: string, setting: HubRecommendationSetting, batchDb?: import("better-sqlite3").Database): number | null {
    if (!setting.recommendedVersion) return null;
    const read = <T>(work: (db: import("better-sqlite3").Database) => T): T => batchDb ? work(batchDb) : this.core.atomic(work);
    return read(db => (db.prepare("SELECT notified_at FROM hub_version_recommendation_receipts WHERE fleet_id=? AND revision=? AND version=? AND acked=1")
      .get(fleetId, setting.revision, setting.recommendedVersion) as { notified_at: number | null } | undefined)?.notified_at ?? null);
  }
  acknowledge(value: unknown, link: HubLinkContext): void {
    const ack: HubRecommendationAck = validated(recommendationAckSchema, value), setting = this.settings();
    if (!link.current() || this.links.get(link.fleetId) !== link || !link.features.has(HUB_RECOMMENDATION_CAPABILITY)) return;
    if (ack.revision !== setting.revision || ack.version !== setting.recommendedVersion) return;
    this.core.atomic(db => {
      if (!link.current()) return;
      db.prepare(`UPDATE hub_version_recommendation_receipts SET acked=1,notified_at=CASE WHEN ?='offered' THEN COALESCE(notified_at,?) ELSE NULL END
        WHERE fleet_id=? AND revision=? AND version IS ? AND last_epoch=?`)
        .run(ack.status, this.core.now(), link.fleetId, ack.revision, ack.version, link.linkEpoch);
    });
    this.wake();
  }
  private wake(): void {
    if (this.closed) return;
    if (this.flushing) { this.dirty = true; return; }
    clearTimeout(this.timer); this.timer = undefined; void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return; this.flushing = true;
    let pending = false;
    try {
      const setting = this.settings(); if (!setting.configured) return;
      for (const [fleetId, link] of this.links) {
        if (this.settings().revision !== setting.revision) { this.dirty = true; break; }
        if (!link.current()) { this.links.delete(fleetId); continue; }
        const due = this.core.atomic(db => {
          const row = db.prepare("SELECT * FROM hub_version_recommendation_receipts WHERE fleet_id=?").get(fleetId) as { revision: number; last_epoch: number; last_sent_at: number; acked: number } | undefined;
          const same = row?.revision === setting.revision;
          if (same && row.last_epoch === link.linkEpoch && (row.acked || this.core.now() - row.last_sent_at < 30_000)) { if (!row.acked) pending = true; return false; }
          db.prepare(`INSERT INTO hub_version_recommendation_receipts VALUES(?,?,?,?,?,0,NULL) ON CONFLICT(fleet_id) DO UPDATE SET
            revision=excluded.revision,version=excluded.version,last_epoch=excluded.last_epoch,last_sent_at=excluded.last_sent_at,
            acked=CASE WHEN revision=excluded.revision THEN acked ELSE 0 END,notified_at=CASE WHEN revision=excluded.revision THEN notified_at ELSE NULL END`)
            .run(fleetId, setting.revision, setting.recommendedVersion, link.linkEpoch, this.core.now()); return true;
        });
        if (!due) continue;
        pending = true;
        try { await this.core.deps.transport()?.send(fleetId, { v: 1, type: "fleet.recommendation", requestId: randomUUID(), linkEpoch: link.linkEpoch,
          payload: { revision: setting.revision, setAt: setting.setAt!, version: setting.recommendedVersion } }); }
        catch { /* link or queue unavailable: one bounded retry while this link stays live */ }
      }
    } catch { pending = true; /* advice is never a reason to fail ordinary member traffic */ }
    finally {
      this.flushing = false;
      if (this.dirty && !this.closed) { this.dirty = false; this.wake(); }
      else if (!this.closed && pending && [...this.links.values()].some(l => l.current())) {
        this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, 30_000); this.timer.unref();
      }
    }
  }
  close(): void { this.closed = true; clearTimeout(this.timer); this.links.clear(); }
}
