import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { HubCatalogService, exposureOf, readExposure } from "../catalog.js";
import { RoomPostReplies } from "./post-replies.js";
import { HubGrantSearch } from "../grant-search.js";
import { HubRoomAssistant } from "./assistant.js";
import { canCreateRoom } from "./admin.js";
import { HubRoomAgents, type RoomPostRow } from "./agents.js";
import { personKeyString } from "../identity.js";
import { HubCore, personFromString, type HubOperationPermit } from "../http/core.js";
import { uuid, plain, validated, HubProtocolError } from "../validation.js";
import { HUB_ROOM_POST_CAPABILITY, roomListSchema, roomPostSchema, roomMembersSchema, peopleSearchSchema } from "../protocol.js";
import type { HubLinkContext } from "../server.js";
import { RoomAutomation } from "./automation.js";
import { resolveRoomMentions, type MentionMember } from "./mentions.js";
import type { HubRoomListResult, HubRoomPostResult, HubRoomMembersResult, HubPeopleSearchResult, HubRequestContext, HubTx } from "../types.js";
import type { RoomEvent, RoomMessage, RoomSystemEvent } from "./types.js";
import type { RoomInvitationHost } from "../invitations.js";
import { RoomDirectoryCandidates, rememberRoomPeople, type RoomPersonSelection } from "./directory.js";

type DB = Database.Database;
interface RoomRow { id: string; name: string; created_by: string; created_at: number; archived: number; all_mention: number; history_for_new: "since-join" | "all"; assistant_for: string | null }
interface MemberRow { id: string; room_id: string; kind: "person" | "agent" | "assistant"; subject: string; role: "manager" | "member"; joined_sequence: number; read_sequence: number; owner_at_join: string | null }
type PostRow = RoomPostRow;
const label = plain(120).transform(s => s.trim()).refine(s => s.length > 0 && !/[\u0000-\u001f\u007f]/.test(s));
const personId = z.string().max(128).refine(s => /^[a-z][a-z0-9_-]{0,63}\/[a-f0-9-]{36}$/.test(s));
const createSchema = z.strictObject({ name: label, people: z.array(personId).max(100).default([]), teams: z.array(uuid).max(100).default([]),
  groups: z.array(uuid).max(100).default([]), agents: z.array(uuid).max(64).default([]), assistant: z.boolean().default(false) });
const postSchema = z.strictObject({ text: plain(64 * 1024).refine(s => s.trim().length > 0), mentions: z.array(z.string().max(128)).max(100).default([]),
  replyTo: uuid.optional(), files: z.array(uuid).max(0).optional(), idempotencyKey: uuid });
const reactSchema = z.strictObject({ emoji: z.string().min(1).max(16), on: z.boolean() });
/** M-3127: the most distinct emoji one post carries. */
export const ROOM_REACTION_LIMIT = 12;
/** One emoji as a person picks it: one grapheme, a pictograph (ZWJ sequences, FE0F and skin tones kept), no controls. */
export function validRoomEmoji(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 1 || s.length > 16 || /[\u0000-\u001f\u007f\s]/u.test(s)) return false;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return false;
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length === 1;
}
const patchSchema = z.strictObject({ name: label.optional(), allMention: z.boolean().optional(), historyForNew: z.enum(["since-join", "all"]).optional(), archived: z.boolean().optional(), assistant: z.boolean().optional() });

export class HubRoomRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, string | number> = {}) { super(`Room: ${code}`); }
}
/** People chat first; direct agent conversations remain in HubRoomsService. No timers or I/O on import. */
export class HubGroupRooms {
  private listeners = new Set<(event: RoomEvent) => void>();
  readonly agents: HubRoomAgents;
  readonly assistant: HubRoomAssistant;
  readonly postReplies: RoomPostReplies;
  private readonly directory: RoomDirectoryCandidates;
  private readonly automation: RoomAutomation;
  private readonly agentSearch: HubGrantSearch;
  private readonly agentReadBuckets = new Map<string, { at: number; count: number }>();
  constructor(private readonly core: HubCore) { this.postReplies = new RoomPostReplies(core); this.automation = new RoomAutomation(() => core.now()); this.agentSearch = new HubGrantSearch(core);
    this.agents = new HubRoomAgents(core, event => this.emit(event), post => this.projection(post), this.automation,
      (db, tx, post) => { this.agentMentions(db, tx, post); this.postReplies.enqueue(db, tx, post); }, id => { this.agentEffects(id); this.postReplies.wake(); });
    this.assistant = new HubRoomAssistant(core, event => this.emit(event), post => this.projection(post)); this.directory = new RoomDirectoryCandidates(core); }
  has(id: string): boolean { return this.core.atomic(db => !!db.prepare("SELECT 1 FROM hub_group_rooms WHERE id=?").get(id)); }
  subscribe(listener: (event: RoomEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Cheap queue admission only; event() still freshly authorizes and projects the eventual disclosure. */
  interested(person: string, event: RoomEvent): boolean {
    if (event.removedPerson) return event.removedPerson === person;
    return this.core.atomic(db => !!db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(event.roomId, person));
  }
  async close(): Promise<void> { this.listeners.clear(); this.directory.close(); this.agentSearch.close(); this.agentReadBuckets.clear(); this.assistant.close(); await this.agents.close(); await this.postReplies.close(); }
  /** The direct-chat receiver shares this stream without changing its grant-backed delivery path. */
  publish(event: RoomEvent): void { this.emit(event); }
  /** C owns invitation checks; these synchronous effects remain on its current SQL transaction. */
  invitationHost(): RoomInvitationHost {
    const room = (db: DB, id: string) => {
      const row = this.room(db, id);
      if (row.assistant_for) throw new HubRoomRefusal(403, "denied");
      if (row.archived) throw new HubRoomRefusal(409, "archived");
      return { id, name: row.name, people: (db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE room_id=? AND kind='person'").get(id) as { n: number }).n };
    };
    const owned = (db: DB, id: string, owner?: string) => {
      const e = readExposure(db, id);
      if (!e || owner !== undefined && e.owner !== owner) throw new HubRoomRefusal(404, "not-found"); return e;
    };
    return Object.freeze({
      managerRoom: (db: DB, id: string, actor: string) => { this.member(db, id, actor, true); return room(db, id); },
      room,
      publishedExposure: (db: DB, id: string) => { const e = owned(db, id);
        if (exposureOf(e).state !== "published") throw new HubRoomRefusal(403, "denied");
        return { id, name: e.display_name, owner: { id: e.owner, name: this.name(db, e.owner) } }; },
      addAgentMember: (db: DB, tx: HubTx, id: string, exposure: string, owner: string) => this.addAgentMember(db, tx, id, exposure, owner),
      roomsForExposure: (db: DB, id: string, owner: string) => { owned(db, id, owner);
        return db.prepare(`SELECT r.id,r.name,m.id memberId,(SELECT COUNT(*) FROM hub_room_members p WHERE p.room_id=r.id AND p.kind='person') people
          FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id WHERE m.kind='agent' AND m.subject=? AND m.owner_at_join=? ORDER BY r.name,r.id`)
          .all(id, owner) as { id: string; name: string; memberId: string; people: number }[]; },
      changed: ({ roomId, ownerId, membershipChanged }) => {
        if (!this.core.live()) return;
        this.emit({ type: "invitation.changed", roomId, data: {}, audiencePerson: ownerId });
        if (!membershipChanged) return;
        this.emit({ type: "member.changed", roomId, data: { roomId } });
        this.emit({ type: "room.changed", roomId, data: { roomId } });
        const latest = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? ORDER BY sequence DESC LIMIT 1").get(roomId) as PostRow | undefined);
        if (latest?.author_kind === "system") this.emit({ type: "message.added", roomId, data: { roomId, message: this.projection(latest) }, sequence: latest.sequence });
      },
    } satisfies RoomInvitationHost);
  }
  async roomsForExposure(ctx: HubRequestContext, exposure: string) {
    const me = await this.who(ctx); return this.core.atomic(db => this.invitationHost().roomsForExposure(db, exposure, me), this.fence(ctx));
  }
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
    return (db.prepare("SELECT display_name FROM hub_people WHERE person=? UNION ALL SELECT display_name FROM hub_room_people WHERE person=? LIMIT 1").get(person, person) as { display_name: string } | undefined)?.display_name ?? person;
  }
  private maximum(db: DB, id: string): number { return (db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM hub_room_posts WHERE room_id=?").get(id) as { n: number }).n; }
  private projection(row: PostRow): RoomMessage {
    const system: RoomSystemEvent | undefined = row.author_kind === "system" && ["room-created", "member-joined", "admin-joined"].includes(row.author_id)
      ? { kind: row.author_id as "room-created" | "member-joined" | "admin-joined", name: row.author_name } : undefined;
    // Agent rows retain their owner-at-message in author_subject; a later exposure transfer must not relabel history.
    const owner = row.author_kind === "agent" ? this.core.atomic(db => ({ name: this.name(db, row.author_subject) })) : undefined;
    return { id: row.id, roomId: row.room_id, at: row.created_at, sequence: row.sequence, author: { kind: row.author_kind, id: row.author_id, name: row.author_name, ...(owner ? { owner } : {}), ...this.viaAuthor(row) },
      ...(system ? { system } : {}), ...this.agentMetadata(row), text: this.core.deps.content.get(row.content_ref)?.question ?? "", mentions: JSON.parse(row.mentions) as string[],
      ...(row.reply_to ? { replyTo: row.reply_to } : {}), ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      ...(row.stage ? { stage: row.stage } : {}), ...(row.answer_to ? { answerTo: row.answer_to } : {}),
      ...this.core.atomic(db => { const a = this.agents.progress(db, row.id), b = this.assistant.progress(db, row.id);
        const ask = a || b ? { total: (a?.total ?? 0)+(b?.total ?? 0), answered: (a?.answered ?? 0)+(b?.answered ?? 0), working: (a?.working ?? 0)+(b?.working ?? 0), later: (a?.later ?? 0)+(b?.later ?? 0) } : undefined;
        const reactions = this.reactions(db, row.id);
        return { ...(ask ? { ask } : {}), ...(this.assistant.warning(db, row.id) ? { warning: "assistant-unavailable" as const } : {}), ...(reactions.length ? { reactions } : {}) }; }) };
  }
  /** M-3127: a post's reactions, each emoji in the order it first appeared, its members in the order they reacted. */
  private reactions(db: DB, postId: string): NonNullable<RoomMessage["reactions"]> {
    const rows = db.prepare("SELECT emoji,member_id FROM hub_room_reactions WHERE post_id=? ORDER BY created_at,rowid").all(postId) as { emoji: string; member_id: string }[];
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.emoji, [...(out.get(r.emoji) ?? []), r.member_id]);
    return [...out].map(([emoji, members]) => ({ emoji, count: members.length, members }));
  }
  private viaAuthor(row: PostRow): { name?: string; via?: { id: string; name: string } } {
    return this.core.atomic(db => { const op = db.prepare("SELECT exposure_id,person_name,via_name FROM hub_room_agent_operations WHERE post_id=? AND receipt_id IS NOT NULL").get(row.id) as { exposure_id: string; person_name: string; via_name: string } | undefined;
      return op ? { name: op.person_name, via: { id: op.exposure_id, name: op.via_name } } : {}; });
  }
  private agentMetadata(row: PostRow): { proactive?: true; system?: RoomSystemEvent } {
    return this.core.atomic(db => {
      const stop = db.prepare("SELECT source_id,reason,name,retry_at FROM hub_room_agent_stops WHERE post_id=?").get(row.id) as { source_id: string; reason: "all" | "ambiguous" | "depth" | "rate" | "capacity"; name: string; retry_at: number | null } | undefined;
      if (stop) return { system: { kind: "agent-mention-stopped", reason: stop.reason, name: stop.name, sourceId: stop.source_id, ...(stop.retry_at !== null ? { retryAt: stop.retry_at } : {}) } };
      return db.prepare("SELECT 1 FROM hub_room_agent_operations WHERE post_id=? AND receipt_id IS NULL").get(row.id) ? { proactive: true } : {};
    });
  }
  private stop(db: DB, tx: HubTx, source: PostRow, reason: "all" | "ambiguous" | "depth" | "rate" | "capacity", name = source.author_name, retryAt?: number): void {
    if (db.prepare("SELECT 1 FROM hub_room_agent_stops WHERE source_id=? AND reason=? AND name=?").get(source.id, reason, name)) return;
    const text = reason === "all" ? "Agents can't use @All agents. This message was not sent to other agents."
      : reason === "ambiguous" ? `More than one member is named "${name}", so this mention was not delivered.`
      : reason === "depth" ? "Agents have asked each other several times in a row, so this stops here. They can ask each other again after a person writes in the room."
      : reason === "capacity" ? "The Hub is busy. This mention was not delivered. Try again later."
      : `${name} is posting too often, so this mention was not delivered. It can try again after ${new Date(retryAt!).toISOString()}.`;
    const row = this.insert(db, tx, source.room_id, { kind: "system", id: "agent-mention-stopped", subject: "system", name }, text);
    if (source.sequence !== undefined) { const l = this.automation.lineage(db, source);
      db.prepare("INSERT INTO hub_room_post_lineage VALUES(?,?,?,?,NULL)").run(row.id, l.root_id, l.depth, l.audience_sequence); }
    db.prepare("INSERT INTO hub_room_agent_stops VALUES(?,?,?,?,?)").run(row.id, source.id, reason, name, retryAt ?? null);
    this.core.audit(tx, { requestId: source.id, actor: { kind: "person", person: personFromString(source.author_subject) }, action: "room.agent-mention-stopped", result: "completed", roomId: source.room_id, messageId: row.id, contentRef: row.content_ref });
  }
  /** Both answers and proactive posts use this transaction, once, before any external delivery. */
  private agentMentions(db: DB, tx: HubTx, post: PostRow): void {
    const operation = db.prepare("SELECT exposure_id,receipt_id FROM hub_room_agent_operations WHERE post_id=?").get(post.id) as { exposure_id: string; receipt_id: string | null } | undefined;
    const sourceId = operation?.exposure_id ?? post.author_id, onBehalf = !!operation?.receipt_id;
    const source = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=? AND owner_at_join=?").get(post.room_id, sourceId, post.author_subject) as MemberRow | undefined;
    if (!source) return;
    const members = (db.prepare("SELECT * FROM hub_room_members WHERE room_id=?").all(post.room_id) as MemberRow[]).flatMap(m => {
      if (m.kind === "person") { const p = db.prepare("SELECT login_label FROM hub_people WHERE person=? UNION ALL SELECT login_label FROM hub_room_people WHERE person=? LIMIT 1").get(m.subject, m.subject) as { login_label: string } | undefined;
        return [{ ...m, name: this.name(db, m.subject), login: p?.login_label }]; }
      const e = m.kind === "agent" ? readExposure(db, m.subject) : undefined;
      return e && e.owner === m.owner_at_join ? [{ ...m, name: e.display_name }] : [];
    }) as MentionMember[];
    const resolved = resolveRoomMentions(this.core.deps.content.get(post.content_ref)?.question ?? "", members, onBehalf ? "" : sourceId), accepted: string[] = [];
    if (resolved.all && !onBehalf) this.stop(db, tx, post, "all");
    const targets = resolved.all && onBehalf ? members.filter(m => m.kind === "agent").map(m => m.subject) : resolved.all ? [] : resolved.agents;
    for (const name of resolved.ambiguous) this.stop(db, tx, post, "ambiguous", name);
    for (const target of [...resolved.people, ...targets]) {
      const agent = targets.includes(target);
      const recipient = members.find(m => agent ? m.kind === "agent" && m.subject === target : m.kind === "person" && m.id === target);
      if (recipient && (db.prepare("SELECT joined_sequence FROM hub_room_members WHERE id=?").get(recipient.id) as { joined_sequence: number }).joined_sequence > this.automation.lineage(db, post).audience_sequence) continue;
      if (agent && (db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries WHERE state IN ('queued','sent')").get() as { n: number }).n + accepted.filter(id => targets.includes(id)).length >= 4096) { this.stop(db, tx, post, "capacity"); continue; }
      if (agent && this.automation.depth(db, post) >= 3) { this.stop(db, tx, post, "depth"); continue; }
      const retryAt = this.automation.admit(db, post.room_id, sourceId);
      if (retryAt !== null) { this.stop(db, tx, post, "rate", post.author_name, retryAt); break; }
      accepted.push(target);
    }
    if (resolved.all && onBehalf) accepted.push("all");
    db.prepare("UPDATE hub_room_posts SET mentions=? WHERE id=?").run(JSON.stringify(accepted), post.id);
    this.agents.enqueue(db, tx, { ...post, mentions: JSON.stringify(accepted.filter(id => id !== "all")) }, source.id);
  }
  private agentEffects(id: string): void {
    this.agents.publishQueued(id);
    const rows = this.core.atomic(db => db.prepare("SELECT p.* FROM hub_room_agent_stops s JOIN hub_room_posts p ON p.id=s.post_id WHERE s.source_id=? ORDER BY p.sequence").all(id) as PostRow[]);
    for (const row of rows) this.emit({ type: "message.added", roomId: row.room_id, data: { roomId: row.room_id, message: this.projection(row) }, sequence: row.sequence });
  }
  private async agentSource(exposureId: string, link: HubLinkContext) {
    const current = () => this.core.live() && link.current();
    if (!current()) throw new HubProtocolError("stale");
    if (!["welcome-caps-v1", "room-ask-v1", HUB_ROOM_POST_CAPABILITY].every(f => link.features.has(f))) throw new HubProtocolError("denied");
    const owned = (db: DB) => {
      const e = readExposure(db, exposureId);
      if (!e || e.owner !== personKeyString(link.owner) || e.fleet_id !== link.fleetId || exposureOf(e).state !== "published") throw new HubProtocolError("denied");
      return e;
    };
    this.core.atomic(owned);
    const permit = await this.core.groupExposure(exposureId, null, { requestId: exposureId, current });
    if (!await this.core.eligible(link.owner)) throw new HubProtocolError("denied");
    const fence = { assertCurrent: () => { permit.assertCurrent(); if (!current()) throw new HubProtocolError("stale"); } };
    const source = this.core.atomic(owned, fence); return { source, fence };
  }
  async agentRooms(input: unknown, link: HubLinkContext): Promise<HubRoomListResult> {
    const body = validated(roomListSchema, input), { source, fence } = await this.agentSource(body.exposureId, link);
    return this.core.atomic(db => {
      this.agentRead(source.owner);
      const rooms = this.agentRoomChoices(db, source.id, source.owner);
      return { ok: true, exposureId: source.id, rooms: rooms.slice(0, 200), ...(rooms.length > 200 ? { truncated: true } : {}) };
    }, fence);
  }
  private agentRead(owner: string): void {
    const at = this.core.now(); for (const [key, b] of this.agentReadBuckets) if (at < b.at || at - b.at >= 60_000) this.agentReadBuckets.delete(key);
    const b = this.agentReadBuckets.get(owner);
    if (b ? b.count >= 30 : this.agentReadBuckets.size >= 1024) throw new HubProtocolError("backpressure");
    this.agentReadBuckets.set(owner, { at: b?.at ?? at, count: (b?.count ?? 0) + 1 });
  }
  async agentMembers(input: unknown, link: HubLinkContext): Promise<HubRoomMembersResult> {
    const body = validated(roomMembersSchema, input), { source, fence } = await this.agentSource(body.exposureId, link); this.agentRead(source.owner);
    return this.core.atomic(db => {
      const rows = db.prepare(`SELECT r.id,r.name FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id WHERE m.kind='agent' AND m.subject=? AND m.owner_at_join=? AND r.archived=0 AND r.assistant_for IS NULL AND (r.id=? OR r.name=?) ORDER BY r.id LIMIT 201`).all(source.id, source.owner, body.room, body.room) as { id: string; name: string }[];
      const room = rows.find(r => r.id === body.room) ?? (rows.length === 1 ? rows[0] : undefined);
      if (!room) return rows.length ? { ok: false, code: "ambiguous-room", rooms: rows.slice(0, 200) } : { ok: false, code: "not-found" };
      const members = (db.prepare("SELECT * FROM hub_room_members WHERE room_id=? ORDER BY kind,id LIMIT 201").all(room.id) as MemberRow[]).map(m => {
        if (m.kind === "assistant") return { id: "assistant", kind: m.kind, name: "Hub assistant", presence: this.assistant.presence(room.id) };
        if (m.kind === "agent") { const e = readExposure(db, m.subject); return { id: m.subject, kind: m.kind, name: e?.display_name ?? m.subject, owner: { name: this.name(db, m.owner_at_join ?? "") }, ...this.agents.presence(m.subject) }; }
        return { id: m.id, kind: m.kind, name: this.name(db, m.subject), presence: db.prepare("SELECT 1 FROM hub_sessions WHERE person=? AND state='active' AND expires_at>?").get(m.subject, this.core.now()) ? "online" : "offline" };
      });
      if (members.length > 200) throw new HubProtocolError("backpressure");
      return { ok: true, roomId: room.id, members };
    }, fence);
  }
  async agentPeople(input: unknown, link: HubLinkContext): Promise<HubPeopleSearchResult> {
    const body = validated(peopleSearchSchema, input), { source, fence } = await this.agentSource(body.exposureId, link); this.agentRead(source.owner);
    const current = async () => { fence.assertCurrent(); if (!await this.core.eligible(link.owner)) throw new HubProtocolError("denied"); fence.assertCurrent(); return { kind: "directory" as const, person: link.owner, sessionId: `member:${source.owner}` }; };
    const ctx: HubRequestContext = { requestId: randomUUID(), isCurrent: () => { try { fence.assertCurrent(); return true; } catch { return false; } },
      current, requirePerson: async () => (await current()).person, requireAdmin: async () => { throw new HubProtocolError("denied"); } };
    const raw = await this.agentSearch.search(ctx, source.id, { exposureRevision: source.revision, kind: "person", q: body.q }); fence.assertCurrent();
    const found = validated(z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), people: z.array(z.object({ person: z.object({ realm: z.string(), objectId: uuid }), login: z.string(), displayName: z.string() })).max(20), truncated: z.boolean() }), z.object({ ok: z.literal(false), reason: z.string() })]), raw);
    if (!found.ok) return { ok: false, code: found.reason === "limited" ? "backpressure" : "unavailable" };
    return { ok: true, people: found.people.map(p => ({ id: personKeyString(p.person), name: p.displayName, login: p.login })), truncated: found.truncated };
  }
  private agentRoomChoices(db: DB, exposure: string, owner: string) {
    return db.prepare(`SELECT r.id,r.name FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id
      WHERE m.kind='agent' AND m.subject=? AND m.owner_at_join=? AND r.archived=0 AND r.assistant_for IS NULL ORDER BY r.name,r.id LIMIT 201`).all(exposure, owner) as { id: string; name: string }[];
  }
  async agentPost(input: unknown, link: HubLinkContext): Promise<HubRoomPostResult> {
    const body = validated(roomPostSchema, input), { source, fence } = await this.agentSource(body.exposureId, link);
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex"); let added = false; let refusedEffects: string | undefined;
    const result = this.core.atomic((db, tx): HubRoomPostResult => {
      const old = db.prepare("SELECT * FROM hub_room_agent_operations WHERE exposure_id=? AND idempotency_key=?").get(source.id, body.idempotencyKey) as { digest: string; room_id: string; post_id: string; owner: string; fleet_id: string; at: number; member_id: string } | undefined;
      if (old) {
        if (old.digest !== digest) return { ok: false, code: "conflict" };
        const member = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=? AND owner_at_join=?").get(old.room_id, source.id, source.owner) as MemberRow | undefined;
        const row = db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(old.post_id) as PostRow;
        if (!member || member.id !== old.member_id || row.sequence < member.joined_sequence || old.owner !== source.owner || old.fleet_id !== source.fleet_id || this.room(db, old.room_id).archived) return { ok: false, code: "denied" };
        return { ok: true, roomId: old.room_id, messageId: old.post_id, at: old.at };
      }
      const matches = (byId: boolean) => db.prepare(`SELECT r.id,r.name FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id
        WHERE m.kind='agent' AND m.subject=? AND m.owner_at_join=? AND r.archived=0 AND r.assistant_for IS NULL AND ${byId ? "r.id" : "r.name"}=? ORDER BY r.id LIMIT 201`)
        .all(source.id, source.owner, body.room) as { id: string; name: string }[];
      const exact = matches(true)[0], named = exact ? [] : matches(false), room = exact ?? (named.length === 1 ? named[0] : undefined);
      if (!room) return named.length > 1 ? { ok: false, code: "ambiguous-room", rooms: named.slice(0, 200) } : { ok: false, code: "not-found" };
      const membership = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(room.id, source.id) as MemberRow;
      if (body.onBehalfOf) { const all = resolveRoomMentions(body.text, [], "").all;
        if (all && !this.room(db, room.id).all_mention && !db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=? AND role='manager'").get(room.id, source.owner)) return { ok: false, code: "denied" }; }
      const retryAt = this.automation.admit(db, room.id, source.id);
      if (retryAt !== null) {
        const prior = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND author_kind='agent' AND author_id=? AND stage IS NULL ORDER BY sequence DESC LIMIT 1").get(room.id, source.id) as PostRow | undefined;
        const notice = prior ?? { id: `rate:${source.id}:${room.id}:${retryAt}`, room_id: room.id, author_name: source.display_name, author_subject: source.owner } as PostRow;
        this.stop(db, tx, notice, "rate", source.display_name, retryAt); refusedEffects = notice.id;
        return { ok: false, code: "rate-limited", retryAt };
      }
      const humanName = body.onBehalfOf ? this.name(db, source.owner) : null;
      const ownerMember = body.onBehalfOf ? db.prepare("SELECT id FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(room.id, source.owner) as { id: string } | undefined : undefined;
      const post = this.insert(db, tx, room.id, { kind: body.onBehalfOf ? "person" : "agent", id: body.onBehalfOf ? ownerMember?.id ?? membership.id : source.id,
        subject: source.owner, name: body.onBehalfOf ? `${humanName} via ${source.display_name}` : source.display_name }, body.text);
      db.prepare("INSERT INTO hub_room_agent_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(source.id, body.idempotencyKey, digest, body.room, room.id, post.id, source.owner, source.fleet_id, post.created_at,
        membership.id, body.onBehalfOf?.receiptId ?? null, humanName, body.onBehalfOf ? source.display_name : null);
      if (body.onBehalfOf) this.automation.onBehalf(db, post, source.owner, body.onBehalfOf.receiptId, source.id); else this.automation.proactive(db, post);
      this.core.audit(tx, { requestId: post.id, actor: { kind: "person", person: link.owner }, action: "room.agent-post", result: "completed", roomId: room.id, messageId: post.id, exposureId: source.id, fleetId: link.fleetId, contentRef: post.content_ref });
      this.agentMentions(db, tx, post); added = true;
      return { ok: true, roomId: room.id, messageId: post.id, at: post.created_at };
    }, fence);
    if (added && result.ok) {
      const row = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(result.messageId) as PostRow);
      this.emit({ type: "message.added", roomId: row.room_id, data: { roomId: row.room_id, message: this.projection(row) }, sequence: row.sequence });
      this.emit({ type: "unread.changed", roomId: row.room_id, data: { roomId: row.room_id } }); this.agentEffects(row.id); this.agents.wake();
    }
    if (refusedEffects) this.agentEffects(refusedEffects);
    return result;
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
    const last = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND sequence>=? AND COALESCE((SELECT audience_sequence FROM hub_room_post_lineage l WHERE l.post_id=hub_room_posts.id),sequence)>=? AND (stage IS NULL OR stage='answered') AND (answer_to IS NULL OR EXISTS(SELECT 1 FROM hub_room_posts original WHERE original.id=hub_room_posts.answer_to AND original.sequence>=?)) ORDER BY sequence DESC LIMIT 1").get(room.id, floor, floor, floor) as PostRow | undefined;
    const unread = (db.prepare("SELECT COUNT(*) AS n FROM hub_room_posts WHERE room_id=? AND sequence>=? AND COALESCE((SELECT audience_sequence FROM hub_room_post_lineage l WHERE l.post_id=hub_room_posts.id),sequence)>=? AND sequence>? AND (author_kind<>'person' OR author_subject<>?) AND author_kind<>'system' AND (stage IS NULL OR stage='answered') AND (answer_to IS NULL OR EXISTS(SELECT 1 FROM hub_room_posts original WHERE original.id=hub_room_posts.answer_to AND original.sequence>=?))")
      .get(room.id, floor, floor, member.read_sequence, member.subject, floor) as { n: number }).n;
    const mentioned = !!db.prepare(`SELECT 1 FROM hub_room_posts p,json_each(p.mentions) j WHERE p.room_id=? AND p.sequence>=? AND COALESCE((SELECT audience_sequence FROM hub_room_post_lineage l WHERE l.post_id=p.id),p.sequence)>=? AND p.sequence>?
      AND (p.author_kind<>'person' OR p.author_subject<>?) AND j.value IN (?,?) LIMIT 1`).get(room.id, floor, floor, member.read_sequence, member.subject, member.id, member.subject);
    const online = (db.prepare(`SELECT COUNT(*) AS n FROM hub_room_members m WHERE m.room_id=? AND m.kind='person' AND EXISTS
      (SELECT 1 FROM hub_sessions s WHERE s.person=m.subject AND s.state='active' AND s.expires_at>?)`).get(room.id, this.core.now()) as { n: number }).n;
    const projected = last ? this.projection(last) : undefined;
    const summary = { id: room.id, kind: "group" as const, name: room.name, people: counts.find(c => c.kind === "person")?.n ?? 0,
      agents: counts.find(c => c.kind === "agent")?.n ?? 0, online, unread, lastAt: last?.created_at ?? room.created_at,
      lastText: projected?.text.slice(0, 240) ?? "", ...(projected?.system ? { lastSystem: projected.system } : {}), lastAuthor: last?.author_name ?? "", mentioned, archived: room.archived === 1 };
    return room.assistant_for ? { ...summary, kind: "direct" as const, assistant: true, presence: this.assistant.presence(room.id) } : summary;
  }
  private addAssistant(db: DB, roomId: string): void {
    if (db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='assistant'").get(roomId)) return;
    const room = this.room(db, roomId);
    db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence) VALUES(?,?,'assistant','assistant','member',?)")
      .run(randomUUID(), roomId, room.history_for_new === "all" ? 0 : this.maximum(db, roomId) + 1);
  }
  private assistantRoom(db: DB, me: string): void {
    if (!this.assistant.availability()?.enabled || db.prepare("SELECT 1 FROM hub_group_rooms WHERE assistant_for=?").get(me)) return;
    const id = randomUUID(); db.prepare("INSERT INTO hub_group_rooms(id,name,created_by,created_at,assistant_for) VALUES(?,'Hub assistant',?,?,?)").run(id, me, this.core.now(), me);
    db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence) VALUES(?,?,'person',?,'member',0)").run(randomUUID(), id, me);
    this.addAssistant(db, id);
  }
  async list(ctx: HubRequestContext) {
    const me = await this.who(ctx); this.agents.sweep();
    return this.core.atomic(db => {
      this.assistantRoom(db, me);
      return { rooms: (db.prepare("SELECT * FROM hub_room_members WHERE kind='person' AND subject=?").all(me) as MemberRow[])
        .map(m => this.summary(db, this.room(db, m.room_id), m)).sort((a, b) => b.lastAt - a.lastAt),
        me: { canCreateRooms: canCreateRoom(this.core, db, me), assistant: this.assistant.availability()?.enabled === true }, invitations: 0 };
    }, this.fence(ctx));
  }
  async candidates(ctx: HubRequestContext, q: string, kind: string) {
    if (q.length > 64 || /[\u0000-\u001f\u007f]/.test(q) || !["person", "team", "group", "agent"].includes(kind)) throw new HubProtocolError("invalid");
    const me = await this.who(ctx);
    const allowed = (db: DB) => canCreateRoom(this.core, db, me) || !!db.prepare(`SELECT 1 FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id
      WHERE m.kind='person' AND m.subject=? AND m.role='manager' AND r.archived=0`).get(me);
    if (kind === "agent") {
      this.core.atomic(db => { if (!allowed(db)) throw new HubRoomRefusal(403, "denied"); }, this.fence(ctx));
      const view = await new HubCatalogService(this.core).visible(ctx);
      const hits = [...view.mine.map(e => ({ kind: "agent" as const, id: e.id, name: e.displayName, mine: true, owner: { name: this.core.atomic(db => this.name(db, me)) } })),
        ...view.askable.map(({ exposure: e, ownerName }) => ({ kind: "agent" as const, id: e.id, name: e.displayName, mine: false, owner: { name: ownerName } }))]
        .filter(e => e.name.toLowerCase().startsWith(q.trim().toLowerCase())).slice(0, 20);
      this.fence(ctx).assertCurrent(); return hits;
    }
    if (q.trim().length >= 2 && (kind === "group" && this.core.deps.directory.searchPolicyGroups || kind === "person" && this.core.deps.directory.searchGrantPeople)) {
      return this.directory.search(ctx, me, q.trim(), kind as "person" | "group", () => this.core.atomic(db => {
        if (!allowed(db)) throw new HubRoomRefusal(403, "denied");
      }, this.fence(ctx)));
    }
    const rows = this.core.atomic(db => {
      if (!allowed(db)) throw new HubRoomRefusal(403, "denied");
      if (kind === "team") return [];
      if (kind !== "person") return [];
      const prefix = `${q.trim().replace(/[\\%_]/g, c => `\\${c}`)}%`;
      return db.prepare("SELECT person,display_name FROM hub_people WHERE status='active' AND (display_name LIKE ? ESCAPE '\\' OR login_label LIKE ? ESCAPE '\\') ORDER BY display_name,person LIMIT 20")
        .all(prefix, prefix) as { person: string; display_name: string }[];
    }, this.fence(ctx));
    const hits: { kind: "person"; id: string; name: string }[] = [];
    for (const row of rows) if (await this.core.eligible(personFromString(row.person))) hits.push({ kind: "person", id: row.person, name: row.display_name });
    return this.core.atomic(db => { if (!allowed(db)) throw new HubRoomRefusal(403, "denied");
      return kind === "team" ? (this.core.deps.roomTeamCandidates?.(db, q.trim()) ?? []).slice(0, 20).map(row => ({ kind: "team", ...row })) : hits;
    }, this.fence(ctx));
  }
  private candidateAllowed(ctx: HubRequestContext, me: string): void {
    this.core.atomic(db => {
      if (!canCreateRoom(this.core, db, me) && !db.prepare(`SELECT 1 FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id
        WHERE m.kind='person' AND m.subject=? AND m.role='manager' AND r.archived=0 AND r.assistant_for IS NULL`).get(me)) throw new HubRoomRefusal(403, "denied");
    }, this.fence(ctx));
  }
  private async groupSelection(ctx: HubRequestContext, me: string, id: string) {
    try { return await this.directory.roster(ctx, me, id, () => this.candidateAllowed(ctx, me)); }
    catch (e) {
      if (e instanceof HubRoomRefusal || e instanceof HubProtocolError && ["revoked", "denied", "backpressure"].includes(e.code)) throw e;
      throw new HubRoomRefusal(503, "group-unavailable", { group: id });
    }
  }
  async groupCandidate(ctx: HubRequestContext, id: string) {
    const me = await this.who(ctx), selection = await this.groupSelection(ctx, me, id);
    return { kind: "group", id, name: selection.name, people: selection.people.length };
  }
  async create(ctx: HubRequestContext, input: unknown) {
    const body = validated(createSchema, input), me = await this.who(ctx);
    this.core.atomic(db => { if (!canCreateRoom(this.core, db, me)) throw new HubRoomRefusal(403, "denied"); }, this.fence(ctx));
    const teams = this.core.deps.roomTeams;
    const expansion = (db: DB) => {
      if (!body.teams.length) return { teams: [], people: [], missing: [] };
      if (!teams || teams !== this.core.deps.roomTeams) throw new HubProtocolError("unavailable");
      const found = teams.expand(db, body.teams); if (found.missing.length) throw new HubProtocolError("invalid"); return found;
    };
    const selected = this.core.atomic(expansion), image = JSON.stringify(selected);
    const groupPeople: string[] = [];
    for (const group of new Set(body.groups)) groupPeople.push(...(await this.groupSelection(ctx, me, group)).people.map(p => p.id));
    const people = [...new Set([me, ...body.people, ...selected.people, ...groupPeople])];
    if (people.length > 100) throw new HubRoomRefusal(409, "people-limit", { people: people.length, limit: 100 });
    const selectedPeople: RoomPersonSelection[] = [];
    for (const person of people) if (person !== me) {
      const current = await this.core.current(personFromString(person)); if (!current) throw new HubRoomRefusal(400, "invalid-person"); selectedPeople.push({ id: person, ...current });
    }
    const permits = await Promise.all(body.agents.map(id => this.core.groupExposure(id, null, this.core.groupContext(ctx))));
    const room = this.core.atomic((db, tx) => {
      for (const permit of permits) permit.assertCurrent();
      if (JSON.stringify(expansion(db)) !== image) throw new HubProtocolError("conflict");
      if (!canCreateRoom(this.core, db, me)) throw new HubRoomRefusal(403, "denied");
      rememberRoomPeople(db, selectedPeople, this.core.now());
      const id = randomUUID(); db.prepare("INSERT INTO hub_group_rooms(id,name,created_by,created_at) VALUES(?,?,?,?)").run(id, body.name, me, this.core.now());
      for (const person of people) db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence) VALUES(?,?,'person',?,?,0)").run(randomUUID(), id, person, person === me ? "manager" : "member");
      this.insert(db, tx, id, { kind: "system", id: "room-created", subject: me, name: this.name(db, me) }, `${this.name(db, me)} created this room.`);
      for (const agent of body.agents) this.addAgentMember(db, tx, id, agent, me);
      if (body.assistant) this.addAssistant(db, id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.created", result: "completed", roomId: id });
      return this.summary(db, this.room(db, id), this.member(db, id, me));
    }, { assertCurrent: () => { this.fence(ctx).assertCurrent(); for (const permit of permits) permit.assertCurrent(); } });
    this.emit({ type: "room.changed", roomId: room.id, data: { roomId: room.id } }); return { room };
  }
  async detail(ctx: HubRequestContext, id: string) {
    const me = await this.who(ctx); this.agents.sweep(id);
    this.core.atomic(db => { this.member(db, id, me); }, this.fence(ctx));
    const canAsk = new Set<string>(), directProofs: HubOperationPermit[] = [];
    const candidates = this.core.atomic(db => db.prepare(`SELECT g.id,g.exposure_id FROM hub_grants g JOIN hub_room_members m ON m.subject=g.exposure_id
      WHERE m.room_id=? AND m.kind='agent' AND g.state='active' AND g.starts_at<=? AND g.expires_at>? AND (g.subject_kind IN ('group','team') OR g.subject=?)`)
      .all(id, this.core.now(), this.core.now(), me) as { id: string; exposure_id: string }[]);
    for (const g of candidates) {
      try { const permit = await this.core.exposureGrant(g.exposure_id, g.id, personFromString(me), this.core.groupContext(ctx)); permit.assertCurrent(); directProofs.push(permit); canAsk.add(g.exposure_id); }
      catch { /* A room member may still read the room when a separate direct-chat allowance is held. */ }
    }
    return this.core.atomic(db => {
      const own = this.member(db, id, me), room = this.room(db, id);
      const members = (db.prepare("SELECT * FROM hub_room_members WHERE room_id=? ORDER BY kind,id").all(id) as MemberRow[]).map(m => {
        if (m.kind === "assistant") return { id: "assistant", kind: m.kind, name: "Hub assistant", role: m.role, presence: this.assistant.presence(id) };
        if (m.kind === "agent") { const e = readExposure(db, m.subject); return { id: m.subject, kind: m.kind, name: e?.display_name ?? m.subject, role: m.role,
          owner: { name: this.name(db, m.owner_at_join ?? "") }, ...this.agents.presence(m.subject), canAsk: canAsk.has(m.subject) }; }
        return { id: m.id, kind: m.kind, name: this.name(db, m.subject), role: m.role,
          signedIn: !!db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(m.subject),
          presence: db.prepare("SELECT 1 FROM hub_sessions WHERE person=? AND state='active' AND expires_at>?").get(m.subject, this.core.now()) ? "online" : "offline" };
      });
      return { room: this.summary(db, room, own), me: { id: own.id, role: own.role }, members,
        settings: { allMention: room.all_mention === 1, historyForNew: room.history_for_new, ...(members.some(m => m.kind === "assistant") ? { assistant: true } : {}) }, invited: [] };
    }, { assertCurrent: () => { this.fence(ctx).assertCurrent(); for (const proof of directProofs) proof.assertCurrent(); } });
  }
  async patch(ctx: HubRequestContext, id: string, input: unknown) {
    const body = validated(patchSchema, input), me = await this.who(ctx);
    this.core.atomic((db, tx) => {
      this.member(db, id, me, true); const row = this.room(db, id);
      if (row.assistant_for) throw new HubRoomRefusal(403, "denied");
      if (body.assistant === true) this.addAssistant(db, id);
      else if (body.assistant === false) db.prepare("DELETE FROM hub_room_members WHERE room_id=? AND kind='assistant'").run(id);
      db.prepare("UPDATE hub_group_rooms SET name=?,all_mention=?,history_for_new=?,archived=? WHERE id=?")
        .run(body.name ?? row.name, body.allMention === undefined ? row.all_mention : Number(body.allMention), body.historyForNew ?? row.history_for_new, body.archived === undefined ? row.archived : Number(body.archived), id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.updated", result: "completed", roomId: id });
    }, this.fence(ctx));
    if (body.archived || body.assistant === false) this.assistant.forget(id);
    this.agents.sweep(id);
    this.emit({ type: "room.changed", roomId: id, data: { roomId: id } }); return this.detail(ctx, id);
  }
  async add(ctx: HubRequestContext, id: string, input: unknown) {
    const body = validated(z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("person"), id: personId }), z.strictObject({ kind: z.literal("agent"), id: uuid }),
      z.strictObject({ kind: z.literal("team"), id: uuid }), z.strictObject({ kind: z.literal("group"), id: uuid }), z.strictObject({ kind: z.literal("assistant") })]), input), me = await this.who(ctx);
    if (body.kind === "assistant") return this.patch(ctx, id, { assistant: true });
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
    const teams = this.core.deps.roomTeams;
    const expansion = (db: DB) => {
      if (body.kind !== "team") return null;
      if (!teams || this.core.deps.roomTeams !== teams) throw new HubProtocolError("unavailable");
      const out = teams.expand(db, [body.id]); if (out.missing.length) throw new HubProtocolError("invalid"); return out;
    };
    const selectedTeam = this.core.atomic(expansion), teamImage = JSON.stringify(selectedTeam);
    const people = body.kind === "person" ? [body.id] : body.kind === "team" ? selectedTeam!.people : (await this.groupSelection(ctx, me, body.id)).people.map(p => p.id);
    const ids = [...new Set(people)];
    const assertCount = (db: DB) => {
      const current = (db.prepare("SELECT subject FROM hub_room_members WHERE room_id=? AND kind='person'").all(id) as { subject: string }[]).map(m => m.subject);
      const count = new Set([...current, ...ids]).size; if (count > 100) throw new HubRoomRefusal(409, "people-limit", { people: count, limit: 100 });
    };
    this.core.atomic(assertCount, this.fence(ctx));
    const selectedPeople: RoomPersonSelection[] = [];
    for (const person of ids) {
      const selected = await this.core.current(personFromString(person)); if (!selected) throw new HubRoomRefusal(400, "invalid-person"); selectedPeople.push({ id: person, ...selected });
    }
    this.core.atomic((db, tx) => {
      this.member(db, id, me, true); const room = this.room(db, id); if (room.assistant_for) throw new HubRoomRefusal(403, "denied"); if (room.archived) throw new HubRoomRefusal(409, "archived");
      if (JSON.stringify(expansion(db)) !== teamImage) throw new HubProtocolError("conflict"); assertCount(db);
      rememberRoomPeople(db, selectedPeople, this.core.now());
      for (const person of ids) {
        if (db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(id, person)) continue;
        const seq = this.maximum(db, id) + 1;
        db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence,read_sequence) VALUES(?,?,'person',?,'member',?,?)")
          .run(randomUUID(), id, person, room.history_for_new === "all" ? 0 : seq, 0);
        this.insert(db, tx, id, { kind: "system", id: "member-joined", subject: person, name: this.name(db, person) }, `${this.name(db, person)} joined this room.`);
      }
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.member-added", result: "completed", roomId: id });
    }, this.fence(ctx));
    this.emit({ type: "room.changed", roomId: id, data: { roomId: id } });
    this.emit({ type: "member.changed", roomId: id, data: { roomId: id } }); return { ok: true };
  }
  /** C invitation acceptance calls this only inside its guarded exact-invitation transaction. */
  addAgentMember(db: DB, tx: HubTx, roomId: string, exposureId: string, owner: string): void {
    const room = this.room(db, roomId); if (room.assistant_for) throw new HubRoomRefusal(403, "denied"); if (room.archived) throw new HubRoomRefusal(409, "archived");
    const e = readExposure(db, exposureId);
    if (!e) throw new HubRoomRefusal(404, "not-found");
    if (e.owner !== owner || exposureOf(e).state !== "published") throw new HubRoomRefusal(403, "denied");
    const old = db.prepare("SELECT owner_at_join FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(roomId, exposureId) as { owner_at_join: string } | undefined;
    if (old) { if (old.owner_at_join !== owner) throw new HubProtocolError("conflict"); return; }
    const seq = this.maximum(db, roomId) + 1;
    db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence,owner_at_join) VALUES(?,?,'agent',?,'member',?,?)")
      .run(randomUUID(), roomId, exposureId, room.history_for_new === "all" ? 0 : seq, owner);
    this.insert(db, tx, roomId, { kind: "system", id: "member-joined", subject: exposureId, name: e.display_name }, `${e.display_name} joined this room.`);
  }
  async changeMember(ctx: HubRequestContext, id: string, memberId: string, role?: "manager" | "member") {
    const me = await this.who(ctx);
    const removed = this.core.atomic((db, tx) => {
      if (this.room(db, id).assistant_for) throw new HubRoomRefusal(403, "denied");
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
    this.agents.sweep(id);
    if (removed) this.emit({ type: "room.changed", roomId: id, data: { roomId: id, removed: true }, removedPerson: removed });
    this.emit({ type: "member.changed", roomId: id, data: { roomId: id } }); return { ok: true };
  }
  async messages(ctx: HubRequestContext, id: string, before: string | null, limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HubProtocolError("invalid");
    const me = await this.who(ctx); this.agents.sweep(id);
    return this.core.atomic(db => {
      const member = this.member(db, id, me); let until = Number.MAX_SAFE_INTEGER;
      if (before) { const row = db.prepare("SELECT sequence FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(validated(uuid, before), id, member.joined_sequence) as { sequence: number } | undefined;
        if (!row) throw new HubRoomRefusal(404, "not-found"); until = row.sequence; }
      const rows = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND sequence>=? AND COALESCE((SELECT audience_sequence FROM hub_room_post_lineage l WHERE l.post_id=hub_room_posts.id),sequence)>=? AND sequence<? AND (answer_to IS NULL OR EXISTS(SELECT 1 FROM hub_room_posts original WHERE original.id=hub_room_posts.answer_to AND original.sequence>=?)) ORDER BY sequence DESC LIMIT ?").all(id, member.joined_sequence, member.joined_sequence, until, member.joined_sequence, limit + 1) as PostRow[];
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
      this.automation.human(db, post);
      this.agents.enqueue(db, tx, { ...post, mentions: JSON.stringify(body.mentions.filter(m => m !== "assistant")) }, member.id);
      this.assistant.enqueue(db, tx, post, member.id, room.assistant_for !== null);
      added = true; return post;
    }, this.fence(ctx));
    const message = this.projection(row);
    if (added) { this.emit({ type: "message.added", roomId: id, data: { roomId: id, message }, sequence: row.sequence }); this.emit({ type: "unread.changed", roomId: id, data: { roomId: id } }); }
    if (added) { this.agents.publishQueued(row.id); this.assistant.publishQueued(row.id); }
    this.agents.wake(); this.assistant.wake(); return message;
  }
  /**
   * M-3127: add or take back my reaction on a post I can see (since my joined_sequence; not a room line, not an answer
   * still to come). Set semantics: adding twice or removing what is not there changes nothing and emits nothing.
   */
  async react(ctx: HubRequestContext, id: string, postId: unknown, input: unknown): Promise<{ reactions: NonNullable<RoomMessage["reactions"]> }> {
    const body = validated(reactSchema, input), target = validated(uuid, postId);
    if (!validRoomEmoji(body.emoji)) throw new HubProtocolError("invalid");
    const me = await this.who(ctx);
    const done = this.core.atomic(db => {
      const member = this.member(db, id, me);
      if (this.room(db, id).archived) throw new HubRoomRefusal(409, "archived");
      const post = db.prepare("SELECT * FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(target, id, member.joined_sequence) as PostRow | undefined;
      if (!post || post.answer_to && !db.prepare("SELECT 1 FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(post.answer_to, id, member.joined_sequence)) throw new HubRoomRefusal(404, "not-found");
      if (post.author_kind === "system" || post.stage && post.stage !== "answered") throw new HubRoomRefusal(409, "invalid");
      let changed: boolean;
      if (body.on) {
        const has = db.prepare("SELECT emoji FROM hub_room_reactions WHERE post_id=? GROUP BY emoji").all(post.id) as { emoji: string }[];
        if (!has.some(r => r.emoji === body.emoji) && has.length >= ROOM_REACTION_LIMIT) throw new HubRoomRefusal(409, "limit");
        changed = db.prepare("INSERT OR IGNORE INTO hub_room_reactions(room_id,post_id,member_id,emoji,created_at) VALUES(?,?,?,?,?)").run(id, post.id, member.id, body.emoji, this.core.now()).changes > 0;
      } else changed = db.prepare("DELETE FROM hub_room_reactions WHERE post_id=? AND member_id=? AND emoji=?").run(post.id, member.id, body.emoji).changes > 0;
      return { post, changed, reactions: this.reactions(db, post.id) };
    }, this.fence(ctx));
    // The post as it now is, on the stream every open tab already reads (message.updated): no new event name.
    if (done.changed) this.emit({ type: "message.updated", roomId: id, data: { roomId: id, message: this.projection(done.post) }, sequence: done.post.sequence });
    return { reactions: done.reactions };
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
      const message = event.data.message as RoomMessage | undefined;
      if (message && db.prepare("SELECT 1 FROM hub_room_post_lineage WHERE post_id=? AND audience_sequence<?").get(message.id, member.joined_sequence)) return null;
      if (message?.answerTo && !db.prepare("SELECT 1 FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(message.answerTo, event.roomId, member.joined_sequence)) return null;
      if (event.type === "unread.changed") return { roomId: event.roomId, unread: this.summary(db, this.room(db, event.roomId), member).unread };
      if (event.type === "room.changed") return { roomId: event.roomId, room: this.summary(db, this.room(db, event.roomId), member) };
      return event.data;
    }, this.fence(ctx));
  }
}
