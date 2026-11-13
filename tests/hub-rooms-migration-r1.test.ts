import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";

it("migrates once, preserves direct-room bytes and refuses an older migration registry", () => {
  const db = new Database(":memory:"), older = HUB_HTTP_MIGRATIONS.filter(m => m.component !== "s3-rooms");
  try {
    applyHubMigrations(db, older);
    const id = randomUUID(), grant = randomUUID(), owner = `corp/${randomUUID()}`, asker = `corp/${randomUUID()}`, exposure = randomUUID();
    db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Agent',1,'published','v','[]',?,0)").run(exposure, randomUUID(), owner, "a".repeat(64));
    db.prepare("INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state) VALUES(?,3,?,?,1,?,0,?,'[\"ask\"]',0,999,'active')").run(grant, owner, exposure, owner, asker);
    db.prepare("INSERT INTO hub_rooms VALUES(?,?,?,?,?,'active',123)").run(id, asker, exposure, owner, grant);
    const before = db.prepare("SELECT * FROM hub_rooms").all();
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    expect(db.prepare("SELECT * FROM hub_rooms").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hub_group_rooms").get()).toEqual({ n: 0 });
    expect(() => applyHubMigrations(db, older)).toThrow(/s3-rooms/);
  } finally { db.close(); }
});
