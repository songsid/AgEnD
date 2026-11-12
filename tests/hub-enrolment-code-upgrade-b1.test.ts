/** Owned serialized SQLite backup; no service, installer or native runtime. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_ENROLMENT_CODE_MIGRATION } from "../src/hub/enrolment-code.js";
import { HUB_COMPANY_JOIN_MIGRATION } from "../src/hub/join/store.js";
import { HUB_GROUP_RESOURCES_MIGRATION } from "../src/hub/group-policy/resources.js";
import { HUB_PAIRING_INBOX_MIGRATION } from "../src/hub/member/pairing-notices.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";

describe("B1 retained state and rollback boundary", () => {
  it("preserves v1 resource/event/inbox bytes and historical audit hashes; old plans need the pre-upgrade backup", () => {
    const old = [
      { ...HUB_COMPANY_JOIN_MIGRATION, version: 2 },
      { ...HUB_AUDIT_MIGRATION, version: 1, up(db: Database.Database) { HUB_AUDIT_MIGRATION.up(db); db.exec("ALTER TABLE hub_audit DROP COLUMN code_id"); } },
      { ...HUB_GROUP_RESOURCES_MIGRATION, version: 1, up(db: Database.Database) { db.exec(`CREATE TABLE hub_group_resources(resource_key TEXT PRIMARY KEY,body TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN('manual','group')),state TEXT NOT NULL CHECK(state IN('active','suspended')),revision INTEGER NOT NULL);
        CREATE TABLE hub_group_resource_events(id TEXT PRIMARY KEY REFERENCES hub_audit(id) ON DELETE CASCADE,body TEXT NOT NULL);`); } },
      { ...HUB_PAIRING_INBOX_MIGRATION, version: 1 },
    ];
    const db = new Database(":memory:"), key = randomBytes(32);
    try {
      applyHubMigrations(db, old);
      db.exec("ALTER TABLE hub_audit ADD COLUMN code_id TEXT"); // Create a legacy-shape hash with null attribution, then restore its old schema.
      const audit = createHubAudit({ db, contentKey: key });
      const id = randomUUID(); db.transaction(() => audit.appendInTransaction({ id, sequence: 0, at: 100, requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.before-upgrade", result: "completed", policyVersion: 0 }, db)).immediate();
      db.exec("ALTER TABLE hub_audit DROP COLUMN code_id");
      const resource = JSON.stringify({ kind: "fleet", id: randomUUID(), revision: 1, owner: { realm: "corp", objectId: randomUUID() } });
      db.prepare("INSERT INTO hub_group_resources VALUES(?,?,'manual','active',1)").run("retained", resource);
      db.prepare("INSERT INTO hub_group_resource_events VALUES(?,?)").run(id, "retained-event-bytes");
      db.prepare("INSERT INTO hub_pairing_notice_inbox VALUES(?,?)").run(randomUUID(), "retained-inbox-bytes");
      const backup = db.serialize(), before = db.prepare("SELECT hash,prev_hash FROM hub_audit").all();
      const current = [HUB_COMPANY_JOIN_MIGRATION, HUB_AUDIT_MIGRATION, HUB_GROUP_RESOURCES_MIGRATION, HUB_PAIRING_INBOX_MIGRATION, HUB_ENROLMENT_CODE_MIGRATION];
      applyHubMigrations(db, current); applyHubMigrations(db, current);
      expect(db.prepare("SELECT hash,prev_hash FROM hub_audit").all()).toEqual(before);
      expect(createHubAudit({ db, contentKey: key }).verifyChain()).toMatchObject({ ok: true });
      expect(db.prepare("SELECT body,source FROM hub_group_resources").get()).toEqual({ body: resource, source: "manual" });
      expect(db.prepare("SELECT body FROM hub_group_resource_events").get()).toEqual({ body: "retained-event-bytes" });
      expect(db.prepare("SELECT body FROM hub_pairing_notice_inbox").get()).toEqual({ body: "retained-inbox-bytes" });
      expect(() => applyHubMigrations(db, old)).toThrow("enrolment-code");
      const restored = new Database(backup); try { expect(() => applyHubMigrations(restored, old)).not.toThrow(); } finally { restored.close(); }
    } finally { db.close(); }
  });
});
