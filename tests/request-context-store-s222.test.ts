import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DeliveryOutbox, type NewOutboxDelivery } from "../src/delivery-outbox.js";
import { requestContextDigest } from "../src/request-context-store.js";
import type { RequestContextV1, RequestOperationBindingV1 } from "../src/request-context-protocol.js";
const ROOT = "00000000-0000-4000-8000-000000000001", CHILD = "00000000-0000-4000-8000-000000000002";
const AUDIENCE = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [], opened: DeliveryOutbox[] = [];
afterEach(() => { for (const box of opened.splice(0)) box.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), "request-store-")); roots.push(root); return join(root, "outbox.db"); }
function open(file = path(), active = true) {
  const box = new DeliveryOutbox(file, "manager", { requestContextDispatchVersion: 1 }); opened.push(box);
  if (active) box.activateRequestContextBarrier(); return box;
}
function context(): RequestContextV1 { return { ref: { version: 1, contextId: ROOT, rootContextId: ROOT }, rootEvidenceRef: "accepted-fixture",
  initiatingActor: { kind: "person", platform: "discord", userId: "demo-person" }, ingress: "restricted-room",
  source: { instance: "source", incarnation: "source-generation" }, sourceAudience: { kind: "room", ref: AUDIENCE } }; }
function input(): NewOutboxDelivery { return { operationId: "op-1", sourceKey: "source-key", sourceInstance: "source", sourceDaemonBootId: "source-boot",
  targetInstance: "target", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "Synthetic labelled request; authority none" } }; }
function binding(i = input(), c = context()): RequestOperationBindingV1 { return { version: 1, operationId: i.operationId,
  contextId: c.ref.contextId, rootContextId: c.ref.rootContextId, source: c.source,
  target: { instance: i.targetInstance, incarnation: "target-generation" }, verb: "send_to_instance", payloadSha256: requestContextDigest(i.payload) }; }
it("keeps the ordinary production path off and creates no companion tables", () => {
  const file = path(), box = new DeliveryOutbox(file); opened.push(box); box.admit(input());
  expect(() => box.admitWithRequestContext(input(), context(), binding())).toThrow(/not ready/);
  expect(box.requestContext(ROOT)).toBeNull();
  const db = new Database(file, { readonly: true }); expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name GLOB 'request_context*_v1'").get()).toEqual({ n: 0 }); db.close();
  expect(() => open(path(), false).admitWithRequestContext(input(), context(), binding())).toThrow(/not ready/);
});
it("commits exact context, operation and delivery once, survives reopen and accepts reordered JSON", () => {
  const file = path(), box = open(file), c = context(), i = input(), b = binding(i, c);
  const first = box.admitWithRequestContext(i, c, b); expect(first.inserted).toBe(true);
  const again = open(file).admitWithRequestContext({ ...i, payload: { content: i.payload.content, type: i.payload.type } }, c, b);
  expect(again).toEqual({ delivery: first.delivery, inserted: false });
  expect(box.requestContextOperation("source", i.operationId)?.deliveryId).toBe(first.delivery.deliveryId);
  expect(box.requestContext(ROOT)).toEqual(c);
});
it.each(["actor", "ingress", "evidence", "audience"])("a retry cannot replace immutable %s", field => {
  const box = open(); box.admitWithRequestContext(input(), context(), binding()); const next = structuredClone(context()) as any;
  if (field === "actor") next.initiatingActor.userId = "someone-else";
  if (field === "ingress") next.ingress = "owner";
  if (field === "evidence") next.rootEvidenceRef = "other";
  if (field === "audience") next.sourceAudience.ref = CHILD;
  expect(() => box.admitWithRequestContext(input(), next, binding())).toThrow(/immutable context conflict/);
  expect(box.requestContext(ROOT)).toEqual(context());
});
it.each(["bytes", "target", "incarnation", "verb", "key", "boot", "root"])("an operation retry cannot change %s", field => {
  const box = open(); const original = box.admitWithRequestContext(input(), context(), binding()); const i = input(), c = context(), b = structuredClone(binding()) as any;
  if (field === "bytes") { i.payload.content = "Changed"; b.payloadSha256 = requestContextDigest(i.payload); }
  if (field === "target") { i.targetInstance = "other"; b.target.instance = "other"; }
  if (field === "incarnation") b.target.incarnation = "new-generation";
  if (field === "verb") b.verb = "delegate_task";
  if (field === "key") i.sourceKey = "new-key";
  if (field === "boot") i.sourceDaemonBootId = "new-boot";
  if (field === "root") b.rootContextId = CHILD;
  expect(() => box.admitWithRequestContext(i, c, b)).toThrow(/conflict/);
  expect(box.listPending()).toHaveLength(1); expect(box.get(original.delivery.deliveryId)?.payload).toEqual(input().payload);
});
it("single-parent descendants retain actor, ingress and audiences without inheriting agent lifetime state", () => {
  const box = open(); box.admitWithRequestContext(input(), context(), binding());
  const c: RequestContextV1 = { ...context(), ref: { version: 1, contextId: CHILD, rootContextId: ROOT, parentContextId: ROOT }, source: { instance: "target", incarnation: "target-generation" } };
  const i = { ...input(), operationId: "child-op", sourceKey: "child-key", sourceInstance: "target", targetInstance: "third" };
  expect(box.admitWithRequestContext(i, c, binding(i, c)).inserted).toBe(true);
  const bad = { ...c, ref: { ...c.ref, contextId: AUDIENCE }, ingress: "owner" as const };
  expect(() => box.admitWithRequestContext({ ...i, operationId: "bad", sourceKey: "bad" }, bad, binding({ ...i, operationId: "bad", sourceKey: "bad" }, bad))).toThrow(/lineage conflict/);
  expect(box.requestContext(AUDIENCE)).toBeNull();
  const independent = { ...context(), ref: { version: 1 as const, contextId: AUDIENCE, rootContextId: AUDIENCE }, ingress: "owner" as const };
  expect(box.admitWithRequestContext({ ...input(), operationId: "independent", sourceKey: "independent" }, independent,
    binding({ ...input(), operationId: "independent", sourceKey: "independent" }, independent)).inserted).toBe(true);
});
it("missing parents, self-parent and multiple parents refuse without partial context or delivery", () => {
  const box = open();
  for (const ref of [{ version: 1, contextId: CHILD, rootContextId: ROOT, parentContextId: ROOT },
    { version: 1, contextId: CHILD, rootContextId: ROOT, parentContextId: CHILD },
    { version: 1, contextId: CHILD, rootContextId: ROOT, parentContextIds: [ROOT] }]) {
    const c = { ...context(), ref } as RequestContextV1;
    expect(() => box.admitWithRequestContext(input(), c, binding(input(), c))).toThrow();
  }
  expect(box.listPending()).toHaveLength(0); expect(box.requestContext(CHILD)).toBeNull();
});
it("neither legacy admission nor a scoped operation may adopt the other's retry identity", () => {
  const scoped = open(); scoped.admitWithRequestContext(input(), context(), binding());
  expect(() => scoped.admit(input())).toThrow(/required for scoped retry/);
  expect(() => scoped.admit({ ...input(), operationId: "different-op" })).toThrow(/required for scoped retry/);
  const legacy = open(); legacy.admit(input());
  expect(() => legacy.admitWithRequestContext(input(), context(), binding())).toThrow(/cannot adopt legacy/);
  expect(legacy.requestContext(ROOT)).toBeNull();
});
it("a companion insert error rolls back context, delivery and references without emitting admission", () => {
  const file = path(), box = open(file); const db = (box as unknown as { db: Database.Database }).db;
  // Establish the companion schema with one unrelated committed root, then inject the real write boundary.
  box.admitWithRequestContext(input(), context(), binding());
  db.exec("CREATE TRIGGER fail_companion BEFORE INSERT ON request_context_operations_v1 BEGIN SELECT RAISE(ABORT,'synthetic-companion-failure'); END");
  const events: unknown[] = []; box.on("working_references", event => events.push(event));
  const c = { ...context(), ref: { version: 1 as const, contextId: CHILD, rootContextId: CHILD } }, i = { ...input(), operationId: "new", sourceKey: "new" };
  expect(() => box.admitWithRequestContext(i, c, binding(i, c))).toThrow(/synthetic-companion-failure/);
  expect(box.requestContext(CHILD)).toBeNull(); expect(box.requestContextOperation("source", "new")).toBeNull();
  expect(box.listPending()).toHaveLength(1); expect(events).toEqual([]);
});
it("corrupt or missing required companion data is unavailable, never an unlabelled retry", () => {
  const box = open(); box.admitWithRequestContext(input(), context(), binding()); const db = (box as unknown as { db: Database.Database }).db;
  db.exec("UPDATE request_contexts_v1 SET context_sha256='bad'");
  expect(() => box.admitWithRequestContext(input(), context(), binding())).toThrow(/corrupt context/);
  expect(() => box.requestContextOperation("source", "op-1")).toThrow(/corrupt context/);
});
it("lost companion metadata and payload corruption cannot fall back through the legacy retry path", () => {
  const box = open(), admitted = box.admitWithRequestContext(input(), context(), binding()), db = (box as unknown as { db: Database.Database }).db;
  expect(box.requestContextForDelivery(admitted.delivery.deliveryId)?.binding.contextId).toBe(ROOT);
  db.exec("DELETE FROM request_context_operations_v1");
  expect(() => box.admit(input())).toThrow(/required for scoped retry/);
  expect(() => box.requestContextForDelivery(admitted.delivery.deliveryId)).toThrow(/missing operation/);
  expect(() => box.admitWithRequestContext(input(), context(), binding())).toThrow(/missing operation/);
});
it("a changed delivery payload is unavailable even when its companion remains intact", () => {
  const box = open(), admitted = box.admitWithRequestContext(input(), context(), binding()), db = (box as unknown as { db: Database.Database }).db;
  db.prepare("UPDATE deliveries SET payload_json=? WHERE delivery_id=?").run(JSON.stringify({ content: "Changed bytes" }), admitted.delivery.deliveryId);
  expect(() => box.requestContextForDelivery(admitted.delivery.deliveryId)).toThrow(/delivery unavailable/);
});
it.each(["before", "after"])("real process exit %s commit rolls back or recovers the exact operation once", async phase => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const file = path(), box = open(file), db = (box as unknown as { db: Database.Database }).db;
  // Establish empty companion tables via a committed operation, then remove only fixture rows.
  box.admitWithRequestContext(input(), context(), binding());
  db.exec("DELETE FROM request_context_operations_v1; DELETE FROM deliveries; DELETE FROM request_contexts_v1;");
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/request-context-s222/crash.ts", import.meta.url)), file, phase],
    { env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10_000 });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(phase === "before" ? 91 : 92);
  const reopened = open(file);
  expect(reopened.listPending()).toHaveLength(phase === "before" ? 0 : 1);
  expect(reopened.requestContext(ROOT)).toEqual(phase === "before" ? null : context());
  if (phase === "before") db.exec("DROP TRIGGER crash_companion");
  const replay = reopened.admitWithRequestContext(input(), context(), binding());
  expect(replay.inserted).toBe(phase === "before"); expect(reopened.listPending()).toHaveLength(1);
  expect(reopened.requestContextForDelivery(replay.delivery.deliveryId)?.binding).toEqual(binding());
}, 15_000);
it("a missing delivery marker cannot hide an existing companion from either reader or legacy retry", () => {
  const box = open(), admitted = box.admitWithRequestContext(input(), context(), binding()), db = (box as unknown as { db: Database.Database }).db;
  db.exec("UPDATE deliveries SET request_context_id=NULL");
  expect(() => box.requestContextForDelivery(admitted.delivery.deliveryId)).toThrow(/missing delivery marker/);
  expect(() => box.admit(input())).toThrow(/required for scoped retry/);
});
it("another root cannot borrow an operation id, and its failed retry leaves no new root", () => {
  const box = open(); box.admitWithRequestContext(input(), context(), binding());
  const c = { ...context(), ref: { version: 1 as const, contextId: CHILD, rootContextId: CHILD }, ingress: "owner" as const };
  expect(() => box.admitWithRequestContext(input(), c, binding(input(), c))).toThrow(/operation conflict/);
  expect(box.requestContext(CHILD)).toBeNull();
});
it("partial companion schema refuses reads and writes instead of silently recreating it", () => {
  const box = open(); box.admitWithRequestContext(input(), context(), binding()); const db = (box as unknown as { db: Database.Database }).db;
  db.exec("DROP TABLE request_context_operations_v1");
  expect(() => box.requestContext(ROOT)).toThrow(/incomplete companion schema/);
  expect(() => box.admit(input())).toThrow(/incomplete companion schema/);
  expect(() => box.admitWithRequestContext(input(), context(), binding())).toThrow(/incomplete companion schema/);
});
it("a competing SQLite writer cannot leave partial provenance, and a retry after release inserts once", () => {
  const file = path(), owner = open(file), contender = open(file), db = (owner as unknown as { db: Database.Database }).db;
  db.exec("BEGIN IMMEDIATE");
  try { expect(() => contender.admitWithRequestContext(input(), context(), binding())).toThrow(/locked/); }
  finally { db.exec("ROLLBACK"); }
  expect(owner.requestContext(ROOT)).toBeNull(); expect(owner.listPending()).toHaveLength(0);
  const first = contender.admitWithRequestContext(input(), context(), binding());
  expect(first.inserted).toBe(true); expect(owner.admitWithRequestContext(input(), context(), binding()).inserted).toBe(false);
  expect(owner.listPending()).toHaveLength(1);
});
