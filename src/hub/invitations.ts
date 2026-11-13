/** Track C seam 3 contracts only. No routes, tables or side effects are mounted here. */
import type Database from "better-sqlite3";
import type { HubRequestContext, HubTx, PersonId } from "./types.js";

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

/** Future C service; this interface does not advertise an implemented feature. */
export interface HubRoomInvitations {
  invite(ctx: HubRequestContext, roomId: string, input: { agents: readonly string[] } | { team: string }): Promise<{ invited: readonly RoomInvitedAgent[] }>;
  pending(ctx: HubRequestContext): Promise<{ invitations: readonly RoomInvitationView[] }>;
  forRoom(ctx: HubRequestContext, roomId: string): Promise<readonly RoomInvitedAgent[]>;
  accept(ctx: HubRequestContext, invitationId: string): Promise<{ ok: true }>;
  decline(ctx: HubRequestContext, invitationId: string): Promise<{ ok: true }>;
  cancel(ctx: HubRequestContext, roomId: string, invitationId: string): Promise<{ ok: true }>;
  roomsForExposure(ctx: HubRequestContext, exposureId: string): Promise<readonly OwnerAgentRoom[]>;
}
