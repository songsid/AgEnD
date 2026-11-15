/** Retain verified version advice for the paired Fleet; never launches an updater. */
import type Database from "better-sqlite3";
import { compareSemver } from "../../update-check.js";
import { createPublishedVersionLookup, type PublishedVersionLookup } from "../published-version.js";
import { HUB_RECOMMENDATION_CAPABILITY, recommendationSchema, type HubRecommendation, type HubRecommendedUpdate, type HubRecommendationAck } from "../recommendation-model.js";
import { validated, parseStrictJson, HubProtocolError } from "../validation.js";
import type { HubMemberLink } from "../client.js";
import { randomUUID } from "node:crypto";
export const HUB_MEMBER_RECOMMENDATION_MIGRATION = Object.freeze({ component: "s3c-version-recommendation", version: 1, up(db: Database.Database) {
  db.exec("CREATE TABLE hub_member_version_recommendation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,body TEXT NOT NULL,received_at INTEGER NOT NULL,verified INTEGER NOT NULL,status TEXT NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0,retry_delay INTEGER NOT NULL DEFAULT 0)");
} });
interface Row { revision: number; body: string; received_at: number; verified: number; status: HubRecommendationAck["status"]; retry_at: number; retry_delay: number }
export class HubMemberRecommendations {
  private cached: HubRecommendedUpdate | null = null;
  private latestLink: HubMemberLink | null = null;
  private running = false;
  private closed = false;
  private readonly lookup: PublishedVersionLookup;
  constructor(private readonly options: { db: Database.Database; hubId: string; hubName: string; version: string;
    current(): boolean; now(): number; lookup?: PublishedVersionLookup; changed?(): void; log?(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void }) {
    this.lookup = options.lookup ?? createPublishedVersionLookup();
    try { const row = this.row(); if (row?.verified) this.publish(row, false); } catch { /* damaged optional advice never holds the member */ }
  }
  private current(): boolean { return !this.closed && this.options.current(); }
  private row(): Row | undefined { return this.options.db.prepare("SELECT * FROM hub_member_version_recommendation WHERE singleton=1").get() as Row | undefined; }
  view(): HubRecommendedUpdate | null { return this.current() && this.cached ? { ...this.cached, hubName: this.options.hubName } : null; }
  private publish(row?: Row, notify = true): void {
    let next: HubRecommendedUpdate | null = null;
    if (row?.verified && row.status === "offered") {
      const value = validated(recommendationSchema, parseStrictJson(row.body));
      if (value.version && compareSemver(value.version, this.options.version) === 1) next = { hubId: this.options.hubId, hubName: this.options.hubName,
        version: value.version, revision: value.revision, setAt: value.setAt, receivedAt: row.received_at };
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.cached); this.cached = next;
    if (changed && notify) { try { this.options.changed?.(); } catch { /* optional presentation hook */ } }
  }
  /** Admission stays synchronous and bounded; npm work never blocks the member's control receive queue. */
  receive(input: unknown, link: HubMemberLink): void {
    const value: HubRecommendation = validated(recommendationSchema, input);
    if (!this.current() || !link.current() || !link.features.has(HUB_RECOMMENDATION_CAPABILITY)) return;
    const body = JSON.stringify(value), prior = this.row();
    if (prior && value.revision < prior.revision) return;
    if (prior && value.revision === prior.revision && body !== prior.body) throw new HubProtocolError("conflict");
    if (!prior || prior.revision !== value.revision) {
      this.options.db.prepare("INSERT OR REPLACE INTO hub_member_version_recommendation(singleton,revision,body,received_at,verified,status) VALUES(1,?,?,?,0,'current')").run(value.revision, body, this.options.now());
      this.publish();
    }
    this.latestLink = link; void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.running || !this.current()) return; this.running = true;
    try {
      while (this.current()) {
        const row = this.row(), link = this.latestLink;
        if (!row || !link?.current()) return;
        const value = validated(recommendationSchema, parseStrictJson(row.body));
        if (!row.verified) {
          let status: HubRecommendationAck["status"] = value.version === null ? "cleared" : "current";
          if (value.version && compareSemver(value.version, this.options.version) === 1) {
            if (this.options.now() < row.retry_at) return;
            let found;
            try { found = await this.lookup(value.version); } catch { found = "unavailable"; }
            if (!this.current()) return;
            if (this.row()?.revision !== row.revision || this.latestLink !== link) continue;
            if (!link.current()) return;
            if (found !== "found") {
              // Replays and reconnects must not repeatedly spawn npm on an unreachable/missing registry.
              // Advice has no authority: a failed check is retained, never exposed or acknowledged.
              const delay = Math.min(row.retry_delay ? row.retry_delay * 2 : 5 * 60_000, 4 * 60 * 60_000);
              this.options.db.prepare("UPDATE hub_member_version_recommendation SET retry_at=?,retry_delay=? WHERE singleton=1 AND revision=?")
                .run(this.options.now() + delay, delay, row.revision);
              return;
            }
            status = "offered";
          }
          if (!this.current() || !link.current()) return;
          if (this.row()?.revision !== row.revision) continue;
          this.options.db.prepare("UPDATE hub_member_version_recommendation SET verified=1,status=?,retry_at=0,retry_delay=0 WHERE singleton=1 AND revision=?").run(status, row.revision);
          this.publish(this.row());
        }
        const retained = this.row();
        if (!retained || retained.revision !== row.revision || !this.current() || !link.current()) continue;
        await link.send({ v: 1, type: "fleet.recommendation-ack", requestId: randomUUID(), linkEpoch: link.linkEpoch,
          payload: { revision: value.revision, version: value.version, status: retained.status } });
        if (this.row()?.revision === row.revision && this.latestLink === link) return;
      }
    } catch { try { this.options.log?.("warn", "Hub version advice could not be retained", { phase: "receive" }); } catch { /* diagnostics only */ } }
    finally { this.running = false; }
  }
  close(): void { this.closed = true; this.cached = null; this.latestLink = null; }
}
