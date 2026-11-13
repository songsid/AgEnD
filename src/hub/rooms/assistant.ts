/** Local room assistant jobs use the host's injected worker port, not a fabricated Fleet exposure. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { personFromString, type HubCore } from "../http/core.js";
import type { HubTx } from "../types.js";
import { HubProtocolError, plain, validated } from "../validation.js";
import type { RoomPostRow } from "./agents.js";
import { boundedRoomText, roomContext } from "./context.js";
import type { RoomAssistantPort, RoomEvent, RoomMessage } from "./types.js";
type DB = Database.Database;
type Input = Parameters<RoomAssistantPort["ask"]>[0];
interface Call { id: string; room_id: string; parent_id: string; reply_id: string; asker: string; asker_member: string; assistant_member: string;
  payload_ref: string; payload_digest: string; state: "queued" | "working" | "answered" | "failed"; reason: string | null; created_at: number }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class HubRoomAssistant {
  private stopped = false;
  private jobs = new Map<string, Promise<void>>();
  constructor(private readonly core: HubCore, private readonly emit: (event: RoomEvent) => void, private readonly project: (row: RoomPostRow) => RoomMessage) {}
  private live() { return !this.stopped && this.core.live(); }
  availability() { try { return this.core.deps.roomAssistant?.available(); } catch { return undefined; } }
  presence(roomId: string) { const x = this.availability(); return !x?.enabled || x.state === "paused" ? "paused" as const : this.jobs.has(roomId) ? "working" as const : "idle" as const; }
  progress(db: DB, parent: string) {
    const row = db.prepare("SELECT state FROM hub_room_assistant_calls WHERE parent_id=?").get(parent) as { state: Call["state"] } | undefined;
    return row ? { total: 1, answered: Number(row.state === "answered"), working: Number(row.state === "working"), later: Number(row.state === "queued") } : undefined;
  }
  warning(db: DB, parent: string): boolean { return !!db.prepare("SELECT 1 FROM hub_room_assistant_calls WHERE parent_id=? AND reason='unavailable'").get(parent); }
  enqueue(db: DB, tx: HubTx, parent: RoomPostRow, askerMember: string, direct: boolean): void {
    if (!direct && !(JSON.parse(parent.mentions) as string[]).includes("assistant")) return;
    const member = db.prepare("SELECT id,joined_sequence FROM hub_room_members WHERE room_id=? AND kind='assistant'").get(parent.room_id) as { id: string; joined_sequence: number } | undefined;
    if (!member) throw new HubProtocolError("invalid");
    const asker = db.prepare("SELECT joined_sequence FROM hub_room_members WHERE id=?").get(askerMember) as { joined_sequence: number };
    const room = db.prepare("SELECT name FROM hub_group_rooms WHERE id=?").get(parent.room_id) as { name: string }, id = randomUUID(), reply = randomUUID(), now = this.core.now();
    const payload: Input = { roomId: parent.room_id, roomName: room.name, messageId: id, asker: { name: boundedRoomText(parent.author_name, 256) },
      text: this.core.deps.content.get(parent.content_ref)?.question ?? "", context: roomContext(this.core, db, parent, Math.max(asker.joined_sequence, member.joined_sequence)) };
    const bytes = JSON.stringify(payload), available = this.availability()?.enabled === true;
    const sequence = (db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM hub_room_posts WHERE room_id=?").get(parent.room_id) as { n: number }).n;
    db.prepare(`INSERT INTO hub_room_posts(id,room_id,sequence,author_kind,author_id,author_subject,author_name,content_ref,digest,mentions,created_at,answer_to,delivery_id,stage)
      VALUES(?,?,?,'assistant','assistant','assistant','Hub assistant',?,'','[]',?,?,?,?)`).run(reply, parent.room_id, sequence,
        this.core.deps.content.put(tx, { question: "" }), now, parent.id, id, available ? "queued" : "not-answered");
    db.prepare(`INSERT INTO hub_room_assistant_calls(id,room_id,parent_id,reply_id,asker,asker_member,assistant_member,payload_ref,payload_digest,state,reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, parent.room_id, parent.id, reply, parent.author_subject, askerMember, member.id,
        this.core.deps.content.put(tx, { question: bytes }), hash(bytes), available ? "queued" : "failed", available ? null : "unavailable", now);
  }
  private valid(db: DB, call: Call): boolean {
    return !!db.prepare("SELECT 1 FROM hub_room_assistant_calls WHERE id=? AND state IN ('queued','working')").get(call.id)
      && !!db.prepare("SELECT 1 FROM hub_group_rooms WHERE id=? AND archived=0").get(call.room_id)
      && !!db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=? AND kind='person' AND subject=?").get(call.asker_member, call.room_id, call.asker)
      && !!db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=? AND kind='assistant'").get(call.assistant_member, call.room_id);
  }
  private changed(call: Call, added = false): void {
    if (!this.live()) return;
    const post = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(call.reply_id) as RoomPostRow);
    this.emit({ type: added ? "message.added" : "message.updated", roomId: call.room_id, data: { roomId: call.room_id, message: this.project(post),
      parent: { id: call.parent_id, ask: this.core.atomic(db => this.project(db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(call.parent_id) as RoomPostRow).ask) } }, sequence: post.sequence });
    this.emit({ type: "unread.changed", roomId: call.room_id, data: { roomId: call.room_id } });
  }
  publishQueued(parent: string): void {
    const call = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_assistant_calls WHERE parent_id=?").get(parent) as Call | undefined);
    if (call) this.changed(call, true);
  }
  start(): void {
    // A prior external call has an uncertain result after a crash; never run that input again automatically.
    this.core.atomic(db => { db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id IN (SELECT reply_id FROM hub_room_assistant_calls WHERE state='working')").run();
      db.prepare("UPDATE hub_room_assistant_calls SET state='failed',reason='interrupted' WHERE state='working'").run(); });
    this.wake();
  }
  wake(): void {
    if (!this.live()) return;
    const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_assistant_calls WHERE state='queued' ORDER BY created_at,rowid").all() as Call[]);
    for (const call of rows) {
      if (this.jobs.has(call.room_id)) continue;
      const promise = this.run(call).finally(() => { this.jobs.delete(call.room_id); if (this.live()) { this.emit({ type: "presence.changed", roomId: call.room_id, data: { roomId: call.room_id, memberId: "assistant", presence: this.presence(call.room_id) } }); this.wake(); } });
      this.jobs.set(call.room_id, promise);
      this.emit({ type: "presence.changed", roomId: call.room_id, data: { roomId: call.room_id, memberId: "assistant", presence: this.presence(call.room_id) } });
    }
  }
  private fail(call: Call): void {
    if (!this.live()) return;
    this.core.atomic(db => { db.prepare("UPDATE hub_room_assistant_calls SET state='failed',reason='unavailable' WHERE id=? AND state IN ('queued','working')").run(call.id);
      db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=? AND stage<>'answered'").run(call.reply_id); }); this.changed(call);
  }
  private async run(call: Call): Promise<void> {
    try {
      const port = this.core.deps.roomAssistant;
      if (!port || !this.availability()?.enabled || !await this.core.eligible(personFromString(call.asker))) { this.fail(call); return; }
      const context = { requestId: call.id, current: () => this.live() }, permission = await this.core.groupAsker(personFromString(call.asker), context);
      const payload = this.core.atomic((db, tx) => {
        if (!this.valid(db, call)) throw new HubProtocolError("revoked");
        const bytes = this.core.deps.content.get(call.payload_ref)?.question;
        if (!bytes || hash(bytes) !== call.payload_digest) throw new HubProtocolError("uncertain");
        db.prepare("UPDATE hub_room_assistant_calls SET state='working' WHERE id=? AND state='queued'").run(call.id);
        db.prepare("UPDATE hub_room_posts SET stage='working' WHERE id=?").run(call.reply_id);
        this.core.audit(tx, { requestId: call.id, actor: { kind: "person", person: personFromString(call.asker) }, action: "room.assistant-started", result: "completed", roomId: call.room_id, messageId: call.parent_id });
        return JSON.parse(bytes) as Input;
      }, permission);
      this.changed(call); const answer = await port.ask(payload);
      if (!this.live()) return;
      validated(plain(128 * 1024), answer.text);
      if (!await this.core.eligible(personFromString(call.asker))) throw new HubProtocolError("revoked");
      const final = await this.core.groupAsker(personFromString(call.asker), context);
      this.core.atomic((db, tx) => {
        if (this.core.deps.roomAssistant !== port || !this.valid(db, call)) throw new HubProtocolError("revoked");
        const seq = (db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM hub_room_posts WHERE room_id=?").get(call.room_id) as { n: number }).n;
        db.prepare("UPDATE hub_room_posts SET stage='answered',sequence=?,created_at=?,content_ref=? WHERE id=?").run(seq, this.core.now(), this.core.deps.content.put(tx, { question: answer.text }), call.reply_id);
        db.prepare("UPDATE hub_room_assistant_calls SET state='answered',reason=NULL WHERE id=?").run(call.id);
        this.core.audit(tx, { requestId: call.id, actor: { kind: "person", person: personFromString(call.asker) }, action: "room.assistant-answer", result: "completed", roomId: call.room_id, messageId: call.reply_id });
      }, final);
      this.changed(call);
    } catch { this.fail(call); }
  }
  forget(roomId: string): void {
    this.core.deps.roomAssistant?.forget(roomId);
    const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_assistant_calls WHERE room_id=? AND state IN ('queued','working')").all(roomId) as Call[]);
    for (const row of rows) this.fail(row);
  }
  close(): void { this.stopped = true; for (const roomId of this.jobs.keys()) this.core.deps.roomAssistant?.forget(roomId); }
}
