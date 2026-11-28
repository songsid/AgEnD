import { HUB_ROOM_REACT_ACK_CAPABILITY } from "../room-react-ack-model.js";
import {roomDeliveryAsker} from "./asker-identity.js";
import {HUB_ROOM_ASKER_IDENTITY_CAPABILITY,ROOM_ASKER_FRESH_MS,ROOM_ASKER_RETENTION_MS} from "../room-asker-identity-model.js";
import {roomAskIdentityDigest} from "../room-asker-identity.js";
import {HUB_ROOM_ANSWER_STATUS_CAPABILITY} from "../room-answer-status-model.js";
import {HUB_ROOM_BRIEF_CAPABILITY} from "../room-brief-model.js";
import {roomRoster,previousRoster,buildRoomBrief,confirmRoomBrief} from "./brief.js";
/** Durable group-room deliveries. Room consent is separate from one-to-one grants. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { exposureOf, readExposure } from "../catalog.js";
import { personFromString, type HubCore } from "../http/core.js";
import { personKeyString } from "../identity.js";
import { HUB_LIMITS, HUB_ROOM_ASK_CAPABILITY, HUB_ROOM_BUTTONS_CAPABILITY, roomAskSchema, roomFilesNegotiated, roomAnswerSchema, agentStateSchema } from "../protocol.js";
import type { HubLinkContext } from "../server.js";
import type { HubAgentState, HubAnswerButtons, HubAttachmentChunk, HubAttachmentRef, HubRoomAsk, HubRoomAnswer, HubRoomAnswerAck, HubTx } from "../types.js";
import { HubProtocolError, validated } from "../validation.js";
import { boundedRoomText as trim, roomContext } from "./context.js";
import { RoomAutomation } from "./automation.js";
import { RoomContextCursor } from "./context-cursor.js";
import { HUB_ROOM_CONTEXT_CAPABILITY, roomContextRequestSchema, roomContextInputSchema,
  type HubRoomContextRequest, type HubRoomContextInput, type HubRoomContextResult, type HubRoomContextInputResult } from "../room-context-model.js";
import type { RoomEvent, RoomMessage } from "./types.js";
import type { PersonalQuestionAdapter } from "../personal/types.js";
import {HUB_ROOM_MENTION_FEEDBACK_CAPABILITY} from "../room-mention-feedback-model.js";
import {personalMentionRefusals} from "../personal/refusals.js";

type DB = Database.Database;
export interface RoomPostRow {
  id: string; room_id: string; sequence: number; author_kind: RoomMessage["author"]["kind"]; author_id: string; author_subject: string;
  author_name: string; content_ref: string; digest: string; mentions: string; reply_to: string | null; idempotency_key: string | null; created_at: number;
  answer_to?: string | null; delivery_id?: string | null; stage?: RoomMessage["stage"] | null;
}
interface Delivery {
  id: string; room_id: string; parent_id: string; reply_id: string; exposure_id: string; exposure_revision: number; fleet_id: string|null; owner: string;
  asker: string; asker_member: string; agent_member: string; payload_ref: string; payload_digest: string;
  state: "queued" | "sent" | "answered" | "retired" | "expired"; sent_epoch: number; last_sent_at: number; created_at: number; expires_at: number;
  reason_code?: string | null;
  answer_id: string | null; answer_digest: string | null;
  source_exposure_id: string | null; source_exposure_revision: number | null; source_fleet_id: string | null; on_behalf: number;
  context_generation?: string | null;
}
interface Member { id: string; subject: string; joined_sequence: number; owner_at_join: string | null }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pending = (d: Delivery) => d.state === "queued" || d.state === "sent";
const reactionAnswered = (d: Delivery) => d.state === "answered" && d.reason_code === "acknowledged-by-reaction" && !d.answer_id;
/**
 * A delivery's state as members see it (a message's progress, the room office's "answering"): one that finished without an
 * answer is expired; a personal agent's queued one its job is working on is sent.
 */
const SEEN_PERSONAL = "CASE WHEN d.reason_code='finished-without-answer' AND d.state IN ('queued','sent') THEN 'expired' WHEN d.state='queued' AND j.state='working' THEN 'sent' ELSE d.state END";
const FROM_PERSONAL = "hub_room_deliveries d LEFT JOIN hub_personal_jobs j ON j.room_delivery_id=d.id";
const SEEN_FLEET = "CASE WHEN reason_code='finished-without-answer' AND state IN ('queued','sent') THEN 'expired' ELSE state END";
export class HubRoomAgents {
  private links = new Map<string, HubLinkContext>();
  private states = new Map<string, { link: HubLinkContext; value: HubAgentState }>();
  private flights = new Map<string, Promise<boolean>>();
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private stopped = false;
  /** M-3127: an answer's buttons or poll, recorded in the answer's own transaction (HubGroupRooms sets it). */
  onAnswerButtons: ((db: DB, tx: HubTx, d: { id: string; room_id: string; reply_id: string; asker_member: string }, buttons: HubAnswerButtons) => void) | null = null;
  constructor(private readonly core: HubCore, private readonly emit: (event: RoomEvent) => void,
    private readonly project: (post: RoomPostRow) => RoomMessage,
    private readonly automation = new RoomAutomation(() => core.now()),
    private readonly onAgentMessage: (db: DB, tx: HubTx, post: RoomPostRow) => void = () => {},
    private readonly committed: (postId: string) => void = () => {}) {}
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
  presence(exposureId: string, batchDb?: import("better-sqlite3").Database) {
    const read = <T>(work: (db: import("better-sqlite3").Database) => T): T => batchDb ? work(batchDb) : this.core.atomic(work);
    return read(db => {
      const row = readExposure(db, exposureId);
      if (!row) return { presence: "offline" as const };
      const e = exposureOf(row), link = e.fleetId?this.links.get(e.fleetId):undefined;
      if (e.state !== "published") return { presence: "paused" as const, presenceReason: "operator" as const };
      if(e.kind==="personal")return {presence:this.core.deps.personal?.presence(exposureId)??"offline" as const};
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
  /** M-3596: whether this agent's state was reported on its fleet's current link (an older member never reports it). */
  reported(exposureId: string): boolean {
    const s = this.states.get(exposureId);
    return !!s && s.link.current() && this.links.get(s.link.fleetId) === s.link;
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
  contextState(input: HubRoomContextRequest, link: HubLinkContext): HubRoomContextResult {
    const body = validated(roomContextRequestSchema,input);
    if (!this.supports(link) || !link.features.has(HUB_ROOM_CONTEXT_CAPABILITY)) return {...body,ok:false,code:"denied"};
    const ok = this.core.atomic(db => {
      const e = readExposure(db,body.exposureId);
      if (!link.current() || !e || e.fleet_id !== link.fleetId || e.owner !== personKeyString(link.owner) || exposureOf(e).state !== "published") return false;
      return new RoomContextCursor(db).observe(e.id,JSON.stringify([e.fleet_id,e.owner]),body.generation,link.linkEpoch);
    });
    if (ok) this.wake();
    return {...body,ok,...(!ok ? {code:"stale" as const} : {})};
  }
  contextInput(input: HubRoomContextInput, link: HubLinkContext): HubRoomContextInputResult {
    const body = validated(roomContextInputSchema,input);
    if (!this.supports(link) || !link.features.has(HUB_ROOM_CONTEXT_CAPABILITY)) return {...body,ok:false,code:"denied"};
    const ok = this.core.atomic(db => {
      const d = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(body.messageId) as Delivery | undefined;
      if (!link.current() || !d || d.exposure_id !== body.exposureId || d.fleet_id !== link.fleetId || d.owner !== personKeyString(link.owner)
        || !d.sent_epoch || !this.valid(db,d) || this.core.now() >= d.expires_at) return false;
      const e=readExposure(db,d.exposure_id);
      if (!e || exposureOf(e).state !== "published" || !this.sourcePublished(db,d)) return false;
      const binding=JSON.stringify([d.fleet_id,d.owner]),cursor=new RoomContextCursor(db);
      if (cursor.generation(d.exposure_id,binding,link.linkEpoch) !== body.generation) return false;
      const bytes=this.core.deps.content.get(d.payload_ref)?.question;
      if (bytes===undefined || digest(bytes)!==d.payload_digest) throw new HubProtocolError("uncertain");
      const ask=validated(roomAskSchema,JSON.parse(bytes));
      const parent=db.prepare("SELECT sequence FROM hub_room_posts WHERE id=? AND room_id=?").get(d.parent_id,d.room_id) as {sequence:number}|undefined;
      if (!parent) return false;
      const interval=ask.contextState ?? {generation:body.generation,after:0,through:parent.sequence};
      if (interval.through!==parent.sequence) return false;
      const ok=cursor.received(d.room_id,d.exposure_id,binding,body.generation,interval);
      if(ok&&link.features.has(HUB_ROOM_BRIEF_CAPABILITY))confirmRoomBrief(db,d.id,d.room_id,d.exposure_id,binding,body.generation,interval.through);
      return ok;
    });
    return {...body,ok,...(!ok ? {code:"stale" as const} : {})};
  }
  /** M-3533 R1: the agents a question asked in `roomId` is with now (progress's "working"), for the room office's "answering". */
  answering(db: DB, roomId: string): Set<string> {
    const rows = (this.core.deps.personal
      ? db.prepare(`SELECT DISTINCT d.exposure_id e FROM ${FROM_PERSONAL} WHERE d.room_id=? AND ${SEEN_PERSONAL}='sent'`).all(roomId)
      : db.prepare(`SELECT DISTINCT exposure_id e FROM hub_room_deliveries WHERE room_id=? AND ${SEEN_FLEET}='sent'`).all(roomId)) as { e: string }[];
    return new Set(rows.map(r => r.e));
  }
  progress(db: DB, parentId: string): RoomMessage["ask"] {
    const rows = (this.core.deps.personal
      ? db.prepare(`SELECT ${SEEN_PERSONAL} state,COUNT(*) n FROM ${FROM_PERSONAL} WHERE d.parent_id=? GROUP BY 1`).all(parentId)
      : db.prepare(`SELECT ${SEEN_FLEET} state,COUNT(*) AS n FROM hub_room_deliveries WHERE parent_id=? GROUP BY 1`).all(parentId)) as { state: Delivery["state"]; n: number }[];
    if (!rows.length) return undefined;
    const n = (state: Delivery["state"]) => rows.find(r => r.state === state)?.n ?? 0;
    const total = rows.reduce((v, r) => v + r.n, 0), failed = n("expired"), blocked = n("retired");
    const missing=total===1&&failed===1&&db.prepare("SELECT 1 FROM hub_room_deliveries WHERE parent_id=? AND reason_code='finished-without-answer'").get(parentId);
    const stopped = total === 1 && blocked === 1 && db.prepare("SELECT 1 FROM hub_room_deliveries WHERE parent_id=? AND reason_code='owner-stopped-sharing'").get(parentId);
    const lapsed = total === 1 && blocked === 1 && db.prepare("SELECT 1 FROM hub_room_deliveries WHERE parent_id=? AND reason_code='share-needs-reshare'").get(parentId);
    return { total, answered: n("answered"), working: n("sent"), later: n("queued"),
      ...(failed ? { failed } : {}), ...(blocked ? { blocked } : {}),
      ...(total === 1 && failed === 1 ? { reason: missing?"finished-without-answer" as const:"expired" as const } : total === 1 && blocked === 1 ? { reason: lapsed ? "share-needs-reshare" as const : stopped ? "owner-stopped-sharing" as const : "retired" as const } : {}) };
  }
  /** Called inside the person's message transaction, once per idempotency key. */
  /**
   * M-3127 `as`: a Hub-made post asks on someone's behalf (a poll's results go to the agent that asked it, from that
   * question's asker): its asker, the name the agent sees, and the text it gets instead of the post's own words.
   */
  enqueue(db: DB, tx: HubTx, parent: RoomPostRow, askerMember: string, as?: { asker: string; name: string; text: string }): void {
    const mentions = JSON.parse(parent.mentions) as string[];
    if (!mentions.length) return;
    const room = db.prepare("SELECT name,purpose FROM hub_group_rooms WHERE id=?").get(parent.room_id) as { name: string;purpose:string };
    const agents = db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent'").all(parent.room_id) as Member[];
    const operation = db.prepare("SELECT exposure_id,receipt_id FROM hub_room_agent_operations WHERE post_id=?").get(parent.id) as { exposure_id: string; receipt_id: string | null } | undefined;
    const source = parent.author_kind === "agent" || operation ? readExposure(db, operation?.exposure_id ?? parent.author_id) : undefined;
    const selected = agents.filter(m => {
      const e=readExposure(db,m.subject);
      // Refusals have no target delivery, placeholder or question statistic.
      if(e?.source_kind==="personal")return mentions.includes(m.subject)&&(!source||!!operation?.receipt_id);
      return mentions.includes("all")||mentions.includes(m.subject);
    });
    const people = db.prepare("SELECT id,subject FROM hub_room_members WHERE room_id=? AND kind='person'").all(parent.room_id) as { id: string; subject: string }[];
    if (mentions.some(m => m !== "all" && !agents.some(a => a.subject === m) && !people.some(p => p.id === m || p.subject === m))) throw new HubProtocolError("invalid");
    if ((db.prepare("SELECT COUNT(*) AS n FROM hub_room_deliveries WHERE state IN ('queued','sent')").get() as { n: number }).n + selected.length > 4096) throw new HubProtocolError("backpressure");
    const sourceMember = db.prepare("SELECT joined_sequence FROM hub_room_members WHERE id=?").get(askerMember) as { joined_sequence: number } | undefined;
    if (!sourceMember || parent.author_kind === "agent" && !source) throw new HubProtocolError("revoked");
    for (const m of selected) {
      const e = readExposure(db, m.subject);
      if (!e || e.owner !== m.owner_at_join) throw new HubProtocolError("revoked");
      if (this.automation.lineage(db, parent).audience_sequence < m.joined_sequence) continue;
      const link=e.fleet_id?this.links.get(e.fleet_id):undefined;
      let contextState=link?.current() && link.features.has(HUB_ROOM_CONTEXT_CAPABILITY)
        ? new RoomContextCursor(db).snapshot(parent.room_id,e.id,JSON.stringify([e.fleet_id,e.owner]),parent.sequence,link.linkEpoch) : null;
      const roster=contextState&&link?.features.has(HUB_ROOM_BRIEF_CAPABILITY)?roomRoster(db,parent.room_id):null;
      let previous=roster&&contextState?previousRoster(db,parent.room_id,e.id,JSON.stringify([e.fleet_id,e.owner]),contextState.generation):null;
      // A newly joined incarnation gets the full window and brief together, even in the same agent conversation.
      if(previous&&!previous.some(row=>row.id===m.id))previous=null;
      if(roster&&!previous&&contextState)contextState={...contextState,after:0};
      const brief=roster?buildRoomBrief(room.purpose??"",roster,previous):undefined;
      const context = roomContext(this.core, db, parent, Math.max(m.joined_sequence, sourceMember.joined_sequence),contextState?.after);
      const id = randomUUID(), replyId = randomUUID(), now = this.core.now();
      // M-3125: a person's post carries its files; a Hub-made post on someone's behalf (`as`) has none.
      const files = as ? [] : this.postFiles(db, parent.id);
      const payload: HubRoomAsk = validated(roomAskSchema, { ...(files.length ? { attachments: files } : {}), messageId: id, roomId: parent.room_id, roomName: trim(room.name, 120), exposureId: e.id,
        asker: { name: trim(as ? as.name : source && !operation?.receipt_id ? `${parent.author_name} · ${this.project(parent).author.owner?.name ?? ""}'s agent` : parent.author_name, 256) }, text: trim(as ? as.text : this.core.deps.content.get(parent.content_ref)?.question ?? "", HUB_LIMITS.question), context, ...(contextState ? {contextState} : {}),...(brief?{brief}:{}) });
      const bytes = JSON.stringify(payload);
      if (Buffer.byteLength(bytes) + 512 > HUB_LIMITS.frame) throw new HubProtocolError("backpressure");
      const max = (db.prepare("SELECT MAX(sequence) AS n FROM hub_room_posts WHERE room_id=?").get(parent.room_id) as { n: number }).n;
      db.prepare(`INSERT INTO hub_room_posts(id,room_id,sequence,author_kind,author_id,author_subject,author_name,content_ref,digest,mentions,created_at,answer_to,delivery_id,stage)
        VALUES(?,?,?,'agent',?,?,?,?,?,'[]',?,?,?,'queued')`).run(replyId, parent.room_id, max + 1, e.id, e.owner, e.display_name,
          this.core.deps.content.put(tx, { question: "" }), "", now, parent.id, id);
      const payloadRef = this.core.deps.content.put(tx, { question: bytes });
      this.core.audit(tx, { requestId: id, actor: { kind: "person", person: personFromString(as?.asker ?? parent.author_subject) }, action: "room.ask-queued", result: "completed", roomId: parent.room_id, messageId: parent.id, exposureId: e.id, fleetId: e.fleet_id??undefined, contentRef: payloadRef });
      db.prepare(`INSERT INTO hub_room_deliveries(id,room_id,parent_id,reply_id,exposure_id,exposure_revision,fleet_id,owner,asker,asker_member,agent_member,payload_ref,payload_digest,state,created_at,expires_at,source_exposure_id,source_exposure_revision,source_fleet_id,on_behalf)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?)`).run(id, parent.room_id, parent.id, replyId, e.id, e.revision, e.fleet_id, e.owner, as?.asker ?? parent.author_subject, askerMember, m.id,
          payloadRef, digest(bytes), now, now + 24 * 60 * 60_000, source?.id ?? null, source?.revision ?? null, source?.fleet_id ?? null, operation?.receipt_id ? 1 : 0);
      if(roster)db.prepare("INSERT INTO hub_room_brief_deliveries VALUES(?,?)").run(id,JSON.stringify(roster));
      if (contextState) db.prepare("UPDATE hub_room_deliveries SET context_generation=? WHERE id=?").run(contextState.generation,id);
      if (this.core.shareLapsed(db, e.id)) {
        db.prepare("UPDATE hub_room_deliveries SET state='retired',reason_code='share-needs-reshare' WHERE id=?").run(id);
        db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(replyId);
      }
      this.automation.child(db, parent, replyId, e.id);
      const projected=exposureOf(e);
      if(projected.kind==="personal"){
        const port=this.core.deps.personal;if(!port)throw new HubProtocolError("unavailable");port.enqueue(db,projected,{room:id});
      }
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
      && this.sourceValid(db, d)
      && !!db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=? AND kind='agent' AND subject=? AND owner_at_join=?").get(d.agent_member, d.room_id, d.exposure_id, d.owner);
  }
  private sourceValid(db: DB, d: Delivery): boolean {
    if (!d.source_exposure_id) return !!db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=? AND kind='person' AND subject=?").get(d.asker_member, d.room_id, d.asker);
    const e = readExposure(db, d.source_exposure_id);
    return !!e && e.owner === d.asker && e.revision === d.source_exposure_revision && e.fleet_id === d.source_fleet_id
      && !!db.prepare("SELECT 1 FROM hub_room_members WHERE id=? AND room_id=? AND kind='agent' AND subject=? AND owner_at_join=?").get(d.asker_member, d.room_id, e.id, d.asker);
  }
  private sourcePublished(db: DB, d: Delivery): boolean {
    const e = d.source_exposure_id ? readExposure(db, d.source_exposure_id) : undefined;
    return !d.source_exposure_id || !!e && exposureOf(e).state === "published";
  }
  /** M-3125: the files on a post (a person's, or an agent answer's), in order; none when the Hub has no attachment store. */
  private postFiles(db: DB, postId: string): HubAttachmentRef[] {
    const store = this.core.deps.attachments; if (!store) return [];
    return [...store.forMessage(db, postId, "question"), ...store.forMessage(db, postId, "answer")];
  }
  /** M-3125: is this a file on a group-room post (so its transfer is this service's, not a 1:1 room's)? */
  ownsFile(id: string): boolean {
    const store = this.core.deps.attachments; if (!store) return false;
    return this.core.atomic(db => { const row = store.row(db, id); return !!row?.message_id && !!db.prepare("SELECT 1 FROM hub_room_posts WHERE id=?").get(row.message_id); });
  }
  /**
   * M-3125 (room files, roomFilesNegotiated): the member pulls one chunk of a file on a post its fleet was asked about. Only a fleet holding an
   * open delivery of that exact post, under the delivery's own permission and validity re-checked at the read; audited once.
   */
  async attachmentGet(input: { id: string; offset: number }, link: HubLinkContext): Promise<HubAttachmentChunk> {
    if (!roomFilesNegotiated(link.features)) throw new HubProtocolError("incompatible");
    const store = this.core.deps.attachments; if (!store) throw new HubProtocolError("incompatible");
    const find = (db: DB) => { const row = store.row(db, input.id);
      const d = row?.state === "bound" && row.message_id ? db.prepare("SELECT * FROM hub_room_deliveries WHERE parent_id=? AND fleet_id=? AND state IN ('queued','sent') ORDER BY created_at DESC LIMIT 1")
        .get(row.message_id, link.fleetId) as Delivery | undefined : undefined; return { row, d }; };
    const found = this.core.atomic(find);
    if (!found.row || !found.d || found.row.room_id !== found.d.room_id) throw new HubProtocolError("not-found");
    const permit = await this.permission(found.d, link);
    if (!link.current()) throw new HubProtocolError("stale");
    return this.core.atomic((db, tx) => {
      const { row, d } = find(db);
      if (!row || !d || d.id !== found.d!.id || !this.valid(db, d) || this.core.now() >= d.expires_at) throw new HubProtocolError("not-found");
      const chunk = store.chunk(db, row.sha256, input.offset);
      if (input.offset === 0) this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "member", fleetId: link.fleetId }, action: "file.transfer", result: "allowed",
        reasonCode: `${row.direction}:${row.size}:${row.mime}:${row.sha256}`, messageId: d.parent_id, roomId: d.room_id, fleetId: link.fleetId, exposureId: d.exposure_id });
      return { id: row.id, offset: input.offset, total: chunk.total, sha256: row.sha256, data: chunk.data.toString("base64") };
    }, permit);
  }
  private async permission(d: Delivery, link: HubLinkContext) {
    const ctx = { requestId: d.id, current: () => this.live() && link.current() && this.links.get(link.fleetId) === link };
    const target = await this.core.groupExposure(d.exposure_id, d.source_exposure_id && !d.on_behalf ? null : personFromString(d.asker), ctx);
    const source = d.source_exposure_id ? await this.core.groupExposure(d.source_exposure_id, null, ctx) : undefined;
    return { assertCurrent: () => { target.assertCurrent(); source?.assertCurrent(); } };
  }
  publicationSettled(ids: readonly string[]): void {
    for (const id of ids) {
      const row = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(id) as Delivery | undefined);
      if (row && row.state === "retired") this.update(row);
    }
  }
  private update(d: Delivery, added = false): void {
    const data = this.core.atomic(db => {
      const reply = db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(d.reply_id) as RoomPostRow;
      return { value: { roomId: d.room_id, message: this.project(reply), parent: { id: d.parent_id, ask: this.project(db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(d.parent_id) as RoomPostRow).ask } }, sequence: reply.sequence };
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
        const lapsed = !expired && this.core.shareLapsed(db, d.exposure_id);
        if (!expired && !lapsed && (dueOnly || this.valid(db, d))) return false;
        const exposure = readExposure(db, d.exposure_id);
        const publicationChanged = !expired && exposure && exposure.revision > d.exposure_revision
          && this.valid(db, { ...d, exposure_revision: exposure.revision });
        db.prepare("UPDATE hub_room_deliveries SET state=?,reason_code=? WHERE id=?").run(expired ? "expired" : "retired", lapsed ? "share-needs-reshare" : publicationChanged ? "publication-changed" : null, d.id);
        db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(d.reply_id); return true;
      });
    });
    for (const d of changed) this.update(d);
  }
  wake(): void {
    if (!this.live()) return;
    this.core.deps.personal?.wake();
    this.sweep();
    const targets = this.core.atomic(db => ({
      fleets: db.prepare("SELECT DISTINCT fleet_id FROM hub_room_deliveries WHERE fleet_id IS NOT NULL AND state IN ('queued','sent')").all() as { fleet_id: string }[],
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
    const rows = this.core.atomic(db => link.features.has(HUB_ROOM_CONTEXT_CAPABILITY)
      ? db.prepare(`SELECT d.* FROM hub_room_deliveries d WHERE fleet_id=? AND state IN ('queued','sent') AND COALESCE(reason_code,'')<>'finished-without-answer' AND (sent_epoch<>? OR last_sent_at<=?)
          AND (context_generation IS NULL OR EXISTS(SELECT 1 FROM hub_room_context_generations g WHERE g.exposure_id=d.exposure_id AND g.generation=d.context_generation AND g.link_epoch=?))
          ORDER BY created_at,d.rowid LIMIT 64`).all(fleetId,link.linkEpoch,this.core.now()-30_000,link.linkEpoch) as Delivery[]
      : db.prepare("SELECT * FROM hub_room_deliveries WHERE fleet_id=? AND state IN ('queued','sent') AND COALESCE(reason_code,'')<>'finished-without-answer' AND (sent_epoch<>? OR last_sent_at<=?) ORDER BY created_at,rowid LIMIT 64").all(fleetId,link.linkEpoch,this.core.now()-30_000) as Delivery[]);
    for (const d of rows) {
      if (!this.live() || !this.supports(link) || this.links.get(fleetId) !== link) return false;
      try {
        if (!await this.core.eligible(personFromString(d.asker)) || !await this.core.eligible(personFromString(d.owner))) continue;
        const permit = await this.permission(d, link);
        const payload = this.core.atomic(db => {
          const current = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery;
          const e = readExposure(db, d.exposure_id);
          if (!pending(current) || !this.valid(db, current) || this.core.now() >= current.expires_at || !e || exposureOf(e).state !== "published" || !this.sourcePublished(db, current)) return null;
          const state = this.states.get(d.exposure_id); if (state?.link === link && state.value.state === "paused") return null;
          const bytes = this.core.deps.content.get(d.payload_ref)?.question;
          if (bytes === undefined || digest(bytes) !== d.payload_digest) throw new HubProtocolError("uncertain");
          const ask = validated(roomAskSchema, JSON.parse(bytes));
          if (ask.contextState && (!link.features.has(HUB_ROOM_CONTEXT_CAPABILITY)
            || new RoomContextCursor(db).generation(d.exposure_id,JSON.stringify([d.fleet_id,d.owner]),link.linkEpoch)!==ask.contextState.generation)) return null;
          if(ask.brief&&!link.features.has(HUB_ROOM_BRIEF_CAPABILITY))delete ask.brief;
          // M-3125: an older member's strict schema refuses `attachments`; it gets the words only.
          if (ask.attachments && !roomFilesNegotiated(link.features)) delete ask.attachments;
          if(link.features.has(HUB_ROOM_ASKER_IDENTITY_CAPABILITY)){
            const signer=this.core.deps.issuer.signRoomAsker;
            const parent=db.prepare("SELECT * FROM hub_room_posts WHERE id=? AND room_id=?").get(d.parent_id,d.room_id)as RoomPostRow|undefined;
            const subject=parent?roomDeliveryAsker(db,parent,d):null;
            // Unknown authors retain the ordinary legacy ask; there is no verified/name fallback.
            // Immutable delivery creation bounds retention: a reconnect must never slide the accepted deadline.
            if(subject&&signer){const now=this.core.now(),retainedUntil=Math.min(d.expires_at,d.created_at+ROOM_ASKER_RETENTION_MS);ask.askerIdentity=signer({v:1,issuer:this.core.deps.config.hubId,issuerKeyId:this.core.deps.issuer.keyId,
              destinationFleetId:fleetId,messageId:ask.messageId,roomId:ask.roomId,exposureId:ask.exposureId,exposureRevision:d.exposure_revision,linkEpoch:link.linkEpoch,
              subject,contentDigest:roomAskIdentityDigest(ask),issuedAt:now,expiresAt:Math.min(now+ROOM_ASKER_FRESH_MS,retainedUntil),retainedUntil,nonce:randomUUID().replaceAll("-","")+randomUUID().replaceAll("-","")});}
          }
          return ask;
        }, permit);
        if (!payload || !link.current()) continue;
        // Persist dispatch intent before the socket write: a fast member answer may arrive before send() settles.
        this.core.atomic(db => {
          if (!this.valid(db, d) || !this.sourcePublished(db, d) || this.core.now() >= d.expires_at) throw new HubProtocolError("stale");
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
  /** Commit the visible reaction and its acknowledgement as one permission-fenced operation. */
  async acknowledgeReaction<T>(body: import("../types.js").HubRoomReact, link: HubLinkContext, apply: (db: DB) => T): Promise<T> {
    if (!this.supports(link) || !link.features.has(HUB_ROOM_REACT_ACK_CAPABILITY) || !body.emoji) throw new HubProtocolError("incompatible");
    const d = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(body.messageId) as Delivery | undefined);
    if (!d || d.fleet_id !== link.fleetId || d.owner !== personKeyString(link.owner) || d.room_id !== body.roomId || d.exposure_id !== body.exposureId || !d.sent_epoch) throw new HubProtocolError("denied");
    const permit = await this.permission(d, link);
    if (!await this.core.eligible(personFromString(d.asker)) || !await this.core.eligible(link.owner)) throw new HubProtocolError("unavailable");
    const result = this.core.atomic((db, tx) => {
      const now = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery;
      if (!link.current() || !this.valid(db, now)) throw new HubProtocolError("revoked");
      const already = reactionAnswered(now);
      if (!already && (!pending(now) || now.answer_id || this.core.now() >= now.expires_at)) throw new HubProtocolError("not-found");
      const e = readExposure(db, now.exposure_id);
      if (!e || exposureOf(e).state !== "published" || !this.sourcePublished(db, now)) throw new HubProtocolError("revoked");
      const value = apply(db);
      if (!already) {
        db.prepare("UPDATE hub_room_deliveries SET state='answered',reason_code='acknowledged-by-reaction',answered_at=COALESCE(answered_at,?) WHERE id=?").run(this.core.now(), now.id);
        // Settle the retained placeholder like a text answer; projection marks its reaction-only completion.
        db.prepare("UPDATE hub_room_posts SET stage='answered' WHERE id=?").run(now.reply_id);
        this.core.audit(tx, { requestId: now.id, actor: { kind: "person", person: link.owner }, action: "room.react-ack", result: "completed", roomId: now.room_id, messageId: now.parent_id, exposureId: now.exposure_id, fleetId: link.fleetId });
      }
      return value;
    }, permit);
    this.update(d);
    return result;
  }
  async answer(input: HubRoomAnswer, link: HubLinkContext): Promise<HubRoomAnswerAck> {
    const body = validated(roomAnswerSchema, input),{mentionFeedback:_feedback,...answer}=body,hash = digest(JSON.stringify(answer));
    if (!this.supports(link) || body.buttons && !link.features.has(HUB_ROOM_BUTTONS_CAPABILITY) || body.attachments && !roomFilesNegotiated(link.features)) throw new HubProtocolError("incompatible");
    if(body.mentionFeedback&&!link.features.has(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY))throw new HubProtocolError("incompatible");
    const d = this.core.atomic(db => db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(body.messageId) as Delivery | undefined);
    if (!d || d.fleet_id !== link.fleetId || d.owner !== personKeyString(link.owner) || body.roomId !== d.room_id || body.exposureId !== d.exposure_id || !d.sent_epoch) throw new HubProtocolError("denied");
    const ack=():HubRoomAnswerAck=>{
      const value=body.mentionFeedback&&link.features.has(HUB_ROOM_MENTION_FEEDBACK_CAPABILITY)?personalMentionRefusals(this.core,d.reply_id,d.exposure_id):undefined;
      return {messageId:d.id,answerId:body.answerId,...(value?{mentionRefusals:value}:{})};
    };
    // A late missing-answer marker cannot undo acknowledgement. A real answer may recover a lost reaction result.
    if (body.notAnswered && reactionAnswered(d)) return ack();
    if(body.notAnswered){
      if(!link.features.has(HUB_ROOM_ANSWER_STATUS_CAPABILITY))throw new HubProtocolError("incompatible");
      if(d.answer_id||!pending(d)||!this.core.atomic(db=>this.valid(db,d))||this.core.now()>=d.expires_at)return ack();
      const permit=await this.permission(d,link);
      if(!await this.core.eligible(personFromString(d.asker))||!await this.core.eligible(link.owner))throw new HubProtocolError("unavailable");
      this.core.atomic((db,tx)=>{
        const now=db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery;
        if(!link.current())throw new HubProtocolError("stale");
        if(now.answer_id||!pending(now)||!this.valid(db,now)||this.core.now()>=now.expires_at||now.reason_code==="finished-without-answer")return;
        db.prepare("UPDATE hub_room_deliveries SET reason_code='finished-without-answer' WHERE id=?").run(d.id);
        db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(d.reply_id);
        this.core.audit(tx,{requestId:body.answerId,actor:{kind:"person",person:link.owner},action:"room.answer-missing",result:"completed",roomId:d.room_id,messageId:d.reply_id,exposureId:d.exposure_id,fleetId:link.fleetId,reasonCode:"finished-without-answer"});
      },permit);this.update(d);return ack();
    }
    if (d.answer_id) {
      if (d.answer_id !== body.answerId || d.answer_digest !== hash) throw new HubProtocolError("conflict");
      return ack();
    }
    const terminal = this.core.atomic(db => !(pending(d) || reactionAnswered(d)) || !this.valid(db, d) || this.core.now() >= d.expires_at);
    if (terminal) {
      if (reactionAnswered(d)) throw new HubProtocolError("not-found");
      this.core.atomic(db => {
        if (!link.current()) throw new HubProtocolError("stale");
        const current = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery;
        if (current.answer_id && (current.answer_id !== body.answerId || current.answer_digest !== hash)) throw new HubProtocolError("conflict");
        db.prepare("UPDATE hub_room_deliveries SET state='retired',answer_id=?,answer_digest=? WHERE id=?").run(body.answerId, hash, d.id);
        db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(d.reply_id);
      });
      this.update(d); return ack();
    }
    const permit = await this.permission(d, link);
    if (!await this.core.eligible(personFromString(d.asker)) || !await this.core.eligible(personFromString(d.owner))) throw new HubProtocolError("unavailable");
    this.core.atomic((db, tx) => {
      if (!link.current()) throw new HubProtocolError("stale");
      const current = db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery;
      if (current.answer_id) { if (current.answer_id !== body.answerId || current.answer_digest !== hash) throw new HubProtocolError("conflict"); return; }
      const e = readExposure(db, d.exposure_id);
      if ((pending(current) || reactionAnswered(current)) && this.valid(db, current) && e && (exposureOf(e).state !== "published" || !this.sourcePublished(db, current))) throw new HubProtocolError("unavailable");
      const disclose = (pending(current) || reactionAnswered(current)) && this.valid(db, current) && this.core.now() < current.expires_at && !!e && exposureOf(e).state === "published";
      if (reactionAnswered(current) && !disclose) throw new HubProtocolError("not-found");
      db.prepare("UPDATE hub_room_deliveries SET reason_code=CASE WHEN ? THEN NULL ELSE reason_code END,state=?,answer_id=?,answer_digest=?,answered_at=CASE WHEN ? THEN COALESCE(answered_at,?) ELSE answered_at END WHERE id=?").run(disclose?1:0,disclose ? "answered" : "retired", body.answerId, hash, disclose ? 1 : 0, this.core.now(), d.id);
      if (disclose) {
        const seq = (db.prepare("SELECT MAX(sequence) AS n FROM hub_room_posts WHERE room_id=?").get(d.room_id) as { n: number }).n + 1;
        const answerRef = this.core.deps.content.put(tx, { question: body.text });
        db.prepare("UPDATE hub_room_posts SET content_ref=?,stage='answered',sequence=?,created_at=? WHERE id=?").run(answerRef, seq, this.core.now(), d.reply_id);
        // M-3125: the answer's staged files bind to its post in this same audited transaction (a refusal undoes the answer).
        if (body.attachments) { const store = this.core.deps.attachments; if (!store) throw new HubProtocolError("incompatible");
          store.bindAnswer(db, body.attachments, d.reply_id, d.room_id, link.fleetId); }
        this.core.audit(tx, { requestId: d.id, actor: { kind: "person", person: link.owner }, action: "room.answer", result: "completed", roomId: d.room_id, messageId: d.reply_id, exposureId: d.exposure_id, fleetId: link.fleetId, contentRef: answerRef });
        if (body.buttons) this.onAnswerButtons?.(db, tx, current, body.buttons);
        this.onAgentMessage(db, tx, db.prepare("SELECT * FROM hub_room_posts WHERE id=?").get(d.reply_id) as RoomPostRow);
      } else db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(d.reply_id);
    }, permit);
    this.update(d); this.committed(d.reply_id); this.wake(); return ack();
  }
  personalQuestions():PersonalQuestionAdapter {
    return {
      prepare:async job=>{
        const d=this.core.atomic(db=>db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(job.room_delivery_id!) as Delivery|undefined);
        if(!d||d.id!==job.id||d.fleet_id!==null)throw new HubProtocolError("not-found");
        if(!await this.core.eligible(personFromString(d.asker))||!await this.core.eligible(personFromString(d.owner)))throw new HubProtocolError("revoked");
        const ctx={requestId:d.id,current:()=>this.live()};
        const target=await this.core.groupExposure(d.exposure_id,personFromString(d.asker),ctx);
        const source=d.source_exposure_id?await this.core.groupExposure(d.source_exposure_id,null,ctx):undefined;
        const permit={assertCurrent:()=>{target.assertCurrent();source?.assertCurrent();}};
        return this.core.atomic(db=>{
          const current=db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(d.id) as Delivery|undefined;
          if(!current||!pending(current)||!this.valid(db,current)||!this.sourcePublished(db,current)||this.core.now()>=current.expires_at)throw new HubProtocolError("revoked");
          if(current.source_exposure_id&&!current.on_behalf)throw new HubProtocolError("denied");
          const e=readExposure(db,current.exposure_id);
          if(e?.personal_agent_id!==job.personal_agent_id)throw new HubProtocolError("revoked");
          const bytes=this.core.deps.content.get(current.payload_ref)?.question;
          if(!bytes||digest(bytes)!==current.payload_digest)throw new HubProtocolError("expired");
          const ask=validated(roomAskSchema,JSON.parse(bytes));
          const prompt=trim(JSON.stringify({room:ask.roomName,question:ask.text,context:ask.context}),48*1024);
          return {prompt,permit};
        },permit);
      },
      settle:(db,tx,job,outcome)=>{
        const d=db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(job.room_delivery_id!) as Delivery|undefined;
        if(!d||d.id!==job.id||d.fleet_id!==null)throw new HubProtocolError("not-found");
        if(!pending(d)){if("text" in outcome)throw new HubProtocolError("revoked");return;}
        const success="text" in outcome,now=this.core.now();
        if(success&&(!this.valid(db,d)||!this.sourcePublished(db,d)||now>=d.expires_at))throw new HubProtocolError("revoked");
        db.prepare("UPDATE hub_room_deliveries SET state=?,answer_id=?,answered_at=CASE WHEN ? THEN COALESCE(answered_at,?) ELSE answered_at END WHERE id=?")
          .run(success?"answered":"expired",success?job.id:null,success?1:0,now,d.id);
        let ref:string|undefined;
        if(success){
          ref=this.core.deps.content.put(tx,{question:outcome.text});
          const seq=(db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM hub_room_posts WHERE room_id=?").get(d.room_id) as {n:number}).n;
          db.prepare("UPDATE hub_room_posts SET content_ref=?,stage='answered',sequence=?,created_at=? WHERE id=?").run(ref,seq,now,d.reply_id);
        }else db.prepare("UPDATE hub_room_posts SET stage='not-answered' WHERE id=?").run(d.reply_id);
        this.core.audit(tx,{requestId:job.id,actor:{kind:"person",person:personFromString(job.owner)},action:"personal.room-answer",result:success?"completed":"held",
          roomId:d.room_id,messageId:d.reply_id,exposureId:d.exposure_id,...(ref?{contentRef:ref}:{}),...(success?{}:{reasonCode:outcome.reason})});
        // Personal answers deliberately never enter onAgentMessage: they cannot start another agent ask.
      },
      changed:job=>{const d=this.core.atomic(db=>db.prepare("SELECT * FROM hub_room_deliveries WHERE id=?").get(job.room_delivery_id!) as Delivery|undefined);if(d)this.update(d);},
    };
  }
  async close(): Promise<void> {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.links.clear(); this.states.clear(); await Promise.allSettled([...this.flights.values()]);
  }
}
