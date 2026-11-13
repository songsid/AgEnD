import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_COMPANY_JOIN_MIGRATION } from "../src/hub/join/store.js";
describe("company join cleanup format upgrade", () => {
  it("preserves v1 state, upgrades once, and makes an older binary refuse the newer record format", () => {
    const db = new Database(":memory:");
    try {
      const previous = { ...HUB_COMPANY_JOIN_MIGRATION, version: 1 };
      applyHubMigrations(db, [previous]);
      db.prepare("UPDATE hub_company_join_control SET enabled=1,revision=9").run();
      applyHubMigrations(db, [HUB_COMPANY_JOIN_MIGRATION]);
      applyHubMigrations(db, [HUB_COMPANY_JOIN_MIGRATION]);
      expect(db.prepare("SELECT enabled,revision FROM hub_company_join_control").get()).toEqual({ enabled: 1, revision: 9 });
      expect(db.prepare("SELECT version FROM hub_schema WHERE component='company-join'").get()).toEqual({ version: 3 });
      expect(() => applyHubMigrations(db, [previous])).toThrow("company-join v3");
    } finally { db.close(); }
  });
});
