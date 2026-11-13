/** Track C seam 5 read contracts only; no team SQL, routes or permission activation. */
import type Database from "better-sqlite3";
import type { PersonId } from "../types.js";

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
