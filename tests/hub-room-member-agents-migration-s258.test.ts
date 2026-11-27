import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
it("upgrades existing rooms to opt-out without changing their settings, and refuses an older registry", () => {
  const db = new Database(":memory:");
  const previous = HUB_HTTP_MIGRATIONS.filter(m => m.component !== "s3-room-member-agents");
  try {
    applyHubMigrations(db, previous);
    db.prepare("INSERT INTO hub_group_rooms(id,name,created_by,created_at,all_mention,history_for_new) VALUES('example','Example','owner',123,0,'all')").run();
    const before = db.prepare("SELECT * FROM hub_group_rooms WHERE id='example'").get() as Record<string, unknown>;
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    expect(db.prepare("SELECT * FROM hub_group_rooms WHERE id='example'").get()).toEqual({ ...before, members_add_own_agents: 0 });
    expect(() => applyHubMigrations(db, previous)).toThrow(/s3-room-member-agents/);
  } finally { db.close(); }
});
