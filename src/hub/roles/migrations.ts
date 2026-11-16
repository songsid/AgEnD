/** Server-only registry selection. Cold recovery never migrates or repairs authority state. */
import type Database from "better-sqlite3";
import { HubStateError, type HubMigration } from "../db.js";
import { HUB_ROLE_WRITER_MIGRATION } from "./writer.js";
import { HUB_ROLE_EXPIRY_MIGRATION } from "./expiry.js";

export const HUB_ROLE_CUTOVER_MIGRATION: HubMigration = {
  component: "roles-cutover", version: 1,
  up(db) { db.exec("CREATE TABLE IF NOT EXISTS hub_role_cutover(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL)"); },
};
export const HUB_ROLE_MIGRATIONS: readonly HubMigration[] = Object.freeze([
  HUB_ROLE_WRITER_MIGRATION, HUB_ROLE_EXPIRY_MIGRATION, HUB_ROLE_CUTOVER_MIGRATION,
]);

/** Legacy images retain the base registry; converted images require the complete known role registry. */
export function hubRoleMigrationsForState(db: Database.Database, migrations: readonly HubMigration[]): readonly HubMigration[] {
  const names = new Set(HUB_ROLE_MIGRATIONS.map(m => m.component));
  const provided = migrations.filter(m => names.has(m.component));
  if (provided.length && (provided.length !== HUB_ROLE_MIGRATIONS.length
    || provided.some(m => HUB_ROLE_MIGRATIONS.find(r => r.component === m.component)?.version !== m.version))) {
    throw new HubStateError("hub-state-mismatch", "the role migration registry is incomplete");
  }
  const base = migrations.filter(m => !names.has(m.component));
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_schema'").get()) return base;
  const stored = db.prepare("SELECT component,version FROM hub_schema WHERE component IN ('roles-writer','roles-expiry','roles-cutover') ORDER BY component")
    .all() as { component: string; version: number }[];
  if (!stored.length) return base;
  const expected = HUB_ROLE_MIGRATIONS.map(m => ({ component: m.component, version: m.version }))
    .sort((a, b) => a.component.localeCompare(b.component));
  if (stored.some(m => m.version > (expected.find(r => r.component === m.component)?.version ?? 0))) {
    throw new HubStateError("hub-state-newer", "the stored role migration registry is newer");
  }
  if (JSON.stringify(stored) !== JSON.stringify(expected)) throw new HubStateError("hub-state-mismatch", "the stored role migration registry is incomplete");
  // A current registry must not recreate lost authority tables on mount or during cold recovery.
  for (const sql of [
    "SELECT id,body,at FROM hub_role_events LIMIT 0",
    "SELECT id,person,acknowledged_at FROM hub_role_notices LIMIT 0",
    "SELECT person,role_id,assignment_id,audit_id FROM hub_role_root_self LIMIT 0",
    "SELECT term,assignment_id,expires_at,audit_id,settled_at FROM hub_role_expiry_terms LIMIT 0",
    "SELECT singleton,body FROM hub_role_cutover LIMIT 0",
  ]) db.prepare(sql).all();
  return [...base, ...HUB_ROLE_MIGRATIONS];
}
