import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
describe("B1 code attribution in required audit", () => {
  it("persists and hashes the code id with reason code, without changing historical chain entries", () => {
    const db = new Database(":memory:");
    try {
      HUB_AUDIT_MIGRATION.up(db); const audit = createHubAudit({ db, contentKey: randomBytes(32) });
      const base = { id: randomUUID(), sequence: 0, at: 100, requestId: "owned-request", actor: { kind: "local-host" as const }, action: "old.event", result: "completed" as const, policyVersion: 0 };
      db.transaction(() => audit.appendInTransaction(base, db)).immediate();
      const old = db.prepare("SELECT hash FROM hub_audit WHERE id=?").get(base.id);
      const codeId = randomUUID(); db.transaction(() => audit.appendInTransaction({ ...base, id: randomUUID(), action: "enrolment-code.used", reasonCode: "code", codeId } as any, db)).immediate();
      expect(db.prepare("SELECT code_id,reason_code FROM hub_audit WHERE action='enrolment-code.used'").get()).toEqual({ code_id: codeId, reason_code: "code" });
      expect(audit.verifyChain()).toMatchObject({ ok: true, checked: 2 });
      HUB_AUDIT_MIGRATION.up(db); expect(db.prepare("SELECT hash FROM hub_audit WHERE id=?").get(base.id)).toEqual(old);
      db.prepare("UPDATE hub_audit SET code_id=? WHERE action='enrolment-code.used'").run(randomUUID());
      expect(audit.verifyChain()).toMatchObject({ ok: false });
    } finally { db.close(); }
  });
});
