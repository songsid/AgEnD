/**
 * AgEnD Hub P1, slice 3: one-asker/one-exposure rooms and the Hub's half of durable delivery (hub.md §2, §5 HubRooms).
 *
 * - A room is keyed by its immutable asker, exposure and grant. It has no shared audience and inherits no history.
 * - `ask` commits the question (an encrypted content ref, never the text) with its audit before answering "queued".
 *   A repeat of the same idempotency key with the same text returns the same message; different text is a conflict.
 * - Questions go to the member over the current link once it has reconciled. Each send carries a freshly signed
 *   envelope (120 s) for the same message id, and the member dedups by that id. Nothing is sent without a transport.
 * - The member's receipts are monotonic and never downgrade known evidence. An answer is accepted only under the
 *   release lease the Hub issued for exactly its id and digest, and only if authorization still holds at that moment.
 * - Reads re-check both people and the grant on every poll, and are paced.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { HubButtonsService, type HubButtonQuestion } from "./buttons.js";
import { buttonsDigest } from "./buttons-model.js";
import type { HubTx } from "./types.js";
import { HubProtocolError, scalarString, validated } from "./validation.js";
import { messageContentDigest, personKeyString } from "./identity.js";
import { HUB_LIMITS, answerSchema } from "./protocol.js";
import type { HubAttachmentChunk, HubAttachmentRef } from "./types.js";
import type { HubAttachmentStore } from "./attachments/store.js";
import { isInlineImage } from "./attachments/limits.js";
import type { HubAnswer, HubExposure, HubReceipt, HubReconcile, HubReconcileReply, HubRequestContext, HubRoom, HubRoomEntry, HubServerFrame } from "./types.js";
import type { HubLinkContext } from "./server.js";
import { exposureOf, grantApplies, grantOf, readExposure, readGrant } from "./catalog.js";
import { POSITIVE, QUESTION_LIFETIME_MS, TERMINAL, messageFacts, readMessage, type HubPolicyService, type MessageRow } from "./policy.js";
import { personFromString, type HubCore, type HubOperationPermit } from "./http/core.js";

/** One accepted poll per room and session in this window (hub.md §5: at most once per ten seconds). */
export const ROOM_POLL_MS = 10_000;
const ENVELOPE_MS = 120_000;
const RANK: Record<string, number> = { queued: 1, delivered: 2, consumed: 3, answered: 4 };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface RoomRow { id: string; asker: string; exposure_id: string; owner_at_creation: string; grant_id: string; state: HubRoom["state"]; created_at: number }
/** A room as the conversation list shows it (#3226 B). */
export interface HubRoomListItem extends HubRoom {
  exposureName: string; exposureState: HubExposure["state"]; ownerName: string;
  grantExpiresAt: number; lastAt: number; waiting: boolean; features: readonly string[];
}
type RoomViewRow = RoomRow & { fleet_id: string; exposure_name: string; exposure_state: HubExposure["state"]; exposure_revision: number; frozen_through: number;
  owner_name: string | null; grant_expires_at: number | null; last_at: number; waiting: number };
const ROOM_VIEW_SQL = `SELECT r.*, e.fleet_id AS fleet_id, e.display_name AS exposure_name, e.state AS exposure_state, e.revision AS exposure_revision, e.frozen_through,
  p.display_name AS owner_name, g.expires_at AS grant_expires_at,
  COALESCE((SELECT MAX(m.stage_at) FROM hub_messages m WHERE m.room_id = r.id), r.created_at) AS last_at,
  EXISTS (SELECT 1 FROM hub_messages m WHERE m.room_id = r.id AND m.stage IN ('queued','delivered','consumed')) AS waiting
  FROM hub_rooms r JOIN hub_exposures e ON e.id = r.exposure_id LEFT JOIN hub_people p ON p.person = e.owner LEFT JOIN hub_grants g ON g.id = r.grant_id`;
function roomListItem(r: RoomViewRow, features: readonly string[]): HubRoomListItem {
  // A closed room says which chat it was (its agent, its owner) and when it last moved (the list's order) — nothing of
  // its grant, its link or whether a question waited (#3246 review).
  if (r.state !== "active") return { ...roomOf(r), exposureName: r.exposure_name, ownerName: r.owner_name ?? "", exposureState: r.exposure_state,
    grantExpiresAt: 0, lastAt: r.last_at, waiting: false, features: [] };
  return { ...roomOf(r), exposureName: r.exposure_name, ownerName: r.owner_name ?? "",
    exposureState: r.frozen_through >= r.exposure_revision && r.exposure_state === "published" ? "frozen" : r.exposure_state,
    grantExpiresAt: r.grant_expires_at ?? 0, lastAt: r.last_at, waiting: !!r.waiting, features };
}
const roomOf = (r: RoomRow): HubRoom => ({ id: r.id, asker: personFromString(r.asker), exposureId: r.exposure_id, ownerAtCreation: personFromString(r.owner_at_creation), grantId: r.grant_id, state: r.state });
const receiptOf = (m: MessageRow): HubReceipt => ({ messageId: m.id, contentDigest: m.content_digest, stage: m.stage as HubReceipt["stage"],
  sequence: m.member_sequence, at: m.stage_at, ...(m.reason_code ? { reasonCode: m.reason_code } : {}) });

/** A file as the asker's browser sees it: always fetched through the room's own route. */
export interface HubFileView { id: string; name: string; size: number; mime: string; url: string }
const fileView = (roomId: string, r: HubAttachmentRef): HubFileView => ({ id: r.id, name: r.name, size: r.size, mime: r.mime, url: `/hub/v1/rooms/${roomId}/files/${r.id}` });
export interface HubRoomEntryView extends HubRoomEntry { buttons?: import("../reply-buttons-controller.js").ReplyButtonsView; pollResult?: true; expired?: boolean; questionFiles?: HubFileView[]; answerFiles?: HubFileView[] }
const FILES = "attachments-v1";
const b64 = (data: string): Buffer => { const b = Buffer.from(data, "base64"); if (b.toString("base64") !== data) throw new HubProtocolError("invalid"); return b; };

export class HubRoomsService {
  /** The newest link seen per fleet (from S1's receive): dispatch uses it only while it is current. */
  private readonly links = new Map<string, HubLinkContext>();
  private readonly polls = new Map<string, number>();
  private readonly flushing = new Set<string>();
  readonly buttons: HubButtonsService;
  constructor(private readonly core: HubCore, private readonly policy: HubPolicyService) {
    this.buttons = new HubButtonsService(core, {
      insert: (db, tx, input) => this.insertQuestion(db, tx, input).receipt,
      flush: fleetId => { void this.flush(fleetId); },
    });
  }

  noteLink(link: HubLinkContext): void {
    const old = this.links.get(link.fleetId);
    if (!old || old.linkEpoch <= link.linkEpoch) this.links.set(link.fleetId, link);
  }
  forget(): void { this.links.clear(); this.polls.clear(); }

  private store(): HubAttachmentStore { const s = this.core.deps.attachments; if (!s) throw new HubProtocolError("incompatible"); return s; }
  /** The optional features of a fleet's current link (empty while it has none: nothing new is offered or sent). */
  features(fleetId: string): readonly string[] {
    const link = this.links.get(fleetId);
    return link?.current() ? [...link.features].filter(f => f !== "welcome-caps-v1" && (f !== FILES || this.core.deps.attachments !== undefined)) : [];
  }
  private requireFiles(fleetId: string): void { if (!this.features(fleetId).includes(FILES)) throw new HubProtocolError("incompatible"); }
  /** The asker's room, its grant applying now with `permission`, inside a transaction. */
  private askerRoom(db: Parameters<Parameters<HubCore["atomic"]>[0]>[0], roomId: string, asker: import("./types.js").PersonKey, now: number, permission: "ask" | "read-own-room") {
    const r = db.prepare("SELECT * FROM hub_rooms WHERE id=?").get(roomId) as RoomRow | undefined;
    if (!r || r.asker !== personKeyString(asker)) throw new HubProtocolError("not-found");
    if (r.state !== "active") throw new HubProtocolError("revoked");
    const e = readExposure(db, r.exposure_id), g = readGrant(db, r.grant_id);
    if (!e || !g) throw new HubProtocolError("revoked");
    const exposure = exposureOf(e), grant = grantOf(g);
    if (permission === "ask" ? exposure.state !== "published" || !grantApplies(grant, exposure, asker, now)
      : grant.state !== "active" || now >= grant.expiresAt || personKeyString(grant.subject.person) !== personKeyString(asker) || !grant.permissions.includes("read-own-room") || exposure.state === "withdrawn")
      throw new HubProtocolError("revoked");
    return { room: r, exposure, grant };
  }
  private async ownerEligible(ctx: HubRequestContext, roomId: string): Promise<{ asker: import("./types.js").PersonKey; room: RoomRow; permit: HubOperationPermit }> {
    const asker = await ctx.requirePerson(), me = personKeyString(asker);
    const room = this.core.atomic((db) => db.prepare("SELECT * FROM hub_rooms WHERE id=?").get(roomId) as RoomRow | undefined);
    if (!room || room.asker !== me) throw new HubProtocolError("not-found");
    const ownerId = this.core.atomic((db) => readExposure(db, room.exposure_id)?.owner);
    if (!ownerId || !(await this.core.eligible(personFromString(ownerId)))) throw new HubProtocolError("revoked");
    await ctx.current();
    const permit = await this.core.groupExposure(room.exposure_id, asker, this.core.groupContext(ctx));
    return { asker, room, permit };
  }

  /** Before any upload body is read: the asker, their room and grant, a link that takes files, and room in their budget. */
  async uploadAdmit(ctx: HubRequestContext, roomId: string, declaredBytes: number): Promise<void> {
    const store = this.store(), { asker, permit } = await this.ownerEligible(ctx, roomId), now = this.core.now();
    this.core.atomic((db) => {
      const { exposure } = this.askerRoom(db, roomId, asker, now, "ask");
      this.requireFiles(exposure.fleetId);
      store.admit(db, { uploader: personKeyString(asker) }, declaredBytes);
    }, permit);
  }
  /** The asker's file for a later question in this room: only while the fleet's link takes files. Pending one hour. */
  async upload(ctx: HubRequestContext, roomId: string, name: string, bytes: Buffer): Promise<HubFileView> {
    const store = this.store(), { asker, permit } = await this.ownerEligible(ctx, roomId), now = this.core.now();
    return this.core.atomic((db, tx) => {
      const { room, exposure, grant } = this.askerRoom(db, roomId, asker, now, "ask");
      this.requireFiles(exposure.fleetId);
      const ref = store.createUpload(db, { roomId: room.id, uploader: personKeyString(asker), name, bytes });
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: asker }, action: "file.upload", result: "allowed",
        reasonCode: `question:${ref.size}:${ref.mime}:${ref.sha256}`, contentRef: this.core.deps.content.put(tx, { question: ref.name }),
        roomId, fleetId: exposure.fleetId, exposureId: exposure.id, ownerAtEvent: exposure.owner, grantId: grant.id, grantRevision: grant.revision });
      return fileView(roomId, ref);
    }, permit);
  }
  /** One of this room's files, for its asker while read-own-room holds; every read is audited. */
  async download(ctx: HubRequestContext, roomId: string, fileId: string): Promise<{ name: string; mime: string; image: boolean; bytes: Buffer }> {
    const store = this.store(), { asker, permit } = await this.ownerEligible(ctx, roomId), now = this.core.now();
    return this.core.atomic((db, tx) => {
      const { exposure, grant } = this.askerRoom(db, roomId, asker, now, "read-own-room");
      const row = store.row(db, fileId);
      if (!row || row.room_id !== roomId || row.state !== "bound" && !(row.state === "pending" && row.uploader === personKeyString(asker) && (row.expires_at ?? 0) > now)) throw new HubProtocolError("not-found");
      const bytes = store.read(db, row.sha256);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: asker }, action: "file.read", result: "allowed",
        reasonCode: `${row.direction}:${row.size}:${row.mime}:${row.sha256}`, ...(row.message_id ? { messageId: row.message_id } : {}),
        roomId, fleetId: exposure.fleetId, exposureId: exposure.id, ownerAtEvent: exposure.owner, grantId: grant.id, grantRevision: grant.revision });
      return { name: row.name, mime: row.mime, image: isInlineImage(row.mime), bytes };
    }, permit);
  }

  /** Open (or find) the asker's room for one exposure under one grant that applies to them now. */
  async open(ctx: HubRequestContext, exposureId: string, grantId: string): Promise<HubRoom & { exposure: HubExposure }> {
    const asker = await ctx.requirePerson(), me = personKeyString(asker), now = this.core.now();
    const owner = this.core.atomic((db) => readExposure(db, exposureId)?.owner);
    if (!owner || !(await this.core.eligible(personFromString(owner)))) throw new HubProtocolError("not-found");
    await ctx.current();
    const permit = await this.core.groupExposure(exposureId, asker, this.core.groupContext(ctx));
    return this.core.atomic((db, tx) => {
      const e = readExposure(db, exposureId), g = readGrant(db, grantId);
      if (!e || !g) throw new HubProtocolError("not-found");
      const exposure = exposureOf(e), grant = grantOf(g);
      if (exposure.state !== "published" || !grantApplies(grant, exposure, asker, now)) throw new HubProtocolError("not-found");
      const found = db.prepare("SELECT * FROM hub_rooms WHERE asker=? AND exposure_id=? AND grant_id=?").get(me, exposureId, grantId) as RoomRow | undefined;
      if (found) {
        if (found.state !== "active") throw new HubProtocolError("revoked");
        return { ...roomOf(found), exposure };
      }
      const room: RoomRow = { id: randomUUID(), asker: me, exposure_id: exposureId, owner_at_creation: e.owner, grant_id: grantId, state: "active", created_at: now };
      db.prepare("INSERT INTO hub_rooms(id, asker, exposure_id, owner_at_creation, grant_id, state, created_at) VALUES(?,?,?,?,?,?,?)")
        .run(room.id, room.asker, room.exposure_id, room.owner_at_creation, room.grant_id, room.state, room.created_at);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: asker }, action: "room.opened", result: "completed",
        roomId: room.id, fleetId: exposure.fleetId, exposureId, ownerAtEvent: exposure.owner, grantId, grantRevision: grant.revision });
      return { ...roomOf(room), exposure };
    }, permit);
  }

  /**
   * This person's rooms, the most recently active first, as the chat's conversation list draws them (#3226 B): the
   * exposure's name and state, who it represents (the owner's display name), the grant's end, when the room last moved
   * and whether a question there still waits for its answer, and what its fleet link negotiated (`features`). A closed room (its grant revoked, its agent withdrawn) is
   * listed too, as closed: the person keeps knowing which chat it was (its history is not readable any more). `features`: what the room's fleet link
   * has negotiated (D's link.features; none until then).
   */
  async list(ctx: HubRequestContext): Promise<readonly HubRoomListItem[]> {
    const asker = await ctx.requirePerson(), me = personKeyString(asker), context = this.core.groupContext(ctx);
    const askerPermit = await this.core.groupAsker(asker, context);
    const rows = this.core.atomic(db => db.prepare(`${ROOM_VIEW_SQL} WHERE r.asker=? ORDER BY (r.state='active') DESC, last_at DESC LIMIT 100`).all(me) as RoomViewRow[]);
    const proofs = new Map<string, HubOperationPermit | null>();
    for (const row of rows) if (!proofs.has(row.exposure_id)) {
      try { proofs.set(row.exposure_id, await this.core.groupExposure(row.exposure_id, null, context)); }
      catch (e) { if (e instanceof HubProtocolError && (e.code === "denied" || e.code === "revoked")) proofs.set(row.exposure_id, null); else throw e; }
    }
    askerPermit.assertCurrent();
    return this.core.atomic(db => rows.flatMap(row => {
      const proof = proofs.get(row.exposure_id); if (proof === null) return [];
      proof?.assertCurrent();
      const fresh = db.prepare(`${ROOM_VIEW_SQL} WHERE r.id=? AND r.asker=?`).get(row.id, me) as RoomViewRow | undefined;
      return fresh ? [roomListItem(fresh, this.featuresOf(fresh.fleet_id))] : [];
    }), askerPermit);
  }

  /**
   * #3226 C (the user's choice): who asked one of the owner's agents, when, and how it went — never what was asked or
   * answered. The owner only (another person: not-found); the latest 20; the read is audited like any metadata read.
   */
  async activity(ctx: HubRequestContext, exposureId: string): Promise<readonly { askerName: string; askedAt: number; stage: HubReceipt["stage"] }[]> {
    const person = await ctx.requirePerson(), me = personKeyString(person);
    await ctx.current();
    return this.core.atomic((db, tx) => {
      const e = readExposure(db, exposureId);
      if (!e || e.owner !== me) throw new HubProtocolError("not-found");
      const rows = db.prepare(`SELECT m.created_at, m.stage, p.display_name FROM hub_messages m LEFT JOIN hub_people p ON p.person = m.asker
        WHERE m.exposure_id=? ORDER BY m.created_at DESC LIMIT 20`).all(exposureId) as { created_at: number; stage: HubReceipt["stage"]; display_name: string | null }[];
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person }, action: "exposure.activity-read", result: "completed",
        fleetId: e.fleet_id, exposureId, ownerAtEvent: person });
      return rows.map((r) => ({ askerName: r.display_name ?? "", askedAt: r.created_at, stage: r.stage }));
    });
  }

  /**
   * One room as `list` draws it — its asker only, else not-found (checked here, not left to the caller: the messages
   * route asks it after its own read, but this answers alone). The messages answer carries it, fresh each poll.
   */
  async view(ctx: HubRequestContext, roomId: string): Promise<HubRoomListItem> {
    const asker = await ctx.requirePerson(), me = personKeyString(asker);
    const row = this.core.atomic((db) => db.prepare(`${ROOM_VIEW_SQL} WHERE r.id=? AND r.asker=?`).get(roomId, me) as RoomViewRow | undefined);
    if (!row) throw new HubProtocolError("not-found");
    const permit = await this.core.groupExposure(row.exposure_id, asker, this.core.groupContext(ctx));
    return this.core.atomic(db => {
      const fresh = db.prepare(`${ROOM_VIEW_SQL} WHERE r.id=? AND r.asker=?`).get(roomId, me) as RoomViewRow | undefined;
      if (!fresh) throw new HubProtocolError("not-found");
      return roomListItem(fresh, this.featuresOf(fresh.fleet_id));
    }, permit);
  }

  /** What the room's fleet link negotiated (D's link.features, #3241): none while it has no current link. */
  private featuresOf(fleetId: string): readonly string[] {
    return [...this.features(fleetId)].sort();
  }

  /** Ask in a room: committed with its audit before "queued" is reported; then sent if the member is on. */
  async ask(ctx: HubRequestContext, roomId: string, idempotencyKey: string, text: string, fileIds: readonly string[] = []): Promise<HubReceipt> {
    if (fileIds.length) this.store();
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > HUB_LIMITS.question || !scalarString(text)) throw new HubProtocolError("invalid");
    if (!/^[a-f0-9-]{36}$/.test(idempotencyKey)) throw new HubProtocolError("invalid");
    const asker = await ctx.requirePerson(), me = personKeyString(asker);
    const room = this.core.atomic((db) => db.prepare("SELECT * FROM hub_rooms WHERE id=?").get(roomId) as RoomRow | undefined);
    if (!room || room.asker !== me) throw new HubProtocolError("not-found");
    const ownerId = this.core.atomic((db) => readExposure(db, room.exposure_id)?.owner);
    if (!ownerId || !(await this.core.eligible(personFromString(ownerId)))) throw new HubProtocolError("revoked");
    await ctx.current();
    const permit = await this.core.groupExposure(room.exposure_id, asker, this.core.groupContext(ctx));
    const out = this.core.atomic((db, tx) => this.insertQuestion(db, tx, {
      roomId, asker, idempotencyKey, text, requestId: ctx.requestId, actor: { kind: "person", person: asker },
    }, fileIds), permit);
    if (out.fleet) void this.flush(out.fleet);
    return out.receipt;
  }

  /** One queue/receipt/audit path for typed asks, button clicks and authorized automatic poll results. */
  private insertQuestion(db: Database.Database, tx: HubTx, input: HubButtonQuestion, fileIds: readonly string[] = []): { receipt: HubReceipt; fleet: string | null } {
    const { roomId, asker, idempotencyKey, text } = input, now = this.core.now(), me = personKeyString(asker), store = this.core.deps.attachments;
    if (!text.trim() || Buffer.byteLength(text, "utf8") > HUB_LIMITS.question || !scalarString(text) || !/^[a-f0-9-]{36}$/.test(idempotencyKey)) throw new HubProtocolError("invalid");
    // Current room/grant checks precede idempotent returns as well: an old request never restores revoked access.
    const { exposure, grant } = this.askerRoom(db, roomId, asker, now, "ask");
    const dup = db.prepare("SELECT * FROM hub_messages WHERE room_id=? AND idempotency_key=?").get(roomId, idempotencyKey) as MessageRow | undefined;
    if (dup) {
      const bound = store?.forMessage(db, dup.id, "question") ?? [];
      if (dup.content_digest !== messageContentDigest("question", text, { attachments: bound }) || bound.map(f => f.id).join() !== fileIds.join()) throw new HubProtocolError("conflict");
      return { receipt: receiptOf(dup), fleet: null };
    }
    const files = fileIds.length ? (this.requireFiles(exposure.fleetId), store!.pending(db, roomId, me, fileIds)) : [];
    const digest = messageContentDigest("question", text, { attachments: files });
    const sequence = ((db.prepare("SELECT MAX(sequence) AS n FROM hub_messages WHERE room_id=?").get(roomId) as { n: number | null }).n ?? 0) + 1;
    const id = randomUUID(), ref = this.core.deps.content.put(tx, { question: text });
    if (files.length) store!.bindQuestion(db, files, id, exposure.fleetId);
    db.prepare(`INSERT INTO hub_messages(id, room_id, idempotency_key, sequence, fleet_id, exposure_id, exposure_revision, grant_id, grant_revision, asker, owner,
      content_digest, question_ref, stage, stage_at, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`)
      .run(id, roomId, idempotencyKey, sequence, exposure.fleetId, exposure.id, exposure.revision, grant.id, grant.revision, me, personKeyString(exposure.owner), digest, ref, now, now, now + QUESTION_LIFETIME_MS);
    this.core.audit(tx, { requestId: input.requestId, actor: input.actor, action: "question.accepted", result: "allowed",
      messageId: id, roomId, fleetId: exposure.fleetId, exposureId: exposure.id, ownerAtEvent: exposure.owner, grantId: grant.id, grantRevision: grant.revision, contentRef: ref });
    return { receipt: { messageId: id, contentDigest: digest, stage: "queued", sequence: 0, at: now }, fleet: exposure.fleetId };
  }

  /** The room's entries after `after`, for its asker only — both people and the grant re-checked; paced per session. */
  async read(ctx: HubRequestContext, roomId: string, after: number, sessionKey: string): Promise<readonly HubRoomEntryView[]> {
    if (!Number.isSafeInteger(after) || after < 0) throw new HubProtocolError("invalid");
    const asker = await ctx.requirePerson(), me = personKeyString(asker), now = this.core.now();
    const room = this.core.atomic((db) => db.prepare("SELECT * FROM hub_rooms WHERE id=?").get(roomId) as RoomRow | undefined);
    if (!room || room.asker !== me) throw new HubProtocolError("not-found");
    const pace = `${sessionKey}:${roomId}`, last = this.polls.get(pace);
    if (last !== undefined && now - last < ROOM_POLL_MS) throw new HubProtocolError("backpressure");
    this.polls.set(pace, now);
    if (this.polls.size > 8192) for (const [k, v] of this.polls) if (now - v >= ROOM_POLL_MS) this.polls.delete(k);
    const ownerId = this.core.atomic((db) => readExposure(db, room.exposure_id)?.owner);
    if (!ownerId || !(await this.core.eligible(personFromString(ownerId)))) throw new HubProtocolError("revoked");
    await ctx.current();
    const permit = await this.core.groupExposure(room.exposure_id, asker, this.core.groupContext(ctx));
    const rows = this.core.atomic((db) => {
      const r = db.prepare("SELECT * FROM hub_rooms WHERE id=?").get(roomId) as RoomRow;
      const e = readExposure(db, r.exposure_id), g = readGrant(db, r.grant_id);
      if (r.state !== "active" || !e || !g) throw new HubProtocolError("revoked");
      const grant = grantOf(g), exposure = exposureOf(e);
      // History stays readable while the grant does (a later exposure revision or a freeze stops new questions only).
      if (grant.state !== "active" || now >= grant.expiresAt || personKeyString(grant.subject.person) !== me || !grant.permissions.includes("read-own-room")
        || exposure.state === "withdrawn") throw new HubProtocolError("revoked");
      return db.prepare("SELECT * FROM hub_messages WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 100").all(roomId, after) as MessageRow[];
    });
    const store = this.core.deps.attachments;
    const files = store ? this.core.atomic((db) => new Map(rows.map(m => [m.id, { question: store.forMessage(db, m.id, "question"), answer: store.forMessage(db, m.id, "answer") }]))) : null;
    const views = this.core.atomic(db => new Map(rows.map(m => [m.id, this.buttons.view(db, m.id)])));
    // The exact agent prompt stays in durable delivery, not in the asker's prose. Use the server-owned result
    // binding (including pre-existing rows), never a text prefix a person could also type. Bound the projection
    // query to this authorized page; no schema or delivery/digest change is needed.
    const pollResults = rows.length ? this.core.atomic(db => new Set((db.prepare(`SELECT result_message_id FROM hub_answer_buttons
      WHERE room_id=? AND result_message_id IN (${rows.map(() => "?").join(",")})`).all(roomId, ...rows.map(m => m.id)) as { result_message_id: string }[])
      .map(row => row.result_message_id))) : new Set<string>();
    const entries = rows.map((m) => {
      const q = this.core.deps.content.get(m.question_ref), a = m.answer_ref ? this.core.deps.content.get(m.answer_ref) : undefined;
      const expired = q === undefined || (m.answer_ref !== null && a === undefined);
      // #3226 B: when it was asked (the chat's time on the question), beside the receipt's stage time; D: the files, as B maps them.
      const f = files?.get(m.id), qf = f?.question.map(r => fileView(roomId, r)) ?? [], af = f?.answer.map(r => fileView(roomId, r)) ?? [];
      return { messageId: m.id, sequence: m.sequence, receipt: receiptOf(m), askedAt: m.created_at, ...(views.get(m.id) ? { buttons: views.get(m.id) } : {}),
        // Explicit blank also replaces the old prompt in a cached tab's merged entry; old renderers show no text.
        ...(pollResults.has(m.id) ? { pollResult: true as const, question: "" } : q?.question !== undefined ? { question: q.question } : {}),
        ...(a?.answer !== undefined ? { answer: a.answer } : {}), ...(expired ? { expired: true } : {}),
        ...(qf.length ? { questionFiles: qf } : {}), ...(af.length ? { answerFiles: af } : {}) };
    });
    permit.assertCurrent(); return entries;
  }

  /**
   * Send this fleet's queued questions over its current, reconciled link (one flush at a time per fleet). Questions
   * whose facts no longer hold are cancelled. Expired ones fail. Without a transport or a current link nothing moves.
   */
  /** Resolves false when a send was refused (the link not ready yet, or gone): the caller may try again shortly. */
  async flush(fleetId: string): Promise<boolean> {
    if (this.flushing.has(fleetId)) return true;
    this.flushing.add(fleetId);
    try {
      const link = this.links.get(fleetId);
      if (!link || !link.current() || !this.core.deps.transport()) return false;
      const pending = this.core.atomic((db) => db.prepare("SELECT * FROM hub_messages WHERE fleet_id=? AND stage='queued' AND sent_epoch<>? ORDER BY created_at LIMIT 32")
        .all(fleetId, link.linkEpoch) as MessageRow[]);
      for (const first of pending) {
        if (!link.current()) return false;
        let eligible = true, permit: HubOperationPermit | undefined;
        try { permit = await this.policy.operation(first, link); }
        catch (e) {
          if (e instanceof HubProtocolError && e.code === "revoked") eligible = false;
          else return false; // Group unknown/denied holds the queue; never fabricates delivery or cancellation.
        }
        const now = this.core.now();
        const frame = this.core.atomic((db, tx): HubServerFrame | null => {
          const msg = readMessage(db, first.id);
          if (!msg || msg.stage !== "queued" || msg.sent_epoch === link.linkEpoch || !link.current()) return null;
          const facts = eligible ? messageFacts(db, msg, now) : { ok: false as const, reason: "revoked" as const };
          if (!facts.ok) {
            const stage = facts.reason === "expired" ? "failed" : "cancelled";
            db.prepare("UPDATE hub_messages SET stage=?, reason_code=?, stage_at=? WHERE id=?").run(stage, facts.reason, now, msg.id);
            this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "local-host" }, action: `question.${stage}`, result: "held", reasonCode: facts.reason,
              messageId: msg.id, roomId: msg.room_id, fleetId, exposureId: msg.exposure_id, ownerAtEvent: personFromString(msg.owner), grantId: msg.grant_id, grantRevision: msg.grant_revision });
            return null;
          }
          const text = this.core.deps.content.get(msg.question_ref)?.question;
          const files = this.core.deps.attachments?.forMessage(db, msg.id, "question") ?? [];
          if (files.length && !link.features.has(FILES)) {
            // The fleet's link no longer takes files (an older member reconnected): fail it visibly, never send it without them.
            db.prepare("UPDATE hub_messages SET stage='failed', reason_code='incompatible', stage_at=? WHERE id=?").run(now, msg.id);
            this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "local-host" }, action: "question.failed", result: "held", reasonCode: "incompatible",
              messageId: msg.id, roomId: msg.room_id, fleetId, exposureId: msg.exposure_id, ownerAtEvent: personFromString(msg.owner), grantId: msg.grant_id, grantRevision: msg.grant_revision });
            return null;
          }
          if (text === undefined || messageContentDigest("question", text, { attachments: files }) !== msg.content_digest) throw new HubProtocolError("uncertain");
          const identity = this.core.deps.issuer.sign({ v: 1, issuer: this.core.deps.config.hubId, issuerKeyId: this.core.deps.issuer.keyId, messageId: msg.id,
            asker: personFromString(msg.asker), owner: personFromString(msg.owner), destinationFleetId: fleetId, exposureId: msg.exposure_id, roomId: msg.room_id,
            grantId: msg.grant_id, grantRevision: msg.grant_revision, exposureRevision: msg.exposure_revision, revocationVersion: this.core.revocationVersion(),
            contentDigest: msg.content_digest, issuedAt: now, expiresAt: now + ENVELOPE_MS, nonce: randomBytes(32).toString("hex") });
          return { v: 1, type: "question", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: { text, identity, ...(files.length ? { attachments: files } : {}) } };
        });
        if (!frame) continue;
        try { permit?.assertCurrent(); } catch { return false; }
        const transport = this.core.deps.transport();
        if (!transport || !link.current()) return false;
        // Socket acceptance only. Recorded as sent on this link after S1 accepted it; a crash in between re-sends the
        // same message id, which the member dedups.
        try { permit?.assertCurrent(); await transport.send(fleetId, frame); } catch { return false; }
        this.core.atomic((db, tx) => {
          db.prepare("UPDATE hub_messages SET sent_epoch=? WHERE id=? AND stage='queued'").run(link.linkEpoch, first.id);
          this.core.audit(tx, { requestId: frame.requestId, actor: { kind: "local-host" }, action: "question.sent", result: "allowed",
            messageId: first.id, roomId: first.room_id, fleetId, exposureId: first.exposure_id, ownerAtEvent: personFromString(first.owner), grantId: first.grant_id, grantRevision: first.grant_revision });
        });
      }
      return true;
    } finally { this.flushing.delete(fleetId); }
  }

  /** A member's receipt: its own durable evidence for one of the messages sent to it. Echoed back as the ACK. */
  receipt(r: HubReceipt, link: HubLinkContext): HubReceipt {
    const now = this.core.now();
    return this.core.atomic((db, tx) => {
      const msg = readMessage(db, r.messageId);
      if (!msg || msg.fleet_id !== link.fleetId) throw new HubProtocolError("not-found");
      if (msg.content_digest !== r.contentDigest) throw new HubProtocolError("conflict");
      const seen = db.prepare("SELECT message_id, stage, content_digest FROM hub_receipts WHERE fleet_id=? AND sequence=?").get(link.fleetId, r.sequence) as { message_id: string; stage: string; content_digest: string } | undefined;
      if (seen) {
        if (seen.message_id !== r.messageId || seen.stage !== r.stage || seen.content_digest !== r.contentDigest) throw new HubProtocolError("conflict");
        return r;                                          // the same evidence again: the same ACK
      }
      if (r.sequence <= msg.member_sequence) throw new HubProtocolError("stale");
      const known = RANK[msg.stage] ?? 0, next = RANK[r.stage] ?? 0;
      if (POSITIVE.includes(msg.stage) && next !== 0 && next < known) throw new HubProtocolError("stale");   // never downgrade evidence
      db.prepare("INSERT INTO hub_receipts(fleet_id, sequence, message_id, content_digest, stage, at, member_delivery_id, reason_code) VALUES(?,?,?,?,?,?,?,?)")
        .run(link.fleetId, r.sequence, r.messageId, r.contentDigest, r.stage, r.at, r.memberDeliveryId ?? null, r.reasonCode ?? null);
      const stage = msg.stage === "answered" && r.stage !== "answered" && !TERMINAL.has(r.stage) ? msg.stage : r.stage;
      db.prepare("UPDATE hub_messages SET stage=?, member_sequence=?, reason_code=?, stage_at=? WHERE id=?").run(stage, r.sequence, r.reasonCode ?? null, now, msg.id);
      this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "member", fleetId: link.fleetId }, action: `receipt.${r.stage}`, result: r.stage === "uncertain" ? "held" : "completed",
        reasonCode: r.reasonCode, messageId: msg.id, roomId: msg.room_id, fleetId: link.fleetId, exposureId: msg.exposure_id, ownerAtEvent: personFromString(msg.owner),
        grantId: msg.grant_id, grantRevision: msg.grant_revision });
      return r;
    });
  }

  /** A member's final answer, accepted only under the Hub's own release lease for exactly it, authorization still holding. */
  async answer(a: HubAnswer, link: HubLinkContext): Promise<HubReceipt> {
    a = validated(answerSchema, a); // owned snapshot before the directory await; caller mutation cannot alter released metadata
    if (messageContentDigest("answer", a.text, { attachments: a.attachments, buttonsDigest: buttonsDigest(a.buttons) }) !== a.contentDigest) throw new HubProtocolError("invalid");
    if (a.buttons && !link.features.has("buttons-v1")) throw new HubProtocolError("incompatible");
    const first = this.core.atomic((db) => readMessage(db, a.messageId));
    if (!first || first.fleet_id !== link.fleetId) throw new HubProtocolError("not-found");
    if (first.answer_id) {
      if (first.answer_id !== a.answerId || first.answer_digest !== a.contentDigest) throw new HubProtocolError("conflict");
      return { ...receiptOf(first), contentDigest: first.content_digest, stage: "answered", sequence: Math.max(1, first.member_sequence) };
    }
    const permit = await this.policy.operation(first, link);
    if (!link.current()) throw new HubProtocolError("stale");
    const now = this.core.now();
    const receipt = this.core.atomic((db, tx) => {
      const msg = readMessage(db, a.messageId)!;
      this.policy.spendReleaseLease(db, a.releaseLease, a, link, now);
      if (msg.answer_id) {
        if (msg.answer_id !== a.answerId || msg.answer_digest !== a.contentDigest) throw new HubProtocolError("conflict");
      } else {
        const facts = messageFacts(db, msg, now);
        if (!facts.ok) throw new HubProtocolError(facts.reason);
        const ref = this.core.deps.content.put(tx, { answer: a.text, ...(a.buttons ? { buttons: a.buttons } : {}) });
        if (a.attachments?.length) {
          if (!link.features.has(FILES)) throw new HubProtocolError("incompatible");
          this.store().bindAnswer(db, a.attachments, msg.id, msg.room_id, link.fleetId);
          for (const f of a.attachments) this.core.audit(tx, { requestId: a.releaseLease.decisionId, actor: { kind: "member", fleetId: link.fleetId }, action: "file.transfer", result: "completed",
            reasonCode: `answer:${f.size}:${f.mime}:${f.sha256}`, contentRef: this.core.deps.content.put(tx, { answer: f.name }), messageId: msg.id, roomId: msg.room_id, fleetId: link.fleetId,
            exposureId: msg.exposure_id, ownerAtEvent: personFromString(msg.owner), grantId: msg.grant_id, grantRevision: msg.grant_revision });
        }
        this.buttons.record(db, tx, msg, a, now);
        db.prepare("UPDATE hub_messages SET answer_id=?, answer_digest=?, answer_ref=?, stage='answered', stage_at=? WHERE id=?").run(a.answerId, a.contentDigest, ref, now, msg.id);
        this.core.audit(tx, { requestId: a.releaseLease.decisionId, actor: { kind: "member", fleetId: link.fleetId }, action: "answer.accepted", result: "completed",
          messageId: msg.id, roomId: msg.room_id, fleetId: link.fleetId, exposureId: msg.exposure_id, ownerAtEvent: personFromString(msg.owner),
          grantId: msg.grant_id, grantRevision: msg.grant_revision, contentRef: ref });
      }
      const done = readMessage(db, a.messageId)!;
      return { messageId: done.id, contentDigest: done.content_digest, stage: "answered" as const, sequence: Math.max(1, done.member_sequence), at: done.stage_at };
    }, permit);
    this.buttons.arm();
    return receipt;
  }

  /** attachments-v1: the member pulls one chunk of a file of a question sent to its fleet (in order, one in flight).
   * Every chunk is a disclosure: both people eligible now, the current link, and the message's room/grant/exposure facts
   * (messageFacts, as for sending) re-checked at the moment the bytes are read — a revoked grant stops the next chunk. */
  async attachmentGet(input: { id: string; offset: number }, link: HubLinkContext): Promise<HubAttachmentChunk> {
    if (!link.features.has(FILES)) throw new HubProtocolError("incompatible");
    const store = this.store();
    const located = this.core.atomic((db) => { const row = store.row(db, input.id); return { row, msg: row?.message_id ? readMessage(db, row.message_id) : undefined }; });
    const ours = (row: typeof located.row, msg: typeof located.msg) => !!row && row.direction === "question" && row.state === "bound" && !!msg && msg.fleet_id === link.fleetId;
    if (!ours(located.row, located.msg)) throw new HubProtocolError("not-found");
    const permit = await this.policy.operation(located.msg!, link);
    if (!link.current()) throw new HubProtocolError("stale");
    const now = this.core.now();
    return this.core.atomic((db, tx) => {
      const row = store.row(db, input.id), msg = row?.message_id ? readMessage(db, row.message_id) : undefined;
      if (!ours(row, msg) || row!.message_id !== located.msg!.id) throw new HubProtocolError("not-found");
      const facts = messageFacts(db, msg!, now);
      if (!facts.ok) throw new HubProtocolError(facts.reason);
      if (!link.current()) throw new HubProtocolError("stale");
      const chunk = store.chunk(db, row!.sha256, input.offset);
      if (input.offset === 0) this.core.audit(tx, { requestId: randomUUID(), actor: { kind: "member", fleetId: link.fleetId }, action: "file.transfer", result: "allowed",
        reasonCode: `question:${row!.size}:${row!.mime}:${row!.sha256}`, messageId: msg!.id, roomId: msg!.room_id, fleetId: link.fleetId, exposureId: msg!.exposure_id,
        ownerAtEvent: personFromString(msg!.owner), grantId: msg!.grant_id, grantRevision: msg!.grant_revision });
      return { id: row!.id, offset: input.offset, total: chunk.total, sha256: row!.sha256, data: chunk.data.toString("base64") };
    }, permit);
  }
  /** attachments-v1: one chunk of an answer's file from the member, before the answer that names it. */
  attachmentPut(input: HubAttachmentChunk, link: HubLinkContext): { id: string; offset: number } {
    if (!link.features.has(FILES)) throw new HubProtocolError("incompatible");
    const store = this.store(), data = b64(input.data);
    const staged = this.core.atomic((db) => store.stage(db, link.fleetId, { id: input.id, offset: input.offset, total: input.total, sha256: input.sha256, data }));
    if (staged.discarded) throw new HubProtocolError("invalid");             // after its own commit dropped the chunks
    return { id: input.id, offset: input.offset };
  }

  /** The member's reconcile page: the retained receipts after its cursor (the Hub's ACKs), at most 128 per page. */
  reconcile(input: HubReconcile, link: HubLinkContext): HubReconcileReply {
    return this.core.atomic((db) => {
      for (const m of input.messages) {
        const msg = readMessage(db, m.messageId);
        if (msg && (msg.fleet_id !== link.fleetId || msg.content_digest !== m.contentDigest)) throw new HubProtocolError("conflict");
      }
      const rows = db.prepare("SELECT * FROM hub_receipts WHERE fleet_id=? AND sequence>? ORDER BY sequence LIMIT 129").all(link.fleetId, input.afterReceiptSequence) as
        { sequence: number; message_id: string; content_digest: string; stage: HubReceipt["stage"]; at: number; member_delivery_id: string | null; reason_code: string | null }[];
      const page = rows.slice(0, 128);
      return { receipts: page.map((r) => ({ messageId: r.message_id, contentDigest: r.content_digest, stage: r.stage, sequence: r.sequence, at: r.at,
        ...(r.member_delivery_id ? { memberDeliveryId: r.member_delivery_id } : {}), ...(r.reason_code ? { reasonCode: r.reason_code } : {}) })),
        nextReceiptSequence: page.length ? page[page.length - 1]!.sequence : input.afterReceiptSequence, more: rows.length > 128 };
    });
  }
}
