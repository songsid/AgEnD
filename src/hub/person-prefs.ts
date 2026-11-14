/** Personal Hub presentation preferences. The caller selects the signed-in person, never a request field. */
import type Database from "better-sqlite3";
import { HubProtocolError } from "./validation.js";

export const HUB_PERSON_PREFS_MIGRATION = Object.freeze({
  component: "s3-person-prefs", version: 1,
  up(db: Database.Database): void {
    db.exec(`CREATE TABLE hub_person_prefs (
      person TEXT PRIMARY KEY REFERENCES hub_people(person),
      favorites TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0)
    )`);
  },
});

export function parsePersonPrefs(value: Record<string, unknown>): { favorites: string[]; onlyIfUnset: boolean } {
  const ids = value.favorites;
  if (Object.keys(value).some(key => key !== "favorites" && key !== "onlyIfUnset")
    || !Array.isArray(ids) || ids.length > 50
    || ids.some(id => typeof id !== "string" || id.length < 1 || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id))
    || new Set(ids).size !== ids.length
    || value.onlyIfUnset !== undefined && typeof value.onlyIfUnset !== "boolean") throw new HubProtocolError("invalid");
  return { favorites: ids as string[], onlyIfUnset: value.onlyIfUnset === true };
}

export function readPersonPrefs(db: Database.Database, person: string) {
  const row = db.prepare("SELECT favorites,revision FROM hub_person_prefs WHERE person=?").get(person) as { favorites: string; revision: number } | undefined;
  return row ? { favorites: JSON.parse(row.favorites) as string[], initialized: true, revision: row.revision }
    : { favorites: [], initialized: false, revision: 0 };
}

/** Inside the caller's transaction: first browser wins migration, including an intentionally empty list. */
export function writePersonPrefs(db: Database.Database, person: string, input: ReturnType<typeof parsePersonPrefs>) {
  db.prepare(`INSERT INTO hub_person_prefs(person,favorites,revision) VALUES(?,?,1)
    ON CONFLICT(person) DO UPDATE SET favorites=excluded.favorites, revision=hub_person_prefs.revision+1
    WHERE ?=0`).run(person, JSON.stringify(input.favorites), input.onlyIfUnset ? 1 : 0);
  return readPersonPrefs(db, person);
}
