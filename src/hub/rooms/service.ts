import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { HubCatalogService, exposureOf, readExposure } from "../catalog.js";
import { HubRoomAssistant } from "./assistant.js";
import { canCreateRoom } from "./admin.js";
import { HubRoomAgents, type RoomPostRow } from "./agents.js";
import { personKeyString } from "../identity.js";
import { HubCore, personFromString, type HubOperationPermit } from "../http/core.js";
import { uuid, plain, validated, HubProtocolError } from "../validation.js";
import type { HubRequestContext, HubTx } from "../types.js";
import type { RoomEvent, RoomMessage } from "./types.js";
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
const patchSchema = z.strictObject({ name: label.optional(), allMention: z.boolean().optional(), historyForNew: z.enum(["since-join", "all"]).optional(), archived: z.boolean().optional(), assistant: z.boolean().optional() });

export class HubRoomRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, string | number> = {}) { super(`Room: ${code}`); }
}
/** People chat first; direct agent conversations remain in HubRoomsService. No timers or I/O on import. */
export class HubGroupRooms {
  private listeners = new Set<(event: RoomEvent) => void>();
  readonly agents: HubRoomAgents;
  readonly assistant: HubRoomAssistant;
  private readonly directory: RoomDirectoryCandidates;
  constructor(private readonly core: HubCore) { this.agents = new HubRoomAgents(core, event => this.emit(event), post => this.projection(post));
    this.assistant = new HubRoomAssistant(core, event => this.emit(event), post => this.projection(post)); this.directory = new RoomDirectoryCandidates(core); }
  has(id: string): boolean { return this.core.atomic(db => !!db.prepare("SELECT 1 FROM hub_group_rooms WHERE id=?").get(id)); }
  subscribe(listener: (event: RoomEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Cheap queue admission only; event() still freshly authorizes and projects the eventual disclosure. */
  interested(person: string, event: RoomEvent): boolean {
    if (event.removedPerson) return event.removedPerson === person;
    return this.core.atomic(db => !!db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(event.roomId, person));
  }
  async close(): Promise<void> { this.listeners.clear(); this.directory.close(); this.assistant.close(); await this.agents.close(); }
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
    return { id: row.id, roomId: row.room_id, at: row.created_at, author: { kind: row.author_kind, id: row.author_id, name: row.author_name },
      text: this.core.deps.content.get(row.content_ref)?.question ?? "", mentions: JSON.parse(row.mentions) as string[],
      ...(row.reply_to ? { replyTo: row.reply_to } : {}), ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      ...(row.stage ? { stage: row.stage } : {}), ...(row.answer_to ? { answerTo: row.answer_to } : {}),
      ...this.core.atomic(db => { const a = this.agents.progress(db, row.id), b = this.assistant.progress(db, row.id);
        const ask = a || b ? { total: (a?.total ?? 0)+(b?.total ?? 0), answered: (a?.answered ?? 0)+(b?.answered ?? 0), working: (a?.working ?? 0)+(b?.working ?? 0), later: (a?.later ?? 0)+(b?.later ?? 0) } : undefined;
        return { ...(ask ? { ask } : {}), ...(this.assistant.warning(db, row.id) ? { warning: "assistant-unavailable" as const } : {}) }; }) };
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
    const last = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND sequence>=? AND (stage IS NULL OR stage='answered') AND (answer_to IS NULL OR EXISTS(SELECT 1 FROM hub_room_posts original WHERE original.id=hub_room_posts.answer_to AND original.sequence>=?)) ORDER BY sequence DESC LIMIT 1").get(room.id, floor, floor) as PostRow | undefined;
    const unread = (db.prepare("SELECT COUNT(*) AS n FROM hub_room_posts WHERE room_id=? AND sequence>=? AND sequence>? AND (author_kind<>'person' OR author_subject<>?) AND author_kind<>'system' AND (stage IS NULL OR stage='answered') AND (answer_to IS NULL OR EXISTS(SELECT 1 FROM hub_room_posts original WHERE original.id=hub_room_posts.answer_to AND original.sequence>=?))")
      .get(room.id, floor, member.read_sequence, member.subject, floor) as { n: number }).n;
    const mentioned = !!db.prepare(`SELECT 1 FROM hub_room_posts p,json_each(p.mentions) j WHERE p.room_id=? AND p.sequence>=? AND p.sequence>?
      AND p.author_subject<>? AND j.value IN (?,?) LIMIT 1`).get(room.id, floor, member.read_sequence, member.subject, member.id, member.subject);
    const online = (db.prepare(`SELECT COUNT(*) AS n FROM hub_room_members m WHERE m.room_id=? AND m.kind='person' AND EXISTS
      (SELECT 1 FROM hub_sessions s WHERE s.person=m.subject AND s.state='active' AND s.expires_at>?)`).get(room.id, this.core.now()) as { n: number }).n;
    const summary = { id: room.id, kind: "group" as const, name: room.name, people: counts.find(c => c.kind === "person")?.n ?? 0,
      agents: counts.find(c => c.kind === "agent")?.n ?? 0, online, unread, lastAt: last?.created_at ?? room.created_at,
      lastText: last ? this.projection(last).text.slice(0, 240) : "", lastAuthor: last?.author_name ?? "", mentioned, archived: room.archived === 1 };
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
      this.insert(db, tx, id, { kind: "system", id: "system", subject: "system", name: "" }, `${this.name(db, me)} created this room.`);
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
      WHERE m.room_id=? AND m.kind='agent' AND g.state='active' AND g.starts_at<=? AND g.expires_at>? AND (g.subject_kind='group' OR g.subject=?)`)
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
        this.insert(db, tx, id, { kind: "system", id: "system", subject: "system", name: "" }, `${this.name(db, person)} joined this room.`);
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
    this.insert(db, tx, roomId, { kind: "system", id: "system", subject: "system", name: "" }, `${e.display_name} joined this room.`);
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
      const rows = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND sequence>=? AND sequence<? AND (answer_to IS NULL OR EXISTS(SELECT 1 FROM hub_room_posts original WHERE original.id=hub_room_posts.answer_to AND original.sequence>=?)) ORDER BY sequence DESC LIMIT ?").all(id, member.joined_sequence, until, member.joined_sequence, limit + 1) as PostRow[];
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
      this.agents.enqueue(db, tx, { ...post, mentions: JSON.stringify(body.mentions.filter(m => m !== "assistant")) }, member.id);
      this.assistant.enqueue(db, tx, post, member.id, room.assistant_for !== null);
      added = true; return post;
    }, this.fence(ctx));
    const message = this.projection(row);
    if (added) { this.emit({ type: "message.added", roomId: id, data: { roomId: id, message }, sequence: row.sequence }); this.emit({ type: "unread.changed", roomId: id, data: { roomId: id } }); }
    if (added) { this.agents.publishQueued(row.id); this.assistant.publishQueued(row.id); }
    this.agents.wake(); this.assistant.wake(); return message;
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
      if (message?.answerTo && !db.prepare("SELECT 1 FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(message.answerTo, event.roomId, member.joined_sequence)) return null;
      if (event.type === "unread.changed") return { roomId: event.roomId, unread: this.summary(db, this.room(db, event.roomId), member).unread };
      if (event.type === "room.changed") return { roomId: event.roomId, room: this.summary(db, this.room(db, event.roomId), member) };
      return event.data;
    }, this.fence(ctx));
  }
}
