/** Retained grants, foreign keys and expiry survive the additive Team subject component. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { HUB_TEAM_GRANTS_MIGRATION } from "../src/hub/teams/grant-schema.js";
import { grantOf } from "../src/hub/catalog.js";

function world() {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON"); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
  const owner = `corp/${randomUUID()}`, exposure = randomUUID(), expiry = Date.now() + 365 * 86_400_000;
  db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,frozen_through,updated_at) VALUES(?,?,?,'Agent',1,'published','agent','[]',?,-1,0)")
    .run(exposure, randomUUID(), owner, "a".repeat(64));
  for (const kind of ["person", "group"]) {
    const grant = randomUUID(), person = `corp/${randomUUID()}`;
    db.prepare("INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state,subject_kind,subject_label) VALUES(?,7,?,?,1,?,0,?,'[\"ask\",\"read-own-room\"]',0,?,'active',?,?)")
      .run(grant, owner, exposure, owner, person, expiry, kind, kind === "group" ? "CN=Engineering,DC=example,DC=test" : "");
    db.prepare("INSERT INTO hub_rooms(id,asker,exposure_id,owner_at_creation,grant_id,state,created_at) VALUES(?,?,?,?,?,'active',0)")
      .run(randomUUID(), person, exposure, owner, grant);
  }
  return { db, exposure, owner, expiry };
}
it("preserves every retained person/group value and canonical grant, child foreign key and longer expiry", () => {
  const w = world(), { db } = w;
  try {
    const before = db.prepare("SELECT * FROM hub_grants ORDER BY id").all() as Parameters<typeof grantOf>[0][];
    const rooms = db.prepare("SELECT * FROM hub_rooms ORDER BY id").all();
    const registry = [...HUB_HTTP_MIGRATIONS, HUB_TEAM_GRANTS_MIGRATION];
    applyHubMigrations(db, registry); applyHubMigrations(db, registry);
    const after = db.prepare("SELECT * FROM hub_grants ORDER BY id").all() as Parameters<typeof grantOf>[0][];
    expect(after).toEqual(before); expect(after.map(grantOf)).toEqual(before.map(grantOf));
    expect(after.every(row => row.expires_at === w.expiry)).toBe(true);
    expect(db.prepare("SELECT * FROM hub_rooms ORDER BY id").all()).toEqual(rooms);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const insert = db.prepare("INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state,subject_kind,subject_label) VALUES(?,1,?,?,1,?,0,?,'[\"ask\"]',0,?,'active',?,'')");
    expect(() => insert.run(randomUUID(), w.owner, w.exposure, w.owner, randomUUID(), w.expiry, "team")).not.toThrow();
    expect(() => insert.run(randomUUID(), w.owner, w.exposure, w.owner, randomUUID(), w.expiry, "other")).toThrow(/CHECK/);
    expect(() => applyHubMigrations(db, HUB_HTTP_MIGRATIONS)).toThrow(/s3-team-grants/);
  } finally { db.close(); }
});
it("rolls the entire column migration back when copying a retained row fails", () => {
  const { db } = world();
  try {
    const before = db.prepare("SELECT * FROM hub_grants ORDER BY id").all();
    db.exec("CREATE TRIGGER migration_hold BEFORE UPDATE ON hub_grants BEGIN SELECT RAISE(ABORT,'migration held'); END");
    expect(() => applyHubMigrations(db, [...HUB_HTTP_MIGRATIONS, HUB_TEAM_GRANTS_MIGRATION])).toThrow(/migration held/);
    expect(db.prepare("SELECT * FROM hub_grants ORDER BY id").all()).toEqual(before);
    expect((db.prepare("PRAGMA table_info(hub_grants)").all() as { name: string }[]).map(row => row.name)).not.toContain("subject_kind_before_teams");
    expect(db.prepare("SELECT 1 FROM hub_schema WHERE component='s3-team-grants'").get()).toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
