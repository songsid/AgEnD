/** M-3341 A1: person-scoped requests, independent of an owner's agent inventory. Unmounted until A2. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { HubCore } from "./http/core.js";
import { personFromString } from "./http/core.js";
import type { HubHttpMigration } from "./http/schema.js";
import type { HubRequestContext, PersonKey } from "./types.js";
import type { RoomInvitationHost, RoomInvitationChange, RoomInvitationRoom } from "./invitations.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError, uuid, validated } from "./validation.js";
import { HubRoomRefusal } from "./rooms/service.js";

type DB = Database.Database;
type State = "pending" | "accepted" | "declined" | "cancelled" | "expired";
interface Row {
  id: string; room_id: string; owner: string; owner_name: string; by_person: string; by_name: string;
  note_ref: string | null; idempotency_key: string; digest: string; created_at: number; expires_at: number;
  state: State; exposure_id: string | null;
}
export interface RoomAgentRequest {
  id: string; owner: { id: string; name: string }; by: { name: string };
  at: number; expiresAt: number; state: State;
}
export interface OwnerAgentRequest extends RoomAgentRequest {
  kind: "owner-request"; room: RoomInvitationRoom; note: string;
}
export interface AgentRequestPage<T> { requests: readonly T[]; next: string | null }
export const ROOM_AGENT_REQUEST_TTL = 7 * 86_400_000;
export const ROOM_AGENT_REQUESTS_PER_DAY = 5;
const DAY = 86_400_000, PAGE = 100;
const ownerId = z.string().max(128).refine(s => /^[a-z][a-z0-9_-]{0,63}\/[a-f0-9-]{36}$/.test(s));
const requestSchema = z.strictObject({
  owner: ownerId, note: z.string().max(100).trim().refine(s => !/[\u0000-\u001f\u007f]/.test(s)).default(""),
  idempotencyKey: uuid,
});
const settingsSchema = z.strictObject({ accepting: z.boolean() });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const read = (db: DB, id: string) => db.prepare("SELECT * FROM hub_room_agent_requests WHERE id=?").get(id) as Row | undefined;
const summary = (row: Row): RoomAgentRequest => ({
  id: row.id, owner: { id: row.owner, name: row.owner_name }, by: { name: row.by_name },
  at: row.created_at, expiresAt: row.expires_at, state: row.state,
});

export const HUB_ROOM_AGENT_REQUESTS_MIGRATION: HubHttpMigration = Object.freeze({
  component: "s3-room-agent-requests", version: 1,
  up(db: DB) {
    db.exec([
      "CREATE TABLE hub_room_agent_requests (",
      " id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES hub_group_rooms(id) ON DELETE CASCADE,",
      " owner TEXT NOT NULL,owner_name TEXT NOT NULL,by_person TEXT NOT NULL,by_name TEXT NOT NULL,note_ref TEXT,",
      " idempotency_key TEXT NOT NULL,digest TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,",
      " state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined','cancelled','expired')),exposure_id TEXT,",
      " UNIQUE(by_person,idempotency_key));",
      "CREATE UNIQUE INDEX hub_room_agent_request_pending ON hub_room_agent_requests(room_id,owner) WHERE state='pending';",
      "CREATE INDEX hub_room_agent_request_owner ON hub_room_agent_requests(owner,state,created_at,id);",
      "CREATE INDEX hub_room_agent_request_room ON hub_room_agent_requests(room_id,state,created_at,id);",
      "CREATE TABLE hub_room_agent_request_settings(owner TEXT PRIMARY KEY,accepting INTEGER NOT NULL CHECK(accepting IN(0,1)),revision INTEGER NOT NULL);",
      "CREATE TABLE hub_room_agent_request_days(manager TEXT NOT NULL,day INTEGER NOT NULL,sends INTEGER NOT NULL CHECK(sends BETWEEN 0 AND 5),PRIMARY KEY(manager,day));",
    ].join("\n"));
  },
});

export interface HubRoomAgentRequests {
  request(ctx: HubRequestContext, roomId: string, input: unknown): Promise<{ request: RoomAgentRequest }>;
  forRoom(ctx: HubRequestContext, roomId: string, cursor?: string): Promise<AgentRequestPage<RoomAgentRequest>>;
  pending(ctx: HubRequestContext, cursor?: string): Promise<AgentRequestPage<OwnerAgentRequest>>;
  cancel(ctx: HubRequestContext, roomId: string, id: string): Promise<{ ok: true }>;
  settings(ctx: HubRequestContext, input?: unknown): Promise<{ accepting: boolean }>;
  /** Mounting must wire these refs into content retention before requests become available. */
  retainedNoteRefs(): readonly string[];
}
export const createHubRoomAgentRequests = (core: HubCore, host: RoomInvitationHost): HubRoomAgentRequests =>
  new RoomAgentRequests(core, host);

class RoomAgentRequests implements HubRoomAgentRequests {
  constructor(private readonly core: HubCore, private readonly host: RoomInvitationHost) {}
  private fence(ctx: HubRequestContext) { return { assertCurrent: () => {
    this.core.check(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
  } }; }
  private async who(ctx: HubRequestContext): Promise<{ person: PersonKey; id: string }> {
    const person = await ctx.requirePerson(); this.fence(ctx).assertCurrent(); return { person, id: personKeyString(person) };
  }
  private now(): number {
    const value = this.core.now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + ROOM_AGENT_REQUEST_TTL)) throw new HubProtocolError("unavailable");
    return value;
  }
  private preference(db: DB, owner: string) {
    const row = db.prepare("SELECT accepting,revision FROM hub_room_agent_request_settings WHERE owner=?").get(owner) as { accepting: number; revision: number } | undefined;
    return row ?? { accepting: 1, revision: 0 };
  }
  private name(db: DB, person: string): string {
    return (db.prepare("SELECT display_name FROM hub_people WHERE person=? UNION ALL SELECT display_name FROM hub_room_people WHERE person=? LIMIT 1")
      .get(person, person) as { display_name: string } | undefined)?.display_name ?? "";
  }
  private changes(db: DB, row: Row): RoomInvitationChange[] {
    const managers = db.prepare("SELECT subject FROM hub_room_members WHERE room_id=? AND kind='person' AND role='manager'").all(row.room_id) as { subject: string }[];
    return [...new Set([row.owner, ...managers.map(m => m.subject)])].map(ownerId => ({ roomId: row.room_id, ownerId, membershipChanged: false }));
  }
  private publish(changes: readonly RoomInvitationChange[]): void {
    for (const value of changes) { try { this.host.changed(value); } catch { /* A committed request survives a disconnected viewer. */ } }
  }
  private expire(ctx: HubRequestContext, actor: string, roomId?: string): void {
    const changes = this.core.atomic(db => {
      if (roomId) this.host.managerRoom(db, roomId, actor);
      const rows = db.prepare("SELECT * FROM hub_room_agent_requests WHERE state='pending' AND expires_at<=? AND " + (roomId ? "room_id=?" : "owner=?"))
        .all(this.now(), roomId ?? actor) as Row[];
      for (const row of rows) db.prepare("UPDATE hub_room_agent_requests SET state='expired' WHERE id=? AND state='pending'").run(row.id);
      return rows.flatMap(row => this.changes(db, row));
    }, this.fence(ctx));
    this.publish(changes);
  }
  private page(db: DB, column: "owner" | "room_id", value: string, cursor: string | undefined, states: string): AgentRequestPage<Row> {
    let at = this.now() + 1, id = "";
    if (cursor !== undefined) {
      validated(uuid, cursor);
      const row = read(db, cursor);
      if (!row || row[column] !== value) throw new HubProtocolError("invalid");
      at = row.created_at; id = row.id;
    }
    const rows = db.prepare("SELECT * FROM hub_room_agent_requests WHERE " + column + "=? AND " + states +
      " AND created_at<=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(value, this.now(), at, at, id, PAGE + 1) as Row[];
    return { requests: rows.slice(0, PAGE), next: rows.length > PAGE ? rows[PAGE - 1]!.id : null };
  }
  async settings(ctx: HubRequestContext, input?: unknown) {
    const actor = await this.who(ctx), setting = input === undefined ? null : validated(settingsSchema, input);
    return this.core.atomic((db, tx) => {
      const old = this.preference(db, actor.id);
      if (setting && old.accepting !== Number(setting.accepting)) {
        const revision = old.revision + 1;
        db.prepare("INSERT INTO hub_room_agent_request_settings VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET accepting=excluded.accepting,revision=excluded.revision")
          .run(actor.id, Number(setting.accepting), revision);
        this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "room.agent-request-settings", result: "completed" });
        if (!equal(this.preference(db, actor.id), { accepting: Number(setting.accepting), revision })) throw new HubProtocolError("conflict");
      }
      return { accepting: setting?.accepting ?? old.accepting === 1 };
    }, this.fence(ctx));
  }
  async request(ctx: HubRequestContext, roomId: string, input: unknown) {
    validated(uuid, roomId); const body = validated(requestSchema, input), actor = await this.who(ctx);
    this.expire(ctx, actor.id, roomId);
    const owner = personFromString(body.owner), recipient = await this.core.current(owner);
    await ctx.current(); this.fence(ctx).assertCurrent();
    if (!recipient) throw new HubProtocolError("not-found");
    const digest = createHash("sha256").update(JSON.stringify([roomId, body.owner, body.note])).digest("hex");
    const out = this.core.atomic((db, tx) => {
      const room = this.host.managerRoom(db, roomId, actor.id), now = this.now(), day = Math.floor(now / DAY);
      const replay = db.prepare("SELECT * FROM hub_room_agent_requests WHERE by_person=? AND idempotency_key=?").get(actor.id, body.idempotencyKey) as Row | undefined;
      if (replay) {
        if (replay.digest !== digest) throw new HubRoomRefusal(409, "idempotency-conflict");
        if (now < replay.created_at) throw new HubProtocolError("uncertain");
        return { request: summary(replay), changes: [] };
      }
      const preference = this.preference(db, body.owner);
      if (!preference.accepting) throw new HubRoomRefusal(409, "owner-not-taking-requests");
      if (db.prepare("SELECT 1 FROM hub_room_agent_requests WHERE room_id=? AND owner=? AND state='pending'").get(roomId, body.owner))
        throw new HubRoomRefusal(409, "request-open");
      const sends = (db.prepare("SELECT sends FROM hub_room_agent_request_days WHERE manager=? AND day=?").get(actor.id, day) as { sends: number } | undefined)?.sends ?? 0;
      if (sends >= ROOM_AGENT_REQUESTS_PER_DAY) throw new HubRoomRefusal(429, "request-limit", { resetsAt: (day + 1) * DAY });
      const row: Row = {
        id: randomUUID(), room_id: roomId, owner: body.owner, owner_name: recipient.displayName || this.name(db, body.owner) || recipient.login,
        by_person: actor.id, by_name: this.name(db, actor.id),
        note_ref: body.note ? this.core.deps.content.put(tx, { question: body.note }) : null,
        idempotency_key: body.idempotencyKey, digest, created_at: now, expires_at: now + ROOM_AGENT_REQUEST_TTL, state: "pending", exposure_id: null,
      };
      db.prepare("INSERT INTO hub_room_agent_requests VALUES(@id,@room_id,@owner,@owner_name,@by_person,@by_name,@note_ref,@idempotency_key,@digest,@created_at,@expires_at,@state,@exposure_id)").run(row);
      db.prepare("INSERT INTO hub_room_agent_request_days VALUES(?,?,1) ON CONFLICT(manager,day) DO UPDATE SET sends=sends+1").run(actor.id, day);
      this.core.audit(tx, { requestId: row.id, actor: { kind: "person", person: actor.person }, action: "room.agent-request-created", result: "completed",
        roomId, ownerAtEvent: owner, ...(row.note_ref ? { contentRef: row.note_ref } : {}) });
      if (!equal(read(db, row.id), row) || !equal(this.preference(db, body.owner), preference) || !equal(this.host.managerRoom(db, roomId, actor.id), room))
        throw new HubProtocolError("conflict");
      if ((db.prepare("SELECT sends FROM hub_room_agent_request_days WHERE manager=? AND day=?").get(actor.id, day) as { sends: number } | undefined)?.sends !== sends + 1)
        throw new HubProtocolError("conflict");
      if (this.now() < now || Math.floor(this.now() / DAY) !== day) throw new HubProtocolError("uncertain");
      return { request: summary(row), changes: this.changes(db, row) };
    }, this.fence(ctx));
    this.publish(out.changes); return { request: out.request };
  }
  async forRoom(ctx: HubRequestContext, roomId: string, cursor?: string) {
    validated(uuid, roomId); const actor = await this.who(ctx); this.expire(ctx, actor.id, roomId);
    return this.core.atomic(db => {
      this.host.managerRoom(db, roomId, actor.id);
      const page = this.page(db, "room_id", roomId, cursor, "state<>'cancelled'");
      return { ...page, requests: page.requests.map(summary) };
    }, this.fence(ctx));
  }
  async pending(ctx: HubRequestContext, cursor?: string) {
    const actor = await this.who(ctx); this.expire(ctx, actor.id);
    return this.core.atomic(db => {
      const page = this.page(db, "owner", actor.id, cursor, "state='pending'");
      const requests = page.requests.flatMap(row => {
        let room: RoomInvitationRoom;
        try { room = this.host.room(db, row.room_id); }
        catch (error) { if (error instanceof HubRoomRefusal && (error.code === "archived" || error.code === "not-found")) return []; throw error; }
        const note = row.note_ref ? this.core.deps.content.get(row.note_ref)?.question : "";
        if (typeof note !== "string" || createHash("sha256").update(JSON.stringify([row.room_id, row.owner, note])).digest("hex") !== row.digest)
          throw new HubProtocolError("unavailable");
        return [{ ...summary(row), kind: "owner-request" as const, room, note }];
      });
      return { ...page, requests };
    }, this.fence(ctx));
  }
  async cancel(ctx: HubRequestContext, roomId: string, id: string) {
    validated(uuid, roomId); validated(uuid, id); const actor = await this.who(ctx); this.expire(ctx, actor.id, roomId);
    const changes = this.core.atomic((db, tx) => {
      this.host.managerRoom(db, roomId, actor.id);
      const row = read(db, id);
      if (!row || row.room_id !== roomId) throw new HubProtocolError("not-found");
      if (row.state === "cancelled") return [];
      if (row.state !== "pending" || this.now() < row.created_at || this.now() >= row.expires_at) throw new HubProtocolError("not-found");
      db.prepare("UPDATE hub_room_agent_requests SET state='cancelled' WHERE id=?").run(id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "room.agent-request-cancelled", result: "completed", roomId });
      if (!equal(read(db, id), { ...row, state: "cancelled" })) throw new HubProtocolError("conflict");
      this.host.managerRoom(db, roomId, actor.id);
      if (this.now() < row.created_at || this.now() >= row.expires_at) throw new HubProtocolError("not-found");
      return this.changes(db, row);
    }, this.fence(ctx));
    this.publish(changes); return { ok: true as const };
  }
  retainedNoteRefs(): readonly string[] {
    return this.core.atomic(db => (db.prepare("SELECT note_ref FROM hub_room_agent_requests WHERE state='pending' AND expires_at>? AND note_ref IS NOT NULL")
      .all(this.now()) as { note_ref: string }[]).map(row => row.note_ref));
  }
}
