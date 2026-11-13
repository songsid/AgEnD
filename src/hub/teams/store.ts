/** Selected Hub rosters. Reading them never expands an AD department or grants an action. */
import type Database from "better-sqlite3";
import type { HubHttpMigration } from "../http/schema.js";
import type { PersonId } from "../types.js";
import type { HubTeamReader, HubTeamSnapshot } from "./types.js";

export const HUB_TEAMS_MIGRATION: HubHttpMigration = Object.freeze({ component: "s5-teams", version: 1,
  up(db: Database.Database) { db.exec(`
CREATE TABLE hub_teams (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), name TEXT NOT NULL,
  department_realm TEXT NOT NULL, department_guid TEXT NOT NULL, department_name TEXT NOT NULL,
  lead TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE TABLE hub_team_members (
  team_id TEXT NOT NULL REFERENCES hub_teams(id), person TEXT NOT NULL,
  display_name TEXT NOT NULL, login_label TEXT NOT NULL, department TEXT NOT NULL,
  PRIMARY KEY(team_id,person)
);
CREATE INDEX hub_team_member_person ON hub_team_members(person,team_id);
`); } });

export interface TeamRow {
  id: string; revision: number; name: string; department_realm: string; department_guid: string;
  department_name: string; lead: string; created_at: number; updated_at: number; deleted: number;
}
export interface TeamMemberRow { team_id: string; person: string; display_name: string; login_label: string; department: string }
export const readTeamRow = (db: Database.Database, id: string): TeamRow | undefined =>
  db.prepare("SELECT * FROM hub_teams WHERE id=? AND deleted=0").get(id) as TeamRow | undefined;
export const teamMembers = (db: Database.Database, id: string): TeamMemberRow[] =>
  db.prepare("SELECT * FROM hub_team_members WHERE team_id=? ORDER BY person").all(id) as TeamMemberRow[];

function read(db: Database.Database, id: string): HubTeamSnapshot | null {
  const row = readTeamRow(db, id); if (!row) return null;
  return { id: row.id, revision: row.revision, name: row.name,
    department: { realm: row.department_realm, objectGuid: row.department_guid }, lead: row.lead,
    members: teamMembers(db, id).map(member => member.person) };
}

/** All calls use the caller's current synchronous transaction, including its final comparison. */
export const hubTeamReader: HubTeamReader = Object.freeze({
  read,
  expand(db: Database.Database, ids: readonly string[]) {
    const teams: { id: string; revision: number }[] = [], people = new Set<PersonId>(), missing: string[] = [];
    for (const id of [...new Set(ids)].sort()) {
      const team = read(db, id);
      if (!team) { missing.push(id); continue; }
      teams.push({ id: team.id, revision: team.revision });
      for (const person of team.members) people.add(person);
    }
    return { teams, people: [...people].sort(), missing };
  },
  isMember(db: Database.Database, id: string, person: PersonId) {
    const team = read(db, id);
    return team ? { revision: team.revision, member: team.members.includes(person) } : null;
  },
});

/** Feedback only; caller retains creator/manager/owner authority. LIKE wildcards stay literal. */
export function hubTeamCandidates(db: Database.Database, prefix: string): readonly { id: string; name: string; people: number }[] {
  const escaped = prefix.trim().replace(/[\\%_]/g, value => "\\" + value);
  return (db.prepare(`SELECT t.id,t.name,COUNT(m.person) AS people FROM hub_teams t
    LEFT JOIN hub_team_members m ON m.team_id=t.id WHERE t.deleted=0 AND t.name LIKE ? ESCAPE '\\'
    GROUP BY t.id ORDER BY t.name COLLATE NOCASE,t.id LIMIT 20`).all(escaped + "%") as { id: string; name: string; people: number }[]);
}
