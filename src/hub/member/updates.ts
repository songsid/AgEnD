/** Fleet-owned remote update admission; launch is injected by the ordinary update host. */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PublishedVersionLookup } from "../published-version.js";
import type { HubMemberLink } from "../client.js";
import { compareSemver } from "../../update-check.js";
import { validated, HubProtocolError } from "../validation.js";
import { fleetUpdateRequestSchema, fleetUpdateCancelSchema, fleetUpdateStatusAckSchema, type FleetUpdateRequest, type FleetUpdateStatus, type FleetUpdateReason } from "../fleet-update-model.js";
import { IdleUpdateQueue, type IdleUpdate, type IdleUpdateLaunch } from "../../update-idle.js";
export const HUB_MEMBER_UPDATES_MIGRATION = Object.freeze({ component: "s3c-fleet-updates", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_member_update_consent(binding TEXT PRIMARY KEY,allowed INTEGER NOT NULL);
    CREATE TABLE hub_member_updates(id TEXT PRIMARY KEY,binding TEXT NOT NULL,version TEXT NOT NULL,body TEXT,status TEXT,sequence INTEGER NOT NULL DEFAULT 0,
      acked INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,notice_state TEXT,last_sent_at INTEGER NOT NULL DEFAULT 0,last_epoch INTEGER NOT NULL DEFAULT 0);`);
} });
export interface MemberUpdateNotice { requestId: string; hubName: string; requestedBy: string; version: string; state: "waiting" | "done" | "rolled-back" | "expired" | "cancelled" | "failed"; currentVersion?: string }
export interface MemberUpdatesOptions {
  db: Database.Database; binding: string; version: string; hubName: string;
  current(): boolean; service(): boolean; idle(): boolean; now(): number; busy?(): boolean;
  lookup: PublishedVersionLookup;
  canInstall(version: string): Promise<boolean>;
  /** `pressed` (M-3770): the owner pressed Update now for this request (updateNow), not the idle wait starting it. */
  launch(row: IdleUpdate, control: IdleUpdateLaunch, pressed?: boolean): Promise<boolean>;
  /** The one fleet card mirrors this row. It must not launch a second update. */
  onQueue?(row: IdleUpdate): void;
  /** Only a launch currently owned by this process; never inferred from a stale marker alone. */
  active?(id: string): boolean;
  outcome?(row: IdleUpdate): { state: "done" | "rolled-back" | "failed"; currentVersion?: string } | null;
  /** Persist the web notice before returning true. Chat delivery can follow through the existing notice path. */
  notify(notice: MemberUpdateNotice): boolean;
  changed?(): void;
}
interface Row { id: string; binding: string; version: string; body: string | null; status: string | null; sequence: number; acked: number; verified: number; notice_state: string | null; last_sent_at: number; last_epoch: number }
export class HubMemberUpdates {
  private stopped = false;
  private link: HubMemberLink | null = null;
  /** M-3173: whether the Hub this pairing last connected to negotiated fleet-update-v1 (null: not connected yet). A Hub that
   *  did not (a beta.3 Hub: the legacy hello) can't ask for an update, so the owner's switch says so instead of turning on. */
  private hubSupports: boolean | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private readonly queue: IdleUpdateQueue;
  private readonly reasons = new Map<string, FleetUpdateReason>();
  private readonly resultVersions = new Map<string, string>();
  private force: { id: string; current(): boolean } | null = null;
  private recoveringClaim: string | null = null;
  constructor(private readonly options: MemberUpdatesOptions) {
    options.db.prepare("INSERT OR IGNORE INTO hub_member_update_consent VALUES(?,0)").run(options.binding);
    this.queue = new IdleUpdateQueue({ db: options.db, now: options.now, current: () => this.current(),
      allowed: r => (this.allowed() || this.forced(r.id)) && this.row(r.id)?.binding === options.binding,
      idle: () => (this.forced(this.queue.pending()?.id) || options.idle()) && this.ownerWasTold(),
      launch: (r, control) => options.launch(r, control, this.forced(r.id)), changed: r => { this.sync(r); try { options.onQueue?.(r); } catch { /* the card cannot change admission */ } } });
  }
  private current(): boolean { try { return !this.stopped && this.options.current(); } catch { return false; } }
  private service(): boolean { try { return this.options.service() === true; } catch { return false; } }
  private row(id: string): Row | undefined { return this.options.db.prepare("SELECT * FROM hub_member_updates WHERE id=?").get(id) as Row | undefined; }
  consent(): { on: boolean; available: boolean; reason?: "not-service" | "hub-older" } {
    const service = this.service(), hubOlder = this.hubSupports === false;
    const available = !this.stopped && service && !hubOlder;
    const row = this.options.db.prepare("SELECT allowed FROM hub_member_update_consent WHERE binding=?").get(this.options.binding) as { allowed: number } | undefined;
    return { on: !!row?.allowed && available, available, ...(!service ? { reason: "not-service" as const } : hubOlder ? { reason: "hub-older" as const } : {}) };
  }
  private allowed(): boolean { return this.consent().on; }
  setConsent(on: boolean): ReturnType<HubMemberUpdates["consent"]> {
    // Withdrawing consent remains possible while the selected pairing is held. A stale controller cannot grant it.
    if (!this.current() && (on || this.stopped)) throw new HubProtocolError("unavailable");
    if (typeof on !== "boolean") throw new HubProtocolError("invalid");
    this.options.db.prepare("UPDATE hub_member_update_consent SET allowed=? WHERE binding=?").run(on && this.service() ? 1 : 0, this.options.binding);
    try { this.options.changed?.(); } catch { /* presentation only */ }
    void this.tick(); return this.consent();
  }
  private forced(id?: string): boolean { try { return !!id && this.force?.id === id && this.force.current(); } catch { return false; } }
  idlePending(): IdleUpdate | null { return this.current() ? this.queue.pending() : null; }
  /** The fleet card cancelled the wait. A row already updating is left to finish. */
  cancelWaiting(id: string): boolean { return this.current() && this.queue.cancel(id, "owner"); }
  manualCandidate(id: string): string | null {
    const row = this.row(id); return this.current() && row?.binding === this.options.binding && row.verified ? row.version : null;
  }
  async updateNow(id: string, current: () => boolean): Promise<boolean> {
    const row = this.queue.get(id);
    if (!this.manualCandidate(id) || !current() || !row || !["waiting", "starting"].includes(row.state) || this.options.now() >= row.expiresAt) return false;
    const force = { id, current }; this.force = force;
    try { await this.tick(); return this.queue.get(id)?.state === "updating"; }
    finally { if (this.force === force) this.force = null; }
  }
  private ownerWasTold(): boolean { const row = this.queue.pending(); return !!row && this.row(row.id)?.notice_state === "waiting"; }
  private eligible(link: HubMemberLink): boolean { return this.current() && link.current() && link.features.has("fleet-update-v1"); }
  connected(link: HubMemberLink | null): void {
    // M-3173: what this Hub can do is known once it has welcomed this Fleet; disconnected, the last answer stands.
    if (link) {
      const supports = link.features.has("fleet-update-v1");
      if (supports !== this.hubSupports) { this.hubSupports = supports; try { this.options.changed?.(); } catch { /* presentation only */ } }
    }
    this.link = link && this.eligible(link) ? link : null; void this.tick();
  }
  receive(input: unknown, link: HubMemberLink): void {
    const value = validated(fleetUpdateRequestSchema, input); if (!this.eligible(link)) return;
    const body = JSON.stringify(value), prior = this.row(value.id);
    if (prior && (prior.binding !== this.options.binding || prior.version !== value.version || (prior.body && prior.body !== body))) throw new HubProtocolError("conflict");
    this.options.db.prepare(`INSERT INTO hub_member_updates(id,binding,version,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=COALESCE(body,excluded.body)`)
      .run(value.id, this.options.binding, value.version, body);
    this.link = link; this.wake();
  }
  cancel(input: unknown, link?: HubMemberLink): void {
    const value = validated(fleetUpdateCancelSchema, input); if (!this.current() || (link && !this.eligible(link))) return;
    const prior = this.row(value.id);
    if (prior && (prior.binding !== this.options.binding || prior.version !== value.version)) return;
    if (link) this.link = link;
    if (!prior) this.options.db.prepare("INSERT INTO hub_member_updates(id,binding,version) VALUES(?,?,?)").run(value.id, this.options.binding, value.version);
    const pending = this.queue.get(value.id);
    if (pending?.state === "updating") { this.sync(pending); return; }
    if (pending) this.queue.cancel(value.id, link ? "hub" : "owner");
    else if (!prior?.status) this.put(value.id, { state: "cancelled" });
    this.wake();
  }
  private put(id: string, status: Omit<FleetUpdateStatus, "id" | "version" | "sequence">): void {
    const row = this.row(id); if (!row || row.binding !== this.options.binding) return;
    const prior = row.status ? JSON.parse(row.status) as FleetUpdateStatus : null;
    const next: FleetUpdateStatus = { id, version: row.version, sequence: row.sequence + 1, ...status };
    if (prior && JSON.stringify({ ...prior, sequence: 0 }) === JSON.stringify({ ...next, sequence: 0 })) return;
    this.options.db.prepare("UPDATE hub_member_updates SET status=?,sequence=?,last_sent_at=0,last_epoch=0 WHERE id=?").run(JSON.stringify(next), next.sequence, id);
    this.notify(id); this.wake();
  }
  private sync(r: IdleUpdate): void {
    const row = this.row(r.id); if (!row || row.binding !== this.options.binding) return;
    const old = row.status ? JSON.parse(row.status) as FleetUpdateStatus : null;
    const state = r.state === "starting" ? "waiting" : r.state;
    const reasonCode: FleetUpdateReason | undefined = r.state === "expired" ? "busy-24h" : r.reason === "permission-revoked" ? "owner-disabled"
      : r.state === "failed" ? this.reasons.get(r.id) ?? (r.reason === "interrupted" ? "interrupted" : "launch-failed") : undefined;
    this.put(r.id, { state, waitingSince: r.createdAt, expiresAt: r.expiresAt,
      ...(old?.startedAt !== undefined || state === "updating" ? { startedAt: old?.startedAt ?? r.updatedAt } : {}),
      ...(reasonCode ? { reasonCode } : {}), ...(this.resultVersions.get(r.id) || old?.currentVersion ? { currentVersion: this.resultVersions.get(r.id) ?? old!.currentVersion } : {}) });
  }
  private notify(id: string): void {
    const row = this.row(id); if (!row?.body || !row.status) return;
    const status = JSON.parse(row.status) as FleetUpdateStatus;
    if (status.state === "updating" || status.state === "refused" || status.reasonCode === "offline-7d" || row.notice_state === status.state) return;
    const request = JSON.parse(row.body) as FleetUpdateRequest;
    try {
      if (this.options.notify({ requestId: id, hubName: this.options.hubName, requestedBy: request.requestedBy.name, version: request.version,
        state: status.state, ...(status.currentVersion ? { currentVersion: status.currentVersion } : {}) }))
        this.options.db.prepare("UPDATE hub_member_updates SET notice_state=? WHERE id=?").run(status.state, id);
    } catch { /* retry the durable owner notice before launching */ }
  }
  view(id: string): (FleetUpdateRequest & { state: "queued" | FleetUpdateStatus["state"]; currentVersion?: string }) | null {
    const row = this.row(id); if (!this.current() || row?.binding !== this.options.binding || !row.body) return null;
    const request = JSON.parse(row.body) as FleetUpdateRequest, status = row.status ? JSON.parse(row.status) as FleetUpdateStatus : null;
    return { ...request, state: status?.state ?? "queued", ...(status?.currentVersion ? { currentVersion: status.currentVersion } : {}) };
  }
  acknowledge(input: unknown, link: HubMemberLink): void {
    const ack = validated(fleetUpdateStatusAckSchema, input), row = this.row(ack.id);
    if (!this.eligible(link) || this.link !== link || !row || row.binding !== this.options.binding || row.version !== ack.version || row.sequence !== ack.sequence) return;
    this.options.db.prepare("UPDATE hub_member_updates SET acked=? WHERE id=?").run(ack.sequence, ack.id);
  }
  private async check(row: Row, link: HubMemberLink): Promise<void> {
    const request = JSON.parse(row.body!) as FleetUpdateRequest;
    let reason: FleetUpdateReason | null = this.options.busy?.() ? "update-running" : !this.service() ? "not-service" : !this.allowed() ? "owner-disabled"
      : compareSemver(this.options.version, request.version) !== -1 ? "already-current" : this.options.now() >= request.expiresAt ? "offline-7d" : null;
    if (!reason) {
      let found: Awaited<ReturnType<PublishedVersionLookup>>;
      try { found = await this.options.lookup(request.version); } catch { found = "unavailable"; }
      if (!this.eligible(link) || this.row(row.id)?.status) return;
      reason = !this.allowed() ? "owner-disabled" : found === "not-found" ? "version-not-found" : found !== "found" ? "npm-unavailable" : null;
    }
    if (!reason) {
      let permitted = false; try { permitted = await this.options.canInstall(request.version); } catch { /* fail closed */ }
      if (!this.eligible(link) || this.row(row.id)?.status) return;
      reason = !this.allowed() ? "owner-disabled" : !permitted ? "no-permission" : null;
    }
    if (reason) { this.put(row.id, { state: reason === "offline-7d" ? "expired" : "refused", reasonCode: reason, ...(reason === "already-current" ? { currentVersion: this.options.version } : {}) }); return; }
    if (!this.eligible(link) || !this.allowed() || this.row(row.id)?.status) return;
    if (this.options.now() >= request.expiresAt) { this.put(row.id, { state: "expired", reasonCode: "offline-7d" }); return; }
    if (this.queue.pending() || this.options.busy?.()) { this.put(row.id, { state: "refused", reasonCode: "update-running" }); return; }
    this.options.db.prepare("UPDATE hub_member_updates SET verified=1 WHERE id=?").run(row.id);
    this.queue.request({ id: row.id, version: request.version });
  }
  /** Startup never replays a durable updating claim, even when the updater died without sending a result. */
  private reconcileClaim(): void {
    const row = this.queue.pending();
    if (row?.state === "updating" && row.id === this.recoveringClaim && !this.options.active?.(row.id)) {
      // A composed host may still be proving service readiness. Unknown is not success or failure.
      const outcome = this.options.outcome ? this.options.outcome(row) : (compareSemver(this.options.version, row.version) === 0 ? { state: "done" as const, currentVersion: this.options.version }
        : { state: "failed" as const, currentVersion: this.options.version });
      if (outcome) this.complete(row.id, outcome.state, outcome.currentVersion, "interrupted");
    }
  }
  async start(): Promise<void> {
    if (!this.current()) return;
    const pending = this.queue.pending();
    this.recoveringClaim = pending?.state === "updating" ? pending.id : null;
    this.reconcileClaim();
    await this.queue.start(); await this.tick();
  }
  complete(id: string, state: "done" | "rolled-back" | "failed", currentVersion?: string, reason: FleetUpdateReason = "launch-failed"): void {
    if (!this.current()) return;
    if (state === "failed") this.reasons.set(id, reason);
    if (currentVersion) this.resultVersions.set(id, currentVersion);
    this.queue.settle(id, state);
  }
  private wake(): void {
    if (!this.current()) return;
    this.dirty = true;
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        do {
          this.dirty = false; const link = this.link;
          if (link && this.eligible(link)) {
            const rows = this.options.db.prepare("SELECT * FROM hub_member_updates WHERE binding=? AND body IS NOT NULL AND status IS NULL ORDER BY rowid").all(this.options.binding) as Row[];
            for (const row of rows) if (this.eligible(link)) await this.check(row, link);
          }
          this.reconcileClaim();
          const pending = this.queue.pending(); if (pending) { this.sync(pending); this.notify(pending.id); }
          await this.queue.pump(); await this.flush();
        } while (this.dirty && this.current());
      }).catch(() => { /* optional remote control must not hold ordinary Fleet work */ }).finally(() => { this.running = null; });
    }
  }
  async tick(): Promise<void> { this.wake(); await this.running; }
  private async flush(): Promise<void> {
    const link = this.link; if (!link || !this.eligible(link)) return;
    const rows = this.options.db.prepare("SELECT * FROM hub_member_updates WHERE binding=? AND status IS NOT NULL AND sequence>acked").all(this.options.binding) as Row[];
    for (const row of rows) {
      if (!this.eligible(link) || this.link !== link) return;
      if (row.last_epoch === link.linkEpoch && this.options.now() - row.last_sent_at < 30_000) continue;
      this.notify(row.id);
      this.options.db.prepare("UPDATE hub_member_updates SET last_epoch=?,last_sent_at=? WHERE id=?").run(link.linkEpoch, this.options.now(), row.id);
      try { await link.send({ v: 1, type: "fleet.update-status", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: JSON.parse(row.status!) as FleetUpdateStatus }); } catch { /* durable retry */ }
    }
  }
  close(): void { this.stopped = true; this.link = null; this.queue.close(); }
}
