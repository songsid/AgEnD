/** New subject schema preserves legacy grants and makes an old binary refuse newer state. */
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { grantOf } from "../src/hub/catalog.js";
it("preserves old personal IDs/revisions/permissions and a longer recorded expiry; old registry refuses the new schema", () => {
  const db = new Database(":memory:"), older = HUB_HTTP_MIGRATIONS.filter(m => m.component !== "s3-grant-subjects");
  try {
    applyHubMigrations(db, older);
    const owner = `corp/${randomUUID()}`, subject = `corp/${randomUUID()}`, exposure = randomUUID(), id = randomUUID(), expiry = Date.now() + 365 * 86_400_000;
    db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,frozen_through,updated_at) VALUES(?,?,?,'Agent',1,'published','agent','[]',?, -1,0)").run(exposure, randomUUID(), owner, "a".repeat(64));
    db.prepare("INSERT INTO hub_grants VALUES(?,7,?,?,1,?,0,?,'[\"ask\",\"read-own-room\"]',0,?,'active')").run(id, owner, exposure, owner, subject, expiry);
    const before = db.prepare("SELECT * FROM hub_grants").get() as any;
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    const after = db.prepare("SELECT * FROM hub_grants").get() as any;
    for (const key of Object.keys(before)) expect(after[key]).toEqual(before[key]);
    expect(after).toMatchObject({ subject_kind: "person", subject_label: "" });
    expect(grantOf(after)).toMatchObject({ id, revision: 7, expiresAt: expiry, subject: { kind: "person" } });
    expect(() => applyHubMigrations(db, older)).toThrow(/s3-grant-subjects/);
  } finally { db.close(); }
});
