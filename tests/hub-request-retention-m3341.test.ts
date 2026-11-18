import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { applyHubMigrations, createHubUnitOfWork, HUB_INSTANCE_MIGRATION } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import type { HubAuditRecord } from "../src/hub/types.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const DAY = 86_400_000;
function world() {
  const db = new Database(":memory:"); databases.push(db);
  applyHubMigrations(db, [HUB_INSTANCE_MIGRATION, HUB_AUDIT_MIGRATION]);
  let now = Date.UTC(2026, 10, 19);
  const audit = createHubAudit({ db, contentKey: randomBytes(32), now: () => now }), uow = createHubUnitOfWork(db);
  const append = (text: string) => uow.atomic(tx => {
    const ref = audit.content.put(tx, { question: text });
    const record: HubAuditRecord = { id: randomUUID(), sequence: 0, at: now, requestId: randomUUID(), actor: { kind: "local-host" },
      action: "example.retention", result: "completed", policyVersion: 0, contentRef: ref };
    audit.append(tx, record); return { ref, id: record.id };
  });
  return { db, audit, uow, append, advance: (days: number) => { now += days * DAY; } };
}

it("retains protected ciphertext and its audit anchor under a one-day policy, then releases both", () => {
  const w = world(), before = w.append("Unrelated old hint"), root = w.append("Protected hint"), after = w.append("Another old hint");
  w.advance(2);
  const result = w.audit.purge({ contentDays: 1, eventDays: 1 }, undefined, { protectedContentRefs: () => [root.ref] });
  expect(result).toEqual({ content: 2, events: 1 });
  expect(w.audit.content.get(root.ref)).toEqual({ question: "Protected hint" });
  expect(w.audit.content.get(before.ref)).toBeUndefined(); expect(w.audit.content.get(after.ref)).toBeUndefined();
  expect(w.db.prepare("SELECT id FROM hub_audit WHERE id=?").get(root.id)).toEqual({ id: root.id });
  expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  w.advance(6);
  expect(w.audit.purge({ contentDays: 1, eventDays: 1 }, undefined, { protectedContentRefs: () => [] })).toEqual({ content: 1, events: 3 });
  expect(w.audit.content.get(root.ref)).toBeUndefined();
  expect(w.db.prepare("SELECT id FROM hub_audit WHERE id=?").get(root.id)).toBeUndefined();
  expect(w.audit.verifyChain()).toMatchObject({ ok: true });
});

it.each(["throw", "thenable", "invalid", "missing", "unbound", "anchor"])("aborts the entire purge for %s protection evidence", failure => {
  const w = world(), root = w.append("Protected hint"); w.append("Unrelated hint");
  let ref = root.ref;
  if (failure === "missing") ref = "0".repeat(32);
  if (failure === "unbound") ref = w.uow.atomic(tx => w.audit.content.put(tx, { question: "Unbound hint" }));
  if (failure === "anchor") w.db.prepare("DELETE FROM hub_audit WHERE id=?").run(root.id);
  w.advance(2);
  const counts = () => ({ content: w.db.prepare("SELECT COUNT(*) n FROM hub_audit_content").get(), events: w.db.prepare("SELECT COUNT(*) n FROM hub_audit").get() });
  const before = counts();
  const provider = () => {
    if (failure === "throw") throw Error("Unavailable roots");
    if (failure === "thenable") return Promise.resolve([ref]) as any;
    return [failure === "invalid" ? "INVALID" : ref];
  };
  expect(() => w.audit.purge({ contentDays: 1, eventDays: 1 }, undefined, { protectedContentRefs: provider })).toThrow();
  expect(counts()).toEqual(before);
});
