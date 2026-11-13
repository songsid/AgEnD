import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { HubCatalogService, exposureOf, readExposure } from "../catalog.js";
import { HubRoomAgents, type RoomPostRow } from "./agents.js";
import { personKeyString } from "../identity.js";
import { HubCore, personFromString, type HubOperationPermit } from "../http/core.js";
import { uuid, plain, validated, HubProtocolError } from "../validation.js";
import type { HubRequestContext, HubTx } from "../types.js";
import type { RoomEvent, RoomMessage } from "./types.js";

type DB = Database.Database;
interface RoomRow { id: string; name: string; created_by: string; created_at: number; archived: number; all_mention: number; history_for_new: "since-join" | "all" }
interface MemberRow { id: string; room_id: string; kind: "person" | "agent" | "assistant"; subject: string; role: "manager" | "member"; joined_sequence: number; read_sequence: number; owner_at_join: string | null }
type PostRow = RoomPostRow;
const label = plain(120).transform(s => s.trim()).refine(s => s.length > 0 && !/[\u0000-\u001f\u007f]/.test(s));
const personId = z.string().max(128).refine(s => /^[a-z][a-z0-9_-]{0,63}\/[a-f0-9-]{36}$/.test(s));
const createSchema = z.strictObject({ name: label, people: z.array(personId).max(100).default([]), teams: z.array(uuid).max(0).default([]),
  groups: z.array(uuid).max(0).default([]), agents: z.array(uuid).max(64).default([]), assistant: z.literal(false).default(false) });
const postSchema = z.strictObject({ text: plain(64 * 1024).refine(s => s.trim().length > 0), mentions: z.array(z.string().max(128)).max(100).default([]),
  replyTo: uuid.optional(), files: z.array(uuid).max(0).optional(), idempotencyKey: uuid });
const patchSchema = z.strictObject({ name: label.optional(), allMention: z.boolean().optional(), historyForNew: z.enum(["since-join", "all"]).optional(), archived: z.boolean().optional(), assistant: z.literal(false).optional() });

export class HubRoomRefusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Room: ${code}`); }
}
/** People chat first; direct agent conversations remain in HubRoomsService. No timers or I/O on import. */
export class HubGroupRooms {
  private listeners = new Set<(event: RoomEvent) => void>();
  readonly agents: HubRoomAgents;
  constructor(private readonly core: HubCore) { this.agents = new HubRoomAgents(core, event => this.emit(event), post => this.projection(post)); }
  has(id: string): boolean { return this.core.atomic(db => !!db.prepare("SELECT 1 FROM hub_group_rooms WHERE id=?").get(id)); }
  subscribe(listener: (event: RoomEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Cheap queue admission only; event() still freshly authorizes and projects the eventual disclosure. */
  interested(person: string, event: RoomEvent): boolean {
    if (event.removedPerson) return event.removedPerson === person;
    return this.core.atomic(db => !!db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(event.roomId, person));
  }
  async close(): Promise<void> { this.listeners.clear(); await this.agents.close(); }
  /** The direct-chat receiver shares this stream without changing its grant-backed delivery path. */
  publish(event: RoomEvent): void { this.emit(event); }
  private emit(event: RoomEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* a disconnected viewer cannot fail a committed write */ } } }
  private fence(ctx: HubRequestContext) { return { assertCurrent: () => { this.core.check(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked"); } }; }
  private async who(ctx: HubRequestContext): Promise<string> { const person = await ctx.requirePerson(); this.fence(ctx).assertCurrent(); return personKeyString(person); }
  private room(db: DB, id: string): RoomRow {
    const row = db.prepare("SELECT * FROM hub_group_rooms WHERE id=?").get(id) as RoomRow | undefined;
    if (!row) throw new HubRoomRefusal(404, "not-found"); return row;
  }
  private member(db: DB, id: string, person: string, manager = false): MemberRow {
    this.room(db, id);
    const row = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(id, person) as MemberRow | undefined;
    if (!row) throw new HubRoomRefusal(403, "not-member");
    if (manager && row.role !== "manager") throw new HubRoomRefusal(403, "denied"); return row;
  }
  private name(db: DB, person: string): string {
    return (db.prepare("SELECT display_name FROM hub_people WHERE person=?").get(person) as { display_name: string } | undefined)?.display_name ?? person;
  }
  private maximum(db: DB, id: string): number { return (db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM hub_room_posts WHERE room_id=?").get(id) as { n: number }).n; }
  private projection(row: PostRow): RoomMessage {
    return { id: row.id, roomId: row.room_id, at: row.created_at, author: { kind: row.author_kind, id: row.author_id, name: row.author_name },
      text: this.core.deps.content.get(row.content_ref)?.question ?? "", mentions: JSON.parse(row.mentions) as string[],
      ...(row.reply_to ? { replyTo: row.reply_to } : {}), ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      ...(row.stage ? { stage: row.stage } : {}), ...(row.answer_to ? { answerTo: row.answer_to } : {}),
      ...this.core.atomic(db => { const ask = this.agents.progress(db, row.id); return ask ? { ask } : {}; }) };
  }
  private insert(db: DB, tx: HubTx, roomId: string, author: { kind: PostRow["author_kind"]; id: string; subject: string; name: string }, text: string,
    mentions: string[] = [], key: string | null = null, digest = "", replyTo: string | null = null): PostRow {
    const row: PostRow = { id: randomUUID(), room_id: roomId, sequence: this.maximum(db, roomId) + 1, author_kind: author.kind, author_id: author.id,
      author_subject: author.subject, author_name: author.name, content_ref: this.core.deps.content.put(tx, { question: text }), digest, mentions: JSON.stringify(mentions),
      reply_to: replyTo, idempotency_key: key, created_at: this.core.now() };
    db.prepare(`INSERT INTO hub_room_posts(id,room_id,sequence,author_kind,author_id,author_subject,author_name,content_ref,digest,mentions,reply_to,idempotency_key,created_at)
      VALUES(@id,@room_id,@sequence,@author_kind,@author_id,@author_subject,@author_name,@content_ref,@digest,@mentions,@reply_to,@idempotency_key,@created_at)`).run(row);
    return row;
  }
  private summary(db: DB, room: RoomRow, member: MemberRow) {
    const counts = db.prepare("SELECT kind,COUNT(*) AS n FROM hub_room_members WHERE room_id=? GROUP BY kind").all(room.id) as { kind: string; n: number }[];
    const floor = member.joined_sequence;
    const last = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND sequence>=? AND (stage IS NULL OR stage='answered') ORDER BY sequence DESC LIMIT 1").get(room.id, floor) as PostRow | undefined;
    const unread = (db.prepare("SELECT COUNT(*) AS n FROM hub_room_posts WHERE room_id=? AND sequence>=? AND sequence>? AND (author_kind<>'person' OR author_subject<>?) AND author_kind<>'system' AND (stage IS NULL OR stage='answered')")
      .get(room.id, floor, member.read_sequence, member.subject) as { n: number }).n;
    const mentioned = !!db.prepare(`SELECT 1 FROM hub_room_posts p,json_each(p.mentions) j WHERE p.room_id=? AND p.sequence>=? AND p.sequence>?
      AND p.author_subject<>? AND j.value IN (?,?) LIMIT 1`).get(room.id, floor, member.read_sequence, member.subject, member.id, member.subject);
    const online = (db.prepare(`SELECT COUNT(*) AS n FROM hub_room_members m WHERE m.room_id=? AND m.kind='person' AND EXISTS
      (SELECT 1 FROM hub_sessions s WHERE s.person=m.subject AND s.state='active' AND s.expires_at>?)`).get(room.id, this.core.now()) as { n: number }).n;
    return { id: room.id, kind: "group" as const, name: room.name, people: counts.find(c => c.kind === "person")?.n ?? 0,
      agents: counts.find(c => c.kind === "agent")?.n ?? 0, online, unread, lastAt: last?.created_at ?? room.created_at,
      lastText: last ? this.projection(last).text.slice(0, 240) : "", lastAuthor: last?.author_name ?? "", mentioned, archived: room.archived === 1 };
  }
  async list(ctx: HubRequestContext) {
    const me = await this.who(ctx); this.agents.sweep();
    return this.core.atomic(db => ({ rooms: (db.prepare("SELECT * FROM hub_room_members WHERE kind='person' AND subject=?").all(me) as MemberRow[])
      .map(m => this.summary(db, this.room(db, m.room_id), m)).sort((a, b) => b.lastAt - a.lastAt),
      me: { canCreateRooms: me === personKeyString(this.core.deps.config.administrator), assistant: this.core.deps.roomAssistant?.available().enabled === true }, invitations: 0 }), this.fence(ctx));
  }
  async candidates(ctx: HubRequestContext, q: string, kind: string) {
    if (q.length > 64 || /[\u0000-\u001f\u007f]/.test(q) || !["person", "team", "group", "agent"].includes(kind)) throw new HubProtocolError("invalid");
    const me = await this.who(ctx);
    const allowed = (db: DB) => me === personKeyString(this.core.deps.config.administrator) || !!db.prepare(`SELECT 1 FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id
      WHERE m.kind='person' AND m.subject=? AND m.role='manager' AND r.archived=0`).get(me);
    if (kind === "agent") {
      this.core.atomic(db => { if (!allowed(db)) throw new HubRoomRefusal(403, "denied"); }, this.fence(ctx));
      const view = await new HubCatalogService(this.core).visible(ctx);
      const hits = [...view.mine.map(e => ({ kind: "agent" as const, id: e.id, name: e.displayName, mine: true, owner: { name: this.core.atomic(db => this.name(db, me)) } })),
        ...view.askable.map(({ exposure: e, ownerName }) => ({ kind: "agent" as const, id: e.id, name: e.displayName, mine: false, owner: { name: ownerName } }))]
        .filter(e => e.name.toLowerCase().startsWith(q.trim().toLowerCase())).slice(0, 20);
      this.fence(ctx).assertCurrent(); return hits;
    }
    const rows = this.core.atomic(db => {
      if (!allowed(db)) throw new HubRoomRefusal(403, "denied");
      if (kind !== "person") return [];
      const prefix = `${q.trim().replace(/[\\%_]/g, c => `\\${c}`)}%`;
      return db.prepare("SELECT person,display_name FROM hub_people WHERE status='active' AND (display_name LIKE ? ESCAPE '\\' OR login_label LIKE ? ESCAPE '\\') ORDER BY display_name,person LIMIT 20")
        .all(prefix, prefix) as { person: string; display_name: string }[];
    }, this.fence(ctx));
    const hits: { kind: "person"; id: string; name: string }[] = [];
    for (const row of rows) if (await this.core.eligible(personFromString(row.person))) hits.push({ kind: "person", id: row.person, name: row.display_name });
    return this.core.atomic(db => { if (!allowed(db)) throw new HubRoomRefusal(403, "denied"); return hits; }, this.fence(ctx));
  }
  async create(ctx: HubRequestContext, input: unknown) {
    const body = validated(createSchema, input), me = await this.who(ctx);
    if (me !== personKeyString(this.core.deps.config.administrator)) throw new HubRoomRefusal(403, "denied");
    const people = [...new Set([me, ...body.people])];
    for (const person of people) if (person !== me && !await this.core.eligible(personFromString(person))) throw new HubRoomRefusal(400, "invalid-person");
    const permits = await Promise.all(body.agents.map(id => this.core.groupExposure(id, null, this.core.groupContext(ctx))));
    const room = this.core.atomic((db, tx) => {
      for (const permit of permits) permit.assertCurrent();
      const id = randomUUID(); db.prepare("INSERT INTO hub_group_rooms(id,name,created_by,created_at) VALUES(?,?,?,?)").run(id, body.name, me, this.core.now());
      for (const person of people) db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence) VALUES(?,?,'person',?,?,0)").run(randomUUID(), id, person, person === me ? "manager" : "member");
      this.insert(db, tx, id, { kind: "system", id: "system", subject: "system", name: "" }, `${this.name(db, me)} created this room.`);
      for (const agent of body.agents) this.addAgentMember(db, tx, id, agent, me);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.created", result: "completed", roomId: id });
      return this.summary(db, this.room(db, id), this.member(db, id, me));
    }, { assertCurrent: () => { this.fence(ctx).assertCurrent(); for (const permit of permits) permit.assertCurrent(); } });
    this.emit({ type: "room.changed", roomId: room.id, data: { roomId: room.id } }); return { room };
  }
  async detail(ctx: HubRequestContext, id: string) {
    const me = await this.who(ctx); this.agents.sweep();
    this.core.atomic(db => { this.member(db, id, me); }, this.fence(ctx));
    const canAsk = new Set<string>(), directProofs: HubOperationPermit[] = [];
    const candidates = this.core.atomic(db => db.prepare(`SELECT g.id,g.exposure_id FROM hub_grants g JOIN hub_room_members m ON m.subject=g.exposure_id
      WHERE m.room_id=? AND m.kind='agent' AND g.state='active' AND g.starts_at<=? AND g.expires_at>? AND (g.subject_kind='group' OR g.subject=?)`)
      .all(id, this.core.now(), this.core.now(), me) as { id: string; exposure_id: string }[]);
    for (const g of candidates) {
      try { const permit = await this.core.exposureGrant(g.exposure_id, g.id, personFromString(me), this.core.groupContext(ctx)); permit.assertCurrent(); directProofs.push(permit); canAsk.add(g.exposure_id); }
      catch { /* A room member may still read the room when a separate direct-chat allowance is held. */ }
    }
    return this.core.atomic(db => {
      const own = this.member(db, id, me), room = this.room(db, id);
      const members = (db.prepare("SELECT * FROM hub_room_members WHERE room_id=? ORDER BY kind,id").all(id) as MemberRow[]).map(m => {
        if (m.kind === "agent") { const e = readExposure(db, m.subject); return { id: m.subject, kind: m.kind, name: e?.display_name ?? m.subject, role: m.role,
          owner: { name: this.name(db, m.owner_at_join ?? "") }, ...this.agents.presence(m.subject), canAsk: canAsk.has(m.subject) }; }
        return { id: m.id, kind: m.kind, name: this.name(db, m.subject), role: m.role,
          presence: db.prepare("SELECT 1 FROM hub_sessions WHERE person=? AND state='active' AND expires_at>?").get(m.subject, this.core.now()) ? "online" : "offline" };
      });
      return { room: this.summary(db, room, own), me: { id: own.id, role: own.role }, members,
        settings: { allMention: room.all_mention === 1, historyForNew: room.history_for_new }, invited: [] };
    }, { assertCurrent: () => { this.fence(ctx).assertCurrent(); for (const proof of directProofs) proof.assertCurrent(); } });
  }
  async patch(ctx: HubRequestContext, id: string, input: unknown) {
    const body = validated(patchSchema, input), me = await this.who(ctx);
    this.core.atomic((db, tx) => {
      this.member(db, id, me, true); const row = this.room(db, id);
      db.prepare("UPDATE hub_group_rooms SET name=?,all_mention=?,history_for_new=?,archived=? WHERE id=?")
        .run(body.name ?? row.name, body.allMention === undefined ? row.all_mention : Number(body.allMention), body.historyForNew ?? row.history_for_new, body.archived === undefined ? row.archived : Number(body.archived), id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.updated", result: "completed", roomId: id });
    }, this.fence(ctx));
    if (body.archived) this.core.deps.roomAssistant?.forget(id);
    this.agents.sweep();
    this.emit({ type: "room.changed", roomId: id, data: { roomId: id } }); return this.detail(ctx, id);
  }
  async add(ctx: HubRequestContext, id: string, input: unknown) {
    const body = validated(z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("person"), id: personId }), z.strictObject({ kind: z.literal("agent"), id: uuid })]), input), me = await this.who(ctx);
    if (body.kind === "agent") {
      this.core.atomic(db => { this.member(db, id, me, true); }, this.fence(ctx));
      const permit = await this.core.groupExposure(body.id, null, this.core.groupContext(ctx));
      this.core.atomic((db, tx) => {
        this.member(db, id, me, true); this.addAgentMember(db, tx, id, body.id, me);
        this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.agent-added", result: "completed", roomId: id, exposureId: body.id });
      }, { assertCurrent: () => { this.fence(ctx).assertCurrent(); permit.assertCurrent(); } });
      this.emit({ type: "member.changed", roomId: id, data: { roomId: id } }); return { ok: true };
    }
    this.core.atomic(db => { this.member(db, id, me, true); }, this.fence(ctx));
    if (!await this.core.eligible(personFromString(body.id))) throw new HubRoomRefusal(400, "invalid-person");
    this.core.atomic((db, tx) => {
      this.member(db, id, me, true); const room = this.room(db, id); if (room.archived) throw new HubRoomRefusal(409, "archived");
      if (db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(id, body.id)) return;
      const seq = this.maximum(db, id) + 1;
      db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence,read_sequence) VALUES(?,?,'person',?,'member',?,?)")
        .run(randomUUID(), id, body.id, room.history_for_new === "all" ? 0 : seq, 0);
      this.insert(db, tx, id, { kind: "system", id: "system", subject: "system", name: "" }, `${this.name(db, body.id)} joined this room.`);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.member-added", result: "completed", roomId: id });
    }, this.fence(ctx));
    this.emit({ type: "room.changed", roomId: id, data: { roomId: id } });
    this.emit({ type: "member.changed", roomId: id, data: { roomId: id } }); return { ok: true };
  }
  /** C invitation acceptance calls this only inside its guarded exact-invitation transaction. */
  addAgentMember(db: DB, tx: HubTx, roomId: string, exposureId: string, owner: string): void {
    const room = this.room(db, roomId); if (room.archived) throw new HubRoomRefusal(409, "archived");
    const e = readExposure(db, exposureId);
    if (!e) throw new HubRoomRefusal(404, "not-found");
    if (e.owner !== owner || exposureOf(e).state !== "published") throw new HubRoomRefusal(403, "denied");
    const old = db.prepare("SELECT owner_at_join FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(roomId, exposureId) as { owner_at_join: string } | undefined;
    if (old) { if (old.owner_at_join !== owner) throw new HubProtocolError("conflict"); return; }
    const seq = this.maximum(db, roomId) + 1;
    db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence,owner_at_join) VALUES(?,?,'agent',?,'member',?,?)")
      .run(randomUUID(), roomId, exposureId, room.history_for_new === "all" ? 0 : seq, owner);
    this.insert(db, tx, roomId, { kind: "system", id: "system", subject: "system", name: "" }, `${e.display_name} joined this room.`);
  }
  async changeMember(ctx: HubRequestContext, id: string, memberId: string, role?: "manager" | "member") {
    const me = await this.who(ctx);
    const removed = this.core.atomic((db, tx) => {
      const own = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(id, me) as MemberRow | undefined;
      const target = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND (id=? OR (kind='agent' AND subject=?))").get(id, memberId, memberId) as MemberRow | undefined;
      if (!target) throw new HubRoomRefusal(404, "not-found");
      const ownerRemovesAgent = role === undefined && target.kind === "agent" && target.owner_at_join === me;
      if (own?.role !== "manager" && !(role === undefined && target.id === own?.id) && !ownerRemovesAgent) throw new HubRoomRefusal(403, "denied");
      if (role && target.kind !== "person") throw new HubProtocolError("invalid");
      if (target.role === "manager" && role !== "manager" && (db.prepare("SELECT COUNT(*) AS n FROM hub_room_members WHERE room_id=? AND role='manager'").get(id) as { n: number }).n <= 1) throw new HubRoomRefusal(409, "last-manager");
      if (role) db.prepare("UPDATE hub_room_members SET role=? WHERE id=?").run(role, target.id);
      else db.prepare("DELETE FROM hub_room_members WHERE id=?").run(target.id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: role ? "room.member-role" : "room.member-removed", result: "completed", roomId: id });
      return !role && target.kind === "person" ? target.subject : null;
    }, this.fence(ctx));
    this.agents.sweep();
    if (removed) this.emit({ type: "room.changed", roomId: id, data: { roomId: id, removed: true }, removedPerson: removed });
    this.emit({ type: "member.changed", roomId: id, data: { roomId: id } }); return { ok: true };
  }
  async messages(ctx: HubRequestContext, id: string, before: string | null, limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HubProtocolError("invalid");
    const me = await this.who(ctx); this.agents.sweep();
    return this.core.atomic(db => {
      const member = this.member(db, id, me); let until = Number.MAX_SAFE_INTEGER;
      if (before) { const row = db.prepare("SELECT sequence FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(validated(uuid, before), id, member.joined_sequence) as { sequence: number } | undefined;
        if (!row) throw new HubRoomRefusal(404, "not-found"); until = row.sequence; }
      const rows = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND sequence>=? AND sequence<? ORDER BY sequence DESC LIMIT ?").all(id, member.joined_sequence, until, limit + 1) as PostRow[];
      return { messages: rows.slice(0, limit).reverse().map(row => this.projection(row)), more: rows.length > limit };
    }, this.fence(ctx));
  }
  async post(ctx: HubRequestContext, id: string, input: unknown): Promise<RoomMessage> {
    const body = validated(postSchema, input), me = await this.who(ctx);
    const digest = createHash("sha256").update(JSON.stringify({ text: body.text, mentions: body.mentions, replyTo: body.replyTo ?? null })).digest("hex");
    let added = false;
    const row = this.core.atomic((db, tx) => {
      const member = this.member(db, id, me), room = this.room(db, id);
      if (room.archived) throw new HubRoomRefusal(409, "archived");
      if (body.mentions.includes("all") && !room.all_mention && member.role !== "manager") throw new HubRoomRefusal(403, "all-mention-off");
      const old = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND author_subject=? AND idempotency_key=?").get(id, me, body.idempotencyKey) as PostRow | undefined;
      if (old) { if (old.digest !== digest || old.sequence < member.joined_sequence) throw new HubRoomRefusal(409, "conflict"); return old; }
      if (body.replyTo && !db.prepare("SELECT 1 FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(body.replyTo, id, member.joined_sequence)) throw new HubRoomRefusal(404, "not-found");
      const post = this.insert(db, tx, id, { kind: "person", id: member.id, subject: me, name: this.name(db, me) }, body.text, body.mentions, body.idempotencyKey, digest, body.replyTo ?? null);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.message", result: "completed", roomId: id, messageId: post.id, contentRef: post.content_ref });
      this.agents.enqueue(db, tx, post, member.id);
      added = true; return post;
    }, this.fence(ctx));
    const message = this.projection(row);
    if (added) { this.emit({ type: "message.added", roomId: id, data: { roomId: id, message }, sequence: row.sequence }); this.emit({ type: "unread.changed", roomId: id, data: { roomId: id } }); }
    if (added) this.agents.publishQueued(row.id);
    this.agents.wake(); return message;
  }
  async markRead(ctx: HubRequestContext, id: string, upTo: unknown) {
    const target = validated(uuid, upTo), me = await this.who(ctx);
    this.core.atomic(db => { const member = this.member(db, id, me);
      const row = db.prepare("SELECT sequence FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(target, id, member.joined_sequence) as { sequence: number } | undefined;
      if (!row) throw new HubRoomRefusal(404, "not-found");
      db.prepare("UPDATE hub_room_members SET read_sequence=MAX(read_sequence,?) WHERE id=?").run(row.sequence, member.id);
    }, this.fence(ctx));
    this.emit({ type: "unread.changed", roomId: id, data: { roomId: id } }); return { ok: true };
  }
  /** Each event is projected for its current viewer after a fresh eligibility check. */
  async event(ctx: HubRequestContext, event: RoomEvent): Promise<Record<string, unknown> | null> {
    const me = await this.who(ctx);
    return this.core.atomic(db => {
      if (event.removedPerson) return event.removedPerson === me ? event.data : null;
      const member = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(event.roomId, me) as MemberRow | undefined;
      if (!member || event.sequence !== undefined && event.sequence < member.joined_sequence) return null;
      if (event.type === "unread.changed") return { roomId: event.roomId, unread: this.summary(db, this.room(db, event.roomId), member).unread };
      if (event.type === "room.changed") return { roomId: event.roomId, room: this.summary(db, this.room(db, event.roomId), member) };
      return event.data;
    }, this.fence(ctx));
  }
}
