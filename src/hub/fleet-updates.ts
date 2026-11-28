/** Hub administrator requests. The receiving Fleet independently grants permission and performs the update. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HubProtocolError, validated, uuid } from "./validation.js";
import { canonicalArguments, personKeyString, sha256 } from "./identity.js";
import { compareSemver } from "../update-check.js";
import { HUB_FLEET_UPDATE_CAPABILITY } from "./protocol.js";
import { fleetUpdateStatusSchema, openFleetUpdate, type FleetUpdateReason, type HubFleetUpdate } from "./fleet-update-model.js";
import type { HubCore } from "./http/core.js";
import type { HubLinkContext } from "./server.js";
import type { HubFleetInfo, HubRequestContext } from "./types.js";
import type { HubFleetVersions } from "./fleet-versions.js";
import type { HubVersionRecommendations } from "./recommendations.js";
export const HUB_FLEET_UPDATES_MIGRATION = Object.freeze({ component: "s3-fleet-updates", version: 1, up(db: import("better-sqlite3").Database) {
  db.exec(`CREATE TABLE hub_fleet_update_permissions(fleet_id TEXT PRIMARY KEY,owner TEXT NOT NULL,generation INTEGER NOT NULL,allowed INTEGER NOT NULL);
    CREATE TABLE hub_fleet_update_batches(id TEXT PRIMARY KEY,actor TEXT NOT NULL,digest TEXT NOT NULL,request_ids TEXT NOT NULL,refused TEXT NOT NULL);
    CREATE TABLE hub_fleet_update_requests(id TEXT PRIMARY KEY,fleet_id TEXT NOT NULL,owner TEXT NOT NULL,generation INTEGER NOT NULL,
      version TEXT NOT NULL,requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      state TEXT NOT NULL,waiting_since INTEGER,started_at INTEGER,reason_code TEXT,current_version TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,
      predecessor_id TEXT,sequence INTEGER NOT NULL DEFAULT 0,status_digest TEXT,sent_epoch INTEGER NOT NULL DEFAULT 0,last_sent_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX hub_fleet_update_fleet ON hub_fleet_update_requests(fleet_id,requested_at);`);
} });
const requestSchema = z.strictObject({ fleetIds: z.array(uuid).min(1).max(200).refine(v => new Set(v).size === v.length),
  ifRevision: z.number().int().min(0), idempotencyKey: uuid });
interface Row { id: string; fleet_id: string; owner: string; generation: number; version: string; requested_by: string; requested_at: number; expires_at: number;
  updated_at: number; state: HubFleetUpdate["state"]; waiting_since: number | null; started_at: number | null; reason_code: FleetUpdateReason | null;
  current_version: string | null; cancel_requested: number; predecessor_id: string | null; sequence: number; status_digest: string | null; sent_epoch: number; last_sent_at: number }
export class HubFleetUpdateRefusal extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const project = (r: Row): HubFleetUpdate => ({ id: r.id, fleetId: r.fleet_id, version: r.version, requestedBy: { name: r.requested_by }, requestedAt: r.requested_at,
  expiresAt: r.expires_at, updatedAt: r.updated_at, state: r.state, waitingSince: r.waiting_since, startedAt: r.started_at, cancelRequested: !!r.cancel_requested,
  ...(r.reason_code ? { reasonCode: r.reason_code } : {}), ...(r.current_version ? { currentVersion: r.current_version } : {}) });
export class HubFleetUpdates {
  private readonly links = new Map<string, HubLinkContext>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private dirty = false;
  private closed = false;
  constructor(private readonly core: HubCore, private readonly versions: HubFleetVersions, private readonly recommendations: HubVersionRecommendations) {}
  private fleet(id: string) { return this.core.deps.store.read().fleets.find(f => f.id === id); }
  private eligible(link: HubLinkContext): boolean {
    try {
      const f = this.fleet(link.fleetId);
      return link.current() && link.features.has(HUB_FLEET_UPDATE_CAPABILITY) && !!f && f.status === "active" && personKeyString(f.owner) === personKeyString(link.owner);
    } catch { return false; }
  }
  report(info: HubFleetInfo, link: HubLinkContext): void {
    if (!this.eligible(link) || typeof info.updatesAllowed !== "boolean") return;
    this.core.atomic(db => {
      if (!this.eligible(link)) return;
      const f = this.fleet(link.fleetId)!;
      db.prepare(`INSERT INTO hub_fleet_update_permissions VALUES(?,?,?,?) ON CONFLICT(fleet_id) DO UPDATE SET
        owner=excluded.owner,generation=excluded.generation,allowed=excluded.allowed`).run(f.id, personKeyString(f.owner), f.generation, info.updatesAllowed ? 1 : 0);
    });
    this.wake();
  }
  allowed(fleetId: string, batchDb?: import("better-sqlite3").Database, state?: ReturnType<HubCore["deps"]["store"]["read"]>): boolean | null {
    const read = <T>(work: (db: import("better-sqlite3").Database) => T): T => batchDb ? work(batchDb) : this.core.atomic(work);
    return read(db => {
      const f = state ? state.fleets.find(f => f.id === fleetId) : this.fleet(fleetId); if (!f || f.status !== "active") return null;
      const report = db.prepare("SELECT capabilities FROM hub_fleet_versions WHERE fleet_id=?").get(fleetId) as { capabilities: string } | undefined;
      if (!report || !(JSON.parse(report.capabilities) as string[]).includes(HUB_FLEET_UPDATE_CAPABILITY)) return null;
      const row = db.prepare("SELECT owner,generation,allowed FROM hub_fleet_update_permissions WHERE fleet_id=?").get(fleetId) as { owner: string; generation: number; allowed: number } | undefined;
      return row?.owner === personKeyString(f.owner) && row.generation === f.generation ? !!row.allowed : null;
    });
  }
  reconcile(): void {
    this.core.atomic(db => {
      const rows = db.prepare("SELECT * FROM hub_fleet_update_requests WHERE state IN ('queued','waiting','updating')").all() as Row[];
      for (const r of rows) {
        const f = this.fleet(r.fleet_id);
        if (!f || f.status !== "active" || f.generation !== r.generation || personKeyString(f.owner) !== r.owner)
          db.prepare("UPDATE hub_fleet_update_requests SET state='cancelled',reason_code='revoked',cancel_requested=0,updated_at=? WHERE id=?").run(this.core.now(), r.id);
        else if (r.state === "queued" && this.core.now() >= r.expires_at)
          db.prepare("UPDATE hub_fleet_update_requests SET state='expired',reason_code='offline-7d',cancel_requested=0,updated_at=? WHERE id=?").run(this.core.now(), r.id);
      }
    });
  }
  view(fleetId: string, batchDb?: import("better-sqlite3").Database): HubFleetUpdate | null {
    const read = <T>(work: (db: import("better-sqlite3").Database) => T): T => batchDb ? work(batchDb) : this.core.atomic(work);
    return read(db => { const r = db.prepare("SELECT * FROM hub_fleet_update_requests WHERE fleet_id=? ORDER BY rowid DESC LIMIT 1").get(fleetId) as Row | undefined; return r ? project(r) : null; });
  }
  async request(ctx: HubRequestContext, value: unknown): Promise<{ requests: HubFleetUpdate[]; refused: { fleetId: string; code: string }[] }> {
    const permit = await this.core.management(ctx, "hub.admin"), b = validated(requestSchema, value);
    permit.assertCurrent(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
    this.reconcile();
    const actor = permit.actor.kind === "directory" ? personKeyString(permit.actor.person) : "local-host";
    const digest = sha256(canonicalArguments({ fleetIds: b.fleetIds, ifRevision: b.ifRevision }));
    const result = this.core.atomic((db, tx) => {
      permit.assertCurrent(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
      const replay = db.prepare("SELECT * FROM hub_fleet_update_batches WHERE id=?").get(b.idempotencyKey) as { actor: string; digest: string; request_ids: string; refused: string } | undefined;
      if (replay) {
        if (replay.actor !== actor || replay.digest !== digest) throw new HubFleetUpdateRefusal(409, "idempotency-conflict");
        return { requests: (JSON.parse(replay.request_ids) as string[]).map(id => project(db.prepare("SELECT * FROM hub_fleet_update_requests WHERE id=?").get(id) as Row)), refused: JSON.parse(replay.refused) as { fleetId: string; code: string }[] };
      }
      const recommendation = this.recommendations.settings();
      if (recommendation.revision !== b.ifRevision) throw new HubFleetUpdateRefusal(409, "revision-conflict");
      if (!recommendation.recommendedVersion) throw new HubFleetUpdateRefusal(409, "no-recommendation");
      const version = recommendation.recommendedVersion, requests: HubFleetUpdate[] = [], refused: { fleetId: string; code: string }[] = [];
      const name = actor === "local-host" ? "Hub host" : (db.prepare("SELECT display_name FROM hub_people WHERE person=?").get(actor) as { display_name: string } | undefined)?.display_name ?? "Hub administrator";
      for (const fleetId of b.fleetIds) {
        const f = this.fleet(fleetId), v = this.versions.view(fleetId);
        let code: string | null = !f ? "not-found" : f.status !== "active" ? "revoked" : this.allowed(fleetId) == null ? "unsupported" : !this.allowed(fleetId) ? "owner-disabled" : v.runsAsService !== true ? "not-service" : v.version && compareSemver(v.version, version) !== -1 ? "already-current" : null;
        const old = db.prepare("SELECT * FROM hub_fleet_update_requests WHERE fleet_id=? AND state IN ('queued','waiting','updating') ORDER BY rowid DESC LIMIT 1").get(fleetId) as Row | undefined;
        if (old && (old.state === "updating" || old.predecessor_id)) code ??= "request-open";
        if (code) { refused.push({ fleetId, code }); continue; }
        if (old?.version === version) { requests.push(project(old)); continue; }
        let predecessor: string | null = null;
        if (old) {
          if (old.sent_epoch === 0) db.prepare("UPDATE hub_fleet_update_requests SET state='cancelled',updated_at=? WHERE id=?").run(this.core.now(), old.id);
          else { db.prepare("UPDATE hub_fleet_update_requests SET cancel_requested=1,last_sent_at=0 WHERE id=?").run(old.id); predecessor = old.id; }
        }
        const id = randomUUID(), now = this.core.now();
        db.prepare(`INSERT INTO hub_fleet_update_requests(id,fleet_id,owner,generation,version,requested_by,requested_at,expires_at,updated_at,state,predecessor_id)
          VALUES(?,?,?,?,?,?,?,?,?,'queued',?)`).run(id, fleetId, personKeyString(f!.owner), f!.generation, version, name, now, now + 7 * 86_400_000, now, predecessor);
        requests.push(project(db.prepare("SELECT * FROM hub_fleet_update_requests WHERE id=?").get(id) as Row));
      }
      db.prepare("INSERT INTO hub_fleet_update_batches VALUES(?,?,?,?,?)").run(b.idempotencyKey, actor, digest, JSON.stringify(requests.map(r => r.id)), JSON.stringify(refused));
      this.core.audit(tx, { requestId: ctx.requestId, actor: permit.actor.kind === "directory" ? { kind: "person", person: permit.actor.person } : { kind: "local-host" }, action: "fleet.update-request", result: "completed" });
      return { requests, refused };
    });
    this.wake(); return result;
  }
  async cancel(ctx: HubRequestContext, id: string): Promise<HubFleetUpdate> {
    validated(uuid, id); const permit = await this.core.management(ctx, "hub.admin");
    const out = this.core.atomic((db, tx) => {
      permit.assertCurrent(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
      const row = db.prepare("SELECT * FROM hub_fleet_update_requests WHERE id=?").get(id) as Row | undefined;
      if (!row) throw new HubFleetUpdateRefusal(404, "not-found");
      if (row.state !== "waiting" && row.state !== "queued") throw new HubFleetUpdateRefusal(409, "request-open");
      if (row.sent_epoch === 0) db.prepare("UPDATE hub_fleet_update_requests SET state='cancelled',cancel_requested=0,updated_at=? WHERE id=?").run(this.core.now(), id);
      else db.prepare("UPDATE hub_fleet_update_requests SET cancel_requested=1,last_sent_at=0 WHERE id=?").run(id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: permit.actor.kind === "directory" ? { kind: "person", person: permit.actor.person } : { kind: "local-host" }, action: "fleet.update-cancel", result: "completed" });
      return project(db.prepare("SELECT * FROM hub_fleet_update_requests WHERE id=?").get(id) as Row);
    }); this.wake(); return out;
  }
  ready(link: HubLinkContext): void { if (this.eligible(link)) { this.links.set(link.fleetId, link); this.wake(); } }
  async status(value: unknown, link: HubLinkContext): Promise<void> {
    const status = validated(fleetUpdateStatusSchema, value);
    if (!this.eligible(link) || this.links.get(link.fleetId) !== link) return;
    const accepted = this.core.atomic(db => {
      const row = db.prepare("SELECT * FROM hub_fleet_update_requests WHERE id=? AND fleet_id=?").get(status.id, link.fleetId) as Row | undefined;
      if (!row || row.owner !== personKeyString(link.owner) || row.generation !== this.fleet(link.fleetId)!.generation || row.version !== status.version || !row.sent_epoch || !this.eligible(link)) return false;
      const digest = sha256(canonicalArguments(status));
      if (status.sequence === row.sequence) return digest === row.status_digest;
      if (status.sequence < row.sequence) return true;
      // A late status cannot reopen a closed request. Receipt ACK still retires the Fleet's durable retry.
      if (!openFleetUpdate(row.state)) return true;
      if (row.state === "updating" && status.state === "waiting") return false;
      db.prepare(`UPDATE hub_fleet_update_requests SET state=?,sequence=?,status_digest=?,updated_at=?,waiting_since=COALESCE(waiting_since,?),
        started_at=COALESCE(started_at,?),expires_at=?,reason_code=?,current_version=?,cancel_requested=CASE WHEN ? THEN cancel_requested ELSE 0 END WHERE id=?`)
        .run(status.state, status.sequence, digest, this.core.now(), status.waitingSince ?? null, status.startedAt ?? null, status.expiresAt ?? row.expires_at,
          status.reasonCode ?? null, status.currentVersion ?? null, status.state === "waiting" ? 1 : 0, status.id);
      return true;
    });
    if (accepted && this.eligible(link)) await this.core.deps.transport()?.send(link.fleetId, { v: 1, type: "fleet.update-status-ack", requestId: randomUUID(), linkEpoch: link.linkEpoch,
      payload: { id: status.id, version: status.version, sequence: status.sequence } });
    this.wake();
  }
  private wake(): void {
    if (this.closed) return; if (this.flushing) { this.dirty = true; return; }
    clearTimeout(this.timer); this.timer = undefined; void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return; this.flushing = true; let pending = false;
    try {
      this.reconcile();
      for (const [fleetId, link] of this.links) {
        if (!this.eligible(link)) { this.links.delete(fleetId); continue; }
        const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_fleet_update_requests WHERE fleet_id=? AND state IN ('queued','waiting') ORDER BY rowid").all(fleetId) as Row[]);
        for (const row of rows) {
          if (!this.eligible(link)) break;
          if (row.predecessor_id) {
            const predecessor = this.core.atomic(db => db.prepare("SELECT * FROM hub_fleet_update_requests WHERE id=?").get(row.predecessor_id) as Row);
            if (openFleetUpdate(predecessor.state)) { pending = true; continue; }
            if (predecessor.state !== "cancelled") {
              this.core.atomic(db => db.prepare("UPDATE hub_fleet_update_requests SET state='refused',reason_code='update-running',updated_at=? WHERE id=?").run(this.core.now(), row.id)); continue;
            }
            this.core.atomic(db => db.prepare("UPDATE hub_fleet_update_requests SET predecessor_id=NULL WHERE id=?").run(row.id));
          }
          if (row.state !== "queued" && !row.cancel_requested) continue;
          pending = true;
          if (row.sent_epoch === link.linkEpoch && this.core.now() - row.last_sent_at < 30_000) continue;
          this.core.atomic(db => db.prepare("UPDATE hub_fleet_update_requests SET sent_epoch=?,last_sent_at=? WHERE id=?").run(link.linkEpoch, this.core.now(), row.id));
          const base = { v: 1 as const, requestId: randomUUID(), linkEpoch: link.linkEpoch };
          try {
            if (row.cancel_requested) await this.core.deps.transport()?.send(fleetId, { ...base, type: "fleet.update-cancel", payload: { id: row.id, version: row.version } });
            else await this.core.deps.transport()?.send(fleetId, { ...base, type: "fleet.update", payload: { id: row.id, version: row.version, requestedAt: row.requested_at, expiresAt: row.expires_at, requestedBy: { name: row.requested_by } } });
          } catch { /* same frozen request retries on this live link; no offline polling */ }
        }
      }
    } catch { pending = true; /* bounded optional traffic cannot break ordinary Hub work */ }
    finally { this.flushing = false;
      if (this.dirty && !this.closed) { this.dirty = false; this.wake(); }
      else if (pending && !this.closed && [...this.links.values()].some(l => l.current())) { this.timer = setTimeout(() => this.wake(), 30_000); this.timer.unref(); }
    }
  }
  close(): void { this.closed = true; clearTimeout(this.timer); this.links.clear(); }
}
