import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
it("adds default-unpaused state without rewriting old exposures and refuses an older migration registry", () => {
  const db = new Database(":memory:"), older = HUB_HTTP_MIGRATIONS.filter(m => m.component !== "s3-sharing-pause");
  try {
    applyHubMigrations(db, older);
    db.prepare("INSERT INTO hub_exposures VALUES(?,?,?,'Agent',7,'published','agent','[]',?,-1,42)").run(randomUUID(), randomUUID(), `corp/${randomUUID()}`, "b".repeat(64));
    const before = db.prepare("SELECT * FROM hub_exposures").get() as any;
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    const after = db.prepare("SELECT * FROM hub_exposures").get() as any;
    for (const k of Object.keys(before)) expect(after[k]).toEqual(before[k]);
    expect(after).toMatchObject({ sharing_paused: 0, sharing_epoch: 0 });
    expect(() => applyHubMigrations(db, older)).toThrow(/s3-sharing-pause/);
  } finally { db.close(); }
});
