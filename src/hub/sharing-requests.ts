import { settleSharingWithdrawal, type SharingSettlement } from "./sharing-withdrawal.js";
/** Owner-browser admission and a bounded, durable Hub → member outbox. Snapshots remain publication truth. */
import type Database from "better-sqlite3";
import { z } from "zod";
import { HubAgentCatalogs } from "./agent-catalog.js";
import { HUB_EXPOSURE_REQUEST_CAPABILITY, HUB_SHARE_REQUEST_TTL, exposureRequestSchema, exposureRequestResultSchema, exposureUndoSchema,
  type HubExposureRequest, type HubExposureRequestResult, type HubExposureUndo, type HubExposurePointer } from "./agent-catalog-model.js";
import { canonicalArguments, personKeyString, sha256 } from "./identity.js";
import { personFromString, type HubCore } from "./http/core.js";
import { HubProtocolError, hash, uuid, validated } from "./validation.js";
import type { HubRequestContext } from "./types.js";
import type { HubLinkContext } from "./server.js";
import { readExposure } from "./catalog.js";
import { keepCoalescedList, restoreStoppedList, stoppedImage, type StoppedImage } from "./sharing-retention.js";
import { HubGroupAuthorizationError } from "./group-policy/authorization.js";

export const HUB_SHARING_REQUESTS_MIGRATION = Object.freeze({ component: "s3-sharing-requests", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_sharing_requests(id TEXT PRIMARY KEY,fleet_id TEXT NOT NULL,owner TEXT NOT NULL,generation INTEGER NOT NULL,
    digest TEXT NOT NULL,body TEXT NOT NULL,before_rows TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    state TEXT NOT NULL,result TEXT,undo_id TEXT,undo TEXT,restores TEXT NOT NULL DEFAULT '{}',last_sent_at INTEGER NOT NULL DEFAULT 0,sent_epoch INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX hub_sharing_request_fleet ON hub_sharing_requests(fleet_id,created_at);`);
} });
const inputSchema = z.strictObject({ idempotencyKey: uuid, fleetId: uuid, catalogRevision: hash,
  share: z.array(z.string().min(1).max(128)).max(64), stop: z.array(uuid).max(64) })
  .refine(value => value.share.length + value.stop.length > 0 && value.share.length + value.stop.length <= 64)
  .refine(value => new Set(value.share).size === value.share.length && new Set(value.stop).size === value.stop.length);
interface Row { id: string; fleet_id: string; owner: string; generation: number; digest: string; body: string; before_rows: string;
  created_at: number; expires_at: number; state: "queued" | "expired" | "complete" | "revoked"; result: string | null;
  undo_id: string | null; undo: string | null; restores: string; last_sent_at: number; sent_epoch: number }
interface Before { target: string; pointer: HubExposurePointer | null; stopped: StoppedImage | null }
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
export class HubSharingRequests {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private dirty = false;
  private closed = false;
  constructor(private readonly core: HubCore, private readonly catalogs: HubAgentCatalogs, private readonly settled?: (value: SharingSettlement) => void) {}
  private project(row: Row) {
    return { id: row.id, fleetId: row.fleet_id, state: row.state, expiresAt: row.expires_at,
      result: row.result ? validated(exposureRequestResultSchema, JSON.parse(row.result)) : null,
      undo: row.undo ? validated(exposureUndoSchema, JSON.parse(row.undo)) : null, restores: JSON.parse(row.restores) as Record<string, string> };
  }
  private fleet(row: Row) {
    return this.core.deps.store.read().fleets.find(fleet => fleet.id === row.fleet_id && fleet.status === "active"
      && fleet.generation === row.generation && personKeyString(fleet.owner) === row.owner);
  }
  private current(row: Row, link: HubLinkContext): boolean {
    return !this.closed && this.core.live() && link.current() && link.fleetId === row.fleet_id && personKeyString(link.owner) === row.owner
      && link.features.has(HUB_EXPOSURE_REQUEST_CAPABILITY) && !!this.fleet(row)
      && this.catalogs.reportOf(row.fleet_id)?.link === link;
  }
  private requestOf(row: Row): HubExposureRequest {
    const body = validated(exposureRequestSchema, JSON.parse(row.body));
    if (sha256(canonicalArguments(body)) !== row.digest || personKeyString(body.by) !== row.owner) throw new HubProtocolError("uncertain");
    return body;
  }
  private async publication(owner: HubExposureRequest["by"], requestId: string, current: () => boolean) {
    const groups = this.core.deps.groups;
    if (!groups) return { assertCurrent: () => { if (!current()) throw new HubProtocolError("revoked"); } };
    try {
      // Prepare only: no invented publication or resource registration is committed by this admission check.
      const permit = await groups.prepareEnrollment({ kind: "exposure", id: requestId, revision: 1, owner }, { requestId, current });
      return { assertCurrent: () => { if (this.core.deps.groups !== groups || !current()) throw new HubProtocolError("revoked"); permit.assertCurrent(); } };
    } catch (error) { throw new HubProtocolError(error instanceof HubGroupAuthorizationError && error.reason === "denied" ? "denied" : "unavailable"); }
  }
  async request(ctx: HubRequestContext, value: unknown) {
    const input = validated(inputSchema, value), browser = await this.catalogs.owner(ctx), owner = personKeyString(browser.person);
    const prior = this.core.atomic(db => db.prepare("SELECT * FROM hub_sharing_requests WHERE id=?").get(input.idempotencyKey) as Row | undefined);
    if (prior) {
      const request = this.requestOf(prior);
      if (prior.owner !== owner || prior.fleet_id !== input.fleetId || !same({ share: request.share, stop: request.stop, catalogRevision: request.catalogRevision },
        { share: input.share, stop: input.stop, catalogRevision: input.catalogRevision })) throw new HubProtocolError("conflict");
      browser.assertCurrent(); this.wake(); return this.project(prior);
    }
    const permit = input.share.length ? await this.publication(browser.person, input.idempotencyKey, () => {
      try { browser.assertCurrent(); return true; } catch { return false; }
    }) : browser;
    const row = this.core.atomic((db, tx) => {
      browser.assertCurrent(); permit.assertCurrent();
      const report = this.catalogs.reportOf(input.fleetId);
      if (!report || personKeyString(report.fleet.owner) !== owner) throw new HubProtocolError("not-found");
      if (!report.link?.features.has(HUB_EXPOSURE_REQUEST_CAPABILITY) || !report.catalog.requests) throw new HubProtocolError("unavailable");
      if (!report.catalog.enabled) throw new HubProtocolError("denied");
      if (report.catalog.revision !== input.catalogRevision) throw new HubProtocolError("conflict");
      const now = this.core.now();
      if ((db.prepare("SELECT count(*) n FROM hub_sharing_requests WHERE owner=? AND created_at>?").get(owner, now - 60_000) as { n: number }).n >= 12
        || (db.prepare("SELECT count(*) n FROM hub_sharing_requests WHERE fleet_id=? AND state='queued' AND expires_at>?").get(input.fleetId, now) as { n: number }).n >= 8) throw new HubProtocolError("backpressure");
      const before: Before[] = [...input.share.map(target => {
        const agent = report.catalog.agents.find(row => row.instance === target);
        if (!agent || !agent.shareable || agent.exposure && agent.exposure.state !== "withdrawn") throw new HubProtocolError("denied");
        return { target, pointer: agent.exposure ?? null, stopped: null };
      }), ...input.stop.map(target => {
        const agent = report.catalog.agents.find(row => row.exposure?.id === target);
        const stopped = stoppedImage(db, target);
        if (!agent?.exposure || agent.exposure.state === "withdrawn" || !stopped || stopped.exposure.owner !== owner
          || stopped.exposure.fleet_id !== input.fleetId || stopped.exposure.revision !== agent.exposure.revision) throw new HubProtocolError("conflict");
        return { target, pointer: agent.exposure, stopped };
      })];
      const name = (db.prepare("SELECT display_name FROM hub_people WHERE person=?").get(owner) as { display_name: string } | undefined)?.display_name ?? "Hub owner";
      const request = validated(exposureRequestSchema, { by: browser.person, byName: name, catalogRevision: input.catalogRevision,
        share: input.share, stop: input.stop, createdAt: now, expiresAt: now + HUB_SHARE_REQUEST_TTL });
      const bytes = canonicalArguments(request);
      db.prepare(`INSERT INTO hub_sharing_requests(id,fleet_id,owner,generation,digest,body,before_rows,created_at,expires_at,state)
        VALUES(?,?,?,?,?,?,?,?,?,'queued')`).run(input.idempotencyKey, input.fleetId, owner, report.fleet.generation, sha256(bytes), bytes, canonicalArguments(before), now, request.expiresAt);
      this.core.audit(tx, { requestId: input.idempotencyKey, actor: { kind: "person", person: browser.person }, action: "exposure.owner-request", result: "completed", fleetId: input.fleetId });
      return db.prepare("SELECT * FROM hub_sharing_requests WHERE id=?").get(input.idempotencyKey) as Row;
    }, permit);
    this.wake(); return this.project(row);
  }
  async view(ctx: HubRequestContext, id: string) {
    validated(uuid, id); const browser = await this.catalogs.owner(ctx);
    this.reconcile();
    return this.core.atomic(db => {
      browser.assertCurrent();
      const row = db.prepare("SELECT * FROM hub_sharing_requests WHERE id=? AND owner=?").get(id, personKeyString(browser.person)) as Row | undefined;
      if (!row || !this.fleet(row)) throw new HubProtocolError("not-found");
      return this.project(row);
    });
  }
  result(id: string, value: unknown, link: HubLinkContext): void {
    const result = validated(exposureRequestResultSchema, value);
    const settlement = this.core.atomic((db, tx) => {
      const closed: SharingSettlement = { direct: [], group: [] };
      const row = db.prepare("SELECT * FROM hub_sharing_requests WHERE id=?").get(id) as Row | undefined;
      if (!row || !this.current(row, link)) throw new HubProtocolError("denied");
      const request = this.requestOf(row), before = JSON.parse(row.before_rows) as Before[];
      if (result.results.length !== before.length || result.noticeAt < request.createdAt - 30_000 || result.noticeAt > this.core.now() + 30_000 || result.results.some(item => item.ok) && result.noticeAt > request.expiresAt + 30_000) throw new HubProtocolError("invalid");
      result.results.forEach((item, index) => {
        const plan = before[index]!, share = index < request.share.length;
        if ((share ? !("instance" in item) || item.instance !== plan.target : !("exposureId" in item) || item.exposureId !== plan.target)) throw new HubProtocolError("invalid");
        if (item.ok && (!same(item.before, plan.pointer) || item.after.revision !== (plan.pointer?.revision ?? 0) + 1
          || plan.pointer && item.after.id !== plan.pointer.id || item.after.state !== (share ? "published" : "withdrawn"))) throw new HubProtocolError("invalid");
        if (item.ok && !share && plan.stopped && plan.pointer) {
          keepCoalescedList(db, this.core, plan.target, result.noticeAt, plan.stopped);
          const retired = settleSharingWithdrawal(db, this.core, tx, [plan.target], plan.pointer.revision);
          closed.direct.push(...retired.direct); closed.group.push(...retired.group);
          // A coalesced stop is still a restriction, even when its omitted snapshot never reached the Hub.
          db.prepare("UPDATE hub_grants SET state='revoked',revision=revision+1 WHERE exposure_id=? AND exposure_revision<=? AND state='active'").run(plan.target, plan.pointer.revision);
          db.prepare("UPDATE hub_rooms SET state='closed' WHERE grant_id IN (SELECT id FROM hub_grants WHERE exposure_id=? AND exposure_revision<=?)").run(plan.target, plan.pointer.revision);
        }
      });
      const bytes = canonicalArguments(result);
      if (row.result && row.result !== bytes) throw new HubProtocolError("conflict");
      if (!row.result) {
        db.prepare("UPDATE hub_sharing_requests SET result=?,state='complete' WHERE id=?").run(bytes, id);
        this.core.audit(tx, { requestId: id, actor: { kind: "member", fleetId: link.fleetId }, action: "exposure.owner-request-result", result: "completed", fleetId: link.fleetId });
      }
      return closed;
    });
    this.settled?.(settlement);
  }
  undo(id: string, value: unknown, link: HubLinkContext): void {
    const undo = validated(exposureUndoSchema, value);
    this.core.atomic((db, tx) => {
      const row = db.prepare("SELECT * FROM hub_sharing_requests WHERE id=?").get(undo.originalRequestId) as Row | undefined;
      if (!row || !this.current(row, link) || !row.result) throw new HubProtocolError("denied");
      const result = validated(exposureRequestResultSchema, JSON.parse(row.result));
      const accepted = result.results.flatMap((item, index) => item.ok ? [index] : []);
      if (undo.noticeAt !== result.noticeAt || !same(undo.results.map(item => item.index), accepted)) throw new HubProtocolError("invalid");
      for (const item of undo.results) {
        const original = result.results[item.index]!;
        if (!original.ok || item.ok && (!same(item.before, original.after) || item.after.id !== item.before.id
          || item.after.revision !== item.before.revision + 1 || item.after.state !== ("instance" in original ? "withdrawn" : "published"))) throw new HubProtocolError("invalid");
      }
      const bytes = canonicalArguments(undo);
      if (row.undo_id && (row.undo_id !== id || row.undo !== bytes)) throw new HubProtocolError("conflict");
      if (!row.undo_id) {
        db.prepare("UPDATE hub_sharing_requests SET undo_id=?,undo=? WHERE id=?").run(id, bytes, row.id);
        this.core.audit(tx, { requestId: id, actor: { kind: "member", fleetId: link.fleetId }, action: "exposure.owner-request-undo", result: "completed", fleetId: link.fleetId });
      }
    });
    this.wake();
  }
  reconcile(): void {
    this.core.atomic(db => {
      for (const row of db.prepare("SELECT * FROM hub_sharing_requests WHERE state='queued'").all() as Row[]) {
        if (!this.fleet(row)) db.prepare("UPDATE hub_sharing_requests SET state='revoked' WHERE id=?").run(row.id);
        else if (this.core.now() >= row.expires_at) db.prepare("UPDATE hub_sharing_requests SET state='expired' WHERE id=?").run(row.id);
      }
      db.prepare("DELETE FROM hub_stopped_ask_lists WHERE expires_at<=?").run(this.core.now());
      db.prepare("DELETE FROM hub_sharing_requests WHERE expires_at<?").run(this.core.now() - 86_400_000);
    });
  }
  wake(): void {
    if (this.closed) return;
    if (this.running) { this.dirty = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 0); this.timer.unref();
  }
  async snapshot(link: HubLinkContext): Promise<void> { await this.restorations(link); this.wake(); }
  private async restorations(link: HubLinkContext): Promise<void> {
    const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_sharing_requests WHERE fleet_id=? AND undo IS NOT NULL").all(link.fleetId) as Row[]);
    for (const row of rows) {
      if (!this.current(row, link)) return;
      const result = validated(exposureRequestResultSchema, JSON.parse(row.result!)), undo = validated(exposureUndoSchema, JSON.parse(row.undo!));
      const restored = JSON.parse(row.restores) as Record<string, string>;
      for (const item of undo.results) {
        const original = result.results[item.index]!;
        if (!item.ok || !original.ok || !("exposureId" in original) || restored[String(item.index)]) continue;
        let permit;
        try { permit = await this.core.sharingPermission(original.exposureId, { requestId: row.undo_id!, current: () => this.current(row, link) }); }
        catch { continue; }
        let image: string | undefined;
        const restorePermit = { assertCurrent: () => {
          permit.assertCurrent();
          if (image !== undefined && this.core.atomic(db => canonicalArguments(readExposure(db, original.exposureId))) !== image) throw new HubProtocolError("stale");
        } };
        this.core.atomic((db, tx) => {
          if (!this.current(row, link)) throw new HubProtocolError("stale");
          image = canonicalArguments(readExposure(db, original.exposureId));
          const outcome = restoreStoppedList(db, this.core, tx, { id: original.exposureId, owner: link.owner, fleetId: link.fleetId, generation: row.generation,
            original: original.before, stopped: original.after, restored: item.after, noticeAt: result.noticeAt, undoId: row.undo_id! });
          if (outcome !== "pending") { restored[String(item.index)] = outcome; db.prepare("UPDATE hub_sharing_requests SET restores=? WHERE id=?").run(canonicalArguments(restored), row.id); }
        }, restorePermit);
      }
    }
  }
  private async flush(): Promise<void> {
    if (this.running || this.closed) return; this.running = true;
    try {
      this.reconcile();
      const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_sharing_requests WHERE state='queued' OR undo IS NOT NULL ORDER BY created_at LIMIT 128").all() as Row[]);
      for (const row of rows) {
        const link = this.catalogs.reportOf(row.fleet_id)?.link;
        if (!link || !this.current(row, link)) continue;
        if (row.undo) await this.restorations(link);
        if (row.state !== "queued" || row.sent_epoch === link.linkEpoch && this.core.now() - row.last_sent_at < 5_000) continue;
        const request = this.requestOf(row);
        if (!await this.core.eligible(link.owner) || !this.current(row, link)) continue;
        const permit = request.share.length ? await this.publication(link.owner, row.id, () => this.current(row, link)) : null;
        permit?.assertCurrent();
        const transport = this.core.deps.transport();
        if (!transport || !this.current(row, link)) continue;
        this.core.atomic(db => { permit?.assertCurrent(); db.prepare("UPDATE hub_sharing_requests SET last_sent_at=?,sent_epoch=? WHERE id=?").run(this.core.now(), link.linkEpoch, row.id); });
        await transport.send(row.fleet_id, { v: 1, type: "exposure.request", requestId: row.id, linkEpoch: link.linkEpoch, payload: request });
      }
    } catch { /* The durable intent remains uncertain; a fresh link or refresh retries the same body. */ }
    finally {
      this.running = false;
      if (this.dirty) { this.dirty = false; this.wake(); }
      if (!this.closed && !this.timer) { this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 5_000); this.timer.unref(); }
    }
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
