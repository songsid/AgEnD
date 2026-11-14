/** Durable answer return to the agent that posted a person's request. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { HubCore } from "../http/core.js";
import { personFromString } from "../http/core.js";
import { personKeyString } from "../identity.js";
import { readExposure, exposureOf } from "../catalog.js";
import type { HubLinkContext } from "../server.js";
import type { HubRoomPostAnswer, HubTx } from "../types.js";
import { roomPostAnswerSchema, roomPostAnswerAckSchema } from "../protocol.js";
import { HubProtocolError, validated } from "../validation.js";
import type { RoomPostRow } from "./agents.js";
type DB = Database.Database;
interface ReturnRow { id: string; post_id: string; answer_id: string; exposure_id: string; owner: string; fleet_id: string; payload_ref: string; payload_digest: string; expires_at: number; sent_epoch: number }
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export class RoomPostReplies {
  private readonly links = new Map<string, HubLinkContext>();
  private readonly flights = new Map<string, Promise<void>>();
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly core: HubCore) {}
  private supports(link: HubLinkContext): boolean { return this.core.live() && !this.stopped && link.current() && ["welcome-caps-v1", "room-ask-v1", "room-post-v1"].every(f => link.features.has(f)); }
  noteLink(link: HubLinkContext): void { this.links.set(link.fleetId, link); this.wake(); }
  enqueue(db: DB, tx: HubTx, answer: RoomPostRow): void {
    const line = db.prepare("SELECT return_post_id FROM hub_room_post_lineage WHERE post_id=?").get(answer.id) as { return_post_id: string | null } | undefined;
    if (!line?.return_post_id) return;
    const op = db.prepare("SELECT * FROM hub_room_agent_operations WHERE post_id=? AND receipt_id IS NOT NULL").get(line.return_post_id) as { post_id: string; exposure_id: string; owner: string; fleet_id: string; receipt_id: string; idempotency_key: string } | undefined;
    if (!op || db.prepare("SELECT 1 FROM hub_room_post_returns WHERE post_id=? AND answer_id=?").get(op.post_id, answer.id)) return;
    const id = randomUUID(), payload: HubRoomPostAnswer = { id, idempotencyKey: op.idempotency_key, postId: op.post_id, roomId: answer.room_id, exposureId: op.exposure_id, receiptId: op.receipt_id,
      message: { id: answer.id, author: { name: answer.author_name }, text: this.core.deps.content.get(answer.content_ref)?.question ?? "", at: answer.created_at } };
    const bytes = JSON.stringify(validated(roomPostAnswerSchema, payload)), ref = this.core.deps.content.put(tx, { question: bytes });
    this.core.audit(tx, { requestId: id, actor: { kind: "person", person: personFromString(op.owner) }, action: "room.agent-reply-queued", result: "completed", roomId: answer.room_id, messageId: answer.id, exposureId: op.exposure_id, fleetId: op.fleet_id, contentRef: ref });
    db.prepare("INSERT INTO hub_room_post_returns(id,post_id,answer_id,exposure_id,owner,fleet_id,payload_ref,payload_digest,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, op.post_id, answer.id, op.exposure_id, op.owner, op.fleet_id, ref, digest(bytes), this.core.now(), this.core.now() + 24 * 60 * 60_000);
  }
  private valid(db: DB, row: ReturnRow): boolean {
    const e = readExposure(db, row.exposure_id);
    return !!e && e.owner === row.owner && e.fleet_id === row.fleet_id && exposureOf(e).state === "published"
      && !!db.prepare(`SELECT 1 FROM hub_room_agent_operations op JOIN hub_room_members m ON m.id=op.member_id JOIN hub_group_rooms r ON r.id=m.room_id
        WHERE op.post_id=? AND m.kind='agent' AND m.subject=? AND m.owner_at_join=? AND r.archived=0`).get(row.post_id, row.exposure_id, row.owner);
  }
  acknowledge(input: unknown, link: HubLinkContext): void {
    const body = validated(roomPostAnswerAckSchema, input); if (!this.supports(link) || this.links.get(link.fleetId) !== link) throw new HubProtocolError("stale");
    this.core.atomic(db => { const row = db.prepare("SELECT * FROM hub_room_post_returns WHERE id=?").get(body.id) as ReturnRow | undefined;
      if (!row || row.fleet_id !== link.fleetId || row.owner !== personKeyString(link.owner) || !row.sent_epoch) return;
      db.prepare("UPDATE hub_room_post_returns SET acked=1 WHERE id=?").run(row.id);
    });
  }
  wake(): void {
    if (this.stopped || !this.core.live()) return;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.core.atomic(db => db.prepare("DELETE FROM hub_room_post_returns WHERE acked=1 OR expires_at<=?").run(this.core.now()));
    const fleets = this.core.atomic(db => db.prepare("SELECT DISTINCT fleet_id FROM hub_room_post_returns WHERE acked=0").all() as { fleet_id: string }[]);
    let live = false;
    for (const { fleet_id } of fleets) { const link = this.links.get(fleet_id); if (!link || !this.supports(link)) continue; live = true;
      if (this.flights.has(fleet_id)) continue;
      const flight = this.flush(link).catch(() => {}).finally(() => { if (this.flights.get(fleet_id) === flight) this.flights.delete(fleet_id); });
      this.flights.set(fleet_id, flight);
    }
    if (live) { this.timer = setTimeout(() => this.wake(), 30_000); this.timer.unref?.(); }
  }
  private async flush(link: HubLinkContext): Promise<void> {
    const transport = this.core.deps.transport(); if (!transport) return;
    const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_post_returns WHERE fleet_id=? AND acked=0 AND (sent_epoch<>? OR last_sent_at<=?) ORDER BY created_at,id LIMIT 64").all(link.fleetId, link.linkEpoch, this.core.now() - 30_000) as ReturnRow[]);
    for (const row of rows) {
      const current = () => this.supports(link) && this.links.get(link.fleetId) === link;
      if (!current()) return;
      if (!await this.core.eligible(link.owner)) continue;
      const permit = await this.core.groupExposure(row.exposure_id, null, { requestId: row.id, current });
      const payload = this.core.atomic(db => {
        if (!current() || !this.valid(db, row) || row.expires_at <= this.core.now() || !(db.prepare("SELECT 1 FROM hub_room_post_returns WHERE id=? AND acked=0").get(row.id))) return null;
        const bytes = this.core.deps.content.get(row.payload_ref)?.question;
        if (bytes === undefined || digest(bytes) !== row.payload_digest) throw new HubProtocolError("uncertain");
        db.prepare("UPDATE hub_room_post_returns SET sent_epoch=?,last_sent_at=? WHERE id=? AND acked=0").run(link.linkEpoch, this.core.now(), row.id);
        return validated(roomPostAnswerSchema, JSON.parse(bytes));
      }, permit);
      if (!payload) continue;
      permit.assertCurrent(); if (!current()) return;
      try { await transport.send(link.fleetId, { v: 1, type: "room.post-answer", requestId: row.id, linkEpoch: link.linkEpoch, payload }); }
      catch { if (this.core.live() && !this.stopped) this.core.atomic(db => db.prepare("UPDATE hub_room_post_returns SET sent_epoch=0,last_sent_at=0 WHERE id=? AND acked=0 AND sent_epoch=?").run(row.id, link.linkEpoch)); }
    }
  }
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.links.clear(); await Promise.allSettled([...this.flights.values()]); }
}
