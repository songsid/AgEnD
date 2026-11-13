/** Track C seam 5 contracts. Runtime storage and routes require explicit composition. */
import type Database from "better-sqlite3";
import type { PersonId } from "../types.js";
import type { HubRequestContext } from "../types.js";

export interface HubTeamSnapshot {
  readonly id: string; readonly revision: number; readonly name: string;
  /** Immutable AD group identity, never its mutable name or DN. */
  readonly department: { readonly realm: string; readonly objectGuid: string };
  readonly lead: PersonId;
  /** The selected roster, not an implicit AD-group expansion. */
  readonly members: readonly PersonId[];
}
export interface HubTeamExpansion {
  /** Selected versions let a caller detect a changed roster before its final effect. */
  readonly teams: readonly { readonly id: string; readonly revision: number }[];
  readonly people: readonly PersonId[];
  /** Missing/deleted selections remain explicit; never silently treated as empty teams. */
  readonly missing: readonly string[];
}

/**
 * Synchronous reads over the caller's current atomic snapshot. IDs in people are
 * deduplicated personKeyString values. This port does not prove directory eligibility,
 * a browser session, room management, exposure ownership or permission to grant access.
 * Callers retain those current checks; no AD call or member enumeration occurs here.
 */
export interface HubTeamReader {
  read(db: Database.Database, teamId: string): HubTeamSnapshot | null;
  expand(db: Database.Database, teamIds: readonly string[]): HubTeamExpansion;
  /** Live roster membership for ask grants and creator rights; null means the team is missing/deleted. */
  isMember(db: Database.Database, teamId: string, person: PersonId): { readonly revision: number; readonly member: boolean } | null;
}

/** Seam-5 browser DTO. Canonical IDs stay separate from display-only directory labels. */
export interface HubTeamView {
  readonly id: string; readonly revision: number; readonly name: string;
  readonly department: string; readonly departmentName: string;
  readonly lead: PersonId; readonly leadName: string; readonly members: readonly PersonId[];
  readonly canManage: boolean;
  /** null means not observed, not a disabled account. Reads never choose a replacement lead. */
  readonly leadEligible: boolean | null;
  readonly memberInfo?: readonly {
    readonly id: PersonId; readonly name: string; readonly login: string; readonly department: string;
    readonly signedIn: boolean; readonly agents: readonly { readonly id: string; readonly name: string }[];
  }[];
  readonly impact?: { readonly grants: readonly { readonly id: string; readonly exposureId: string; readonly name: string; readonly expiresAt: number }[];
    readonly roomCreator: boolean };
}

/** One mounted instance supplies CRUD and the existing room/permission reader ports. R wraps HTTP envelopes. */
export interface HubTeams extends HubTeamReader {
  candidates(db: Database.Database, prefix: string): readonly { readonly id: string; readonly name: string; readonly people: number }[];
  list(ctx: HubRequestContext): Promise<readonly HubTeamView[]>;
  get(ctx: HubRequestContext, id: string): Promise<HubTeamView>;
  create(ctx: HubRequestContext, input: unknown): Promise<HubTeamView>;
  update(ctx: HubRequestContext, id: string, input: unknown): Promise<HubTeamView>;
  remove(ctx: HubRequestContext, id: string): Promise<void>;
}
