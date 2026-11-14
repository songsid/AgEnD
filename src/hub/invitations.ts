/** Track C seam 3: explicit owner consent. Importing this module mounts no routes or storage. */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { HubRequestContext, HubTx, PersonId, PersonKey } from "./types.js";
import type { HubCore } from "./http/core.js";
import type { HubHttpMigration } from "./http/schema.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError, uuid, validated } from "./validation.js";

export interface RoomInvitationRoom { readonly id: string; readonly name: string; readonly people: number }
export interface RoomInvitationExposure {
  readonly id: string; readonly name: string; readonly owner: { readonly id: PersonId; readonly name: string };
}
/** Owner-facing pending list. at is the invitation time; expiry is exactly seven days after it. */
export interface RoomInvitationView {
  readonly id: string; readonly room: RoomInvitationRoom;
  readonly agent: { readonly exposureId: string; readonly name: string };
  readonly by: { readonly name: string }; readonly at: number;
}
/** Manager-facing room detail keeps expired invitations so the manager can invite again. */
export interface RoomInvitedAgent {
  readonly id: string; readonly exposureId: string; readonly name: string;
  readonly owner: { readonly name: string }; readonly at: number; readonly state: "pending" | "expired";
}
export interface OwnerAgentRoom extends RoomInvitationRoom {
  /** Physical membership row ID, used for DELETE .../members/:memberId. */
  readonly memberId: string;
}
export interface RoomInvitationChange {
  readonly roomId: string; readonly ownerId: PersonId; readonly membershipChanged: boolean;
}

/**
 * R supplies synchronous room reads/effects over C's current core.atomic DB/transaction.
 * These reads are not reusable permits. C checks its current session, exact pending row,
 * owner, expiry and current publication again inside the same transaction that consumes it.
 */
export interface RoomInvitationHost {
  /** Require current manager membership; throw on a missing/archived room. */
  managerRoom(db: Database.Database, roomId: string, actor: PersonId): RoomInvitationRoom;
  /** Read the current room; throw on a missing/archived room. */
  room(db: Database.Database, roomId: string): RoomInvitationRoom;
  /** Require a current published exposure and return its exact immutable owner. */
  publishedExposure(db: Database.Database, exposureId: string): RoomInvitationExposure;
  /** Recheck room/publication/owner and add membership in the SAME invitation transaction. */
  addAgentMember(db: Database.Database, tx: HubTx, roomId: string, exposureId: string, owner: PersonId): void;
  /** Owner-only projection; owner is already freshly established by C. */
  roomsForExposure(db: Database.Database, exposureId: string, owner: PersonId): readonly OwnerAgentRoom[];
  /** C calls this only after commit. R publishes member/invitation events, never inside SQL. */
  changed(change: RoomInvitationChange): void;
}

/** The HTTP mount supplies its host and explicitly composes this service. */
export interface HubRoomInvitations {
  invite(ctx: HubRequestContext, roomId: string, input: { agents: readonly string[] } | { team: string }): Promise<{ invited: readonly RoomInvitedAgent[] }>;
  pending(ctx: HubRequestContext): Promise<{ invitations: readonly RoomInvitationView[] }>;
  forRoom(ctx: HubRequestContext, roomId: string): Promise<readonly RoomInvitedAgent[]>;
  accept(ctx: HubRequestContext, invitationId: string): Promise<{ ok: true }>;
  decline(ctx: HubRequestContext, invitationId: string): Promise<{ ok: true }>;
  cancel(ctx: HubRequestContext, roomId: string, invitationId: string): Promise<{ ok: true }>;
  roomsForExposure(ctx: HubRequestContext, exposureId: string): Promise<readonly OwnerAgentRoom[]>;
}

export const ROOM_INVITATION_TTL = 7 * 86_400_000;
export const HUB_ROOM_INVITATIONS_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-room-invitations", version: 1,
  up(db: Database.Database) { db.exec(`
CREATE TABLE hub_room_invitations (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES hub_group_rooms(id), exposure_id TEXT NOT NULL,
  owner TEXT NOT NULL, by_person TEXT NOT NULL, by_name TEXT NOT NULL, agent_name TEXT NOT NULL, owner_name TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined','cancelled','expired'))
);
CREATE UNIQUE INDEX hub_room_invitation_pending ON hub_room_invitations(room_id,exposure_id,owner) WHERE state='pending';
CREATE INDEX hub_room_invitation_owner ON hub_room_invitations(owner,state,created_at);
CREATE INDEX hub_room_invitation_room ON hub_room_invitations(room_id,state,created_at);
`); } });

type DB = Database.Database;
interface InvitationRow {
  id: string; room_id: string; exposure_id: string; owner: string; by_person: string;
  by_name: string; agent_name: string; owner_name: string; created_at: number; expires_at: number;
  state: "pending" | "accepted" | "declined" | "cancelled" | "expired";
}
const read = (db: DB, id: string) => db.prepare("SELECT * FROM hub_room_invitations WHERE id=?").get(id) as InvitationRow | undefined;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const invited = (row: InvitationRow): RoomInvitedAgent => ({ id: row.id, exposureId: row.exposure_id, name: row.agent_name,
  owner: { name: row.owner_name }, at: row.created_at, state: row.state === "expired" ? "expired" : "pending" });

export function createHubRoomInvitations(core: HubCore, host: RoomInvitationHost): HubRoomInvitations {
  return new RoomInvitations(core, host);
}

class RoomInvitations implements HubRoomInvitations {
  constructor(private readonly core: HubCore, private readonly host: RoomInvitationHost) {}
  private fence(ctx: HubRequestContext) { return { assertCurrent: () => {
    this.core.check(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
  } }; }
  private async who(ctx: HubRequestContext): Promise<{ person: PersonKey; id: string }> {
    const person = await ctx.requirePerson(); this.fence(ctx).assertCurrent(); return { person, id: personKeyString(person) };
  }
  private now(): number {
    const now = this.core.now(); if (!Number.isSafeInteger(now) || now < 0) throw new HubProtocolError("unavailable"); return now;
  }
  private name(db: DB, id: string): string {
    return (db.prepare("SELECT display_name FROM hub_people WHERE person=? UNION ALL SELECT display_name FROM hub_room_people WHERE person=? LIMIT 1")
      .get(id, id) as { display_name: string } | undefined)?.display_name ?? id;
  }
  private publish(changes: readonly RoomInvitationChange[]): void {
    for (const change of changes) { try { this.host.changed(change); } catch { /* a committed action survives a disconnected viewer */ } }
  }
  /** Persist observed expiry before an action can refuse it; rollback of that action cannot revive the invitation. */
  private expire(ctx: HubRequestContext, actor: string, id?: string, room?: string): void {
    const changes = this.core.atomic(db => {
      if (room) this.host.managerRoom(db, room, actor);
      const rows = db.prepare(`SELECT * FROM hub_room_invitations WHERE state='pending' AND expires_at<=?
        AND ${id ? "id=? AND owner=?" : room ? "room_id=?" : "owner=?"}`)
        .all(this.now(), ...(id ? [id, actor] : [room ?? actor])) as InvitationRow[];
      for (const row of rows) db.prepare("UPDATE hub_room_invitations SET state='expired' WHERE id=? AND state='pending'").run(row.id);
      return rows.map(row => ({ roomId: row.room_id, ownerId: row.owner, membershipChanged: false }));
    }, this.fence(ctx));
    this.publish(changes);
  }
  private owned(db: DB, id: string, owner: string): InvitationRow {
    const row = read(db, id); if (!row) throw new HubProtocolError("not-found");
    if (row.owner !== owner) throw new HubProtocolError("denied"); return row;
  }
  private pendingRow(row: InvitationRow, now = this.now()): void {
    if (row.state === "expired" || now >= row.expires_at) throw new HubProtocolError("not-found");
    if (now < row.created_at) throw new HubProtocolError("uncertain");
    if (row.state !== "pending") throw new HubProtocolError("not-found");
  }
  private sameRow(db: DB, row: InvitationRow): void {
    if (!equal(read(db, row.id), row)) throw new HubProtocolError("conflict");
  }
  private finalTime(row: InvitationRow): void {
    const now = this.now(); if (now < row.created_at || now >= row.expires_at) throw new HubProtocolError("not-found");
  }
  async invite(ctx: HubRequestContext, roomId: string, input: { agents: readonly string[] } | { team: string }) {
    validated(uuid, roomId); const actor = await this.who(ctx);
    if (!input || typeof input !== "object" || Object.keys(input).length !== 1) throw new HubProtocolError("invalid");
    this.expire(ctx, actor.id, undefined, roomId);
    const out = this.core.atomic((db, tx) => {
      const room = this.host.managerRoom(db, roomId, actor.id), now = this.now();
      if (!Number.isSafeInteger(now + ROOM_INVITATION_TTL)) throw new HubProtocolError("invalid");
      let agents: string[], teamImage: unknown = null;
      const teams = this.core.deps.roomTeams;
      if ("team" in input) {
        const team = validated(uuid, input.team); if (!teams) throw new HubProtocolError("unavailable");
        const expanded = teams.expand(db, [team]); if (expanded.missing.length) throw new HubProtocolError("not-found");
        teamImage = { id: team, expanded };
        agents = expanded.people.flatMap(owner => (db.prepare("SELECT id FROM hub_exposures WHERE owner=? AND state='published' AND sharing_paused=0 ORDER BY id")
          .all(owner) as { id: string }[]).map(row => row.id));
      } else {
        if (!Array.isArray(input.agents) || input.agents.length > 64) throw new HubProtocolError("invalid");
        agents = input.agents.map(id => validated(uuid, id));
      }
      const result: InvitationRow[] = [], changes: RoomInvitationChange[] = [], exposures: RoomInvitationExposure[] = [];
      for (const id of new Set(agents)) {
        const exposure = this.host.publishedExposure(db, id);
        exposures.push(exposure);
        if (this.host.roomsForExposure(db, id, exposure.owner.id).some(existing => existing.id === roomId)) continue;
        if (exposure.owner.id === actor.id) {
          this.host.addAgentMember(db, tx, roomId, id, actor.id);
          this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "room.agent-added", result: "completed", roomId, exposureId: id });
          if (!equal(this.host.publishedExposure(db, id), exposure)) throw new HubProtocolError("stale");
          changes.push({ roomId, ownerId: actor.id, membershipChanged: true }); continue;
        }
        const existing = db.prepare("SELECT * FROM hub_room_invitations WHERE room_id=? AND exposure_id=? AND owner=? AND state='pending'")
          .get(roomId, id, exposure.owner.id) as InvitationRow | undefined;
        if (existing) { this.pendingRow(existing); result.push(existing); continue; }
        // Retain the old history without presenting it beside its replacement. This rolls back with the new invite.
        db.prepare("UPDATE hub_room_invitations SET state='cancelled' WHERE room_id=? AND exposure_id=? AND owner=? AND state='expired'")
          .run(roomId, id, exposure.owner.id);
        const row: InvitationRow = { id: randomUUID(), room_id: roomId, exposure_id: id, owner: exposure.owner.id, by_person: actor.id,
          by_name: this.name(db, actor.id), agent_name: exposure.name, owner_name: exposure.owner.name, created_at: now, expires_at: now + ROOM_INVITATION_TTL, state: "pending" };
        db.prepare(`INSERT INTO hub_room_invitations VALUES(@id,@room_id,@exposure_id,@owner,@by_person,@by_name,@agent_name,@owner_name,@created_at,@expires_at,@state)`).run(row);
        this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "room.invitation-created", result: "completed", roomId, exposureId: id });
        this.sameRow(db, row); this.finalTime(row);
        if (!equal(this.host.publishedExposure(db, id), exposure)) throw new HubProtocolError("stale");
        result.push(row); changes.push({ roomId, ownerId: row.owner, membershipChanged: false });
      }
      for (const row of result) { this.sameRow(db, row); this.finalTime(row); }
      for (const exposure of exposures) if (!equal(this.host.publishedExposure(db, exposure.id), exposure)) throw new HubProtocolError("stale");
      if (!equal(this.host.managerRoom(db, roomId, actor.id), room)) throw new HubProtocolError("conflict");
      if (teamImage) {
        const selected = teamImage as { id: string; expanded: unknown };
        if (this.core.deps.roomTeams !== teams || !equal(teams!.expand(db, [selected.id]), selected.expanded)) throw new HubProtocolError("conflict");
      }
      return { invited: result.map(invited), changes };
    }, this.fence(ctx));
    this.publish(out.changes); return { invited: out.invited };
  }
  async pending(ctx: HubRequestContext) {
    const owner = await this.who(ctx); this.expire(ctx, owner.id);
    return this.core.atomic(db => ({ invitations: (db.prepare("SELECT * FROM hub_room_invitations WHERE owner=? AND state='pending' ORDER BY created_at,id")
      .all(owner.id) as InvitationRow[]).flatMap(row => {
      const now = this.now(); if (now < row.created_at) return [];
      this.pendingRow(row, now);
      let room: RoomInvitationRoom;
      try { room = this.host.room(db, row.room_id); } catch (error) {
        // A retained invitation to an archived/deleted room must not hide other rooms' pending invitations.
        const refusal = error as { status?: unknown; code?: unknown } | null;
        if ((refusal?.status === 409 && refusal.code === "archived") || (refusal?.status === 404 && refusal.code === "not-found")) return [];
        throw error;
      }
      return [{ id: row.id, room, agent: { exposureId: row.exposure_id, name: row.agent_name }, by: { name: row.by_name }, at: row.created_at }];
    }) }), this.fence(ctx));
  }
  async forRoom(ctx: HubRequestContext, roomId: string) {
    validated(uuid, roomId); const actor = await this.who(ctx); this.expire(ctx, actor.id, undefined, roomId);
    return this.core.atomic(db => {
      this.host.managerRoom(db, roomId, actor.id);
      return (db.prepare("SELECT * FROM hub_room_invitations WHERE room_id=? AND state IN ('pending','expired') ORDER BY created_at,id")
        .all(roomId) as InvitationRow[]).map(invited);
    }, this.fence(ctx));
  }
  async accept(ctx: HubRequestContext, invitationId: string) {
    validated(uuid, invitationId); const actor = await this.who(ctx); this.expire(ctx, actor.id, invitationId);
    const changes = this.core.atomic((db, tx) => {
      const row = this.owned(db, invitationId, actor.id); if (row.state === "accepted") return [];
      this.pendingRow(row); const room = this.host.room(db, row.room_id), exposure = this.host.publishedExposure(db, row.exposure_id);
      if (exposure.owner.id !== actor.id) throw new HubProtocolError("denied");
      this.host.addAgentMember(db, tx, row.room_id, row.exposure_id, actor.id);
      db.prepare("UPDATE hub_room_invitations SET state='accepted' WHERE id=?").run(row.id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "room.invitation-accepted", result: "completed", roomId: row.room_id, exposureId: row.exposure_id });
      this.sameRow(db, { ...row, state: "accepted" }); this.finalTime(row);
      if (!equal(this.host.room(db, row.room_id), room) || !equal(this.host.publishedExposure(db, row.exposure_id), exposure)) throw new HubProtocolError("stale");
      return [{ roomId: row.room_id, ownerId: actor.id, membershipChanged: true }];
    }, this.fence(ctx));
    this.publish(changes); return { ok: true as const };
  }
  async decline(ctx: HubRequestContext, invitationId: string) {
    validated(uuid, invitationId); const actor = await this.who(ctx); this.expire(ctx, actor.id, invitationId);
    const changes = this.core.atomic((db, tx) => {
      const row = this.owned(db, invitationId, actor.id); if (row.state === "declined") return [];
      this.pendingRow(row); db.prepare("UPDATE hub_room_invitations SET state='declined' WHERE id=?").run(row.id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "room.invitation-declined", result: "completed", roomId: row.room_id, exposureId: row.exposure_id });
      this.sameRow(db, { ...row, state: "declined" }); this.finalTime(row);
      return [{ roomId: row.room_id, ownerId: actor.id, membershipChanged: false }];
    }, this.fence(ctx));
    this.publish(changes); return { ok: true as const };
  }
  async cancel(ctx: HubRequestContext, roomId: string, invitationId: string) {
    validated(uuid, roomId); validated(uuid, invitationId); const actor = await this.who(ctx); this.expire(ctx, actor.id, undefined, roomId);
    const changes = this.core.atomic((db, tx) => {
      const room = this.host.managerRoom(db, roomId, actor.id), row = read(db, invitationId);
      if (!row || row.room_id !== roomId) throw new HubProtocolError("not-found");
      if (row.state === "cancelled") return [];
      const expired = row.state === "expired";
      if (!expired) this.pendingRow(row);
      db.prepare("UPDATE hub_room_invitations SET state='cancelled' WHERE id=?").run(row.id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "room.invitation-cancelled", result: "completed", roomId, exposureId: row.exposure_id });
      this.sameRow(db, { ...row, state: "cancelled" }); if (!expired) this.finalTime(row);
      if (!equal(this.host.managerRoom(db, roomId, actor.id), room)) throw new HubProtocolError("stale");
      return [{ roomId, ownerId: row.owner, membershipChanged: false }];
    }, this.fence(ctx));
    this.publish(changes); return { ok: true as const };
  }
  async roomsForExposure(ctx: HubRequestContext, exposureId: string) {
    validated(uuid, exposureId); const owner = await this.who(ctx);
    return this.core.atomic(db => this.host.roomsForExposure(db, exposureId, owner.id), this.fence(ctx));
  }
}
