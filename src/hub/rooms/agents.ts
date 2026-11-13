/** Durable group-room deliveries. Room consent is separate from one-to-one grants. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { exposureOf, readExposure } from "../catalog.js";
import { personFromString, type HubCore } from "../http/core.js";
import { personKeyString } from "../identity.js";
import { HUB_LIMITS, HUB_ROOM_ASK_CAPABILITY, roomAskSchema, roomAnswerSchema, agentStateSchema } from "../protocol.js";
import type { HubLinkContext } from "../server.js";
import type { HubAgentState, HubRoomAsk, HubRoomAnswer, HubRoomAnswerAck, HubTx } from "../types.js";
import { HubProtocolError, validated } from "../validation.js";
import type { RoomEvent, RoomMessage } from "./types.js";

type DB = Database.Database;
export interface RoomPostRow {
  id: string; room_id: string; sequence: number; author_kind: RoomMessage["author"]["kind"]; author_id: string; author_subject: string;
  author_name: string; content_ref: string; digest: string; mentions: string; reply_to: string | null; idempotency_key: string | null; created_at: number;
  answer_to?: string | null; delivery_id?: string | null; stage?: RoomMessage["stage"] | null;
}
interface Delivery {
  id: string; room_id: string; parent_id: string; reply_id: string; exposure_id: string; exposure_revision: number; fleet_id: string; owner: string;
  asker: string; asker_member: string; agent_member: string; payload_ref: string; payload_digest: string;
  state: "queued" | "sent" | "answered" | "retired" | "expired"; sent_epoch: number; last_sent_at: number; created_at: number; expires_at: number;
  answer_id: string | null; answer_digest: string | null;
}
interface Member { id: string; subject: string; joined_sequence: number; owner_at_join: string | null }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pending = (d: Delivery) => d.state === "queued" || d.state === "sent";
const trim = (value: string, bytes: number) => {
  if (Buffer.byteLength(value) <= bytes) return value;
  // Truncate at a Unicode codepoint so the frozen payload has one stable JSON representation.
  let out = "", used = 0;
  for (const c of value) { const n = Buffer.byteLength(c); if (used + n > bytes) break; out += c; used += n; }
  return out;
};
export class HubRoomAgents {
  private links = new Map<string, HubLinkContext>();
  private states = new Map<string, { link: HubLinkContext; value: HubAgentState }>();
  private flights = new Map<string, Promise<boolean>>();
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private stopped = false;
  constructor(private readonly core: HubCore, private readonly emit: (event: RoomEvent) => void,
    private readonly project: (post: RoomPostRow) => RoomMessage) {}
  private live(): boolean { return !this.stopped && this.core.live(); }
  private supports(link: HubLinkContext): boolean { return link.current() && link.features.has("welcome-caps-v1") && link.features.has(HUB_ROOM_ASK_CAPABILITY); }
  noteLink(link: HubLinkContext): void {
    if (this.links.get(link.fleetId) === link) return;
    this.links.set(link.fleetId, link);
    this.core.atomic(db => {
      for (const row of db.prepare("SELECT DISTINCT e.id AS exposure_id FROM hub_exposures e JOIN hub_room_members m ON m.kind='agent' AND m.subject=e.id WHERE e.fleet_id=?").all(link.fleetId) as { exposure_id: string }[]) this.presenceChanged(row.exposure_id);
    });
  }
  disconnected(fleetId: string): void {
    const link = this.links.get(fleetId); if (!link || link.current()) return;
    this.links.delete(fleetId);
    const ids = this.core.atomic(db => db.prepare("SELECT id FROM hub_exposures WHERE fleet_id=?").all(fleetId) as { id: string }[]);
    for (const row of ids) this.presenceChanged(row.id);
  }
  presence(exposureId: string) {
    return this.core.atomic(db => {
      const row = readExposure(db, exposureId);
      if (!row) return { presence: "offline" as const };
      const e = exposureOf(row), link = this.links.get(e.fleetId);
      if (e.state !== "published") return { presence: "paused" as const, presenceReason: "operator" as const };
      if (!link?.current()) return { presence: "offline" as const };
      if (!this.supports(link)) return { presence: "offline" as const, presenceReason: "update" as const };
      const state = this.states.get(exposureId);
      const value = state?.link === link ? state.value : null;
      return { presence: value?.state ?? "idle", ...(value?.reason ? { presenceReason: value.reason } : {}), ...(value?.note ? { presenceNote: value.note } : {}) };
    });
  }
  publicationChanged(fleetId?: string, exposureId?: string): void {
    if (fleetId) this.sweepScope("fleet_id=?", fleetId);
    if (exposureId) this.sweepScope("exposure_id=?", exposureId);
    const ids = this.core.atomic(db => db.prepare(`SELECT DISTINCT m.subject FROM hub_room_members m JOIN hub_exposures e ON e.id=m.subject
      WHERE m.kind='agent' AND (? IS NULL OR e.fleet_id=?) AND (? IS NULL OR e.id=?)`).all(fleetId ?? null, fleetId ?? null, exposureId ?? null, exposureId ?? null) as { subject: string }[]);
    for (const row of ids) this.presenceChanged(row.subject); this.wake();
  }
  private presenceChanged(exposureId: string): void {
    const projection = this.presence(exposureId);
    const rooms = this.core.atomic(db => db.prepare("SELECT room_id FROM hub_room_members WHERE kind='agent' AND subject=?").all(exposureId) as { room_id: string }[]);
    for (const { room_id: roomId } of rooms) this.emit({ type: "presence.changed", roomId, data: { roomId, memberId: exposureId, ...projection } });
  }
  state(input: HubAgentState, link: HubLinkContext): void {
    const body = validated(agentStateSchema, input);
    if (!this.supports(link)) throw new HubProtocolError("incompatible");
    this.core.atomic(db => {
      const e = readExposure(db, body.exposureId);
      if (!e || e.fleet_id !== link.fleetId || e.owner !== personKeyString(link.owner)) throw new HubProtocolError("denied");
    });
    this.states.set(body.exposureId, { link, value: body }); this.presenceChanged(body.exposureId); this.wake();
  }
  progress(db: DB, parentId: string) {
    const rows = db.prepare("SELECT state,COUNT(*) AS n FROM hub_room_deliveries WHERE parent_id=? GROUP BY state").all(parentId) as { state: Delivery["state"]; n: number }[];
    if (!rows.length) return undefined;
    const n = (state: Delivery["state"]) => rows.find(r => r.state === state)?.n ?? 0;
    return { total: rows.reduce((v, r) => v + r.n, 0), answered: n("answered"), working: n("sent"), later: n("queued") };
  }
  /** Called inside the person's message transaction, once per idempotency key. */
  enqueue(db: DB, tx: HubTx, parent: RoomPostRow, askerMember: string): void {
    const mentions = JSON.parse(parent.mentions) as string[];
    if (!mentions.length) return;
    const room = db.prepare("SELECT name FROM hub_group_rooms WHERE id=?").get(parent.room_id) as { name: string };
    const agents = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent'").all(parent.room_id) as Member[];
    const selected = agents.filter(m => mentions.includes("all") || mentions.includes(m.subject));
    const people = db.prepare("SELECT id,subject FROM hub_room_members WHERE room_id=? AND kind='person'").all(parent.room_id) as { id: string; subject: string }[];
    if (mentions.some(m => m !== "all" && !agents.some(a => a.subject === m) && !people.some(p => p.id === m || p.subject === m))) throw new HubProtocolError("invalid");
    if ((db.prepare("SELECT COUNT(*) AS n FROM hub_room_deliveries WHERE state IN ('queued','sent')").get() as { n: number }).n + selected.length > 4096) throw new HubProtocolError("backpressure");
    const personMember = db.prepare("SELECT joined_sequence FROM hub_room_members WHERE id=?").get(askerMember) as { joined_sequence: number };
    for (const m of selected) {
      const e = readExposure(db, m.subject);
      if (!e || e.owner !== m.owner_at_join) throw new HubProtocolError("revoked");
      const rows = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND sequence<? AND sequence>=? AND author_kind<>'system' AND (stage IS NULL OR stage='answered') ORDER BY sequence DESC LIMIT 30")
        .all(parent.room_id, parent.sequence, Math.max(m.joined_sequence, personMember.joined_sequence)) as RoomPostRow[];
      const anchor = parent.reply_to ? db.prepare("SELECT * FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=? AND sequence>=?").get(parent.reply_to, parent.room_id, m.joined_sequence, personMember.joined_sequence) as RoomPostRow | undefined : undefined;
      if (anchor && !rows.some(r => r.id === anchor.id)) rows.push(anchor);
      rows.sort((a, b) => a.sequence - b.sequence);
      const context = rows.map(row => ({ author: trim(row.author_name, 256), text: trim(this.core.deps.content.get(row.content_ref)?.question ?? "", 2048), at: row.created_at,
        ...(row.id === parent.reply_to ? { repliedTo: true as const } : {}) }));
      const id = randomUUID(), replyId = randomUUID(), now = this.core.now();
      const payload: HubRoomAsk = validated(roomAskSchema, { messageId: id, roomId: parent.room_id, roomName: trim(room.name, 120), exposureId: e.id,
        asker: { name: trim(parent.author_name, 256) }, text: this.core.deps.content.get(parent.content_ref)?.question ?? "", context });
      const bytes = JSON.stringify(payload);
      if (Buffer.byteLength(bytes) + 512 > HUB_LIMITS.frame) throw new HubProtocolError("backpressure");
      const max = (db.prepare("SELECT MAX(sequence) AS n FROM hub_room_posts WHERE room_id=?").get(parent.room_id) as { n: number }).n;
      db.prepare(`INSERT INTO hub_room_posts(id,room_id,sequence,author_kind,author_id,author_subject,author_name,content_ref,digest,mentions,created_at,answer_to,delivery_id,stage)
        VALUES(?,?,?,'agent',?,?,?,?,?,'[]',?,?,?,'queued')`).run(replyId, parent.room_id, max + 1, e.id, e.owner, e.display_name,
          this.core.deps.content.put(tx, { question: "" }), "", now, parent.id, id);
      db.prepare(`INSERT INTO hub_room_deliveries(id,room_id,parent_id,reply_id,exposure_id,exposure_revision,fleet_id,owner,asker,asker_member,agent_member,payload_ref,payload_digest,state,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, parent.room_id, parent.id, replyId, e.id, e.revision, e.fleet_id, e.owner, parent.author_subject, askerMember, m.id,
          this.core.deps.content.put(tx, { question: bytes }), digest(bytes), now, now + 24 * 60 * 60_000);
    }
  }
  publishQueued(parentId: string): void {
    const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_deliveries WHERE parent_id=?").all(parentId) as Delivery[]);
    for (const d of rows) this.update(d, true);
  }
  private valid(db: DB, d: Delivery): boolean {
    const room = db.prepare("SELECT archived FROM hub_group_rooms WHERE id=?").get(d.room_id) as { archived: number } | undefined;
    const e = readExposure(db, d.exposure_id);
    return !!room && !room.archived && !!e && e.owner === d.owner && e.fleet_id === d.fleet_id && e.revision === d.exposure_revision
      && !!db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=? AND kind='person' AND subject=?").get(d.asker_member, d.room_id, d.asker)
      && !!db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=? AND kind='agent' AND subject=? AND owner_at_join=?").get(d.agent_member, d.room_id, d.exposure_id, d.owner);
  }
  private update(d: Delivery, added = false): void {
    const data = this.core.atomic(db => {
      const reply = db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(d.reply_id) as RoomPostRow;
      return { value: { roomId: d.room_id, message: this.project(reply), parent: { id: d.parent_id, ask: this.progress(db, d.parent_id) } }, sequence: reply.sequence };
    });
    this.emit({ type: added ? "message.added" : "message.updated", roomId: d.room_id, data: data.value, sequence: data.sequence }); this.emit({ type: "unread.changed", roomId: d.room_id, data: { roomId: d.room_id } });
  }
  /** Room reads/changes scope validity work; the global timer loads due expirations only. */
  sweep(roomId?: string): void {
    if (!this.live()) return;
    if (roomId) this.sweepScope("room_id=?", roomId);
    else this.sweepScope("expires_at<=?", this.core.now(), true);
  }
  private sweepScope(where: string, value: string | number, dueOnly = false): void {
    const changed = this.core.atomic(db => {
      const rows = db.prepare(`SELECT * FROM hub_room_deliveries WHERE state IN ('queued','sent') AND ${where}`).all(value) as Delivery[];
      return rows.filter(d => {
        const expired = this.core.now() >= d.expires_at;
        if (!expired && (dueOnly || this.valid(db, d))) return false;
        db.prepare("UPDATE hub_room_deliveries SET state=? WHERE id=?").run(expired ? "expired" : "retired", d.id);
        db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(d.reply_id); return true;
      });
    });
    for (const d of changed) this.update(d);
  }
  wake(): void {
    if (!this.live()) return;
    this.sweep();
    const targets = this.core.atomic(db => ({
      fleets: db.prepare("SELECT DISTINCT fleet_id FROM hub_room_deliveries WHERE state IN ('queued','sent')").all() as { fleet_id: string }[],
      deadline: (db.prepare("SELECT MIN(expires_at) at FROM hub_room_deliveries WHERE state IN ('queued','sent')").get() as { at: number | null }).at,
    }));
    let retry = false;
    for (const { fleet_id } of targets.fleets) {
      const link = this.links.get(fleet_id);
      if (!link || !this.supports(link) || !this.core.deps.transport()) continue;
      retry = true; void this.flush(fleet_id).catch(() => {});
    }
    // Offline fleets need no polling. Live transient failures retry at30s; link/state/post/publication changes wake immediately.
    const at = Math.min(targets.deadline ?? Infinity, retry ? this.core.now() + 30_000 : Infinity);
    if (at < this.timerAt) {
      if (this.timer) clearTimeout(this.timer);
      this.timerAt = at; this.timer = setTimeout(() => { this.timer = null; this.timerAt = Infinity; this.wake(); }, Math.max(1, at - this.core.now())); this.timer.unref();
    }
  }
  flush(fleetId: string): Promise<boolean> {
    const prior = this.flights.get(fleetId); if (prior) return prior;
    const flight = this.flushFleet(fleetId).finally(() => { if (this.flights.get(fleetId) === flight) this.flights.delete(fleetId); });
    this.flights.set(fleetId, flight); return flight;
  }
  private async flushFleet(fleetId: string): Promise<boolean> {
    if (!this.live()) return false;
    const link = this.links.get(fleetId), transport = this.core.deps.transport();
    if (!link || !this.supports(link) || !transport) return false;
    const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_deliveries WHERE fleet_id=? AND state IN ('queued','sent') AND (sent_epoch<>? OR last_sent_at<=?) ORDER BY created_at,rowid LIMIT 64").all(fleetId, link.linkEpoch, this.core.now() - 30_000) as Delivery[]);
    for (const d of rows) {
      if (!this.live() || !this.supports(link) || this.links.get(fleetId) !== link) return false;
      try {
        if (!await this.core.eligible(personFromString(d.asker)) || !await this.core.eligible(personFromString(d.owner))) continue;
        const permit = await this.core.groupExposure(d.exposure_id, personFromString(d.asker), { requestId: d.id, current: () => this.live() && link.current() && this.links.get(fleetId) === link });
        const payload = this.core.atomic(db => {
          const current = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery;
          const e = readExposure(db, d.exposure_id);
          if (!pending(current) || !this.valid(db, current) || this.core.now() >= current.expires_at || !e || exposureOf(e).state !== "published") return null;
          const state = this.states.get(d.exposure_id); if (state?.link === link && state.value.state === "paused") return null;
          const bytes = this.core.deps.content.get(d.payload_ref)?.question;
          if (bytes === undefined || digest(bytes) !== d.payload_digest) throw new HubProtocolError("uncertain");
          return validated(roomAskSchema, JSON.parse(bytes));
        }, permit);
        if (!payload || !link.current()) continue;
        // Persist dispatch intent before the socket write: a fast member answer may arrive before send() settles.
        this.core.atomic(db => {
          if (!this.valid(db, d) || this.core.now() >= d.expires_at) throw new HubProtocolError("stale");
          db.prepare("UPDATE hub_room_deliveries SET state='sent',sent_epoch=?,last_sent_at=? WHERE id=? AND state IN ('queued','sent')").run(link.linkEpoch, this.core.now(), d.id);
          db.prepare("UPDATE hub_room_posts SET stage='working' WHERE id=? AND stage='queued'").run(d.reply_id);
        }, permit);
        try {
          permit.assertCurrent();
          await transport.send(fleetId, { v: 1, type: "room.ask", requestId: d.id, linkEpoch: link.linkEpoch, payload });
        } catch {
          if (this.live()) this.core.atomic(db => {
            db.prepare("UPDATE hub_room_deliveries SET state='queued',sent_epoch=0,last_sent_at=0 WHERE id=? AND state='sent' AND sent_epoch=? AND answer_id IS NULL").run(d.id, link.linkEpoch);
            db.prepare("UPDATE hub_room_posts SET stage='queued' WHERE id=? AND stage='working' AND EXISTS(SELECT 1 FROM hub_room_deliveries WHERE id=? AND state='queued')").run(d.reply_id, d.id);
          });
        }
        if (!this.live()) return false;
        this.update(d);
      } catch { /* A failed/unknown operational read holds this exact target until its deadline or a fresh retry. */ }
    }
    return true;
  }
  async answer(input: HubRoomAnswer, link: HubLinkContext): Promise<HubRoomAnswerAck> {
    const body = validated(roomAnswerSchema, input), hash = digest(JSON.stringify(body));
    if (!this.supports(link)) throw new HubProtocolError("incompatible");
    const d = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(body.messageId) as Delivery | undefined);
    if (!d || d.fleet_id !== link.fleetId || d.owner !== personKeyString(link.owner) || body.roomId !== d.room_id || body.exposureId !== d.exposure_id || !d.sent_epoch) throw new HubProtocolError("denied");
    if (d.answer_id) {
      if (d.answer_id !== body.answerId || d.answer_digest !== hash) throw new HubProtocolError("conflict");
      return { messageId: d.id, answerId: body.answerId };
    }
    const terminal = this.core.atomic(db => !pending(d) || !this.valid(db, d) || this.core.now() >= d.expires_at);
    if (terminal) {
      this.core.atomic(db => {
        if (!link.current()) throw new HubProtocolError("stale");
        const current = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery;
        if (current.answer_id && (current.answer_id !== body.answerId || current.answer_digest !== hash)) throw new HubProtocolError("conflict");
        db.prepare("UPDATE hub_room_deliveries SET state='retired',answer_id=?,answer_digest=? WHERE id=?").run(body.answerId, hash, d.id);
        db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(d.reply_id);
      });
      this.update(d); return { messageId: d.id, answerId: body.answerId };
    }
    const permit = await this.core.groupExposure(d.exposure_id, personFromString(d.asker), { requestId: d.id, current: () => this.live() && link.current() });
    if (!await this.core.eligible(personFromString(d.asker)) || !await this.core.eligible(personFromString(d.owner))) throw new HubProtocolError("unavailable");
    this.core.atomic((db, tx) => {
      if (!link.current()) throw new HubProtocolError("stale");
      const current = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery;
      if (current.answer_id) { if (current.answer_id !== body.answerId || current.answer_digest !== hash) throw new HubProtocolError("conflict"); return; }
      const e = readExposure(db, d.exposure_id);
      if (pending(current) && this.valid(db, current) && e && exposureOf(e).state !== "published") throw new HubProtocolError("unavailable");
      const disclose = pending(current) && this.valid(db, current) && this.core.now() < current.expires_at && !!e && exposureOf(e).state === "published";
      db.prepare("UPDATE hub_room_deliveries SET state=?,answer_id=?,answer_digest=? WHERE id=?").run(disclose ? "answered" : "retired", body.answerId, hash, d.id);
      if (disclose) {
        const seq = (db.prepare("SELECT MAX(sequence) AS n FROM hub_room_posts WHERE room_id=?").get(d.room_id) as { n: number }).n + 1;
        db.prepare("UPDATE hub_room_posts SET content_ref=?,stage='answered',sequence=?,created_at=? WHERE id=?").run(this.core.deps.content.put(tx, { question: body.text }), seq, this.core.now(), d.reply_id);
        this.core.audit(tx, { requestId: d.id, actor: { kind: "person", person: link.owner }, action: "room.answer", result: "completed", roomId: d.room_id, messageId: d.reply_id, exposureId: d.exposure_id, fleetId: d.fleet_id });
      } else db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(d.reply_id);
    }, permit);
    this.update(d); return { messageId: d.id, answerId: body.answerId };
  }
  async close(): Promise<void> {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.links.clear(); this.states.clear(); await Promise.allSettled([...this.flights.values()]);
  }
}
