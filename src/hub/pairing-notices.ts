/** S-90 security notices. The queue is in the credential's database transaction; sockets are only delivery. */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { HubMigration } from "./db.js";
import type { HubAuditStore } from "./audit/index.js";
import type { HubDirectory, HubRequestContext, PersonKey, HubServerTransport } from "./types.js";
import type { HubQuickPairingNotice } from "./pairing.js";
import type { HubTransportState, HubTransportStore } from "./store.js";
import type { HubLinkContext } from "./server.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError, identifier, uuid, validated, parseStrictJson } from "./validation.js";
import { pairingNoticeSchema } from "./protocol.js";

export const HUB_PAIRING_NOTICES_MIGRATION: HubMigration = Object.freeze({ component: "s90-pairing-notices", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_pairing_notices(id TEXT PRIMARY KEY, fleet_id TEXT NOT NULL, generation INTEGER NOT NULL,
    owner TEXT NOT NULL, initiating_session TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(fleet_id,generation));
    CREATE TABLE hub_pairing_notice_targets(notice_id TEXT NOT NULL REFERENCES hub_pairing_notices(id),
    kind TEXT NOT NULL CHECK(kind IN ('person','fleet','session')), target TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','delivered','failed')), PRIMARY KEY(notice_id,kind,target));`);
} });
export type PairingNoticeView = import("zod").infer<typeof pairingNoticeSchema>;
interface NoticeRow { id: string; fleet_id: string; generation: number; owner: string; initiating_session: string; body: string }
export class HubPairingNotices {
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly links = new Map<string, HubLinkContext>();
  private readonly sending = new Set<string>();
  private readonly sentAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly options: {
    db: Database.Database; store: HubTransportStore; administrator: PersonKey; directory: HubDirectory;
    audit: Pick<HubAuditStore, "appendInTransaction">; current(): boolean;
    transport(): Pick<HubServerTransport, "send"> | null; now?: () => number;
  }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private check() { if (this.closed || !this.options.current()) throw new HubProtocolError("unavailable"); }
  private audit(db: Database.Database, action: string, fleetId: string, actor: PersonKey | null, requestId: string,
    result: "completed" | "allowed" | "denied" = "completed") {
    this.check();
    if (db !== this.options.db || !db.inTransaction) throw new HubProtocolError("unavailable");
    const out: unknown = this.options.audit.appendInTransaction({ id: randomUUID(), sequence: 0, at: this.now(), requestId,
      actor: actor ? { kind: "person", person: actor } : { kind: "local-host" }, action, fleetId, result,
      policyVersion: this.options.store.read().revocationVersion }, db);
    if (out && typeof (out as { then?: unknown }).then === "function") {
      void Promise.resolve(out).catch(() => undefined); throw new HubProtocolError("unavailable");
    }
    this.check();
  }
  private view(row: NoticeRow): PairingNoticeView {
    const notice = validated(pairingNoticeSchema, parseStrictJson(row.body));
    if (notice.id !== row.id || notice.fleetId !== row.fleet_id || notice.generation !== row.generation) throw new HubProtocolError("uncertain");
    const fleet = this.options.store.read().fleets.find(f => f.id === notice.fleetId);
    return { ...notice, revoked: !fleet || fleet.status !== "active" || fleet.generation !== notice.generation };
  }
  /** Must fail the outer credential transaction if any recipient or required queued audit cannot be retained. */
  enqueue = (db: Database.Database, input: HubQuickPairingNotice, state: HubTransportState): void => {
    this.check();
    if (db !== this.options.db || !db.inTransaction) throw new HubProtocolError("unavailable");
    const notice = validated(pairingNoticeSchema, { id: randomUUID(), fleetId: input.fleetId, generation: input.generation,
      label: input.label, at: input.at, source: "group", revoked: false });
    const owner = personKeyString(input.owner);
    const fleet = state.fleets.find(f => f.id === notice.fleetId);
    if (!fleet || fleet.status !== "active" || fleet.generation !== notice.generation || personKeyString(fleet.owner) !== owner) throw new HubProtocolError("unavailable");
    const count = (db.prepare("SELECT count(*) n FROM hub_pairing_notices").get() as { n: number }).n;
    if (count >= 1024) throw new HubProtocolError("backpressure"); // Never evict unread offline security notices.
    db.prepare("INSERT INTO hub_pairing_notices VALUES(?,?,?,?,?,?)").run(notice.id, notice.fleetId, notice.generation, owner,
      validated(identifier, input.initiatingSessionId), JSON.stringify(notice));
    const people = new Set([owner, personKeyString(this.options.administrator)]);
    for (const person of people) {
      db.prepare("INSERT INTO hub_pairing_notice_targets VALUES(?,'person',?,'queued')").run(notice.id, person);
      this.audit(db, "pairing.notice-queued", notice.fleetId, input.owner, notice.id);
    }
    for (const other of state.fleets.filter(f => f.id !== notice.fleetId && f.status === "active" && f.credentialHash && personKeyString(f.owner) === owner)) {
      db.prepare("INSERT INTO hub_pairing_notice_targets VALUES(?,'fleet',?,'queued')").run(notice.id, other.id);
      this.audit(db, "pairing.notice-queued", notice.fleetId, input.owner, notice.id);
    }
  };
  /** Called after commit, or when a ready member reconnects. Queue retention never depends on this callback. */
  committed = (): void => {
    for (const listener of this.listeners) { try { listener(); } catch { /* its authenticated read retries */ } }
    for (const link of this.links.values()) void this.flushFleet(link).catch(() => undefined);
  };
  subscribe(listener: () => void): () => void {
    this.check(); if (this.listeners.size >= 64) throw new HubProtocolError("backpressure");
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  /** Read/ack uses current eligible person authority, never pair/publish permission or a URL bearer token. */
  async forSession(ctx: HubRequestContext): Promise<PairingNoticeView[]> {
    const who = await ctx.requirePerson(), actor = await ctx.current(); this.check();
    if (ctx.isCurrent?.() !== true || actor.kind !== "directory" || personKeyString(actor.person) !== personKeyString(who)) throw new HubProtocolError("revoked");
    const person = personKeyString(who);
    return this.options.db.transaction(() => {
      this.check(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
      const rows = this.options.db.prepare(`SELECT n.* FROM hub_pairing_notices n JOIN hub_pairing_notice_targets t ON t.notice_id=n.id
        WHERE t.kind='person' AND t.target=? AND n.initiating_session<>? ORDER BY n.rowid DESC LIMIT 100`).all(person, actor.sessionId) as NoticeRow[];
      const notices = rows.map(row => this.view(row));
      for (const notice of notices) this.audit(this.options.db, "pairing.notice-disclosed", notice.fleetId, who, ctx.requestId, "allowed");
      if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
      return notices;
    }).immediate();
  }
  async acknowledgeSession(ctx: HubRequestContext, noticeId: string): Promise<void> {
    validated(uuid, noticeId);
    const mine = await this.forSession(ctx), notice = mine.find(n => n.id === noticeId);
    if (!notice) throw new HubProtocolError("not-found");
    const actor = await ctx.current();
    if (actor.kind !== "directory" || ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
    this.options.db.transaction(() => {
      this.check(); const db = this.options.db;
      const recipient = db.prepare(`SELECT 1 FROM hub_pairing_notice_targets t JOIN hub_pairing_notices n ON n.id=t.notice_id
        WHERE t.notice_id=? AND t.kind='person' AND t.target=? AND n.initiating_session<>?`).get(noticeId, personKeyString(actor.person), actor.sessionId);
      if (!recipient) throw new HubProtocolError("not-found");
      if (db.prepare("SELECT 1 FROM hub_pairing_notice_targets WHERE notice_id=? AND kind='session' AND target=? AND state='delivered'").get(noticeId, actor.sessionId)) return;
      this.audit(db, "pairing.notice-delivered", notice.fleetId, actor.person, ctx.requestId);
      db.prepare("INSERT OR REPLACE INTO hub_pairing_notice_targets VALUES(?,'session',?,'delivered')").run(noticeId, actor.sessionId);
      if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
    }).immediate();
  }
  noteLink(link: HubLinkContext): void {
    if (link.current()) {
      if (this.links.get(link.fleetId) !== link) for (const key of this.sentAt.keys()) if (key.startsWith(`${link.fleetId}/`)) this.sentAt.delete(key);
      this.links.set(link.fleetId, link);
    }
  }
  async flushFleet(link: HubLinkContext): Promise<void> {
    this.check();
    if (!link.current() || !link.features.has("welcome-caps-v1") || !link.features.has("pairing-notices-v1") || this.sending.has(link.fleetId)) return;
    this.sending.add(link.fleetId);
    try {
      const rows = this.options.db.prepare(`SELECT n.* FROM hub_pairing_notices n JOIN hub_pairing_notice_targets t ON t.notice_id=n.id
        WHERE t.kind='fleet' AND t.target=? AND t.state<>'delivered' ORDER BY n.rowid LIMIT 100`).all(link.fleetId) as NoticeRow[];
      const due = rows.filter(row => { const at = this.sentAt.get(`${link.fleetId}/${row.id}/${link.linkEpoch}`); return at === undefined || this.now() - at >= 5000; });
      if (!due.length) return; // No directory polling for an empty or not-yet-due queue.
      const eligible = await this.options.directory.checkEligibility(link.owner);
      this.check(); if (!link.current() || !eligible.eligible || personKeyString(eligible.person.key) !== personKeyString(link.owner)) return;
      const fleet = this.options.store.read().fleets.find(f => f.id === link.fleetId);
      if (!fleet || fleet.status !== "active" || !fleet.credentialHash || personKeyString(fleet.owner) !== personKeyString(link.owner)) return;
      for (const row of due) {
        const key = `${link.fleetId}/${row.id}/${link.linkEpoch}`, before = this.sentAt.get(key);
        if (before !== undefined && this.now() - before < 5000) continue;
        const notice = this.view(row);
        if (row.owner !== personKeyString(link.owner) || !link.current()) throw new HubProtocolError("denied");
        this.options.db.transaction(() => this.audit(this.options.db, "pairing.notice-dispatched", notice.fleetId, link.owner, row.id, "allowed")).immediate();
        if (!link.current()) return;
        try {
          const transport = this.options.transport(); if (!transport) throw new HubProtocolError("unavailable");
          await transport.send(link.fleetId, { v: 1, type: "pairing.notice", requestId: notice.id, linkEpoch: link.linkEpoch, payload: notice });
          this.sentAt.set(key, this.now()); // Only a retained member ACK means delivered.
        } catch {
          this.sentAt.set(key, this.now());
          this.options.db.transaction(() => {
            this.audit(this.options.db, "pairing.notice-failed", notice.fleetId, link.owner, row.id, "denied");
            this.options.db.prepare("UPDATE hub_pairing_notice_targets SET state='failed' WHERE notice_id=? AND kind='fleet' AND target=? AND state<>'delivered'").run(row.id, link.fleetId);
          }).immediate();
        }
      }
    } finally { this.sending.delete(link.fleetId); }
  }
  acknowledgeFleet(link: HubLinkContext, noticeId: string): void {
    validated(uuid, noticeId); this.check();
    if (!link.current() || !link.features.has("welcome-caps-v1") || !link.features.has("pairing-notices-v1")) throw new HubProtocolError("denied");
    this.options.db.transaction(() => {
      const row = this.options.db.prepare(`SELECT n.* FROM hub_pairing_notices n JOIN hub_pairing_notice_targets t ON t.notice_id=n.id
        WHERE n.id=? AND t.kind='fleet' AND t.target=?`).get(noticeId, link.fleetId) as NoticeRow | undefined;
      if (!row || row.owner !== personKeyString(link.owner) || !link.current()) throw new HubProtocolError("not-found");
      const target = this.options.db.prepare("SELECT state FROM hub_pairing_notice_targets WHERE notice_id=? AND kind='fleet' AND target=?").get(noticeId, link.fleetId) as { state: string };
      if (target.state === "delivered") return;
      this.audit(this.options.db, "pairing.notice-delivered", row.fleet_id, link.owner, noticeId);
      this.options.db.prepare("UPDATE hub_pairing_notice_targets SET state='delivered' WHERE notice_id=? AND kind='fleet' AND target=?").run(noticeId, link.fleetId);
      for (const key of this.sentAt.keys()) if (key.startsWith(`${link.fleetId}/${noticeId}/`)) this.sentAt.delete(key);
      if (!link.current()) throw new HubProtocolError("revoked");
    }).immediate();
  }
  start(): void {
    this.check(); if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [id, link] of this.links) {
        if (!link.current()) {
          this.links.delete(id);
          for (const key of this.sentAt.keys()) if (key.startsWith(`${id}/`)) this.sentAt.delete(key);
          continue;
        }
        void this.flushFleet(link).catch(() => undefined);
      }
    }, 1000); this.timer.unref();
  }
  close(): void {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    this.listeners.clear(); this.links.clear(); this.sentAt.clear();
  }
}
