/** Local roster snapshots for allowed-list evaluation. No directory calls or new team SQL. */
import type Database from "better-sqlite3";
import { hubTeamReader } from "../teams/store.js";
import { personKeyString } from "../identity.js";
import { uuid } from "../validation.js";
import { parseCanonicalPolicy } from "../roles/read.js";
import type { HubGroupPolicy } from "./model.js";
import { HubGroupPolicyError } from "./errors.js";

export function readAllowedListTeams(db: Database.Database, policy: Pick<HubGroupPolicy,"realm" | "teams">) {
  const snapshots = (policy.teams ?? []).map(rule => {
    const row = hubTeamReader.read(db, rule.teamId);
    if (row && (row.id !== rule.teamId || !Number.isSafeInteger(row.revision) || row.revision < 1
      || row.members.length > 200 || row.members.some(id => !id.startsWith(`${policy.realm}/`)
        || !uuid.safeParse(id.slice(policy.realm.length + 1)).success))) throw new HubGroupPolicyError("unavailable");
    return { id: rule.teamId, team: row };
  });
  return { snapshots, image: JSON.stringify(snapshots), memberships(who: { realm: string; objectId: string }) {
    const id = personKeyString(who); return snapshots.filter(row => row.team?.members.includes(id)).map(row => row.id);
  } };
}

/** T2 display-only Used-for port. A missing policy component means no allowed-list use; corrupt state is not hidden. */
export function hubAllowedListUsesTeam(db: Database.Database, teamId: string): boolean {
  if (!uuid.safeParse(teamId).success) throw new HubGroupPolicyError("invalid");
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_group_policy'").get()) return false;
  const row = db.prepare("SELECT body FROM hub_group_policy WHERE singleton=1").get() as { body: string } | undefined;
  if (!row) throw new HubGroupPolicyError("unavailable");
  const selected = parseCanonicalPolicy(row.body);
  return (selected.policy.teams ?? []).some(rule => rule.teamId === teamId);
}
