import {HUB_ROOM_MEMBERS_CAPABILITY} from "../room-members-model.js";
import {pageRoomMembers} from "./members-page.js";
import {normalizeRoomPurpose} from "./purpose.js";
import { ROOM_OFFICE_STYLES, newRoomOffice, officeAgent, officeOn, roomOfficeView, withLook, memberLook, type RoomOfficeLook, type RoomPresence } from "./office.js";
import { agentIntro } from "../agent-intro.js";
import { countChainStop } from "../admin-dashboard.js";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { HubCatalogService, exposureOf, readExposure } from "../catalog.js";
import { RoomPostReplies } from "./post-replies.js";
import { HubGrantSearch } from "../grant-search.js";
import { HubRoomAssistant } from "./assistant.js";
import { canCreateRoom, prepareRoomCreation } from "./admin.js";
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
import { RoomButtons } from "./buttons.js";
import { HUB_ROOM_REACT_CAPABILITY, roomReactSchema } from "../protocol.js";
import { replyButtonClickText } from "../../reply-buttons.js";
import { pollResultsText, type PollBallot } from "../../reply-polls.js";
import { RoomDirectoryCandidates, rememberRoomPeople, roomPersonLabels, type RoomPersonSelection } from "./directory.js";
import type { HubAttachmentStore } from "../attachments/store.js";
import type { HubAttachmentRef } from "../types.js";
import { isInlineImage } from "../attachments/limits.js";
import {HUB_ROOM_MENTION_FEEDBACK_CAPABILITY} from "../room-mention-feedback-model.js";
import {personalMentionRefusals,recordPersonalMentionRefusals} from "../personal/refusals.js";

type DB = Database.Database;
interface RoomRow { id: string; name: string; purpose:string; created_by: string; created_at: number; archived: number; all_mention: number; history_for_new: "since-join" | "all"; assistant_for: string | null; office_enabled: number | null; office_style: string }
interface MemberRow { id: string; room_id: string; kind: "person" | "agent" | "assistant"; subject: string; role: "manager" | "member"; joined_sequence: number; read_sequence: number; owner_at_join: string | null }
type PostRow = RoomPostRow;
const label = plain(120).transform(s => s.trim()).refine(s => s.length > 0 && !/[\u0000-\u001f\u007f]/.test(s));
const personId = z.string().max(128).refine(s => /^[a-z][a-z0-9_-]{0,63}\/[a-f0-9-]{36}$/.test(s));
const purpose=z.string().transform(normalizeRoomPurpose);
const createSchema = z.strictObject({ name: label, purpose:purpose.default(""), people: z.array(personId).max(100).default([]), teams: z.array(uuid).max(100).default([]),
  groups: z.array(uuid).max(100).default([]), agents: z.array(uuid).max(64).default([]), assistant: z.boolean().default(false) });
// M-3125: a post carries up to 10 of the poster's own pending uploads in this room; with files the text may be empty.
const postSchema = z.strictObject({ text: plain(64 * 1024), mentions: z.array(z.string().max(128)).max(100).default([]),
  replyTo: uuid.optional(), files: z.array(uuid).max(10).optional(), idempotencyKey: uuid })
  .refine(b => b.text.trim().length > 0 || (b.files?.length ?? 0) > 0);
export interface GroupRoomFileView { id: string; name: string; size: number; mime: string; url: string }
const groupFileView = (roomId: string, r: HubAttachmentRef): GroupRoomFileView => ({ id: r.id, name: r.name, size: r.size, mime: r.mime, url: `/hub/v1/rooms/${roomId}/files/${r.id}` });
const clickSchema = z.strictObject({ setId: z.string().regex(/^[a-f0-9]{32}$/), index: z.number().int().min(0).max(9).optional(),
  options: z.array(z.number().int().min(0).max(9)).max(10).optional(), idempotencyKey: uuid });
/** M-3127: one press per set — its click post's idempotency key, a UUID shape derived from the set id. */
const setKey = (setId: string) => { const h = createHash("sha256").update(`room-button:${setId}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
/** M-3127 C: how many posts one search reads at most, and the most hits it returns. */
export const ROOM_SEARCH_SCAN = 2000, ROOM_SEARCH_LIMIT = 50, ROOM_SEARCH_PER_MINUTE = 30;
const fold = (s: string) => s.normalize("NFKC").toLowerCase();
/**
 * M-3127 C: a hit's words — up to `width` characters around its first term, on whole characters, with every term's places
 * in that snippet (`marks`: [start, end) ranges, merged). The page marks them; it never parses HTML.
 */
export function searchSnippet(text: string, terms: string[], width = 120): { snippet: string; marks: [number, number][] } {
  const chars = [...text], lower = fold(text);
  const first = Math.min(...terms.map(t => lower.indexOf(t)).filter(i => i >= 0), Number.MAX_SAFE_INTEGER);
  // A code-unit index → a character index (an emoji is two units): count the characters before it.
  const at = first === Number.MAX_SAFE_INTEGER ? 0 : [...text.slice(0, first)].length;
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), chars.length - width)), end = Math.min(chars.length, start + width);
  const snippet = `${start > 0 ? "…" : ""}${chars.slice(start, end).join("").replace(/\s+/g, " ")}${end < chars.length ? "…" : ""}`;
  const low = snippet.toLowerCase(), ranges: [number, number][] = [];
  for (const t of terms) for (let i = low.indexOf(t); i !== -1 && ranges.length < 64; i = low.indexOf(t, i + Math.max(1, t.length))) ranges.push([i, i + t.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const marks: [number, number][] = [];
  for (const r of ranges) { const last = marks[marks.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else marks.push([...r]); }
  return { snippet, marks };
}
const reactSchema = z.strictObject({ emoji: z.string().min(1).max(16), on: z.boolean() });
/** M-3127: the most distinct emoji one post carries. */
export const ROOM_REACTION_LIMIT = 12;
/** M-3340: a person's pins per room (the Fleet chat's own limit, chat-pins.js PINS_MAX). */
export const ROOM_PINS_MAX = 50;
/** One emoji as a person picks it: one grapheme, a pictograph (ZWJ sequences, FE0F and skin tones kept), no controls. */
export function validRoomEmoji(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 1 || s.length > 16 || /[\u0000-\u001f\u007f\s]/u.test(s)) return false;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return false;
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length === 1;
}
const patchSchema = z.strictObject({ name: label.optional(), purpose:purpose.optional(), allMention: z.boolean().optional(), historyForNew: z.enum(["since-join", "all"]).optional(), archived: z.boolean().optional(), assistant: z.boolean().optional(),
  office: z.strictObject({ enabled: z.boolean().optional(), style: z.enum(ROOM_OFFICE_STYLES).optional() }).optional() });

export class HubRoomRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, string | number> = {}) { super(`Room: ${code}`); }
}
/** People chat first; direct agent conversations remain in HubRoomsService. No timers or I/O on import. */
export class HubGroupRooms {
  private readonly appPosts: boolean;
  private listeners = new Set<(event: RoomEvent) => void>();
  readonly agents: HubRoomAgents;
  readonly assistant: HubRoomAssistant;
  readonly postReplies: RoomPostReplies;
  private readonly directory: RoomDirectoryCandidates;
  private readonly automation: RoomAutomation;
  /** M-3127 B: answers' buttons and polls; one timer for the next deadline (cleared by close()). */
  private readonly buttons: RoomButtons;
  private buttonsTimer: NodeJS.Timeout | null = null;
  private buttonsClosed = false;
  /** M-3127 C (Fable P3b): each person's recent searches (their times), for ROOM_SEARCH_PER_MINUTE. */
  private readonly searches = new Map<string, number[]>();
  private readonly agentSearch: HubGrantSearch;
  private readonly agentReadBuckets = new Map<string, { at: number; count: number }>();
  /** M-3533 R1: `office` true once the Hub offers the room office (room-office-v1); until then its field and route are refused. */
  /**
   * M-3533 R2a: a Fleet's shared agents' looks (exposure id → colour, emoji) from its owner's agent catalog, set by the
   * composition (agent-catalog.ts); none: the room office draws no look.
   */
  looks: ((fleetId: string) => Map<string, RoomOfficeLook> | null) | null = null;
  /** M-3533 R2b: a held picture's bytes by its hash (agent-pictures.ts), set by the composition; none: no picture is served. */
  pictureFile: ((sha256: string) => { mime: string; bytes: Buffer } | null) | null = null;
  /** M-3533 R2b: a room agent's disc or portrait, for the room's members only — the hash the room shows for it now. */
  async picture(ctx: HubRequestContext, id: string, exposureId: string, slot: "disc" | "portrait") {
    const me = await this.who(ctx);
    const sha256 = this.core.atomic(db => {
      this.member(db, id, me);
      if (!db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(id, exposureId)) throw new HubRoomRefusal(404, "not-found");
      const e = readExposure(db, exposureId);
      const h = e?.fleet_id && this.looks ? this.looks(e.fleet_id)?.get(exposureId)?.[slot] : undefined;
      if (!h) throw new HubRoomRefusal(404, "not-found");
      return h;
    }, this.fence(ctx));
    const file = this.pictureFile?.(sha256);
    if (!file) throw new HubRoomRefusal(404, "not-found");
    return { sha256, ...file };
  }
  /** M-3533 R2c: one pose of a room agent's own character, for the room's members only — the strip the room shows for it now. */
  async characterStrip(ctx: HubRequestContext, id: string, exposureId: string, pose: string) {
    const me = await this.who(ctx);
    const sha256 = this.core.atomic(db => {
      this.member(db, id, me);
      if (!db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(id, exposureId)) throw new HubRoomRefusal(404, "not-found");
      const e = readExposure(db, exposureId);
      const character = e?.fleet_id && this.looks ? this.looks(e.fleet_id)?.get(exposureId)?.character : undefined;
      const h = character && Object.hasOwn(character, pose) ? character[pose]?.sha256 : undefined;
      if (!h) throw new HubRoomRefusal(404, "not-found");
      return h;
    }, this.fence(ctx));
    const file = this.pictureFile?.(sha256);
    if (!file) throw new HubRoomRefusal(404, "not-found");
    return { sha256, ...file };
  }
  /** M-3533 R2b: these agents' pictures changed — every room holding one re-reads its members (open pages follow). */
  lookChanged(exposureIds: readonly string[]): void {
    const ids = [...new Set(exposureIds)].slice(0, 512);
    if (!ids.length) return;
    const rooms = this.core.atomic(db => db.prepare(`SELECT DISTINCT room_id FROM hub_room_members WHERE kind='agent' AND subject IN (${ids.map(() => "?").join(",")})`).all(...ids) as { room_id: string }[]);
    for (const { room_id: roomId } of rooms) this.emit({ type: "member.changed", roomId, data: { roomId } });
  }
  constructor(private readonly core: HubCore, private readonly office = false) { this.appPosts=core.atomic(db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_mcp_room_posts'").get()); this.postReplies = new RoomPostReplies(core); this.automation = new RoomAutomation(() => core.now()); this.agentSearch = new HubGrantSearch(core);
    this.agents = new HubRoomAgents(core, event => this.emit(event), post => this.projection(post), this.automation,
      (db, tx, post) => { this.agentMentions(db, tx, post); this.postReplies.enqueue(db, tx, post); }, id => { this.agentEffects(id); this.postReplies.wake(); });
    this.assistant = new HubRoomAssistant(core, event => this.emit(event), post => this.projection(post)); this.directory = new RoomDirectoryCandidates(core);
    this.buttons = new RoomButtons(core.deps.content, () => core.now());
    this.agents.onAnswerButtons = (db, tx, d, b) => {
      const ref = this.buttons.record(db, tx, d, b);
      if (!ref) return;   // that set id is taken: no buttons on this answer, nothing opened
      this.core.audit(tx, { requestId: d.id, actor: { kind: "local-host" }, action: b.poll ? "room.poll-opened" : "room.buttons-opened", result: "completed", roomId: d.room_id, messageId: d.reply_id, contentRef: ref });
      queueMicrotask(() => this.armButtons());
    };
    this.armButtons(); }
  has(id: string): boolean { return this.core.atomic(db => !!db.prepare("SELECT 1 FROM hub_group_rooms WHERE id=?").get(id)); }
  subscribe(listener: (event: RoomEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Cheap queue admission only; event() still freshly authorizes and projects the eventual disclosure. */
  interested(person: string, event: RoomEvent): boolean {
    if (event.removedPerson) return event.removedPerson === person;
    return this.core.atomic(db => !!db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(event.roomId, person));
  }
  async close(): Promise<void> { this.buttonsClosed = true; if (this.buttonsTimer) clearTimeout(this.buttonsTimer); this.buttonsTimer = null; this.listeners.clear(); this.directory.close(); this.agentSearch.close(); this.agentReadBuckets.clear(); this.assistant.close(); await this.agents.close(); await this.postReplies.close(); }
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
    let system: RoomSystemEvent | undefined = row.author_kind === "system" && ["room-created", "member-joined", "admin-joined", "poll-closed", "app-rate-limited"].includes(row.author_id)
      ? { kind: row.author_id as "room-created" | "member-joined" | "admin-joined" | "poll-closed" | "app-rate-limited", name: row.author_name } : undefined;
    if(row.author_kind==="system"&&row.author_id==="purpose-changed"){
      const event=this.core.atomic(db=>db.prepare("SELECT purpose FROM hub_room_purpose_events WHERE post_id=?").get(row.id)) as {purpose:string}|undefined;
      if(event)system={kind:"purpose-changed",name:row.author_name,purpose:event.purpose};
    }
    if (row.author_kind === "system" && row.author_id === "office-style-changed") {
      const event = this.core.atomic(db => db.prepare("SELECT style FROM hub_room_office_style_events WHERE post_id=?").get(row.id)) as { style: string } | undefined;
      if (event) system = { kind: "office-style-changed", name: row.author_name, style: event.style };
    }
    if (row.author_kind === "system" && row.author_id === "office-changed") {
      const event = this.core.atomic(db => db.prepare("SELECT enabled FROM hub_room_office_events WHERE post_id=?").get(row.id)) as { enabled: number } | undefined;
      if (event) system = { kind: "office-changed", name: row.author_name, enabled: event.enabled === 1 };
    }
    // Agent rows retain their owner-at-message in author_subject; a later exposure transfer must not relabel history.
    const agent = row.author_kind === "agent" ? this.core.atomic(db => { const e = readExposure(db, row.author_id);
      return { owner: { name: this.name(db, row.author_subject) }, ...(e ? { agentKind: e.source_kind === "personal" ? "personal" as const : "fleet" as const } : {}) }; }) : undefined;
    return { id: row.id, roomId: row.room_id, at: row.created_at, sequence: row.sequence, author: { kind: row.author_kind, id: row.author_id, name: row.author_name, ...agent, ...this.viaAuthor(row) },
      ...(system ? { system } : {}), ...this.agentMetadata(row), text: this.core.deps.content.get(row.content_ref)?.question ?? "", mentions: JSON.parse(row.mentions) as string[],
      ...(row.reply_to ? { replyTo: row.reply_to } : {}), ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      ...(row.stage ? { stage: row.stage } : {}), ...(row.answer_to ? { answerTo: row.answer_to } : {}), ...this.filesOf(row),
      ...this.core.atomic(db => { const a = this.agents.progress(db, row.id), b = this.assistant.progress(db, row.id);
        const total = (a?.total ?? 0)+(b?.total ?? 0), failed = (a?.failed ?? 0)+(b?.failed ?? 0), blocked = (a?.blocked ?? 0)+(b?.blocked ?? 0);
        const ask = a || b ? { total, answered: (a?.answered ?? 0)+(b?.answered ?? 0), working: (a?.working ?? 0)+(b?.working ?? 0), later: (a?.later ?? 0)+(b?.later ?? 0),
          ...(failed ? { failed } : {}), ...(blocked ? { blocked } : {}),
          ...(total === 1 && (failed === 1 || blocked === 1) && (a?.reason || b?.reason) ? { reason: (a?.reason || b?.reason)! } : {}) } : undefined;
        // The retained parent records who asked when the answer was queued. Do not infer from this viewer or the
        // delivery's owner: an agent can ask too, and an absent owner's via post uses its agent member as a fallback id.
        const asker = row.answer_to ? db.prepare(`SELECT p.author_id AS id FROM hub_room_posts p
          WHERE p.id=? AND p.room_id=? AND p.author_kind='person' AND NOT EXISTS
          (SELECT 1 FROM hub_room_agent_operations op WHERE op.post_id=p.id AND op.member_id=p.author_id)`)
          .get(row.answer_to, row.room_id) as { id: string } | undefined : undefined;
        const stopped = row.delivery_id && row.stage === "not-answered" ? db.prepare("SELECT 1 FROM hub_room_deliveries WHERE id=? AND reason_code='owner-stopped-sharing'").get(row.delivery_id) : null;
        const missing=row.delivery_id&&row.stage==="not-answered"?db.prepare("SELECT 1 FROM hub_room_deliveries WHERE id=? AND reason_code='finished-without-answer'").get(row.delivery_id):null;
        const lapsed = row.delivery_id && row.stage === "not-answered" ? db.prepare("SELECT 1 FROM hub_room_deliveries WHERE id=? AND reason_code='share-needs-reshare'").get(row.delivery_id) : null;
        const reactions = this.reactions(db, row.id), buttons = row.author_kind === "agent" ? this.buttons.view(db, row.id, id => this.memberName(db, id)) : undefined;
        return { ...(lapsed ? {reasonCode:"share-needs-reshare" as const} : {}), ...(missing?{reasonCode:"finished-without-answer" as const}:{}),...(stopped ? { reasonCode: "owner-stopped-sharing" as const } : {}), ...(ask ? { ask } : {}), ...(asker ? { askedBy: asker.id } : {}), ...(this.assistant.warning(db, row.id) ? { warning: "assistant-unavailable" as const } : {}), ...(reactions.length ? { reactions } : {}), ...(buttons ? { buttons } : {}) }; }) };
  }
  /** M-3127: a post's reactions, each emoji in the order it first appeared, its members in the order they reacted. */
  private reactions(db: DB, postId: string): NonNullable<RoomMessage["reactions"]> {
    const rows = db.prepare("SELECT emoji,member_id FROM hub_room_reactions WHERE post_id=? ORDER BY created_at,rowid").all(postId) as { emoji: string; member_id: string }[];
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.emoji, [...(out.get(r.emoji) ?? []), r.member_id]);
    return [...out].map(([emoji, members]) => ({ emoji, count: members.length, members }));
  }
  private filesStore(): HubAttachmentStore | undefined { return this.core.deps.attachments ?? undefined; }
  private store(): HubAttachmentStore { const s = this.filesStore(); if (!s) throw new HubProtocolError("incompatible"); return s; }
  /** M-3125: a post's files, in order (none when the Hub has no attachment store). */
  private filesOf(row: PostRow): { files?: GroupRoomFileView[] } {
    const store = this.filesStore(); if (!store) return {};
    const refs = this.core.atomic(db => [...store.forMessage(db, row.id, "question"), ...store.forMessage(db, row.id, "answer")]);
    return refs.length ? { files: refs.map(r => groupFileView(row.room_id, r)) } : {};
  }
  private viaAuthor(row: PostRow): { name?: string; via?: { id: string; name: string; kind: "app" | "agent" } } {
    return this.core.atomic(db => {
      const app = this.appPosts ? db.prepare("SELECT app_id,app_name FROM hub_mcp_room_posts WHERE post_id=?").get(row.id) as { app_id: string; app_name: string } | undefined : undefined;
      if(app)return {via:{id:app.app_id,name:app.app_name,kind:"app" as const}};
      const op = db.prepare("SELECT exposure_id,person_name,via_name FROM hub_room_agent_operations WHERE post_id=? AND receipt_id IS NOT NULL").get(row.id) as { exposure_id: string; person_name: string; via_name: string } | undefined;
      return op ? { name: op.person_name, via: { id: op.exposure_id, name: op.via_name,kind:"agent" as const } } : {}; });
  }
  private agentMetadata(row: PostRow): { proactive?: true; system?: RoomSystemEvent } {
    return this.core.atomic(db => {
      const stop = db.prepare("SELECT source_id,reason,name,retry_at FROM hub_room_agent_stops WHERE post_id=?").get(row.id) as { source_id: string; reason: "all" | "ambiguous" | "depth" | "rate" | "capacity"; name: string; retry_at: number | null } | undefined;
      if (stop) return { system: { kind: "agent-mention-stopped", reason: stop.reason, name: stop.name, sourceId: stop.source_id, ...(stop.retry_at !== null ? { retryAt: stop.retry_at } : {}) } };
      return db.prepare("SELECT 1 FROM hub_room_agent_operations WHERE post_id=? AND receipt_id IS NULL").get(row.id) ? { proactive: true } : {};
    });
  }
  private stop(db: DB, tx: HubTx, source: PostRow, reason: "all" | "ambiguous" | "depth" | "rate" | "capacity", name = source.author_name, retryAt?: number): void {
    const sourceAgent = (db.prepare("SELECT exposure_id FROM hub_room_agent_operations WHERE post_id=?").get(source.id) as { exposure_id: string } | undefined)?.exposure_id ?? source.author_id;
    const coalesce = reason === "rate" ? JSON.stringify(["rate", source.room_id, sourceAgent, Math.ceil(retryAt! / 60_000)]) : JSON.stringify([source.id, reason, name]);
    if (db.prepare("SELECT 1 FROM hub_room_agent_stops WHERE coalesce_key=?").get(coalesce)) return;
    const text = reason === "all" ? "Agents can't use @All agents. This message was not sent to other agents."
      : reason === "ambiguous" ? `More than one member is named "${name}", so this mention was not delivered.`
      : reason === "depth" ? "Agents have asked each other several times in a row, so this stops here. They can ask each other again after a person writes in the room."
      : reason === "capacity" ? "The Hub is busy, so this mention was not delivered."
      : `${name} is posting too often, so this mention was not delivered. It can try again after ${new Date(retryAt!).toISOString()}.`;
    const row = this.insert(db, tx, source.room_id, { kind: "system", id: "agent-mention-stopped", subject: "system", name }, text);
    if (source.sequence !== undefined) { const l = this.automation.lineage(db, source);
      db.prepare("INSERT INTO hub_room_post_lineage VALUES(?,?,?,?,NULL)").run(row.id, l.root_id, l.depth, l.audience_sequence); }
    db.prepare("INSERT INTO hub_room_agent_stops VALUES(?,?,?,?,?,?)").run(row.id, source.id, reason, name, retryAt ?? null, coalesce);
    countChainStop(db, reason, this.core.now());
    this.core.audit(tx, { requestId: source.id, actor: { kind: "person", person: personFromString(source.author_subject) }, action: "room.agent-mention-stopped", result: "completed", roomId: source.room_id, messageId: row.id, contentRef: row.content_ref });
  }
  /** Both answers and proactive posts use this transaction, once, before any external delivery. */
  /** The room's members by the names an @ can use: people (and their login), and agents whose owner still publishes them. */
  private mentionMembers(db: DB, roomId: string): MentionMember[] {
    return (db.prepare("SELECT * FROM hub_room_members WHERE room_id=?").all(roomId) as MemberRow[]).flatMap(m => {
      if (m.kind === "person") { const p = db.prepare("SELECT login_label FROM hub_people WHERE person=? UNION ALL SELECT login_label FROM hub_room_people WHERE person=? LIMIT 1").get(m.subject, m.subject) as { login_label: string } | undefined;
        return [{ ...m, name: this.name(db, m.subject), login: p?.login_label }]; }
      const e = m.kind === "agent" ? readExposure(db, m.subject) : undefined;
      return e && e.owner === m.owner_at_join ? [{ ...m, name: e.display_name }] : [];
    }) as MentionMember[];
  }
  private agentMentions(db: DB, tx: HubTx, post: PostRow): void {
    const operation = db.prepare("SELECT exposure_id,receipt_id FROM hub_room_agent_operations WHERE post_id=?").get(post.id) as { exposure_id: string; receipt_id: string | null } | undefined;
    const sourceId = operation?.exposure_id ?? post.author_id, onBehalf = !!operation?.receipt_id;
    const source = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=? AND owner_at_join=?").get(post.room_id, sourceId, post.author_subject) as MemberRow | undefined;
    if (!source) return;
    const members = this.mentionMembers(db, post.room_id);
    const resolved = resolveRoomMentions(this.core.deps.content.get(post.content_ref)?.question ?? "", members, onBehalf ? "" : sourceId), accepted: string[] = [],refusedPersonal:string[]=[];
    if (resolved.all && !onBehalf) this.stop(db, tx, post, "all");
    const targets = resolved.all && onBehalf ? members.filter(m => m.kind === "agent"
      && (readExposure(db,m.subject)?.source_kind!=="personal"||resolved.agents.includes(m.subject))).map(m => m.subject) : resolved.all ? [] : resolved.agents;
    for (const name of resolved.ambiguous) this.stop(db, tx, post, "ambiguous", name);
    for (const target of [...resolved.people, ...targets]) {
      const agent = targets.includes(target);
      if(agent&&readExposure(db,target)?.source_kind==="personal"&&!onBehalf){refusedPersonal.push(readExposure(db,target)!.display_name);continue;}
      const recipient = members.find(m => agent ? m.kind === "agent" && m.subject === target : m.kind === "person" && m.id === target);
      if (recipient && (db.prepare("SELECT joined_sequence FROM hub_room_members WHERE id=?").get(recipient.id) as { joined_sequence: number }).joined_sequence > this.automation.lineage(db, post).audience_sequence) continue;
      if (agent && (db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries WHERE state IN ('queued','sent')").get() as { n: number }).n + accepted.filter(id => targets.includes(id)).length >= 4096) { this.stop(db, tx, post, "capacity"); continue; }
      if (agent && this.automation.depth(db, post) >= 3) { this.stop(db, tx, post, "depth"); continue; }
      const retryAt = this.automation.admit(db, post.room_id, sourceId);
      if (retryAt !== null) { this.stop(db, tx, post, "rate", post.author_name, retryAt); break; }
      accepted.push(target);
    }
    if (resolved.all && onBehalf) accepted.push("all");
    recordPersonalMentionRefusals(this.core,db,tx,post,sourceId,[...new Set(refusedPersonal)]);
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
    const body = validated(roomMembersSchema, input);if(body.v2&&!link.features.has(HUB_ROOM_MEMBERS_CAPABILITY))throw new HubProtocolError("incompatible");
    const { source, fence } = await this.agentSource(body.exposureId, link); this.agentRead(source.owner);
    return this.core.atomic(db => {
      const rows = db.prepare(`SELECT r.id,r.name FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id WHERE m.kind='agent' AND m.subject=? AND m.owner_at_join=? AND r.archived=0 AND r.assistant_for IS NULL AND (r.id=? OR r.name=?) ORDER BY r.id LIMIT 201`).all(source.id, source.owner, body.room, body.room) as { id: string; name: string }[];
      const room = rows.find(r => r.id === body.room) ?? (rows.length === 1 ? rows[0] : undefined);
      if (!room) {const choices=rows.slice(0,200);if(body.v2)while(Buffer.byteLength(JSON.stringify({ok:false,code:"ambiguous-room",rooms:choices}))>8192)choices.pop();return rows.length?{ok:false,code:"ambiguous-room",rooms:choices}:{ok:false,code:"not-found"};}
      if(body.v2){
        const roomRow=this.room(db,room.id);
        const roster=(db.prepare("SELECT * FROM hub_room_members WHERE room_id=? ORDER BY kind,id").all(room.id) as MemberRow[]).map(m=>{
          if(m.kind==="assistant")return {id:"assistant",kind:"assistant" as const,name:"Hub assistant",presence:this.assistant.presence(room.id),intro:"Hub assistant. Answers from this room's chat.",mentionable:false as const};
          if(m.kind==="agent"){const e=readExposure(db,m.subject);return {id:m.subject,kind:m.kind,name:e?.display_name??m.subject,presence:this.agents.presence(m.subject).presence,owner:{name:this.name(db,m.owner_at_join??"")},intro:agentIntro(db,m.subject).intro};}
          // M-3594: a person's id is their stable Hub person id (realm/objectId, as a 1:1 question's asker id), not this
          // room's membership row, so an agent can tell one person apart across rooms and private questions.
          return {id:m.subject,kind:m.kind,name:this.name(db,m.subject),presence:db.prepare("SELECT 1 FROM hub_sessions WHERE person=? AND state='active' AND expires_at>?").get(m.subject,this.core.now())?"online":"offline"};
        });
        return pageRoomMembers(room.id,roomRow.purpose,roster,body,JSON.stringify([source.id,source.owner]));
      }
      const members = (db.prepare("SELECT * FROM hub_room_members WHERE room_id=? ORDER BY kind,id LIMIT 201").all(room.id) as MemberRow[]).map(m => {
        if (m.kind === "assistant") return { id: "assistant", kind: m.kind, name: "Hub assistant", presence: this.assistant.presence(room.id) };
        if (m.kind === "agent") { const e = readExposure(db, m.subject); return { id: m.subject, kind: m.kind, name: e?.display_name ?? m.subject, owner: { name: this.name(db, m.owner_at_join ?? "") }, ...this.agents.presence(m.subject) }; }
        return { id: m.subject, kind: m.kind, name: this.name(db, m.subject), presence: db.prepare("SELECT 1 FROM hub_sessions WHERE person=? AND state='active' AND expires_at>?").get(m.subject, this.core.now()) ? "online" : "offline" };
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
    if(body.direct||body.attachments)throw new HubProtocolError("incompatible");
    if(body.mentionFeedback&&!link.features.has(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY))throw new HubProtocolError("incompatible");
    const {mentionFeedback:_feedback,...operation}=body;
    const digest = createHash("sha256").update(JSON.stringify(operation)).digest("hex"); let added = false; let refusedEffects: string | undefined;
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
        const notice = prior ?? { id: `rate:${source.id}:${room.id}:${retryAt}`, room_id: room.id, author_id: source.id, author_name: source.display_name, author_subject: source.owner } as PostRow;
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
    if(result.ok&&body.mentionFeedback&&link.features.has(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY)){
      const mentionRefusals=personalMentionRefusals(this.core,result.messageId,body.exposureId);
      if(mentionRefusals)return {...result,mentionRefusals};
    }
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
  private recordPurpose(db:DB,tx:HubTx,id:string,me:string,purpose:string,requestId:string):PostRow{
    const name=this.name(db,me),text=purpose?`${name} set the purpose: ${purpose}`:`${name} cleared the purpose.`;
    const post=this.insert(db,tx,id,{kind:"system",id:"purpose-changed",subject:me,name},text);
    db.prepare("INSERT INTO hub_room_purpose_events VALUES(?,?)").run(post.id,purpose);
    this.core.audit(tx,{requestId,actor:{kind:"person",person:personFromString(me)},action:"room.purpose-changed",result:"completed",roomId:id,messageId:post.id,contentRef:post.content_ref});
    return post;
  }
  /** M-3533 R1: a manager turned the room office on or off — one line, as a purpose change has (§2.1). */
  private recordOffice(db: DB, tx: HubTx, id: string, me: string, enabled: boolean, requestId: string): PostRow {
    const name = this.name(db, me), text = `${name} turned the room office ${enabled ? "on" : "off"}.`;
    const post = this.insert(db, tx, id, { kind: "system", id: "office-changed", subject: me, name }, text);
    db.prepare("INSERT INTO hub_room_office_events VALUES(?,?)").run(post.id, Number(enabled));
    this.core.audit(tx, { requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.office-changed", result: "completed", roomId: id, messageId: post.id, contentRef: post.content_ref });
    return post;
  }
  /** M-3533 R1b: a manager changed the office's style — one line per save (§2.1b), the style by id. */
  private recordOfficeStyle(db: DB, tx: HubTx, id: string, me: string, style: string, requestId: string): PostRow {
    const name = this.name(db, me), text = `${name} changed the room office's style to "${style}"`;
    const post = this.insert(db, tx, id, { kind: "system", id: "office-style-changed", subject: me, name }, text);
    db.prepare("INSERT INTO hub_room_office_style_events VALUES(?,?)").run(post.id, style);
    this.core.audit(tx, { requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.office-style-changed", result: "completed", roomId: id, messageId: post.id, contentRef: post.content_ref });
    return post;
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
    const summary = { id: room.id, kind: "group" as const, name: room.name, purpose:room.purpose??"", people: counts.find(c => c.kind === "person")?.n ?? 0,
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
    const me = await this.who(ctx);
    let access: Awaited<ReturnType<typeof prepareRoomCreation>> | undefined;
    // A creation hint never becomes a new dependency of membership-based room reads.
    try { access = await prepareRoomCreation(this.core, ctx, me); } catch { /* Strict writes obtain a separate proof. */ }
    this.agents.sweep();
    return this.core.atomic(db => {
      if(!ctx.application)this.assistantRoom(db, me);
      let canCreateRooms = canCreateRoom(this.core, db, me);
      try { canCreateRooms ||= access?.allows(db) === true; } catch { /* Expired/changed hint: keep rooms readable. */ }
      return { rooms: (db.prepare("SELECT * FROM hub_room_members WHERE kind='person' AND subject=?").all(me) as MemberRow[])
        .map(m => this.summary(db, this.room(db, m.room_id), m)).sort((a, b) => b.lastAt - a.lastAt),
        me: { canCreateRooms, assistant: this.assistant.availability()?.enabled === true }, invitations: 0 };
    }, this.fence(ctx));
  }
  async candidates(ctx: HubRequestContext, q: string, kind: string, discovery = false) {
    if (q.length > 64 || /[\u0000-\u001f\u007f]/.test(q) || !["person", "team", "group", "agent"].includes(kind)) throw new HubProtocolError("invalid");
    const me = await this.who(ctx), access = await prepareRoomCreation(this.core, ctx, me,
      db => !!db.prepare(`SELECT 1 FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id
        WHERE m.kind='person' AND m.subject=? AND m.role='manager' AND r.archived=0`).get(me));
    const allowed = access.allows;
    if (kind === "agent") {
      this.core.atomic(db => { if (!allowed(db)) throw new HubRoomRefusal(403, "denied"); }, this.fence(ctx));
      const catalog = new HubCatalogService(this.core);
      return (discovery ? catalog.withRoomVisible.bind(catalog) : catalog.withVisible.bind(catalog))(ctx, view => {
        const hits = [...view.mine.map(e => ({ kind: "agent" as const, id: e.id, name: e.displayName, mine: true, owner: { name: this.core.atomic(db => this.name(db, me)) } })),
          ...view.askable.map(({ exposure: e, ownerName }) => ({ kind: "agent" as const, id: e.id, name: e.displayName, mine: false, owner: { name: ownerName } })),
          ...(view.findable ?? []).map(({ exposure: e, ownerName }) => ({ kind: "agent" as const, id: e.id, name: e.displayName, mine: false, discoverable: true, owner: { name: ownerName } }))]
          .filter(e => e.name.toLowerCase().startsWith(q.trim().toLowerCase())).slice(0, 20);
        this.fence(ctx).assertCurrent(); return this.core.atomic(db => {
          if (!allowed(db)) throw new HubRoomRefusal(403, "denied");
          return hits.map(row => ({ ...row, ...agentIntro(db, row.id) }));
      }, this.fence(ctx)); });
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
      return db.prepare("SELECT person,display_name,login_label FROM hub_people WHERE status='active' AND (display_name LIKE ? ESCAPE '\\' OR login_label LIKE ? ESCAPE '\\') ORDER BY display_name,person LIMIT 20")
        .all(prefix, prefix) as { person: string; display_name: string; login_label: string }[];
    }, this.fence(ctx));
    const hits: { id: string; name: string; account: string }[] = [];
    for (const row of rows) if (await this.core.eligible(personFromString(row.person))) hits.push({ id: row.person, name: row.display_name, account: row.login_label });
    return this.core.atomic(db => { if (!allowed(db)) throw new HubRoomRefusal(403, "denied");
      return kind === "team" ? (this.core.deps.roomTeamCandidates?.(db, q.trim()) ?? []).slice(0, 20).map(row => ({ kind: "team", ...row })) : roomPersonLabels(hits);
    }, this.fence(ctx));
  }
  private candidateAccess(ctx: HubRequestContext, me: string) {
    return prepareRoomCreation(this.core, ctx, me, db => !!db.prepare(`SELECT 1 FROM hub_room_members m JOIN hub_group_rooms r ON r.id=m.room_id
      WHERE m.kind='person' AND m.subject=? AND m.role='manager' AND r.archived=0 AND r.assistant_for IS NULL`).get(me));
  }
  private async groupSelection(ctx: HubRequestContext, me: string, id: string,
    prepared?: Awaited<ReturnType<typeof prepareRoomCreation>>) {
    const access = prepared ?? await this.candidateAccess(ctx, me);
    const assertCurrent = () => { this.fence(ctx).assertCurrent(); access.assertCurrent(); };
    try { return await this.directory.roster(ctx, me, id, assertCurrent); }
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
    const body = validated(createSchema, input), me = await this.who(ctx), access = await prepareRoomCreation(this.core, ctx, me);
    access.assertCurrent();
    const teams = this.core.deps.roomTeams;
    const expansion = (db: DB) => {
      if (!body.teams.length) return { teams: [], people: [], missing: [] };
      if (!teams || teams !== this.core.deps.roomTeams) throw new HubProtocolError("unavailable");
      const found = teams.expand(db, body.teams); if (found.missing.length) throw new HubProtocolError("invalid"); return found;
    };
    const selected = this.core.atomic(expansion), image = JSON.stringify(selected);
    const groupPeople: string[] = [];
    for (const group of new Set(body.groups)) groupPeople.push(...(await this.groupSelection(ctx, me, group, access)).people.map(p => p.id));
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
      if (!access.allows(db)) throw new HubRoomRefusal(403, "denied");
      rememberRoomPeople(db, selectedPeople, this.core.now());
      const id = randomUUID(); db.prepare("INSERT INTO hub_group_rooms(id,name,purpose,created_by,created_at,office_enabled) VALUES(?,?,?,?,?,?)").run(id, body.name, body.purpose, me, this.core.now(), newRoomOffice());
      for (const person of people) db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence) VALUES(?,?,'person',?,?,0)").run(randomUUID(), id, person, person === me ? "manager" : "member");
      this.insert(db, tx, id, { kind: "system", id: "room-created", subject: me, name: this.name(db, me) }, `${this.name(db, me)} created this room.`);
      for (const agent of body.agents) this.addAgentMember(db, tx, id, agent, me);
      if (body.assistant) this.addAssistant(db, id);
      if(body.purpose)this.recordPurpose(db,tx,id,me,body.purpose,ctx.requestId);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.created", result: "completed", roomId: id });
      return this.summary(db, this.room(db, id), this.member(db, id, me));
    }, { assertCurrent: () => { this.fence(ctx).assertCurrent(); access.assertCurrent(); for (const permit of permits) permit.assertCurrent(); } });
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
      // M-3533 R2a: each shared agent's look (its owner's catalog colour and emoji), each Fleet's catalog read once.
      const catalogs = new Map<string, Map<string, RoomOfficeLook> | null>();
      const lookOf = (fleetId: string, exposureId: string) => {
        if (!catalogs.has(fleetId)) catalogs.set(fleetId, this.looks ? this.looks(fleetId) : null);
        return catalogs.get(fleetId)?.get(exposureId) ?? null;
      };
      const members = (db.prepare("SELECT * FROM hub_room_members WHERE room_id=? ORDER BY kind,id").all(id) as MemberRow[]).map(m => {
        if (m.kind === "assistant") return { id: "assistant", kind: m.kind, name: "Hub assistant", role: m.role, presence: this.assistant.presence(id) };
        if (m.kind === "agent") { const e = readExposure(db, m.subject), look = memberLook(e?.fleet_id ? lookOf(e.fleet_id, m.subject) : null); return { id: m.subject, kind: m.kind, name: e?.display_name ?? m.subject, ...(look ? { look } : {}), ...agentIntro(db,m.subject), role: m.role,
          ...(e ? { agentKind: e.source_kind === "personal" ? "personal" as const : "fleet" as const } : {}),
          ...(e?.answer_only===1?{answerOnly:true}:{}), owner: { name: this.name(db, m.owner_at_join ?? ""), ...(m.owner_at_join ? { id: m.owner_at_join } : {}), ...(m.owner_at_join === me ? { mine: true } : {}) }, ...this.agents.presence(m.subject), canAsk: canAsk.has(m.subject) }; }
        return { id: m.id, kind: m.kind, name: this.name(db, m.subject), role: m.role,
          signedIn: !!db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(m.subject),
          presence: db.prepare("SELECT 1 FROM hub_sessions WHERE person=? AND state='active' AND expires_at>?").get(m.subject, this.core.now()) ? "online" : "offline" };
      });
      // M-3125: the room takes people's files when this Hub stores files (the 1:1 chat's own attachments-v1 mark).
      return { room: { ...this.summary(db, room, own), ...(this.filesStore() ? { features: ["attachments-v1"] } : {}) }, me: { id: own.id, role: own.role }, members,
        settings: { allMention: room.all_mention === 1, historyForNew: room.history_for_new,
          ...(this.appPosts?{aiApps:(db.prepare("SELECT enabled FROM hub_mcp_room_policy WHERE room_id=?").get(id) as {enabled:number}|undefined)?.enabled!==0}:{}),
          ...(members.some(m => m.kind === "assistant") ? { assistant: true } : {}),
          ...(this.office ? { office: { enabled: officeOn(room.office_enabled), style: room.office_style } } : {}) }, invited: [] };
    }, { assertCurrent: () => { this.fence(ctx).assertCurrent(); for (const proof of directProofs) proof.assertCurrent(); } });
  }
  async patch(ctx: HubRequestContext, id: string, input: unknown) {
    const body = validated(patchSchema, input), me = await this.who(ctx);
    if (body.office && !this.office) throw new HubProtocolError("invalid");
    const posts=this.core.atomic((db, tx) => {
      this.member(db, id, me, true); const row = this.room(db, id);
      if (row.assistant_for) throw new HubRoomRefusal(403, "denied");
      if (body.assistant === true) this.addAssistant(db, id);
      else if (body.assistant === false) db.prepare("DELETE FROM hub_room_members WHERE room_id=? AND kind='assistant'").run(id);
      const was = officeOn(row.office_enabled), office = body.office?.enabled === undefined ? row.office_enabled : Number(body.office.enabled);
      const style = body.office?.style ?? row.office_style;
      db.prepare("UPDATE hub_group_rooms SET name=?,purpose=?,all_mention=?,history_for_new=?,archived=?,office_enabled=?,office_style=? WHERE id=?")
        .run(body.name ?? row.name, body.purpose??row.purpose, body.allMention === undefined ? row.all_mention : Number(body.allMention), body.historyForNew ?? row.history_for_new, body.archived === undefined ? row.archived : Number(body.archived), office, style, id);
      const changed:PostRow[]=[];
      if(body.purpose!==undefined&&body.purpose!==row.purpose)changed.push(this.recordPurpose(db,tx,id,me,body.purpose,ctx.requestId));
      if(body.office?.enabled!==undefined&&body.office.enabled!==was)changed.push(this.recordOffice(db,tx,id,me,body.office.enabled,ctx.requestId));
      if(body.office?.style!==undefined&&body.office.style!==row.office_style)changed.push(this.recordOfficeStyle(db,tx,id,me,body.office.style,ctx.requestId));
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.updated", result: "completed", roomId: id });
      return changed;
    }, this.fence(ctx));
    if (body.archived || body.assistant === false) this.assistant.forget(id);
    this.agents.sweep(id);
    for(const post of posts)this.emit({type:"message.added",roomId:id,data:{roomId:id,message:this.projection(post)},sequence:post.sequence});
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
    const me = await this.who(ctx); this.agents.sweep(id); this.settleButtons();
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
    const files = body.files ?? [];
    const digest = createHash("sha256").update(JSON.stringify(files.length ? { text: body.text, mentions: body.mentions, replyTo: body.replyTo ?? null, files }
      : { text: body.text, mentions: body.mentions, replyTo: body.replyTo ?? null })).digest("hex");
    let added = false;
    const row = this.core.atomic((db, tx) => {
      const member = this.member(db, id, me), room = this.room(db, id);
      if (room.archived) throw new HubRoomRefusal(409, "archived");
      if(ctx.application && ((db.prepare("SELECT enabled FROM hub_mcp_room_policy WHERE room_id=?").get(id) as {enabled:number}|undefined)?.enabled===0
        || room.assistant_for || body.mentions.includes("all") || body.mentions.includes("assistant") || /@all\b/iu.test(body.text))) throw new HubRoomRefusal(403,"denied");
      if (body.mentions.includes("all") && !room.all_mention && member.role !== "manager") throw new HubRoomRefusal(403, "all-mention-off");
      const old = db.prepare("SELECT * FROM hub_room_posts WHERE room_id=? AND author_subject=? AND idempotency_key=?").get(id, me, body.idempotencyKey) as PostRow | undefined;
      if (old) { if (old.digest !== digest || old.sequence < member.joined_sequence) throw new HubRoomRefusal(409, "conflict"); return old; }
      if (body.replyTo && !db.prepare("SELECT 1 FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(body.replyTo, id, member.joined_sequence)) throw new HubRoomRefusal(404, "not-found");
      const refs = files.length ? this.store().pending(db, id, me, files) : [];
      // M-3298: an "@Name" a person types reminds that person (the room list's @, their page's ping). The Hub alone says who:
      // the people the text names, resolved as an agent post's are (agentMentions) — not oneself; an ambiguous name, code and
      // email addresses are no one (mentions.ts). Of what the page sent only what routes is kept (@all, the assistant, the
      // room's agents): a person id in it is never taken on trust (#4132 review F1: a page's pick of one of two same-named
      // people, or a crafted id the text does not name, would remind someone the text did not).
      const agentIds = new Set((db.prepare("SELECT subject FROM hub_room_members WHERE room_id=? AND kind='agent'").all(id) as { subject: string }[]).map(m => m.subject));
      const routed = body.mentions.filter(m => m === "all" || m === "assistant" || agentIds.has(m));
      const people = resolveRoomMentions(body.text, this.mentionMembers(db, id), "").people.filter(p => p !== member.id);
      const post = this.insert(db, tx, id, { kind: "person", id: member.id, subject: me, name: this.name(db, me) }, body.text, [...new Set([...routed, ...people])], body.idempotencyKey, digest, body.replyTo ?? null);
      if(ctx.application)db.prepare("INSERT INTO hub_mcp_room_posts VALUES(?,?,?)").run(post.id,ctx.application.id,ctx.application.name);
      if (refs.length) this.store().bindPost(db, refs, post.id);
      if(ctx.application){if(!this.core.deps.content.bindMessage)throw new HubProtocolError("unavailable");this.core.deps.content.bindMessage(tx,post.content_ref,post.id);}
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.message", result: "completed", roomId: id, messageId: post.id, ...(ctx.application?{}:{contentRef: post.content_ref}) });
      this.automation.human(db, post);
      this.agents.enqueue(db, tx, { ...post, mentions: JSON.stringify(body.mentions.filter(m => m !== "assistant")) }, member.id,
        ctx.application?{asker:me,name:`${post.author_name} via ${ctx.application.name}`,text:body.text}:undefined);
      if(!ctx.application)this.assistant.enqueue(db, tx, post, member.id, room.assistant_for !== null);
      added = true; return post;
    }, this.fence(ctx));
    const message = this.projection(row);
    if (added) { this.emit({ type: "message.added", roomId: id, data: { roomId: id, message }, sequence: row.sequence }); this.emit({ type: "unread.changed", roomId: id, data: { roomId: id } }); }
    if (added) { this.agents.publishQueued(row.id); this.assistant.publishQueued(row.id); }
    this.agents.wake(); this.assistant.wake(); return message;
  }
  /** A quiet, coalesced line after the third rejected app post; no question or agent delivery. */
  async appRateLimited(ctx:HubRequestContext,id:string):Promise<void> {
    if(!ctx.application)throw new HubProtocolError("denied");
    const me=await this.who(ctx);
    const post=this.core.atomic((db,tx)=>{
      this.member(db,id,me);if(this.room(db,id).archived)return null;
      const now=this.core.now(),window=Math.floor(now/60_000)*60_000;
      db.prepare("DELETE FROM hub_mcp_rate_notices WHERE person=? AND window<?").run(me,now-60*60_000);
      db.prepare("INSERT INTO hub_mcp_rate_notices VALUES(?,?,?,1,NULL) ON CONFLICT(person,room_id,window) DO UPDATE SET refused=refused+1").run(me,id,window);
      const notice=db.prepare("SELECT refused,post_id FROM hub_mcp_rate_notices WHERE person=? AND room_id=? AND window=?").get(me,id,window) as {refused:number;post_id:string|null};
      if(notice.refused!==3||notice.post_id)return null;
      const name=this.name(db,me),row=this.insert(db,tx,id,{kind:"system",id:"app-rate-limited",subject:me,name},`${name}'s AI app was slowed down.`);
      db.prepare("UPDATE hub_mcp_rate_notices SET post_id=? WHERE person=? AND room_id=? AND window=?").run(row.id,me,id,window);return row;
    },this.fence(ctx));
    if(post)this.emit({type:"message.added",roomId:id,data:{roomId:id,message:this.projection(post)},sequence:post.sequence});
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
      const post = this.visiblePost(db, id, member, target);
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
  /**
   * M-3340: the signed-in person's own pins in a group room — newest first, each with the message as messages() shows it to
   * them now. A pin whose message they can no longer see (it is older than their joining, or its question is not theirs)
   * is left out. Nobody else's pins are ever read, and nobody else learns of these.
   */
  /**
   * M-3533 R1: the room's office for a member (office.ts roomOfficeView): its agents and assistant, each in the state the
   * member list shows, "answering" while the Hub waits on its answer to a question asked here. 409 office-off when a
   * manager turned it off; a 1:1 assistant chat has none.
   */
  async officeState(ctx: HubRequestContext, id: string) {
    if (!this.office) throw new HubRoomRefusal(404, "not-found");
    const me = await this.who(ctx); this.agents.sweep(id);
    return this.core.atomic(db => {
      this.member(db, id, me); const room = this.room(db, id);
      if (room.assistant_for) throw new HubRoomRefusal(404, "not-found");
      if (!officeOn(room.office_enabled)) throw new HubRoomRefusal(409, "office-off");
      // What a message's progress says (agents.ts), so the two never disagree; a wait that ran out was settled by the sweep above.
      const answering = this.agents.answering(db, id);
      // R2a: each Fleet's catalog read once (it is the owner's latest, kept by the Hub: there when the Fleet is offline).
      const catalogs = new Map<string, Map<string, RoomOfficeLook> | null>();
      const lookOf = (fleetId: string, exposureId: string) => {
        if (!catalogs.has(fleetId)) catalogs.set(fleetId, this.looks ? this.looks(fleetId) : null);
        return catalogs.get(fleetId)?.get(exposureId) ?? null;
      };
      const agents = (db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind IN ('agent','assistant') ORDER BY kind,id").all(id) as MemberRow[]).map(m => {
        if (m.kind === "assistant") { const p = this.assistant.presence(id); return officeAgent("assistant", "Hub assistant", p, p === "working", true); }
        const e = readExposure(db, m.subject), p = this.agents.presence(m.subject).presence as RoomPresence;
        return withLook(officeAgent(m.subject, e?.display_name ?? m.subject, p, answering.has(m.subject)), e?.fleet_id ? lookOf(e.fleet_id, m.subject) : null);
      });
      return roomOfficeView({ name: room.name, style: room.office_style }, agents, this.core.now());
    }, this.fence(ctx));
  }
  async pins(ctx: HubRequestContext, id: string): Promise<{ pins: Array<{ messageId: string; pinnedAt: number; message: RoomMessage }> }> {
    const me = await this.who(ctx);
    return this.core.atomic(db => ({ pins: this.pinList(db, id, this.member(db, id, me), me) }), this.fence(ctx));
  }
  /** M-3340: pin (on) or unpin a message the person can see; answers with their pins. Past ROOM_PINS_MAX: 409 pins-full. */
  async pin(ctx: HubRequestContext, id: string, postId: unknown, on: boolean) {
    const target = validated(uuid, postId), me = await this.who(ctx);
    const out = this.core.atomic(db => {
      const member = this.member(db, id, me);
      if (on) {
        const post = this.visiblePost(db, id, member, target);
        if (post.author_kind === "system") throw new HubRoomRefusal(409, "invalid");
        const has = db.prepare("SELECT 1 FROM hub_room_pins WHERE room_id=? AND person=? AND post_id=?").get(id, me, post.id);
        if (!has && (db.prepare("SELECT COUNT(*) n FROM hub_room_pins WHERE room_id=? AND person=?").get(id, me) as { n: number }).n >= ROOM_PINS_MAX) throw new HubRoomRefusal(409, "pins-full");
        if (!has) db.prepare("INSERT INTO hub_room_pins(room_id,person,post_id,pinned_at) VALUES(?,?,?,?)").run(id, me, post.id, this.core.now());
      } else db.prepare("DELETE FROM hub_room_pins WHERE room_id=? AND person=? AND post_id=?").run(id, me, target);
      return { pins: this.pinList(db, id, member, me) };
    }, this.fence(ctx));
    // The person's other tabs and devices read their pins again; the event says only which room.
    this.emit({ type: "pins.changed", roomId: id, data: { roomId: id }, audiencePerson: me });
    return out;
  }
  private pinList(db: DB, id: string, member: MemberRow, me: string) {
    const rows = db.prepare("SELECT post_id,pinned_at FROM hub_room_pins WHERE room_id=? AND person=? ORDER BY pinned_at DESC,rowid DESC").all(id, me) as { post_id: string; pinned_at: number }[];
    const out: Array<{ messageId: string; pinnedAt: number; message: RoomMessage }> = [];
    for (const row of rows) {
      let post: PostRow;
      try { post = this.visiblePost(db, id, member, row.post_id); } catch { continue; }
      out.push({ messageId: row.post_id, pinnedAt: row.pinned_at, message: this.projection(post) });
    }
    return out;
  }
  /**
   * M-3127: a post exactly as messages() shows it to `member` — since their joined_sequence, its lineage's audience floor
   * too (Ridge, M-3118: the descendants of a question older than them stay hidden), and an answer only when its question
   * is theirs to see. 404 otherwise.
   */
  private visiblePost(db: DB, roomId: string, member: MemberRow, postId: string): PostRow {
    const post = db.prepare("SELECT * FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=? AND COALESCE((SELECT audience_sequence FROM hub_room_post_lineage l WHERE l.post_id=hub_room_posts.id),sequence)>=?")
      .get(postId, roomId, member.joined_sequence, member.joined_sequence) as PostRow | undefined;
    if (!post || post.answer_to && !db.prepare("SELECT 1 FROM hub_room_posts WHERE id=? AND room_id=? AND sequence>=?").get(post.answer_to, roomId, member.joined_sequence)) throw new HubRoomRefusal(404, "not-found");
    return post;
  }
  /** M-3127: a member's name as the room shows it (a person's display name, an agent's exposure name, the assistant). */
  private memberName(db: DB, memberId: string): string {
    const m = db.prepare("SELECT * FROM hub_room_members WHERE id=?").get(memberId) as MemberRow | undefined;
    if (!m) return "";
    if (m.kind === "person") return this.name(db, m.subject);
    if (m.kind === "assistant") return "Room assistant";
    return readExposure(db, m.subject)?.display_name ?? "";
  }
  /**
   * M-3127 B: press an answer's button, or vote in its poll (the direct chat's body: { setId, index | options,
   * idempotencyKey }). Plain buttons: the question's asker only (403 not-asker), the first press wins, and it becomes the
   * asker's own room message — the button's label, replying to the answer, to that agent — delivered by the ordinary room
   * ask (the agent gets the click line). Polls: every person who can see it; a later vote replaces mine until it closes.
   */
  async click(ctx: HubRequestContext, id: string, input: unknown): Promise<{ ok: true }> {
    const body = validated(clickSchema, input), me = await this.who(ctx);
    this.settleButtons();
    const done = this.core.atomic((db, tx) => {
      const member = this.member(db, id, me);
      if (this.room(db, id).archived) throw new HubRoomRefusal(409, "archived");
      const row = this.buttons.row(db, body.setId);
      if (!row || row.room_id !== id) throw new HubRoomRefusal(404, "not-found");
      const answer = this.visiblePost(db, id, member, row.post_id), b = this.buttons.choices(row);
      if (!b) throw new HubRoomRefusal(409, "expired");
      let picked: number[];
      if (b.poll) {
        const o = body.options;
        if (body.index !== undefined || !o || o.some(i => i >= b.labels.length) || new Set(o).size !== o.length || !b.poll.multi && o.length !== 1) throw new HubProtocolError("invalid");
        picked = [...o].sort((x, y) => x - y);
      } else {
        if (body.options !== undefined || body.index === undefined || body.index >= b.labels.length) throw new HubProtocolError("invalid");
        picked = [body.index];
      }
      const digest = createHash("sha256").update(JSON.stringify([body.setId, !!b.poll, picked])).digest("hex");
      const dup = db.prepare("SELECT set_id,digest FROM hub_room_button_operations WHERE room_id=? AND member_id=? AND idempotency_key=?").get(id, member.id, body.idempotencyKey) as { set_id: string; digest: string } | undefined;
      if (dup) { if (dup.set_id !== body.setId || dup.digest !== digest) throw new HubRoomRefusal(409, "conflict"); return { answer, click: null as PostRow | null, changed: false }; }
      if (row.state !== "open" || this.core.now() >= row.expires_at) throw new HubRoomRefusal(409, "expired");
      let click: PostRow | null = null;
      if (!b.poll) {
        if (row.asker_member !== member.id) throw new HubRoomRefusal(403, "not-asker");
        const i = picked[0]!, label = b.labels[i]!, value = b.values?.[i] ?? label, name = this.name(db, me);
        // One click per set, whatever the browser's key: the set's own key makes a second press a conflict, not a post.
        const key = setKey(body.setId), clickDigest = createHash("sha256").update(JSON.stringify({ text: label, mentions: [answer.author_id], replyTo: answer.id })).digest("hex");
        click = this.insert(db, tx, id, { kind: "person", id: member.id, subject: me, name }, label, [answer.author_id], key, clickDigest, answer.id);
        this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "room.message", result: "completed", roomId: id, messageId: click.id, contentRef: click.content_ref });
        this.automation.human(db, click);
        if (db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(id, answer.author_id))
          this.agents.enqueue(db, tx, click, member.id, { asker: me, name, text: replyButtonClickText({ label, value }) });
        db.prepare("UPDATE hub_room_buttons SET state='chosen',chosen_index=?,chosen_member=?,closed_at=?,revision=revision+1 WHERE id=? AND state='open'").run(i, member.id, this.core.now(), row.id);
      } else {
        db.prepare("INSERT INTO hub_room_votes(set_id,member_id,options,at) VALUES(?,?,?,?) ON CONFLICT(set_id,member_id) DO UPDATE SET options=excluded.options,at=excluded.at")
          .run(row.id, member.id, JSON.stringify(picked), this.core.now());
        db.prepare("UPDATE hub_room_buttons SET revision=revision+1 WHERE id=?").run(row.id);
      }
      db.prepare("INSERT INTO hub_room_button_operations VALUES(?,?,?,?,?)").run(id, member.id, body.idempotencyKey, body.setId, digest);
      return { answer, click, changed: true };
    }, this.fence(ctx));
    if (done.changed) this.emit({ type: "message.updated", roomId: id, data: { roomId: id, message: this.projection(done.answer) }, sequence: done.answer.sequence });
    if (done.click) {
      this.emit({ type: "message.added", roomId: id, data: { roomId: id, message: this.projection(done.click) }, sequence: done.click.sequence });
      this.emit({ type: "unread.changed", roomId: id, data: { roomId: id } });
      this.agents.publishQueued(done.click.id); this.agents.wake();
    }
    return { ok: true };
  }
  /** M-3127 B: the next open set's deadline, once; closes what is due and arms again (30 s after a failure). */
  private armButtons(delay?: number): void {
    if (this.buttonsClosed || !this.core.live()) return;
    if (this.buttonsTimer) clearTimeout(this.buttonsTimer);
    let wait = delay;
    if (wait === undefined) {
      const next = this.core.atomic(db => this.buttons.nextDeadline(db));
      if (next === null) { this.buttonsTimer = null; return; }
      wait = Math.max(0, next - this.core.now());
    }
    this.buttonsTimer = setTimeout(() => { this.buttonsTimer = null; try { this.closeDueButtons(); this.armButtons(); } catch { this.armButtons(30_000); } }, Math.min(wait, 2 ** 31 - 1));
    this.buttonsTimer.unref?.();
  }
  /**
   * M-3127 B: sets past their deadline. Buttons expire. A poll closes: one room line (「投票結束」, in the poll's lineage —
   * Ridge: a system consequence, never a fresh human root) and the results delivered to the agent that asked it, on behalf
   * of that question's asker (the Fleet chat's [poll results]).
   */
  private closeDueButtons(): void {
    if (this.buttonsClosed || !this.core.live()) return;
    const out = this.core.atomic((db, tx) => {
      const changed: { answer: PostRow; line: PostRow | null }[] = [];
      for (const row of this.buttons.due(db)) {
        const b = this.buttons.choices(row), now = this.core.now();
        const answer = db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(row.post_id) as PostRow | undefined;
        if (!b?.poll || !answer) { db.prepare("UPDATE hub_room_buttons SET state='expired',closed_at=?,revision=revision+1 WHERE id=? AND state='open'").run(now, row.id); if (answer) changed.push({ answer, line: null }); continue; }
        db.prepare("UPDATE hub_room_buttons SET state='closed',closed_at=?,revision=revision+1 WHERE id=? AND state='open'").run(now, row.id);
        const votes = this.buttons.votes(db, row.id);
        const ballots: PollBallot[] = votes.map(v => ({ voter: v.member_id, name: this.memberName(db, v.member_id), options: v.options, at: v.at }));
        const text = pollResultsText({ id: row.id, buttons: b.labels.map((label, i) => ({ label, value: b.values?.[i] ?? label })), createdAt: row.created_at, expiresAt: row.expires_at }, b.poll, ballots, now);
        // The room line says only that it closed (counts are on the poll; names only with showVoters, on the poll too).
        const line = this.insert(db, tx, row.room_id, { kind: "system", id: "poll-closed", subject: "system", name: answer.author_name }, `Poll closed · ${votes.length} voted`);
        const l = this.automation.lineage(db, answer);
        db.prepare("INSERT INTO hub_room_post_lineage VALUES(?,?,?,?,NULL)").run(line.id, l.root_id, l.depth, l.audience_sequence);
        db.prepare("UPDATE hub_room_buttons SET result_post=? WHERE id=?").run(line.id, row.id);
        const d = db.prepare("SELECT asker,asker_member FROM hub_room_deliveries WHERE id=?").get(row.delivery_id) as { asker: string; asker_member: string } | undefined;
        const room = this.room(db, row.room_id);
        const agentHere = db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(row.room_id, answer.author_id);
        const askerHere = d && db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=?").get(d.asker_member, row.room_id);
        if (d && agentHere && askerHere && !room.archived)
          this.agents.enqueue(db, tx, { ...line, mentions: JSON.stringify([answer.author_id]) }, d.asker_member, { asker: d.asker, name: "Poll results", text });
        this.core.audit(tx, { requestId: row.id, actor: { kind: "local-host" }, action: "room.poll-closed", result: "completed", roomId: row.room_id, messageId: line.id, contentRef: line.content_ref });
        changed.push({ answer, line });
      }
      return changed;
    });
    for (const { answer, line } of out) {
      this.emit({ type: "message.updated", roomId: answer.room_id, data: { roomId: answer.room_id, message: this.projection(answer) }, sequence: answer.sequence });
      if (line) { this.emit({ type: "message.added", roomId: line.room_id, data: { roomId: line.room_id, message: this.projection(line) }, sequence: line.sequence }); this.agents.publishQueued(line.id); }
    }
    if (out.some(x => x.line)) this.agents.wake();
  }
  /**
   * M-3127 (agent reactions, on room-answer-buttons-v1): an agent's reaction (its `react`) to the room question it was asked — only on that delivery's
   * own question, from the Fleet and owner it went to, while the agent is still in the room. One reaction per agent and
   * post (a later one replaces it; "" takes it back), stored under the agent's membership; the post as it now is goes out
   * on the room stream (message.updated).
   */
  async agentReact(input: import("../types.js").HubRoomReact, link: import("../server.js").HubLinkContext): Promise<import("../types.js").HubRoomReactResult> {
    const body = validated(roomReactSchema, input);
    if (body.emoji !== "" && !validRoomEmoji(body.emoji)) throw new HubProtocolError("invalid");
    if (!link.current() || !link.features.has(HUB_ROOM_REACT_CAPABILITY)) throw new HubProtocolError("revoked");
    const done = this.core.atomic(db => {
      const d = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(body.messageId) as { room_id: string; parent_id: string; exposure_id: string; fleet_id: string; owner: string; agent_member: string } | undefined;
      if (!d || d.fleet_id !== link.fleetId || d.owner !== personKeyString(link.owner) || d.room_id !== body.roomId || d.exposure_id !== body.exposureId) throw new HubProtocolError("denied");
      const room = this.room(db, d.room_id);
      if (room.archived) return { post: null, changed: false, archived: true };   // a result, never a broken member link
      if (!db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=? AND kind='agent' AND subject=?").get(d.agent_member, d.room_id, d.exposure_id)) throw new HubProtocolError("revoked");
      const post = db.prepare("SELECT * FROM hub_room_posts WHERE id=? AND room_id=?").get(d.parent_id, d.room_id) as PostRow | undefined;
      if (!post) throw new HubProtocolError("not-found");
      // Under the agent as the room lists it (its exposure id: the members panel's id for an agent), so the page can name it.
      const who = d.exposure_id;
      const had = db.prepare("SELECT emoji FROM hub_room_reactions WHERE post_id=? AND member_id=?").all(post.id, who) as { emoji: string }[];
      if (had.length === (body.emoji ? 1 : 0) && (!body.emoji || had[0]!.emoji === body.emoji)) return { post, changed: false };
      if (body.emoji && !had.some(r => r.emoji === body.emoji)
        && (db.prepare("SELECT COUNT(DISTINCT emoji) n FROM hub_room_reactions WHERE post_id=? AND member_id<>?").get(post.id, who) as { n: number }).n >= ROOM_REACTION_LIMIT
        && !(db.prepare("SELECT 1 FROM hub_room_reactions WHERE post_id=? AND emoji=?").get(post.id, body.emoji))) throw new HubProtocolError("invalid");
      db.prepare("DELETE FROM hub_room_reactions WHERE post_id=? AND member_id=?").run(post.id, who);
      if (body.emoji) db.prepare("INSERT INTO hub_room_reactions(room_id,post_id,member_id,emoji,created_at) VALUES(?,?,?,?,?)").run(d.room_id, post.id, who, body.emoji, this.core.now());
      return { post, changed: true };
    });
    if ("archived" in done) return { messageId: body.messageId, ok: false, code: "archived" };
    if (done.changed && done.post) this.emit({ type: "message.updated", roomId: done.post.room_id, data: { roomId: done.post.room_id, message: this.projection(done.post) }, sequence: done.post.sequence });
    return { messageId: body.messageId, ok: true };
  }
  /** A read or a press first closes what is already due (a suspended host's timer may be late): never a stale open poll. */
  private settleButtons(): void {
    const next = this.core.atomic(db => this.buttons.nextDeadline(db));
    if (next !== null && next <= this.core.now()) { this.closeDueButtons(); this.armButtons(); }
  }
  /**
   * M-3127 C: messages with these words in the group rooms I am in, newest first — exactly what messages() would show me
   * (since my joined_sequence, the lineage floor, answered rows only, no room lines). The text is encrypted at rest and
   * retention deletes it, so there is no plaintext index: a bounded scan (ROOM_SEARCH_SCAN posts a request), and `cursor`
   * when more remain ("search older messages"). Every word must appear (NFKC, case-folded). ROOM_SEARCH_PER_MINUTE each.
   */
  async search(ctx: HubRequestContext, q: unknown, limit: unknown = 20, cursor: unknown = null) {
    const query = typeof q === "string" ? q.trim() : "", n = typeof limit === "number" ? limit : Number(limit);
    const terms = [...new Set(fold(query).split(/\s+/).filter(Boolean))].slice(0, 8);
    if (query.length < 1 || query.length > 100 || !terms.length || !Number.isSafeInteger(n) || n < 1 || n > ROOM_SEARCH_LIMIT) throw new HubProtocolError("invalid");
    let after: { at: number; id: string } | null = null;
    if (cursor !== null && cursor !== undefined && cursor !== "") {
      const c = typeof cursor === "string" ? /^(\d{1,15})\.([a-f0-9-]{36})$/.exec(cursor) : null;
      if (!c) throw new HubProtocolError("invalid");
      after = { at: Number(c[1]), id: c[2]! };
    }
    const me = await this.who(ctx);
    // A search reads and decrypts up to ROOM_SEARCH_SCAN posts on the event loop: at most ROOM_SEARCH_PER_MINUTE a minute
    // each (429 busy, the page says to try again in a moment). One person's map entry; old times drop on every call.
    const now = this.core.now(), recent = (this.searches.get(me) ?? []).filter(t => t > now - 60_000);
    if (recent.length >= ROOM_SEARCH_PER_MINUTE) { this.searches.set(me, recent); throw new HubRoomRefusal(429, "busy"); }
    this.searches.set(me, [...recent, now]);
    if (this.searches.size > 10_000) for (const [k, v] of this.searches) if (!v.some(t => t > now - 60_000)) this.searches.delete(k);
    {
      return this.core.atomic(db => {
        const rows = db.prepare(`SELECT p.*,r.name AS room_name FROM hub_room_posts p
          JOIN hub_room_members m ON m.room_id=p.room_id AND m.kind='person' AND m.subject=?
          JOIN hub_group_rooms r ON r.id=p.room_id
          WHERE p.sequence>=m.joined_sequence AND COALESCE((SELECT audience_sequence FROM hub_room_post_lineage l WHERE l.post_id=p.id),p.sequence)>=m.joined_sequence
            AND p.author_kind<>'system' AND (p.stage IS NULL OR p.stage='answered')
            AND (p.answer_to IS NULL OR EXISTS(SELECT 1 FROM hub_room_posts o WHERE o.id=p.answer_to AND o.sequence>=m.joined_sequence))
            AND (? IS NULL OR p.created_at<? OR p.created_at=? AND p.id<?)
          ORDER BY p.created_at DESC,p.id DESC LIMIT ?`).all(me, after?.at ?? null, after?.at ?? 0, after?.at ?? 0, after?.id ?? "", ROOM_SEARCH_SCAN) as (PostRow & { room_name: string })[];
        const hits: { roomId: string; roomName: string; messageId: string; sequence: number; at: number; author: { kind: string; name: string }; snippet: string; marks: [number, number][] }[] = [];
        let last: PostRow | null = null;
        for (const row of rows) {
          last = row;
          const text = this.core.deps.content.get(row.content_ref)?.question;
          if (!text) continue;   // retention removed it
          const lower = fold(text);
          if (!terms.every(t => lower.includes(t))) continue;
          const author = this.projection(row).author;
          hits.push({ roomId: row.room_id, roomName: row.room_name, messageId: row.id, sequence: row.sequence, at: row.created_at,
            author: { kind: author.kind, name: author.name }, ...searchSnippet(text, terms) });
          if (hits.length >= n) break;
        }
        const more = !!last && (hits.length >= n ? last !== rows[rows.length - 1] || rows.length === ROOM_SEARCH_SCAN : rows.length === ROOM_SEARCH_SCAN);
        return { hits, ...(more && last ? { cursor: `${last.created_at}.${last.id}` } : {}) };
      }, this.fence(ctx));
    }
  }
  /** M-3125: before any upload body is read — a member of a room that is not archived, and room in their pending budget. */
  async uploadAdmit(ctx: HubRequestContext, id: string, declaredBytes: number): Promise<void> {
    const me = await this.who(ctx), store = this.store();
    this.core.atomic(db => { this.member(db, id, me); if (this.room(db, id).archived) throw new HubRoomRefusal(409, "archived"); store.admit(db, { uploader: me }, declaredBytes); }, this.fence(ctx));
  }
  /** M-3125: a member's file for a later post in this room, pending one hour (as in a 1:1 chat). */
  async upload(ctx: HubRequestContext, id: string, name: string, bytes: Buffer): Promise<GroupRoomFileView> {
    const me = await this.who(ctx), store = this.store();
    return this.core.atomic((db, tx) => {
      this.member(db, id, me); if (this.room(db, id).archived) throw new HubRoomRefusal(409, "archived");
      const ref = store.createUpload(db, { roomId: id, uploader: me, name, bytes });
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "file.upload", result: "allowed",
        reasonCode: `question:${ref.size}:${ref.mime}:${ref.sha256}`, contentRef: this.core.deps.content.put(tx, { question: ref.name }), roomId: id });
      return groupFileView(id, ref);
    }, this.fence(ctx));
  }
  /**
   * M-3125: one of this room's files, for a current member: a file on a post they can see (at or after their join floor, the
   * room's history rule) or their own pending upload. Every read is audited.
   */
  async download(ctx: HubRequestContext, id: string, fileId: string): Promise<{ name: string; mime: string; image: boolean; bytes: Buffer }> {
    const me = await this.who(ctx), store = this.store(), now = this.core.now();
    return this.core.atomic((db, tx) => {
      const member = this.member(db, id, me), row = store.row(db, fileId);
      if (!row || row.room_id !== id) throw new HubProtocolError("not-found");
      // The listing's own visibility rule (Ridge, M-3118): the post at or after the floor, its lineage's audience at or after it, and the
      // post it answers too — a chained answer after a viewer joined does not reveal a hidden question's files, nor its own.
      const visible = row.state === "bound" && !!row.message_id && !!db.prepare(`SELECT 1 FROM hub_room_posts p WHERE p.id=? AND p.room_id=? AND p.sequence>=?
        AND (p.stage IS NULL OR p.stage='answered')
        AND COALESCE((SELECT audience_sequence FROM hub_room_post_lineage l WHERE l.post_id=p.id),p.sequence)>=?
        AND (p.answer_to IS NULL OR EXISTS(SELECT 1 FROM hub_room_posts o WHERE o.id=p.answer_to AND o.sequence>=?))`).get(row.message_id, id, member.joined_sequence, member.joined_sequence, member.joined_sequence);
      const own = row.state === "pending" && row.uploader === me && (row.expires_at ?? 0) > now;
      if (!own && !visible) throw new HubProtocolError("not-found");
      const bytes = store.read(db, row.sha256);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: personFromString(me) }, action: "file.read", result: "allowed",
        reasonCode: `${row.direction}:${row.size}:${row.mime}:${row.sha256}`, ...(row.message_id ? { messageId: row.message_id } : {}), roomId: id });
      return { name: row.name, mime: row.mime, image: isInlineImage(row.mime), bytes };
    }, this.fence(ctx));
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
