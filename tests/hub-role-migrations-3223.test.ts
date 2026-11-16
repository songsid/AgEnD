/** Registry selection never repairs a partial authority image. Owned SQLite only. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { applyHubMigrations, assertHubMigrationsCurrent } from "../src/hub/db.js";
import { HUB_ROLE_MIGRATIONS, hubRoleMigrationsForState } from "../src/hub/roles/migrations.js";
import { roleCutoverLegacyPlan } from "./support/hub-role-cutover-plan.js";
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function rig() {
  const db = new Database(":memory:"); databases.push(db); db.pragma("foreign_keys=ON");
  const base = roleCutoverLegacyPlan(randomUUID()); applyHubMigrations(db, base);
  return { db, base };
}
it("retains the base registry before cutover and recognizes the complete current role registry", () => {
  const { db, base } = rig();
  expect(hubRoleMigrationsForState(db, base)).toEqual(base);
  applyHubMigrations(db, [...base, ...HUB_ROLE_MIGRATIONS]);
  const selected = hubRoleMigrationsForState(db, base);
  expect(selected).toEqual([...base, ...HUB_ROLE_MIGRATIONS]);
  expect(() => assertHubMigrationsCurrent(db, selected)).not.toThrow();
});
it.each(["partial", "newer", "lost-table", "lost-column"])("refuses %s role state without recreating anything", mode => {
  const { db, base } = rig(); applyHubMigrations(db, [...base, ...HUB_ROLE_MIGRATIONS]);
  if (mode === "partial") db.exec("DELETE FROM hub_schema WHERE component='roles-expiry'");
  if (mode === "newer") db.exec("UPDATE hub_schema SET version=99 WHERE component='roles-expiry'");
  if (mode === "lost-table") db.exec("DROP TABLE hub_role_expiry_terms");
  if (mode === "lost-column") db.exec("ALTER TABLE hub_role_expiry_terms RENAME COLUMN settled_at TO missing_settled_at");
  const before = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  expect(() => hubRoleMigrationsForState(db, base)).toThrow();
  expect(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
});
it("refuses an incomplete compiled role registry", () => {
  const { db, base } = rig();
  expect(() => hubRoleMigrationsForState(db, [...base, HUB_ROLE_MIGRATIONS[0]!])).toThrow();
});
