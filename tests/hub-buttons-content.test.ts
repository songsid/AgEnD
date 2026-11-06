import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { applyHubMigrations, createHubUnitOfWork } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import type { HubAuditRecord, HubAnswerButtons } from "../src/hub/types.js";
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const event = (contentRef: string): HubAuditRecord => ({ id: randomUUID(), sequence: 0, at: Date.now(), requestId: randomUUID(),
  actor: { kind: "local-host" }, action: "poll.voted", result: "completed", policyVersion: 0, contentRef });
describe("Hub choices and ballots use the existing encrypted audit content store", () => {
  it("persists all choice and ballot fields encrypted and rolls back failed writes", () => {
    const db = new Database(":memory:"); dbs.push(db); applyHubMigrations(db, [HUB_AUDIT_MIGRATION]);
    const audit = createHubAudit({ db, contentKey: randomBytes(32) }), uow = createHubUnitOfWork(db);
    const buttons: HubAnswerButtons = { id: "a".repeat(32), labels: ["Private choice", "Other"], values: ["private-value", "other"],
      poll: { seconds: 10, multi: true, reveal: "close", showVoters: true, question: "Private question" } };
    const pollBallot = { voter: "directory/" + randomUUID(), name: "Private voter", options: [1], at: Date.now(),
      setId: buttons.id, roomId: randomUUID(), messageId: randomUUID() };
    const payload = { answer: "Private answer", buttons, pollBallot };
    const ref = uow.atomic(tx => { const ref = audit.content.put(tx, payload); audit.append(tx, event(ref)); return ref; });
    expect(audit.content.get(ref)).toEqual(payload);
    const rows = db.prepare("SELECT nonce,ciphertext FROM hub_audit_content").all() as { nonce: Buffer; ciphertext: Buffer }[];
    const raw = Buffer.concat(rows.map(r => r.ciphertext));
    for (const value of ["Private choice", "private-value", "Private question", "Private voter", "Private answer"]) expect(raw.includes(Buffer.from(value))).toBe(false);
    expect(() => uow.atomic(tx => { audit.content.put(tx, payload); throw new Error("rollback"); })).toThrow("rollback");
    expect(db.prepare("SELECT COUNT(*) AS n FROM hub_audit_content").get()).toEqual({ n: 1 });
    expect(audit.verifyChain().ok).toBe(true);
  });
});
